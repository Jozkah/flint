//! Destructive shell command detection.
//!
//! A small, deliberately conservative check run before `bash`. A match does
//! not refuse the command: it forces the normal approval prompt even when
//! auto-approval is on, so a person sees `rm -rf ~` before it runs rather than
//! after. False positives cost one click; false negatives are what the OS
//! sandbox and the permission gate are still there for.
//!
//! A command the checker cannot see through -- an unbalanced quote, `eval`,
//! `Invoke-Expression`, a PowerShell `-EncodedCommand`, `xargs rm` fed from
//! input -- is treated the same way: asked about, never silently allowed.
//!
//! The rule data (wrappers, shells, commands that always ask, SQL phrases) and
//! the shared test vectors live in one file,
//! `web-app/src/lib/destructiveCommandRules.json`, which the web app's port
//! (`web-app/src/lib/destructiveCommand.ts`) imports too. Both runtimes run
//! every vector in that file as a parity test, so the two cannot drift
//! without a test failing.

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

/// The canonical rules file, shared with the web app.
const RULES_JSON: &str = include_str!("../../../../web-app/src/lib/destructiveCommandRules.json");

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rules {
    wrappers: Vec<String>,
    wrapper_value_options: HashMap<String, Vec<String>>,
    wrapper_positional: HashMap<String, usize>,
    inline_shells: Vec<String>,
    powershells: Vec<String>,
    /// Interpreters and the options that run code given on the command line.
    inline_interpreters: HashMap<String, Vec<String>>,
    uncertain_commands: HashMap<String, String>,
    always_ask_commands: HashMap<String, String>,
    delete_commands: Vec<String>,
    sql_phrases: Vec<String>,
}

static RULES: LazyLock<Rules> = LazyLock::new(|| {
    serde_json::from_str(RULES_JSON).expect("destructiveCommandRules.json is valid")
});

/// How deep `bash -c "..."`, `cmd /c ...` and `$(...)` may nest before the
/// command is treated as too convoluted to check.
const MAX_DEPTH: usize = 4;

/// Why `command` looks destructive (or cannot be checked), or `None`.
/// `workspace` is the project root: deleting inside it is ordinary work,
/// deleting outside it is not.
pub fn destructive_reason(command: &str, workspace: &Path) -> Option<String> {
    destructive_reason_in(command, &Scope::new([workspace]))
}

/// [`destructive_reason`] against every root of an approved scope (a project
/// and its scratch directory, a chat's workspace, ...).
pub fn destructive_reason_in(command: &str, scope: &Scope) -> Option<String> {
    reason_at_depth(command, scope, 0)
}

/// Why a shell command must be put to the person even when a rule or
/// auto-approval would allow it: it looks destructive, or the static command
/// scan cannot say what it will run (`BASH_ARGV0`, a `for` loop over a glob or
/// expansion, `eval`, `sudo`, `xargs`, ...).
///
/// Kept apart from [`destructive_reason_in`] on purpose: that function is
/// parity-tested against the web app's port, while the scan lives only here.
pub fn forced_prompt_reason(command: &str, scope: &Scope) -> Option<String> {
    destructive_reason_in(command, scope).or_else(|| opaque_reason(command))
}

/// Why the command scan reports `command` as opaque, or `None` when it
/// resolves to a known set of base commands.
pub fn opaque_reason(command: &str) -> Option<String> {
    use tauri_plugin_agent_tools::tools::cmdscan::{scan_command, CommandScan};
    match scan_command(command) {
        CommandScan::Opaque => Some(
            "runs code that cannot be resolved statically (shell indirection, a loop over a glob, eval or a wrapper)"
                .to_string(),
        ),
        CommandScan::Bases(_) => None,
    }
}

/// The folders a command may delete inside without being asked about.
///
/// Each root is resolved once, up front: canonicalised through the filesystem
/// when it exists (so a root reached through a symlink or junction compares
/// by where it really is), lexically normalised otherwise. A root that is not
/// an absolute path, or that normalises to the filesystem root, is dropped:
/// it cannot vouch for anything. An empty scope is the unknown scope, in which
/// every absolute path counts as outside.
#[derive(Debug, Clone, Default)]
pub struct Scope {
    roots: Vec<String>,
    /// Set once an earlier segment changed directory to somewhere not known
    /// to be inside the scope (`cd ~ && rm -rf *`): relative targets no
    /// longer resolve against the workspace, so they count as outside.
    cwd_unknown: bool,
}

impl Scope {
    pub fn new<P: AsRef<Path>>(roots: impl IntoIterator<Item = P>) -> Self {
        let roots = roots
            .into_iter()
            .filter_map(|root| {
                // A root that was canonicalised on Windows arrives verbatim
                // (`\\?\C:\...`); its plain spelling is the same folder.
                let raw = root.as_ref().to_string_lossy();
                let raw = match raw.strip_prefix(r"\\?\UNC\") {
                    Some(rest) => format!(r"\\{rest}"),
                    None => raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string(),
                };
                let raw = raw.replace('\\', "/");
                if !is_absolute_str(&raw) {
                    return None;
                }
                let resolved = resolve_absolute(&raw)?;
                // `/` or a bare drive would make everything "inside".
                (resolved.contains('/') && !resolved.ends_with(':')).then_some(resolved)
            })
            .collect();
        Self {
            roots,
            cwd_unknown: false,
        }
    }

