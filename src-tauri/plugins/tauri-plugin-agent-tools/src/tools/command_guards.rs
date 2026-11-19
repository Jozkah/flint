//! Small refusals for shell and git commands that the permission gate does not
//! express: what an isolated worktree run may do to branches it shares with the
//! main checkout, files that look like secrets going into a commit, commands
//! whose variable expansions would be enormous, and commands that name a path a
//! `read`/`edit`/`write` deny rule covers.
//!
//! Everything here is a pure function of the command text (plus, for the last
//! one, the permission rules), so the `bash` tool, the `git` tool and the
//! desktop's gate all read the same answer. Each refusal says what it refused
//! and what still works, so the model does not spend a turn guessing.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// Largest text a command's variable expansions may build, in bytes.
pub const MAX_EXPANDED_BYTES: usize = 64 * 1024;

/// The branch namespace Flint gives its own worktrees' branches.
const OWN_BRANCH_PREFIX: &str = "flint/";

// ---------------------------------------------------------------------------
// Isolated worktree guards
// ---------------------------------------------------------------------------

/// The folder of the isolated worktree this run writes to, when it writes to
/// one Flint owns (the first granted write root sits under the worktrees
/// folder). `None` for every other run, so none of these guards apply there.
pub fn isolated_worktree(ctx: &crate::tools::ToolContext<'_>) -> Option<PathBuf> {
    let data = ctx.mask_root?;
    let owned = crate::workspace::worktrees_dir(data).canonicalize().ok()?;
    let real = ctx.write_roots.first()?.canonicalize().ok()?;
    (real.starts_with(&owned) && real != owned).then_some(real)
}

/// Git subcommands that only read. Pointed at another checkout (`-C`) these
/// are harmless; anything else is not.
const READ_ONLY_SUBCOMMANDS: &[&str] = &[
    "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "cat-file", "blame",
    "describe", "shortlog", "grep", "rev-list", "merge-base", "name-rev", "reflog", "for-each-ref",
    "show-ref", "diff-tree", "diff-files", "diff-index", "check-ignore", "cherry", "whatchanged",
];

