//! Attribution for the commits and pull requests Flint's agent makes.
//!
//! Other coding agents sign their work: a `Co-Authored-By` trailer on each
//! commit and a "Generated with" line at the end of each pull request body.
//! Flint does the same, deterministically, by rewriting the `git` tool's
//! arguments before the call is put to the user, so the approval prompt shows
//! exactly the message or body that will be committed or posted. The model is
//! told not to write these lines itself (see the tool description in
//! `schema.rs`).
//!
//! Both are switched by the user in `<data folder>/attribution.json`, which the
//! desktop and the CLI read alike. Both default to on.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The address in the co-author trailer.
///
/// This must be the GitHub noreply address of the Flint GitHub account
/// (`<id>+<login>@users.noreply.github.com`) so GitHub shows the Flint avatar
/// next to the commit: the `flint-desktop` account (id 334201045). The only
/// copy: the renderer asks the backend to
/// rewrite calls (`attribute_git_call`) rather than building trailers itself.
pub const FLINT_COAUTHOR_EMAIL: &str = "334201045+flint-desktop@users.noreply.github.com";

/// The line appended to the end of a pull request body.
pub const PR_FOOTER: &str = "\u{1F916} Generated with [Flint](https://github.com/Jozkah/flint)";

/// Largest `-F` / `--body-file` file read to rewrite it inline.
const MAX_FILE: u64 = 1024 * 1024;

/// The user's choices. Both on unless switched off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Add Flint as co-author on commits.
    pub commits: bool,
    /// Add "Generated with Flint" to pull requests.
    pub pull_requests: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { commits: true, pull_requests: true }
    }
}

pub fn settings_path(data_folder: &Path) -> PathBuf {
    data_folder.join("attribution.json")
}

