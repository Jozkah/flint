//! The `open_path` tool: open a file or folder from the project on the user's
//! screen, or show it selected in Explorer.
//!
//! Opening a file with its default program is how a program starts, so this is
//! narrow. The path must exist and lie inside a folder the run can read or write
//! (the project, its worktree, the session workspace), never the agent's own
//! `.jan` folder. A folder opens in Explorer, and any file can be shown selected
//! there; but a file is only *opened* with its default program when it is a
//! document or media type: anything a person double-clicks to run (programs,
//! scripts, installers, shortcuts, registry files) is refused. Every call is
//! asked about every time, naming the path.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::tools::git_tool::{canon, in_jan_dir, inside, Roots};

const TIMEOUT_SECS: u64 = 15;

/// File types that run something when opened. Compared in lower case.
pub const RUNNABLE: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "ps1xml", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp",
    "mst", "scr", "lnk", "url", "hta", "reg", "dll", "jar", "cpl", "msc", "application", "gadget", "appref-ms", "inf",
    "sct", "pif", "appx", "appxbundle", "msix", "msixbundle", "sh", "py", "pyw", "rb", "pl", "php",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub path: String,
    pub reveal: bool,
}

pub fn plan(args: &Value) -> Result<Plan, String> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("ERROR: open_path needs a 'path'.")?;
    if path.len() > 1000 || path.chars().any(|c| c.is_control()) || path.contains("://") {
        return Err("ERROR: open_path takes a path on this computer, not an address.".into());
    }
    let reveal = match args.get("reveal") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("ERROR: open_path 'reveal' must be true or false.".into()),
    };
    Ok(Plan { path: path.to_string(), reveal })
}

/// What the user is told they are approving.
pub fn summary(plan: &Plan) -> String {
    if plan.reveal {
        format!("Show {} in Explorer", plan.path)
    } else {
        format!("Open {} with its default app", plan.path)
    }
}

fn runnable(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => RUNNABLE.contains(&ext.to_ascii_lowercase().as_str()),
        // A file with no type asks Windows which program to use, which can be
        // anything; it can still be shown in Explorer.
        None => true,
    }
}

/// The checked path: it exists, lies in a folder the run can use, and is a
/// kind of thing that may be opened this way.
pub fn resolve(plan: &Plan, roots: &Roots) -> Result<PathBuf, String> {
    let base = roots.default_base().cloned();
    let given = Path::new(&plan.path);
    let wanted = match (given.is_absolute(), base) {
        (true, _) => given.to_path_buf(),
        (false, Some(base)) => base.join(given),
        (false, None) => return Err("no project folder is available for this run".to_string()),
    };
    let path = canon(&wanted).ok_or_else(|| format!("`{}` does not exist", wanted.display()))?;
    if in_jan_dir(&path) {
        return Err("the agent's own `.jan` folder is not opened this way".into());
    }
    let mut allowed = roots.write();
    allowed.extend(roots.read.iter().cloned());
    if !inside(&path, &allowed) {
        return Err(format!(
            "`{}` is outside the project folder, worktree and session workspace; only those can be opened",
            path.display()
        ));
    }
    if path.is_file() && !plan.reveal && runnable(&path) {
        return Err(format!(
            "`{}` is a program, script or file of a type with no safe way to open it from here. Use reveal to show it in Explorer, and the user can open it.",
            path.display()
        ));
    }
    Ok(path)
}

#[cfg(windows)]
pub async fn run(args: &Value, ctx: &crate::tools::ToolContext<'_>) -> String {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    let plan = match plan(args) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let roots = Roots::from_ctx(ctx);
    let path = match resolve(&plan, &roots) {
        Ok(p) => p,
        Err(e) => return format!("ERROR: open_path: {e}"),
    };
    // `canon` can give a `\\?\` path; Explorer and Start-Process want the plain one.
    let shown = crate::tools::gate::strip_verbatim(&path);
    let result = if plan.reveal || path.is_dir() {
        let mut cmd = std::process::Command::new("explorer.exe");
        if plan.reveal && path.is_file() {
            cmd.raw_arg(format!("/select,\"{}\"", shown.display()));
        } else {
            cmd.raw_arg(format!("\"{}\"", shown.display()));
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x0800_0000);
        // Explorer reports failure through its exit code even when it worked, so
        // only a failure to start is an error.
        cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
    } else {
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:OP_PATH"])
            .env("OP_PATH", &shown)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .creation_flags(0x0800_0000);
        match tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), cmd.output()).await {
            Err(_) => Err(format!("it did not start within {TIMEOUT_SECS} seconds")),
            Ok(Err(e)) => Err(e.to_string()),
            Ok(Ok(out)) if out.status.success() => Ok(()),
            Ok(Ok(out)) => Err(String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("").trim().to_string()),
        }
    };
    match result {
        Ok(()) if plan.reveal => format!("Showing {} in Explorer.", shown.display()),
        Ok(()) => format!("Opened {}.", shown.display()),
        Err(e) => format!("ERROR: open_path: {e}"),
    }
}

#[cfg(not(windows))]
pub async fn run(args: &Value, ctx: &crate::tools::ToolContext<'_>) -> String {
    let _ = (args, ctx, Duration::from_secs(TIMEOUT_SECS));
    "ERROR: open_path works on Windows only.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roots_in(dir: &Path) -> Roots {
        Roots { granted: vec![dir.to_path_buf()], workspace: vec![], read: vec![] }
    }

    #[test]
    fn a_path_is_needed_and_an_address_is_refused() {
        assert_eq!(plan(&json!({ "path": "docs/a.pdf" })), Ok(Plan { path: "docs/a.pdf".into(), reveal: false }));
        assert!(plan(&json!({ "path": "docs/a.pdf", "reveal": true })).unwrap().reveal);
        for bad in [json!({}), json!({ "path": "" }), json!({ "path": "https://example.com" }), json!({ "path": "a\nb" }), json!({ "path": "a", "reveal": "yes" })] {
            assert!(plan(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_summary_names_the_path_and_the_way() {
        assert_eq!(summary(&Plan { path: "a.pdf".into(), reveal: false }), "Open a.pdf with its default app");
        assert_eq!(summary(&Plan { path: "a.pdf".into(), reveal: true }), "Show a.pdf in Explorer");
    }

    #[test]
    fn only_documents_open_and_anything_can_be_shown() {
        let dir = std::env::temp_dir().join(format!("flint-open-path-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for name in ["report.pdf", "tool.exe", "run.BAT", "setup.msi", "noext", "page.html", "x.ps1", "link.lnk"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let roots = roots_in(&dir);
        let open = |p: &str, reveal: bool| resolve(&Plan { path: p.into(), reveal }, &roots);
        assert!(open("report.pdf", false).is_ok());
        assert!(open("page.html", false).is_ok());
        assert!(open("sub", false).is_ok());
        for runnable in ["tool.exe", "run.BAT", "setup.msi", "noext", "x.ps1", "link.lnk"] {
            assert!(open(runnable, false).is_err(), "{runnable}");
            assert!(open(runnable, true).is_ok(), "{runnable} revealed");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_must_exist_and_lie_in_the_run_folders() {
        let dir = std::env::temp_dir().join(format!("flint-open-path-in-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("flint-open-path-out-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();
        let roots = roots_in(&dir);
        let open = |p: &str| resolve(&Plan { path: p.into(), reveal: false }, &roots);
        assert!(open("missing.txt").unwrap_err().contains("does not exist"));
        assert!(open(&outside.join("secret.txt").to_string_lossy()).unwrap_err().contains("outside"));
        assert!(open("../").is_err());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
