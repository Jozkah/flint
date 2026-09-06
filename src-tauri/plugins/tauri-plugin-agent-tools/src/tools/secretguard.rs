//! Refuse a change that would write a credential into the project (AH-157).
//!
//! Redaction (AH-045) keeps credentials out of logs, journals and audit events.
//! It cannot help with the opposite direction: an agent that *writes* a key into
//! a tracked file. Once that lands, a commit puts it in history, and history is
//! the one place a secret cannot be taken back out.
//!
//! So writes are scanned rather than rewritten. Silently editing content the
//! model asked to write would leave the file disagreeing with what the model
//! believes it wrote and the run continuing on a false premise; the call is
//! refused instead, with a message that says which line and what kind, and never
//! the value.
//!
//! Two entry points, matching the two moments a credential can reach a file:
//!
//! - [`guard_added_lines`] for `write`/`edit`, scanning the *added* lines of the
//!   diff the tool is about to apply. Only added lines: a key that is already in
//!   the file is not this change's doing, and blocking every edit to a file that
//!   already contains one would make the file uneditable.
//! - [`guard_staged_diff`] for a `git commit`, scanning what is staged. A file
//!   can be staged by a command that never went through the write tools (`git
//!   add` after a shell redirect, a patch applied by `git apply`), so the commit
//!   is the second, independent check rather than a repeat of the first.
//!
//! Detection is [`jan_agent_harness::secrets`] -- the same rules the redactor
//! uses, so what is refused here and what is hidden there can never drift apart.

use std::path::Path;

use jan_agent_harness::secrets::{scan, Finding};

/// A credential found in a change, located the way the author would look for it:
/// by the file it is in and the line as it appears in the new content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// The file the added line belongs to. Empty when the diff carries no file
    /// header (the `write`/`edit` display diff describes a single known file).
    pub file: String,
    /// 1-based line number in the new content, when the diff states it.
    pub line: Option<usize>,
    /// What the value looked like. Never the value.
    pub kind: &'static str,
}

impl Hit {
    fn describe(&self) -> String {
        match (&self.file.is_empty(), self.line) {
            (false, Some(line)) => format!("{}:{} ({})", self.file, line, self.kind),
            (false, None) => format!("{} ({})", self.file, self.kind),
            (true, Some(line)) => format!("line {} ({})", line, self.kind),
            (true, None) => format!("({})", self.kind),
        }
    }
}

/// The refusal a tool returns instead of applying the change.
///
/// `ERROR` prefixed, because that is how every other refusal in this module
/// reaches the model, and the surrounding handler treats the prefix as a failure
/// that must not be recorded as a successful call.
pub fn refusal(hits: &[Hit], what: &str) -> String {
    let mut message = format!(
        "ERROR: refusing to {what}: it would add {} to the project.\n",
        if hits.len() == 1 {
            "a credential".to_string()
        } else {
            format!("{} credentials", hits.len())
        }
    );
    for hit in hits {
        message.push_str("  - ");
        message.push_str(&hit.describe());
        message.push('\n');
    }
    message.push_str(
        "Nothing was written. Put the value in the environment or a secret store \
         the project ignores, and reference it by name instead. If this is a test \
         fixture or a placeholder, make it obviously fake (`$VAR`, `<redacted>`, \
         `example`).",
    );
    message
}

/// Credentials in the added lines of a line-prefixed diff.
///
/// Handles both diff shapes this codebase produces: the display diff from
/// `render_write_diff`/`render_edit_diff` (`+`-prefixed lines, `@@ ... @@`
/// markers, an optional `1 | ` line-number gutter) and a real unified diff from
/// `git diff` (`+++ b/path` headers, `@@ -a,b +c,d @@` hunks). Anything it
/// cannot parse degrades toward scanning the line, never toward skipping it.
pub fn guard_added_lines(diff: &str, default_file: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    let mut file = default_file.to_string();
    // Line number in the *new* file, tracked through unified-diff hunk headers.
    let mut new_line: Option<usize> = None;

    for raw in diff.lines() {
        if let Some(path) = raw.strip_prefix("+++ ") {
            // `+++ b/src/main.rs` or `+++ /dev/null`.
            let path = path.trim();
            let path = path.strip_prefix("b/").unwrap_or(path);
            if path != "/dev/null" {
                file = path.split('\t').next().unwrap_or(path).to_string();
            }
            continue;
        }
        if raw.starts_with("--- ") || raw.starts_with("diff --git ") {
            continue;
        }
        if let Some(header) = raw.strip_prefix("@@") {
            new_line = parse_new_start(header);
            continue;
        }
        let Some(rest) = raw.strip_prefix('+') else {
            // A context or removed line advances the new-file counter only when
            // it is context.
            if let Some(n) = new_line.as_mut() {
                if !raw.starts_with('-') {
                    *n += 1;
                }
            }
            continue;
        };
        // The display diff writes `+  12 | text`; the gutter is rendering, not
        // content, so strip it before scanning and use it as the line number.
        let (line_no, content) = split_gutter(rest);
        let line = line_no.or(new_line);
        for Finding { kind, .. } in scan(content) {
            hits.push(Hit {
                file: file.clone(),
                line,
                kind: kind.label(),
            });
        }
        if let Some(n) = new_line.as_mut() {
            *n += 1;
        }
    }
    hits
}

