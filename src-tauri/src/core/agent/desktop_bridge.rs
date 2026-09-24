//! `jan-desktop`: an in-process MCP server that exposes a small, tightly-scoped
//! set of Jan's desktop UI capabilities to the agent as ordinary MCP tools,
//! instead of bespoke agent-to-UI calls.
//!
//! This module holds the part that must be correct regardless of the transport:
//! the five tools' schemas, their typed arguments, and the authorization layer —
//! path containment, bounded terminal reads, a session-scoped diff-id registry
//! that rejects stale or cross-session ids, and a settings allowlist. Every
//! request is bound to the window, workspace, conversation, and session it came
//! from, so one conversation can never open another's files or accept another's
//! diff.
//!
//! The actual UI work (opening an editor, reading a terminal, showing a diff,
//! writing a setting) is behind the [`DesktopUi`] trait, so the domain services
//! stay the single implementation and this logic is testable with a fake. The
//! rmcp `ServerHandler` that speaks the wire protocol is a thin adapter over
//! [`DesktopBridge::dispatch`]; it does no validation of its own.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

/// The MCP server name the agent sees. Local and non-networked.
pub const SERVER_NAME: &str = "jan-desktop";

/// Who a request belongs to. Minted by the desktop host from the live window and
/// conversation, never from anything the model can influence, and carried on
/// every dispatch so a tool can only ever act within this scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestContext {
    pub window_id: String,
    pub workspace_root: PathBuf,
    pub conversation_id: String,
    pub session_id: String,
}

/// The desktop capabilities the bridge drives. Implemented once by the real
/// domain services; a fake stands in for tests.
pub trait DesktopUi {
    /// Open `path` (already validated to be inside the workspace) at an optional
    /// 1-based line/column.
    fn open_file(&self, path: &Path, line: Option<u32>, column: Option<u32>) -> Result<(), String>;
    /// Return recent terminal output for `terminal_id` (or the session's default
    /// when `None`), already bounded to `max_lines`.
    fn terminal_contents(&self, terminal_id: Option<&str>, max_lines: usize)
        -> Result<String, String>;
    /// Show a diff and return a host-side identifier for it.
    fn show_diff(&self, path: &Path, diff: &str) -> Result<String, String>;
    /// Record that a diff the host issued was accepted.
    fn diff_accepted(&self, diff_id: &str) -> Result<(), String>;
    /// Apply one setting (already allowlist-checked), returning its previous and
    /// resulting values.
    fn apply_setting(&self, key: &str, value: &Value) -> Result<SettingChange, String>;
}

/// The before/after of a setting change, for the tool result. Secret-valued
/// settings are redacted by [`redact_setting`] before they leave the bridge.
#[derive(Clone, Debug, PartialEq)]
pub struct SettingChange {
    pub key: String,
    pub previous: Value,
    pub resulting: Value,
}

/// Settings the agent is allowed to change. Anything not listed is refused, so a
/// new setting is opt-in rather than reachable by default.
const SETTINGS_ALLOWLIST: &[&str] = &[
    "editor.fontSize",
    "editor.wordWrap",
    "editor.theme",
    "ui.density",
    "agent.showReasoning",
];

/// Keys whose value must never appear in a tool result or log, even on the
/// allowlist path (kept here so a future allowlisted secret is redacted).
fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("token") || k.contains("secret") || k.contains("api_key") || k.contains("apikey")
        || k.contains("password")
}

/// Redact a setting change whose key is sensitive.
pub fn redact_setting(mut change: SettingChange) -> SettingChange {
    if is_secret_key(&change.key) {
        change.previous = json!("[redacted]");
        change.resulting = json!("[redacted]");
    }
    change
}

/// The diff-id registry and the bridge's dispatch entry point.
pub struct DesktopBridge<U: DesktopUi> {
    ui: U,
    /// Diff ids the bridge has handed out, each bound to the session that
    /// created it. A `diff_accepted` for an id not in here — unknown, stale, or
    /// from another session — is refused.
    issued_diffs: HashMap<String, String>, // diff_id -> session_id
    /// Upper bound on terminal lines returned, whatever the request asks for.
    max_terminal_lines: usize,
}

impl<U: DesktopUi> DesktopBridge<U> {
    pub fn new(ui: U) -> Self {
        Self {
            ui,
            issued_diffs: HashMap::new(),
            max_terminal_lines: 1_000,
        }
    }

