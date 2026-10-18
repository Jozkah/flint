//! `flint launch <tool>`: start a coding CLI that is already installed with
//! the environment (and, where it needs them, arguments) that point it at the
//! local Flint API server, so it uses the models Flint serves.
//!
//! Nothing is installed and no setting of the tool is written: everything goes
//! on the child's environment and command line for this one run. `--dry-run`
//! prints exactly what would be started, with the key masked.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

/// Tools `launch` knows how to point at the server.
pub const KNOWN_TOOLS: &[&str] = &["claude", "codex", "aider"];

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 1337;
pub const DEFAULT_PREFIX: &str = "/v1";
/// A local server without an API key still makes these tools ask for one.
pub const PLACEHOLDER_KEY: &str = "flint-local";

/// Where the local API server is, and the key it wants (if any).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    /// `/v1` by default; always starts with `/`, never ends with one.
    pub prefix: String,
    pub api_key: String,
}

impl Target {
    pub fn origin(&self) -> String {
        let host = if self.host.contains(':') && !self.host.starts_with('[') { format!("[{}]", self.host) } else { self.host.clone() };
        format!("http://{host}:{}", self.port)
    }

    /// `http://127.0.0.1:1337/v1`: OpenAI-style clients.
    pub fn openai_base(&self) -> String {
        format!("{}{}", self.origin(), self.prefix)
    }

    /// The base Anthropic clients want: they add `/v1/messages` themselves.
    pub fn anthropic_base(&self) -> String {
        format!("{}{}", self.origin(), self.prefix.strip_suffix("/v1").unwrap_or(&self.prefix))
    }

    pub fn has_key(&self) -> bool {
        self.api_key != PLACEHOLDER_KEY
    }
}

fn clean_prefix(prefix: &str) -> String {
    let p = prefix.trim().trim_end_matches('/');
    if p.is_empty() {
        String::new()
    } else if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{p}")
    }
}

/// The server address from the desktop app's `settings.json`, if it saved one.
/// Tolerant of shape drift: anything missing falls back to the defaults.
pub fn target_from_settings(raw: &str, api_key: &str) -> Target {
    let state = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|root| root.get("setting-local-api-server").and_then(|v| v.as_str().map(str::to_string)))
        .and_then(|blob| serde_json::from_str::<serde_json::Value>(&blob).ok())
        .and_then(|v| v.get("state").cloned())
        .unwrap_or(serde_json::Value::Null);
    let host = match state.get("serverHost").and_then(|v| v.as_str()) {
        Some("0.0.0.0") | None | Some("") => DEFAULT_HOST.to_string(),
        Some(h) => h.to_string(),
    };
    let port = state.get("serverPort").and_then(|v| v.as_u64()).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).unwrap_or(DEFAULT_PORT);
    let prefix = state.get("apiPrefix").and_then(|v| v.as_str()).map(clean_prefix).unwrap_or_else(|| DEFAULT_PREFIX.to_string());
    Target { host, port, prefix, api_key: if api_key.is_empty() { PLACEHOLDER_KEY.to_string() } else { api_key.to_string() } }
}

