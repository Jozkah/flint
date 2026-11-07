//! `jan-desktop`: an in-process MCP server that exposes a small, tightly-scoped
//! set of Jan's desktop UI capabilities to the agent as ordinary MCP tools,
//! instead of bespoke agent-to-UI calls.
//!
//! This module holds the part that must be correct regardless of the transport:
//! the four tools' schemas, their typed arguments, and the authorization layer —
//! path containment, bounded terminal reads, and a session-scoped diff-id registry
//! that rejects stale or cross-session ids. Every
//! request is bound to the window, workspace, conversation, and session it came
//! from, so one conversation can never open another's files or accept another's
//! diff.
//!
//! The actual UI work (opening an editor, reading a terminal, showing a diff)
//! is behind the [`DesktopUi`] trait, so the domain services
//! stay the single implementation and this logic is testable with a fake. The
//! rmcp `ServerHandler` that speaks the wire protocol is a thin adapter over
//! [`DesktopBridge::dispatch`]; it does no validation of its own.

use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

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
}

/// Most diff ids kept at once; the oldest is dropped past this.
const MAX_ISSUED_DIFFS: usize = 256;

/// Diff ids handed out, each bound to the session that created it. Shared by
/// every bridge built over it, so an id issued by one call is still known to
/// the next, and bounded so a session cannot grow it without limit.
#[derive(Default)]
pub struct DiffRegistry {
    owners: HashMap<String, String>, // diff_id -> session_id
    order: VecDeque<String>,
}

impl DiffRegistry {
    fn insert(&mut self, diff_id: String, session_id: String) {
        if self.owners.insert(diff_id.clone(), session_id).is_none() {
            self.order.push_back(diff_id);
        }
        while self.order.len() > MAX_ISSUED_DIFFS {
            if let Some(oldest) = self.order.pop_front() {
                self.owners.remove(&oldest);
            }
        }
    }

    fn owner(&self, diff_id: &str) -> Option<&String> {
        self.owners.get(diff_id)
    }

    fn remove(&mut self, diff_id: &str) {
        if self.owners.remove(diff_id).is_some() {
            self.order.retain(|id| id != diff_id);
        }
    }

    /// Forget every id a session was issued (when the session ends).
    pub fn forget_session(&mut self, session_id: &str) {
        self.owners.retain(|_, owner| owner != session_id);
        let owners = &self.owners;
        self.order.retain(|id| owners.contains_key(id));
    }
}

/// The process-wide registry the desktop command routes through, so a diff
/// issued by one `jan-desktop` call can be accepted by a later one.
pub fn shared_diff_registry() -> Arc<Mutex<DiffRegistry>> {
    static SHARED: OnceLock<Arc<Mutex<DiffRegistry>>> = OnceLock::new();
    SHARED.get_or_init(Default::default).clone()
}

/// The diff-id registry and the bridge's dispatch entry point.
pub struct DesktopBridge<U: DesktopUi> {
    ui: U,
    /// Diff ids the bridge has handed out, each bound to the session that
    /// created it. A `diff_accepted` for an id not in here — unknown, stale, or
    /// from another session — is refused.
    issued_diffs: Arc<Mutex<DiffRegistry>>,
    /// Upper bound on terminal lines returned, whatever the request asks for.
    max_terminal_lines: usize,
}

impl<U: DesktopUi> DesktopBridge<U> {
    pub fn new(ui: U) -> Self {
        Self::with_registry(ui, Arc::default())
    }

    /// A bridge whose diff ids live in `registry`, outliving this value.
    pub fn with_registry(ui: U, registry: Arc<Mutex<DiffRegistry>>) -> Self {
        Self {
            ui,
            issued_diffs: registry,
            max_terminal_lines: 1_000,
        }
    }

    fn registry(&self) -> std::sync::MutexGuard<'_, DiffRegistry> {
        self.issued_diffs.lock().unwrap_or_else(|e| e.into_inner())
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
        self.registry().insert(diff_id.clone(), ctx.session_id.clone());
        Ok(json!({ "diff_id": diff_id }))
    }

    fn diff_accepted(&mut self, ctx: &RequestContext, args: &Value) -> Result<Value, String> {
        let diff_id = arg_str(args, "diff_id")?;
        match self.registry().owner(diff_id) {
            Some(owner) if owner == &ctx.session_id => {}
            Some(_) => return Err("diff id belongs to another session".to_string()),
            None => return Err("unknown or stale diff id".to_string()),
        }
        self.ui.diff_accepted(diff_id)?;
        // One acceptance per id: consume it so a replay is refused.
        self.registry().remove(diff_id);
        Ok(json!({ "accepted": diff_id }))
    }

}

