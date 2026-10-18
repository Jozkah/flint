//! Claude Code hooks, run inside Flint.
//!
//! Flint's own hooks (`tauri_plugin_agent_tools::hooks`) are deliberately
//! small: declared per project, told nothing about the conversation, and
//! unable to add anything to the prompt. That is the right shape for a policy
//! file a repository ships. It cannot carry what Claude Code users put in
//! `~/.claude`: a `SessionStart` hook that loads their response style, or a
//! `UserPromptSubmit` hook that adds context to each prompt.
//!
//! So this module runs the hooks the *user* already wrote for Claude Code --
//! and only those, and only after they opted in when importing from Claude Code
//! (`cc-links.json` `hooks: true`):
//!
//! * `hooks` in `~/.claude/settings.json`, and
//! * `hooks/hooks.json` of each plugin imported from Claude Code, run from the
//!   plugin's own directory (`${CLAUDE_PLUGIN_ROOT}`).
//!
//! Only `SessionStart` and `UserPromptSubmit` run. They are the two that add
//! context rather than gate a tool call, and the two with a defined way to hand
//! text back: whatever the hook prints, or the `additionalContext` of its JSON
//! output, goes to the model. Every other event is ignored, as are matchers for
//! sessions Flint never has (`resume`, `clear`, `compact`).
//!
//! A hook here is *not* confined: it is the user's own command from their own
//! config, run the way Claude Code runs it. The repository being worked on has
//! no say in what runs. Unlike Flint's project hooks, these receive the prompt
//! on stdin (Claude Code's documented input), which is the reason this is
//! opt-in.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::core::agent::cc_links::{self, LinkKind, Links};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    SessionStart,
    UserPromptSubmit,
}

impl Event {
    fn name(self) -> &'static str {
        match self {
            Event::SessionStart => "SessionStart",
            Event::UserPromptSubmit => "UserPromptSubmit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hook {
    pub event: Event,
    pub command: String,
    pub timeout_secs: u64,
    /// The plugin directory the hook belongs to, for `${CLAUDE_PLUGIN_ROOT}`.
    pub plugin_root: Option<PathBuf>,
}

/// Claude Code's own default is 60s; these only add context, so less.
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 60;
/// What one hook may add to the prompt. A hook printing a log file would
/// otherwise eat the context window.
const MAX_CONTEXT_CHARS: usize = 32 * 1024;

/// `~/.claude` under the app's own home (`jan_home_dir`), so an isolated
/// profile (explicit home override, tests) never reads the real one.
pub(crate) fn claude_home() -> Option<PathBuf> {
    crate::core::app::commands::jan_home_dir().map(|h| h.join(".claude"))
}

/// The hooks that apply right now: none unless the user opted in.
pub fn active() -> Vec<Hook> {
    let links = cc_links::load();
    match claude_home() {
        Some(home) => discover(&home, &links),
        None => Vec::new(),
    }
}

/// Every runnable hook for `links`, in the order Claude Code would run them:
/// user settings first, then each linked plugin.
pub fn discover(claude_home: &Path, links: &Links) -> Vec<Hook> {
    if !links.hooks {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(settings) = read_json(&claude_home.join("settings.json")) {
        parse_into(&settings, None, &mut out);
    }
    for link in links.items.iter().filter(|l| l.kind == LinkKind::Plugin) {
        let root = PathBuf::from(&link.source_path);
        if let Some(file) = read_json(&root.join("hooks").join("hooks.json")) {
            parse_into(&file, Some(&root), &mut out);
        }
    }
    // The same command declared twice (settings and a plugin) runs once.
    let mut seen = std::collections::HashSet::new();
    out.retain(|h| seen.insert((h.event as u8, h.command.clone())));
    out
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(raw.strip_prefix('\u{feff}').unwrap_or(&raw)).ok()
}

/// `settings.json` carries the events under a `hooks` key; so does a plugin's
/// `hooks.json`. A bare events object is accepted too.
fn parse_into(doc: &Value, plugin_root: Option<&Path>, out: &mut Vec<Hook>) {
    let events = doc.get("hooks").unwrap_or(doc);
    let Some(events) = events.as_object() else {
        return;
    };
    for (name, groups) in events {
        let event = match name.as_str() {
            "SessionStart" => Event::SessionStart,
            "UserPromptSubmit" => Event::UserPromptSubmit,
            _ => continue,
        };
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for group in groups {
            if event == Event::SessionStart && !matches_startup(group.get("matcher")) {
                continue;
            }
            let Some(hooks) = group.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for hook in hooks {
                if hook.get("type").and_then(Value::as_str) != Some("command") {
                    continue;
                }
                let Some(command) = hook
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|c| !c.is_empty())
                else {
                    continue;
                };
                let timeout_secs = hook
                    .get("timeout")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_TIMEOUT_SECS)
                    .clamp(1, MAX_TIMEOUT_SECS);
                out.push(Hook {
                    event,
                    command: command.to_string(),
                    timeout_secs,
                    plugin_root: plugin_root.map(Path::to_path_buf),
                });
            }
        }
    }
}

