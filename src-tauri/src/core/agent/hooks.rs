//! Configurable command hooks fired on agent lifecycle events.
//!
//! A hook is a command Jan runs when something happens — a tool failed, a
//! compaction is about to start, a permission was denied, the working directory
//! changed, a file changed. Configuration is a map from event name to a list of
//! `{ matcher, hooks: [{ type: "command", command }] }` groups; a group fires
//! when its matcher matches the event's subject.
//!
//! This module owns the parts that must be correct independent of where the
//! events are produced: the event set, the typed payloads (common metadata plus
//! event-specific fields), matcher semantics validated at load time, recursion
//! protection, secret redaction, and a bounded process runner. Producers (the
//! tool loop, the compaction pipeline, the permission layer, the cwd manager,
//! the filesystem watcher) call [`HookRegistry::fire`] with a built payload.

use std::collections::BTreeMap;
use std::io::Write;
use std::process::Stdio;
use std::time::{Duration, Instant};

use glob::Pattern;
use serde::Deserialize;
use serde_json::{json, Value};

/// Load and compile a project's hook configuration from
/// `<repo>/.jan/agent/hooks.json`, if present and valid.
///
/// Returns `None` (not an error) when there is no file, so a project without
/// hooks pays nothing and behaves exactly as before. A present-but-invalid file
/// is logged and ignored rather than failing the run — a broken hook config must
/// not stop the agent.
pub fn load_from_project(repo: &std::path::Path) -> Option<HookRegistry> {
    let path = repo.join(".jan").join("agent").join("hooks.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<HookConfig>(&raw).map_err(|e| e.to_string()).and_then(|c| {
        HookRegistry::compile(&c).map_err(|e| e.0)
    }) {
        Ok(reg) => Some(reg),
        Err(e) => {
            log::warn!("ignoring invalid {}: {e}", path.display());
            None
        }
    }
}

/// Milliseconds since the Unix epoch, for a payload timestamp.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Every event a hook can bind to. The first three pairs mirror the usual
/// tool/stop lifecycle; the rest are the events this system adds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    Stop,
    StopFailure,
    PreCompact,
    PostCompact,
    PermissionRequest,
    PermissionDenied,
    CwdChanged,
    FileChanged,
}

impl HookEvent {
    /// The configuration key for this event.
    pub fn key(self) -> &'static str {
        match self {
            HookEvent::PreToolUse => "PreToolUse",
            HookEvent::PostToolUse => "PostToolUse",
            HookEvent::PostToolUseFailure => "PostToolUseFailure",
            HookEvent::Stop => "Stop",
            HookEvent::StopFailure => "StopFailure",
            HookEvent::PreCompact => "PreCompact",
            HookEvent::PostCompact => "PostCompact",
            HookEvent::PermissionRequest => "PermissionRequest",
            HookEvent::PermissionDenied => "PermissionDenied",
            HookEvent::CwdChanged => "CwdChanged",
            HookEvent::FileChanged => "FileChanged",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        [
            HookEvent::PreToolUse,
            HookEvent::PostToolUse,
            HookEvent::PostToolUseFailure,
            HookEvent::Stop,
            HookEvent::StopFailure,
            HookEvent::PreCompact,
            HookEvent::PostCompact,
            HookEvent::PermissionRequest,
            HookEvent::PermissionDenied,
            HookEvent::CwdChanged,
            HookEvent::FileChanged,
        ]
        .into_iter()
        .find(|e| e.key() == key)
    }

    /// Whether a failure of this hook should block the action that triggered it.
    /// Pre-events guard an action and may block it; post-events observe one that
    /// already happened and never block.
    pub fn is_blocking(self) -> bool {
        matches!(
            self,
            HookEvent::PreToolUse | HookEvent::PreCompact | HookEvent::PermissionRequest
        )
    }
}

/// One configured command hook.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HookCommand {
    #[serde(rename = "type")]
    pub kind: String,
    pub command: String,
}

/// A matcher plus the commands it fires.
#[derive(Debug, Clone, Deserialize)]
pub struct HookGroup {
    /// Glob matched against the event subject (tool name, file path, ...).
    /// Absent or empty means "match everything".
    #[serde(default)]
    pub matcher: String,
    #[serde(default)]
    pub hooks: Vec<HookCommand>,
}