    /// Whether the resolved absolute `path` is one of the roots or under one.
    fn contains(&self, path: &str) -> bool {
        self.roots
            .iter()
            .any(|r| path == r || path.starts_with(&format!("{r}/")))
    }
}

fn reason_at_depth(command: &str, workspace: &Scope, depth: usize) -> Option<String> {
    if depth > MAX_DEPTH {
        return Some("nests shells too deeply to check".to_string());
    }
    // A backslash is an escape in POSIX shells and a path separator on
    // Windows, and the command line does not say which. Read it both ways;
    // either one finding something is enough.
    let readings: &[bool] = if command.contains('\\') {
        &[false, true]
    } else {
        &[false]
    };
    readings
        .iter()
        .find_map(|&posix| reason_for_reading(command, workspace, depth, posix))
}

fn reason_for_reading(
    command: &str,
    workspace: &Scope,
    depth: usize,
    posix_escapes: bool,
) -> Option<String> {
    let parsed = match parse(command, posix_escapes) {
        Ok(parsed) => parsed,
        // The plain reading already parsed this, so a failure only here means
        // a Windows path ending in `\` inside quotes: not a reason to ask.
        Err(_) if posix_escapes => return None,
        Err(why) => {
            return Some(format!(
                "could not be parsed ({why}), so it cannot be checked"
            ))
        }
    };
    for body in &parsed.substitutions {
        if let Some(reason) = reason_at_depth(body, workspace, depth + 1) {
            return Some(reason);
        }
    }
    let mut scope = workspace.clone();
    for segment in &parsed.segments {
        let words = strip_prefixes(&segment.words);
        if words.is_empty() {
            continue;
        }
        if let Some(reason) = check_segment(&words, &scope, depth, segment.piped) {
            return Some(reason);
        }
        if changes_to_unknown_dir(&words, &scope) {
            scope.cwd_unknown = true;
        }
    }
    let lower = command.to_ascii_lowercase();
    RULES
        .sql_phrases
        .iter()
        .find(|p| lower.contains(p.as_str()))
        .map(|p| format!("runs `{}`", p.to_ascii_uppercase()))
}

/// The command name a word invokes: no directory, no `.exe`, lowercase.
fn command_name(word: &str) -> String {
    let lower = word.to_ascii_lowercase();
    let base = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    base.strip_suffix(".exe").unwrap_or(base).to_string()
}

const INLINE_CODE: &str = "runs code given on the command line, which cannot be checked";

/// Whether an interpreter's options (those before the script name) include
/// one that runs code from the command line, as `-c` or `--eval=...`.
fn runs_inline_code(args: &[String], flags: &[String]) -> bool {
    for arg in args {
        if !arg.starts_with('-') {
            return false;
        }
        if flags
            .iter()
            .any(|f| arg == f || arg.starts_with(&format!("{f}=")))
        {
            return true;
        }
    }
    false
}

const READS_INPUT: &str = "runs a script read from input, which cannot be checked";
const PS_UNCHECKABLE: &str = "runs a PowerShell command that cannot be checked";
const PS_VALUE_OPTIONS: &[&str] = &[
    "-executionpolicy",
    "-ep",
    "-windowstyle",
    "-workingdirectory",
    "-wd",
    "-configurationname",
    "-version",
    "-inputformat",
    "-outputformat",
    "-psconsolefile",
];
const PS_SWITCHES: &[&str] = &[
    "-noprofile",
    "-nop",
    "-noexit",
    "-noe",
    "-nologo",
    "-nol",
    "-noninteractive",
    "-noni",
    "-sta",
    "-mta",
];

/// A short-option cluster such as `-fu` that contains `flag`; never `--long`.
fn short_cluster_has(a: &str, flag: char) -> bool {
    a.strip_prefix('-').is_some_and(|body| {
        !body.is_empty() && body.chars().all(|c| c.is_ascii_lowercase()) && body.contains(flag)
    })
}

