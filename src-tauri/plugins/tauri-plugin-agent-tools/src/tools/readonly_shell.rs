//! A built-in allowlist of shell commands that only look at things, so Ask
//! mode does not prompt for `ls`, `cat src/main.rs` or `git status`.
//!
//! This is a narrowing of what the permission gate asks about, not a way around
//! it: the gate has already applied deny rules, `ask` rules, the hidden `.jan`
//! and `.git` checks and the secret-file guard by the time a command reaches
//! this check, and an allowed command still runs through the same sandbox and
//! confinement as any other.
//!
//! The parser is deliberately small and strict. It understands only quotes,
//! `|`, `&&`, `||` and `;`, and answers "read-only" only when every segment is a
//! known program with only known flags and project-relative path arguments.
//! Anything else -- a redirection, a substitution or variable (`$`, backtick),
//! a background `&`, a subshell, a program or flag that is not listed, a path
//! that leaves the project or names a credential file, a recursive content
//! search -- is "not known to be read-only", and the caller asks as before.
//! When unsure, it says no.

use crate::tools::proc::ShellFlavor;

/// Longest command considered. A long line is more to get wrong.
const MAX_LEN: usize = 2_000;

/// Whether `command` is made only of known read-only invocations.
pub fn is_read_only(command: &str, flavor: ShellFlavor) -> bool {
    if command.len() > MAX_LEN || command.trim().is_empty() {
        return false;
    }
    let Some(segments) = split(command, flavor) else {
        return false;
    };
    let last = segments.len() - 1;
    let mut any = false;
    for (i, words) in segments.iter().enumerate() {
        if words.is_empty() {
            // `ls;` ends in an empty segment; `ls;;ls` or a leading `;` do not.
            if i == last && any {
                continue;
            }
            return false;
        }
        if !segment_is_read_only(words) {
            return false;
        }
        any = true;
    }
    any
}

/// The words of each `|`/`&&`/`||`/`;` segment, quotes removed, or `None` when
/// the line holds anything this parser will not reason about.
#[allow(unused_assignments)]
fn split(command: &str, flavor: ShellFlavor) -> Option<Vec<Vec<String>>> {
    if flavor == ShellFlavor::Cmd {
        // cmd reads quotes, `%VAR%`, `^` and `&` its own way.
        return None;
    }
    let chars: Vec<char> = command.chars().collect();
    let mut segments: Vec<Vec<String>> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    // Set by `|`, `&&` and `||`, which need a command on their right.
    let mut pending_operator = false;
    let mut i = 0;

    macro_rules! end_word {
        () => {
            if in_word {
                words.push(std::mem::take(&mut word));
                in_word = false;
                pending_operator = false;
            }
        };
    }

    while i < chars.len() {
        let c = chars[i];
        // ASCII only: typographic quotes and look-alike characters are read
        // differently by PowerShell and by POSIX shells.
        if !c.is_ascii() || (c.is_ascii_control() && c != '\t') {
            return None;
        }
        match c {
            '\'' => {
                in_word = true;
                i += 1;
                loop {
                    let q = *chars.get(i)?;
                    i += 1;
                    if q == '\'' {
                        break;
                    }
                    word.push(q);
                }
                continue;
            }
            '"' => {
                in_word = true;
                i += 1;
                loop {
                    let q = *chars.get(i)?;
                    i += 1;
                    match q {
                        '"' => break,
                        // Expansion and escapes inside double quotes.
                        '$' | '`' | '\\' => return None,
                        _ => word.push(q),
                    }
                }
                continue;
            }
            ' ' | '\t' => end_word!(),
            ';' => {
                end_word!();
                segments.push(std::mem::take(&mut words));
            }
            '|' => {
                end_word!();
                segments.push(std::mem::take(&mut words));
                pending_operator = true;
                if chars.get(i + 1) == Some(&'|') {
                    i += 1;
                }
            }
            '&' => {
                // `&&` chains; a lone `&` backgrounds or (PowerShell) calls.
                if chars.get(i + 1) != Some(&'&') {
                    return None;
                }
                end_word!();
                segments.push(std::mem::take(&mut words));
                pending_operator = true;
                i += 1;
            }
            // Redirection, substitution, variables, subshells, blocks.
            '>' | '<' | '`' | '$' | '(' | ')' | '{' | '}' => return None,
            // Home expansion at the start of a word.
            '~' if !in_word => return None,
            // cmd-only metacharacters would have returned above; in the other
            // shells these are ordinary characters.
            '\\' => {
                // A backslash is a path separator for PowerShell and an
                // escape for POSIX shells. Accept it only where both read it
                // as a plain character.
                match chars.get(i + 1) {
                    Some(n) if n.is_ascii_alphanumeric() || matches!(n, '.' | '_' | '-') => {
                        in_word = true;
                        word.push('\\');
                    }
                    _ => return None,
                }
            }
            '#' if !in_word => return None,
            _ => {
                in_word = true;
                word.push(c);
            }
        }
        i += 1;
    }
    end_word!();
    if pending_operator {
        return None;
    }
    segments.push(words);
    Some(segments)
}