/// `--base-url http://host:port[/prefix]` as a target.
pub fn target_from_url(url: &str, api_key: &str) -> Result<Target, String> {
    let u = url::Url::parse(url).map_err(|e| format!("'{url}' is not a URL: {e}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("the base URL must be http:// or https://".into());
    }
    let host = u.host_str().ok_or("the base URL has no host")?.to_string();
    let port = u.port_or_known_default().unwrap_or(DEFAULT_PORT);
    let path = clean_prefix(u.path());
    Ok(Target {
        host,
        port,
        prefix: if path.is_empty() { DEFAULT_PREFIX.to_string() } else { path },
        api_key: if api_key.is_empty() { PLACEHOLDER_KEY.to_string() } else { api_key.to_string() },
    })
}

/// What `launch` will start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// The command for `tool`, pointed at `target`. `extra` is passed to the tool
/// after Flint's own arguments.
pub fn plan(tool: &str, target: &Target, model: Option<&str>, extra: &[String]) -> Result<Plan, String> {
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    let (program, mut args, env): (&str, Vec<String>, Vec<(String, String)>) = match tool.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude-code" => {
            let mut env = vec![
                ("ANTHROPIC_BASE_URL".to_string(), target.anthropic_base()),
                ("ANTHROPIC_AUTH_TOKEN".to_string(), target.api_key.clone()),
                // Keeps Claude Code from reaching anthropic.com for anything but the model calls.
                ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(), "1".to_string()),
            ];
            if let Some(m) = model {
                env.push(("ANTHROPIC_MODEL".to_string(), m.to_string()));
                env.push(("ANTHROPIC_SMALL_FAST_MODEL".to_string(), m.to_string()));
            }
            ("claude", vec![], env)
        }
        "codex" => {
            // Codex reads its provider from config; `-c` overrides it for this run only.
            let mut args: Vec<String> = [
                ("model_provider", "flint".to_string()),
                ("model_providers.flint.name", "Flint".to_string()),
                ("model_providers.flint.base_url", target.openai_base()),
                ("model_providers.flint.env_key", "FLINT_API_KEY".to_string()),
                ("model_providers.flint.wire_api", "responses".to_string()),
            ]
            .into_iter()
            .flat_map(|(k, v)| ["-c".to_string(), format!("{k}=\"{v}\"")])
            .collect();
            if let Some(m) = model {
                args.push("-m".into());
                args.push(m.to_string());
            }
            ("codex", args, vec![("FLINT_API_KEY".to_string(), target.api_key.clone())])
        }
        "aider" => {
            let args = model.map(|m| vec!["--model".to_string(), format!("openai/{m}")]).unwrap_or_default();
            (
                "aider",
                args,
                vec![
                    ("OPENAI_API_BASE".to_string(), target.openai_base()),
                    ("OPENAI_API_KEY".to_string(), target.api_key.clone()),
                ],
            )
        }
        other => {
            return Err(format!("flint launch does not know '{other}'. Known tools: {}.", KNOWN_TOOLS.join(", ")));
        }
    };
    args.extend(extra.iter().cloned());
    Ok(Plan { program: program.to_string(), args, env })
}

fn quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

impl Plan {
    /// The environment as it is shown: the key, when it is a real one, masked.
    fn shown_env(&self, target: &Target) -> Vec<(String, String)> {
        self.env
            .iter()
            .map(|(k, v)| if target.has_key() && *v == target.api_key { (k.clone(), "<api key>".to_string()) } else { (k.clone(), v.clone()) })
            .collect()
    }

    /// One shell-style line: `NAME=value ... program args`.
    pub fn render(&self, target: &Target) -> String {
        let mut parts: Vec<String> = self.shown_env(target).iter().map(|(k, v)| format!("{k}={}", quote(v))).collect();
        parts.push(self.program.clone());
        parts.extend(self.args.iter().map(|a| quote(a)));
        parts.join(" ")
    }
}

