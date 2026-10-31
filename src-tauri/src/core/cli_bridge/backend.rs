//! Runs the official vendor CLIs as plain model endpoints.
//!
//! Each CLI stays unmodified and signs in with its own login; Flint never reads
//! or stores the vendor's tokens. Claude Code is the only backend verified
//! against a real binary. The Codex and Gemini parsers follow the vendors'
//! documented JSONL and accept both shapes they have documented.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};

use super::prompt::Image;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Claude,
    Codex,
    Gemini,
}

/// What a running CLI reports back.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Text(String),
    Usage { input: u64, output: u64 },
    Failed(String),
}

/// Silence this long means the CLI hung.
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);

impl Backend {
    pub const ALL: [Backend; 3] = [Backend::Claude, Backend::Codex, Backend::Gemini];

    pub const fn id(self) -> &'static str {
        match self {
            Backend::Claude => "claude-cli",
            Backend::Codex => "codex-cli",
            Backend::Gemini => "gemini-cli",
        }
    }

    pub fn from_id(id: &str) -> Option<Backend> {
        Backend::ALL.into_iter().find(|backend| backend.id() == id)
    }

    pub const fn display_name(self) -> &'static str {
        match self {
            Backend::Claude => "Claude (Claude Code login)",
            Backend::Codex => "ChatGPT (Codex login)",
            Backend::Gemini => "Gemini (Gemini CLI login)",
        }
    }

    pub const fn binary(self) -> &'static str {
        match self {
            Backend::Claude => "claude",
            Backend::Codex => "codex",
            Backend::Gemini => "gemini",
        }
    }

    /// Models offered in the picker. The CLIs resolve aliases themselves, so
    /// these stay valid as vendors ship new versions.
    pub fn models(self) -> Vec<String> {
        let list: &[&str] = match self {
            Backend::Claude => &[
                "claude-opus-5-5",
                "claude-fable-5-1",
                "claude-sonnet-5-5",
                "claude-haiku-5-5",
                "claude-haiku-4-5",
                "claude-sonnet-5",
                "claude-opus-5",
                "claude-fable-5",
                "claude-opus-4-8",
                "claude-opus-4-7",
                "claude-opus-4-6",
                "claude-sonnet-4-6",
            ],
            Backend::Codex => &["gpt-6.1-sol"],
            // From the model constants in gemini-cli 0.66.0.
            Backend::Gemini => &[
                "gemini-3.1-pro-preview",
                "gemini-3-pro-preview",
                "gemini-3.8-flash",
                "gemini-3.5-flash",
                "gemini-3-flash-preview",
                "gemini-3.1-flash-lite",
                "gemini-3.5-flash-lite",
                "gemini-2.5-pro",
                "gemini-2.5-flash",
                "gemini-2.5-flash-lite",
            ],
        };
        list.iter().map(|model| model.to_string()).collect()
    }

    /// The models this login can use. Codex lists its own roster; the others
    /// resolve aliases themselves, so their static list stays valid.
    pub async fn discover_models(self) -> Vec<String> {
        if self == Backend::Codex {
            if let Some(binary) = find_binary(self.binary()) {
                let output = tokio::time::timeout(
                    Duration::from_secs(30),
                    command(&binary).args(["debug", "models"]).output(),
                )
                .await;
                if let Ok(Ok(out)) = output {
                    if let Ok(value) = serde_json::from_slice::<Value>(&out.stdout) {
                        let found = parse_codex_roster(&value);
                        if !found.is_empty() {
                            return found;
                        }
                    }
                }
            }
        }
        self.models()
    }

    /// The CLI's own login check; `true` when signed in.
    pub async fn logged_in(self) -> bool {
        let Some(binary) = find_binary(self.binary()) else {
            return false;
        };
        let args: &[&str] = match self {
            Backend::Claude => &["auth", "status"],
            Backend::Codex => &["login", "status"],
            // Gemini has no status command: a stored credential file is the
            // login.
            Backend::Gemini => return gemini_credentials_present(),
        };
        let output = tokio::time::timeout(
            Duration::from_secs(20),
            command(&binary).args(args).output(),
        )
        .await;
        match output {
            Ok(Ok(out)) => {
                let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
                match self {
                    Backend::Claude => text.contains("\"loggedin\": true"),
                    _ => out.status.success() && !text.contains("not logged"),
                }
            }
            _ => false,
        }
    }

    /// Codex and Gemini cannot have their built-in tools removed, so the
    /// request tells them to stay text-only; Flint runs the tools itself.
    pub const fn preamble(self) -> &'static str {
        match self {
            Backend::Claude => "",
            Backend::Codex | Backend::Gemini => {
                "[system]\nYou are a model inside another application. Never run shell commands, read or edit files, or use any built-in tool of your own (attached images are visible to you). Answer in text, and use only the <tool_call> protocol below when a tool is needed.\n\n"
            }
        }
    }

    fn args(self, model: &str) -> Vec<String> {
        let own = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        match self {
            Backend::Claude => {
                let mut args = own(&[
                    "-p",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--tools",
                    "",
                    "--strict-mcp-config",
                    "--mcp-config",
                    "{\"mcpServers\":{}}",
                    "--setting-sources",
                    "",
                    "--no-session-persistence",
                    "--system-prompt",
                    "You are a helpful assistant inside another application. Follow the instructions in the message. Images attached to the message are visible to you.",
                ]);
                args.extend(own(&["--model", model]));
                args
            }
            Backend::Codex => {
                let mut args = own(&[
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "--ephemeral",
                    // No MCP servers, AGENTS.md or rules from the user's own
                    // Codex setup; the login in CODEX_HOME still applies.
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--sandbox",
                    "read-only",
                    // Codex answers from its own web search and shell when
                    // they exist, ignoring Flint's tools. Switch them off.
                    "-c",
                    "web_search=\"disabled\"",
                ]);
                for feature in [
                    "shell_tool",
                    "apps",
                    "plugins",
                    "browser_use",
                    "computer_use",
                    "in_app_browser",
                    "multi_agent",
                    "image_generation",
                    "goals",
                ] {
                    args.extend(own(&["--disable", feature]));
                }
                args.extend(own(&["--model", model, "-"]));
                args
            }
            Backend::Gemini => {
                let mut args = own(&["--output-format", "stream-json"]);
                args.extend(own(&["--model", model, "-p", ""]));
                args
            }
        }
    }

    /// Parse one stdout line into zero or more events.
    pub fn parse_line(self, line: &str) -> Vec<Event> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match self {
            Backend::Claude => parse_claude(&value),
            Backend::Codex => parse_codex(&value),
            Backend::Gemini => parse_gemini(&value),
        }
    }
}

