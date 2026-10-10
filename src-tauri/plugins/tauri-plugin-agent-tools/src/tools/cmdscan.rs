//! Shell-command decomposition for the exec permission gate. Reduces a command
//! to the set of base commands it will actually run, so a session grant cannot
//! be escalated by hiding a second command behind `&&`, a pipe, a wrapper like
//! `sudo`, or a `$(...)` substitution. `git status && rm -rf ~` yields
//! `{git, rm}`, not `{git}`.
//!
//! Commands whose real behavior cannot be reasoned about statically (`eval`,
//! `xargs`, `find -exec`, `sudo`, ...) are reported as [`CommandScan::Opaque`]
//! so the gate always prompts for them. The scan fails safe: any construct it
//! cannot resolve degrades toward prompting, never toward silent allow.

use std::collections::BTreeSet;

#[derive(Debug, PartialEq, Eq)]
pub enum CommandScan {
    /// The full set of base commands this command will execute.
    Bases(BTreeSet<String>),
    /// The command runs code that can't be statically resolved to a base set
    /// (e.g. `eval`, `sudo`, `find -exec`); it must always prompt.
    Opaque,
}

/// Commands whose argument *is* code to run, or that escalate privilege /
/// reach off-box. We cannot bound what they execute, so they are always opaque.
const OPAQUE: &[&str] = &[
    "eval", "xargs", "source", ".", "sudo", "su", "doas", "ssh", "watch",
];
/// `find` predicates that run an arbitrary command.
const EXEC_PREDICATES: &[&str] = &["-exec", "-execdir", "-ok", "-okdir"];
/// POSIX shells: `<shell> -c "<cmd>"` runs `<cmd>`, so we recurse into it.
const SHELLS: &[&str] = &["sh", "bash", "dash", "zsh", "ksh", "ash"];
/// Prefix commands and shell keywords that precede the real command; we skip
/// them (and their flags) to reach the command they wrap.
const WRAPPERS: &[&str] = &[
    "nice", "nohup", "setsid", "time", "timeout", "stdbuf", "ionice", "chrt", "command", "builtin",
    "exec", "then", "else", "elif", "do", "if", "while", "until", "for", "case",
    "select", "coproc", "!",
];
/// [`WRAPPERS`] with a flag that takes a separate value.
const VALUE_FLAG_WRAPPERS: &[&str] =
    &["nice", "timeout", "stdbuf", "ionice", "chrt", "exec", "time"];

/// Commands that redefine what a name resolves to, or run their argument as
/// code in a language this scanner does not parse. A grant on a base only
/// means something while that name still runs the program the user approved,
/// so these are never plain invocations. Matched on [`canon`].
///
/// POSIX: a function definition renames a later base; `hash -p`/`enable -f`
/// repoint a name; `trap`, `bind -x`, `complete -C`, `compgen -C`, `fc` run
/// their argument; `declare`/`typeset`/`local`/`readonly`/`let`/`getopts`/
/// `mapfile` assign through names whose `a[...]` subscript bash evaluates.
/// cmd: `doskey` defines macros, `path` sets `PATH`. PowerShell: the alias,
/// item, variable and module cmdlets that define or shadow a command, and the
/// run-this-text cmdlets. The Windows shells run text too.
const REDEFINING: &[&str] = &[
    "alias", "shopt", "function", "filter", "hash", "enable", "trap", "bind", "complete",
    "compgen", "compopt", "fc", "declare", "typeset", "local", "readonly", "let", "getopts",
    "mapfile", "readarray", "doskey", "path", "set-alias", "sal", "new-alias", "nal",
    "set-item", "si", "new-item", "ni", "rename-item", "rni", "move-item", "set-content",
    "add-content", "ac", "import-module", "ipmo", "set-variable", "sv", "new-variable", "nv",
    "add-type", "update-typedata", "invoke-expression", "iex", "invoke-command", "icm",
    "powershell", "pwsh", "cmd", "wsl",
];
/// Builtins that assign to the names in their arguments. Plain when every name
/// is an ordinary one: not a [`RESOLUTION_VARS`] entry and with no `[...]`
/// subscript, which bash evaluates as arithmetic. `setx` is cmd's persistent
/// `set`; PowerShell aliases `set` to `Set-Variable`.
const ASSIGNING_BUILTINS: &[&str] = &["export", "unset", "read", "set", "setx"];
/// Shell and loader variables that decide which program a name runs, or that
/// run code on their own (`BASH_ENV`, `PS4` under `set -x`). Matched
/// case-insensitively, after cmd's `^` escapes are removed.
const RESOLUTION_VARS: &[&str] = &[
    "path", "pathext", "comspec", "psmodulepath", "bash_env", "env", "bashopts", "shellopts",
    "ps4", "prompt_command", "ifs", "execignore", "bash_loadables_path",
    "psdefaultparametervalues", "psmoduleautoloadingpreference",
];
/// Prefixes of [`RESOLUTION_VARS`]: the dynamic loaders' variables and bash's
/// exported functions.
const RESOLUTION_VAR_PREFIXES: &[&str] = &["ld_", "dyld_", "bash_func_"];
/// `[[ ]]` operators that evaluate an operand as arithmetic (or `-v`, a
/// subscript), which runs any `$(...)` held in a variable's value.
const ARITHMETIC_TESTS: &[&str] = &["-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-v"];

/// Lowercased name with a Windows executable suffix removed, so `SSH.EXE` and
/// `ssh` are one command.
fn canon(base: &str) -> String {
    let lower = base.to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com", ".ps1"] {
        if let Some(stem) = lower.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    lower
}