/// The whole hook configuration: event key -> groups.
#[derive(Debug, Default, Deserialize)]
#[serde(transparent)]
pub struct HookConfig(pub BTreeMap<String, Vec<HookGroup>>);

/// One compiled group: an optional matcher (None = match all) and its commands.
type CompiledGroup = (Option<Pattern>, Vec<HookCommand>);

/// A validated, compiled registry.
pub struct HookRegistry {
    /// Compiled matchers per event.
    groups: BTreeMap<&'static str, Vec<CompiledGroup>>,
    /// Bound on how deep a hook-triggered chain may go before firing stops.
    max_chain_depth: u32,
    /// Per-hook wall-clock cap.
    timeout: Duration,
    /// Cap on captured stdout+stderr bytes.
    output_cap: usize,
}

/// Errors from validating a hook configuration, each naming the offending key.
#[derive(Debug, PartialEq, Eq)]
pub struct HookConfigError(pub String);

impl std::fmt::Display for HookConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl HookRegistry {
    /// Compile and validate a configuration. Fails on an unknown event key, a
    /// hook whose `type` is not `command`, an empty command, or a matcher that
    /// is not a valid glob — every error names what to fix.
    pub fn compile(config: &HookConfig) -> Result<Self, HookConfigError> {
        let mut groups: BTreeMap<&'static str, Vec<CompiledGroup>> = BTreeMap::new();
        for (key, group_list) in &config.0 {
            let event = HookEvent::from_key(key)
                .ok_or_else(|| HookConfigError(format!("unknown hook event {key:?}")))?;
            let mut compiled = Vec::new();
            for group in group_list {
                let pattern = if group.matcher.trim().is_empty() || group.matcher == "*" {
                    None
                } else {
                    Some(Pattern::new(&group.matcher).map_err(|e| {
                        HookConfigError(format!(
                            "{key}: matcher {:?} is not a valid glob: {e}",
                            group.matcher
                        ))
                    })?)
                };
                for hook in &group.hooks {
                    if hook.kind != "command" {
                        return Err(HookConfigError(format!(
                            "{key}: hook type {:?} is not supported (only \"command\")",
                            hook.kind
                        )));
                    }
                    if hook.command.trim().is_empty() {
                        return Err(HookConfigError(format!("{key}: hook command is empty")));
                    }
                }
                compiled.push((pattern, group.hooks.clone()));
            }
            groups.insert(event.key(), compiled);
        }
        Ok(Self {
            groups,
            max_chain_depth: 4,
            timeout: Duration::from_secs(30),
            output_cap: 64 * 1024,
        })
    }

    /// The commands that fire for `event` given its `subject` (the tool name,
    /// the changed path, ...). Deterministic: groups in configuration order,
    /// each group's hooks in order.
    pub fn select(&self, event: HookEvent, subject: &str) -> Vec<&HookCommand> {
        let Some(compiled) = self.groups.get(event.key()) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (pattern, hooks) in compiled {
            let matches = match pattern {
                None => true,
                Some(p) => p.matches(subject),
            };
            if matches {
                out.extend(hooks.iter());
            }
        }
        out
    }

    /// Fire the hooks for one event. Refuses to fire — returning an empty result
    /// — when the payload's chain depth has reached the recursion bound, so a
    /// hook that causes the same class of event cannot loop unboundedly. Post
    /// (non-blocking) hooks never fail the caller; a blocking event's caller
    /// inspects the outcomes and decides.
    pub fn fire(&self, event: HookEvent, payload: &HookPayload) -> Vec<HookOutcome> {
        if payload.chain_depth >= self.max_chain_depth {
            return Vec::new();
        }
        let subject = payload.subject();
        let commands = self.select(event, &subject);
        let body = payload.redacted_json();
        commands
            .into_iter()
            .map(|c| self.run(&c.command, &body))
            .collect()
    }