/// Slugs of the models Codex lists for this account (`codex debug models`).
fn parse_codex_roster(value: &Value) -> Vec<String> {
    value["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["visibility"].as_str().is_none_or(|v| v == "list"))
        .filter_map(|model| model["slug"].as_str().map(str::to_string))
        .collect()
}

fn parse_claude(value: &Value) -> Vec<Event> {
    match value.get("type").and_then(Value::as_str) {
        Some("stream_event") => {
            let delta = &value["event"]["delta"];
            match (delta["type"].as_str(), delta["text"].as_str()) {
                (Some("text_delta"), Some(text)) if !text.is_empty() => {
                    vec![Event::Text(text.to_string())]
                }
                _ => Vec::new(),
            }
        }
        Some("result") => {
            if value["is_error"].as_bool() == Some(true) {
                let message = value["result"].as_str().unwrap_or("Claude Code returned an error");
                return vec![Event::Failed(message.to_string())];
            }
            let usage = &value["usage"];
            let input = usage["input_tokens"].as_u64().unwrap_or(0)
                + usage["cache_read_input_tokens"].as_u64().unwrap_or(0)
                + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            vec![Event::Usage {
                input,
                output: usage["output_tokens"].as_u64().unwrap_or(0),
            }]
        }
        _ => Vec::new(),
    }
}

fn parse_codex(value: &Value) -> Vec<Event> {
    match value.get("type").and_then(Value::as_str) {
        Some("item.completed") => {
            let item = &value["item"];
            match (item["type"].as_str(), item["text"].as_str()) {
                (Some("agent_message"), Some(text)) => vec![Event::Text(text.to_string())],
                _ => Vec::new(),
            }
        }
        Some("turn.completed") => {
            let usage = &value["usage"];
            vec![Event::Usage {
                input: usage["input_tokens"].as_u64().unwrap_or(0),
                output: usage["output_tokens"].as_u64().unwrap_or(0),
            }]
        }
        Some("turn.failed") | Some("error") => {
            let message = value["error"]["message"]
                .as_str()
                .or_else(|| value["message"].as_str())
                .unwrap_or("Codex returned an error");
            vec![Event::Failed(message.to_string())]
        }
        _ => Vec::new(),
    }
}

fn parse_gemini(value: &Value) -> Vec<Event> {
    match value.get("type").and_then(Value::as_str) {
        Some("message") if value["role"].as_str() == Some("assistant") => {
            match value["content"].as_str() {
                Some(text) if !text.is_empty() => vec![Event::Text(text.to_string())],
                _ => Vec::new(),
            }
        }
        Some("result") => {
            if value["status"].as_str() == Some("error") {
                let message = value["error"]["message"].as_str().unwrap_or("Gemini CLI returned an error");
                return vec![Event::Failed(message.to_string())];
            }
            let stats = &value["stats"];
            vec![Event::Usage {
                input: stats["input_tokens"].as_u64().unwrap_or(0),
                output: stats["output_tokens"].as_u64().unwrap_or(0),
            }]
        }
        Some("error") => vec![Event::Failed(
            value["message"].as_str().unwrap_or("Gemini CLI returned an error").to_string(),
        )],
        _ => Vec::new(),
    }
}

fn gemini_credentials_present() -> bool {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".gemini").join("oauth_creds.json").is_file())
        .unwrap_or(false)
        || std::env::var_os("GEMINI_API_KEY").is_some()
}