/// `@@ -1,4 +7,9 @@` -> `Some(7)`. `None` when the header is not that shape,
/// which includes this codebase's own `@@ edit 1/2 @@` marker.
fn parse_new_start(header: &str) -> Option<usize> {
    let plus = header.split('+').nth(1)?;
    let digits: String = plus.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Splits `  12 | text` into `(Some(12), "text")`, or `(None, whole)` when there
/// is no gutter. A `|` inside real content is common (a shell pipe, a table), so
/// the gutter counts only when everything before it is a number.
fn split_gutter(line: &str) -> (Option<usize>, &str) {
    let Some((head, tail)) = line.split_once('|') else {
        return (None, line);
    };
    let head = head.trim();
    if head.is_empty() || !head.chars().all(|c| c.is_ascii_digit()) {
        return (None, line);
    }
    (head.parse().ok(), tail.strip_prefix(' ').unwrap_or(tail))
}

/// Credentials in what is currently staged in `repo`.
///
/// Returns `Ok(vec![])` when nothing is staged, and also when git cannot be run
/// or the path is not a repository: this is a guard on a commit that git itself
/// would then refuse, and failing the call because `git` is missing would break
/// every non-git use of the shell tool. A guard that cannot run must not become
/// an outage -- but it must also not claim to have passed, which is why the
/// caller only skips the refusal, never records an approval.
pub fn guard_staged_diff(repo: &Path) -> Result<Vec<Hit>, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["diff", "--cached", "--unified=0", "--no-color"])
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let diff = String::from_utf8_lossy(&output.stdout);
    Ok(guard_added_lines(&diff, ""))
}

