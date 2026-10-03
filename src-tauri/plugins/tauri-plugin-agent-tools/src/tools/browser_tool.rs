//! The `browser` tool: classification for the gate, wording for the approval
//! prompt, and the bridge from a tool call to the run's browser session
//! (`crate::browser::session`).
//!
//! The tool is one name with an `action` so a small model keeps one entry in
//! its tool list. It is classified per call, like `git`:
//! - looking (`snapshot`, `screenshot`, `console`, `wait`, `scroll`, `close`)
//!   runs without asking, and needs a page the run already opened;
//! - acting (`click`, `type`, `press`, `select`, `back`, `reload`, `tab`) is
//!   gated like a write: asked in modes that ask, covered by a session grant;
//! - `upload` is gated like a write too, and its file must lie inside the run's
//!   working folders (anything else is refused, and a write escape at the gate);
//! - `open` and `evaluate` are asked about every time, whatever grants exist.
//!   `open` because the model picks which local address the browser reaches (a
//!   dev server, or any other service on this machine); `evaluate` because
//!   arbitrary script in the page can do what no single click can.

use serde_json::Value;

use super::{ImageContentPart, ToolContext};
use crate::browser::session::{self, Caller};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Looks at the page the run already opened.
    Read,
    /// Acts on the page.
    Act,
    /// Attaches a file from the run's folders to a page: gated like a write,
    /// and a path outside those folders is a write escape.
    Upload,
    /// Starts or redirects the browser: asked every time.
    Open,
    /// Runs script in the page: asked every time.
    Evaluate,
}

/// How a call is classified. An action nothing implements counts as acting, so
/// a misspelling is never a way around the gate (the handler refuses it).
pub fn class_of(args: &Value) -> Class {
    match args.get("action").and_then(Value::as_str).map(|a| a.trim().to_ascii_lowercase()).as_deref() {
        Some("snapshot" | "screenshot" | "console" | "wait" | "scroll" | "close") => Class::Read,
        Some("open") => Class::Open,
        Some("upload") => Class::Upload,
        Some("evaluate") => Class::Evaluate,
        _ => Class::Act,
    }
}

/// The registry key and lifecycle scope for a call: one session per run.
pub fn caller_of(ctx: &ToolContext<'_>) -> Caller {
    let scope = ctx.cancel.as_ref().map(|t| t.scope().clone());
    let pick = |a: Option<&str>, b: Option<&str>, c: Option<&str>| -> String {
        [a, b, c]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let run = pick(scope.as_ref().map(|s| s.run.as_str()), ctx.run_id, None);
    let session = pick(scope.as_ref().map(|s| s.session.as_str()), ctx.session_id, ctx.job_owner);
    let key = if !run.is_empty() {
        run.clone()
    } else if !session.is_empty() {
        session.clone()
    } else {
        "default".to_string()
    };
    Caller { key, session, run }
}

fn clip(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{t}…") } else { t }
}

/// One line for the approval prompt: what will happen, with what the target is.
pub fn display(args: &Value, key: &str) -> String {
    let action = args.get("action").and_then(Value::as_str).unwrap_or("?");
    let s = |k: &str| args.get(k).and_then(Value::as_str);
    let target = || {
        let r = s("ref").unwrap_or("?");
        match session::ref_label(key, r) {
            Some(label) => format!("{r} ({label})"),
            None => r.to_string(),
        }
    };
    match action {
        "open" => {
            let mut line = format!("browser open {}", clip(s("url").unwrap_or("?"), 200));
            if let Some(extra) = args.get("allow_origins").and_then(Value::as_array) {
                let list: Vec<&str> = extra.iter().filter_map(Value::as_str).collect();
                if !list.is_empty() {
                    line.push_str(&format!(" (also allowing {})", clip(&list.join(", "), 200)));
                }
            }
            line
        }
        "click" | "select" | "scroll" => format!("browser {action} {}", target()),
        // The typed text is not shown: it may be a password. Its length is.
        "type" => format!(
            "browser type into {} ({} characters{})",
            target(),
            s("text").map_or(0, |t| t.chars().count()),
            if args.get("submit").and_then(Value::as_bool) == Some(true) { ", then Enter" } else { "" }
        ),
        "press" => format!("browser press {}", clip(s("key").unwrap_or("?"), 40)),
        "evaluate" => format!("browser evaluate script in the page: {}", clip(s("expression").unwrap_or("?"), 300)),
        // The file name only: the full path is the model's, the question is "this file, here".
        "upload" => format!(
            "browser upload {} into {}",
            clip(std::path::Path::new(s("path").unwrap_or("?")).file_name().and_then(|n| n.to_str()).unwrap_or("?"), 80),
            target()
        ),
        "tab" => format!("browser tab {}{}", s("op").unwrap_or("list"), s("url").map(|u| format!(" {}", clip(u, 200))).unwrap_or_default()),
        other => format!("browser {other}"),
    }
}

/// The file an `upload` call may attach, or why not.
///
/// Only a regular file that really lies inside the run's working folder, its
/// scratch folder or a folder it was granted for writing: the same jail the
/// `write` tool works in. The path is resolved the way the file tools resolve
/// it, then canonicalised, so `..` and links cannot reach outside; the agent's
/// own `.jan` state and credential files are refused; and the size is capped.
pub fn resolve_upload(args: &Value, ctx: &ToolContext<'_>) -> Result<std::path::PathBuf, String> {
    let raw = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.trim().is_empty())
        .ok_or("ERROR: upload needs a `path` to a file inside your working folder.")?;
    let target = crate::tools::sandbox::resolve_path(ctx.project_root, ctx.scratch_root, raw);
    let canon = std::fs::canonicalize(&target).map_err(|_| format!("ERROR: no such file: {raw}"))?;
    let mut roots: Vec<std::path::PathBuf> = vec![ctx.project_root.to_path_buf()];
    roots.extend(ctx.scratch_root.map(|p| p.to_path_buf()));
    roots.extend(ctx.write_roots.iter().cloned());
    let inside = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| canon.starts_with(&r));
    if !inside {
        return Err(format!(
            "ERROR: {raw} is outside your working folder, so it was not uploaded. Copy the file into the workspace first, or ask the user for access."
        ));
    }
    let shown = canon.to_string_lossy();
    if crate::tools::sandbox::is_hidden_jan_path_in(ctx.project_root, ctx.write_roots, &shown) {
        return Err("ERROR: that path is the agent's own state directory, which is hidden and cannot be uploaded.".to_string());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| format!("ERROR: cannot read {raw}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("ERROR: {raw} is not a regular file."));
    }
    if meta.len() > session::MAX_UPLOAD_BYTES {
        return Err(format!("ERROR: {raw} is {} bytes; the limit is {}.", meta.len(), session::MAX_UPLOAD_BYTES));
    }
    // The browser is told a plain path: no Windows verbatim prefix.
    Ok(match shown.strip_prefix(r"\\?\") {
        Some(plain) if !plain.starts_with("UNC") => std::path::PathBuf::from(plain),
        _ => canon,
    })
}