    /// The five tools' MCP schemas, advertised under [`SERVER_NAME`].
    pub fn tool_schemas() -> Vec<Value> {
        vec![
            json!({
                "name": "open_file",
                "description": "Open a workspace file in Jan's editor at an optional line and column. The path must be inside the current workspace; an absolute or escaping path is refused.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Workspace-relative path to open." },
                        "line": { "type": "integer", "description": "1-based line to reveal." },
                        "column": { "type": "integer", "description": "1-based column to reveal." }
                    },
                    "required": ["path"]
                }
            }),
            json!({
                "name": "get_terminal_contents",
                "description": "Return recent output from a terminal in this session, bounded in size. Only this session's terminals are visible.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "terminal_id": { "type": "string", "description": "Terminal to read; omit for the session's default." },
                        "max_lines": { "type": "integer", "description": "Maximum lines to return; clamped to the server's cap." }
                    },
                    "required": []
                }
            }),
            json!({
                "name": "show_diff",
                "description": "Show a diff for a workspace file in Jan's diff UI and return a diff id. The path must be inside the workspace.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Workspace-relative path the diff applies to." },
                        "diff": { "type": "string", "description": "Unified-diff text to display." }
                    },
                    "required": ["path", "diff"]
                }
            }),
            json!({
                "name": "diff_accepted",
                "description": "Record that a diff this server issued was accepted. The diff id must be one issued to this session; an unknown, stale, or cross-session id is refused.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "diff_id": { "type": "string", "description": "The id returned by show_diff." }
                    },
                    "required": ["diff_id"]
                }
            }),
            json!({
                "name": "apply_settings",
                "description": "Change one allowlisted Jan setting and return its previous and resulting values. A setting not on the allowlist is refused; a sensitive value is redacted in the result.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string", "description": "Dotted setting name; must be allowlisted." },
                        "value": { "description": "New value for the setting." }
                    },
                    "required": ["key", "value"]
                }
            }),
        ]
    }

    /// Route one tool call. Returns the tool result value, or a structured error
    /// string. All authorization happens here, before the [`DesktopUi`] is touched.
    pub fn dispatch(&mut self, ctx: &RequestContext, tool: &str, args: &Value) -> Result<Value, String> {
        match tool {
            "open_file" => self.open_file(ctx, args),
            "get_terminal_contents" => self.get_terminal_contents(args),
            "show_diff" => self.show_diff(ctx, args),
            "diff_accepted" => self.diff_accepted(ctx, args),
            "apply_settings" => self.apply_settings(args),
            other => Err(format!("unknown jan-desktop tool: {other}")),
        }
    }

    fn open_file(&self, ctx: &RequestContext, args: &Value) -> Result<Value, String> {
        let rel = arg_str(args, "path")?;
        let target = resolve_in_workspace(&ctx.workspace_root, rel)?;
        let line = arg_u32(args, "line")?;
        let column = arg_u32(args, "column")?;
        self.ui.open_file(&target, line, column)?;
        Ok(json!({ "opened": rel }))
    }

    fn get_terminal_contents(&self, args: &Value) -> Result<Value, String> {
        let terminal_id = args.get("terminal_id").and_then(|v| v.as_str());
        let requested = arg_u32(args, "max_lines")?.unwrap_or(200) as usize;
        let bounded = requested.clamp(1, self.max_terminal_lines);
        let text = self.ui.terminal_contents(terminal_id, bounded)?;
        Ok(json!({ "contents": text, "max_lines": bounded }))
    }

    fn show_diff(&mut self, ctx: &RequestContext, args: &Value) -> Result<Value, String> {
        let rel = arg_str(args, "path")?;
        let target = resolve_in_workspace(&ctx.workspace_root, rel)?;
        let diff = arg_str(args, "diff")?;
        let diff_id = self.ui.show_diff(&target, diff)?;
        self.issued_diffs.insert(diff_id.clone(), ctx.session_id.clone());
        Ok(json!({ "diff_id": diff_id }))
    }

    fn diff_accepted(&mut self, ctx: &RequestContext, args: &Value) -> Result<Value, String> {
        let diff_id = arg_str(args, "diff_id")?;
        match self.issued_diffs.get(diff_id) {
            Some(owner) if owner == &ctx.session_id => {}
            Some(_) => return Err("diff id belongs to another session".to_string()),
            None => return Err("unknown or stale diff id".to_string()),
        }
        self.ui.diff_accepted(diff_id)?;
        // One acceptance per id: consume it so a replay is refused.
        self.issued_diffs.remove(diff_id);
        Ok(json!({ "accepted": diff_id }))
    }

    fn apply_settings(&self, args: &Value) -> Result<Value, String> {
        let key = arg_str(args, "key")?;
        if !SETTINGS_ALLOWLIST.contains(&key) {
            return Err(format!("setting {key:?} is not allowed to be changed by the agent"));
        }
        let value = args
            .get("value")
            .ok_or_else(|| "missing required argument 'value'".to_string())?;
        let change = redact_setting(self.ui.apply_setting(key, value)?);
        Ok(json!({
            "key": change.key,
            "previous": change.previous,
            "resulting": change.resulting,
        }))
    }
}

