//! The `host_package` tool: look at, and change, the programs installed on this
//! computer through winget.
//!
//! The `bash` sandbox cannot run winget, so "is X installed, which version, what
//! has an update" had no answer. Looking runs without asking (`list`, `search`,
//! `show`, `outdated`). Changing does not: `install`, `upgrade` and `uninstall`
//! name one package by its exact id and are asked about every time, because
//! installing a program is running someone else's code as the user. There is no
//! "upgrade everything": each package is its own question.
//!
//! The call is an argv array. The id is checked for the characters a winget id
//! uses, so it can never be read as an option. Installs are silent and
//! non-interactive; one that needs an administrator fails with Windows' message
//! rather than waiting for a prompt nobody can answer.

use std::time::Duration;

use serde_json::Value;

const READ_TIMEOUT_SECS: u64 = 90;
const CHANGE_TIMEOUT_SECS: u64 = 900;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    List,
    Search,
    Show,
    Outdated,
    Install,
    Upgrade,
    Uninstall,
}

impl Verb {
    pub fn changes(self) -> bool {
        matches!(self, Verb::Install | Verb::Upgrade | Verb::Uninstall)
    }

    fn word(self) -> &'static str {
        match self {
            Verb::List => "list",
            Verb::Search => "search",
            Verb::Show => "show",
            Verb::Outdated => "outdated",
            Verb::Install => "install",
            Verb::Upgrade => "upgrade",
            Verb::Uninstall => "uninstall",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub verb: Verb,
    pub target: Option<String>,
}

/// An id or a search word: letters, digits and the few marks a package id has.
fn valid_target(text: &str, allow_space: bool) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && !text.starts_with('-')
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-') || (allow_space && c == ' '))
}

pub fn plan(args: &Value) -> Result<Plan, String> {
    let verb = match args.get("action").and_then(Value::as_str) {
        Some("list") => Verb::List,
        Some("search") => Verb::Search,
        Some("show") => Verb::Show,
        Some("outdated") => Verb::Outdated,
        Some("install") => Verb::Install,
        Some("upgrade") => Verb::Upgrade,
        Some("uninstall") => Verb::Uninstall,
        _ => return Err("ERROR: host_package needs an 'action': list, search, show, outdated, install, upgrade or uninstall.".into()),
    };
    let target = args.get("id").and_then(Value::as_str).or_else(|| args.get("query").and_then(Value::as_str)).map(str::trim);
    let needs_exact = matches!(verb, Verb::Show | Verb::Install | Verb::Upgrade | Verb::Uninstall);
    match (verb, target) {
        (Verb::Outdated, _) => Ok(Plan { verb, target: None }),
        (Verb::List, None) | (Verb::List, Some("")) => Ok(Plan { verb, target: None }),
        (Verb::Search, None) | (Verb::Search, Some("")) => Err("ERROR: host_package search needs a 'query'.".into()),
        (_, Some(t)) if valid_target(t, !needs_exact) => Ok(Plan { verb, target: Some(t.to_string()) }),
        (_, Some(_)) if needs_exact => Err("ERROR: 'id' must be a winget package id such as Git.Git (letters, digits, dots, dashes, underscores; no spaces). Find it with search.".into()),
        (_, Some(_)) => Err("ERROR: 'query' may hold letters, digits, spaces, dots, dashes and underscores.".into()),
        (_, None) => Err(format!("ERROR: host_package {} needs an 'id' (the exact winget package id; find it with search).", verb.word())),
    }
}

/// The winget argument list.
pub fn argv(plan: &Plan) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let t = plan.target.clone();
    match plan.verb {
        Verb::List => {
            args.push("list".into());
            if let Some(t) = t {
                args.push(t);
            }
        }
        Verb::Search => {
            args.push("search".into());
            args.extend(t);
        }
        Verb::Show => args.extend(["show".into(), "--id".into(), t.unwrap_or_default(), "--exact".into()]),
        Verb::Outdated => args.push("upgrade".into()),
        Verb::Install => args.extend(["install".into(), "--id".into(), t.unwrap_or_default(), "--exact".into(), "--silent".into(), "--accept-package-agreements".into()]),
        Verb::Upgrade => args.extend(["upgrade".into(), "--id".into(), t.unwrap_or_default(), "--exact".into(), "--silent".into(), "--accept-package-agreements".into()]),
        Verb::Uninstall => args.extend(["uninstall".into(), "--id".into(), t.unwrap_or_default(), "--exact".into(), "--silent".into()]),
    }
    args.extend(["--accept-source-agreements".into(), "--disable-interactivity".into()]);
    args
}

/// What the user is shown for a call that changes something.
pub fn summary(plan: &Plan) -> String {
    let id = plan.target.as_deref().unwrap_or("");
    match plan.verb {
        Verb::Install => format!("Install {id} with winget"),
        Verb::Upgrade => format!("Upgrade {id} with winget"),
        Verb::Uninstall => format!("Uninstall {id} with winget"),
        other => format!("winget {} {id}", other.word()).trim().to_string(),
    }
}