fn segment_is_read_only(words: &[String]) -> bool {
    let program = words[0].as_str();
    let args = &words[1..];
    match program {
        "ls" => ls(args),
        "cat" => cat(args),
        "head" => head_tail(args, false),
        "tail" => head_tail(args, true),
        "wc" => wc(args),
        "grep" => grep(args),
        "find" => find(args),
        "pwd" => args.iter().all(|a| a == "-L" || a == "-P"),
        "echo" => true,
        "git" => git(args),
        _ => false,
    }
}

/// Whether a path argument stays inside the project and names no credential:
/// no absolute path, drive, UNC, home or `..`, and no component (or `rev:path`
/// tail) that is a known secret file.
fn path_ok(arg: &str) -> bool {
    path_ok_inner(arg, false)
}

/// `allow_tilde` lets a git revision such as `HEAD~1` through; every other
/// word with a `~` could be a Windows 8.3 short name (`ENV~1`) or home form.
fn path_ok_inner(arg: &str, allow_tilde: bool) -> bool {
    if arg.starts_with(['/', '\\', '~']) {
        return false;
    }
    // Glob and brace characters expand to names the secret-file check below
    // never sees (`.env*`, `id_r*`), so the word must be fully literal.
    if arg.contains(['*', '?', '[', ']', '{', '}']) {
        return false;
    }
    if arg.contains('~') && !(allow_tilde && !arg.contains(['/', '\\', ':'])) {
        return false;
    }
    let bytes = arg.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    arg.split(':')
        .flat_map(|part| part.split(['/', '\\']))
        .all(|c| c != ".." && !crate::project_browse::is_sensitive_name(c))
}

fn paths_ok<'a>(args: impl IntoIterator<Item = &'a String>) -> bool {
    args.into_iter().all(|a| path_ok(a))
}

/// Short-flag clusters (`-la`) made only of `allowed` letters.
fn cluster_ok(arg: &str, allowed: &str) -> bool {
    arg.len() > 1 && arg[1..].chars().all(|c| allowed.contains(c))
}