fn check_segment(
    words: &[String],
    workspace: &Scope,
    depth: usize,
    piped: bool,
) -> Option<String> {
    let cmd = command_name(&words[0]);
    let args = &words[1..];
    let lower_args: Vec<String> = args.iter().map(|a| a.to_ascii_lowercase()).collect();
    let rules = &*RULES;

    if let Some(reason) = rules.uncertain_commands.get(&cmd) {
        return Some(reason.clone());
    }
    if let Some(reason) = rules.always_ask_commands.get(&cmd) {
        return Some(reason.clone());
    }
    if let Some(flags) = rules.inline_interpreters.get(&cmd) {
        if runs_inline_code(args, flags) {
            return Some(INLINE_CODE.into());
        }
    }
    if rules.inline_shells.contains(&cmd) {
        // `bash -c "script"`, `sh -lc '...'`: check the script itself.
        let script = lower_args
            .iter()
            .position(|a| a.starts_with('-') && !a.starts_with("--") && a.contains('c'))
            .and_then(|at| args.get(at + 1));
        return match script {
            Some(script) => reason_at_depth(script, workspace, depth + 1),
            // The script comes from a pipe, here-doc or here-string, or stdin.
            None if piped || lower_args.iter().any(|a| a.starts_with("<<") || a == "-s") => {
                Some(READS_INPUT.into())
            }
            None => None,
        };
    }
    if cmd == "cmd" {
        // `cmd /c <command line>` (or `/k`): check the rest of the line.
        let Some(at) = lower_args.iter().position(|a| a == "/c" || a == "/k") else {
            return piped.then(|| READS_INPUT.to_string());
        };
        return reason_at_depth(&args[at + 1..].join(" "), workspace, depth + 1);
    }
    if rules.powershells.contains(&cmd) {
        if lower_args.iter().any(|a| {
            matches!(
                a.as_str(),
                "-e" | "-ec" | "-en" | "-enc" | "-encodedcommand"
            ) || a.starts_with("-encodedc")
        }) {
            return Some("runs an encoded PowerShell command, which cannot be checked".into());
        }
        if let Some(at) = lower_args
            .iter()
            .position(|a| a == "-c" || a.starts_with("-com"))
        {
            return reason_at_depth(&args[at + 1..].join(" "), workspace, depth + 1);
        }
        if lower_args.iter().any(|a| a.len() >= 2 && "-file".starts_with(a.as_str())) {
            return None;
        }
        // `pwsh -NoProfile "Remove-Item ..."`: the first word that is not an
        // option starts the command, and the rest of the line belongs to it.
        let mut k = 0;
        while k < lower_args.len() {
            let a = lower_args[k].as_str();
            if !a.starts_with('-') {
                return reason_at_depth(&args[k..].join(" "), workspace, depth + 1);
            }
            if PS_VALUE_OPTIONS.contains(&a) {
                k += 1;
            } else if !PS_SWITCHES.contains(&a) {
                return Some(PS_UNCHECKABLE.into());
            }
            k += 1;
        }
        return piped.then(|| READS_INPUT.to_string());
    }

    match cmd.as_str() {
        "rm" | "unlink" | "shred" | "remove-item" | "ri" => {
            // Recursive or not, a target outside the workspace is asked about.
            let (_recursive, targets) = deletion_flags(args, false);
            targets
                .iter()
                .find(|t| outside_workspace(t, workspace))
                .map(|t| format!("`{}` deletes `{t}`, outside the workspace", words.join(" ")))
        }
        "del" | "erase" => {
            if lower_args.iter().any(|a| a == "/s") {
                return Some("`del /s` deletes recursively".into());
            }
            let (_recursive, targets) = deletion_flags(args, true);
            targets
                .iter()
                .find(|t| outside_workspace(t, workspace))
                .map(|t| format!("`{}` deletes `{t}`, outside the workspace", words.join(" ")))
        }
        "rd" | "rmdir" => {
            let slash_s = lower_args.iter().any(|a| a == "/s");
            let (recursive, targets) = deletion_flags(args, true);
            if !(slash_s || recursive) {
                return None;
            }
            let targets: Vec<&String> = targets.iter().collect();
            let default = ".".to_string();
            let targets = if targets.is_empty() {
                vec![&default]
            } else {
                targets
            };
            targets
                .into_iter()
                .find(|t| outside_workspace(t, workspace))
                .map(|t| format!("`{}` deletes `{t}`, outside the workspace", words.join(" ")))
        }
        "xargs" => {
            // The paths come from input the checker never sees.
            let inner = xargs_command(args)?;
            rules
                .delete_commands
                .contains(&command_name(inner))
                .then(|| {
                    format!(
                        "`xargs {}` deletes paths read from input",
                        command_name(inner)
                    )
                })
        }
        "find" => {
            let deletes = lower_args.iter().enumerate().any(|(i, a)| {
                a == "-delete"
                    || (matches!(a.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir")
                        && lower_args
                            .get(i + 1)
                            .is_some_and(|c| rules.delete_commands.contains(&command_name(c))))
            });
            if !deletes {
                return None;
            }
            let starts: Vec<&String> = args
                .iter()
                .take_while(|a| !a.starts_with('-') && *a != "(" && *a != "!")
                .collect();
            let default = ".".to_string();
            let starts = if starts.is_empty() {
                vec![&default]
            } else {
                starts
            };
            starts
                .into_iter()
                .find(|t| outside_workspace(t, workspace))
                .map(|t| {
                    format!(
                        "`{}` deletes under `{t}`, outside the workspace",
                        words.join(" ")
                    )
                })
        }
        "git" => {
            let sub = git_subcommand(&lower_args)?;
            let rest = &lower_args[sub + 1..];
            let has = |f: &str| rest.iter().any(|a| a == f);
            // Original case: `-D`/`-S`/`-W` differ from their lowercase forms.
            let raw = &args[sub + 1..];
            let raw_has = |f: &str| raw.iter().any(|a| a == f);
            match lower_args[sub].as_str() {
                "reset" if has("--hard") => {
                    Some("`git reset --hard` discards uncommitted work".into())
                }
                "clean" => {
                    let short: String = rest
                        .iter()
                        .filter(|a| a.starts_with('-') && !a.starts_with("--"))
                        .map(|a| a.trim_start_matches('-'))
                        .collect();
                    (short.contains('f') || has("--force"))
                        .then(|| "`git clean` deletes untracked files".to_string())
                }
                "checkout"
                    if has("--")
                        || has(".")
                        || has("--force")
                        || rest.iter().any(|a| {
                            short_cluster_has(a, 'f') || a.starts_with("--pathspec-from-file")
                        }) =>
                {
                    Some("`git checkout` of paths discards uncommitted changes".into())
                }
                "restore"
                    if !(raw_has("--staged") || raw_has("-S"))
                        || raw_has("--worktree")
                        || raw_has("-W") =>
                {
                    Some("`git restore` discards uncommitted changes".into())
                }
                "branch"
                    if raw.iter().any(|a| {
                        a.strip_prefix('-').is_some_and(|b| {
                            !b.is_empty()
                                && b.chars().all(|c| c.is_ascii_alphabetic())
                                && b.contains('D')
                        })
                    }) || (has("--delete")
                        && (has("--force") || rest.iter().any(|a| short_cluster_has(a, 'f')))) =>
                {
                    Some("`git branch -D` deletes a branch that may be unmerged".into())
                }
                "stash" if matches!(rest.first().map(String::as_str), Some("drop" | "clear")) => {
                    Some("`git stash drop` discards stashed changes".into())
                }
                "rebase" if !has("--continue") && !has("--abort") && !has("--quit") => {
                    Some("`git rebase` rewrites history".into())
                }
                name @ ("filter-branch" | "filter-repo") => {
                    Some(format!("`git {name}` rewrites history"))
                }
                "push"
                    if has("--force")
                        || rest.iter().any(|a| {
                            short_cluster_has(a, 'f')
                                || a.starts_with("--force-with-lease")
                                || a.starts_with("--mirror")
                                || a.starts_with('+')
                        }) =>
                {
                    Some("`git push --force` rewrites remote history".into())
                }
                "push"
                    if has("--delete")
                        || rest.iter().any(|a| {
                            short_cluster_has(a, 'd') || (a.starts_with(':') && a.len() > 1)
                        }) =>
                {
                    Some("`git push --delete` removes a remote branch".into())
                }
                _ => None,
            }
        }
        c if c == "mkfs" || c.starts_with("mkfs.") => Some("`mkfs` formats a filesystem".into()),
        "dd" if lower_args.iter().any(|a| a.starts_with("of=/dev/")) => {
            Some("`dd` writes to a raw device".into())
        }
        "format" if args.first().is_some_and(|a| is_drive(a)) => {
            Some("`format` erases a drive".into())
        }
        _ => None,
    }
}

/// Whether this segment moves the shell to a directory not known to be inside
/// `scope`: `cd`/`pushd`/`Set-Location` to an outside, home or unresolvable
/// target, a bare `cd` (home), `cd -`, or `popd`.
fn changes_to_unknown_dir(words: &[String], scope: &Scope) -> bool {
    match command_name(&words[0]).as_str() {
        "popd" | "pop-location" => true,
        "cd" | "chdir" | "pushd" | "set-location" | "sl" | "push-location" => {
            let target = words[1..]
                .iter()
                .rfind(|a| !a.starts_with('-') && !is_cmd_switch(a));
            match target {
                None => true,
                Some(t) => {
                    let t = t.trim_matches(['"', '\'']);
                    t.is_empty() || t == "-" || outside_workspace(t, scope)
                }
            }
        }
        _ => false,
    }
}

/// Whether a deletion is recursive, and its targets. Understands POSIX short
/// and long flags (`-rf`, `--recursive`) and PowerShell parameters
/// (`-Recurse`, `-Force`, `-Path x`).
fn deletion_flags(args: &[String], cmd_switches: bool) -> (bool, Vec<String>) {
    let mut recursive = false;
    let mut targets = Vec::new();
    for a in args {
        let lower = a.to_ascii_lowercase();
        if lower == "--recursive" {
            recursive = true;
        } else if lower.starts_with("--") || (cmd_switches && is_cmd_switch(a)) {
            // Other long options, and cmd switches like `/q`.
        } else if let Some(body) = a.strip_prefix('-') {
            if !body.is_empty() && body.chars().all(|c| "rRfivdI".contains(c)) {
                recursive |= body.contains(['r', 'R']);
            } else {
                // A PowerShell parameter: `-Recurse`, `-Force`, `-Path`, ...
                recursive |= lower.starts_with("-rec");
            }
        } else {
            targets.push(a.clone());
        }
    }
    (recursive, targets)
}

/// A cmd.exe switch such as `/s` or `/q` -- not a path like `/*` or `/x/y`.
fn is_cmd_switch(a: &str) -> bool {
    let b = a.as_bytes();
    b.len() == 2 && b[0] == b'/' && b[1].is_ascii_alphabetic()
}

/// Index of git's subcommand, skipping global options (`-C dir`, `-c k=v`).
fn git_subcommand(lower_args: &[String]) -> Option<usize> {
    let mut i = 0;
    while i < lower_args.len() {
        let a = lower_args[i].as_str();
        // Lowercased already, so `-c` also covers `-C <dir>`.
        if matches!(a, "-c" | "--git-dir" | "--work-tree" | "--namespace") {
            i += 2;
        } else if a.starts_with('-') {
            i += 1;
        } else {
            return Some(i);
        }
    }
    None
}

/// The command `xargs` will run, skipping its own options.
fn xargs_command(args: &[String]) -> Option<&String> {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if matches!(a, "-I" | "-n" | "-P" | "-L" | "-d" | "-E" | "-s" | "-a") {
            i += 2;
        } else if a.starts_with('-') {
            i += 1;
        } else {
            return Some(&args[i]);
        }
    }
    None
}