/// A `SessionStart` matcher names the kind of start: `startup`, `resume`,
/// `clear`, `compact`. A Flint run is always a fresh start; an absent or `*`
/// matcher matches everything.
fn matches_startup(matcher: Option<&Value>) -> bool {
    match matcher.and_then(Value::as_str).map(str::trim) {
        None | Some("") | Some("*") => true,
        Some(m) => m.split('|').any(|part| matches!(part.trim(), "startup" | "*")),
    }
}

/// What a hook's output means for the prompt: the `additionalContext` of a JSON
/// object (top level or under `hookSpecificOutput`), or the whole text when it
/// is not JSON. `None` when there is nothing to add.
pub fn context_from_output(stdout: &str) -> Option<String> {
    let text = stdout.trim();
    if text.is_empty() {
        return None;
    }
    let picked = if text.starts_with('{') {
        match serde_json::from_str::<Value>(text) {
            Ok(v) => v
                .pointer("/hookSpecificOutput/additionalContext")
                .or_else(|| v.get("additionalContext"))
                .and_then(Value::as_str)
                .map(str::to_string),
            // A `{` that is not JSON is just text that starts with one.
            Err(_) => Some(text.to_string()),
        }
    } else {
        Some(text.to_string())
    }?;
    let picked = picked.trim();
    if picked.is_empty() {
        return None;
    }
    Some(match picked.char_indices().nth(MAX_CONTEXT_CHARS) {
        Some((at, _)) => format!("{}\n[hook output truncated]", &picked[..at]),
        None => picked.to_string(),
    })
}

/// Run every hook for `event`, returning the context each one produced.
/// A hook that fails, times out or prints nothing contributes nothing: these
/// hooks add to a prompt, and a broken one must not stop the run.
pub async fn run(hooks: &[Hook], event: Event, payload: &Value, cwd: &Path) -> Vec<String> {
    run_cancellable(hooks, event, payload, cwd, None)
        .await
        .unwrap_or_default()
}

/// The turn was stopped while its hooks were running.
///
/// Distinct from a hook that fails or times out, which adds nothing and lets
/// the turn go on: a stopped turn must not carry on as though the hooks had
/// looked at the prompt and found nothing to say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interrupted(pub tauri_plugin_agent_tools::lifecycle::StopReason);

impl Interrupted {
    /// The refusal a caller reports for the turn.
    pub fn message(self) -> &'static str {
        "the turn was stopped while its prompt hooks ran, so the prompt was not submitted"
    }
}

type CancelToken = tauri_plugin_agent_tools::lifecycle::Token;