fn is_number(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

fn ls(args: &[String]) -> bool {
    const LONG: &[&str] = &[
        "--all",
        "--almost-all",
        "--human-readable",
        "--classify",
        "--recursive",
        "--reverse",
        "--directory",
        "--color",
        "--color=never",
        "--color=auto",
        "--color=always",
    ];
    let mut paths = Vec::new();
    let mut rest = false;
    for a in args {
        if !rest && a == "--" {
            rest = true;
        } else if !rest && a.starts_with("--") {
            if !LONG.contains(&a.as_str()) {
                return false;
            }
        } else if !rest && a.starts_with('-') {
            if !cluster_ok(a, "1AaCdFfGghiklLmnoprRSstuUx") {
                return false;
            }
        } else {
            paths.push(a);
        }
    }
    paths_ok(paths)
}

fn cat(args: &[String]) -> bool {
    let mut paths = Vec::new();
    let mut rest = false;
    for a in args {
        if !rest && a == "--" {
            rest = true;
        } else if !rest && a.starts_with('-') && a.len() > 1 {
            if !cluster_ok(a, "nbsAETv") {
                return false;
            }
        } else {
            paths.push(a);
        }
    }
    paths_ok(paths)
}

fn wc(args: &[String]) -> bool {
    let mut paths = Vec::new();
    let mut rest = false;
    for a in args {
        if !rest && a == "--" {
            rest = true;
        } else if !rest && a.starts_with('-') && a.len() > 1 {
            if !cluster_ok(a, "lwcmL") {
                return false;
            }
        } else {
            paths.push(a);
        }
    }
    paths_ok(paths)
}

/// `head`/`tail`: `-n N`, `-c N`, `-N`, `-q`, `-v`, and their long forms. No
/// follow flags: a `tail -f` never returns.
fn head_tail(args: &[String], tail: bool) -> bool {
    let value_ok = |v: &str| {
        let v = if tail { v.strip_prefix('+').unwrap_or(v) } else { v };
        let v = v.strip_prefix('-').unwrap_or(v);
        is_number(v)
    };
    let mut paths = Vec::new();
    let mut rest = false;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if rest || !a.starts_with('-') || a.len() == 1 {
            paths.push(a);
        } else if a == "--" {
            rest = true;
        } else if let Some(long) = a.strip_prefix("--") {
            match long.split_once('=') {
                Some(("lines" | "bytes", v)) if value_ok(v) => {}
                None if matches!(long, "quiet" | "silent" | "verbose") => {}
                _ => return false,
            }
        } else if a[1..].chars().all(|c| c.is_ascii_digit()) {
            // `-20`
        } else if a == "-q" || a == "-v" || a == "-qv" || a == "-vq" {
        } else if a.starts_with("-n") || a.starts_with("-c") {
            let attached = &a[2..];
            if attached.is_empty() {
                match args.get(i) {
                    Some(v) if value_ok(v) => i += 1,
                    _ => return false,
                }
            } else if !value_ok(attached) {
                return false;
            }
        } else {
            return false;
        }
    }
    paths_ok(paths)
}

/// Non-recursive `grep`. `-r`, `-R`, `-f` and `--include` style flags are not
/// allowed: a recursive search can read every file under a folder, including
/// credential files the path check never sees, and `-f` reads a pattern file.
fn grep(args: &[String]) -> bool {
    const SHORT: &str = "ivnclLwxEFGHhoqsa";
    const LONG: &[&str] = &[
        "ignore-case",
        "invert-match",
        "line-number",
        "count",
        "files-with-matches",
        "files-without-match",
        "word-regexp",
        "line-regexp",
        "extended-regexp",
        "fixed-strings",
        "basic-regexp",
        "with-filename",
        "no-filename",
        "only-matching",
        "quiet",
        "silent",
        "no-messages",
        "text",
        "color",
        "colour",
    ];
    const LONG_VALUE: &[&str] = &[
        "after-context",
        "before-context",
        "context",
        "max-count",
        "regexp",
    ];
    let mut positional: Vec<&String> = Vec::new();
    let mut pattern_given = false;
    let mut rest = false;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if rest || !a.starts_with('-') || a.len() == 1 {
            positional.push(a);
        } else if a == "--" {
            rest = true;
        } else if let Some(long) = a.strip_prefix("--") {
            let (name, value) = match long.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (long, None),
            };
            if LONG.contains(&name) && (value.is_none() || matches!(name, "color" | "colour")) {
            } else if LONG_VALUE.contains(&name) {
                if name == "regexp" {
                    pattern_given = true;
                }
                match value {
                    Some(_) => {}
                    None => {
                        if args.get(i).is_none() {
                            return false;
                        }
                        i += 1;
                    }
                }
            } else {
                return false;
            }
        } else {
            // A cluster: letters without values, then optionally one letter
            // that takes the rest of the word or the next word as its value.
            let body: Vec<char> = a[1..].chars().collect();
            let mut j = 0;
            while j < body.len() {
                let c = body[j];
                if SHORT.contains(c) {
                    j += 1;
                } else if "ABCme".contains(c) {
                    if c == 'e' {
                        pattern_given = true;
                    }
                    if j + 1 == body.len() {
                        if args.get(i).is_none() {
                            return false;
                        }
                        i += 1;
                    }
                    j = body.len();
                } else if c.is_ascii_digit() && body.iter().all(|c| c.is_ascii_digit()) {
                    j = body.len();
                } else {
                    return false;
                }
            }
        }
    }
    // Without `-e`/`--regexp` the first word is the pattern, not a path.
    let files = if pattern_given { &positional[..] } else { positional.get(1..).unwrap_or(&[]) };
    if !pattern_given && positional.is_empty() {
        return false;
    }
    paths_ok(files.iter().copied())
}