/// Resolve a workspace-relative path and refuse anything that escapes the
/// workspace: by component first, then through the filesystem so a link
/// inside the workspace cannot lead out of it. A path that does not exist yet
/// still validates (its longest existing prefix is what is resolved).
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
            Component::Normal(part) => {
                // A colon names an NTFS alternate data stream (`a.txt:s`);
                // a device name (`CON`, `NUL`) or a trailing dot or space is
                // not the file it looks like on Windows.
                let name = part.to_string_lossy();
                if name.contains(':') || is_reserved_name(&name) {
                    return Err(format!("{rel:?} names a stream or device, not a workspace file"));
                }
                out.push(part)
            }
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
    // A symlink or junction inside the workspace can lead out of it. Resolve
    // the longest prefix that exists (the file itself may not yet) and require
    // it to stay under the real workspace.
    if let Ok(real_workspace) = std::fs::canonicalize(workspace) {
        let mut probe = out.as_path();
        let real = loop {
            match std::fs::canonicalize(probe) {
                Ok(real) => break Some(real),
                Err(_) => match probe.parent() {
                    Some(parent) if parent != workspace => probe = parent,
                    _ => break None,
                },
            }
        };
        if let Some(real) = real {
            if !real.starts_with(&real_workspace) {
                return Err(format!("{rel:?} leads out of the workspace through a link"));
            }
        }
    }
    Ok(out)
}

/// A Windows device name (with or without an extension) or a name Windows
/// would silently strip a trailing dot or space from.
fn is_reserved_name(name: &str) -> bool {
    if name.ends_with('.') || name.ends_with(' ') {
        return true;
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
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

/// A [`DesktopUi`] for contexts with no interactive desktop surface attached:
/// open file, terminal and diff report that none is, rather than pretend. The
/// desktop's window layer supplies its own [`DesktopUi`] for those tools.
pub struct FileSettingsUi;

impl FileSettingsUi {
    pub fn app_store() -> Self {
        Self
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

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

    /// CAGA-027: stream names, device names and trailing dots are refused.
    #[test]
    fn workspace_paths_refuse_streams_and_device_names() {
        let ws = ctx("s").workspace_root;
        for bad in ["a.txt:stream", "dir/CON", "nul.txt", "COM1", "a."] {
            assert!(resolve_in_workspace(&ws, bad).is_err(), "{bad}");
        }
        assert!(resolve_in_workspace(&ws, "src/console.rs").is_ok());
        assert!(resolve_in_workspace(&ws, "COM10").is_ok());
    }

    /// CAGA-027: a link inside the workspace that leads out is refused.
    #[test]
    fn workspace_paths_refuse_links_that_leave() {
        let base = std::env::temp_dir().join(format!("flint-bridge-link-{}", std::process::id()));
        let ws = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, ws.join("link")).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, ws.join("link")).is_ok();
        if linked {
            assert!(resolve_in_workspace(&ws, "link/secret.txt").is_err());
            assert!(resolve_in_workspace(&ws, "link/new.txt").is_err());
        }
        std::fs::write(ws.join("ok.txt"), "x").unwrap();
        assert!(resolve_in_workspace(&ws, "ok.txt").is_ok());
        assert!(resolve_in_workspace(&ws, "not/yet/there.txt").is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn advertises_four_tools() {
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
                "diff_accepted"
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
    fn diff_id_issued_by_show_diff_is_accepted_by_a_later_bridge_of_the_same_session() {
        let registry = Arc::new(Mutex::new(DiffRegistry::default()));
        let mut first = DesktopBridge::with_registry(FakeUi::default(), registry.clone());
        let c = ctx("s1");
        let id = first.dispatch(&c, "show_diff", &json!({ "path": "a.txt", "diff": "@@" })).unwrap()["diff_id"]
            .as_str()
            .unwrap()
            .to_string();
        drop(first);
        let mut second = DesktopBridge::with_registry(FakeUi::default(), registry.clone());
        assert!(second.dispatch(&ctx("s2"), "diff_accepted", &json!({ "diff_id": id })).is_err());
        second.dispatch(&c, "diff_accepted", &json!({ "diff_id": id })).expect("same session accepts");
        // An id minted by an unshared bridge is unknown here.
        assert!(bridge().dispatch(&c, "diff_accepted", &json!({ "diff_id": id })).is_err());
    }

    #[test]
    fn registry_is_bounded_and_forgets_ended_sessions() {
        let mut r = DiffRegistry::default();
        for i in 0..(MAX_ISSUED_DIFFS + 10) {
            r.insert(format!("d{i}"), "s1".into());
        }
        assert_eq!(r.owners.len(), MAX_ISSUED_DIFFS);
        assert!(r.owner("d0").is_none() && r.owner(&format!("d{}", MAX_ISSUED_DIFFS + 9)).is_some());
        r.insert("other".into(), "s2".into());
        r.forget_session("s1");
        assert_eq!(r.owners.len(), 1);
        assert_eq!(r.order.len(), 1);
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
    fn unknown_tool_is_refused() {
        let mut b = bridge();
        assert!(b.dispatch(&ctx("s1"), "rm_rf", &json!({})).is_err());
        let err = b
            .dispatch(&ctx("s1"), "apply_settings", &json!({ "key": "editor.fontSize", "value": 14 }))
            .unwrap_err();
        assert!(err.contains("unknown jan-desktop tool"), "{err}");
    }
}