/// The user's settings. A missing or unreadable file is the default (on): the
/// file only ever turns attribution off.
pub fn load(data_folder: Option<&Path>) -> Settings {
    data_folder
        .and_then(|d| std::fs::read_to_string(settings_path(d)).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(data_folder: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(data_folder)?;
    let path = settings_path(data_folder);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(settings).unwrap_or_default())?;
    std::fs::rename(tmp, path)
}

/// The model named in the trailer: the bare id, without a provider prefix.
fn model_label(model_id: &str) -> &str {
    model_id.trim().rsplit('/').next().unwrap_or("").trim()
}

/// `Co-Authored-By: Flint (<model>) <email>`.
pub fn trailer(model_id: &str) -> String {
    match model_label(model_id) {
        "" => format!("Co-Authored-By: Flint <{FLINT_COAUTHOR_EMAIL}>"),
        m => format!("Co-Authored-By: Flint ({m}) <{FLINT_COAUTHOR_EMAIL}>"),
    }
}

/// A `Token: value` line as `git interpret-trailers` recognises one.
fn is_trailer_line(line: &str) -> bool {
    let Some((key, _)) = line.split_once(':') else { return false };
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn has_line(text: &str, line: &str) -> bool {
    text.lines().any(|l| l.trim().eq_ignore_ascii_case(line.trim()))
}

/// The message with `trailer` at the end of its trailer block: appended to the
/// last paragraph when that paragraph already is a trailer block, otherwise in
/// a new paragraph after one blank line. Unchanged when the trailer is there.
pub fn add_trailer(message: &str, trailer: &str) -> String {
    if has_line(message, trailer) {
        return message.to_string();
    }
    let body = message.trim_end();
    if body.is_empty() {
        return trailer.to_string();
    }
    let normalized = body.replace("\r\n", "\n");
    let last = normalized.rsplit("\n\n").next().unwrap_or("");
    let mut lines = last.lines().filter(|l| !l.trim().is_empty());
    let first_is_trailer = lines.next().is_some_and(is_trailer_line);
    // Continuation lines (leading whitespace) belong to the trailer above.
    let block = normalized.contains("\n\n")
        && first_is_trailer
        && last
            .lines()
            .filter(|l| !l.trim().is_empty())
            .all(|l| is_trailer_line(l) || l.starts_with([' ', '\t']));
    if block {
        format!("{body}\n{trailer}")
    } else {
        format!("{body}\n\n{trailer}")
    }
}

/// The body with [`PR_FOOTER`] at its end, once.
pub fn add_footer(body: &str) -> String {
    if body.contains(PR_FOOTER) {
        return body.to_string();
    }
    let body = body.trim_end();
    if body.is_empty() {
        PR_FOOTER.to_string()
    } else {
        format!("{body}\n\n{PR_FOOTER}")
    }
}

fn read_file(base: &Path, raw: &str) -> Option<String> {
    let path = Path::new(raw);
    // stdin, or a relative path with nothing to resolve it against.
    if raw == "-" || (!path.is_absolute() && !base.is_absolute()) {
        return None;
    }
    let path = if path.is_absolute() { path.to_path_buf() } else { base.join(path) };
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Where a message or body value sits in argv.
enum Slot {
    /// `-m VALUE`: the value is its own entry.
    Next(usize),
    /// `--message=VALUE` or `-mVALUE`: `prefix` then the value in one entry.
    Joined(usize, String),
}

impl Slot {
    fn get<'a>(&self, args: &'a [String]) -> &'a str {
        match self {
            Slot::Next(i) => &args[*i],
            Slot::Joined(i, p) => &args[*i][p.len()..],
        }
    }
    fn set(&self, args: &mut [String], value: String) {
        match self {
            Slot::Next(i) => args[*i] = value,
            Slot::Joined(i, p) => args[*i] = format!("{p}{value}"),
        }
    }
    /// The option entry and its value entry, for replacing `-F file` whole.
    fn span(&self) -> std::ops::Range<usize> {
        match self {
            Slot::Next(i) => i - 1..i + 1,
            Slot::Joined(i, _) => *i..i + 1,
        }
    }
}

/// Add the trailer to a `git commit` argv (`args[0] == "commit"`).
fn attribute_commit(args: &mut Vec<String>, trailer: &str, base: &Path) {
    let mut messages: Vec<Slot> = Vec::new();
    let mut file: Option<Slot> = None;
    let mut amend = false;
    let mut reuse = false;
    let mut fixup = false;
    let mut end = args.len();
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "--" => {
                end = i;
                break;
            }
            "-m" | "--message" => {
                if i + 1 < args.len() {
                    messages.push(Slot::Next(i + 1));
                }
                i += 2;
                continue;
            }
            "-F" | "--file" => {
                if i + 1 < args.len() {
                    file = Some(Slot::Next(i + 1));
                }
                i += 2;
                continue;
            }
            "-c" | "-C" | "--reuse-message" | "--reedit-message" => {
                reuse = true;
                i += 2;
                continue;
            }
            "--fixup" | "--squash" => {
                fixup = true;
                i += 2;
                continue;
            }
            "-t" | "--template" | "--author" | "--date" | "--cleanup" | "--trailer" => {
                i += 2;
                continue;
            }
            "--amend" => amend = true,
            _ if a.starts_with("--message=") => messages.push(Slot::Joined(i, "--message=".into())),
            _ if a.starts_with("--file=") => file = Some(Slot::Joined(i, "--file=".into())),
            _ if a.starts_with("--reuse-message=") || a.starts_with("--reedit-message=") => reuse = true,
            _ if a.starts_with("--fixup=") || a.starts_with("--squash=") => fixup = true,
            _ if a.starts_with('-') && !a.starts_with("--") && a.len() > 1 => {
                // A cluster of short flags: the first value-taking letter
                // takes the rest of the entry, or the next entry.
                let cluster = &a[1..];
                if let Some((pos, c)) = cluster.char_indices().find(|(_, c)| "mFcCt".contains(*c)) {
                    let prefix = format!("-{}", &cluster[..=pos]);
                    let attached = pos + c.len_utf8() < cluster.len();
                    let slot = if attached {
                        Some(Slot::Joined(i, prefix))
                    } else if i + 1 < args.len() {
                        Some(Slot::Next(i + 1))
                    } else {
                        None
                    };
                    match (c, slot) {
                        ('m', Some(s)) => messages.push(s),
                        ('F', Some(s)) => file = Some(s),
                        ('c' | 'C', _) => reuse = true,
                        _ => {}
                    }
                    i += if attached { 1 } else { 2 };
                    continue;
                }
            }
            _ => {}
        }
        i += 1;
    }
    if fixup {
        return;
    }
    if messages.iter().any(|s| has_line(s.get(args), trailer)) {
        return;
    }
    if let Some(slot) = file {
        // The message as it will be committed, inline, so the prompt shows it.
        match read_file(base, slot.get(args)) {
            Some(text) => {
                let span = slot.span();
                args.splice(span, ["-m".to_string(), add_trailer(&text, trailer)]);
            }
            // Not readable from here (no folder to resolve it against, or
            // stdin): git reads the file and adds the trailer itself.
            None => {
                args.splice(end..end, ["--trailer".to_string(), trailer.to_string()]);
            }
        }
        return;
    }
    if let Some(last) = messages.last() {
        // Each `-m` is its own paragraph: a last `-m` of trailers alone
        // extends that block rather than starting another after it.
        let value = if messages.len() > 1 {
            add_trailer(&format!("_\n\n{}", last.get(args)), trailer)[3..].to_string()
        } else {
            add_trailer(last.get(args), trailer)
        };
        last.set(args, value);
        return;
    }
    if amend || reuse {
        // The message comes from an existing commit; git adds the trailer
        // (and does not repeat one that is already last).
        args.splice(end..end, ["--trailer".to_string(), trailer.to_string()]);
    }
}