/// `find` with only predicates that look. `-exec`, `-delete`, `-fprint*` and
/// every flag not listed are refused.
fn find(args: &[String]) -> bool {
    const NO_VALUE: &[&str] = &[
        "-print", "-print0", "-empty", "-not", "-and", "-or", "-a", "-o", "-depth", "-prune", "-true",
        "-false", "-readable", "-writable", "-executable", "-xdev", "-mount",
    ];
    const WITH_VALUE: &[&str] = &[
        "-name", "-iname", "-path", "-ipath", "-wholename", "-type", "-maxdepth", "-mindepth",
        "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-perm", "-user",
        "-group", "-regex", "-iregex", "-lname", "-ilname", "-samefile",
    ];
    // Starting points come first, before the first expression word.
    let mut i = 0;
    let mut starts = Vec::new();
    while i < args.len() && !args[i].starts_with('-') && args[i] != "!" {
        starts.push(&args[i]);
        i += 1;
    }
    if !paths_ok(starts) {
        return false;
    }
    while i < args.len() {
        let a = args[i].as_str();
        i += 1;
        if a == "!" || NO_VALUE.contains(&a) {
            continue;
        }
        if WITH_VALUE.contains(&a) {
            if a == "-samefile" {
                match args.get(i) {
                    Some(v) if path_ok(v) => {}
                    _ => return false,
                }
            } else if args.get(i).is_none() {
                return false;
            }
            i += 1;
            continue;
        }
        return false;
    }
    true
}

/// Flags that make a read-only git subcommand write, run a program or read a
/// path outside the repository.
fn dangerous_git_flag(flag: &str) -> bool {
    let name = flag.split('=').next().unwrap_or(flag);
    matches!(
        name,
        "--output"
            | "--ext-diff"
            | "--textconv"
            | "--no-index"
            | "--exec-path"
            | "--git-dir"
            | "--work-tree"
            | "--upload-pack"
            | "--open-files-in-pager"
            | "--pager"
            | "--contents"
            | "--config"
            | "--receive-pack"
            | "--super-prefix"
    ) || flag.starts_with("-O")
        || flag.starts_with("--output")
        || flag.starts_with("--exec")
}

