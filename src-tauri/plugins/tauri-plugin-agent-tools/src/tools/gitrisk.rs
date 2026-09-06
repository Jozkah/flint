//! Recognise the git commands that destroy work (AH-046).
//!
//! Exec permission in this harness is granted per base command, which is what
//! makes "allow all git commands" a usable answer to a prompt: the model can then
//! run `git status`, `git diff`, `git add`, `git commit` without asking again. The
//! problem is that the same grant covers `git reset --hard` and
//! `git push --force`, and those are not more git usage -- they are the
//! irreversible kind. A hard reset discards uncommitted work with no reflog entry
//! to recover it from; a force push rewrites a branch other people have.
//!
//! So destructive git is classified here and gated on its own, separately from
//! safe git usage: a `git` grant never covers it, and approving one destructive
//! command does not approve the next one.
//!
//! ## What counts
//!
//! Only operations that can lose committed or uncommitted work, or rewrite
//! published history. Reading, staging, committing, branching, fetching and
//! merging are not here: a bad merge is recoverable, and a gate that prompts for
//! ordinary work teaches the operator to approve without reading.
//!
//! ## Compound commands
//!
//! `make build && git reset --hard` is a destructive command. Every segment is
//! classified, so hiding the reset behind a separator, a pipe or a newline does
//! not get it past the gate. The segmentation here is deliberately simple and
//! errs toward *finding* a git invocation: [`cmdscan`](super::cmdscan) already
//! owns the question of which base commands a line runs, and this module only has
//! to decide whether any of them is a destructive git.

/// What makes a command destructive. The variant is what the prompt shows, so
/// each one names the loss rather than the flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitRisk {
    /// `push --force` / `push -f` / `push --mirror`: rewrites a remote branch.
    ForcePush,
    /// `push --delete` / `push :branch`: removes a remote branch.
    RemoteBranchDelete,
    /// `reset --hard` / `reset --merge` / `reset --keep`: discards the working
    /// tree, with no reflog entry for uncommitted changes.
    HardReset,
    /// `clean -f` / `-fd` / `-x`: deletes untracked files, including ignored ones
    /// with `-x`, and untracked files are not in the object database at all.
    DestructiveClean,
    /// `checkout --` / `checkout -f` / `restore` without `--staged`: overwrites
    /// working-tree files from the index or a commit.
    DiscardChanges,
    /// `branch -D` / `branch --delete --force`: deletes a branch whose commits
    /// may be unreachable afterwards.
    BranchDelete,
    /// `filter-branch`, `filter-repo`, `rebase` with `--force-rebase`,
    /// `commit --amend` on a pushed commit, `replace`: rewrites history.
    HistoryRewrite,
    /// `update-ref -d`, `reflog expire`, `gc --prune=now`: removes the recovery
    /// path other destructive operations rely on.
    RecoveryLoss,
    /// `stash drop` / `stash clear`: deletes stashed work.
    StashDrop,
    /// `worktree remove --force`: deletes a worktree with changes in it.
    WorktreeForceRemove,
}

impl GitRisk {
    /// A short, stable identifier -- used in events and tests.
    pub fn label(self) -> &'static str {
        match self {
            GitRisk::ForcePush => "force-push",
            GitRisk::RemoteBranchDelete => "remote-branch-delete",
            GitRisk::HardReset => "hard-reset",
            GitRisk::DestructiveClean => "destructive-clean",
            GitRisk::DiscardChanges => "discard-changes",
            GitRisk::BranchDelete => "branch-delete",
            GitRisk::HistoryRewrite => "history-rewrite",
            GitRisk::RecoveryLoss => "recovery-loss",
            GitRisk::StashDrop => "stash-drop",
            GitRisk::WorktreeForceRemove => "worktree-force-remove",
        }
    }

    /// What is lost if this runs, in one sentence, for the prompt.
    pub fn explain(self) -> &'static str {
        match self {
            GitRisk::ForcePush => {
                "rewrites the remote branch; commits only on the remote are lost"
            }
            GitRisk::RemoteBranchDelete => "deletes the branch on the remote",
            GitRisk::HardReset => {
                "discards every uncommitted change in the working tree, which the reflog cannot recover"
            }
            GitRisk::DestructiveClean => {
                "deletes untracked files, which were never in the object database"
            }
            GitRisk::DiscardChanges => "overwrites working-tree files, discarding uncommitted edits",
            GitRisk::BranchDelete => "deletes the branch, and with it any commits only it reached",
            GitRisk::HistoryRewrite => "rewrites existing history",
            GitRisk::RecoveryLoss => {
                "removes the reflog or unreachable objects that other recoveries depend on"
            }
            GitRisk::StashDrop => {
                "deletes stashed work, which no branch or tag points at"
            }
            GitRisk::WorktreeForceRemove => "deletes the worktree including its uncommitted changes",
        }
    }
}

/// The destructive git operation `command` performs, if any. The first one found
/// wins: one is enough to gate the call, and reporting a list would only make the
/// prompt longer.
pub fn classify(command: &str) -> Option<GitRisk> {
    segments(command).into_iter().find_map(classify_segment)
}