/// Whether assigning `name` (optionally `+=`-suffixed, `env:`-prefixed, or
/// holding cmd `^` escapes, which cmd strips before acting) can change what a
/// granted base runs.
fn is_resolution_var(name: &str) -> bool {
    let unescaped: String = name.chars().filter(|&c| c != '^').collect();
    let lower = unescaped.to_ascii_lowercase();
    let lower = lower.trim_end_matches('+');
    let lower = lower.strip_prefix("env:").unwrap_or(lower);
    RESOLUTION_VARS.contains(&lower) || RESOLUTION_VAR_PREFIXES.iter().any(|p| lower.starts_with(p))
}

/// Whether a `NAME=value` token assigns one of [`RESOLUTION_VARS`].
fn assigns_resolution_var(token: &str) -> bool {
    token.split_once('=').is_some_and(|(name, _)| is_resolution_var(name))
}

/// Whether an [`ASSIGNING_BUILTINS`] call assigns anything but an ordinary
/// variable: a resolution variable (`export PATH=...`, `setx PATH ...`) or a
/// subscripted name (`read 'a[$(rm x)]'`).
fn assigns_unsafely(args: &[String]) -> bool {
    args.iter().any(|t| {
        let name = t.split_once('=').map_or(t.as_str(), |(name, _)| name);
        name.contains('[') || is_resolution_var(name)
    })
}

/// Whether a command word is built or rewritten at run time: a variable or
/// glob (`l$x`, `/bin/r?`), cmd's `^`/`%var%`, a PowerShell backtick, a
/// non-assignment `=` (`a[$i]=x`, `PS4+=x`), or a PowerShell `function:` /
/// `alias:` drive path. A grant on its text would cover every value.
fn command_word_is_dynamic(word: &str) -> bool {
    if word == "[" || word == "[[" || word == "!" {
        return false;
    }
    word.contains(['=', '$', '*', '?', '[', '^', '%', '`', '{']) || is_drive_ref(word)
}

/// Whether a token names PowerShell's `Function:` or `Alias:` drive, where a
/// command is defined or shadowed (`Set-Item function:ls`, `${alias:ls}`).
fn is_drive_ref(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    lower.contains("function:") || lower.contains("alias:")
}

/// Whether the command's own flags or arguments name a variable to assign or
/// a subscript to evaluate (`printf -v 'a[$(rm x)]'`, `test -v`, `wait -p`).
fn names_a_variable(base: &str, args: &[String]) -> bool {
    match base {
        "printf" | "test" | "[" | "[[" => args.iter().any(|t| t.starts_with("-v")),
        "wait" => args
            .iter()
            .any(|t| t.starts_with('-') && !t.starts_with("--") && t.contains('p')),
        _ => false,
    }
}

/// Whether wrapper flag `t` (followed by `next`) may take `next` as its value,
/// which makes it ambiguous which token is the command: `timeout -s KILL 5
/// rm`, `exec -a ls rm`, `time -o ls rm`. Attached values (`-oL`,
/// `--signal=KILL`) are not. `time` is checked against its no-value
/// whitelist, so unknown, combined or abbreviated spellings default to
/// ambiguous rather than being missed.
fn wrapper_flag_is_ambiguous(wrapper: &str, t: &str, next: Option<&String>) -> bool {
    let numeric = |t: &str| t.chars().next().is_some_and(|c| c.is_ascii_digit());
    let value_flag = if wrapper == "time" {
        t.starts_with('-') && !is_time_plain_flag(t)
    } else {
        (t.len() == 2 && t.starts_with('-') && !numeric(&t[1..]))
            || (t.starts_with("--") && !t.contains('='))
    };
    value_flag
        && VALUE_FLAG_WRAPPERS.contains(&wrapper)
        && next.is_some_and(|n| !n.starts_with('-') && !numeric(n))
}

/// Whether the whole line holds a construct that evaluates text from a
/// variable as code, or that the quote tracking here cannot follow: bash
/// arithmetic (`$((x))`, `(( x ))`, `$[x]`), a `[[ $n -eq 1 ]]` test, a
/// parameter expansion that evaluates (`${!x}`, `${x@P}`, `${a[$i]}`), a
/// compound array assignment, a `name()` function header, ANSI-C quoting
/// (`$'\''` escapes a quote the trackers read as the string's end), or a
/// PowerShell member access (`$x.Invoke()`). Checked before substitutions are
/// extracted, which drops `$((...))` and splits on parens. Applied under every
/// shell: the scanner cannot tell which one runs the line, so each reading is
/// a reason to prompt.
fn line_evaluates_text(command: &str) -> bool {
    if command.contains("$'")
        || has_arithmetic(command)
        || has_empty_parens(command)
        || has_compound_assignment(command)
        || has_member_access(command)
    {
        return true;
    }
    // Over the whole line, not per segment: splitting cuts `[[ ]]` at its own
    // `&&`, leaving the operator in a segment with no `[[`.
    command.contains("[[")
        && tokenize(command).iter().any(|t| ARITHMETIC_TESTS.contains(&t.as_str()))
}