fn git(args: &[String]) -> bool {
    // Global options (`-c`, `-C`, `--git-dir`, ...) come before the
    // subcommand and can run programs through configuration.
    let Some(sub) = args.first() else {
        return false;
    };
    if sub.starts_with('-') {
        return false;
    }
    let rest = &args[1..];
    match sub.as_str() {
        "status" | "log" | "diff" | "show" | "rev-parse" | "ls-files" | "blame" => {
            let mut positional = Vec::new();
            let mut revisions = Vec::new();
            let mut after_dd = false;
            for a in rest {
                if after_dd {
                    positional.push(a);
                } else if a == "--" {
                    after_dd = true;
                } else if a.starts_with('-') && a.len() > 1 {
                    // A value attached to a flag is a path often enough
                    // (`--exclude-from=/etc/passwd`) to hold to the same rule.
                    if let Some((_, value)) = a.split_once('=') {
                        if !path_ok(value) {
                            return false;
                        }
                    }
                    // `-c`/`-C` are global options there and harmless flags
                    // here, but a lone `-c` in this position is not worth
                    // arguing about.
                    if dangerous_git_flag(a) || a == "-c" {
                        return false;
                    }
                } else {
                    revisions.push(a);
                }
            }
            paths_ok(positional) && revisions.into_iter().all(|a| path_ok_inner(a, true))
        }
        "branch" => {
            // Listing only. Any other form creates, moves or deletes a branch.
            let mut listing = rest.is_empty();
            let mut positional = false;
            for a in rest {
                match a.as_str() {
                    "--list" | "-l" | "-a" | "--all" | "-r" | "--remotes" | "-v" | "-vv"
                    | "--verbose" | "--show-current" | "--no-color" | "--color" => {
                        listing = true;
                    }
                    f if f.starts_with('-') => return false,
                    _ => positional = true,
                }
            }
            // A bare name makes a branch; with `--list` it is a pattern.
            listing && (!positional || rest.iter().any(|a| matches!(a.as_str(), "--list" | "-l")))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ro(cmd: &str) -> bool {
        is_read_only(cmd, ShellFlavor::Posix)
    }

    #[test]
    fn plain_read_only_commands_are_known() {
        for cmd in [
            "ls",
            "ls -la",
            "ls -la src",
            "ls --all --human-readable",
            "ls src/components",
            "ls -- src",
            "cat README.md",
            "cat -n src/main.rs",
            "cat a.txt b.txt",
            "head -n 20 src/main.rs",
            "head -20 src/main.rs",
            "head -n20 a.txt",
            "head --lines=5 a.txt",
            "tail -n 50 log.txt",
            "tail -n +10 log.txt",
            "tail -c 100 log.txt",
            "wc -l src/main.rs",
            "wc -lwc a b",
            "grep TODO src/main.rs",
            "grep -n TODO a.txt b.txt",
            "grep -in 'fn main' src/main.rs",
            "grep -e foo -e bar a.txt",
            "grep -A 3 -B2 error log.txt",
            "grep --ignore-case --line-number x a.txt",
            "grep -- -pattern a.txt",
            "find . -name '*.rs'",
            "find src -type f -name \"*.ts\" -maxdepth 2",
            "find . -type d -not -name node_modules",
            "find . -name a -o -name b",
            "find . -size +1M -print",
            "pwd",
            "pwd -P",
            "echo hello",
            "echo 'a > b' \"c | d\"",
            "echo",
            "git status",
            "git status --short",
            "git log --oneline -n 20",
            "git log -p src/main.rs",
            "git log --pretty=format:%h",
            "git diff",
            "git diff --stat HEAD~1",
            "git diff main..feature -- src",
            "git show HEAD",
            "git show HEAD:src/main.rs",
            "git branch",
            "git branch --list",
            "git branch --list 'feat/*'",
            "git branch -a",
            "git branch --show-current",
            "git rev-parse HEAD",
            "git rev-parse --show-toplevel",
            "git ls-files",
            "git blame src/main.rs",
        ] {
            assert!(ro(cmd), "should be read-only: {cmd}");
        }
    }

    #[test]
    fn globs_and_short_names_in_paths_are_refused() {
        for cmd in [
            "cat .env*",
            "cat .e*",
            "cat id_r*",
            "cat ENV~1",
            "cat {.env,x}",
            "cat .en?",
            "cat .en[v]",
            "head -n 5 .env*",
            "wc -l id_r*",
            "grep x .env*",
            "ls .ssh/id_*",
            "find .e* -name x",
            "git show HEAD:.env*",
            "git diff -- .env*",
            "git diff -- ENV~1",
        ] {
            assert!(!ro(cmd), "must ask: {cmd}");
        }
        assert!(ro("ls src"));
        assert!(ro("git diff HEAD~1"));
        assert!(ro("find . -name '*.rs'"));
    }

    #[test]
    fn chains_and_pipes_need_every_part_to_be_known() {
        for cmd in [
            "ls | wc -l",
            "cat a.txt | grep foo",
            "git log --oneline | head -5",
            "git status && git diff",
            "ls || echo none",
            "pwd; ls",
            "ls;",
            "grep a b.txt | grep -v c | wc -l",
        ] {
            assert!(ro(cmd), "should be read-only: {cmd}");
        }
        for cmd in [
            "ls; rm -rf /",
            "ls && rm x",
            "ls | sh",
            "cat a | xargs rm",
            "git status && git push",
            "ls ;; ls",
            "; ls",
            "ls | tee out.txt",
            "echo hi | sed s/a/b/",
            "ls |",
            "| ls",
        ] {
            assert!(!ro(cmd), "must ask: {cmd}");
        }
    }

    #[test]
    fn redirection_substitution_and_expansion_are_never_read_only() {
        for cmd in [
            "cat x > y",
            "cat x >> y",
            "echo hi > f",
            "echo hi>f",
            "echo hi 2>&1",
            "ls > /dev/null",
            "cat < /etc/passwd",
            "cat <<EOF",
            "echo $(rm x)",
            "echo `rm x`",
            "echo \"$(rm x)\"",
            "echo \"`rm x`\"",
            "echo $HOME",
            "echo ${HOME}",
            "echo \"$HOME\"",
            "ls $(pwd)",
            "(ls)",
            "ls &",
            "ls & rm x",
            "echo a\nrm x",
            "echo a\rrm x",
            "ls ~",
            "ls ~/src",
            "echo {a,b}",
            "FOO=bar ls",
            "ls\u{2018}x\u{2019}",
            "echo \u{202e}hi",
            "ls \\; rm x",
            "echo \"a\\\"b\"",
            "echo 'unterminated",
            "echo \"unterminated",
            "",
            "   ",
        ] {
            assert!(!ro(cmd), "must ask: {cmd:?}");
        }
    }

    #[test]
    fn programs_that_are_not_listed_ask() {
        for cmd in [
            "rm x",
            "mv a b",
            "cp a b",
            "touch x",
            "mkdir d",
            "sed -i s/a/b/ f",
            "sed s/a/b/ f",
            "awk '{print}' f",
            "sort -o out f",
            "uniq a b",
            "tee f",
            "curl http://x",
            "node x.js",
            "python x.py",
            "env",
            "sh -c ls",
            "bash -c ls",
            "/bin/ls",
            "./ls",
            "LS",
            "xargs ls",
            "sudo ls",
            "time ls",
            "nohup ls",
            "command ls",
            "exec ls",
            "rg foo",
            "rg -n foo src",
        ] {
            assert!(!ro(cmd), "must ask: {cmd}");
        }
    }

    #[test]
    fn unknown_or_dangerous_flags_ask() {
        for cmd in [
            "ls --sort=size",
            "ls -z",
            "cat -x f",
            "cat --show-all f",
            "head -f a",
            "head -n a",
            "head -n",
            "tail -f log.txt",
            "tail -F log.txt",
            "tail --follow log.txt",
            "tail --pid=1 log.txt",
            "tail -n +x log.txt",
            "wc --files0-from=list",
            "grep -r foo .",
            "grep -R foo src",
            "grep --recursive foo .",
            "grep -rn foo .",
            "grep -f /etc/passwd x",
            "grep -f patterns.txt x",
            "grep --file=patterns.txt x",
            "grep --include=*.rs foo",
            "grep -d recurse foo .",
            "grep",
            "grep -A",
            "grep -e",
            "find . -exec rm {} \\;",
            "find . -exec cat {} +",
            "find . -execdir rm {} +",
            "find . -ok rm {} \\;",
            "find . -delete",
            "find . -fprint out.txt",
            "find . -fprintf out.txt x",
            "find . -fls out.txt",
            "find . -fprint0 out",
            "find . -newer other",
            "find . -printf x",
            "find . -name",
            "find . -name a -delete",
            "find . -type f -exec sh -c x ;",
            "pwd -x",
            "pwd extra",
        ] {
            assert!(!ro(cmd), "must ask: {cmd}");
        }
    }

    #[test]
    fn git_is_read_only_only_for_looking() {
        for cmd in [
            "git",
            "git push",
            "git commit -m x",
            "git add .",
            "git checkout x",
            "git reset --hard",
            "git clean -fd",
            "git branch foo",
            "git branch -d foo",
            "git branch -D foo",
            "git branch -m a b",
            "git branch -c a b",
            "git branch -u origin/x",
            "git branch --set-upstream-to=x",
            "git tag v1",
            "git stash",
            "git config user.name x",
            "git remote add x y",
            "git fetch",
            "git pull",
            "git -c core.pager=sh log",
            "git -c core.fsmonitor=x status",
            "git -C other status",
            "git --git-dir=x status",
            "git --work-tree=x status",
            "git --exec-path=x status",
            "git diff --output=f",
            "git diff --output f",
            "git log --output=f",
            "git show --output=f HEAD",
            "git diff --ext-diff",
            "git diff --textconv",
            "git diff --no-index a b",
            "git diff --no-index /etc/passwd /etc/hosts",
            "git log -Oorderfile",
            "git grep -O pager foo",
            "git grep foo",
            "git show --open-files-in-pager",
            "git log --exec-path",
            "git status -c",
            "git log --pager=sh",
            "git ls-files --exclude-from=/etc/passwd",
            "git blame --contents /etc/passwd x",
            "git diff HEAD:../../x",
            "git show /etc/passwd",
            "git show C:/x",
            "git diff -- ../x",
            "git diff -- .env",
            "git show HEAD:.env",
            "git log -p -- config/.env.local",
            "git diff > out",
            "git log | sh",
        ] {
            assert!(!ro(cmd), "must ask: {cmd}");
        }
    }

    #[test]
    fn paths_that_leave_the_project_or_name_secrets_ask() {
        for cmd in [
            "cat /etc/passwd",
            "cat /etc/shadow",
            "cat C:/Users/me/.ssh/id_rsa",
            "cat C:\\Users\\me\\x",
            "cat \\\\server\\share\\x",
            "cat ../secret.txt",
            "cat src/../../x",
            "cat a/../../x",
            "cat ~/.ssh/id_rsa",
            "cat .env",
            "cat config/.env.production",
            "cat id_rsa",
            "cat server.pem",
            "cat server.key",
            "cat .npmrc",
            "cat credentials.json",
            "head .env",
            "tail -n 5 .env",
            "wc -l .env",
            "grep KEY .env",
            "grep KEY src/.env",
            "grep -e KEY .env",
            "ls /",
            "ls /etc",
            "ls C:/",
            "ls ..",
            "ls ../..",
            "find / -name x",
            "find .. -name x",
            "find C:/ -name x",
            "find . -samefile /etc/passwd",
            "find . -samefile .env",
        ] {
            assert!(!ro(cmd), "must ask: {cmd}");
        }
        // Ordinary neighbours of those names are fine.
        for cmd in [
            "cat .envrc.example",
            "cat environment.md",
            "cat src/keys.rs",
            "cat my..file",
            "cat a..b/c",
            "ls .github",
            "grep key a.txt",
            "grep /etc/passwd a.txt",
        ] {
            assert!(ro(cmd), "should be read-only: {cmd}");
        }
    }

    #[test]
    fn grep_pattern_is_not_checked_as_a_path_but_files_are() {
        assert!(ro("grep /etc/passwd a.txt"));
        assert!(ro("grep '^/api' a.txt"));
        assert!(!ro("grep foo /etc/passwd"));
        assert!(!ro("grep -e foo /etc/passwd"));
        assert!(!ro("grep -e /etc/passwd /etc/passwd"));
    }

    #[test]
    fn cmd_exe_is_never_trusted() {
        assert!(!is_read_only("ls", ShellFlavor::Cmd));
        assert!(!is_read_only("echo hello", ShellFlavor::Cmd));
        assert!(is_read_only("ls", ShellFlavor::PowerShell));
        assert!(is_read_only("git status", ShellFlavor::PowerShell));
    }

    #[test]
    fn powershell_specific_constructs_ask() {
        for cmd in [
            "ls | % { rm $_ }",
            "ls | ForEach-Object { rm $_ }",
            "& ls",
            "ls; & rm x",
            "Get-ChildItem",
            "echo @(1,2)",
            "ls -Recurse",
            "ls -Force",
            "cat -Path x",
            "echo hi | Out-File x",
        ] {
            assert!(!is_read_only(cmd, ShellFlavor::PowerShell), "must ask: {cmd}");
        }
        // Backslash paths are plain characters in both shells.
        assert!(is_read_only("cat src\\main.rs", ShellFlavor::PowerShell));
        assert!(is_read_only("ls src\\components", ShellFlavor::PowerShell));
        assert!(!is_read_only("cat ..\\x", ShellFlavor::PowerShell));
    }

    #[test]
    fn very_long_lines_ask() {
        let long = format!("echo {}", "a".repeat(MAX_LEN));
        assert!(!ro(&long));
    }
}