fn is_drive(a: &str) -> bool {
    let b = a.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Whether `s` starts with a drive letter and a colon (`C:`). Byte-based, so
/// a multibyte character after the first byte cannot split a str slice.
fn drive_prefix(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Whether a `/`-separated path is absolute: `/...` (POSIX, UNC as `//`) or a
/// drive with a separator (`C:/...`), on every host, so the shared vectors give
/// the same verdicts on Windows and POSIX.
fn is_absolute_str(path: &str) -> bool {
    path.starts_with('/') || (drive_prefix(path) && path.as_bytes().get(2) == Some(&b'/'))
}

/// A resolved path in the one form roots and targets are compared in: `/`
/// separators, no verbatim (`\\?\`) prefix, no trailing separator, and
/// case-folded where the filesystem is case-insensitive (Windows, or any
/// drive-letter path).
fn comparable(path: &str) -> String {
    let path = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!("//{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    };
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    if cfg!(windows) || drive_prefix(path) {
        path.to_ascii_lowercase()
    } else {
        path.to_string()
    }
}

/// Append `rest` to an already-resolved `base`. `.` and empty components are
/// dropped; `..` in a part that could not be resolved through the filesystem
/// is refused (`None`), because whether it climbs out depends on symlinks that
/// cannot be seen.
fn join_rest(mut base: String, rest: &[&str]) -> Option<String> {
    for part in rest {
        match *part {
            "" | "." => continue,
            ".." => return None,
            name => {
                base.push('/');
                base.push_str(name);
            }
        }
    }
    Some(comparable(&base))
}

/// Resolve an absolute `/`-separated path for comparison. The longest prefix
/// that exists is canonicalised through the filesystem -- following symlinks
/// and junctions, and applying `..` the way the OS will -- and the remainder,
/// which does not exist yet, is appended lexically. `None` when the path
/// cannot be resolved without guessing (a `..` below the part that exists).
fn resolve_absolute(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    if Path::new(path).is_absolute() {
        for i in (1..=parts.len()).rev() {
            // A wildcard component names no one file, so nothing at or below
            // it can be looked up.
            if parts[..i].iter().any(|p| p.contains(['*', '?', '['])) {
                continue;
            }
            let prefix = parts[..i].join("/");
            let prefix = if prefix.is_empty() {
                "/".to_string()
            } else {
                prefix
            };
            if let Ok(canonical) = std::fs::canonicalize(&prefix) {
                return join_rest(comparable(&canonical.to_string_lossy()), &parts[i..]);
            }
        }
    }
    // Nothing exists (or this host does not treat the path as absolute, such
    // as a drive path on POSIX): lexical only.
    if parts.first().is_some_and(|p| is_drive(p)) {
        join_rest(parts[0].to_string(), &parts[1..])
    } else {
        join_rest(String::new(), &parts)
    }
}

/// A deletion target that reaches beyond the approved scope: the filesystem
/// root, home, a parent directory, a variable or substitution we cannot
/// resolve, a drive-relative path, or an absolute path that -- resolved and
/// canonicalised -- is not under any root of `scope`.
fn outside_workspace(target: &str, scope: &Scope) -> bool {
    let t = target.trim_matches(['"', '\'']);
    if t.is_empty() {
        return false;
    }
    if t.starts_with('~') || t.starts_with('$') || t.starts_with('%') || t.starts_with('`') {
        return true;
    }
    // A variable, substitution or brace expansion anywhere in the path.
    if t.contains(['$', '%', '`', '{']) {
        return true;
    }
    let norm = t.replace('\\', "/");
    // `C:foo` is relative to that drive's current directory, which is unknown.
    if drive_prefix(&norm) && !is_absolute_str(&norm) {
        return true;
    }
    if !is_absolute_str(&norm) {
        return scope.cwd_unknown
            || norm == ".."
            || norm.starts_with("../")
            || norm.contains("/../")
            || norm.ends_with("/..");
    }
    let trimmed = norm.trim_end_matches(['/', '*']);
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    match resolve_absolute(trimmed) {
        Some(resolved) => !scope.contains(&resolved),
        None => true,
    }
}

/// One simple command; `piped` when a single `|` fed it.
#[derive(Debug)]
struct Seg {
    words: Vec<String>,
    piped: bool,
}

/// A command line split into simple commands, plus the bodies of any command
/// substitutions (`$(...)`, `` `...` ``, `<(...)`), which are checked too.
#[derive(Debug, Default)]
struct Parsed {
    segments: Vec<Seg>,
    substitutions: Vec<String>,
}

/// Split a command line into simple commands on `;`, `&`, `&&`, `||`, `|`
/// and newlines -- the separators of POSIX shells, PowerShell and cmd.exe --
/// then into words. Quotes group words and are removed. Not a full shell
/// parser, only enough to find each command and its arguments; an unclosed
/// quote or substitution is an error, so the caller asks rather than guesses.
fn parse(command: &str, posix_escapes: bool) -> Result<Parsed, &'static str> {
    let mut out = Parsed::default();
    let mut pending_pipe = false;
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // POSIX reading: `\x` makes `x` literal, so `\"` neither opens a
        // quote nor hides what follows. A backslash before anything else
        // stays literal (a Windows path). Both readings are checked.
        if posix_escapes
            && c == '\\'
            && quote != Some('\'')
            && chars
                .get(i + 1)
                .is_some_and(|n| "\"' ;|&`$\\".contains(*n))
        {
            cur.push(chars[i + 1]);
            i += 2;
            continue;
        }
        // Substitutions run even inside double quotes, never inside single.
        if quote != Some('\'') {
            let opens_paren = (c == '$' || (quote.is_none() && (c == '<' || c == '>')))
                && chars.get(i + 1) == Some(&'(');
            if opens_paren {
                let mut depth = 1;
                let mut j = i + 2;
                while j < chars.len() && depth > 0 {
                    match chars[j] {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        _ => {}
                    }
                    j += 1;
                }
                if depth > 0 {
                    return Err("unclosed `$(`");
                }
                out.substitutions.push(chars[i + 2..j - 1].iter().collect());
                cur.extend(&chars[i..j]);
                i = j;
                continue;
            }
            if c == '`' {
                if let Some(end) = chars[i + 1..].iter().position(|&x| x == '`') {
                    let end = i + 1 + end;
                    out.substitutions.push(chars[i + 1..end].iter().collect());
                    cur.extend(&chars[i..=end]);
                    i = end + 1;
                    continue;
                }
                // A lone backtick: PowerShell's escape character. Literal.
            }
        }
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None => match c {
                '"' | '\'' => quote = Some(c),
                ' ' | '\t' | '\r' => {
                    if !cur.is_empty() {
                        words.push(std::mem::take(&mut cur));
                    }
                }
                ';' | '\n' | '|' | '&' => {
                    if !cur.is_empty() {
                        words.push(std::mem::take(&mut cur));
                    }
                    let is_pipe = c == '|' && chars.get(i + 1) != Some(&'|');
                    if (c == '|' || c == '&') && chars.get(i + 1) == Some(&c) {
                        i += 1;
                    }
                    if !words.is_empty() {
                        out.segments.push(Seg {
                            words: std::mem::take(&mut words),
                            piped: pending_pipe,
                        });
                        pending_pipe = is_pipe;
                    } else {
                        pending_pipe |= is_pipe;
                    }
                }
                _ => cur.push(c),
            },
        }
        i += 1;
    }
    if quote.is_some() {
        return Err("unbalanced quote");
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    if !words.is_empty() {
        out.segments.push(Seg {
            words,
            piped: pending_pipe,
        });
    }
    Ok(out)
}

/// Drop `sudo`, `env`, `VAR=value` and similar wrappers so the real command
/// is first.
fn strip_prefixes(words: &[String]) -> Vec<String> {
    let rules = &*RULES;
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        let is_assignment = w.contains('=') && !w.starts_with('-') && !w.starts_with('=');
        if is_assignment {
            i += 1;
            continue;
        }
        if !rules.wrappers.iter().any(|x| x == w) {
            break;
        }
        i += 1;
        // Options, and the value of those that take one as a separate word
        // (`sudo -u root`, `nice -n 10`). `-u=x` and `-ux` are one word.
        let value_options = rules.wrapper_value_options.get(w);
        while i < words.len() && words[i].starts_with('-') && words[i] != "-" {
            let takes_value = value_options.is_some_and(|v| v.iter().any(|o| o == &words[i]));
            i += if takes_value { 2 } else { 1 };
        }
        i += rules.wrapper_positional.get(w).copied().unwrap_or(0);
    }
    words[i.min(words.len())..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        command: String,
        workspace: String,
        expect: String,
    }

    #[derive(serde::Deserialize)]
    struct Vectors {
        cases: Vec<Case>,
    }

    /// Every vector in the shared rules file gives the verdict it lists. The
    /// web app runs the same list (`destructiveCommand.test.ts`), which is
    /// what keeps the two implementations in step.
    #[test]
    fn every_shared_vector_gives_its_expected_verdict() {
        let vectors: Vectors = serde_json::from_str(RULES_JSON).unwrap();
        assert!(vectors.cases.len() > 40, "the shared vectors went missing");
        let mut wrong = Vec::new();
        for case in &vectors.cases {
            let got = destructive_reason(&case.command, Path::new(&case.workspace));
            let asked = if got.is_some() { "ask" } else { "allow" };
            if asked != case.expect {
                wrong.push(format!(
                    "{:?} -> {asked} ({got:?}), expected {}",
                    case.command, case.expect
                ));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn non_ascii_delete_target_does_not_panic() {
        let ws = Path::new("/home/me/project");
        for cmd in ["rm -rf é", "rm -rf aé", "rm -rf 中", "Remove-Item -Recurse 中"] {
            assert!(destructive_reason(cmd, ws).is_none(), "{cmd}");
        }
    }

    #[test]
    fn rm_of_file_outside_workspace_asks() {
        let ws = Path::new("/home/me/project");
        for cmd in [
            "rm ~/.ssh/id_ed25519",
            "rm /etc/hosts",
            r"del %APPDATA%\x",
            r"Remove-Item C:\Users\me\a.txt",
        ] {
            assert!(destructive_reason(cmd, ws).is_some(), "{cmd}");
        }
    }

    #[test]
    fn rm_relative_inside_workspace_still_allowed() {
        let ws = Path::new("/home/me/project");
        for cmd in ["rm notes.txt", "rm src/a.txt", "del file.txt"] {
            assert!(destructive_reason(cmd, ws).is_none(), "{cmd}");
        }
    }

    #[test]
    fn the_rules_file_parses() {
        assert!(RULES.wrappers.iter().any(|w| w == "sudo"));
        assert!(RULES.delete_commands.iter().any(|w| w == "rm"));
    }

    #[test]
    fn a_reason_names_what_was_found() {
        let ws = Path::new("/home/me/project");
        let why = destructive_reason("cd x && rm -rf ~/work", ws).unwrap();
        assert!(why.contains("~/work"), "{why}");
        let why = destructive_reason("echo 'oops", ws).unwrap();
        assert!(why.contains("unbalanced quote"), "{why}");
        let why = destructive_reason("pwsh -enc AAAA", ws).unwrap();
        assert!(why.contains("encoded"), "{why}");
    }

    /// A `cd` out of the workspace makes later relative targets outside.
    #[test]
    fn changing_directory_out_of_the_workspace_is_tracked() {
        let ws = Path::new("/home/me/project");
        for cmd in [
            "cd ~ && rm -rf *",
            "cd / ; rm -rf ./*",
            "cd .. && rm -rf proj",
            "cd && rm -rf build",
            "cd - && rm -rf build",
            "pushd /etc && rm -rf conf",
            "cd $HOME; rm -r -f stuff",
            r"Set-Location C:\; Remove-Item -Recurse *",
            r"cd /d C:\ && rd /s /q stuff",
            "cd sub && popd && rm -rf build",
        ] {
            assert!(destructive_reason(cmd, ws).is_some(), "{cmd}");
        }
        for cmd in ["cd src && rm -rf build", "cd ./a/b; rm -rf node_modules"] {
            assert!(destructive_reason(cmd, ws).is_none(), "{cmd}");
        }
    }

    #[test]
    fn deeply_nested_shells_are_asked_about() {
        let ws = Path::new("/home/me/project");
        let mut cmd = "ls".to_string();
        for _ in 0..8 {
            cmd = format!("echo $({cmd})");
        }
        assert!(destructive_reason(&cmd, ws).is_some());
    }

    fn temp_tree(tag: &str) -> std::path::PathBuf {
        let base =
            std::env::temp_dir().join(format!("jan destructive {tag} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("proj dir").join("sub")).unwrap();
        std::fs::create_dir_all(base.join("proj dir-other").join("sub")).unwrap();
        std::fs::create_dir_all(base.join("outside")).unwrap();
        base
    }

    fn rm(path: &std::path::Path) -> String {
        format!("rm -rf \"{}\"", path.to_string_lossy())
    }

    /// Absolute paths inside any root are inside, with spaces, either
    /// separator, a trailing separator or glob, and `..` that stays inside.
    #[test]
    fn absolute_paths_inside_the_scope_are_allowed() {
        let base = temp_tree("inside");
        let proj = base.join("proj dir");
        let scratch = base.join("outside");
        let scope = Scope::new([&proj, &scratch]);
        let p = proj.to_string_lossy().to_string();
        for target in [
            proj.join("sub").to_string_lossy().to_string(),
            format!("{p}/sub/"),
            format!("{p}/sub/*"),
            format!("{p}/sub/../sub/new-file"),
            format!("{p}/not-yet-created/deeper"),
            p.replace('\\', "/"),
            // The second root counts as much as the first.
            scratch.join("tmp").to_string_lossy().to_string(),
        ] {
            let cmd = format!("rm -rf \"{target}\"");
            assert_eq!(destructive_reason_in(&cmd, &scope), None, "{cmd}");
        }
        if cfg!(windows) {
            // Mixed separators and case.
            let mixed = format!("{}\\sub/x", p.to_uppercase());
            assert_eq!(
                destructive_reason_in(&format!("rm -rf \"{mixed}\""), &scope),
                None
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Outside, unknown, ambiguous and escaping targets are still asked about.
    #[test]
    fn outside_unknown_and_ambiguous_targets_still_ask() {
        let base = temp_tree("outside");
        let proj = base.join("proj dir");
        let scope = Scope::new([&proj]);
        let p = proj.to_string_lossy().to_string();
        for target in [
            // A sibling whose name starts with the root's.
            base.join("proj dir-other")
                .join("sub")
                .to_string_lossy()
                .to_string(),
            // Traversal out of the root, existing and not.
            format!("{p}/../outside"),
            format!("{p}/missing/../../outside"),
            format!("{p}/sub/../../proj dir-other"),
            base.to_string_lossy().to_string(),
            "/".to_string(),
            "~/x".to_string(),
            "$HOME/x".to_string(),
            "../x".to_string(),
        ] {
            let cmd = format!("rm -rf \"{target}\"");
            assert!(destructive_reason_in(&cmd, &scope).is_some(), "{cmd}");
        }
        // Unknown scope: every absolute path is outside.
        assert!(destructive_reason_in(&rm(&proj.join("sub")), &Scope::default()).is_some());
        // A relative or root-level "root" vouches for nothing.
        assert!(destructive_reason_in(&rm(&proj.join("sub")), &Scope::new(["proj"])).is_some());
        assert!(destructive_reason_in("rm -rf /etc", &Scope::new(["/"])).is_some());
        // Unparseable commands are asked about whatever the scope.
        assert!(destructive_reason_in(&format!("rm -rf \"{p}/sub"), &scope).is_some());
        if cfg!(windows) {
            // Drive-relative: its base directory is unknown.
            assert!(destructive_reason_in("rm -rf C:sub", &scope).is_some());
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A link inside the root that points outside is resolved before the
    /// comparison, so deleting through it is asked about.
    #[test]
    fn a_link_escaping_the_root_is_outside() {
        let base = temp_tree("link");
        let proj = base.join("proj dir");
        let link = proj.join("escape");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(base.join("outside"), &link).is_ok();
        #[cfg(windows)]
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(base.join("outside"))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !made {
            eprintln!("skipping: could not create a link on this machine");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        let scope = Scope::new([&proj]);
        assert!(destructive_reason_in(&rm(&link.join("data")), &scope).is_some());
        assert!(destructive_reason_in(&rm(&link), &scope).is_some());
        // And a root reached through a link is compared by where it really is.
        let via_link = Scope::new([&link]);
        assert_eq!(
            destructive_reason_in(&rm(&base.join("outside").join("x")), &via_link),
            None
        );
        #[cfg(windows)]
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A verbatim Windows root (as `canonicalize` returns it) is the same
    /// folder as its plain spelling.
    #[cfg(windows)]
    #[test]
    fn a_verbatim_root_matches_its_plain_spelling() {
        let base = temp_tree("verbatim");
        let proj = base.join("proj dir");
        let canonical = std::fs::canonicalize(&proj).unwrap();
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        let scope = Scope::new([&canonical]);
        assert_eq!(destructive_reason_in(&rm(&proj.join("sub")), &scope), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn opaque_commands_force_a_prompt_and_ordinary_ones_do_not() {
        let scope = Scope::new([std::env::temp_dir()]);
        for cmd in [
            "BASH_ARGV0=ls rm x",
            "echo $BASH_ARGV0",
            "for f in *.txt; do cat $f; done",
            "for f in $FILES; do echo $f; done",
            "eval \"$CMD\"",
        ] {
            assert!(forced_prompt_reason(cmd, &scope).is_some(), "{cmd}");
        }
        for cmd in [
            "ls",
            "ls -la src",
            "git status",
            "git log --oneline -5",
            "cat README.md",
            "echo hello",
            "for f in a.txt b.txt; do cat $f; done",
            "cargo test -p foo && echo ok",
        ] {
            assert_eq!(forced_prompt_reason(cmd, &scope), None, "{cmd}");
        }
    }
}