/// True when `command` is a git commit -- the moment a staged credential becomes
/// permanent.
///
/// Deliberately generous about form (`git commit`, `git -C dir commit`,
/// `git commit -am ...`) and deliberately narrow about intent: `git commit-tree`
/// is a different command and is not matched, and neither is the word `commit`
/// appearing as an argument (`git log --grep commit`).
pub fn is_git_commit(command: &str) -> bool {
    let mut tokens = command.split_whitespace();
    let Some(program) = tokens.next() else {
        return false;
    };
    let program = program.rsplit(['/', '\\']).next().unwrap_or(program);
    if program != "git" && program != "git.exe" {
        return false;
    }
    // Skip git's own global flags and their values, which sit before the
    // subcommand: `git -C dir -c k=v commit`.
    let mut next_takes_value = false;
    for token in tokens {
        if next_takes_value {
            next_takes_value = false;
            continue;
        }
        if let Some(flag) = token.strip_prefix('-') {
            let flag = flag.trim_start_matches('-');
            next_takes_value = matches!(flag, "C" | "c" | "git-dir" | "work-tree" | "namespace");
            continue;
        }
        return token == "commit";
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AKIAIOSFODNN7EXAMPLE";

    #[test]
    fn an_added_credential_is_reported_with_its_file_and_line() {
        let diff = format!("@@ -1,2 +1,3 @@\n context\n+AWS_ACCESS_KEY_ID={KEY}\n context\n");
        let hits = guard_added_lines(&diff, "deploy/.env");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].file, "deploy/.env");
        assert_eq!(hits[0].line, Some(2));
    }

    #[test]
    fn a_credential_already_in_the_file_does_not_block_an_edit() {
        let diff = format!(" AWS_ACCESS_KEY_ID={KEY}\n+# a comment\n");
        assert!(guard_added_lines(&diff, "a.env").is_empty());
    }

    #[test]
    fn a_removed_credential_does_not_block_the_removal() {
        let diff = format!("-AWS_ACCESS_KEY_ID={KEY}\n+AWS_ACCESS_KEY_ID=$FROM_ENV\n");
        assert!(guard_added_lines(&diff, "a.env").is_empty());
    }

    #[test]
    fn the_display_diffs_line_gutter_is_not_scanned_as_content() {
        let diff = format!("@@ created file @@\n+    1 | API_KEY={KEY}\n+    2 | ok\n");
        let hits = guard_added_lines(&diff, "config.toml");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].line, Some(1));
    }

    #[test]
    fn a_pipe_in_content_is_not_mistaken_for_a_gutter() {
        let diff = "+cat a | grep b\n";
        assert!(guard_added_lines(diff, "run.sh").is_empty());
    }

    #[test]
    fn a_unified_diff_names_each_file_it_touches() {
        let diff = format!(
            "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -0,0 +1 @@\n+clean\n\
             diff --git a/two.env b/two.env\n--- /dev/null\n+++ b/two.env\n@@ -0,0 +1 @@\n+API_KEY={KEY}\n"
        );
        let hits = guard_added_lines(&diff, "");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].file, "two.env");
        assert_eq!(hits[0].line, Some(1));
    }

    #[test]
    fn placeholders_and_env_references_are_not_credentials() {
        let diff = "+API_KEY=$OPENAI_API_KEY\n+password: <redacted>\n+max_tokens=4096\n";
        assert!(guard_added_lines(diff, "a.toml").is_empty());
    }

    #[test]
    fn the_refusal_names_the_location_and_never_the_value() {
        let hits = vec![Hit {
            file: "deploy/.env".into(),
            line: Some(3),
            kind: "aws-access-key-id",
        }];
        let message = refusal(&hits, "write deploy/.env");
        assert!(message.starts_with("ERROR: refusing to write deploy/.env"));
        assert!(message.contains("deploy/.env:3 (aws-access-key-id)"));
        assert!(message.contains("Nothing was written"));
        assert!(!message.contains(KEY));
    }

    #[test]
    fn a_git_commit_is_recognised_through_its_global_flags() {
        for command in [
            "git commit -m x",
            "git commit",
            "git -C /repo commit -am x",
            "git -c user.name=x commit",
            "/usr/bin/git commit",
        ] {
            assert!(is_git_commit(command), "not recognised: {command}");
        }
    }

    #[test]
    fn a_command_that_merely_mentions_commit_is_not_one() {
        for command in [
            "git log --grep commit",
            "git commit-tree abc",
            "git status",
            "echo git commit",
            "",
        ] {
            assert!(!is_git_commit(command), "wrongly recognised: {command}");
        }
    }

    #[test]
    fn staging_a_credential_is_caught_at_the_commit() {
        let Some(dir) = git_repo() else {
            // No git on this machine: the guard's own contract is that it does
            // not become an outage, which the next test asserts directly.
            return;
        };
        std::fs::write(dir.join("deploy.env"), format!("API_KEY={KEY}\n")).unwrap();
        run_git(&dir, &["add", "deploy.env"]);
        let hits = guard_staged_diff(&dir).expect("git diff --cached runs");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].file, "deploy.env");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clean_staged_change_is_allowed() {
        let Some(dir) = git_repo() else { return };
        std::fs::write(dir.join("notes.md"), "nothing secret here\n").unwrap();
        run_git(&dir, &["add", "notes.md"]);
        assert!(guard_staged_diff(&dir).expect("git runs").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_that_is_not_a_repository_is_an_error_not_a_pass() {
        let dir = std::env::temp_dir().join(format!("jan_secretguard_bare_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Either git is missing or the path is not a repo; both are `Err`, and
        // the point is that neither is `Ok(vec![])`, which would read as "checked
        // and clean".
        assert!(guard_staged_diff(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── test helpers ────────────────────────────────────────────────────────

    fn run_git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output();
        assert!(status.is_ok(), "git {args:?} could not run");
    }

    /// A throwaway repository, or `None` when git is unavailable.
    fn git_repo() -> Option<std::path::PathBuf> {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "jan_secretguard_{}_{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).ok()?;
        let init = std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["init", "--quiet"])
            .output()
            .ok()?;
        if !init.status.success() {
            return None;
        }
        Some(dir)
    }
}