/// Resolves once `token` is stopped; never, without one.
async fn stopped(token: Option<&CancelToken>) {
    match token {
        Some(token) => {
            while !token.is_stopped() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

/// [`run`], stopped by `cancel`. A running hook is killed (its child is
/// `kill_on_drop`) and the caller is told the turn was interrupted, so it can
/// refuse the prompt instead of sending it on unchecked.
pub async fn run_cancellable(
    hooks: &[Hook],
    event: Event,
    payload: &Value,
    cwd: &Path,
    cancel: Option<&CancelToken>,
) -> Result<Vec<String>, Interrupted> {
    use tauri_plugin_agent_tools::lifecycle::StopReason;
    let interrupted = || {
        cancel
            .and_then(|t| t.stopped())
            .map(Interrupted)
    };
    let mut out = Vec::new();
    for hook in hooks.iter().filter(|h| h.event == event) {
        if let Some(why) = interrupted() {
            return Err(why);
        }
        tokio::select! {
            biased;
            _ = stopped(cancel) => {
                return Err(interrupted().unwrap_or(Interrupted(StopReason::Cancelled)));
            }
            text = exec(hook, payload, cwd) => {
                if let Some(text) = text {
                    out.push(text);
                }
            }
        }
    }
    // A stop that landed as the last hook finished still counts.
    if let Some(why) = interrupted() {
        return Err(why);
    }
    Ok(out)
}

/// Ends a hook's whole process tree when dropped with a pid still set: the
/// hook was stopped, cancelled or ran out of time.
struct TreeGuard(Option<u32>);

impl Drop for TreeGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0.take() {
            let _ = tauri_plugin_agent_tools::tools::proc::kill_tree(pid);
        }
    }
}

async fn exec(hook: &Hook, payload: &Value, cwd: &Path) -> Option<String> {
    use tauri_plugin_agent_tools::tools::proc;
    use tokio::io::AsyncWriteExt;

    let shell = proc::shell();
    if shell.via_stdin {
        log::warn!("cc hook: the resolved shell reads commands from stdin; skipped");
        return None;
    }
    let mut command = hook.command.clone();
    if let Some(root) = &hook.plugin_root {
        command = command.replace("${CLAUDE_PLUGIN_ROOT}", &root.to_string_lossy().replace('\\', "/"));
    }
    let cwd = if cwd.is_dir() {
        cwd.to_path_buf()
    } else {
        crate::core::app::commands::jan_home_dir().unwrap_or_else(|| PathBuf::from("."))
    };

    let mut cmd = tokio::process::Command::new(&shell.program);
    // A hook is the user's script: it gets the host's libraries, not the AppImage's.
    jan_process::HostProcessEnv::host_env(&mut cmd);
    cmd.args(&shell.args)
        .arg(&command)
        .current_dir(&cwd)
        .env("CLAUDE_PROJECT_DIR", &cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(root) = &hook.plugin_root {
        cmd.env("CLAUDE_PLUGIN_ROOT", root);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: a hook is never shown.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            log::warn!("cc hook: could not start `{}`: {e}", hook.command);
            return None;
        }
    };
    // Dropping the child ends the shell and nothing else: what the shell
    // started (a `sleep`, a script) keeps running and keeps the output pipe
    // open, so a stopped or timed-out hook would still hold the run up. The
    // guard ends the whole tree unless the hook finished by itself.
    let mut tree = TreeGuard(child.id());
    // Written beside the wait, not before it: a hook that never reads its input
    // would otherwise block a large payload's write past the time limit. A
    // hook that closes the pipe early is its business, not a failure.
    let writer = child.stdin.take().map(|mut stdin| {
        let body = payload.to_string();
        tokio::spawn(async move {
            let _ = stdin.write_all(body.as_bytes()).await;
        })
    });
    let limit = Duration::from_secs(hook.timeout_secs);
    let waited = tokio::time::timeout(limit, child.wait_with_output()).await;
    if waited.is_ok() {
        tree.0 = None;
    }
    drop(tree);
    if let Some(writer) = writer {
        writer.abort();
    }
    match waited {
        Ok(Ok(out)) if out.status.success() => {
            context_from_output(&String::from_utf8_lossy(&out.stdout))
        }
        Ok(Ok(out)) => {
            log::warn!("cc hook: `{}` exited with {}", hook.command, out.status);
            None
        }
        Ok(Err(e)) => {
            log::warn!("cc hook: `{}` could not be waited on: {e}", hook.command);
            None
        }
        Err(_) => {
            log::warn!("cc hook: `{}` outlived its {}s limit", hook.command, hook.timeout_secs);
            None
        }
    }
}

/// `SessionStart` context is the same for every turn of a session, so it is
/// computed once per session and replayed: the system prompt stays byte-stable
/// (and its cached prefix valid) and the hook is not re-run on every message.
static SESSION_CACHE: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);
const SESSION_CACHE_MAX: usize = 256;