/// How `gh pr create` was asked to fill the body from the branch's commits.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fill {
    /// `--fill` / `-f`.
    Default,
    /// `--fill-first`.
    First,
    /// `--fill-verbose`.
    Verbose,
}

/// A read-only git query in `repo`, with nothing the repository names run.
fn git_output(repo: &Path, args: &[&str]) -> Option<String> {
    let bin = crate::tools::git_native::discover_git()?;
    let mut cmd = std::process::Command::new(bin);
    cmd.args(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat"])
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The body `gh pr create --fill*` would write, built the way gh builds it:
/// one commit (or `--fill-first`) gives that commit's body; several give a
/// `- subject` line per commit, oldest first, with each body under it for
/// `--fill-verbose`. `None` when the branch's commits cannot be read.
fn fill_body(repo: &Path, base: Option<&str>, fill: Fill) -> Option<String> {
    if !repo.is_absolute() {
        return None;
    }
    let base = match base {
        Some(b) => b.to_string(),
        None => git_output(repo, &["rev-parse", "--abbrev-ref", "origin/HEAD"])?.trim().to_string(),
    };
    // gh compares against the remote's copy of the base when there is one.
    let remote = format!("origin/{base}");
    let verified =
        |r: &str| git_output(repo, &["rev-parse", "--verify", "-q", &format!("{r}^{{commit}}")]).is_some();
    let base_ref = if !base.starts_with("origin/") && verified(&remote) {
        remote
    } else if verified(&base) {
        base
    } else {
        return None;
    };
    let log = git_output(
        repo,
        &["log", "--reverse", "--no-color", "--format=%s%x1f%b%x1e", &format!("{base_ref}..HEAD")],
    )?;
    let commits: Vec<(String, String)> = log
        .split('\u{1e}')
        .map(|c| c.trim_start_matches(['\n', '\r']))
        .filter_map(|c| c.split_once('\u{1f}'))
        .map(|(s, b)| (s.trim().to_string(), b.trim().to_string()))
        .collect();
    let first = commits.first()?;
    if commits.len() == 1 || fill == Fill::First {
        return Some(first.1.clone());
    }
    let mut body = String::new();
    for (subject, text) in &commits {
        body.push_str(&format!("- {subject}\n"));
        if fill == Fill::Verbose && !text.is_empty() {
            body.push_str(&format!("\n{text}\n\n"));
        }
    }
    Some(body.trim_end().to_string())
}

/// Add the footer to a `gh pr create|edit` argv (`args[..2] == ["pr", _]`).
fn attribute_pr(args: &mut Vec<String>, base: &Path) {
    let mut body: Option<Slot> = None;
    let mut file: Option<Slot> = None;
    let mut fill: Option<Fill> = None;
    let mut base_branch: Option<String> = None;
    let mut i = 2;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "-b" | "--body" => {
                if i + 1 < args.len() {
                    body = Some(Slot::Next(i + 1));
                }
                i += 2;
                continue;
            }
            "-F" | "--body-file" => {
                if i + 1 < args.len() {
                    file = Some(Slot::Next(i + 1));
                }
                i += 2;
                continue;
            }
            "-B" | "--base" => {
                base_branch = args.get(i + 1).cloned();
                i += 2;
                continue;
            }
            "-f" | "--fill" => fill = fill.or(Some(Fill::Default)),
            "--fill-first" => fill = Some(Fill::First),
            "--fill-verbose" => fill = Some(Fill::Verbose),
            _ if a.starts_with("--base=") => base_branch = Some(a["--base=".len()..].to_string()),
            _ if a.starts_with("--body=") => body = Some(Slot::Joined(i, "--body=".into())),
            _ if a.starts_with("--body-file=") => file = Some(Slot::Joined(i, "--body-file=".into())),
            _ => {}
        }
        i += 1;
    }
    if let Some(slot) = file {
        let Some(text) = read_file(base, slot.get(args)) else { return };
        let span = slot.span();
        args.splice(span, ["--body".to_string(), add_footer(&text)]);
    } else if let Some(slot) = body {
        let value = add_footer(slot.get(args));
        slot.set(args, value);
    } else if let (Some(fill), true) = (fill, args[1] == "create") {
        // gh still fills the title; the body it would have written is given
        // explicitly, with the footer, so the prompt shows it.
        if let Some(text) = fill_body(base, base_branch.as_deref(), fill) {
            args.extend(["--body".to_string(), add_footer(&text)]);
        }
    }
}