/// Resolve a workspace-relative path and refuse anything that escapes the
/// workspace. Lexical only (no filesystem access, no symlink following), so a
/// path that does not exist yet still validates and a planted symlink cannot
/// redirect the check.
fn resolve_in_workspace(workspace: &Path, rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() || has_drive_or_root(trimmed) {
        return Err(format!("{rel:?} must be a workspace-relative path"));
    }
    let mut out = workspace.to_path_buf();
    for comp in candidate.components() {
        match comp {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("{rel:?} must not climb out of the workspace"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("{rel:?} must be a workspace-relative path"));
            }
        }
    }
    // Belt and braces: the normalized result must still be under the workspace.
    if !out.starts_with(workspace) || out == workspace {
        return Err(format!("{rel:?} does not resolve to a file inside the workspace"));
    }
    Ok(out)
}

fn has_drive_or_root(s: &str) -> bool {
    let b = s.as_bytes();
    s.starts_with('/')
        || s.starts_with('\\')
        || (b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic())
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("missing or empty required argument '{key}'"))
}

fn arg_u32(args: &Value, key: &str) -> Result<Option<u32>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= u32::MAX as u64)
            .map(|n| Some(n as u32))
            .ok_or_else(|| format!("argument '{key}' must be a non-negative integer")),
    }
}

/// A [`DesktopUi`] backed by the on-disk settings JSON for `apply_setting`, with
/// the UI-only capabilities (open file, terminal, diff) reporting that no
/// interactive desktop surface is attached to this context.
///
/// This is the runtime-reachable slice: `apply_settings` genuinely reads and
/// writes the settings file (allowlisted, atomically), so the agent can change a
/// permitted setting end to end. The editor/terminal/diff tools require a live
/// window and are served by the desktop's window layer, which supplies its own
/// [`DesktopUi`]; here they refuse rather than pretend.
pub struct FileSettingsUi {
    settings_path: PathBuf,
    /// Write through the app's settings store instead of the file.
    shared: bool,
}

impl FileSettingsUi {
    pub fn new(settings_path: PathBuf) -> Self {
        Self { settings_path, shared: false }
    }

    /// The app's own `settings.json`, changed through `settings_store`
    /// (Jozkah/jan#240).
    ///
    /// The webview's settings store holds that file in memory and rewrites
    /// the whole of it on a debounce. A write of our own straight to the file
    /// was lost at its next flush, and a flush in flight was lost to ours --
    /// whichever landed second won. Going through the store's own
    /// `settings_get`/`settings_set` puts the change under its lock and into
    /// the map it flushes, so both writers' keys survive.
    pub fn app_store() -> Self {
        Self { settings_path: PathBuf::new(), shared: true }
    }