pub async fn session_start_context(
    hooks: &[Hook],
    session_id: Option<&str>,
    cwd: &Path,
) -> Vec<String> {
    if !hooks.iter().any(|h| h.event == Event::SessionStart) {
        return Vec::new();
    }
    // Keyed by the hook set too, so editing `~/.claude` mid-session is picked
    // up on the next message instead of never.
    let key = session_id.map(|id| {
        let mut commands: Vec<&str> = hooks
            .iter()
            .filter(|h| h.event == Event::SessionStart)
            .map(|h| h.command.as_str())
            .collect();
        commands.sort_unstable();
        format!("{id}\u{0}{}", commands.join("\u{0}"))
    });
    if let Some(key) = &key {
        if let Ok(cache) = SESSION_CACHE.lock() {
            if let Some(hit) = cache.as_ref().and_then(|c| c.get(key)) {
                return hit.clone();
            }
        }
    }
    let payload = json!({
        "session_id": session_id.unwrap_or_default(),
        "cwd": cwd.to_string_lossy(),
        "hook_event_name": Event::SessionStart.name(),
        "source": "startup",
    });
    let fresh = run(hooks, Event::SessionStart, &payload, cwd).await;
    if let Some(key) = key {
        if let Ok(mut cache) = SESSION_CACHE.lock() {
            let cache = cache.get_or_insert_with(HashMap::new);
            if cache.len() >= SESSION_CACHE_MAX {
                cache.clear();
            }
            cache.insert(key, fresh.clone());
        }
    }
    fresh
}

pub async fn prompt_submit_context(
    hooks: &[Hook],
    session_id: Option<&str>,
    cwd: &Path,
    prompt: &str,
    cancel: Option<&CancelToken>,
) -> Result<Vec<String>, Interrupted> {
    if !hooks.iter().any(|h| h.event == Event::UserPromptSubmit) {
        return Ok(Vec::new());
    }
    let payload = json!({
        "session_id": session_id.unwrap_or_default(),
        "cwd": cwd.to_string_lossy(),
        "hook_event_name": Event::UserPromptSubmit.name(),
        "prompt": prompt,
    });
    run_cancellable(hooks, Event::UserPromptSubmit, &payload, cwd, cancel).await
}

/// What the Claude Code context hooks add to one turn, for the surfaces that do
/// not run the Rust agent loop (the desktop chat transport, the Cowork runner).
/// The wording and placement are the loop's: `session_start` blocks follow the
/// system prompt, `prompt_submit` blocks are wrapped as reminders on the user's
/// message.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcContextHooks {
    /// The user opted in and at least one hook applies.
    pub enabled: bool,
    pub session_start: Vec<String>,
    pub prompt_submit: Vec<String>,
    /// The turn was stopped while the hooks ran. The prompt must not be sent
    /// on as though the hooks had checked it; a surface that sees this refuses
    /// the turn. A hook that merely fails or times out does not set it.
    pub interrupted: bool,
}

/// `hooks` run for one turn. Same trust, timeouts and output caps as the loop:
/// nothing here is new, it is the loop's calls behind a different door.
pub async fn context_for_turn(
    hooks: &[Hook],
    session_id: Option<&str>,
    cwd: &Path,
    prompt: Option<&str>,
    cancel: Option<&CancelToken>,
) -> CcContextHooks {
    if hooks.is_empty() {
        return CcContextHooks::default();
    }
    let session_start = session_start_context(hooks, session_id, cwd).await;
    let (prompt_submit, interrupted) = match prompt.map(str::trim).filter(|p| !p.is_empty()) {
        Some(prompt) => {
            match prompt_submit_context(hooks, session_id, cwd, prompt, cancel).await {
                Ok(blocks) => (blocks, false),
                Err(_) => (Vec::new(), true),
            }
        }
        None => (Vec::new(), false),
    };
    CcContextHooks {
        enabled: true,
        session_start,
        prompt_submit,
        interrupted,
    }
}

