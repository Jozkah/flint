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
    inline_shells: Vec<String>,
    powershells: Vec<String>,
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
    reason_at_depth(command, workspace, 0)
}

fn reason_at_depth(command: &str, workspace: &Path, depth: usize) -> Option<String> {
    if depth > MAX_DEPTH {
        return Some("nests shells too deeply to check".to_string());
    }
    let parsed = match parse(command) {
        Ok(parsed) => parsed,
        Err(why) => return Some(format!("could not be parsed ({why}), so it cannot be checked")),
    };
    for body in &parsed.substitutions {
        if let Some(reason) = reason_at_depth(body, workspace, depth + 1) {
            return Some(reason);
        }
    }
    for segment in &parsed.segments {
        let words = strip_prefixes(segment);
        if words.is_empty() {
            continue;
        }
        if let Some(reason) = check_segment(&words, workspace, depth) {
            return Some(reason);
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

fn check_segment(words: &[String], workspace: &Path, depth: usize) -> Option<String> {
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
    if rules.inline_shells.contains(&cmd) {
        // `bash -c "script"`, `sh -lc '...'`: check the script itself.
        let at = lower_args
            .iter()
            .position(|a| a.starts_with('-') && !a.starts_with("--") && a.contains('c'))?;
        let script = args.get(at + 1)?;
        return reason_at_depth(script, workspace, depth + 1);
    }
    if cmd == "cmd" {
        // `cmd /c <command line>` (or `/k`): check the rest of the line.
        let at = lower_args.iter().position(|a| a == "/c" || a == "/k")?;
        return reason_at_depth(&args[at + 1..].join(" "), workspace, depth + 1);
    }
    if rules.powershells.contains(&cmd) {
        if lower_args.iter().any(|a| {
            matches!(a.as_str(), "-e" | "-ec" | "-en" | "-enc" | "-encodedcommand")
                || a.starts_with("-encodedc")
        }) {
            return Some("runs an encoded PowerShell command, which cannot be checked".into());
        }
        let at = lower_args.iter().position(|a| a == "-c" || a.starts_with("-com"))?;
        return reason_at_depth(&args[at + 1..].join(" "), workspace, depth + 1);
    }

    match cmd.as_str() {
        "rm" | "unlink" | "shred" | "remove-item" | "ri" => {
            let (recursive, targets) = deletion_flags(args, false);
            let reach = recursive || cmd == "shred";
            if reach {
                if let Some(t) = targets.iter().find(|t| outside_workspace(t, workspace)) {
                    return Some(format!("`{}` deletes `{t}`, outside the workspace", words.join(" ")));
                }
            }
            None
        }
        "del" | "erase" => {
            if lower_args.iter().any(|a| a == "/s") {
                return Some("`del /s` deletes recursively".into());
            }
            let (recursive, targets) = deletion_flags(args, true);
            recursive
                .then(|| targets.iter().find(|t| outside_workspace(t, workspace)))
                .flatten()
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
            let targets = if targets.is_empty() { vec![&default] } else { targets };
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
                .then(|| format!("`xargs {}` deletes paths read from input", command_name(inner)))
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
            let starts = if starts.is_empty() { vec![&default] } else { starts };
            starts
                .into_iter()
                .find(|t| outside_workspace(t, workspace))
                .map(|t| format!("`{}` deletes under `{t}`, outside the workspace", words.join(" ")))
        }
        "git" => {
            let sub = git_subcommand(&lower_args)?;
            let rest = &lower_args[sub + 1..];
            let has = |f: &str| rest.iter().any(|a| a == f);
            match lower_args[sub].as_str() {
                "reset" if has("--hard") => Some("`git reset --hard` discards uncommitted work".into()),
                "clean" => {
                    let short: String = rest
                        .iter()
                        .filter(|a| a.starts_with('-') && !a.starts_with("--"))
                        .map(|a| a.trim_start_matches('-'))
                        .collect();
                    let force = short.contains('f') || has("--force");
                    let dirs = short.contains('d');
                    let ignored = short.contains('x');
                    (force && (dirs || ignored)).then(|| "`git clean` deletes untracked files".to_string())
                }
                "push"
                    if has("--force")
                        || has("-f")
                        || rest.iter().any(|a| {
                            a.starts_with("--force-with-lease") || a.starts_with("--mirror") || a.starts_with('+')
                        }) =>
                {
                    Some("`git push --force` rewrites remote history".into())
                }
                _ => None,
            }
        }
        c if c == "mkfs" || c.starts_with("mkfs.") => Some("`mkfs` formats a filesystem".into()),
        "dd" if lower_args.iter().any(|a| a.starts_with("of=/dev/")) => Some("`dd` writes to a raw device".into()),
        "format" if args.first().is_some_and(|a| is_drive(a)) => Some("`format` erases a drive".into()),
        _ => None,
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

/// A deletion target that reaches beyond the project: the filesystem root,
/// home, a parent directory, a variable or substitution we cannot resolve, or
/// an absolute path not under `workspace`.
fn outside_workspace(target: &str, workspace: &Path) -> bool {
    let t = target.trim_matches(['"', '\'']);
    if t.is_empty() {
        return false;
    }
    if t.starts_with('~') || t.starts_with('$') || t.starts_with('%') || t.starts_with('`') {
        return true;
    }
    let norm = t.replace('\\', "/");
    if norm == ".." || norm.starts_with("../") || norm.contains("/../") || norm.ends_with("/..") {
        return true;
    }
    let absolute = norm.starts_with('/') || (norm.len() >= 2 && is_drive(&norm[..2]));
    if !absolute {
        return false;
    }
    let root = workspace.to_string_lossy().replace('\\', "/");
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return true;
    }
    let (n, r) = if cfg!(windows) || is_drive(&norm[..2.min(norm.len())]) || is_drive(&root[..2.min(root.len())]) {
        (norm.to_ascii_lowercase(), root.to_ascii_lowercase())
    } else {
        (norm.clone(), root.to_string())
    };
    let n = n.trim_end_matches(['/', '*']).to_string();
    !(n == r || n.starts_with(&format!("{r}/")))
}

/// A command line split into simple commands, plus the bodies of any command
/// substitutions (`$(...)`, `` `...` ``, `<(...)`), which are checked too.
#[derive(Debug, Default)]
struct Parsed {
    segments: Vec<Vec<String>>,
    substitutions: Vec<String>,
}

/// Split a command line into simple commands on `;`, `&`, `&&`, `||`, `|`
/// and newlines -- the separators of POSIX shells, PowerShell and cmd.exe --
/// then into words. Quotes group words and are removed. Not a full shell
/// parser, only enough to find each command and its arguments; an unclosed
/// quote or substitution is an error, so the caller asks rather than guesses.
fn parse(command: &str) -> Result<Parsed, &'static str> {
    let mut out = Parsed::default();
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
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
                    if (c == '|' || c == '&') && chars.get(i + 1) == Some(&c) {
                        i += 1;
                    }
                    if !words.is_empty() {
                        out.segments.push(std::mem::take(&mut words));
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
        out.segments.push(words);
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
        if rules.wrappers.iter().any(|x| x == w) || is_assignment {
            i += 1;
            continue;
        }
        if w.starts_with('-') && i > 0 && rules.wrappers.iter().any(|x| x == &words[i - 1]) {
            i += 1;
            continue;
        }
        break;
    }
    words[i..].to_vec()
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
                wrong.push(format!("{:?} -> {asked} ({got:?}), expected {}", case.command, case.expect));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
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

    #[test]
    fn deeply_nested_shells_are_asked_about() {
        let ws = Path::new("/home/me/project");
        let mut cmd = "ls".to_string();
        for _ in 0..8 {
            cmd = format!("echo $({cmd})");
        }
        assert!(destructive_reason(&cmd, ws).is_some());
    }
}