/// Locate `name` on PATH. On Windows the npm shims are `.cmd` files, which
/// `Command::new("claude")` does not find on its own.
pub fn find_binary(name: &str) -> Option<PathBuf> {
    let extensions: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[""] };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for extension in extensions {
            let file = if extension.is_empty() {
                dir.join(name)
            } else {
                dir.join(format!("{name}.{extension}"))
            };
            if file.is_file() {
                return Some(file);
            }
        }
    }
    None
}

/// A command with the vendor-key variables removed so the CLI uses its own
/// login, run from an empty directory so no project files or settings apply.
fn command(binary: &std::path::Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary);
    for variable in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
    ] {
        command.env_remove(variable);
    }
    command.current_dir(scratch_dir());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command.kill_on_drop(true);
    command
}

fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("flint-cli-bridge");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Decoded request images on disk, deleted on drop.
#[derive(Default)]
struct ImageFiles {
    dir: Option<PathBuf>,
}

impl ImageFiles {
    fn write(&mut self, images: &[Image]) -> Vec<PathBuf> {
        use base64::Engine;
        let dir = scratch_dir().join(format!("img-{:x}", rand::random::<u64>()));
        if std::fs::create_dir_all(&dir).is_err() {
            return Vec::new();
        }
        self.dir = Some(dir.clone());
        images
            .iter()
            .enumerate()
            .filter_map(|(index, image)| {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(image.base64.trim())
                    .ok()?;
                let path = dir.join(format!("{}.{}", index + 1, image.extension()));
                std::fs::write(&path, bytes).ok()?;
                Some(path)
            })
            .collect()
    }
}