fn has_arithmetic(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_single {
            in_single = c != '\'';
            i += 1;
            continue;
        }
        match c {
            '\\' => i += 1,
            '\'' if !in_double => in_single = true,
            '"' => in_double = !in_double,
            '$' if chars.get(i + 1) == Some(&'{') && param_evaluates_code(&chars[i + 2..]) => {
                return true;
            }
            // Bash's legacy `$[expr]` arithmetic.
            '$' if chars.get(i + 1) == Some(&'[') => return true,
            '(' if chars.get(i + 1) == Some(&'(') => {
                if i == 0 || chars[i - 1] != '$' {
                    // `((` inside double quotes is text, not a command.
                    if in_double {
                        i += 1;
                        continue;
                    }
                    return true;
                }
                let end = skip_balanced(&chars, i + 1).min(chars.len());
                let literal = |ch: &char| ch.is_ascii_digit() || " +-*/%()".contains(*ch);
                if !chars[i + 2..end].iter().all(literal) {
                    return true;
                }
                i = end;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// Whether the parameter expansion whose body starts at `body` (just past
/// `${`) can evaluate a variable's value as code. Only known-plain forms
/// pass: a name (or `#name`) with an optional literal subscript, then `}`, a
/// literal substring offset, a default operator or a pattern operator.
fn param_evaluates_code(body: &[char]) -> bool {
    let mut j = 0;
    if body.first() == Some(&'#') && body.get(1).is_some_and(|c| *c != '}') {
        j += 1;
    }
    let name_start = j;
    while body.get(j).is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_') {
        j += 1;
    }
    // A special parameter (`${#}`, `${?}`, `${@}`), never `!`.
    if j == name_start {
        if !matches!(body.get(j), Some('@' | '*' | '#' | '?' | '$' | '-')) {
            return true;
        }
        j += 1;
    }
    if body.get(j) == Some(&'[') {
        let Some(len) = body[j + 1..].iter().position(|&c| c == ']') else {
            return true;
        };
        let sub = &body[j + 1..j + 1 + len];
        let literal = sub.iter().all(|c| c.is_ascii_digit()) || sub == ['@'] || sub == ['*'];
        if !literal || sub.is_empty() {
            return true;
        }
        j += len + 2;
    }
    match body.get(j) {
        Some('}' | '-' | '=' | '+' | '?' | '#' | '%' | '/' | '^' | ',') => false,
        Some(':') if matches!(body.get(j + 1), Some('-' | '=' | '+' | '?')) => false,
        Some(':') => {
            let end = body[j..].iter().position(|&c| c == '}').map_or(body.len(), |e| j + e);
            !body[j + 1..end]
                .iter()
                .all(|c| c.is_ascii_digit() || matches!(c, ' ' | '-' | ':'))
        }
        _ => true,
    }
}

/// Whether `s` holds a compound array assignment, `a=(...)` or `a+=(...)`,
/// outside single quotes. Bash evaluates each `[key]=` subscript in it as
/// arithmetic, and segment splitting cuts it apart at the parens.
fn has_compound_assignment(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for (i, &c) in chars.iter().enumerate() {
        if in_single {
            in_single = c != '\'';
            continue;
        }
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '\'' if !in_double => in_single = true,
            '"' => in_double = !in_double,
            '=' if chars.get(i + 1) == Some(&'(') => {
                let before = if i > 0 && chars[i - 1] == '+' { i - 1 } else { i };
                let name_end = before.checked_sub(1).map(|p| chars[p]);
                if name_end.is_some_and(|p| p.is_ascii_alphanumeric() || p == '_' || p == ']') {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Whether `s` holds a function definition header, `name()` or `name ( )`,
/// outside quotes. Its body may be a subshell rather than a brace group.
fn has_empty_parens(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut quote: Option<char> = None;
    for (i, &c) in chars.iter().enumerate() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' if chars[i + 1..].iter().find(|ch| !ch.is_whitespace()) == Some(&')') => {
                return true;
            }
            _ => {}
        }
    }
    false
}

/// Whether `s` reads a member, index or method of a variable outside quotes
/// (`$x.Invoke()`, `$a[0]`, `$t::Run()`). PowerShell evaluates these in
/// argument mode, and a property or method can run code. Inside double quotes
/// only the variable itself expands.
fn has_member_access(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '$' => {
                let mut j = i + 1;
                if chars.get(j) == Some(&'{') {
                    match chars[j..].iter().position(|&ch| ch == '}') {
                        Some(end) => j += end + 1,
                        None => return true,
                    }
                } else {
                    while j < chars.len()
                        && (chars[j].is_ascii_alphanumeric()
                            || chars[j] == '_'
                            || (chars[j] == ':' && chars.get(j + 1) != Some(&':')))
                    {
                        j += 1;
                    }
                }
                // `$(` is a substitution and `$((` arithmetic, handled apart.
                if j > i + 1 && matches!(chars.get(j), Some('.' | '[' | '(' | ':')) {
                    return true;
                }
                i = j;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// Marks a segment that is not a plain invocation, in the output of
/// [`simple_commands`]. It is emitted *beside* the parsed command, so deny and
/// ask rules still see the program, while an allow rule written for that
/// program does not match the marked copy and the line prompts.
pub const NON_PLAIN_MARK: &str = "[non-plain]";

pub fn scan_command(command: &str) -> CommandScan {
    let mut bases = BTreeSet::new();
    if scan_into(command, &mut bases, 0) {
        CommandScan::Bases(bases)
    } else {
        CommandScan::Opaque
    }
}

/// Collect the bases of `command` into `bases`. Returns `false` the moment an
/// opaque construct is hit, which aborts the whole scan.
fn scan_into(command: &str, bases: &mut BTreeSet<String>, depth: usize) -> bool {
    if depth > 8 || line_evaluates_text(command) {
        return false;
    }
    let (outer, subs) = extract_substitutions(command);
    for sub in subs {
        if !scan_into(&sub, bases, depth + 1) {
            return false;
        }
    }
    for seg in split_segments(&outer) {
        if !scan_segment(&seg, bases, depth) {
            return false;
        }
    }
    true
}

/// Pull `$(...)`, backtick, and `<(...)`/`>(...)` substitutions out of `s` for
/// separate scanning, replacing each with a space. `$((...))` arithmetic runs
/// no command and is dropped. Substitutions inside single quotes are literal
/// and left in place.
fn extract_substitutions(s: &str) -> (String, Vec<String>) {
    let chars: Vec<char> = s.chars().collect();
    let mut outer = String::with_capacity(s.len());
    let mut subs = Vec::new();
    let mut i = 0;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        if quote == Some('\'') {
            if c == '\'' {
                quote = None;
            }
            outer.push(c);
            i += 1;
            continue;
        }
        match c {
            '\\' if i + 1 < chars.len() => {
                outer.push(c);
                outer.push(chars[i + 1]);
                i += 2;
            }
            '\'' if quote.is_none() => {
                quote = Some('\'');
                outer.push(c);
                i += 1;
            }
            '"' => {
                quote = if quote == Some('"') { None } else { Some('"') };
                outer.push(c);
                i += 1;
            }
            '`' => {
                let (inner, next) = capture_backtick(&chars, i);
                subs.push(inner);
                outer.push(' ');
                i = next;
            }
            '$' if i + 1 < chars.len() && chars[i + 1] == '(' => {
                if i + 2 < chars.len() && chars[i + 2] == '(' {
                    // $((...)) arithmetic: no command.
                    i = skip_balanced(&chars, i + 2);
                    outer.push(' ');
                } else {
                    let (inner, next) = capture_balanced(&chars, i + 1);
                    subs.push(inner);
                    outer.push(' ');
                    i = next;
                }
            }
            '<' | '>' if i + 1 < chars.len() && chars[i + 1] == '(' => {
                let (inner, next) = capture_balanced(&chars, i + 1);
                subs.push(inner);
                outer.push(' ');
                i = next;
            }
            _ => {
                outer.push(c);
                i += 1;
            }
        }
    }
    (outer, subs)
}

/// From an opening `(` at `open`, return (inner-without-parens, index-after-`)`).
fn capture_balanced(chars: &[char], open: usize) -> (String, usize) {
    let mut depth = 1;
    let mut inner = String::new();
    let mut j = open + 1;
    while j < chars.len() && depth > 0 {
        match chars[j] {
            '(' => {
                depth += 1;
                inner.push('(');
            }
            ')' => {
                depth -= 1;
                if depth > 0 {
                    inner.push(')');
                }
            }
            c => inner.push(c),
        }
        j += 1;
    }
    (inner, j)
}

/// From an opening `(` at `open`, return the index just past its matching `)`.
fn skip_balanced(chars: &[char], open: usize) -> usize {
    let mut depth = 1;
    let mut j = open + 1;
    while j < chars.len() && depth > 0 {
        match chars[j] {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        j += 1;
    }
    j
}

fn capture_backtick(chars: &[char], tick: usize) -> (String, usize) {
    let mut inner = String::new();
    let mut j = tick + 1;
    while j < chars.len() && chars[j] != '`' {
        if chars[j] == '\\' && j + 1 < chars.len() {
            inner.push(chars[j + 1]);
            j += 2;
        } else {
            inner.push(chars[j]);
            j += 1;
        }
    }
    (inner, (j + 1).min(chars.len()))
}

/// Split on the shell control operators that separate commands, honoring
/// quotes. `(`/`)` (subshell grouping; substitutions are already removed) also
/// separate.
fn split_segments(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut segs = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            cur.push(c);
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                cur.push(c);
                i += 1;
            }
            '\\' if i + 1 < chars.len() => {
                cur.push(c);
                cur.push(chars[i + 1]);
                i += 2;
            }
            // `&` in a redirection (`2>&1`, `>&2`, `<&3`, `&>file`) duplicates
            // a descriptor; it does not end the command. Splitting there made
            // `go build 2>&1` two commands, `go build 2>` and `1`, each shown
            // and asked about on its own.
            '&' if i > 0 && matches!(chars[i - 1], '>' | '<')
                || chars.get(i + 1) == Some(&'>') =>
            {
                cur.push(c);
                i += 1;
            }
            ';' | '\n' | '|' | '&' | '(' | ')' => {
                segs.push(std::mem::take(&mut cur));
                i += 1;
            }
            _ => {
                cur.push(c);
                i += 1;
            }
        }
    }
    segs.push(cur);
    segs.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Resolve one simple command segment to its base(s). Returns `false` if it is
/// opaque.
fn scan_segment(seg: &str, bases: &mut BTreeSet<String>, depth: usize) -> bool {
    let tokens = tokenize(seg);
    // Any command-running find predicate makes the whole segment opaque.
    if tokens.iter().any(|t| EXEC_PREDICATES.contains(&t.as_str())) {
        return false;
    }
    let mut idx = 0;
    let mut guard = 0;
    loop {
        guard += 1;
        if guard > 64 {
            return false;
        }
        while idx < tokens.len() && is_assignment(&tokens[idx]) {
            // `PATH=/tmp/x ls` runs a different `ls`.
            if assigns_resolution_var(&tokens[idx]) {
                return false;
            }
            idx += 1;
        }
        if idx >= tokens.len() {
            return true; // only assignments / empty: runs nothing
        }
        let base = strip_base(&tokens[idx]);
        if base.is_empty() {
            return true;
        }
        // A command word built at run time names whatever it expands to.
        if command_word_is_dynamic(&tokens[idx]) || tokens.iter().any(|t| is_drive_ref(t)) {
            return false;
        }
        let name = canon(&base);
        if OPAQUE.contains(&base.as_str())
            || OPAQUE.contains(&name.as_str())
            || REDEFINING.contains(&name.as_str())
        {
            return false;
        }
        let args = &tokens[idx + 1..];
        if (ASSIGNING_BUILTINS.contains(&name.as_str()) && assigns_unsafely(args))
            || names_a_variable(&name, args)
        {
            return false;
        }
        if base == "env" {
            idx += 1;
            while idx < tokens.len() && is_assignment(&tokens[idx]) {
                if assigns_resolution_var(&tokens[idx]) {
                    return false;
                }
                idx += 1;
            }
            // `env -flag ...` can consume the command with a value-flag we can't
            // model; be safe and prompt.
            if idx < tokens.len() && tokens[idx].starts_with('-') {
                return false;
            }
            continue;
        }
        if SHELLS.contains(&base.as_str()) {
            if let Some(p) = tokens[idx + 1..].iter().position(|t| t == "-c") {
                let c_arg = idx + 1 + p + 1;
                return match tokens.get(c_arg) {
                    Some(cmd) => scan_into(cmd, bases, depth + 1),
                    None => false,
                };
            }
            bases.insert(base);
            return true;
        }
        if WRAPPERS.contains(&base.as_str()) {
            idx += 1;
            // Skip the wrapper's flags, numeric args (durations/priorities), and
            // any inline assignments to reach the wrapped command.
            while idx < tokens.len() {
                let t = &tokens[idx];
                let numeric = |t: &str| t.chars().next().is_some_and(|c| c.is_ascii_digit());
                if t == "--" {
                    idx += 1;
                    break;
                }
                // A bare flag followed by a word may take that word as its
                // value, so which token is the command is ambiguous: prompt.
                if wrapper_flag_is_ambiguous(base.as_str(), t, tokens.get(idx + 1)) {
                    return false;
                }
                // `nice PATH=/tmp ls`: an inline assignment still applies.
                if is_assignment(t) && assigns_resolution_var(t) {
                    return false;
                }
                if t.starts_with('-') || numeric(t) || is_assignment(t) {
                    idx += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        bases.insert(base);
        return true;
    }
}

/// GNU `time`'s getopt spec is `+af:o:pqvV`: only `-f`/`--format` and
/// `-o`/`--output` take a separate value; `-a`, `-p`, `-q`, `-v`, `-V` do not
/// and may combine into one cluster (`-aqvV`). Whether `t` is entirely made of
/// those no-value flags, so anything else (an unknown flag, a cluster holding
/// `f` or `o`, or an abbreviation of `--format`/`--output` such as `--out`) is
/// treated as ambiguous rather than missed.
fn is_time_plain_flag(t: &str) -> bool {
    const LONG: &[&str] = &["--append", "--portability", "--quiet", "--verbose", "--version"];
    if let Some(short) = t.strip_prefix('-').filter(|s| !s.starts_with('-')) {
        return !short.is_empty() && short.chars().all(|c| "apqvV".contains(c));
    }
    LONG.contains(&t)
}

/// Split a segment into whitespace-delimited tokens, stripping quotes and
/// resolving backslash escapes.
fn tokenize(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == '\\'
                && q == '"'
                && i + 1 < chars.len()
                // Inside double quotes a backslash escapes only these; before
                // anything else it is literal, so `"C:\Program Files\git.exe"`
                // keeps its separators (Jozkah/jan#209).
                && matches!(chars[i + 1], '$' | '`' | '"' | '\\' | '\n')
            {
                cur.push(chars[i + 1]);
                has = true;
                i += 2;
                continue;
            } else {
                cur.push(c);
                has = true;
            }
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                has = true;
                i += 1;
            }
            '\\' if i + 1 < chars.len() => {
                cur.push(chars[i + 1]);
                has = true;
                i += 2;
            }
            c if c.is_whitespace() => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
                i += 1;
            }
            _ => {
                cur.push(c);
                has = true;
                i += 1;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

fn is_assignment(t: &str) -> bool {
    let Some(eq) = t.find('=') else {
        return false;
    };
    if eq == 0 {
        return false;
    }
    t[..eq]
        .chars()
        .enumerate()
        .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

fn strip_base(t: &str) -> String {
    t.rsplit(['/', '\\']).next().unwrap_or(t).to_string()
}

/// Every simple command a shell line runs, each starting at the program it
/// really runs (Jozkah/jan#227): the line is split on control operators and
/// substitutions are pulled out, then leading `NAME=value` assignments and
/// wrappers (`env`, `timeout 60`, `nohup`, `sudo -u x`, ...) are skipped and
/// `sh -c '<cmd>'` is recursed into. The permission gate judges each of these
/// on its own, so a chained or wrapped command cannot hide behind the first.
///
/// Arguments are re-quoted where needed, so a quoted argument stays one word
/// for whoever splits the result again. A segment it cannot take apart is
/// returned as written rather than dropped.
pub fn simple_commands(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    collect_commands(command, &mut out, 0);
    out
}

/// `command` as an extra, marked entry for the gate: see [`NON_PLAIN_MARK`].
fn non_plain(command: &str) -> String {
    format!("{NON_PLAIN_MARK} {}", command.trim())
}

fn collect_commands(command: &str, out: &mut Vec<String>, depth: usize) {
    if depth > 8 {
        out.push(command.trim().to_string());
        out.push(non_plain(command));
        return;
    }
    // A line that evaluates variable text as code (arithmetic, `name()`,
    // `a=(...)`) is marked whole; its segments are still listed below.
    if line_evaluates_text(command) {
        out.push(non_plain(command));
    }
    let (outer, subs) = extract_substitutions(command);
    for sub in subs {
        collect_commands(&sub, out, depth + 1);
    }
    for seg in split_segments(&outer) {
        command_of_segment(&seg, out, depth);
    }
}

/// Lists the command `seg` runs. When `seg` is not a plain invocation of it
/// (an assignment to a resolution variable, an ambiguous wrapper flag, a
/// redefining builtin, a command word built at run time) the segment is also
/// listed with [`NON_PLAIN_MARK`], so the gate never treats it as covered by a
/// rule that names only the program.
fn command_of_segment(seg: &str, out: &mut Vec<String>, depth: usize) {
    let mut unplain = false;
    walk_segment(seg, out, depth, &mut unplain);
    if unplain {
        out.push(non_plain(seg));
    }
}

fn walk_segment(seg: &str, out: &mut Vec<String>, depth: usize, unplain: &mut bool) {
    let tokens = tokenize(seg);
    let mut idx = 0;
    for _ in 0..64 {
        while idx < tokens.len() && is_assignment(&tokens[idx]) {
            *unplain |= assigns_resolution_var(&tokens[idx]);
            idx += 1;
        }
        let Some(first) = tokens.get(idx) else {
            return; // assignments only, or empty: runs nothing
        };
        let base = strip_base(first);
        let name = canon(&base);
        if tokens.iter().any(|t| is_drive_ref(t))
            || command_word_is_dynamic(first)
            || OPAQUE.contains(&name.as_str()) && !matches!(base.as_str(), "sudo" | "doas")
            || REDEFINING.contains(&name.as_str())
            || (ASSIGNING_BUILTINS.contains(&name.as_str())
                && assigns_unsafely(&tokens[idx + 1..]))
            || names_a_variable(&name, &tokens[idx + 1..])
        {
            *unplain = true;
        }
        if base == "env" || base == "sudo" || base == "doas" {
            idx += 1;
            while let Some(t) = tokens.get(idx) {
                if is_assignment(t) {
                    *unplain |= assigns_resolution_var(t);
                    idx += 1;
                } else if t.starts_with('-') {
                    // `env -S` splits its argument into a command we cannot see.
                    *unplain |= t == "-S" || t == "--split-string";
                    // Flags that take a value: `env -u NAME`, `sudo -u user`.
                    let takes_value = matches!(
                        t.as_str(),
                        "-u" | "-C" | "-S" | "-g" | "-h" | "-p" | "-D" | "-R" | "-T" | "--unset"
                            | "--chdir" | "--user" | "--group"
                    );
                    idx += if takes_value { 2 } else { 1 };
                } else {
                    break;
                }
            }
            continue;
        }
        if SHELLS.contains(&base.as_str()) {
            if let Some(p) = tokens[idx + 1..].iter().position(|t| t == "-c") {
                if let Some(cmd) = tokens.get(idx + 1 + p + 1) {
                    collect_commands(cmd, out, depth + 1);
                    return;
                }
            }
        }
        if WRAPPERS.contains(&base.as_str()) {
            idx += 1;
            while let Some(t) = tokens.get(idx) {
                let numeric = t.chars().next().is_some_and(|c| c.is_ascii_digit());
                if t == "--" {
                    idx += 1;
                    break;
                }
                if wrapper_flag_is_ambiguous(base.as_str(), t, tokens.get(idx + 1)) {
                    // `time -o FILE cmd`: the flag owns the next word, so the
                    // command is the one after it. Marked either way.
                    *unplain = true;
                    idx += 2;
                    continue;
                }
                if is_assignment(t) {
                    *unplain |= assigns_resolution_var(t);
                    idx += 1;
                } else if t.starts_with('-') || numeric {
                    idx += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        let words: Vec<String> = tokens[idx..].iter().map(|t| requote(t)).collect();
        out.push(words.join(" "));
        return;
    }
    out.push(seg.trim().to_string());
}

/// A word as a shell would need it written to stay one word.
fn requote(word: &str) -> String {
    if !word.is_empty() && !word.chars().any(|c| c.is_whitespace() || "'\"\\".contains(c)) {
        return word.to_string();
    }
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// Collapse runs of whitespace so equivalent opaque commands share one key.
pub fn normalize(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod simple_command_tests {
    use super::simple_commands;

    #[test]
    fn each_command_in_a_line_starts_at_its_program() {
        assert_eq!(simple_commands("true; git push"), vec!["true", "git push"]);
        assert_eq!(simple_commands("cd . && git reset --hard"), vec!["cd .", "git reset --hard"]);
        assert_eq!(simple_commands("GIT_DIR=.git env -u X timeout 60 git push -f"), vec!["git push -f"]);
        assert_eq!(simple_commands("sudo -u bob git status"), vec!["git status"]);
        assert_eq!(simple_commands("bash -c 'git reset --hard'"), vec!["git reset --hard"]);
        assert_eq!(simple_commands("echo $(git reset --hard)"), vec!["git reset --hard", "echo"]);
        assert_eq!(simple_commands("git commit -m 'a b'"), vec!["git commit -m 'a b'"]);
        // A descriptor redirection is part of its command, not a separator.
        assert_eq!(simple_commands("go build ./... 2>&1"), vec!["go build ./... 2>&1"]);
        assert_eq!(simple_commands("make >&2 && git push"), vec!["make >&2", "git push"]);
        assert_eq!(simple_commands("cargo test &>log; ls"), vec!["cargo test &>log", "ls"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bases(command: &str) -> BTreeSet<String> {
        match scan_command(command) {
            CommandScan::Bases(b) => b,
            CommandScan::Opaque => panic!("expected Bases for {command:?}, got Opaque"),
        }
    }

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn simple_command() {
        assert_eq!(bases("ls -la"), set(&["ls"]));
    }

    #[test]
    fn strips_directory_prefix() {
        assert_eq!(bases("/usr/bin/git commit -m x"), set(&["git"]));
    }

    #[test]
    fn compound_and_exposes_hidden_command() {
        assert_eq!(bases("git status && rm -rf ~"), set(&["git", "rm"]));
    }

    #[test]
    fn pipes_and_semicolons_and_newlines() {
        assert_eq!(bases("cat f | grep x"), set(&["cat", "grep"]));
        assert_eq!(bases("a; b\nc"), set(&["a", "b", "c"]));
        assert_eq!(bases("a || b && c"), set(&["a", "b", "c"]));
    }

    #[test]
    fn leading_env_assignments_are_skipped() {
        assert_eq!(bases("FOO=bar BAZ=1 node app.js"), set(&["node"]));
    }

    #[test]
    fn env_wrapper_with_assignments() {
        assert_eq!(bases("env A=1 B=2 python run.py"), set(&["python"]));
    }

    #[test]
    fn env_with_flag_is_opaque() {
        assert_eq!(scan_command("env -i rm -rf /"), CommandScan::Opaque);
    }

    #[test]
    fn timeout_and_nice_unwrap_to_inner_command() {
        assert_eq!(bases("timeout 5 curl http://x"), set(&["curl"]));
        assert_eq!(bases("nice -n 10 make"), set(&["make"]));
        assert_eq!(bases("nohup node server.js"), set(&["node"]));
    }

    #[test]
    fn a_wrapper_flag_that_may_take_a_value_makes_the_command_ambiguous() {
        // `time -o FILE cmd` writes to FILE and runs cmd, not FILE, so a grant
        // on `ls` must not cover `time -o ls rm -rf ~`.
        for command in [
            "time -o ls rm -rf ~",
            "command time -o ls rm -rf ~",
            "/usr/bin/time -o ls rm x",
            "time -f ls rm -rf ~",
            "time -ao ls rm -rf ~",
            "time --out ls rm -rf ~",
            "time --format ls rm -rf ~",
            "time --forma ls rm -rf ~",
            "time -zo ls rm -rf ~",
            "timeout -s KILL 5 rm x",
            "exec -a ls rm x",
        ] {
            assert_eq!(scan_command(command), CommandScan::Opaque, "{command}");
        }
        // Plain flags, attached values and numeric arguments stay resolvable.
        assert_eq!(bases("time -p ls"), set(&["ls"]));
        assert_eq!(bases("time -aqvV ls"), set(&["ls"]));
        assert_eq!(bases("timeout --signal=KILL 5 curl u"), set(&["curl"]));
        assert_eq!(bases("nice -n 10 make"), set(&["make"]));
        assert_eq!(bases("time -- ls"), set(&["ls"]));
    }

    #[test]
    fn subshell_group() {
        assert_eq!(bases("(cd sub && rm f)"), set(&["cd", "rm"]));
    }

    #[test]
    fn command_substitution_is_scanned() {
        assert_eq!(bases("echo $(rm x)"), set(&["echo", "rm"]));
        assert_eq!(bases("echo `rm x`"), set(&["echo", "rm"]));
    }

    #[test]
    fn substitution_in_single_quotes_is_literal() {
        assert_eq!(bases("echo '$(rm x)'"), set(&["echo"]));
    }

    #[test]
    fn substitution_in_double_quotes_runs() {
        assert_eq!(bases("echo \"$(rm x)\""), set(&["echo", "rm"]));
    }

    #[test]
    fn arithmetic_is_not_a_command() {
        assert_eq!(bases("echo $((1 + 2))"), set(&["echo"]));
    }

    #[test]
    fn inline_shell_c_is_recursed() {
        assert_eq!(bases("bash -c 'rm -rf x'"), set(&["rm"]));
        assert_eq!(bases("sh -c \"git push && rm y\""), set(&["git", "rm"]));
    }

    #[test]
    fn eval_and_sudo_and_xargs_are_opaque() {
        assert_eq!(scan_command("eval \"$CMD\""), CommandScan::Opaque);
        assert_eq!(scan_command("sudo rm -rf /"), CommandScan::Opaque);
        assert_eq!(scan_command("ls | xargs rm"), CommandScan::Opaque);
        assert_eq!(scan_command("source ./x.sh"), CommandScan::Opaque);
    }

    #[test]
    fn find_exec_is_opaque() {
        assert_eq!(
            scan_command("find . -name '*.tmp' -exec rm {} ;"),
            CommandScan::Opaque
        );
        // plain find (no command-running predicate) resolves normally
        assert_eq!(bases("find . -name '*.rs'"), set(&["find"]));
    }

    #[test]
    fn empty_command_has_no_bases() {
        assert_eq!(bases(""), set(&[]));
        assert_eq!(bases("   "), set(&[]));
    }
}

/// A grant or allow rule written for a program is honoured only for a plain
/// invocation of it. Anything that can redefine, wrap or indirect command
/// resolution is opaque to [`scan_command`], and [`simple_commands`] marks the
/// segment with [`NON_PLAIN_MARK`] beside the parsed command so no allow rule
/// written for the program matches the marked copy.
#[cfg(test)]
mod plain_invocation_tests {
    use super::*;

    fn opaque(command: &str) {
        assert_eq!(scan_command(command), CommandScan::Opaque, "{command}");
    }

    fn plain(command: &str, expected: &[&str]) {
        let want: BTreeSet<String> = expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(scan_command(command), CommandScan::Bases(want), "{command}");
    }

    fn marked(command: &str) -> bool {
        simple_commands(command).iter().any(|c| c.starts_with(NON_PLAIN_MARK))
    }

    const BASH: &[&str] = &[
        // Alias, function, hash and friends repoint a later `ls`.
        "alias ls='rm -rf ~'; ls",
        "shopt -s expand_aliases",
        "function ls { rm -rf ~; }; ls",
        "function git ( rm -rf ~ ); git status",
        "ls() { rm -rf ~; }; ls",
        "ls () ( rm -rf ~ ); ls",
        "hash -p /bin/rm ls; ls -rf ~",
        "enable -f ./x.so ls; ls",
        "trap 'rm -rf ~' EXIT; ls",
        "bind -x '\"a\": rm x'",
        "complete -C 'rm x' ls",
        "fc -s ls=rm",
        "declare -n x=y",
        "typeset a",
        "local x=1",
        "readonly x=1",
        "let x=1",
        "mapfile -t a < f",
        "declare -- 'a[$(rm x)]=1'",
        // Resolution variables, assigned or passed through a wrapper.
        "PATH=/tmp/evil:$PATH ls",
        "FOO=1 PATH=/tmp ls",
        "export PATH=/tmp/evil",
        "export BASH_ENV=./x.sh; bash x",
        "LD_PRELOAD=./x.so ls",
        "env PATH=/tmp ls",
        "env A=1 PATH=/tmp ls",
        "nice PATH=/tmp ls",
        "unset PATH",
        "read PATH",
        "read 'a[$(rm x)]'",
        "IFS=/ ls",
        "a[$(rm x)]=1 ls",
        "PS4+=x ls",
        // Variable text evaluated as code.
        "echo $((x + 1))",
        "(( x++ ))",
        "[[ $n -eq 1 ]] && ls",
        "[[ x && git -eq $n ]]",
        "printf -v 'a[$(rm x)]' x",
        "wait -np x",
        "a=([$i]=x); ls",
        "echo ${!x}",
        "echo ${a[$i]}",
        // A command word built at run time.
        "l$x -la",
        "$x -la",
        "/bin/r? x",
        // A wrapper flag may take the next word as its value.
        "time -o ls rm -rf ~",
        "timeout -s KILL 5 rm x",
        "exec -a ls rm x",
        "echo $'\\'' $(rm x)",
    ];

    const WINDOWS: &[&str] = &[
        // cmd: `^` is stripped from every token before cmd acts on it.
        "set PA^TH=C:\\evil & git status",
        "set \"PATH=C:\\evil\" & git status",
        "setx PATH C:\\evil & git status",
        "setx PA^TH C:\\evil & git status",
        "setx pathext .x",
        "path C:\\evil",
        "l^s",
        "doskey ls=rm -rf ~",
        "%x% -la",
        "cmd /c ls",
        // PowerShell.
        "Set-Alias ls rm",
        "sal ls rm",
        "New-Alias git rm",
        "Set-Item function:ls { rm -rf ~ }",
        "${function:ls} = { rm x }",
        "$env:PATH = 'C:\\evil'",
        "$env:Path += ';C:\\evil'",
        "Import-Module .\\evil.psm1",
        "Set-Variable -Name $n -Value 1",
        "Add-Type -TypeDefinition $c",
        "Invoke-Expression $c",
        "iex $c",
        "powershell -Command 'ls'",
        "$x.Invoke()",
        "echo $a[0]",
        "Get-Item alias:ls",
        "Remove-Item function:ls",
        "SET-ALIAS ls rm",
        "powershell.exe -c ls",
    ];

    #[test]
    fn bash_redefinitions_are_not_plain() {
        for command in BASH {
            opaque(command);
        }
    }

    #[test]
    fn cmd_and_powershell_redefinitions_are_not_plain() {
        for command in WINDOWS {
            opaque(command);
        }
    }

    #[test]
    fn simple_commands_marks_every_non_plain_line() {
        for command in BASH.iter().chain(WINDOWS) {
            assert!(marked(command), "{command} -> {:?}", simple_commands(command));
        }
    }

    #[test]
    fn marked_output_keeps_the_parsed_command_for_deny_rules() {
        // A deny rule on `git` must still see the program.
        let cmds = simple_commands("PATH=/tmp/evil git push");
        assert!(cmds.iter().any(|c| c == "git push"), "{cmds:?}");
        assert!(cmds.iter().any(|c| c.starts_with(NON_PLAIN_MARK)), "{cmds:?}");
        // `time -o FILE cmd` runs `cmd`, so the parsed command skips the file.
        let cmds = simple_commands("time -o out.txt rm -rf x");
        assert!(cmds.iter().any(|c| c == "rm -rf x"), "{cmds:?}");
        assert!(cmds.iter().all(|c| c != "out.txt rm -rf x"), "{cmds:?}");
        assert!(cmds.iter().any(|c| c.starts_with(NON_PLAIN_MARK)), "{cmds:?}");
        // `function` is no longer a wrapper skipped to reach a body.
        assert!(!simple_commands("function git { rm -rf ~; }").iter().any(|c| c == "git { rm -rf ~"));
    }

    #[test]
    fn ordinary_commands_stay_plain() {
        for (command, expected) in [
            ("ls -la", &["ls"][..]),
            ("git status && cargo test -- --nocapture", &["cargo", "git"][..]),
            ("export RUST_LOG=debug; echo $HOME", &["echo", "export"][..]),
            ("FOO=1 npm run build", &["npm"][..]),
            ("echo $((1 + 2))", &["echo"][..]),
            ("echo \"((x))\" '$((x))'", &["echo"][..]),
            ("echo ${a[0]} ${a[@]} ${#a[*]} ${x:1} ${x: -2:1}", &["echo"][..]),
            ("echo ${x:-def} ${x:=d} ${x//[a-z]/} ${x#*:} ${#x} ${x%.*}", &["echo"][..]),
            ("printf '%s' x; wait -n", &["printf", "wait"][..]),
            ("[ -f x ] && cat x", &["[", "cat"][..]),
            ("[[ -f x ]]", &["[["][..]),
            ("timeout 5 curl u", &["curl"][..]),
            ("timeout --signal=KILL 5 curl u", &["curl"][..]),
            ("nice -n 10 make", &["make"][..]),
            ("stdbuf -oL make", &["make"][..]),
            ("time -p ls", &["ls"][..]),
            ("time -aqvV ls", &["ls"][..]),
            ("time -- ls", &["ls"][..]),
            ("read -r line < f", &["read"][..]),
            ("echo \"$(git rev-parse HEAD)\"", &["echo", "git"][..]),
            ("cargo test 2>&1 | tail -5", &["cargo", "tail"][..]),
            ("docker run -e ENV=prod img", &["docker"][..]),
            ("echo a^b", &["echo"][..]),
            ("set -e", &["set"][..]),
            ("dir C:\\Users", &["dir"][..]),
        ] {
            // `2>&1` and `\` are shell punctuation here; compare only the
            // commands a grant would name.
            let got = scan_command(command);
            match got {
                CommandScan::Bases(b) => {
                    for want in expected {
                        assert!(b.contains(*want), "{command}: {b:?} lacks {want}");
                    }
                }
                CommandScan::Opaque => panic!("{command} should stay plain"),
            }
            assert!(!marked(command), "{command} -> {:?}", simple_commands(command));
        }
        plain("ls", &["ls"]);
    }
}