/// winget draws a spinner and progress bars with carriage returns and block
/// characters. Keep the lines that carry information.
fn clean(text: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for raw in text.split('\n') {
        // A line redrawn with `\r` keeps only its last drawing.
        let line = raw.rsplit('\r').next().unwrap_or("").trim_end();
        let spinner = line.trim().len() <= 1 && line.trim().chars().all(|c| matches!(c, '-' | '\\' | '|' | '/' | ' '));
        let bar = line.contains('\u{2588}') || line.contains('\u{2592}');
        if line.trim().is_empty() || spinner || bar {
            continue;
        }
        lines.push(line);
    }
    lines.join("\n")
}

#[cfg(windows)]
pub async fn host_package(args: &Value) -> String {
    let plan = match plan(args) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let mut cmd = tokio::process::Command::new("winget");
    cmd.args(argv(&plan));
    let timeout = Duration::from_secs(if plan.verb.changes() { CHANGE_TIMEOUT_SECS } else { READ_TIMEOUT_SECS });
    match crate::tools::host_read::capture(cmd, timeout).await {
        Err(crate::tools::host_read::CaptureError::Timeout) => format!("ERROR: winget did not finish in {} seconds and was stopped.", timeout.as_secs()),
        Err(crate::tools::host_read::CaptureError::NotFound) => "ERROR: winget is not installed on this computer (it ships with App Installer from the Microsoft Store).".to_string(),
        Err(crate::tools::host_read::CaptureError::Io(e)) => format!("ERROR: could not run winget: {e}"),
        Ok(out) => {
            let log = crate::secrets::redact_secrets(&crate::tools::host_build::trimmed(&clean(&format!("{}\n{}", out.stdout, out.stderr))));
            if out.success {
                if log.is_empty() { format!("{} finished.", summary(&plan)) } else { log }
            } else {
                format!("ERROR: {} failed (exit code {}).\n{log}", summary(&plan), out.code.map_or("none".into(), |c| c.to_string()))
            }
        }
    }
}

#[cfg(not(windows))]
pub async fn host_package(args: &Value) -> String {
    let _ = (args, Duration::from_secs(READ_TIMEOUT_SECS), clean(""));
    "ERROR: host_package works on Windows only (it uses winget).".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(v: Value) -> Result<Plan, String> {
        plan(&v)
    }

    #[test]
    fn looking_is_free_and_changing_names_one_exact_package() {
        for ok in [json!({ "action": "list" }), json!({ "action": "list", "query": "git" }), json!({ "action": "outdated" }), json!({ "action": "search", "query": "visual studio code" }), json!({ "action": "show", "id": "Git.Git" })] {
            let plan = p(ok.clone()).unwrap_or_else(|e| panic!("{ok}: {e}"));
            assert!(!plan.verb.changes(), "{ok}");
        }
        for ok in [json!({ "action": "install", "id": "Git.Git" }), json!({ "action": "upgrade", "id": "7zip.7zip" }), json!({ "action": "uninstall", "id": "Foo.Bar-Baz_1+" })] {
            assert!(p(ok.clone()).unwrap().verb.changes(), "{ok}");
        }
    }

    #[test]
    fn there_is_no_upgrade_everything_and_ids_cannot_be_options() {
        for bad in [json!({ "action": "upgrade" }), json!({ "action": "install" }), json!({ "action": "uninstall", "id": "" }), json!({ "action": "install", "id": "--all" }), json!({ "action": "install", "id": "-h" }), json!({ "action": "install", "id": "a b" }), json!({ "action": "install", "id": "x;y" }), json!({ "action": "show", "id": "a*" }), json!({ "action": "search" }), json!({ "action": "format" }), json!({})] {
            assert!(p(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_argument_list_is_exact_and_non_interactive() {
        let install = p(json!({ "action": "install", "id": "Git.Git" })).unwrap();
        assert_eq!(argv(&install), ["install", "--id", "Git.Git", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"]);
        assert_eq!(argv(&p(json!({ "action": "outdated" })).unwrap()), ["upgrade", "--accept-source-agreements", "--disable-interactivity"]);
        assert_eq!(argv(&p(json!({ "action": "list", "query": "git" })).unwrap())[..2], ["list", "git"]);
    }

    #[test]
    fn the_summary_names_the_package() {
        assert_eq!(summary(&p(json!({ "action": "uninstall", "id": "Git.Git" })).unwrap()), "Uninstall Git.Git with winget");
    }

    #[test]
    fn spinners_and_progress_bars_are_dropped() {
        let raw = "   - \r   \\ \r   | \r\u{2588}\u{2588}\u{2588}\u{2592}\u{2592}  30%\nName  Id\n----\nGit   Git.Git\n";
        assert_eq!(clean(raw), "Name  Id\n----\nGit   Git.Git");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn lists_real_installed_programs() {
        // Skipped quietly where winget is not installed.
        if std::process::Command::new("winget").arg("--version").output().is_err() {
            return;
        }
        let out = host_package(&json!({ "action": "list", "query": "winget" })).await;
        assert!(!out.starts_with("ERROR:"), "{out}");
        assert!(!out.contains('\u{2588}'), "progress bars are removed: {out}");
    }
}