fn stripped(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn resolve(base: &Path, raw: &str) -> PathBuf {
    let p = Path::new(raw);
    let joined = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
    stripped(&joined.canonicalize().unwrap_or_else(|_| lexical(&joined)))
}

fn is_flint_ref(branch: &str) -> bool {
    let b = branch.strip_prefix("refs/heads/").unwrap_or(branch);
    b.starts_with(OWN_BRANCH_PREFIX)
}

fn refusal(what: &str, still_works: &str) -> String {
    format!(
        "refused in an isolated worktree: {what}. {still_works}"
    )
}

const SHARED_BRANCH_STILL_WORKS: &str = "Still works: committing, creating and switching branches under `flint/`, merging into this worktree's branch, a plain `git push`, and any read-only command. Changes to other branches go through the user's own checkout";

/// Why a git command (its argv after the program name) must not run in the
/// isolated worktree at `worktree`, or `None`. See the module docs.
pub fn git_worktree_refusal(argv: &[String], worktree: &Path) -> Option<String> {
    let worktree = stripped(&worktree.canonicalize().unwrap_or_else(|_| worktree.to_path_buf()));
    let mut foreign: Vec<String> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "-C" | "--git-dir" | "--work-tree" => {
                if let Some(v) = argv.get(i + 1) {
                    foreign.push(v.clone());
                }
                i += 2;
                continue;
            }
            "-c" | "--exec-path" | "--namespace" => {
                i += 2;
                continue;
            }
            _ if a.starts_with("--git-dir=") || a.starts_with("--work-tree=") => {
                foreign.push(a.split_once('=').map(|(_, v)| v.to_string()).unwrap_or_default());
            }
            _ if a.starts_with('-') => {}
            _ => break,
        }
        i += 1;
    }
    let sub = argv.get(i)?.to_ascii_lowercase();
    let rest: Vec<&str> = argv[i + 1..].iter().map(String::as_str).collect();
    let names = |only_after_dashdash: bool| -> Vec<&str> {
        let mut out = Vec::new();
        let mut dashes = false;
        for a in &rest {
            if *a == "--" {
                dashes = true;
                continue;
            }
            if !a.starts_with('-') || (only_after_dashdash && dashes) {
                out.push(*a);
            }
        }
        out
    };

    // Another checkout than this worktree: only reads.
    for target in &foreign {
        let there = resolve(&worktree, target);
        if !there.starts_with(&worktree) && !READ_ONLY_SUBCOMMANDS.contains(&sub.as_str()) {
            return Some(refusal(
                &format!("`git {sub}` aimed at {target}, outside this worktree, could change the main checkout"),
                "Still works: read-only commands (status, log, diff, show) against it, and any command inside this worktree",
            ));
        }
    }

    match sub.as_str() {
        "bisect" if rest.first().is_some_and(|r| r.eq_ignore_ascii_case("run")) => Some(refusal(
            "`git bisect run` repeatedly checks out commits and runs a command unattended",
            "Still works: `git bisect start`, `good`, `bad`, `skip`, `log` and `reset` step by step, and running the test command yourself",
        )),
        "maintenance"
            if rest
                .first()
                .is_some_and(|r| matches!(r.to_ascii_lowercase().as_str(), "register" | "start")) =>
        {
            Some(refusal(
                "`git maintenance register|start` adds this repository to the machine's background maintenance schedule",
                "Still works: `git maintenance run` for a one-off pass, and `git gc`",
            ))
        }
        "push" => {
            let forced = rest.iter().any(|a| {
                matches!(*a, "--force" | "-f" | "--mirror" | "--delete" | "-d")
                    || a.starts_with("--force-with-lease")
                    || a.starts_with("--force-if-includes")
                    || (a.starts_with('-') && !a.starts_with("--") && a[1..].contains('f'))
                    || a.starts_with('+')
                    || (a.starts_with(':') && a.len() > 1)
            });
            forced.then(|| {
                refusal(
                    "a forced or deleting `git push` rewrites a branch other checkouts share",
                    SHARED_BRANCH_STILL_WORKS,
                )
            })
        }
        "branch" => {
            let flag = rest.iter().any(|a| {
                matches!(
                    *a,
                    "-f" | "--force" | "-D" | "-d" | "--delete" | "-m" | "-M" | "--move" | "-c" | "-C" | "--copy"
                ) || (a.starts_with('-')
                    && !a.starts_with("--")
                    && a[1..].chars().all(|c| c.is_ascii_alphabetic())
                    && a[1..].chars().any(|c| matches!(c, 'f' | 'D' | 'd' | 'm' | 'M' | 'c' | 'C')))
            });
            let other = names(false).into_iter().any(|n| !is_flint_ref(n));
            (flag && other).then(|| {
                refusal(
                    "`git branch` would move, rename or delete a branch outside `flint/`, which the main checkout may be using",
                    SHARED_BRANCH_STILL_WORKS,
                )
            })
        }
        "update-ref" => {
            let target = names(false).into_iter().next()?;
            let own = target == "HEAD" || is_flint_ref(target) || target.starts_with("refs/flint/") || target.starts_with("refs/worktree/");
            (!own).then(|| {
                refusal(
                    &format!("`git update-ref {target}` rewrites a ref this worktree does not own"),
                    SHARED_BRANCH_STILL_WORKS,
                )
            })
        }
        _ => None,
    }
}