    /// Run one command, feeding the payload JSON on stdin, with a timeout and a
    /// bounded captured output. The command inherits no broader privilege than
    /// the session — callers run the registry under the same sandbox/permission
    /// context as the run.
    fn run(&self, command: &str, stdin_body: &str) -> HookOutcome {
        let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
            ("cmd", vec!["/C", command])
        } else {
            ("sh", vec!["-c", command])
        };
        let mut child = match std::process::Command::new(program)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                return HookOutcome {
                    command: command.to_string(),
                    exit_code: None,
                    timed_out: false,
                    output: format!("failed to spawn hook: {e}"),
                }
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(stdin_body.as_bytes());
        }
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let output = read_capped(child, self.output_cap);
                    return HookOutcome {
                        command: command.to_string(),
                        exit_code: status.code(),
                        timed_out: false,
                        output,
                    };
                }
                Ok(None) => {
                    if start.elapsed() >= self.timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return HookOutcome {
                            command: command.to_string(),
                            exit_code: None,
                            timed_out: true,
                            output: String::new(),
                        };
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    return HookOutcome {
                        command: command.to_string(),
                        exit_code: None,
                        timed_out: false,
                        output: format!("hook wait failed: {e}"),
                    }
                }
            }
        }
    }
}

fn read_capped(output: std::process::Child, cap: usize) -> String {
    let out = output.wait_with_output();
    match out {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            if s.len() > cap {
                s.truncate(cap);
                s.push_str("\n[hook output truncated]");
            }
            s
        }
        Err(e) => format!("hook output read failed: {e}"),
    }
}

/// The result of running one hook command.
#[derive(Debug, Clone, PartialEq)]
pub struct HookOutcome {
    pub command: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output: String,
}

impl HookOutcome {
    /// Whether this outcome should block a blocking event's action: a non-zero
    /// exit or a timeout.
    pub fn blocks(&self) -> bool {
        self.timed_out || self.exit_code.is_some_and(|c| c != 0)
    }
}

/// A hook payload: common metadata plus event-specific fields, and the chain
/// depth used for recursion protection.
#[derive(Debug, Clone)]
pub struct HookPayload {
    pub event: HookEvent,
    pub session_id: String,
    pub conversation_id: String,
    pub timestamp_ms: u64,
    pub cwd: String,
    pub workspace_id: String,
    pub correlation_id: String,
    /// How many hook-triggered events deep this chain is. A hook-generated
    /// operation carries the triggering payload's depth + 1.
    pub chain_depth: u32,
    /// Event-specific fields, already assembled by the producer.
    pub specific: Value,
}