/// Tauri command: run the Claude Code context hooks for a turn. Never an
/// error: a missing opt-in, a broken hook or an unreadable `~/.claude` all come
/// back as nothing to add, because these hooks only ever add to a prompt.
#[cfg_attr(not(feature = "cli"), tauri::command)]
pub async fn run_cc_context_hooks(
    session_id: Option<String>,
    project_dir: Option<String>,
    prompt: Option<String>,
) -> CcContextHooks {
    let hooks = active();
    let cwd = project_dir
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .or_else(crate::core::app::commands::jan_home_dir)
        .unwrap_or_default();
    // Registered under the session so a stop aimed at it (the person pressing
    // Stop, an application-wide stop) reaches the hooks too. Without a session
    // there is nothing for a stop to name.
    let registered = session_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(|id| {
            use tauri_plugin_agent_tools::lifecycle::{register, Scope};
            register(CancelToken::new(Scope::new(id, "", "cc-prompt-hooks")))
        });
    context_for_turn(
        &hooks,
        session_id.as_deref(),
        &cwd,
        prompt.as_deref(),
        registered.as_ref().map(|r| r.token()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_home_follows_the_app_home_not_the_real_profile() {
        let home = crate::core::app::commands::jan_home_dir().expect("home");
        assert_eq!(claude_home(), Some(home.join(".claude")));
        if let Some(real) = dirs::home_dir() {
            assert_ne!(claude_home(), Some(real.join(".claude")));
        }
    }
    use crate::core::agent::cc_links::Link;

    fn links(hooks: bool, plugin_root: Option<&Path>) -> Links {
        Links {
            hooks,
            items: plugin_root
                .map(|root| {
                    vec![Link {
                        kind: LinkKind::Plugin,
                        name: "superpowers".into(),
                        origin: "cc-user".into(),
                        source_path: root.to_string_lossy().into_owned(),
                        fingerprint: 0,
                    }]
                })
                .unwrap_or_default(),
        }
    }

    #[test]
    fn nothing_runs_unless_the_user_opted_in() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("settings.json"),
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}"#,
        )
        .unwrap();
        assert!(discover(home.path(), &links(false, None)).is_empty());
        assert_eq!(discover(home.path(), &links(true, None)).len(), 1);
    }

    #[test]
    fn only_context_events_and_command_hooks_are_read() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("settings.json"),
            r#"{"hooks":{
                "PreToolUse":[{"hooks":[{"type":"command","command":"gate"}]}],
                "Stop":[{"hooks":[{"type":"command","command":"tidy"}]}],
                "SessionStart":[
                    {"matcher":"resume","hooks":[{"type":"command","command":"on-resume"}]},
                    {"matcher":"startup|clear","hooks":[{"type":"command","command":"on-start","timeout":5}]},
                    {"hooks":[{"type":"prompt","command":"not-a-command"}]}
                ],
                "UserPromptSubmit":[{"hooks":[{"type":"command","command":"on-prompt","timeout":999}]}]
            }}"#,
        )
        .unwrap();
        let hooks = discover(home.path(), &links(true, None));
        let got: Vec<_> = hooks.iter().map(|h| (h.event, h.command.as_str(), h.timeout_secs)).collect();
        assert_eq!(
            got,
            vec![
                (Event::SessionStart, "on-start", 5),
                (Event::UserPromptSubmit, "on-prompt", MAX_TIMEOUT_SECS),
            ]
        );
    }

    #[test]
    fn plugin_hooks_come_from_the_linked_plugin_directory() {
        let home = tempfile::tempdir().unwrap();
        let plugin = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(plugin.path().join("hooks")).unwrap();
        std::fs::write(
            plugin.path().join("hooks").join("hooks.json"),
            r#"{"hooks":{"SessionStart":[{"matcher":"startup|clear|compact","hooks":[{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/hooks/session-start\""}]}]}}"#,
        )
        .unwrap();
        let hooks = discover(home.path(), &links(true, Some(plugin.path())));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].plugin_root.as_deref(), Some(plugin.path()));
    }

    #[test]
    fn duplicate_commands_run_once() {
        let home = tempfile::tempdir().unwrap();
        let plugin = tempfile::tempdir().unwrap();
        let doc = r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"same"}]}]}}"#;
        std::fs::write(home.path().join("settings.json"), doc).unwrap();
        std::fs::create_dir_all(plugin.path().join("hooks")).unwrap();
        std::fs::write(plugin.path().join("hooks").join("hooks.json"), doc).unwrap();
        assert_eq!(discover(home.path(), &links(true, Some(plugin.path()))).len(), 1);
    }

    #[test]
    fn output_is_plain_text_or_json_additional_context() {
        assert_eq!(context_from_output("  be terse \n").as_deref(), Some("be terse"));
        assert_eq!(context_from_output("   "), None);
        assert_eq!(
            context_from_output(r#"{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"style on"}}"#)
                .as_deref(),
            Some("style on")
        );
        assert_eq!(context_from_output(r#"{"additionalContext":"top"}"#).as_deref(), Some("top"));
        // JSON that carries no context adds nothing, rather than printing JSON at the model.
        assert_eq!(context_from_output(r#"{"continue":true}"#), None);
        // Text that merely starts with a brace is text.
        assert_eq!(context_from_output("{not json").as_deref(), Some("{not json"));
    }

    #[test]
    fn oversized_output_is_cut() {
        let big = "x".repeat(MAX_CONTEXT_CHARS + 50);
        let got = context_from_output(&big).unwrap();
        assert!(got.ends_with("[hook output truncated]"));
        assert!(got.len() < big.len());
    }

    #[tokio::test]
    async fn no_hooks_means_a_disabled_empty_answer() {
        let cwd = tempfile::tempdir().unwrap();
        let got = context_for_turn(&[], Some("s"), cwd.path(), Some("hi"), None).await;
        assert_eq!(got, CcContextHooks::default());
        assert!(!got.enabled);
    }

    #[tokio::test]
    async fn a_hook_that_cannot_run_adds_nothing_but_the_turn_goes_on() {
        let cwd = tempfile::tempdir().unwrap();
        let hooks = vec![Hook {
            event: Event::UserPromptSubmit,
            command: "definitely-not-a-real-command-qagap".into(),
            timeout_secs: 5,
            plugin_root: None,
        }];
        let got = context_for_turn(&hooks, Some("s"), cwd.path(), Some("hi"), None).await;
        assert!(got.enabled);
        assert!(got.prompt_submit.is_empty());
        assert!(got.session_start.is_empty());
    }

    /// These hooks only ever add to a prompt; none of them can hold it back.
    /// A prompt hook that exits non-zero (Claude Code's "block" is exit 2) or
    /// outlives its limit -- what a stopped run looks like from here -- adds
    /// nothing and the turn still carries the prompt as written. There is no
    /// outcome in which the prompt is dropped, or passed on as if a hook had
    /// approved it.
    #[tokio::test]
    async fn a_failed_or_timed_out_prompt_hook_adds_nothing_and_leaves_the_prompt_alone() {
        let cwd = tempfile::tempdir().unwrap();
        let hook = |command: &str, timeout_secs| Hook {
            event: Event::UserPromptSubmit,
            command: command.into(),
            timeout_secs,
            plugin_root: None,
        };
        let hooks = vec![hook("exit 2", 5), hook("sleep 10", 1)];
        let started = std::time::Instant::now();
        let got = context_for_turn(&hooks, Some("s"), cwd.path(), Some("hi"), None).await;
        assert!(got.enabled);
        assert!(started.elapsed() < Duration::from_secs(8), "the slow hook was not bounded");
        assert!(got.prompt_submit.is_empty());
        assert!(got.session_start.is_empty());
    }

    #[tokio::test]
    async fn a_blank_prompt_skips_the_prompt_hooks() {
        let cwd = tempfile::tempdir().unwrap();
        let hooks = vec![Hook {
            event: Event::UserPromptSubmit,
            command: "echo ran".into(),
            timeout_secs: 5,
            plugin_root: None,
        }];
        let got = context_for_turn(&hooks, Some("s"), cwd.path(), Some("   "), None).await;
        assert!(got.enabled);
        assert!(got.prompt_submit.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_turn_gets_session_and_prompt_context_together() {
        let cwd = tempfile::tempdir().unwrap();
        let hooks = vec![
            Hook {
                event: Event::SessionStart,
                command: "echo style-on".into(),
                timeout_secs: 5,
                plugin_root: None,
            },
            Hook {
                event: Event::UserPromptSubmit,
                command: "echo per-prompt".into(),
                timeout_secs: 5,
                plugin_root: None,
            },
        ];
        let got = context_for_turn(&hooks, Some("turn-s1"), cwd.path(), Some("hello"), None).await;
        assert_eq!(got.session_start, vec!["style-on".to_string()]);
        assert_eq!(got.prompt_submit, vec!["per-prompt".to_string()]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_hook_receives_the_prompt_and_its_output_comes_back() {
        let cwd = tempfile::tempdir().unwrap();
        let hooks = vec![Hook {
            event: Event::UserPromptSubmit,
            command: "python3 -c 'import sys,json; print(\"saw: \" + json.load(sys.stdin)[\"prompt\"])'"
                .into(),
            timeout_secs: 10,
            plugin_root: None,
        }];
        let got = prompt_submit_context(&hooks, Some("s1"), cwd.path(), "hello", None)
            .await
            .unwrap();
        assert_eq!(got, vec!["saw: hello".to_string()]);
    }

    #[tokio::test]
    async fn a_turn_stopped_while_prompt_hooks_run_is_interrupted_not_checked() {
        use tauri_plugin_agent_tools::lifecycle::StopReason;
        let cwd = tempfile::tempdir().unwrap();
        let hooks = vec![Hook {
            event: Event::UserPromptSubmit,
            command: "sleep 10".into(),
            timeout_secs: 30,
            plugin_root: None,
        }];
        let token = CancelToken::detached();
        let stopper = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            stopper.stop(StopReason::Cancelled);
        });
        let started = std::time::Instant::now();
        let got = prompt_submit_context(&hooks, Some("s"), cwd.path(), "hi", Some(&token)).await;
        assert_eq!(got, Err(Interrupted(StopReason::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(5), "the hook was not stopped");

        let turn = context_for_turn(&hooks, Some("s"), cwd.path(), Some("hi"), Some(&token)).await;
        assert!(turn.interrupted);
        assert!(turn.prompt_submit.is_empty());
    }

    #[tokio::test]
    async fn an_already_stopped_turn_runs_no_hook() {
        use tauri_plugin_agent_tools::lifecycle::StopReason;
        let cwd = tempfile::tempdir().unwrap();
        let marker = cwd.path().join("ran");
        let hooks = vec![Hook {
            event: Event::UserPromptSubmit,
            command: format!("echo x > \"{}\"", marker.to_string_lossy().replace('\\', "/")),
            timeout_secs: 5,
            plugin_root: None,
        }];
        let token = CancelToken::detached();
        token.stop(StopReason::Cancelled);
        let got = prompt_submit_context(&hooks, Some("s"), cwd.path(), "hi", Some(&token)).await;
        assert_eq!(got, Err(Interrupted(StopReason::Cancelled)));
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn a_failing_hook_on_a_live_turn_is_not_an_interruption() {
        let cwd = tempfile::tempdir().unwrap();
        let hooks = vec![Hook {
            event: Event::UserPromptSubmit,
            command: "exit 2".into(),
            timeout_secs: 5,
            plugin_root: None,
        }];
        let token = CancelToken::detached();
        let got = context_for_turn(&hooks, Some("s"), cwd.path(), Some("hi"), Some(&token)).await;
        assert!(got.enabled);
        assert!(!got.interrupted);
        assert!(got.prompt_submit.is_empty());
    }
}