    fn read(&self) -> serde_json::Map<String, Value> {
        std::fs::read_to_string(&self.settings_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }
}

impl DesktopUi for FileSettingsUi {
    fn open_file(&self, _path: &Path, _line: Option<u32>, _column: Option<u32>) -> Result<(), String> {
        Err("no interactive desktop surface is attached to this session".to_string())
    }
    fn terminal_contents(&self, _id: Option<&str>, _max: usize) -> Result<String, String> {
        Err("no interactive desktop surface is attached to this session".to_string())
    }
    fn show_diff(&self, _path: &Path, _diff: &str) -> Result<String, String> {
        Err("no interactive desktop surface is attached to this session".to_string())
    }
    fn diff_accepted(&self, _diff_id: &str) -> Result<(), String> {
        Err("no interactive desktop surface is attached to this session".to_string())
    }
    fn apply_setting(&self, key: &str, value: &Value) -> Result<SettingChange, String> {
        if self.shared {
            let previous = crate::core::app::settings_store::settings_get(key.to_string())
                .map_or(Value::Null, |s| from_store_value(&s));
            crate::core::app::settings_store::settings_set(key.to_string(), to_store_value(value))?;
            return Ok(SettingChange {
                key: key.to_string(),
                previous,
                resulting: value.clone(),
            });
        }
        let mut map = self.read();
        let previous = map.get(key).cloned().unwrap_or(Value::Null);
        map.insert(key.to_string(), value.clone());
        let serialized =
            serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
        // Atomic write: temp + rename, so a crash never truncates settings.
        let dir = self
            .settings_path
            .parent()
            .ok_or_else(|| "settings path has no parent".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".settings.tmp-{}", std::process::id()));
        std::fs::write(&tmp, serialized).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.settings_path).map_err(|e| e.to_string())?;
        Ok(SettingChange {
            key: key.to_string(),
            previous,
            resulting: value.clone(),
        })
    }
}