/// [`git_worktree_refusal`] for every `git` invocation in a shell command line.
pub fn command_worktree_refusal(command: &str, worktree: &Path) -> Option<String> {
    for simple in crate::tools::cmdscan::simple_commands(command) {
        let Some(tokens) = crate::tools::git_tool::split_command_line(&simple) else {
            continue;
        };
        let Some(first) = tokens.first() else { continue };
        let base = first.rsplit(['/', '\\']).next().unwrap_or(first).to_ascii_lowercase();
        if base == "git" || base == "git.exe" {
            if let Some(why) = git_worktree_refusal(&tokens[1..], worktree) {
                return Some(why);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Files that probably hold secrets
// ---------------------------------------------------------------------------

/// Whether a path's file name looks like it holds a secret: `.env` and
/// `.env.*` (the committed templates `.env.example`, `.env.sample`,
/// `.env.template` and `.env.dist` excepted), `*.pem`, `*.key`, `*.p12`,
/// `*.pfx`, private keys named `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`
/// (their `.pub` halves are fine) and `credentials`/`credentials.<data
/// extension>`.
pub fn is_secret_looking(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    if name == ".env" || name.starts_with(".env.") {
        return !matches!(
            name.as_str(),
            ".env.example" | ".env.sample" | ".env.template" | ".env.dist" | ".env.defaults"
        );
    }
    if let Some(ext) = name.rsplit_once('.').map(|(_, e)| e) {
        if matches!(ext, "pem" | "key" | "p12" | "pfx") {
            return true;
        }
    }
    for key in ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"] {
        if name == key || (name.starts_with(&format!("{key}.")) && !name.ends_with(".pub")) {
            return true;
        }
    }
    if name == "credentials" {
        return true;
    }
    if let Some(ext) = name.strip_prefix("credentials.") {
        return matches!(ext, "json" | "yaml" | "yml" | "toml" | "ini" | "xml" | "csv" | "txt" | "cfg" | "conf" | "env");
    }
    false
}

fn has_glob(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

/// Why a `git add` / `git commit` (argv after `git`) names a secret-looking
/// file explicitly, or `None`. `-f`/`--force` on an `add` is the explicit
/// override: it says the person or model knows the file is special.
pub fn secret_staging_refusal(argv: &[String]) -> Option<String> {
    let mut i = 0;
    while i < argv.len() && argv[i].starts_with('-') {
        i += if matches!(argv[i].as_str(), "-C" | "-c") { 2 } else { 1 };
    }
    let sub = argv.get(i)?.to_ascii_lowercase();
    if sub != "add" {
        return None;
    }
    let rest = &argv[i + 1..];
    let forced = rest.iter().any(|a| {
        a == "--force" || a == "-f" || (a.starts_with('-') && !a.starts_with("--") && a[1..].contains('f'))
    });
    if forced {
        return None;
    }
    let mut dashes = false;
    for a in rest {
        if a == "--" {
            dashes = true;
            continue;
        }
        if (dashes || !a.starts_with('-')) && !has_glob(a) && is_secret_looking(a) {
            return Some(secret_message(a));
        }
    }
    None
}

fn secret_message(path: &str) -> String {
    format!(
        "{path} looks like it holds secrets (.env*, *.pem, id_*, credentials*), so it is not staged. Leave it out of the commit; if it truly belongs in the repository, stage it on purpose with `git add -f -- {path}`"
    )
}

/// Whether `argv` stages many files at once (`add -A`, `add .`, `add -u`,
/// `commit -a`) and which listing says what would be taken: `Some(true)` also
/// lists untracked files, `Some(false)` only modified tracked ones.
pub fn broad_staging(argv: &[String]) -> Option<bool> {
    let mut i = 0;
    while i < argv.len() && argv[i].starts_with('-') {
        i += if matches!(argv[i].as_str(), "-C" | "-c") { 2 } else { 1 };
    }
    let sub = argv.get(i)?.to_ascii_lowercase();
    let rest = &argv[i + 1..];
    let short = |c: char| rest.iter().any(|a| a.starts_with('-') && !a.starts_with("--") && a[1..].contains(c));
    match sub.as_str() {
        "add" => {
            if rest.iter().any(|a| matches!(a.as_str(), "-f" | "--force")) {
                return None;
            }
            let all = rest.iter().any(|a| matches!(a.as_str(), "--all" | "." | ":/" | "-A") || a == "-A");
            let update = rest.iter().any(|a| a == "--update") || short('u');
            if all || short('A') {
                Some(true)
            } else if update {
                Some(false)
            } else {
                None
            }
        }
        "commit" => (rest.iter().any(|a| a == "--all") || short('a')).then_some(false),
        _ => None,
    }
}

/// The first secret-looking name among NUL-separated `git ls-files` output.
pub fn secret_in_listing(listing: &[u8]) -> Option<String> {
    listing
        .split(|b| *b == 0)
        .filter_map(|p| std::str::from_utf8(p).ok())
        .find(|p| is_secret_looking(p))
        .map(secret_message)
}

// ---------------------------------------------------------------------------
// Expansion size cap
// ---------------------------------------------------------------------------

fn expanded_len(text: &str, vars: &HashMap<String, usize>) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut total = 0usize;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' && i + 1 < chars.len() {
            let (name, next) = if chars[i + 1] == '{' {
                match chars[i + 2..].iter().position(|c| *c == '}') {
                    Some(end) => (chars[i + 2..i + 2 + end].iter().collect::<String>(), i + 3 + end),
                    None => (String::new(), i + 1),
                }
            } else {
                let end = chars[i + 1..]
                    .iter()
                    .position(|c| !(c.is_alphanumeric() || *c == '_'))
                    .unwrap_or(chars.len() - i - 1);
                (chars[i + 1..i + 1 + end].iter().collect::<String>(), i + 1 + end)
            };
            if !name.is_empty() {
                total = total.saturating_add(vars.get(&name).copied().unwrap_or(0));
                i = next;
                continue;
            }
        }
        total = total.saturating_add(chars[i].len_utf8());
        i += 1;
    }
    total
}

/// Why a command's variable expansions are too long to run, or `None`.
///
/// Walks `NAME=value` assignments in order, tracking how long each variable's
/// value gets once earlier variables are substituted (`a=$a$a` doubles), and
/// refuses when any value, or any other segment of the line once expanded,
/// passes [`MAX_EXPANDED_BYTES`].
pub fn expansion_refusal(command: &str) -> Option<String> {
    let mut vars: HashMap<String, usize> = HashMap::new();
    let mut worst = 0usize;
    for raw in command.split(['\n', ';']).flat_map(|s| s.split("&&")) {
        let seg = raw.trim();
        let seg = ["export ", "local ", "declare ", "typeset "]
            .iter()
            .find_map(|p| seg.strip_prefix(p))
            .unwrap_or(seg)
            .trim();
        let assignment = seg.split_once('=').and_then(|(name, value)| {
            let (name, append) = match name.strip_suffix('+') {
                Some(n) => (n, true),
                None => (name, false),
            };
            let valid = !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !name.starts_with(|c: char| c.is_ascii_digit());
            valid.then(|| (name.to_string(), value.trim(), append))
        });
        let len = match assignment {
            Some((name, value, append)) => {
                let value = value
                    .strip_prefix(['"', '\''])
                    .map(|v| v.strip_suffix(['"', '\'']).unwrap_or(v))
                    .unwrap_or(value);
                let mut len = expanded_len(value, &vars);
                if append {
                    len = len.saturating_add(vars.get(&name).copied().unwrap_or(0));
                }
                vars.insert(name, len);
                len
            }
            None => expanded_len(seg, &vars),
        };
        worst = worst.max(len);
    }
    (worst > MAX_EXPANDED_BYTES).then(|| {
        format!(
            "refused: this command's variable expansions would build about {} KB of text (the limit is {} KB). Write the data to a file with the `write` tool and pass the file's path instead",
            worst / 1024,
            MAX_EXPANDED_BYTES / 1024
        )
    })
}

// ---------------------------------------------------------------------------
// A command naming a path a deny rule covers
// ---------------------------------------------------------------------------

/// Whether a shell command names a path that a `read`, `edit` or `write` deny
/// rule covers, and which one. The gate matches those rules against file-tool
/// calls; `bash cat secrets/keys.txt` is the same read by another route, so it
/// is put to the person (and refused where nobody can be asked).
pub fn denied_path_named(
    perms: &crate::permissions::ToolPermissions,
    command: &str,
    root: &Path,
    subject: &crate::subject::Subject,
) -> Option<String> {
    for simple in crate::tools::cmdscan::simple_commands(command) {
        let Some(tokens) = crate::tools::git_tool::split_command_line(&simple) else {
            continue;
        };
        for tok in tokens.iter().skip(1) {
            let value = if tok.starts_with('-') {
                match tok.split_once('=') {
                    Some((_, v)) => v,
                    None => continue,
                }
            } else {
                tok.as_str()
            };
            let looks_like_path = value.contains(['/', '\\']) || value.starts_with(['.', '~']) || root.join(value).exists();
            if value.is_empty() || !looks_like_path {
                continue;
            }
            let resource = crate::resource::Resource::path(value, Some(root));
            for tool in ["read", "edit", "write"] {
                if let Some(rule) = perms.denies_call(tool, std::slice::from_ref(&resource), subject) {
                    return Some(format!(
                        "names {value}, which the `{}` rule denies",
                        rule.source()
                    ));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn wt() -> PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn bisect_run_and_maintenance_start_are_refused_with_what_still_works() {
        let why = git_worktree_refusal(&v(&["bisect", "run", "make", "test"]), &wt()).unwrap();
        assert!(why.contains("Still works") && why.contains("bisect start"), "{why}");
        assert!(git_worktree_refusal(&v(&["bisect", "start"]), &wt()).is_none());
        assert!(git_worktree_refusal(&v(&["maintenance", "register"]), &wt()).is_some());
        assert!(git_worktree_refusal(&v(&["maintenance", "start"]), &wt()).is_some());
        assert!(git_worktree_refusal(&v(&["maintenance", "run"]), &wt()).is_none());
    }

    #[test]
    fn shared_branch_rewrites_are_refused_but_own_branches_are_not() {
        for bad in [
            vec!["push", "--force", "origin", "main"],
            vec!["push", "-f"],
            vec!["push", "--force-with-lease"],
            vec!["push", "origin", "+main"],
            vec!["branch", "-D", "main"],
            vec!["branch", "-f", "main", "HEAD"],
            vec!["update-ref", "refs/heads/main", "HEAD"],
        ] {
            assert!(git_worktree_refusal(&v(&bad), &wt()).is_some(), "{bad:?}");
        }
        for ok in [
            vec!["push", "origin", "flint/session-ab12"],
            vec!["push", "-u", "origin", "HEAD"],
            vec!["branch", "-D", "flint/old-task"],
            vec!["branch", "--list"],
            vec!["branch", "feature-x"],
            vec!["update-ref", "refs/heads/flint/x", "HEAD"],
            vec!["reset", "--hard", "HEAD~1"],
            vec!["status"],
        ] {
            assert!(git_worktree_refusal(&v(&ok), &wt()).is_none(), "{ok:?}");
        }
    }

    #[test]
    fn a_mutating_command_aimed_at_the_source_checkout_is_refused() {
        let base = std::env::temp_dir().join("flint-guard-wt");
        let source = std::env::temp_dir().join("flint-guard-source");
        let _ = std::fs::create_dir_all(&base);
        let _ = std::fs::create_dir_all(&source);
        let src = source.to_string_lossy().to_string();
        assert!(git_worktree_refusal(&v(&["-C", &src, "reset", "--hard"]), &base).is_some());
        assert!(git_worktree_refusal(&v(&["-C", &src, "status"]), &base).is_none());
        assert!(git_worktree_refusal(&v(&["-C", ".", "reset", "--hard"]), &base).is_none());
        let _ = std::fs::remove_dir_all(&source);
    }

    #[test]
    fn a_shell_line_is_read_command_by_command() {
        let base = wt();
        assert!(command_worktree_refusal("ls && git push --force origin main", &base).is_some());
        assert!(command_worktree_refusal("timeout 5 git bisect run ./t.sh", &base).is_some());
        assert!(command_worktree_refusal("echo git push --force", &base).is_none());
        assert!(command_worktree_refusal("git status", &base).is_none());
    }

    #[test]
    fn secret_looking_names() {
        for yes in [".env", ".env.local", "app/.env.production", "server.pem", "id_rsa", "~/.ssh/id_ed25519", "credentials", "credentials.json", "tls.key"] {
            assert!(is_secret_looking(yes), "{yes}");
        }
        for no in [".env.example", ".env.sample", "id_rsa.pub", "id_utils.py", "credentials.rs", "credentials_helper.ts", "environment.md", "key.rs", "README.md"] {
            assert!(!is_secret_looking(no), "{no}");
        }
    }

    #[test]
    fn staging_a_secret_is_refused_unless_forced() {
        assert!(secret_staging_refusal(&v(&["add", ".env"])).is_some());
        assert!(secret_staging_refusal(&v(&["add", "--", "keys/server.pem"])).is_some());
        assert!(secret_staging_refusal(&v(&["add", "-f", ".env"])).is_none());
        assert!(secret_staging_refusal(&v(&["add", "src/main.rs", ".env.example"])).is_none());
        assert!(secret_staging_refusal(&v(&["status"])).is_none());
        assert_eq!(broad_staging(&v(&["add", "-A"])), Some(true));
        assert_eq!(broad_staging(&v(&["add", "."])), Some(true));
        assert_eq!(broad_staging(&v(&["add", "-u"])), Some(false));
        assert_eq!(broad_staging(&v(&["commit", "-a", "-m", "x"])), Some(false));
        assert_eq!(broad_staging(&v(&["commit", "-m", "x"])), None);
        assert!(secret_in_listing(b"src/a.rs\0.env\0").unwrap().contains(".env"));
        assert!(secret_in_listing(b"src/a.rs\0").is_none());
    }

    #[test]
    fn doubling_expansions_are_refused_and_ordinary_ones_are_not() {
        let mut bomb = String::from("a=0123456789");
        for _ in 0..14 {
            bomb.push_str("; a=\"$a$a\"");
        }
        bomb.push_str("; echo $a");
        let why = expansion_refusal(&bomb).expect("refused");
        assert!(why.contains("64 KB") && why.contains("write"), "{why}");
        assert!(expansion_refusal("name=world; echo \"hello $name\"").is_none());
        assert!(expansion_refusal("x=$HOME/bin; ls $x").is_none());
        assert!(expansion_refusal(&format!("echo {}", "a".repeat(1000))).is_none());
    }

    #[test]
    fn a_command_naming_a_denied_path_is_found() {
        let root = std::env::temp_dir().join("flint-guard-deny");
        let _ = std::fs::create_dir_all(root.join("secrets"));
        let deny = vec!["read(secrets/**)".to_string()];
        let perms = crate::permissions::ToolPermissions::new(
            crate::permissions::PermissionDefault::Allow,
            &[],
            &deny,
            &[],
        );
        let subject = crate::subject::Subject::MainAgent;
        let why = denied_path_named(&perms, "cat secrets/keys.txt", &root, &subject).expect("found");
        assert!(why.contains("secrets/keys.txt"), "{why}");
        assert!(denied_path_named(&perms, "cat src/main.rs", &root, &subject).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