impl Drop for ImageFiles {
    fn drop(&mut self) {
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Run one request to completion, sending events as they arrive. The prompt
/// goes in on stdin so nothing long or user-supplied touches the command line.
pub async fn run(
    backend: Backend,
    model: &str,
    mut stdin_text: String,
    images: Vec<Image>,
    events: mpsc::Sender<Event>,
) {
    let mut args = backend.args(model);
    // Images reach each CLI its own way. Files live in a per-request folder
    // under the scratch directory and are removed when the request ends.
    let mut files = ImageFiles::default();
    if !images.is_empty() {
        match backend {
            Backend::Claude => {
                // Image blocks need the stream-json input form.
                args.extend(["--input-format".to_string(), "stream-json".to_string()]);
                let mut content = vec![json!({"type": "text", "text": stdin_text})];
                content.extend(images.iter().map(|image| {
                    json!({"type": "image", "source": {"type": "base64", "media_type": image.mime, "data": image.base64}})
                }));
                stdin_text = format!(
                    "{}\n",
                    json!({"type": "user", "message": {"role": "user", "content": content}})
                );
            }
            Backend::Codex => {
                let paths = files.write(&images);
                let flags = paths
                    .iter()
                    .flat_map(|path| ["--image".to_string(), path.display().to_string()]);
                // Right after `exec`; each flag takes one file.
                args.splice(1..1, flags);
            }
            Backend::Gemini => {
                // `@path` in the prompt attaches the file; the folder sits
                // inside the CLI's working directory.
                let paths = files.write(&images);
                let refs: Vec<String> = paths
                    .iter()
                    .filter_map(|path| path.strip_prefix(scratch_dir()).ok())
                    .map(|path| format!("@{}", path.display().to_string().replace('\\', "/")))
                    .collect();
                stdin_text = format!("{stdin_text}\n\nAttached images: {}", refs.join(" "));
            }
        }
    }
    let Some(binary) = find_binary(backend.binary()) else {
        let _ = events
            .send(Event::Failed(format!(
                "{} is not installed or not on PATH. Install it and sign in with `{} login`.",
                backend.binary(),
                backend.binary()
            )))
            .await;
        return;
    };
    let mut child = match command(&binary)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = events.send(Event::Failed(format!("could not start {}: {error}", backend.binary()))).await;
            return;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_text.as_bytes()).await;
    }
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if text.len() < 2000 {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
        }
        text
    });
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut failed = false;
    loop {
        match tokio::time::timeout(IDLE_TIMEOUT, lines.next_line()).await {
            Err(_) => {
                let _ = events.send(Event::Failed(format!("{} stopped responding", backend.binary()))).await;
                failed = true;
                break;
            }
            Ok(Ok(Some(line))) => {
                for event in backend.parse_line(&line) {
                    // Codex reports a retried stream drop as an `error` event and
                    // then finishes the turn; a completed turn wins over it.
                    match event {
                        Event::Failed(_) => failed = true,
                        Event::Usage { .. } => failed = false,
                        Event::Text(_) => {}
                    }
                    if events.send(event).await.is_err() {
                        return; // caller went away; kill_on_drop ends the CLI
                    }
                }
            }
            Ok(_) => break,
        }
    }
    let status = child.wait().await;
    if !failed && !status.as_ref().is_ok_and(|status| status.success()) {
        let detail = stderr_task.await.unwrap_or_default();
        let detail = detail.trim();
        let _ = events
            .send(Event::Failed(if detail.is_empty() {
                format!("{} exited with an error", backend.binary())
            } else {
                format!("{}: {detail}", backend.binary())
            }))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_text_deltas_and_usage_parse() {
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}}"#;
        assert_eq!(Backend::Claude.parse_line(delta), vec![Event::Text("pong".into())]);
        let result = r#"{"type":"result","is_error":false,"usage":{"input_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":5,"output_tokens":4}}"#;
        assert_eq!(Backend::Claude.parse_line(result), vec![Event::Usage { input: 10, output: 4 }]);
        let error = r#"{"type":"result","is_error":true,"result":"rate limited"}"#;
        assert_eq!(Backend::Claude.parse_line(error), vec![Event::Failed("rate limited".into())]);
        assert!(Backend::Claude.parse_line("not json").is_empty());
    }

    #[test]
    fn codex_and_gemini_shapes_parse() {
        let message = r#"{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}"#;
        assert_eq!(Backend::Codex.parse_line(message), vec![Event::Text("hi".into())]);
        let done = r#"{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2}}"#;
        assert_eq!(Backend::Codex.parse_line(done), vec![Event::Usage { input: 7, output: 2 }]);
        // Codex 0.5x: a stream drop it retries is an `error` event mid-turn.
        let retrying = r#"{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion)"}"#;
        assert!(matches!(Backend::Codex.parse_line(retrying).as_slice(), [Event::Failed(_)]));
        let gemini = r#"{"type":"message","role":"assistant","content":"yo","delta":true}"#;
        assert_eq!(Backend::Gemini.parse_line(gemini), vec![Event::Text("yo".into())]);
        let user = r#"{"type":"message","role":"user","content":"q"}"#;
        assert!(Backend::Gemini.parse_line(user).is_empty());
    }

    #[test]
    fn claude_args_disable_tools_and_settings() {
        let args = Backend::Claude.args("haiku");
        let joined = args.join(" ");
        assert!(joined.contains("--tools  --strict-mcp-config") || args.windows(2).any(|w| w == ["--tools", ""]));
        assert!(args.windows(2).any(|w| w == ["--setting-sources", ""]));
        assert!(args.windows(2).any(|w| w == ["--model", "haiku"]));
    }
}