/// Run the call against the run's session.
pub async fn run(args: &Value, ctx: &ToolContext<'_>) -> (String, Option<Vec<ImageContentPart>>) {
    let caller = caller_of(ctx);
    let is_upload = class_of(args) == Class::Upload;
    let upload = if is_upload {
        match resolve_upload(args, ctx) {
            Ok(p) => Some(p),
            Err(e) => return (e, None),
        }
    } else {
        None
    };
    let opts = session::Options { upload: upload.as_deref(), compact_image: ctx.compact_images };
    let reply = session::run_with(&caller, args, &opts).await;
    let images = reply.image.map(|bytes| {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let ext = if reply.image_mime == "image/jpeg" { "jpg" } else { "png" };
        vec![ImageContentPart {
            data_url: format!("data:{};base64,{b64}", reply.image_mime),
            name: format!("browser-screenshot.{ext}"),
        }]
    });
    (reply.text, images)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn looking_is_read_acting_is_act_and_open_and_evaluate_always_ask() {
        for a in ["snapshot", "screenshot", "console", "wait", "scroll", "close", "SNAPSHOT"] {
            assert_eq!(class_of(&json!({ "action": a })), Class::Read, "{a}");
        }
        for a in ["click", "type", "press", "select", "back", "reload", "tab"] {
            assert_eq!(class_of(&json!({ "action": a })), Class::Act, "{a}");
        }
        assert_eq!(class_of(&json!({ "action": "upload" })), Class::Upload);
        assert_eq!(class_of(&json!({ "action": "open" })), Class::Open);
        assert_eq!(class_of(&json!({ "action": "Evaluate" })), Class::Evaluate);
    }

    #[test]
    fn a_missing_or_unknown_action_is_never_classified_as_looking() {
        assert_eq!(class_of(&json!({})), Class::Act);
        assert_eq!(class_of(&json!({ "action": "snapshot2" })), Class::Act);
        assert_eq!(class_of(&json!({ "action": 3 })), Class::Act);
    }

    #[test]
    fn the_prompt_line_names_the_action_and_hides_typed_text() {
        let k = "no-session";
        assert_eq!(display(&json!({ "action": "open", "url": "http://localhost:5173/" }), k), "browser open http://localhost:5173/");
        assert!(display(&json!({ "action": "open", "url": "http://localhost:1/", "allow_origins": ["http://localhost:2"] }), k)
            .contains("also allowing http://localhost:2"));
        let t = display(&json!({ "action": "type", "ref": "e3", "text": "hunter2", "submit": true }), k);
        assert!(t.contains("7 characters, then Enter") && !t.contains("hunter2"), "{t}");
        assert_eq!(display(&json!({ "action": "click", "ref": "e9" }), k), "browser click e9");
        assert!(display(&json!({ "action": "evaluate", "expression": "document.title" }), k).ends_with("document.title"));
        assert_eq!(display(&json!({ "action": "reload" }), k), "browser reload");
    }

    #[test]
    fn the_key_is_the_run_then_the_session_then_a_default() {
        let root = std::path::Path::new(".");
        let store = std::path::Path::new(".");
        let enabled: Vec<String> = vec![];
        let ctx = ToolContext::new(root, store, &enabled);
        assert_eq!(caller_of(&ctx).key, "default");
        let ctx = ToolContext::new(root, store, &enabled).with_job_owner("thread-1");
        let c = caller_of(&ctx);
        assert_eq!((c.key.as_str(), c.session.as_str()), ("thread-1", "thread-1"));
        let token = crate::lifecycle::Token::new(crate::lifecycle::Scope::new("s", "r", "call-1"));
        let ctx = ToolContext::new(root, store, &enabled).with_job_owner("thread-1").with_cancel(token);
        let c = caller_of(&ctx);
        assert_eq!((c.key.as_str(), c.session.as_str(), c.run.as_str()), ("r", "s", "r"));
    }
}