/// Split a command line into the pieces that could each be an invocation.
///
/// Separators only -- quoting is not tracked, so a git-looking string inside a
/// quoted argument (`echo "git reset --hard"`) is classified as if it ran. That
/// is the safe direction to be wrong in: the cost is a prompt the operator
/// declines, against a destructive command that slipped through.
fn segments(command: &str) -> Vec<&str> {
    command
        .split(|c| c == ';' || c == '\n' || c == '\r')
        .flat_map(|part| part.split("&&"))
        .flat_map(|part| part.split("||"))
        .flat_map(|part| part.split('|'))
        .flat_map(|part| part.split('&'))
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

fn classify_segment(segment: &str) -> Option<GitRisk> {
    let mut tokens = segment.split_whitespace().peekable();

    // Walk past anything that wraps the real command, so `sudo git ...`,
    // `env X=1 git ...` and `nice git ...` are still seen as git.
    let mut program = None;
    while let Some(token) = tokens.next() {
        let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
        let base = base.strip_suffix(".exe").unwrap_or(base);
        if base.contains('=') {
            continue; // `VAR=value` prefix assignment
        }
        // A wrapper's own argument: `timeout 30 git ...`, `nice -n 5 git ...`.
        // Skipped by shape rather than by remembering which wrapper it followed,
        // because a bare number is never a program name.
        if base.chars().all(|c| c.is_ascii_digit() || c == '.') && !base.is_empty() {
            continue;
        }
        if base.starts_with('-') {
            continue;
        }
        if matches!(
            base,
            "sudo" | "doas" | "env" | "nice" | "nohup" | "time" | "timeout" | "stdbuf" | "command"
        ) {
            continue;
        }
        program = Some(base);
        break;
    }
    if program? != "git" {
        return None;
    }

    // git's own global flags precede the subcommand; some take a value.
    let mut rest: Vec<&str> = Vec::new();
    let mut skip_value = false;
    for token in tokens {
        if skip_value {
            skip_value = false;
            continue;
        }
        if let Some(flag) = token.strip_prefix('-') {
            let flag = flag.trim_start_matches('-');
            let name = flag.split('=').next().unwrap_or(flag);
            skip_value = !flag.contains('=')
                && matches!(name, "C" | "c" | "git-dir" | "work-tree" | "namespace" | "exec-path");
            continue;
        }
        rest.push(token);
    }
    let subcommand = *rest.first()?;
    // Flags for the subcommand, from the whole segment: they can appear before or
    // after positional arguments (`git clean -fd .` and `git clean . -fd`).
    let flags: Vec<&str> = segment
        .split_whitespace()
        .filter(|t| t.starts_with('-'))
        .collect();
    let has = |names: &[&str]| {
        flags.iter().any(|flag| {
            let stripped = flag.trim_start_matches('-');
            let name = stripped.split('=').next().unwrap_or(stripped);
            if names.contains(&name) {
                return true;
            }
            // Short flags cluster: `-fdx` is `-f -d -x`.
            !flag.starts_with("--")
                && stripped.chars().all(|c| c.is_ascii_alphabetic())
                && names
                    .iter()
                    .any(|n| n.len() == 1 && stripped.contains(*n))
        })
    };

    match subcommand {
        "push" => {
            if has(&["force", "f", "mirror"]) {
                return Some(GitRisk::ForcePush);
            }
            // `--force-with-lease` is safer but still rewrites the branch.
            if flags.iter().any(|f| f.starts_with("--force-with-lease")) {
                return Some(GitRisk::ForcePush);
            }
            if has(&["delete", "d"]) || rest.iter().any(|arg| arg.starts_with(':')) {
                return Some(GitRisk::RemoteBranchDelete);
            }
            None
        }
        "reset" => has(&["hard", "merge", "keep"]).then_some(GitRisk::HardReset),
        "clean" => {
            // `-n`/`--dry-run` deletes nothing, whatever else is present.
            if has(&["n", "dry-run"]) {
                return None;
            }
            has(&["f", "force", "x", "X", "d"]).then_some(GitRisk::DestructiveClean)
        }
        "checkout" => {
            if has(&["f", "force"]) || segment.contains(" -- ") {
                return Some(GitRisk::DiscardChanges);
            }
            None
        }
        "restore" => {
            // `--staged` alone only unstages; without it the working tree is
            // overwritten.
            (!has(&["staged"]) || has(&["worktree", "W"])).then_some(GitRisk::DiscardChanges)
        }
        "branch" => flags
            .iter()
            .any(|f| *f == "-D" || (has(&["delete", "d"]) && has(&["force"])))
            .then_some(GitRisk::BranchDelete),
        "filter-branch" | "filter-repo" | "replace" => Some(GitRisk::HistoryRewrite),
        "commit" => has(&["amend"]).then_some(GitRisk::HistoryRewrite),
        "rebase" => has(&["force-rebase", "root"]).then_some(GitRisk::HistoryRewrite),
        "update-ref" => has(&["d"]).then_some(GitRisk::RecoveryLoss),
        "reflog" => (rest.get(1) == Some(&"expire") || rest.get(1) == Some(&"delete"))
            .then_some(GitRisk::RecoveryLoss),
        "gc" => flags
            .iter()
            .any(|f| f.starts_with("--prune"))
            .then_some(GitRisk::RecoveryLoss),
        "prune" => Some(GitRisk::RecoveryLoss),
        "stash" => matches!(rest.get(1), Some(&"drop") | Some(&"clear")).then_some(GitRisk::StashDrop),
        "worktree" => (rest.get(1) == Some(&"remove") && has(&["force", "f"]))
            .then_some(GitRisk::WorktreeForceRemove),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_operations_that_lose_work() {
        for (command, risk) in [
            ("git push --force origin main", GitRisk::ForcePush),
            ("git push -f", GitRisk::ForcePush),
            ("git push --force-with-lease origin main", GitRisk::ForcePush),
            ("git push --mirror backup", GitRisk::ForcePush),
            ("git push origin --delete feature", GitRisk::RemoteBranchDelete),
            ("git push origin :feature", GitRisk::RemoteBranchDelete),
            ("git reset --hard HEAD~3", GitRisk::HardReset),
            ("git reset --keep origin/main", GitRisk::HardReset),
            ("git clean -fd", GitRisk::DestructiveClean),
            ("git clean -xfd .", GitRisk::DestructiveClean),
            ("git checkout -- src/", GitRisk::DiscardChanges),
            ("git checkout -f main", GitRisk::DiscardChanges),
            ("git restore src/main.rs", GitRisk::DiscardChanges),
            ("git branch -D feature", GitRisk::BranchDelete),
            ("git filter-branch --tree-filter x", GitRisk::HistoryRewrite),
            ("git commit --amend -m x", GitRisk::HistoryRewrite),
            ("git update-ref -d refs/heads/x", GitRisk::RecoveryLoss),
            ("git reflog expire --all", GitRisk::RecoveryLoss),
            ("git gc --prune=now", GitRisk::RecoveryLoss),
            ("git stash clear", GitRisk::StashDrop),
            ("git worktree remove --force wt", GitRisk::WorktreeForceRemove),
        ] {
            assert_eq!(classify(command), Some(risk), "misclassified: {command}");
        }
    }

    #[test]
    fn ordinary_git_usage_is_not_destructive() {
        for command in [
            "git status",
            "git status --porcelain",
            "git diff HEAD~1",
            "git add -A",
            "git commit -m 'work'",
            "git log --oneline -20",
            "git fetch origin",
            "git pull --rebase",
            "git push origin main",
            "git branch feature",
            "git branch -d merged",
            "git checkout main",
            "git checkout -b feature",
            "git switch main",
            "git restore --staged src/main.rs",
            "git stash push -m wip",
            "git stash list",
            "git clean --dry-run -fd",
            "git clean -n",
            "git reset HEAD~1",
            "git reset --soft HEAD~1",
            "git worktree remove wt",
            "git rebase main",
            "git merge feature",
        ] {
            assert_eq!(classify(command), None, "false positive: {command}");
        }
    }

    #[test]
    fn a_destructive_command_hidden_in_a_compound_line_is_still_found() {
        for command in [
            "cargo build && git reset --hard",
            "git status; git clean -fdx",
            "git fetch || git reset --hard origin/main",
            "echo start\ngit push --force",
            "make test & git clean -fd",
            "git log | head && git branch -D wip",
        ] {
            assert!(classify(command).is_some(), "missed: {command}");
        }
    }

    #[test]
    fn a_wrapper_does_not_hide_the_command() {
        for command in [
            "sudo git reset --hard",
            "env GIT_DIR=.git git clean -fd",
            "timeout 30 git push --force",
            "/usr/bin/git reset --hard",
        ] {
            assert!(classify(command).is_some(), "missed: {command}");
        }
    }

    #[test]
    fn a_command_that_is_not_git_is_not_classified() {
        for command in [
            "rm -rf /",
            "cargo clean",
            "hg push --force",
            "echo git",
            "",
        ] {
            assert_eq!(classify(command), None, "wrongly classified: {command}");
        }
    }

    #[test]
    fn every_risk_explains_itself_without_naming_a_flag() {
        for risk in [
            GitRisk::ForcePush,
            GitRisk::RemoteBranchDelete,
            GitRisk::HardReset,
            GitRisk::DestructiveClean,
            GitRisk::DiscardChanges,
            GitRisk::BranchDelete,
            GitRisk::HistoryRewrite,
            GitRisk::RecoveryLoss,
            GitRisk::StashDrop,
            GitRisk::WorktreeForceRemove,
        ] {
            assert!(!risk.label().is_empty());
            let explanation = risk.explain();
            assert!(explanation.len() > 20, "too terse for a prompt: {explanation}");
            assert!(!explanation.contains("--"), "prompt should name the loss: {explanation}");
        }
    }
}