impl HookPayload {
    /// The text a matcher is applied to for this event: the tool name for
    /// tool events, the path for `FileChanged`, and so on. Falls back to empty.
    pub fn subject(&self) -> String {
        self.specific
            .get("tool")
            .or_else(|| self.specific.get("path"))
            .or_else(|| self.specific.get("operation"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    /// The payload as JSON with sensitive fields redacted, ready to hand a hook.
    pub fn redacted_json(&self) -> String {
        let mut body = json!({
            "event": self.event.key(),
            "sessionId": self.session_id,
            "conversationId": self.conversation_id,
            "timestampMs": self.timestamp_ms,
            "cwd": self.cwd,
            "workspaceId": self.workspace_id,
            "correlationId": self.correlation_id,
            "chainDepth": self.chain_depth,
        });
        let mut specific = self.specific.clone();
        redact_in_place(&mut specific);
        body["data"] = specific;
        body.to_string()
    }

    /// A child payload for an event a hook itself caused: same correlation, one
    /// deeper. Used to bound recursion.
    pub fn child(&self, event: HookEvent, specific: Value) -> HookPayload {
        HookPayload {
            event,
            chain_depth: self.chain_depth + 1,
            specific,
            ..self.clone()
        }
    }
}

/// Redact values whose key names a secret, anywhere in the tree.
fn redact_in_place(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if is_secret_key(k) {
                    *v = json!("[redacted]");
                } else {
                    redact_in_place(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_in_place),
        _ => {}
    }
}

fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("token")
        || k.contains("secret")
        || k.contains("password")
        || k.contains("api_key")
        || k.contains("apikey")
        || k == "authorization"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(json_str: &str) -> HookConfig {
        serde_json::from_str(json_str).expect("parse config")
    }

    fn payload(event: HookEvent, specific: Value) -> HookPayload {
        HookPayload {
            event,
            session_id: "s1".into(),
            conversation_id: "c1".into(),
            timestamp_ms: 1,
            cwd: "/ws".into(),
            workspace_id: "w1".into(),
            correlation_id: "corr-1".into(),
            chain_depth: 0,
            specific,
        }
    }

    #[test]
    fn compiles_valid_config_and_selects_by_matcher() {
        let config = cfg(r#"{
            "PostToolUseFailure": [
                { "matcher": "bash", "hooks": [{ "type": "command", "command": "log.sh" }] },
                { "matcher": "*", "hooks": [{ "type": "command", "command": "always.sh" }] }
            ]
        }"#);
        let reg = HookRegistry::compile(&config).unwrap();
        let bash: Vec<&str> = reg
            .select(HookEvent::PostToolUseFailure, "bash")
            .into_iter()
            .map(|c| c.command.as_str())
            .collect();
        assert_eq!(bash, vec!["log.sh", "always.sh"], "deterministic order");
        let read: Vec<&str> = reg
            .select(HookEvent::PostToolUseFailure, "read")
            .into_iter()
            .map(|c| c.command.as_str())
            .collect();
        assert_eq!(read, vec!["always.sh"], "only the catch-all matches read");
    }

    #[test]
    fn rejects_invalid_config() {
        // Unknown event.
        assert!(HookRegistry::compile(&cfg(
            r#"{ "Nope": [{ "matcher": "*", "hooks": [] }] }"#
        ))
        .is_err());
        // Non-command hook type.
        assert!(HookRegistry::compile(&cfg(
            r#"{ "Stop": [{ "hooks": [{ "type": "webhook", "command": "x" }] }] }"#
        ))
        .is_err());
        // Empty command.
        assert!(HookRegistry::compile(&cfg(
            r#"{ "Stop": [{ "hooks": [{ "type": "command", "command": "  " }] }] }"#
        ))
        .is_err());
        // Bad glob.
        assert!(HookRegistry::compile(&cfg(
            r#"{ "FileChanged": [{ "matcher": "[", "hooks": [{ "type": "command", "command": "x" }] }] }"#
        ))
        .is_err());
    }

    #[test]
    fn blocking_classification_matches_the_event() {
        assert!(HookEvent::PreToolUse.is_blocking());
        assert!(HookEvent::PreCompact.is_blocking());
        assert!(HookEvent::PermissionRequest.is_blocking());
        assert!(!HookEvent::PostToolUseFailure.is_blocking());
        assert!(!HookEvent::FileChanged.is_blocking());
        assert!(!HookEvent::PostCompact.is_blocking());
    }

    #[test]
    fn payload_redacts_secrets_and_carries_common_metadata() {
        let p = payload(
            HookEvent::PermissionDenied,
            json!({ "operation": "bash", "api_key": "sk-123", "nested": { "token": "t" } }),
        );
        let body: Value = serde_json::from_str(&p.redacted_json()).unwrap();
        assert_eq!(body["event"], "PermissionDenied");
        assert_eq!(body["sessionId"], "s1");
        assert_eq!(body["correlationId"], "corr-1");
        assert_eq!(body["data"]["api_key"], "[redacted]");
        assert_eq!(body["data"]["nested"]["token"], "[redacted]");
        assert_eq!(body["data"]["operation"], "bash");
    }

    #[test]
    fn recursion_is_bounded_by_chain_depth() {
        let config = cfg(r#"{ "FileChanged": [{ "matcher": "*", "hooks": [
            { "type": "command", "command": "should-not-run" }
        ] }] }"#);
        let reg = HookRegistry::compile(&config).unwrap();
        let mut p = payload(HookEvent::FileChanged, json!({ "path": "a.txt" }));
        p.chain_depth = reg.max_chain_depth; // at the bound.
        let outcomes = reg.fire(HookEvent::FileChanged, &p);
        assert!(outcomes.is_empty(), "a chain at the bound must not fire");
    }

    #[test]
    fn child_payload_deepens_the_chain_and_keeps_correlation() {
        let p = payload(HookEvent::PostToolUse, json!({ "tool": "bash" }));
        let c = p.child(HookEvent::FileChanged, json!({ "path": "x" }));
        assert_eq!(c.chain_depth, 1);
        assert_eq!(c.correlation_id, "corr-1");
        assert_eq!(c.event, HookEvent::FileChanged);
    }

    #[test]
    fn fire_runs_a_command_and_captures_its_exit() {
        // A portable no-op that succeeds, and one that fails.
        let ok_cmd = if cfg!(windows) { "exit 0" } else { "true" };
        let fail_cmd = if cfg!(windows) { "exit 3" } else { "exit 3" };
        let config = HookConfig({
            let mut m = BTreeMap::new();
            m.insert(
                "PostToolUse".to_string(),
                vec![HookGroup {
                    matcher: "bash".into(),
                    hooks: vec![
                        HookCommand { kind: "command".into(), command: ok_cmd.into() },
                        HookCommand { kind: "command".into(), command: fail_cmd.into() },
                    ],
                }],
            );
            m
        });
        let reg = HookRegistry::compile(&config).unwrap();
        let p = payload(HookEvent::PostToolUse, json!({ "tool": "bash" }));
        let outcomes = reg.fire(HookEvent::PostToolUse, &p);
        assert_eq!(outcomes.len(), 2);
        assert_eq!(outcomes[0].exit_code, Some(0));
        assert!(!outcomes[0].blocks());
        assert_eq!(outcomes[1].exit_code, Some(3));
        assert!(outcomes[1].blocks());
    }

    #[test]
    fn load_from_project_reads_and_fires_a_configured_hook() {
        // The production path: a hooks.json under .jan/agent/ compiles into a
        // registry, and a PostToolUse payload for `bash` fires its command, which
        // writes a marker file. Proves config-load -> registry -> runner.
        let dir = std::env::temp_dir().join(format!("jan-hooks-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let agent = dir.join(".jan").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        let marker = dir.join("fired.marker");
        // Native path, with backslashes doubled so it survives JSON parsing;
        // the shell then sees the real path.
        let marker_json = marker.to_string_lossy().replace('\\', "\\\\");
        let cmd = if cfg!(windows) {
            format!("echo hooked>{marker_json}")
        } else {
            format!("echo hooked > {marker_json}")
        };
        let config = format!(
            r#"{{ "PostToolUse": [ {{ "matcher": "bash", "hooks": [ {{ "type": "command", "command": "{cmd}" }} ] }} ] }}"#
        );
        std::fs::write(agent.join("hooks.json"), config).unwrap();

        let reg = load_from_project(&dir).expect("hooks compiled from project");
        let p = payload(HookEvent::PostToolUse, json!({ "tool": "bash" }));
        let outcomes = reg.fire(HookEvent::PostToolUse, &p);
        assert_eq!(outcomes.len(), 1, "the configured hook fired");
        assert!(marker.exists(), "the hook command ran and wrote its marker");

        // A non-matching subject fires nothing.
        let read_p = payload(HookEvent::PostToolUse, json!({ "tool": "read" }));
        assert!(reg.fire(HookEvent::PostToolUse, &read_p).is_empty());

        // No config -> None, no work.
        let empty = std::env::temp_dir().join(format!("jan-hooks-none-{}", std::process::id()));
        assert!(load_from_project(&empty).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hook_that_times_out_is_reported_and_killed() {
        let config = HookConfig({
            let mut m = BTreeMap::new();
            let sleep_cmd = if cfg!(windows) {
                // ping is the portable "sleep" on Windows without extra tools.
                "ping -n 30 127.0.0.1 >NUL"
            } else {
                "sleep 30"
            };
            m.insert(
                "PreToolUse".to_string(),
                vec![HookGroup {
                    matcher: "*".into(),
                    hooks: vec![HookCommand { kind: "command".into(), command: sleep_cmd.into() }],
                }],
            );
            m
        });
        let mut reg = HookRegistry::compile(&config).unwrap();
        reg.timeout = Duration::from_millis(200); // shorten for the test.
        let p = payload(HookEvent::PreToolUse, json!({ "tool": "bash" }));
        let outcomes = reg.fire(HookEvent::PreToolUse, &p);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].timed_out, "a slow hook must be timed out");
        assert!(outcomes[0].blocks(), "a timed-out blocking hook blocks");
    }
}