/// The settings store keeps every value as a string (`{ key: string }`); a
/// bare JSON number written into the file made the whole map fail to parse.
/// A string is kept as it is, anything else as its JSON text.
fn to_store_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The inverse of [`to_store_value`]: JSON text back to its value, anything
/// else as the string it is.
fn from_store_value(stored: &str) -> Value {
    serde_json::from_str::<Value>(stored)
        .ok()
        .filter(|v| !v.is_string())
        .unwrap_or_else(|| Value::String(stored.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Values go into the settings store as strings and come back as what
    /// they were (#240).
    #[test]
    fn store_values_round_trip() {
        for v in [json!(16), json!(true), json!("compact"), json!({ "a": 1 })] {
            assert_eq!(from_store_value(&to_store_value(&v)), v, "{v}");
        }
        assert_eq!(to_store_value(&json!("compact")), "compact");
        assert!(FileSettingsUi::app_store().shared);
        assert!(!FileSettingsUi::new(PathBuf::from("x")).shared);
    }

    /// A file opened, with its line and column.
    type Opened = (PathBuf, Option<u32>, Option<u32>);

    #[derive(Default)]
    struct FakeUi {
        opened: RefCell<Vec<Opened>>,
        accepted: RefCell<Vec<String>>,
        next_diff_id: RefCell<u32>,
    }
    impl DesktopUi for FakeUi {
        fn open_file(&self, path: &Path, line: Option<u32>, column: Option<u32>) -> Result<(), String> {
            self.opened.borrow_mut().push((path.to_path_buf(), line, column));
            Ok(())
        }
        fn terminal_contents(&self, _id: Option<&str>, max_lines: usize) -> Result<String, String> {
            Ok(format!("<= {max_lines} lines"))
        }
        fn show_diff(&self, _path: &Path, _diff: &str) -> Result<String, String> {
            let mut n = self.next_diff_id.borrow_mut();
            *n += 1;
            Ok(format!("diff-{n}"))
        }
        fn diff_accepted(&self, diff_id: &str) -> Result<(), String> {
            self.accepted.borrow_mut().push(diff_id.to_string());
            Ok(())
        }
        fn apply_setting(&self, key: &str, value: &Value) -> Result<SettingChange, String> {
            Ok(SettingChange {
                key: key.to_string(),
                previous: json!("old"),
                resulting: value.clone(),
            })
        }
    }

    fn ctx(session: &str) -> RequestContext {
        RequestContext {
            window_id: "w1".into(),
            workspace_root: PathBuf::from(if cfg!(windows) { "C:\\ws" } else { "/ws" }),
            conversation_id: "c1".into(),
            session_id: session.into(),
        }
    }

    fn bridge() -> DesktopBridge<FakeUi> {
        DesktopBridge::new(FakeUi::default())
    }

    #[test]
    fn advertises_five_tools() {
        let schemas = DesktopBridge::<FakeUi>::tool_schemas();
        let names: Vec<&str> = schemas
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "open_file",
                "get_terminal_contents",
                "show_diff",
                "diff_accepted",
                "apply_settings"
            ]
        );
    }

    #[test]
    fn open_file_validates_workspace_containment() {
        let mut b = bridge();
        let c = ctx("s1");
        b.dispatch(&c, "open_file", &json!({ "path": "src/main.rs", "line": 12 }))
            .expect("in-workspace open");
        for bad in ["../secret", "/etc/passwd", "C:/Windows/x", "", "sub/../../up"] {
            assert!(
                b.dispatch(&c, "open_file", &json!({ "path": bad })).is_err(),
                "escaping path {bad:?} must be refused"
            );
        }
    }

    #[test]
    fn terminal_contents_are_bounded() {
        let mut b = bridge();
        let c = ctx("s1");
        let out = b
            .dispatch(&c, "get_terminal_contents", &json!({ "max_lines": 100000 }))
            .unwrap();
        // Clamped to the server cap (1000), not the requested 100000.
        assert_eq!(out["max_lines"], 1000);
    }

    #[test]
    fn diff_accept_requires_an_id_issued_to_this_session() {
        let mut b = bridge();
        let c = ctx("s1");
        let issued = b
            .dispatch(&c, "show_diff", &json!({ "path": "a.txt", "diff": "@@" }))
            .unwrap();
        let id = issued["diff_id"].as_str().unwrap().to_string();

        // Another session cannot accept it.
        let other = ctx("s2");
        assert!(b
            .dispatch(&other, "diff_accepted", &json!({ "diff_id": id }))
            .is_err());
        // Unknown id is refused.
        assert!(b
            .dispatch(&c, "diff_accepted", &json!({ "diff_id": "diff-999" }))
            .is_err());
        // The owner accepts once...
        b.dispatch(&c, "diff_accepted", &json!({ "diff_id": id.clone() }))
            .expect("owner accepts");
        // ...and a replay is now refused (id consumed).
        assert!(b
            .dispatch(&c, "diff_accepted", &json!({ "diff_id": id }))
            .is_err());
    }

    #[test]
    fn apply_settings_enforces_the_allowlist() {
        let mut b = bridge();
        let c = ctx("s1");
        let ok = b
            .dispatch(&c, "apply_settings", &json!({ "key": "editor.fontSize", "value": 14 }))
            .unwrap();
        assert_eq!(ok["resulting"], json!(14));
        assert!(b
            .dispatch(&c, "apply_settings", &json!({ "key": "provider.apiKey", "value": "x" }))
            .is_err(), "non-allowlisted setting refused");
    }

    #[test]
    fn secret_setting_value_is_redacted() {
        let change = redact_setting(SettingChange {
            key: "provider.apiKey".into(),
            previous: json!("old-secret"),
            resulting: json!("new-secret"),
        });
        assert_eq!(change.previous, json!("[redacted]"));
        assert_eq!(change.resulting, json!("[redacted]"));
    }

    #[test]
    fn unknown_tool_is_refused() {
        let mut b = bridge();
        assert!(b.dispatch(&ctx("s1"), "rm_rf", &json!({})).is_err());
    }

    #[test]
    fn file_settings_ui_applies_an_allowlisted_setting_atomically() {
        let dir = std::env::temp_dir().join(format!("jan-settings-ui-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{ "editor.fontSize": 12 }"#).unwrap();

        let mut b = DesktopBridge::new(FileSettingsUi::new(path.clone()));
        let c = RequestContext {
            window_id: "w".into(),
            workspace_root: dir.clone(),
            conversation_id: "c".into(),
            session_id: "s".into(),
        };

        // An allowlisted setting is written through, and the file reflects it.
        let out = b
            .dispatch(&c, "apply_settings", &json!({ "key": "editor.fontSize", "value": 16 }))
            .unwrap();
        assert_eq!(out["previous"], json!(12));
        assert_eq!(out["resulting"], json!(16));
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["editor.fontSize"], json!(16));

        // A non-allowlisted key is refused and the file is untouched.
        assert!(b
            .dispatch(&c, "apply_settings", &json!({ "key": "provider.apiKey", "value": "x" }))
            .is_err());

        // A UI-only tool reports there is no interactive surface here.
        let err = b
            .dispatch(&c, "open_file", &json!({ "path": "a.txt" }))
            .unwrap_err();
        assert!(err.contains("no interactive desktop surface"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