/// Rewrite a `git` tool call's JSON arguments (`{program?, args, cwd?}`) to
/// carry the attribution the settings ask for. `base` resolves a relative
/// `-F` / `--body-file` path (the call's `cwd` is tried first). Anything that
/// is not a commit or a pull request create/edit is left alone, as is a call
/// whose shape is not understood: the tool itself reports that.
pub fn attribute_call(v: &mut Value, model_id: &str, settings: Settings, base: &Path) {
    let program = v
        .get("program")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("git")
        .to_string();
    let base = match v.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(c) if Path::new(c).is_absolute() => PathBuf::from(c),
        Some(c) => base.join(c),
        None => base.to_path_buf(),
    };
    let Some(Value::Array(items)) = v.get("args") else { return };
    let Some(mut args) = items.iter().map(|i| i.as_str().map(str::to_string)).collect::<Option<Vec<_>>>() else {
        return;
    };
    let lead = usize::from(args.first() == Some(&program));
    let mut rest = args.split_off(lead);
    let before = rest.clone();
    match (program.as_str(), rest.first().map(String::as_str), rest.get(1).map(String::as_str)) {
        ("git", Some("commit"), _) if settings.commits => {
            attribute_commit(&mut rest, &trailer(model_id), &base)
        }
        ("gh", Some("pr"), Some("create" | "edit")) if settings.pull_requests => {
            attribute_pr(&mut rest, &base)
        }
        _ => return,
    }
    if rest != before {
        args.extend(rest);
        v["args"] = Value::Array(args.into_iter().map(Value::String).collect());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T: &str = "Co-Authored-By: Flint (qwen3.8-27b) <334201045+flint-desktop@users.noreply.github.com>";

    fn run(program: &str, args: &[&str]) -> Vec<String> {
        run_with(program, args, Settings::default(), Path::new("."))
    }

    fn run_with(program: &str, args: &[&str], s: Settings, base: &Path) -> Vec<String> {
        let mut v = json!({ "program": program, "args": args });
        attribute_call(&mut v, "llamacpp/qwen3.8-27b", s, base);
        v["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn trailer_names_the_bare_model() {
        assert_eq!(trailer("llamacpp/qwen3.8-27b"), T);
        assert_eq!(trailer(""), "Co-Authored-By: Flint <334201045+flint-desktop@users.noreply.github.com>");
    }

    #[test]
    fn plain_message_gets_a_new_paragraph() {
        assert_eq!(add_trailer("Fix the parser", T), format!("Fix the parser\n\n{T}"));
        assert_eq!(add_trailer("Fix\n\nBody text.\n", T), format!("Fix\n\nBody text.\n\n{T}"));
    }

    #[test]
    fn existing_trailer_block_is_extended() {
        let msg = "Fix\n\nBody.\n\nSigned-off-by: A <a@x>\nRefs: #12";
        assert_eq!(add_trailer(msg, T), format!("{msg}\n{T}"));
        // A subject that looks like `key: value` is not a trailer block.
        assert_eq!(add_trailer("fix: parser", T), format!("fix: parser\n\n{T}"));
    }

    #[test]
    fn trailer_is_not_repeated() {
        let msg = format!("Fix\n\n{T}");
        assert_eq!(add_trailer(&msg, T), msg);
        assert_eq!(add_trailer(&msg.to_lowercase(), T), msg.to_lowercase());
        let args = run("git", &["commit", "-m", &msg]);
        assert_eq!(args, vec!["commit", "-m", &msg]);
    }

    #[test]
    fn commit_dash_m_forms() {
        assert_eq!(run("git", &["commit", "-m", "Fix"]), vec!["commit", "-m", &format!("Fix\n\n{T}")]);
        assert_eq!(run("git", &["git", "commit", "-am", "Fix"]), vec!["git", "commit", "-am", &format!("Fix\n\n{T}")]);
        assert_eq!(run("git", &["commit", "--message=Fix"]), vec!["commit", format!("--message=Fix\n\n{T}").as_str()]);
        assert_eq!(run("git", &["commit", "-mFix"]), vec!["commit", format!("-mFix\n\n{T}").as_str()]);
    }

    #[test]
    fn multiple_dash_m_only_the_last_paragraph_changes() {
        let got = run("git", &["commit", "-m", "Subject", "-m", "Body paragraph."]);
        assert_eq!(got, vec!["commit", "-m", "Subject", "-m", &format!("Body paragraph.\n\n{T}")]);
        let got = run("git", &["commit", "-m", "Subject", "-m", "Refs: #1"]);
        assert_eq!(got, vec!["commit", "-m", "Subject", "-m", &format!("Refs: #1\n{T}")]);
        // Already present in any paragraph: nothing added.
        let got = run("git", &["commit", "-m", "Subject", "-m", T, "-m", "More"]);
        assert_eq!(got, vec!["commit", "-m", "Subject", "-m", T, "-m", "More"]);
    }

    #[test]
    fn dash_f_file_is_inlined_with_the_trailer() {
        let dir = std::env::temp_dir().join(format!("flint-attr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("msg.txt"), "Subject\n\nBody.\n").unwrap();
        let got = run_with("git", &["commit", "-F", "msg.txt", "--", "a.txt"], Settings::default(), &dir);
        assert_eq!(got, vec!["commit", "-m", &format!("Subject\n\nBody.\n\n{T}"), "--", "a.txt"]);
        let got = run_with("git", &["commit", "--file=msg.txt"], Settings::default(), &dir);
        assert_eq!(got, vec!["commit", "-m", &format!("Subject\n\nBody.\n\n{T}")]);
        // A file that cannot be read is left for git to report.
        // Not readable here: git reads it and adds the trailer itself.
        let got = run_with("git", &["commit", "-F", "missing.txt"], Settings::default(), &dir);
        assert_eq!(got, vec!["commit", "-F", "missing.txt", "--trailer", T]);
        // Relative with nothing to resolve it against (Chat): the same.
        let got = run_with("git", &["commit", "-F", "msg.txt"], Settings::default(), Path::new(""));
        assert_eq!(got, vec!["commit", "-F", "msg.txt", "--trailer", T]);
        std::fs::write(dir.join("body.md"), "Details").unwrap();
        let got = run_with("gh", &["pr", "create", "--title", "T", "--body-file", "body.md"], Settings::default(), &dir);
        assert_eq!(got, vec!["pr", "create", "--title", "T", "--body", &format!("Details\n\n{PR_FOOTER}")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn amend() {
        // With a new message: the message carries the trailer.
        assert_eq!(
            run("git", &["commit", "--amend", "-m", "Fix"]),
            vec!["commit", "--amend", "-m", &format!("Fix\n\n{T}")]
        );
        // Keeping the old message: git adds it, before any pathspec.
        assert_eq!(
            run("git", &["commit", "--amend", "--no-edit", "--", "a"]),
            vec!["commit", "--amend", "--no-edit", "--trailer", T, "--", "a"]
        );
        // A fixup commit's message is git's own; left alone.
        assert_eq!(run("git", &["commit", "--fixup", "HEAD"]), vec!["commit", "--fixup", "HEAD"]);
    }

    #[test]
    fn pr_body_footer() {
        assert_eq!(
            run("gh", &["pr", "create", "--title", "T", "--body", "Details"]),
            vec!["pr", "create", "--title", "T", "--body", &format!("Details\n\n{PR_FOOTER}")]
        );
        assert_eq!(
            run("gh", &["pr", "create", "-t", "T", "-b", ""]),
            vec!["pr", "create", "-t", "T", "-b", PR_FOOTER]
        );
        assert_eq!(
            run("gh", &["pr", "edit", "5", "--body=Details"]),
            vec!["pr", "edit", "5", format!("--body=Details\n\n{PR_FOOTER}").as_str()]
        );
        // Not duplicated on an edit of a body that already ends with it.
        let body = format!("Details\n\n{PR_FOOTER}");
        assert_eq!(run("gh", &["pr", "edit", "5", "--body", &body]), vec!["pr", "edit", "5", "--body", &body]);
        // An edit that does not set the body, and other gh calls, are untouched.
        assert_eq!(run("gh", &["pr", "edit", "5", "--title", "X"]), vec!["pr", "edit", "5", "--title", "X"]);
        assert_eq!(run("gh", &["issue", "create", "--body", "B"]), vec!["issue", "create", "--body", "B"]);
    }

    #[test]
    fn pr_fill_gets_the_body_gh_would_write_plus_the_footer() {
        let dir = std::env::temp_dir().join(format!("flint-attr-fill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g = |a: &[&str]| {
            let ok = std::process::Command::new(crate::tools::git_native::discover_git().unwrap())
                .args(["-c", "user.name=T", "-c", "user.email=t@x", "-c", "commit.gpgsign=false"])
                .args(a)
                .current_dir(&dir)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "{a:?}");
        };
        g(&["init", "-q", "-b", "main"]);
        g(&["commit", "-q", "--allow-empty", "-m", "base"]);
        g(&["switch", "-q", "-c", "feat"]);
        g(&["commit", "-q", "--allow-empty", "-m", "Add parser\n\nWhy it exists."]);
        let fill = |extra: &[&str]| {
            let mut a = vec!["pr", "create", "--base", "main"];
            a.extend_from_slice(extra);
            run_with("gh", &a, Settings::default(), &dir)
        };
        // One commit: its body.
        assert_eq!(
            fill(&["--fill"]),
            vec!["pr", "create", "--base", "main", "--fill", "--body", &format!("Why it exists.\n\n{PR_FOOTER}")]
        );
        g(&["commit", "-q", "--allow-empty", "-m", "Test parser"]);
        // Several: a line per commit, oldest first.
        assert_eq!(
            fill(&["-f"]).last().unwrap(),
            &format!("- Add parser\n- Test parser\n\n{PR_FOOTER}")
        );
        assert_eq!(fill(&["--fill-first"]).last().unwrap(), &format!("Why it exists.\n\n{PR_FOOTER}"));
        assert_eq!(
            fill(&["--fill-verbose"]).last().unwrap(),
            &format!("- Add parser\n\nWhy it exists.\n\n- Test parser\n\n{PR_FOOTER}")
        );
        // A body given explicitly wins, and a base that does not exist leaves the call alone.
        assert_eq!(fill(&["--fill", "--body", "B"]).last().unwrap(), &format!("B\n\n{PR_FOOTER}"));
        let got = run_with("gh", &["pr", "create", "--base", "nope", "--fill"], Settings::default(), &dir);
        assert_eq!(got, vec!["pr", "create", "--base", "nope", "--fill"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn toggles_off_leave_calls_alone() {
        let off = Settings { commits: false, pull_requests: false };
        assert_eq!(run_with("git", &["commit", "-m", "Fix"], off, Path::new(".")), vec!["commit", "-m", "Fix"]);
        assert_eq!(
            run_with("gh", &["pr", "create", "--body", "B"], off, Path::new(".")),
            vec!["pr", "create", "--body", "B"]
        );
        let only_prs = Settings { commits: false, pull_requests: true };
        assert_eq!(run_with("git", &["commit", "-m", "Fix"], only_prs, Path::new(".")), vec!["commit", "-m", "Fix"]);
    }

    #[test]
    fn settings_round_trip_and_default_on() {
        let dir = std::env::temp_dir().join(format!("flint-attr-s-{}", std::process::id()));
        assert_eq!(load(Some(&dir)), Settings::default());
        save(&dir, &Settings { commits: false, pull_requests: true }).unwrap();
        assert_eq!(load(Some(&dir)), Settings { commits: false, pull_requests: true });
        std::fs::write(settings_path(&dir), r#"{"pullRequests": false}"#).unwrap();
        assert_eq!(load(Some(&dir)), Settings { commits: true, pull_requests: false });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_rewritten_call_still_plans() {
        let args = run("git", &["commit", "-m", "Fix"]);
        assert!(crate::tools::git_tool::plan("git", &args).is_ok());
        let args = run("gh", &["pr", "create", "--title", "T", "--body", "B"]);
        assert!(crate::tools::git_tool::plan("gh", &args).is_ok());
    }
}