/// Whether something accepts connections at the target.
fn reachable(target: &Target) -> bool {
    (target.host.as_str(), target.port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .is_some_and(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok())
}

fn invalid(message: impl Into<String>) -> HarnessError {
    HarnessError::new(ErrorKind::InvalidInput, message).at(Stage::Startup)
}

/// `flint launch <tool> [--model M] [--base-url U] [--dry-run] [-- tool args]`
pub fn run(
    tool: &str,
    model: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
    dry_run: bool,
    json: bool,
    extra: &[String],
) -> Result<(), HarnessError> {
    let key = api_key.map(str::to_string).or_else(|| std::env::var("FLINT_API_KEY").ok()).unwrap_or_default();
    let target = match base_url {
        Some(u) => target_from_url(u, &key).map_err(invalid)?,
        None => {
            let raw = std::fs::read_to_string(crate::core::app::commands::resolve_jan_data_folder().join("settings.json")).unwrap_or_default();
            target_from_settings(&raw, &key)
        }
    };
    let plan = plan(tool, &target, model, extra).map_err(invalid)?;
    if dry_run {
        if json {
            let env: serde_json::Map<String, serde_json::Value> =
                plan.shown_env(&target).into_iter().map(|(k, v)| (k, serde_json::Value::String(v))).collect();
            println!("{}", serde_json::json!({ "program": plan.program, "args": plan.args, "env": env }));
        } else {
            println!("{}", plan.render(&target));
        }
        return Ok(());
    }
    if !reachable(&target) {
        return Err(HarnessError::new(
            ErrorKind::Io,
            format!(
                "Flint's local API server is not answering at {}. Start it in Settings > Local API Server (or pass --base-url).",
                target.origin()
            ),
        )
        .at(Stage::Startup));
    }
    let mut cmd = std::process::Command::new(&plan.program);
    cmd.args(&plan.args).envs(plan.env.iter().map(|(k, v)| (k, v)));
    match cmd.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(HarnessError::new(
            ErrorKind::NotFound,
            format!("'{}' was not found on PATH. Install it first; `flint launch {tool} --dry-run` shows what would run.", plan.program),
        )
        .at(Stage::Startup)),
        Err(e) => Err(HarnessError::new(ErrorKind::Io, format!("could not start {}: {e}", plan.program)).at(Stage::Startup)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        target_from_settings("{}", "")
    }

    #[test]
    fn settings_give_the_server_address_and_missing_ones_the_defaults() {
        let t = target();
        assert_eq!((t.origin().as_str(), t.prefix.as_str(), t.api_key.as_str()), ("http://127.0.0.1:1337", "/v1", PLACEHOLDER_KEY));
        let blob = serde_json::json!({ "state": { "serverHost": "0.0.0.0", "serverPort": 8080, "apiPrefix": "api/" } }).to_string();
        let raw = serde_json::json!({ "setting-local-api-server": blob }).to_string();
        let t = target_from_settings(&raw, "k");
        assert_eq!((t.origin().as_str(), t.prefix.as_str(), t.api_key.as_str()), ("http://127.0.0.1:8080", "/api", "k"));
        assert_eq!(target_from_settings("not json", "").port, 1337);
    }

    #[test]
    fn a_base_url_overrides_the_settings() {
        let t = target_from_url("http://localhost:9000/v1/", "").unwrap();
        assert_eq!((t.host.as_str(), t.port, t.prefix.as_str()), ("localhost", 9000, "/v1"));
        assert!(target_from_url("ftp://x", "").is_err() && target_from_url("nope", "").is_err());
    }

    #[test]
    fn claude_gets_the_anthropic_base_without_v1_and_the_model() {
        let p = plan("claude", &target(), Some("qwen3"), &["--print".to_string()]).unwrap();
        let env: std::collections::HashMap<_, _> = p.env.iter().cloned().collect();
        assert_eq!(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:1337");
        assert_eq!(env["ANTHROPIC_MODEL"], "qwen3");
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], PLACEHOLDER_KEY);
        assert_eq!((p.program.as_str(), p.args.as_slice()), ("claude", &["--print".to_string()][..]));
    }

    #[test]
    fn codex_is_pointed_at_the_responses_route_for_this_run_only() {
        let p = plan("codex", &target(), Some("m1"), &[]).unwrap();
        assert!(p.args.windows(2).any(|w| w[0] == "-c" && w[1] == "model_providers.flint.base_url=\"http://127.0.0.1:1337/v1\""));
        assert!(p.args.iter().any(|a| a == "model_providers.flint.wire_api=\"responses\""));
        assert!(p.args.windows(2).any(|w| w[0] == "-m" && w[1] == "m1"));
        assert_eq!(p.env, vec![("FLINT_API_KEY".to_string(), PLACEHOLDER_KEY.to_string())]);
    }

    #[test]
    fn aider_uses_the_openai_base_and_an_openai_prefixed_model() {
        let p = plan("aider", &target(), Some("m"), &[]).unwrap();
        assert_eq!(p.args, vec!["--model", "openai/m"]);
        assert!(p.env.contains(&("OPENAI_API_BASE".to_string(), "http://127.0.0.1:1337/v1".to_string())));
    }

    #[test]
    fn an_unknown_tool_is_refused_naming_the_known_ones() {
        let e = plan("emacs", &target(), None, &[]).unwrap_err();
        assert!(e.contains("emacs") && e.contains("claude, codex, aider"), "{e}");
    }

    #[test]
    fn the_printed_command_masks_a_real_key_and_quotes_awkward_arguments() {
        let t = target_from_settings("{}", "sk-secret-123");
        let p = plan("codex", &t, None, &["fix the bug".to_string()]).unwrap();
        let line = p.render(&t);
        assert!(!line.contains("sk-secret-123") && line.contains("FLINT_API_KEY='<api key>'"), "{line}");
        assert!(line.ends_with("'fix the bug'"), "{line}");
        // The placeholder is not a secret and is shown as it is.
        let open = plan("aider", &target(), None, &[]).unwrap().render(&target());
        assert!(open.contains(&format!("OPENAI_API_KEY={PLACEHOLDER_KEY}")), "{open}");
    }
}
