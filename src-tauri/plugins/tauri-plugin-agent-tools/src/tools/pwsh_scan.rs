//! A conservative safety classifier for PowerShell scripts.
//!
//! [`super::cmdscan`] treats PowerShell as opaque: it cannot say what
//! `New-Item`, `Set-Content` or a `$variable` path will touch, so every
//! multi-line script was put to the person even in the mode that says "work on
//! your own inside your own folder". This module closes that gap for the
//! narrow, common case of a script that only creates, reads and removes files
//! *inside the run's own folders*.
//!
//! The answer is [`PwshScan::Contained`] only when a real tokenisation and a
//! small interpreter prove ALL of:
//!
//! * every statement is a simple command from a short allowlist (file
//!   cmdlets, `Write-Output`, `Select-String`, `git` reads, ...), `if` /
//!   `foreach` over literals, or an assignment of a literal;
//! * every path argument is a literal, or a variable assigned from a literal /
//!   `Join-Path` / `Get-Location`, that statically resolves inside an allowed
//!   root (no `..`, no drive roots, no UNC, no `~`, no `%`, no `$env:`, no
//!   provider paths, no wildcard outside the last component, no `.git`,
//!   `.jan` or credential-file names), and whose real location on disk (links
//!   and junctions followed) is still inside the root;
//! * nothing can run text or another program: no `&`, `.`, `iex`,
//!   `Start-Process`, `-EncodedCommand`, `Add-Type`, `[type]::` calls,
//!   `$(...)`, backticks, redirection, script-defined aliases or functions.
//!
//! Anything else is [`PwshScan::NotProven`] and falls back to the existing
//! prompt. A false negative costs one click; a false positive would let a
//! script act without being asked, so every doubt resolves to `NotProven`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The verdict for one script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PwshScan {
    /// Every statement was proven to stay inside the allowed roots.
    Contained,
    /// Something was not proven; the reason names the first doubt.
    NotProven(String),
}

impl PwshScan {
    pub fn is_contained(&self) -> bool {
        matches!(self, PwshScan::Contained)
    }
}

/// Classify `script` run with `project_root` as the working folder. The
/// roots a script may touch are the project, the run's scratch folder and any
/// write root the session was granted.
pub fn classify_in(
    script: &str,
    project_root: &Path,
    scratch: Option<&Path>,
    write_roots: &[PathBuf],
) -> PwshScan {
    let mut roots = vec![project_root.to_path_buf()];
    if let Some(s) = scratch {
        roots.push(s.to_path_buf());
    }
    roots.extend(write_roots.iter().cloned());
    classify(script, project_root, &roots)
}

/// Classify `script` run in `cwd`, which must itself be inside `roots`.
pub fn classify(script: &str, cwd: &Path, roots: &[PathBuf]) -> PwshScan {
    match run(script, cwd, roots) {
        Ok(()) => PwshScan::Contained,
        Err(why) => PwshScan::NotProven(why),
    }
}

type R<X> = Result<X, String>;

fn err<X>(why: impl Into<String>) -> R<X> {
    Err(why.into())
}

const MAX_SCRIPT: usize = 20_000;
const MAX_STATEMENTS: usize = 400;
const MAX_NESTING: usize = 6;
const MAX_UNROLL: usize = 64;
const MAX_ITERATIONS: usize = 256;
const MAX_WALK: usize = 20_000;

fn run(script: &str, cwd: &Path, roots: &[PathBuf]) -> R<()> {
    let script = script.strip_prefix('\u{feff}').unwrap_or(script);
    if script.trim().is_empty() {
        return err("empty script");
    }
    if script.len() > MAX_SCRIPT {
        return err("script is too long to check");
    }
    {
        let cs: Vec<char> = script.chars().collect();
        for (i, c) in cs.iter().enumerate() {
            if *c == '\r' && cs.get(i + 1) != Some(&'\n') {
                return err("a bare carriage return (PowerShell reads it as a line break)");
            }
        }
    }
    if let Some(c) = script.chars().find(|c| is_hostile_char(*c)) {
        return err(format!("contains {:?}, which PowerShell reads in surprising ways", c));
    }
    let roots = Roots::new(roots);
    if roots.items.is_empty() {
        return err("no usable root");
    }
    let cwd = norm_abs(cwd).ok_or("working folder is not an absolute path")?;
    if !roots.inside(&cwd, false) {
        return err("working folder is outside the allowed roots");
    }
    let toks = lex(script)?;
    let mut it = Interp {
        t: toks,
        p: 0,
        vars: HashMap::new(),
        cwd,
        roots: &roots,
        assigned: Vec::new(),
        blocks: 0,
        iters: 0,
        stmts: 0,
    };
    it.program()
}

/// Characters PowerShell treats as quotes, dashes or whitespace although they
/// are not the ASCII ones, plus control characters.
fn is_hostile_char(c: char) -> bool {
    matches!(
        c,
        '\u{2018}'..='\u{201F}'
            | '\u{2013}'..='\u{2015}'
            | '\u{00A0}'
            | '\u{0085}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{200B}'..='\u{200F}'
            | '\u{FEFF}'
    ) || (c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

// ---------------------------------------------------------------------------
// Roots and paths
// ---------------------------------------------------------------------------

struct Roots {
    /// (lexical, canonical) spellings of each allowed root.
    items: Vec<(String, String)>,
    /// Compare case-insensitively (Windows drive paths).
    ci: bool,
    /// Roots are `X:/...` paths, so a rooted `/x` is the current drive.
    windows: bool,
}

fn is_drive_path(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Absolute, `/`-separated, `.`/`..` resolved, no trailing slash. `None` for a
/// relative path, a UNC path or a bare drive/filesystem root.
fn norm_abs(path: &Path) -> Option<String> {
    let path = crate::tools::gate::strip_verbatim(path);
    let mut s = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        if rest.starts_with("UNC/") {
            return None;
        }
        s = rest.to_string();
    }
    if s.starts_with("//") {
        return None;
    }
    let (prefix, rest) = if is_drive_path(&s) {
        if s.len() > 2 && s.as_bytes()[2] != b'/' {
            return None;
        }
        (s[..2].to_string(), s[2..].to_string())
    } else if s.starts_with('/') {
        (String::new(), s.clone())
    } else {
        return None;
    };
    let mut comps: Vec<&str> = Vec::new();
    for c in rest.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                comps.pop();
            }
            other => comps.push(other),
        }
    }
    if comps.is_empty() {
        return None;
    }
    Some(format!("{prefix}/{}", comps.join("/")))
}

fn under(path: &str, root: &str, ci: bool, strict: bool) -> bool {
    let (p, r) = if ci {
        (path.to_lowercase(), root.to_lowercase())
    } else {
        (path.to_string(), root.to_string())
    };
    if p == r {
        return !strict;
    }
    p.starts_with(&format!("{r}/"))
}

impl Roots {
    fn new(paths: &[PathBuf]) -> Roots {
        let mut items = Vec::new();
        for p in paths {
            let Some(lex) = norm_abs(p) else { continue };
            let canon = std::fs::canonicalize(p)
                .ok()
                .and_then(|c| norm_abs(&c))
                .unwrap_or_else(|| lex.clone());
            if !items.iter().any(|(l, _): &(String, String)| *l == lex) {
                items.push((lex, canon));
            }
        }
        let ci = items.iter().any(|(l, _)| is_drive_path(l));
        Roots { items, ci, windows: ci }
    }

    fn inside(&self, abs: &str, strict: bool) -> bool {
        self.items
            .iter()
            .any(|(l, _)| under(abs, l, self.ci, strict))
    }

    fn is_root(&self, abs: &str) -> bool {
        self.items.iter().any(|(l, c)| {
            if self.ci {
                l.eq_ignore_ascii_case(abs) || c.eq_ignore_ascii_case(abs)
            } else {
                l == abs || c == abs
            }
        })
    }

    /// `abs` holds one of the roots (deleting it would take the root along).
    fn is_ancestor_of_root(&self, abs: &str) -> bool {
        self.items
            .iter()
            .any(|(l, c)| under(l, abs, self.ci, true) || under(c, abs, self.ci, true))
    }

    /// Where `abs` really leads (links and junctions followed) is still
    /// inside a root. Unresolvable is not inside.
    fn really_inside(&self, abs: &str) -> bool {
        let Ok(real) = crate::tools::sandbox::canonicalize_lenient(Path::new(abs)) else {
            return false;
        };
        let Some(real) = norm_abs(&real) else {
            return false;
        };
        self.items
            .iter()
            .any(|(l, c)| under(&real, c, self.ci, false) || under(&real, l, self.ci, false))
    }
}

fn reserved_device(comp: &str) -> bool {
    let base = comp.split('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(base.as_str(), "con" | "prn" | "aux" | "nul" | "conin$" | "conout$" | "clock$")
        || (base.len() == 4
            && (base.starts_with("com") || base.starts_with("lpt"))
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0')
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Use {
    /// A listing or a read; a wildcard in the last component is fine.
    Read,
    /// A read of one named thing.
    Exact,
    /// Reading file contents (or searching them): wildcards must not be able
    /// to reach a credential file, `.git` or `.jan`.
    Content,
    /// Create or write one named path.
    Write,
    /// Remove; strictly below a root; bulk patterns never at a root.
    Delete,
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Part {
    Lit(String),
    Var(String),
}

#[derive(Debug, Clone, PartialEq)]
enum T {
    Word(Vec<Part>),
    Sq(String),
    Dq(Vec<Part>),
    Var(String),
    Member(String),
    LParen,
    RParen,
    LBrace,
    RBrace,
    Comma,
    Semi,
    Pipe,
    Nl,
    Assign,
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `$name` starting at `c[i] == '$'`. Returns the lowercase name and the next
/// index. Anything that is not a plain name is refused.
fn lex_var(c: &[char], mut i: usize) -> R<(String, usize)> {
    i += 1;
    let start = i;
    while i < c.len() && is_name_char(c[i]) {
        i += 1;
    }
    if i == start {
        return err("a `$` that is not a plain variable ($(...), ${...}, $?, ...)");
    }
    if c.get(i) == Some(&':') {
        return err("scoped or provider variable (`$env:`, `$global:`, ...)");
    }
    Ok((c[start..i].iter().collect::<String>().to_ascii_lowercase(), i))
}

fn lex_members(c: &[char], i: &mut usize, out: &mut Vec<T>) -> R<()> {
    while c.get(*i) == Some(&'.') && c.get(*i + 1).is_some_and(|x| x.is_ascii_alphabetic() || *x == '_') {
        *i += 1;
        let start = *i;
        while *i < c.len() && is_name_char(c[*i]) {
            *i += 1;
        }
        out.push(T::Member(c[start..*i].iter().collect::<String>().to_ascii_lowercase()));
        if matches!(c.get(*i), Some('(') | Some('[') | Some(':')) {
            return err("method call or static member");
        }
    }
    Ok(())
}

fn after_quote(c: &[char], i: usize) -> R<()> {
    match c.get(i) {
        None => Ok(()),
        Some(ch) if matches!(ch, ' ' | '\t' | '\r' | '\n' | ';' | '|' | ')' | '}' | ',') => Ok(()),
        _ => err("text glued to a quoted string"),
    }
}

/// Parse the body of an expandable string into parts.
fn dq_parts(body: &[char], _here: bool) -> R<Vec<Part>> {
    let mut parts = Vec::new();
    let mut lit = String::new();
    let mut i = 0;
    while i < body.len() {
        let ch = body[i];
        match ch {
            '`' => return err("backtick escape in a string"),
            '$' => {
                // A `$` that cannot start a name is literal text in a string.
                let next = body.get(i + 1).copied();
                match next {
                    Some('(') | Some('{') => return err("subexpression in a string"),
                    Some(n) if is_name_char(n) => {
                        if !lit.is_empty() {
                            parts.push(Part::Lit(std::mem::take(&mut lit)));
                        }
                        let (name, ni) = lex_var(body, i)?;
                        parts.push(Part::Var(name));
                        i = ni;
                    }
                    Some('?') | Some('$') | Some('^') => return err("special variable in a string"),
                    _ => {
                        lit.push('$');
                        i += 1;
                    }
                }
            }
            other => {
                lit.push(other);
                i += 1;
            }
        }
    }
    if !lit.is_empty() || parts.is_empty() {
        parts.push(Part::Lit(lit));
    }
    Ok(parts)
}

fn lex(src: &str) -> R<Vec<T>> {
    let c: Vec<char> = src.chars().collect();
    let mut out: Vec<T> = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        match ch {
            ' ' | '\t' => i += 1,
            '\n' | '\r' => {
                out.push(T::Nl);
                i += 1;
            }
            '#' => {
                while i < c.len() && c[i] != '\n' && c[i] != '\r' {
                    i += 1;
                }
            }
            '<' => {
                if c.get(i + 1) == Some(&'#') {
                    let mut j = i + 2;
                    loop {
                        if j + 1 >= c.len() {
                            return err("unterminated block comment");
                        }
                        if c[j] == '#' && c[j + 1] == '>' {
                            break;
                        }
                        j += 1;
                    }
                    i = j + 2;
                } else {
                    return err("input redirection");
                }
            }
            '>' => return err("output redirection"),
            ';' => {
                out.push(T::Semi);
                i += 1;
            }
            '|' => {
                if c.get(i + 1) == Some(&'|') {
                    return err("`||`");
                }
                out.push(T::Pipe);
                i += 1;
            }
            '(' => {
                out.push(T::LParen);
                i += 1;
            }
            ')' => {
                out.push(T::RParen);
                i += 1;
                lex_members(&c, &mut i, &mut out)?;
            }
            '{' => {
                out.push(T::LBrace);
                i += 1;
            }
            '}' => {
                out.push(T::RBrace);
                i += 1;
            }
            ',' => {
                out.push(T::Comma);
                i += 1;
            }
            '&' => return err("call operator or `&&`"),
            '`' => return err("backtick escape or line continuation"),
            '[' | ']' => return err("type literal, cast or index"),
            '!' => return err("`!`"),
            '@' => {
                let q = c.get(i + 1).copied();
                if q == Some('\'') || q == Some('"') {
                    // Here-string: the opener ends its line, the closer starts one.
                    let mut j = i + 2;
                    while c.get(j) == Some(&' ') || c.get(j) == Some(&'\t') || c.get(j) == Some(&'\r') {
                        j += 1;
                    }
                    if c.get(j) != Some(&'\n') {
                        return err("malformed here-string");
                    }
                    j += 1;
                    let body_start = j;
                    let q = q.unwrap();
                    let end;
                    loop {
                        // `j` is at the start of a line.
                        let mut k = j;
                        while c.get(k) == Some(&' ') || c.get(k) == Some(&'\t') {
                            k += 1;
                        }
                        if c.get(k) == Some(&q) && c.get(k + 1) == Some(&'@') {
                            end = j;
                            i = k + 2;
                            break;
                        }
                        while j < c.len() && c[j] != '\n' {
                            j += 1;
                        }
                        if j >= c.len() {
                            return err("unterminated here-string");
                        }
                        j += 1;
                    }
                    let mut body: Vec<char> = c[body_start..end].to_vec();
                    while matches!(body.last(), Some('\n') | Some('\r')) {
                        body.pop();
                    }
                    if q == '\'' {
                        out.push(T::Sq(body.into_iter().collect()));
                    } else {
                        out.push(T::Dq(dq_parts(&body, true)?));
                    }
                    after_quote(&c, i)?;
                } else {
                    return err("splatting, array or hashtable literal");
                }
            }
            '\'' => {
                let mut s = String::new();
                i += 1;
                loop {
                    match c.get(i) {
                        None => return err("unterminated string"),
                        Some('\'') => {
                            if c.get(i + 1) == Some(&'\'') {
                                s.push('\'');
                                i += 2;
                            } else {
                                i += 1;
                                break;
                            }
                        }
                        Some(x) => {
                            s.push(*x);
                            i += 1;
                        }
                    }
                }
                out.push(T::Sq(s));
                after_quote(&c, i)?;
            }
            '"' => {
                // Find the terminator: `""` is an escaped quote.
                let mut j = i + 1;
                let mut body: Vec<char> = Vec::new();
                loop {
                    match c.get(j) {
                        None => return err("unterminated string"),
                        Some('"') => {
                            if c.get(j + 1) == Some(&'"') {
                                body.push('"');
                                body.push('"');
                                j += 2;
                            } else {
                                j += 1;
                                break;
                            }
                        }
                        Some(x) => {
                            body.push(*x);
                            j += 1;
                        }
                    }
                }
                // `dq_parts` turns each `""` pair into one quote.
                out.push(T::Dq(dq_parts_pairs(&body)?));
                i = j;
                after_quote(&c, i)?;
            }
            '=' => {
                let next = c.get(i + 1).copied();
                if matches!(next, None | Some(' ') | Some('\t') | Some('\r') | Some('\n') | Some('$') | Some('\'') | Some('"') | Some('(')) {
                    out.push(T::Assign);
                    i += 1;
                } else {
                    lex_word(&c, &mut i, &mut out)?;
                }
            }
            _ => lex_word(&c, &mut i, &mut out)?,
        }
    }
    Ok(out)
}

/// [`dq_parts`] for a body in which `""` pairs stand for one quote.
fn dq_parts_pairs(body: &[char]) -> R<Vec<Part>> {
    let mut fixed: Vec<char> = Vec::with_capacity(body.len());
    let mut i = 0;
    while i < body.len() {
        if body[i] == '"' && body.get(i + 1) == Some(&'"') {
            fixed.push('"');
            i += 2;
        } else {
            fixed.push(body[i]);
            i += 1;
        }
    }
    // A literal quote can no longer be confused with a terminator.
    dq_parts(&fixed, true)
}

fn lex_word(c: &[char], i: &mut usize, out: &mut Vec<T>) -> R<()> {
    let mut parts: Vec<Part> = Vec::new();
    let mut lit = String::new();
    while *i < c.len() {
        let ch = c[*i];
        match ch {
            ' ' | '\t' | '\r' | '\n' | ';' | '|' | '(' | ')' | '{' | '}' | ',' => break,
            '\'' | '"' => return err("quote inside a word"),
            '`' | '&' | '<' | '>' | '[' | ']' | '@' | '!' | '%' => {
                return err(format!("`{ch}` in a word"));
            }
            '$' => {
                let (name, ni) = lex_var(c, *i)?;
                if !lit.is_empty() {
                    parts.push(Part::Lit(std::mem::take(&mut lit)));
                }
                parts.push(Part::Var(name));
                *i = ni;
                // `$x.Member` at the start of a word is a member access.
                if parts.len() == 1
                    && c.get(*i) == Some(&'.')
                    && c.get(*i + 1).is_some_and(|x| x.is_ascii_alphabetic() || *x == '_')
                {
                    break;
                }
            }
            x if !x.is_ascii() => return err("non-ASCII character outside a string"),
            x => {
                lit.push(x);
                *i += 1;
            }
        }
    }
    if !lit.is_empty() {
        parts.push(Part::Lit(lit));
    }
    if parts.is_empty() {
        return err("unexpected character");
    }
    if let [Part::Var(name)] = parts.as_slice() {
        let name = name.clone();
        out.push(T::Var(name));
        lex_members(c, i, out)?;
        if matches!(c.get(*i), Some('(') | Some('[')) {
            return err("method call or index");
        }
    } else {
        out.push(T::Word(parts));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Values and interpreter
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Val {
    Str(String),
    /// An absolute, normalised path (still re-checked where it is used).
    Path(String),
    Num(i64),
    Bool(bool),
    Null,
    List(Vec<Val>),
    /// Files and folders listed from allowed paths: (path, recursive).
    Items(Vec<(String, bool)>),
    /// Anything computed: usable as text or data, never as a path.
    Data,
}

fn text_of(v: &Val) -> Option<String> {
    match v {
        Val::Str(s) | Val::Path(s) => Some(s.clone()),
        Val::Num(n) => Some(n.to_string()),
        Val::Bool(true) => Some("True".into()),
        Val::Bool(false) => Some("False".into()),
        Val::Null => Some(String::new()),
        _ => None,
    }
}

#[derive(Clone, PartialEq)]
enum Up {
    None,
    Items(Vec<(String, bool)>),
    Data,
}

struct Interp<'a> {
    t: Vec<T>,
    p: usize,
    vars: HashMap<String, Val>,
    cwd: String,
    roots: &'a Roots,
    assigned: Vec<String>,
    /// How many `{ }` bodies deep the interpreter is.
    blocks: usize,
    iters: usize,
    stmts: usize,
}

fn lit_of(parts: &[Part]) -> Option<String> {
    let mut s = String::new();
    for p in parts {
        match p {
            Part::Lit(l) => s.push_str(l),
            Part::Var(_) => return None,
        }
    }
    Some(s)
}

fn looks_like_param(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0] == b'-' && b[1].is_ascii_alphabetic()
}

fn numeric(s: &str) -> Option<i64> {
    s.parse::<i64>().ok()
}

const COMPARE_OPS: &[&str] = &[
    "-eq", "-ne", "-gt", "-ge", "-lt", "-le", "-like", "-notlike", "-match", "-notmatch",
    "-contains", "-notcontains", "-and", "-or", "-xor", "-ceq", "-cne", "-ieq", "-ine",
    "-clike", "-ilike", "-in", "-notin",
];

/// Variables a script may not assign: automatic and preference variables that
/// change how later commands run.
fn assign_forbidden(name: &str) -> bool {
    if name.starts_with("ps") {
        return true;
    }
    if name.ends_with("preference") && !matches!(name, "erroractionpreference" | "progresspreference") {
        return true;
    }
    matches!(
        name,
        "_" | "pwd" | "home" | "args" | "input" | "error" | "matches" | "host" | "ofs" | "true"
            | "false" | "null" | "this" | "foreach" | "switch" | "lastexitcode" | "env"
            | "executioncontext" | "myinvocation" | "profile" | "shellid" | "stacktrace"
            | "sender" | "event" | "eventargs" | "pid" | "nestedpromptlevel" | "pipelineobject"
            | "consolefilename" | "maximumhistorycount" | "verbosepreference"
    )
}

impl<'a> Interp<'a> {
    fn peek(&self) -> Option<&T> {
        self.t.get(self.p)
    }

    fn peek_at(&self, n: usize) -> Option<&T> {
        self.t.get(self.p + n)
    }

    fn next(&mut self) -> Option<T> {
        let t = self.t.get(self.p).cloned();
        if t.is_some() {
            self.p += 1;
        }
        t
    }

    fn skip_nl(&mut self) {
        while matches!(self.peek(), Some(T::Nl)) {
            self.p += 1;
        }
    }

    fn skip_seps(&mut self) {
        while matches!(self.peek(), Some(T::Nl) | Some(T::Semi)) {
            self.p += 1;
        }
    }

    fn expect(&mut self, want: T, what: &str) -> R<()> {
        match self.next() {
            Some(ref t) if *t == want => Ok(()),
            _ => err(format!("expected {what}")),
        }
    }

    fn program(&mut self) -> R<()> {
        loop {
            self.skip_seps();
            if self.peek().is_none() {
                return Ok(());
            }
            self.statement(false)?;
        }
    }

    /// One statement, then its terminator. `in_block` lets `}` end it.
    fn statement(&mut self, in_block: bool) -> R<()> {
        self.stmts += 1;
        if self.stmts > MAX_STATEMENTS {
            return err("too many statements to check");
        }
        let first = self.peek().cloned();
        match first {
            Some(T::Var(name)) if matches!(self.peek_at(1), Some(T::Assign)) => {
                self.p += 2;
                self.skip_nl();
                self.assign(name)?;
            }
            Some(T::Word(parts)) => {
                let kw = lit_of(&parts).map(|s| s.to_ascii_lowercase());
                match kw.as_deref() {
                    Some("if") if matches!(self.peek_at(1), Some(T::LParen)) => self.if_stmt()?,
                    Some("foreach") if matches!(self.peek_at(1), Some(T::LParen)) => {
                        self.foreach_stmt()?
                    }
                    _ => {
                        self.pipeline()?;
                    }
                }
            }
            _ => {
                self.pipeline()?;
            }
        }
        match self.peek() {
            None | Some(T::Nl) | Some(T::Semi) => Ok(()),
            Some(T::RBrace) if in_block => Ok(()),
            _ => err("unexpected token after a statement"),
        }
    }

    fn assign(&mut self, name: String) -> R<()> {
        if assign_forbidden(&name) {
            return err(format!("assigns the automatic variable `${name}`"));
        }
        let v = self.pipeline()?;
        self.vars.insert(name.clone(), v);
        self.assigned.push(name);
        Ok(())
    }

    // ----- block-structured statements --------------------------------------

    /// `{ statements }`, consuming both braces.
    fn block(&mut self) -> R<()> {
        self.skip_nl();
        self.expect(T::LBrace, "`{`")?;
        self.blocks += 1;
        if self.blocks > MAX_NESTING {
            return err("nested too deeply");
        }
        loop {
            self.skip_seps();
            match self.peek() {
                Some(T::RBrace) => {
                    self.p += 1;
                    break;
                }
                None => return err("unterminated block"),
                _ => self.statement(true)?,
            }
        }
        self.blocks -= 1;
        Ok(())
    }

    /// Run `body` and make every variable it assigned unusable as a path:
    /// the body may have run any number of times or not at all.
    fn uncertain<X>(&mut self, body: impl FnOnce(&mut Self) -> R<X>) -> R<X> {
        let pre = self.vars.clone();
        let mark = self.assigned.len();
        let out = body(self);
        let names = self.assigned.split_off(mark);
        self.vars = pre;
        for n in names {
            self.vars.insert(n.clone(), Val::Data);
            self.assigned.push(n);
        }
        out
    }

    fn if_stmt(&mut self) -> R<()> {
        self.p += 1;
        let pre = self.vars.clone();
        let mark = self.assigned.len();
        let mut had_else = false;
        loop {
            self.expect(T::LParen, "`(`")?;
            self.skip_nl();
            self.pipeline()?;
            self.skip_nl();
            self.expect(T::RParen, "`)`")?;
            self.vars = pre.clone();
            self.block()?;
            let save = self.p;
            self.skip_nl();
            let kw = match self.peek() {
                Some(T::Word(parts)) => lit_of(parts).map(|s| s.to_ascii_lowercase()),
                _ => None,
            };
            match kw.as_deref() {
                Some("elseif") => {
                    self.p += 1;
                    continue;
                }
                Some("else") => {
                    self.p += 1;
                    self.vars = pre.clone();
                    self.block()?;
                    had_else = true;
                    break;
                }
                _ => {
                    self.p = save;
                    break;
                }
            }
        }
        let _ = had_else;
        let names = self.assigned.split_off(mark);
        self.vars = pre;
        for n in names {
            self.vars.insert(n.clone(), Val::Data);
            self.assigned.push(n);
        }
        Ok(())
    }

    fn foreach_stmt(&mut self) -> R<()> {
        self.p += 1;
        self.expect(T::LParen, "`(`")?;
        let Some(T::Var(name)) = self.next() else {
            return err("foreach needs a loop variable");
        };
        if assign_forbidden(&name) {
            return err("loop variable is an automatic variable");
        }
        match self.next() {
            Some(T::Word(parts)) if lit_of(&parts).is_some_and(|s| s.eq_ignore_ascii_case("in")) => {}
            _ => return err("expected `in`"),
        }
        let list = self.pipeline()?;
        self.skip_nl();
        self.expect(T::RParen, "`)`")?;
        self.skip_nl();
        let body = self.p;
        let items: Option<Vec<Val>> = match list {
            Val::List(v) => Some(v),
            v @ (Val::Str(_) | Val::Path(_) | Val::Num(_)) => Some(vec![v]),
            _ => None,
        };
        match items {
            Some(items) if !items.is_empty() => {
                if items.len() > MAX_UNROLL || self.iters + items.len() > MAX_ITERATIONS {
                    return err("loop is too long to check");
                }
                self.iters += items.len();
                for el in items {
                    self.vars.insert(name.clone(), el);
                    self.p = body;
                    self.block()?;
                }
                self.vars.insert(name.clone(), Val::Data);
                self.assigned.push(name);
            }
            _ => {
                // Unknown or empty: checked once with an unusable variable.
                self.uncertain(|me| {
                    me.vars.insert(name.clone(), Val::Data);
                    me.assigned.push(name.clone());
                    me.block()
                })?;
                self.vars.insert(name, Val::Data);
            }
        }
        Ok(())
    }

    /// A `{ ... }` argument of `Where-Object` / `ForEach-Object`: `$_` is data
    /// and nothing it assigns can be used as a path afterwards.
    fn script_block(&mut self) -> R<()> {
        let prev = self.vars.get("_").cloned();
        self.uncertain(|me| {
            me.vars.insert("_".into(), Val::Data);
            me.block()
        })?;
        match prev {
            Some(v) => {
                self.vars.insert("_".into(), v);
            }
            None => {
                self.vars.remove("_");
            }
        }
        Ok(())
    }

    // ----- pipelines and expressions -----------------------------------------

    fn is_command_start(&self) -> bool {
        match self.peek() {
            Some(T::Word(parts)) => match lit_of(parts) {
                Some(s) => {
                    let is_range = s
                        .split_once("..")
                        .is_some_and(|(x, y)| numeric(x).is_some() && numeric(y).is_some());
                    !s.starts_with('-') && s != "+" && numeric(&s).is_none() && !is_range
                }
                None => false,
            },
            _ => false,
        }
    }

    fn pipeline(&mut self) -> R<Val> {
        let mut up = Up::None;
        loop {
            let v = if self.is_command_start() {
                self.command(up.clone())?
            } else {
                if up != Up::None {
                    return err("an expression after a pipe");
                }
                self.expr()?
            };
            if matches!(self.peek(), Some(T::Pipe)) {
                self.p += 1;
                self.skip_nl();
                up = match v {
                    Val::Items(i) => Up::Items(i),
                    _ => Up::Data,
                };
                continue;
            }
            return Ok(v);
        }
    }

    fn expr(&mut self) -> R<Val> {
        let mut left = self.operand()?;
        loop {
            let op = match self.peek() {
                Some(T::Word(p)) => lit_of(p).map(|s| s.to_ascii_lowercase()),
                _ => None,
            };
            match op.as_deref() {
                Some("+") => {
                    self.p += 1;
                    let right = self.operand()?;
                    left = match (&left, &right) {
                        (Val::Str(_) | Val::Path(_) | Val::Num(_), Val::Str(_) | Val::Path(_) | Val::Num(_)) => {
                            Val::Str(format!(
                                "{}{}",
                                text_of(&left).unwrap_or_default(),
                                text_of(&right).unwrap_or_default()
                            ))
                        }
                        _ => Val::Data,
                    };
                }
                Some(o) if COMPARE_OPS.contains(&o) => {
                    self.p += 1;
                    self.operand()?;
                    left = Val::Data;
                }
                _ => return Ok(left),
            }
        }
    }

    fn operand(&mut self) -> R<Val> {
        if let Some(T::Word(parts)) = self.peek().cloned() {
            let Some(s) = lit_of(&parts) else {
                return err("an unquoted word with a variable where a value was expected");
            };
            let l = s.to_ascii_lowercase();
            if l == "-not" || l == "-bnot" {
                self.p += 1;
                self.operand()?;
                return Ok(Val::Data);
            }
            if let Some((a, b)) = s.split_once("..") {
                if let (Some(a), Some(b)) = (numeric(a), numeric(b)) {
                    self.p += 1;
                    if (b - a).abs() as usize >= MAX_UNROLL {
                        return err("range is too long to check");
                    }
                    let v: Vec<Val> = if a <= b {
                        (a..=b).map(Val::Num).collect()
                    } else {
                        (b..=a).rev().map(Val::Num).collect()
                    };
                    return Ok(Val::List(v));
                }
            }
            if let Some(n) = numeric(&s) {
                self.p += 1;
                return Ok(Val::Num(n));
            }
            return err("a bare word where a value was expected");
        }
        let first = self.primary(false)?;
        if matches!(self.peek(), Some(T::Comma)) {
            let mut v = vec![first];
            while matches!(self.peek(), Some(T::Comma)) {
                self.p += 1;
                self.skip_nl();
                v.push(self.primary(false)?);
            }
            return Ok(Val::List(v));
        }
        Ok(first)
    }

    fn var(&self, name: &str) -> R<Val> {
        match name {
            "true" => Ok(Val::Bool(true)),
            "false" => Ok(Val::Bool(false)),
            "null" => Ok(Val::Null),
            "pwd" => Ok(Val::Path(self.cwd.clone())),
            n => self
                .vars
                .get(n)
                .cloned()
                .ok_or_else(|| format!("variable `${n}` has no value this scan can see")),
        }
    }

    fn members(&mut self, mut v: Val) -> Val {
        while let Some(T::Member(m)) = self.peek().cloned() {
            self.p += 1;
            v = match (&v, m.as_str()) {
                (Val::Path(p), "path") => Val::Path(p.clone()),
                _ => Val::Data,
            };
        }
        v
    }

    fn resolve_parts(&self, parts: &[Part]) -> R<Val> {
        let mut s = String::new();
        let mut data = false;
        for p in parts {
            match p {
                Part::Lit(l) => s.push_str(l),
                Part::Var(n) => {
                    let v = self.var(n)?;
                    match text_of(&v) {
                        Some(t) => s.push_str(&t),
                        None => data = true,
                    }
                }
            }
        }
        Ok(if data { Val::Data } else { Val::Str(s) })
    }

    /// One value: a word, a string, a variable, `( ... )`, optionally a block.
    fn primary(&mut self, allow_block: bool) -> R<Val> {
        match self.peek().cloned() {
            Some(T::Word(parts)) => {
                self.p += 1;
                if let Some(s) = lit_of(&parts) {
                    if looks_like_param(&s) {
                        return err("a parameter where a value was expected");
                    }
                }
                self.resolve_parts(&parts)
            }
            Some(T::Sq(s)) => {
                self.p += 1;
                Ok(Val::Str(s))
            }
            Some(T::Dq(parts)) => {
                self.p += 1;
                self.resolve_parts(&parts)
            }
            Some(T::Var(n)) => {
                self.p += 1;
                let v = self.var(&n)?;
                Ok(self.members(v))
            }
            Some(T::LParen) => {
                self.p += 1;
                self.skip_nl();
                let v = self.pipeline()?;
                self.skip_nl();
                self.expect(T::RParen, "`)`")?;
                Ok(self.members(v))
            }
            Some(T::LBrace) if allow_block => {
                self.script_block()?;
                Ok(Val::Data)
            }
            _ => err("an unsupported value"),
        }
    }

    fn arg_value(&mut self, allow_block: bool) -> R<Val> {
        let first = self.primary(allow_block)?;
        if matches!(self.peek(), Some(T::Comma)) {
            let mut v = vec![first];
            while matches!(self.peek(), Some(T::Comma)) {
                self.p += 1;
                self.skip_nl();
                v.push(self.primary(false)?);
            }
            return Ok(Val::List(v));
        }
        Ok(first)
    }

    // ----- commands -----------------------------------------------------------

    fn command(&mut self, up: Up) -> R<Val> {
        let Some(T::Word(parts)) = self.next() else {
            return err("expected a command");
        };
        let Some(name) = lit_of(&parts) else {
            return err("a command named by a variable");
        };
        let lname = name.to_ascii_lowercase();
        if lname == "git" {
            return self.native_git();
        }
        let Some(spec) = spec_for(&lname) else {
            return err(format!("`{name}` is not on the allowlist"));
        };
        let mut named: HashMap<&'static str, Val> = HashMap::new();
        let mut positional: Vec<Val> = Vec::new();
        loop {
            match self.peek().cloned() {
                None | Some(T::Nl) | Some(T::Semi) | Some(T::Pipe) | Some(T::RParen) | Some(T::RBrace) => break,
                Some(T::Word(p)) if lit_of(&p).is_some_and(|s| looks_like_param(&s)) => {
                    let raw = lit_of(&p).unwrap();
                    self.p += 1;
                    if raw.contains(':') {
                        return err("a `-Parameter:value` form");
                    }
                    let (canon, kind) = spec
                        .param(&raw)
                        .ok_or_else(|| format!("`{raw}` is not an allowed parameter of `{name}`"))?;
                    let v = match kind {
                        Pk::Sw => Val::Bool(true),
                        Pk::Blk => {
                            // `ForEach-Object Delete` binds -MemberName and
                            // calls the method on every item: only a `{}`
                            // block is a script this scan has read.
                            if !matches!(self.peek(), Some(T::LBrace)) {
                                return err("a script-block parameter given something other than a { } block");
                            }
                            self.arg_value(true)?
                        }
                        _ => self.arg_value(false)?,
                    };
                    if canon == "erroraction" {
                        let ok = text_of(&v).is_some_and(|s| {
                            matches!(
                                s.to_ascii_lowercase().as_str(),
                                "stop" | "continue" | "silentlycontinue" | "ignore"
                            )
                        });
                        if !ok {
                            return err("an -ErrorAction value this scan does not know");
                        }
                    }
                    if named.insert(canon, v).is_some() {
                        return err("a parameter given twice");
                    }
                }
                Some(other) => {
                    if spec.blocks && !matches!(other, T::LBrace) {
                        return err("a bare word where a { } script block was expected");
                    }
                    let v = self.arg_value(spec.blocks)?;
                    positional.push(v);
                }
            }
        }
        let mut rest = Vec::new();
        for (i, v) in positional.into_iter().enumerate() {
            match spec.pos.get(i) {
                Some(canon) => {
                    if named.insert(canon, v).is_some() {
                        return err("a parameter given twice");
                    }
                }
                None if spec.variadic => rest.push(v),
                None => return err(format!("too many arguments for `{name}`")),
            }
        }
        self.run_cmd(spec.cmd, &named, &rest, up, &name)
    }

    fn native_git(&mut self) -> R<Val> {
        let mut args: Vec<String> = Vec::new();
        loop {
            match self.peek().cloned() {
                None | Some(T::Nl) | Some(T::Semi) | Some(T::Pipe) | Some(T::RParen) | Some(T::RBrace) => break,
                Some(T::Comma) => return err("a list argument to git"),
                Some(T::Word(_)) | Some(T::Sq(_)) | Some(T::Dq(_)) | Some(T::Var(_)) => {
                    let v = self.primary(false)?;
                    let t = text_of(&v).ok_or("a git argument that is not static text")?;
                    args.push(t);
                }
                _ => return err("an unsupported git argument"),
            }
        }
        if args.first().is_none_or(|a| a.starts_with('-')) {
            return err("git global options or no subcommand");
        }
        const BANNED: &[&str] = &[
            "--output", "--ext-diff", "--textconv", "--open-files-in-pager", "--exec",
            "--upload-pack", "--receive-pack", "--config", "--git-dir", "--work-tree",
        ];
        let is_grep = args[0].eq_ignore_ascii_case("grep");
        for a in &args {
            let l = a.to_ascii_lowercase();
            // An option may be abbreviated to any unambiguous prefix.
            let name = l.split('=').next().unwrap_or("");
            let abbreviates = name.starts_with("--")
                && name.len() > 2
                && BANNED.iter().any(|b| b.starts_with(name));
            if abbreviates
                || l.starts_with("-o")
                || (is_grep && l.starts_with("-f"))
                || l.contains('\n')
            {
                return err("a git option that writes files, reads patterns from a file or runs programs");
            }
        }
        match crate::tools::git_tool::plan("git", &args) {
            Ok(plan)
                if plan.class == crate::tools::git_tool::GitClass::Read
                    && plan.destructive.is_none()
                    && !plan.reaches_remote =>
            {
                Ok(Val::Data)
            }
            Ok(_) => err("a git command that is not a plain read"),
            Err(e) => err(format!("git: {e}")),
        }
    }

    // ----- paths ---------------------------------------------------------------

    /// `raw` as a normalised absolute path string, without touching the disk.
    fn abs_path(&self, raw: &str, allow_wild: bool) -> R<String> {
        if raw.is_empty() {
            return err("an empty path");
        }
        if raw == "-" || raw == "+" {
            return err("a location-history path");
        }
        for ch in raw.chars() {
            if matches!(ch, '~' | '%' | '$' | '`' | '<' | '>' | '|' | '"' | '[' | ']' | '{' | '}' | '\0')
                || ch.is_control()
            {
                return err(format!("path character `{ch}`"));
            }
        }
        let s = raw.replace('\\', "/");
        if s.starts_with("//") {
            return err("a UNC or device path");
        }
        let (prefix, rest): (Option<String>, &str) = if is_drive_path(&s) {
            if s.len() == 2 || s.as_bytes()[2] != b'/' {
                return err("a drive-relative path");
            }
            (Some(s[..2].to_string()), &s[3..])
        } else if let Some(r) = s.strip_prefix('/') {
            if self.roots.windows {
                return err("a rooted path on the current drive");
            }
            (Some(String::new()), r)
        } else {
            (None, &s[..])
        };
        if rest.contains(':') {
            return err("a `:` in a path (alternate stream or provider)");
        }
        let comps: Vec<&str> = rest.split('/').filter(|c| !c.is_empty() && *c != ".").collect();
        for (i, c) in comps.iter().enumerate() {
            if *c == ".." {
                return err("`..` in a path");
            }
            if c.ends_with('.') || c.ends_with(' ') {
                return err("a path component ending in a dot or space");
            }
            if reserved_device(c) {
                return err("a reserved device name");
            }
            if c.contains(['*', '?']) {
                if !allow_wild {
                    return err("a wildcard in a path that must be exact");
                }
                if i + 1 != comps.len() {
                    return err("a wildcard outside the last path component");
                }
            }
        }
        let tail = comps.join("/");
        let abs = match prefix {
            Some(p) => {
                if tail.is_empty() {
                    format!("{p}/")
                } else {
                    format!("{p}/{tail}")
                }
            }
            None => {
                if tail.is_empty() {
                    self.cwd.clone()
                } else {
                    format!("{}/{tail}", self.cwd)
                }
            }
        };
        Ok(abs)
    }

    /// Every path named by `v`, proven inside the roots for `mode`.
    fn use_paths(&self, v: &Val, mode: Use) -> R<Vec<String>> {
        let items: Vec<&Val> = match v {
            Val::List(l) if !l.is_empty() => l.iter().collect(),
            other => vec![other],
        };
        let mut out = Vec::new();
        for item in items {
            let raw = match item {
                Val::Str(s) | Val::Path(s) => s.as_str(),
                _ => return err("a path this scan cannot compute statically"),
            };
            let abs = self.abs_path(raw, matches!(mode, Use::Read | Use::Content | Use::Delete))?;
            self.check_abs(&abs, mode)?;
            out.push(abs);
        }
        Ok(out)
    }

    fn check_abs(&self, abs: &str, mode: Use) -> R<()> {
        let (parent, last) = abs.rsplit_once('/').unwrap_or(("", abs));
        let wild = last.contains(['*', '?']);
        if !self.roots.inside(abs, matches!(mode, Use::Write | Use::Delete)) {
            return err(format!("`{abs}` is not inside the allowed folders"));
        }
        if abs
            .split('/')
            .any(|c| c.eq_ignore_ascii_case(".jan") || c.eq_ignore_ascii_case(".git"))
            || crate::tools::sandbox::names_git_internals(abs)
        {
            return err("a `.git` or `.jan` path");
        }
        if !wild && crate::project_browse::is_sensitive_name(last) {
            return err("a credential file");
        }
        if wild && matches!(mode, Use::Content | Use::Delete | Use::Write) && glob_reaches_protected(last) {
            return err("a wildcard that can match a credential file, `.git` or `.jan`");
        }
        if matches!(mode, Use::Delete | Use::Write)
            && (self.roots.is_root(abs) || self.roots.is_ancestor_of_root(abs))
        {
            return err("a root folder, or a folder holding one");
        }
        if mode == Use::Delete && wild && self.roots.is_root(parent) {
            return err("a bulk delete at the root of a folder");
        }
        let probe = if wild { parent } else { abs };
        if !self.roots.really_inside(probe) {
            return err(format!("`{abs}` leads outside the allowed folders (link or junction)"));
        }
        Ok(())
    }

    fn path_arg<'v>(&self, named: &'v HashMap<&'static str, Val>) -> Option<&'v Val> {
        named.get("path").or_else(|| named.get("literalpath"))
    }

    // ----- cmdlets ---------------------------------------------------------------

    fn run_cmd(
        &mut self,
        cmd: Cmd,
        a: &HashMap<&'static str, Val>,
        rest: &[Val],
        up: Up,
        name: &str,
    ) -> R<Val> {
        self.run_cmd_inner(cmd, a, rest, up)
            .map_err(|e| format!("{name}: {e}"))
    }

    fn run_cmd_inner(
        &mut self,
        cmd: Cmd,
        a: &HashMap<&'static str, Val>,
        rest: &[Val],
        up: Up,
    ) -> R<Val> {
        let has = |k: &str| a.contains_key(k);
        match cmd {
            Cmd::GetChildItem | Cmd::GetItem => {
                let recursive = has("recurse");
                let listed: Vec<(String, bool)> = match self.path_arg(a) {
                    Some(v) => self
                        .use_paths(v, Use::Read)?
                        .into_iter()
                        .map(|p| (p, recursive))
                        .collect(),
                    None => match &up {
                        Up::Data => return err("paths piped in from text"),
                        Up::None if cmd == Cmd::GetItem => return err("Get-Item without a path"),
                        Up::None => vec![(self.cwd.clone(), recursive)],
                        Up::Items(i) => i.iter().map(|(p, r)| (p.clone(), *r || recursive)).collect(),
                    },
                };
                if recursive {
                    // 5.1 follows junctions under -Recurse.
                    for (p, _) in &listed {
                        let dir = wildcard_parent(p);
                        let mut budget = MAX_WALK;
                        if walk_problem(Path::new(&dir), &mut budget, 0, false) {
                            return err("a recursive listing over a folder holding links or junctions");
                        }
                    }
                }
                Ok(Val::Items(listed))
            }
            Cmd::GetContent => {
                match self.path_arg(a) {
                    Some(v) => {
                        self.use_paths(v, Use::Content)?;
                    }
                    None => match &up {
                        Up::Items(i) => items_readable(i)?,
                        _ => return err("Get-Content without a path"),
                    },
                }
                Ok(Val::Data)
            }
            Cmd::SetContent | Cmd::AddContent | Cmd::OutFile => {
                let v = self
                    .path_arg(a)
                    .or_else(|| a.get("filepath"))
                    .ok_or("a write without an explicit path")?;
                self.use_paths(v, Use::Write)?;
                Ok(Val::Data)
            }
            Cmd::NewItem | Cmd::Mkdir => {
                let v = self.path_arg(a).ok_or("New-Item without an explicit path")?;
                if let Some(t) = a.get("itemtype") {
                    let t = text_of(t).unwrap_or_default().to_ascii_lowercase();
                    if !matches!(t.as_str(), "file" | "directory") {
                        return err("an -ItemType other than File or Directory (links, junctions)");
                    }
                }
                let bases: Vec<String> = match (a.get("name"), v) {
                    (Some(n), base) => {
                        let n = text_of(n).ok_or("a computed -Name")?;
                        let mut out = Vec::new();
                        let list: Vec<&Val> = match base {
                            Val::List(l) => l.iter().collect(),
                            other => vec![other],
                        };
                        for b in list {
                            let b = text_of(b).ok_or("a computed path")?;
                            let b = self.abs_path(&b, false)?;
                            out.push(format!("{b}/{n}"));
                        }
                        out
                    }
                    (None, base) => {
                        let list: Vec<&Val> = match base {
                            Val::List(l) => l.iter().collect(),
                            other => vec![other],
                        };
                        let mut out = Vec::new();
                        for b in list {
                            out.push(text_of(b).ok_or("a computed path")?);
                        }
                        out
                    }
                };
                for b in bases {
                    let abs = self.abs_path(&b, false)?;
                    self.check_abs(&abs, Use::Write)?;
                }
                Ok(Val::Data)
            }
            Cmd::RemoveItem => {
                let v = self.path_arg(a).ok_or("Remove-Item without an explicit path")?;
                let paths = self.use_paths(v, Use::Delete)?;
                if has("recurse") {
                    for p in &paths {
                        let target = if p.rsplit('/').next().is_some_and(|l| l.contains(['*', '?'])) {
                            p.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()
                        } else {
                            p.clone()
                        };
                        let mut budget = MAX_WALK;
                        if walk_problem(Path::new(&target), &mut budget, 0, true) {
                            return err("a recursive delete over a folder holding links, junctions, `.git`, `.jan` or credential files");
                        }
                    }
                }
                Ok(Val::Null)
            }
            Cmd::TestPath => {
                match self.path_arg(a) {
                    Some(v) => {
                        self.use_paths(v, Use::Read)?;
                    }
                    None if matches!(up, Up::Items(_)) => {}
                    None => return err("Test-Path without a path"),
                }
                Ok(Val::Data)
            }
            Cmd::JoinPath => {
                let base = a.get("path").ok_or("Join-Path without a base")?;
                let child = a.get("childpath").ok_or("Join-Path without a child")?;
                if has("resolve") {
                    return err("Join-Path -Resolve");
                }
                let mut abs = self.abs_path(&text_of(base).ok_or("a computed base path")?, true)?;
                let mut parts = vec![child.clone()];
                if let Some(extra) = a.get("additionalchildpath") {
                    match extra {
                        Val::List(l) => parts.extend(l.iter().cloned()),
                        other => parts.push(other.clone()),
                    }
                }
                for p in parts {
                    let t = text_of(&p).ok_or("a computed child path")?;
                    abs = self.abs_path(&format!("{abs}/{t}"), true)?;
                }
                Ok(Val::Path(abs))
            }
            Cmd::SplitPath => {
                if has("qualifier") || has("resolve") {
                    return err("Split-Path -Qualifier / -Resolve");
                }
                let raw = text_of(a.get("path").ok_or("Split-Path without a path")?)
                    .ok_or("a computed path")?;
                let abs = self.abs_path(&raw, true)?;
                let (parent, leaf) = abs.rsplit_once('/').unwrap_or(("", &abs));
                if has("leaf") || has("leafbase") || has("extension") {
                    let leaf = leaf.to_string();
                    let s = if has("extension") {
                        leaf.rsplit_once('.').map(|(_, e)| format!(".{e}")).unwrap_or_default()
                    } else if has("leafbase") {
                        leaf.rsplit_once('.').map(|(b, _)| b.to_string()).unwrap_or(leaf)
                    } else {
                        leaf
                    };
                    Ok(Val::Str(s))
                } else if has("isabsolute") || has("noqualifier") {
                    Ok(Val::Data)
                } else {
                    Ok(Val::Path(parent.to_string()))
                }
            }
            Cmd::ResolvePath => {
                let v = self.path_arg(a).ok_or("Resolve-Path without a path")?;
                let paths = self.use_paths(v, Use::Exact)?;
                match paths.as_slice() {
                    [one] => Ok(Val::Path(one.clone())),
                    _ => Ok(Val::Items(paths.into_iter().map(|p| (p, false)).collect())),
                }
            }
            Cmd::Write => Ok(Val::Data),
            Cmd::SelectString => {
                a.get("pattern").ok_or("Select-String without a pattern")?;
                match self.path_arg(a) {
                    Some(v) => {
                        self.use_paths(v, Use::Content)?;
                    }
                    None => match &up {
                        Up::Items(i) => items_readable(i)?,
                        Up::Data => {}
                        Up::None => return err("Select-String reading no input"),
                    },
                }
                Ok(Val::Data)
            }
            Cmd::Measure => Ok(Val::Data),
            Cmd::Sort | Cmd::Select | Cmd::Where => {
                if cmd == Cmd::Where && !has("filterscript") {
                    return err("Where-Object without a script block");
                }
                let shaping = has("property") || has("expandproperty");
                Ok(match up {
                    Up::Items(i) if !shaping => Val::Items(i),
                    _ => Val::Data,
                })
            }
            Cmd::ForEach => {
                if !has("process") {
                    return err("ForEach-Object without a script block");
                }
                Ok(Val::Data)
            }
            Cmd::GetLocation => {
                if !a.is_empty() || !rest.is_empty() {
                    return err("Get-Location with arguments");
                }
                Ok(Val::Path(self.cwd.clone()))
            }
            Cmd::SetLocation => {
                if self.blocks > 0 {
                    return err("a location change inside a block");
                }
                let v = self.path_arg(a).ok_or("Set-Location without a path")?;
                let paths = self.use_paths(&v.clone(), Use::Exact)?;
                match paths.as_slice() {
                    [one] => {
                        self.cwd = one.clone();
                        Ok(Val::Null)
                    }
                    _ => err("Set-Location to several paths"),
                }
            }
            Cmd::OutNull | Cmd::StrictMode => Ok(Val::Null),
        }
    }
}

/// Whether `p` is, or holds below it, a symbolic link or a junction -- and,
/// with `names`, a `.git` / `.jan` entry or a credential file. An unreadable
/// folder, or one larger than the budget, counts as a problem.
fn walk_problem(p: &Path, budget: &mut usize, depth: usize, names: bool) -> bool {
    if depth > 48 {
        return true;
    }
    if names {
        if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
            if protected_name(n) {
                return true;
            }
        }
    }
    let Ok(md) = std::fs::symlink_metadata(p) else {
        // Not there (yet): nothing to follow.
        return false;
    };
    if is_link(&md) {
        return true;
    }
    if md.is_dir() {
        let Ok(rd) = std::fs::read_dir(p) else {
            return true;
        };
        for e in rd {
            if *budget == 0 {
                return true;
            }
            *budget -= 1;
            match e {
                Ok(e) => {
                    if walk_problem(&e.path(), budget, depth + 1, names) {
                        return true;
                    }
                }
                Err(_) => return true,
            }
        }
    }
    false
}

fn protected_name(n: &str) -> bool {
    n.eq_ignore_ascii_case(".git")
        || n.eq_ignore_ascii_case(".jan")
        || crate::project_browse::is_sensitive_name(n)
}

/// The folder a listing path covers: the path itself, or the parent of a
/// wildcard pattern.
fn wildcard_parent(p: &str) -> String {
    match p.rsplit_once('/') {
        Some((d, last)) if last.contains(['*', '?']) => d.to_string(),
        _ => p.to_string(),
    }
}

/// Listed paths whose contents may be read: nothing under them (or, for a
/// non-recursive listing, directly in them) is a credential file, `.git`,
/// `.jan` or a link. Checked against the disk as it is now.
fn items_readable(items: &[(String, bool)]) -> R<()> {
    for (p, recursive) in items {
        let dir = wildcard_parent(p);
        let path = Path::new(&dir);
        let mut budget = MAX_WALK;
        let bad = if *recursive {
            walk_problem(path, &mut budget, 0, true)
        } else {
            match std::fs::symlink_metadata(path) {
                Err(_) => false,
                Ok(md) if !md.is_dir() => walk_problem(path, &mut budget, 0, true),
                Ok(_) => match std::fs::read_dir(path) {
                    Err(_) => true,
                    Ok(rd) => rd
                        .flatten()
                        .any(|e| protected_name(&e.file_name().to_string_lossy())),
                },
            }
        };
        if bad {
            return err("a listing that feeds a reader holds credential files, `.git`, `.jan` or links");
        }
    }
    Ok(())
}

/// Whether the glob `pattern` (one path component) could match a name that
/// is a credential file, `.git` or `.jan`.
fn glob_reaches_protected(pattern: &str) -> bool {
    let candidates = [
        ".git", ".jan", ".env", ".env.local", ".env.production", ".npmrc", ".netrc", ".pgpass",
        "credentials", "credentials.json", "service-account.json", "id_rsa", "id_ed25519",
        "id_ecdsa", "id_rsa.pub", "x.pem", "x.key", "x.p12", "x.pfx", "x.keystore", "x.jks",
        "x.asc", "x.gpg", "x.kdbx",
    ];
    let pat: Vec<char> = pattern.to_ascii_lowercase().chars().collect();
    candidates.iter().any(|c| {
        let name: Vec<char> = c.chars().collect();
        glob_match(&pat, &name)
    })
}

/// `*` and `?` glob match; the caller folds ASCII case.
fn glob_match(pat: &[char], s: &[char]) -> bool {
    match pat.split_first() {
        None => s.is_empty(),
        Some((&'*', rest)) => (0..=s.len()).any(|i| glob_match(rest, &s[i..])),
        Some((&'?', rest)) => !s.is_empty() && glob_match(rest, &s[1..]),
        Some((c, rest)) => s.first() == Some(c) && glob_match(rest, &s[1..]),
    }
}

#[cfg(windows)]
fn is_link(md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    md.file_attributes() & 0x400 != 0 || md.file_type().is_symlink()
}

#[cfg(not(windows))]
fn is_link(md: &std::fs::Metadata) -> bool {
    md.file_type().is_symlink()
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Pk {
    Sw,
    Path,
    Val,
    Blk,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Cmd {
    GetChildItem,
    GetItem,
    GetContent,
    SetContent,
    AddContent,
    OutFile,
    NewItem,
    Mkdir,
    RemoveItem,
    TestPath,
    JoinPath,
    SplitPath,
    ResolvePath,
    Write,
    SelectString,
    Measure,
    Sort,
    Select,
    Where,
    ForEach,
    GetLocation,
    SetLocation,
    OutNull,
    StrictMode,
}

struct Spec {
    cmd: Cmd,
    params: &'static [(&'static str, Pk)],
    /// Accepted spellings besides the full name: (spelling, canonical).
    abbr: &'static [(&'static str, &'static str)],
    /// Canonical names of the positional slots, in order.
    pos: &'static [&'static str],
    variadic: bool,
    blocks: bool,
}

impl Spec {
    fn param(&self, raw: &str) -> Option<(&'static str, Pk)> {
        let n = raw.trim_start_matches('-').to_ascii_lowercase();
        let by_name = |n: &str| {
            self.params
                .iter()
                .chain(COMMON.iter())
                .find(|(p, _)| *p == n)
                .copied()
        };
        if let Some(hit) = by_name(&n) {
            return Some(hit);
        }
        let canon = self
            .abbr
            .iter()
            .chain([("ea", "erroraction")].iter())
            .find(|(s, _)| *s == n)
            .map(|(_, c)| *c)?;
        by_name(canon)
    }
}

const COMMON: &[(&str, Pk)] = &[("erroraction", Pk::Val), ("whatif", Pk::Sw)];

use Pk::{Blk, Path as P, Sw, Val as V};

fn mk(
    cmd: Cmd,
    params: &'static [(&'static str, Pk)],
    abbr: &'static [(&'static str, &'static str)],
    pos: &'static [&'static str],
    variadic: bool,
    blocks: bool,
) -> Spec {
    Spec { cmd, params, abbr, pos, variadic, blocks }
}

fn spec_for(name: &str) -> Option<Spec> {
    Some(match name {
        "get-childitem" | "gci" | "ls" | "dir" => mk(
            Cmd::GetChildItem,
            &[
                ("path", P), ("literalpath", P), ("filter", V), ("include", V), ("exclude", V),
                ("recurse", Sw), ("force", Sw), ("name", Sw), ("file", Sw), ("directory", Sw),
                ("depth", V),
            ],
            &[("r", "recurse"), ("lp", "literalpath"), ("ad", "directory"), ("af", "file")],
            &["path"], false, false,
        ),
        "get-item" | "gi" => mk(
            Cmd::GetItem,
            &[("path", P), ("literalpath", P), ("filter", V), ("include", V), ("exclude", V), ("force", Sw)],
            &[("lp", "literalpath")],
            &["path"], false, false,
        ),
        "get-content" | "gc" | "cat" | "type" => mk(
            Cmd::GetContent,
            &[
                ("path", P), ("literalpath", P), ("totalcount", V), ("tail", V), ("raw", Sw),
                ("encoding", V), ("readcount", V), ("force", Sw),
            ],
            &[("lp", "literalpath"), ("head", "totalcount"), ("first", "totalcount"), ("last", "tail")],
            &["path"], false, false,
        ),
        "set-content" => mk(
            Cmd::SetContent,
            &[
                ("path", P), ("literalpath", P), ("value", V), ("encoding", V), ("force", Sw),
                ("nonewline", Sw), ("passthru", Sw),
            ],
            &[("lp", "literalpath")],
            &["path", "value"], false, false,
        ),
        "add-content" | "ac" => mk(
            Cmd::AddContent,
            &[
                ("path", P), ("literalpath", P), ("value", V), ("encoding", V), ("force", Sw),
                ("nonewline", Sw), ("passthru", Sw),
            ],
            &[("lp", "literalpath")],
            &["path", "value"], false, false,
        ),
        "out-file" => mk(
            Cmd::OutFile,
            &[
                ("filepath", P), ("path", P), ("literalpath", P), ("encoding", V), ("append", Sw),
                ("force", Sw), ("nonewline", Sw), ("width", V), ("noclobber", Sw), ("inputobject", V),
            ],
            &[("lp", "literalpath")],
            &["filepath"], false, false,
        ),
        "new-item" | "ni" => mk(
            Cmd::NewItem,
            &[("path", P), ("name", V), ("itemtype", V), ("value", V), ("force", Sw)],
            &[("type", "itemtype")],
            &["path"], false, false,
        ),
        "mkdir" | "md" => mk(
            Cmd::Mkdir,
            &[("path", P), ("name", V), ("force", Sw)],
            &[],
            &["path"], false, false,
        ),
        "remove-item" | "ri" | "rm" | "del" | "erase" | "rmdir" | "rd" => mk(
            Cmd::RemoveItem,
            &[
                ("path", P), ("literalpath", P), ("recurse", Sw), ("force", Sw), ("filter", V),
                ("include", V), ("exclude", V),
            ],
            &[("r", "recurse"), ("lp", "literalpath")],
            &["path"], false, false,
        ),
        "test-path" => mk(
            Cmd::TestPath,
            &[
                ("path", P), ("literalpath", P), ("pathtype", V), ("isvalid", Sw), ("include", V),
                ("exclude", V), ("filter", V),
            ],
            &[("lp", "literalpath")],
            &["path"], false, false,
        ),
        "join-path" => mk(
            Cmd::JoinPath,
            &[
                ("path", V), ("childpath", V), ("additionalchildpath", V), ("resolve", Sw),
            ],
            &[],
            &["path", "childpath", "additionalchildpath"], false, false,
        ),
        "split-path" => mk(
            Cmd::SplitPath,
            &[
                ("path", V), ("parent", Sw), ("leaf", Sw), ("leafbase", Sw), ("extension", Sw),
                ("qualifier", Sw), ("noqualifier", Sw), ("isabsolute", Sw), ("resolve", Sw),
            ],
            &[],
            &["path"], false, false,
        ),
        "resolve-path" | "rvpa" => mk(
            Cmd::ResolvePath,
            &[("path", P), ("literalpath", P)],
            &[("lp", "literalpath")],
            &["path"], false, false,
        ),
        "write-output" | "write" | "echo" => mk(
            Cmd::Write,
            &[("inputobject", V), ("noenumerate", Sw)],
            &[],
            &[], true, false,
        ),
        "write-host" => mk(
            Cmd::Write,
            &[
                ("object", V), ("nonewline", Sw), ("separator", V), ("foregroundcolor", V),
                ("backgroundcolor", V),
            ],
            &[],
            &[], true, false,
        ),
        "select-string" | "sls" => mk(
            Cmd::SelectString,
            &[
                ("pattern", V), ("path", P), ("literalpath", P), ("simplematch", Sw),
                ("casesensitive", Sw), ("notmatch", Sw), ("quiet", Sw), ("context", V),
                ("list", Sw), ("allmatches", Sw), ("encoding", V),
            ],
            &[("lp", "literalpath")],
            &["pattern", "path"], false, false,
        ),
        "measure-object" | "measure" => mk(
            Cmd::Measure,
            &[
                ("property", V), ("line", Sw), ("word", Sw), ("character", Sw), ("sum", Sw),
                ("average", Sw), ("maximum", Sw), ("minimum", Sw), ("ignorewhitespace", Sw),
            ],
            &[],
            &["property"], false, false,
        ),
        "sort-object" | "sort" => mk(
            Cmd::Sort,
            &[
                ("property", V), ("descending", Sw), ("unique", Sw), ("casesensitive", Sw),
                ("top", V),
            ],
            &[],
            &["property"], false, false,
        ),
        "select-object" | "select" => mk(
            Cmd::Select,
            &[
                ("property", V), ("first", V), ("last", V), ("skip", V), ("unique", Sw),
                ("expandproperty", V), ("index", V),
            ],
            &[],
            &["property"], false, false,
        ),
        "where-object" | "where" => mk(
            Cmd::Where,
            &[("filterscript", Blk)],
            &[],
            &["filterscript"], false, true,
        ),
        "foreach-object" | "foreach" => mk(
            Cmd::ForEach,
            &[("process", Blk)],
            &[],
            &["process"], false, true,
        ),
        "get-location" | "gl" | "pwd" => mk(Cmd::GetLocation, &[], &[], &[], false, false),
        "set-location" | "sl" | "cd" | "chdir" => mk(
            Cmd::SetLocation,
            &[("path", P), ("literalpath", P)],
            &[("lp", "literalpath")],
            &["path"], false, false,
        ),
        "out-null" => mk(Cmd::OutNull, &[], &[], &[], false, false),
        "set-strictmode" => mk(
            Cmd::StrictMode,
            &[("version", V), ("off", Sw)],
            &[],
            &[], false, false,
        ),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    struct Env {
        root: PathBuf,
        outside: PathBuf,
    }

    fn env() -> &'static Env {
        static ENV: OnceLock<Env> = OnceLock::new();
        ENV.get_or_init(|| {
            let base = std::env::temp_dir().join(format!("flint-pwsh-scan-{}", std::process::id()));
            let root = base.join("work tree");
            let outside = base.join("outside");
            std::fs::create_dir_all(root.join("src")).unwrap();
            std::fs::create_dir_all(root.join("build")).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(root.join("src").join("a.txt"), "x").unwrap();
            Env {
                root: std::fs::canonicalize(&root).unwrap(),
                outside: std::fs::canonicalize(&outside).unwrap(),
            }
        })
    }

    fn scan(script: &str) -> PwshScan {
        classify_in(script, &env().root, None, &[])
    }

    fn ok(script: &str) {
        let got = scan(script);
        assert!(got.is_contained(), "should be contained: {script}\n  -> {got:?}");
    }

    fn no(script: &str) {
        let got = scan(script);
        assert!(!got.is_contained(), "must NOT be contained: {script}");
    }

    fn root_str() -> String {
        env().root.to_string_lossy().trim_start_matches(r"\\?\").to_string()
    }

    fn outside_str() -> String {
        env().outside.to_string_lossy().trim_start_matches(r"\\?\").to_string()
    }

    // --- allowed -----------------------------------------------------------

    #[test]
    fn the_qa_probe_script_is_contained() {
        ok("$probe = Join-Path (Get-Location) 'qa-probe'\n\
            New-Item -ItemType Directory -Path $probe | Out-Null\n\
            Set-Content -Path (Join-Path $probe 'hello.txt') -Value 'hi'\n\
            Get-Content (Join-Path $probe 'hello.txt')\n\
            Test-Path $probe\n\
            Remove-Item -Recurse -Force $probe\n\
            Write-Output 'done'");
    }

    #[test]
    fn typical_scaffold_scripts_are_contained() {
        ok("New-Item -ItemType Directory -Path .\\build\\out -Force | Out-Null");
        ok("mkdir build\\gen");
        ok("Set-Content -Path build\\notes.txt -Value 'hello'");
        ok("'hello' | Out-File -FilePath build\\o.txt -Encoding utf8");
        ok("Add-Content build\\notes.txt 'more'");
        ok("Get-ChildItem src -Recurse | Select-String 'TODO' | Measure-Object");
        ok("ls src | Sort-Object Name | Select-Object -First 3");
        ok("Get-ChildItem -Path src -Filter *.txt | Where-Object { $_.Length -gt 0 } | ForEach-Object { Write-Output $_.Name }");
        ok("$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\nWrite-Host 'ok' -ForegroundColor Green");
        ok("if (Test-Path build\\x) { Remove-Item build\\x -Recurse -Force } else { New-Item -ItemType Directory -Path build\\x | Out-Null }");
        ok("foreach ($n in 'a','b','c') { Set-Content -Path (Join-Path 'build' \"$n.txt\") -Value $n }");
        ok("foreach ($i in 1..3) { New-Item -Path build\\d$i -ItemType Directory | Out-Null }");
        ok("$f = 'build\\gen.txt'; Set-Content $f 'x'; Get-Content $f; Remove-Item $f");
        ok("Set-Location build; New-Item -Path out.txt -ItemType File | Out-Null; Remove-Item out.txt");
        ok("git status");
        ok("git log --oneline -5");
        ok("git diff --stat | Measure-Object -Line");
        ok("@'\nline with $(Get-Date) and ; rm -rf C:\\\n'@ | Set-Content build\\h.txt");
        ok("Remove-Item .\\build\\*.tmp -ErrorAction SilentlyContinue");
        ok("(Get-Location).Path | Write-Output");
        ok("$dir = Split-Path -Parent 'src\\a.txt'; Get-ChildItem $dir");
        ok(&format!("Set-Content -Path '{}\\build\\abs.txt' -Value 'x'", root_str()));
        ok(&format!("Remove-Item -Recurse '{}\\build\\out'", root_str()));
        ok("# a comment\nGet-ChildItem # trailing\n");
    }

    #[test]
    fn scratch_and_granted_roots_are_allowed() {
        let base = std::env::temp_dir().join(format!("flint-pwsh-extra-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let extra = std::fs::canonicalize(&base).unwrap();
        let p = format!("{}\\x.txt", extra.to_string_lossy().trim_start_matches(r"\\?\"));
        let script = format!("Set-Content -Path '{p}' -Value 1");
        assert!(!classify_in(&script, &env().root, None, &[]).is_contained());
        assert!(classify_in(&script, &env().root, Some(&extra), &[]).is_contained());
        assert!(classify_in(&script, &env().root, None, &[extra.clone()]).is_contained());
        let _ = std::fs::remove_dir_all(base);
    }

    // --- adversarial -------------------------------------------------------

    #[test]
    fn escapes_by_parent_traversal_are_refused() {
        no("Remove-Item ..\\x -Recurse");
        no("Set-Content ..\\..\\x.txt 'x'");
        no("Remove-Item build\\..\\..\\x -Recurse");
        no("Set-Location ..; Remove-Item x");
        no("Set-Location ..\\..\n Remove-Item -Recurse -Force .\\x");
        no("$p = '..'; Remove-Item $p -Recurse");
        no("$p = Join-Path (Get-Location) '..\\x'; Remove-Item $p");
        no("(Split-Path -Parent (Get-Location)) | Set-Location");
        no("Remove-Item (Split-Path -Parent (Get-Location)) -Recurse");
    }

    #[test]
    fn escapes_by_absolute_paths_are_refused() {
        no("Remove-Item -Recurse -Force C:\\");
        no("Remove-Item -Recurse -Force C:\\Windows\\Temp\\x");
        no(&format!("Remove-Item -Recurse '{}\\x'", outside_str()));
        no(&format!("Set-Content '{}\\x.txt' 'x'", outside_str()));
        no("Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts");
        no("Set-Content \\\\server\\share\\x 'x'");
        no("Set-Content \\\\?\\C:\\x 'x'");
        no("Set-Content //server/share/x 'x'");
        no("Remove-Item \\Windows -Recurse");
        no("Set-Content D:x.txt 'x'");
        no("Set-Content ~\\x.txt 'x'");
        no("Remove-Item ~ -Recurse");
        no("Remove-Item $HOME -Recurse");
        no("Remove-Item /etc -Recurse");
    }

    #[test]
    fn computed_and_hidden_paths_are_refused() {
        no("$a = 'C:\\Wi'; $b = $a + 'ndows'; Remove-Item $b -Recurse");
        no("$a = 'C:\\Win'; Remove-Item \"${a}dows\" -Recurse");
        no("Remove-Item \"$env:USERPROFILE\\x\" -Recurse");
        no("Remove-Item $env:TEMP -Recurse");
        no("Set-Content \"$env:APPDATA\\x\" 'x'");
        no("[IO.Path]::Combine('C:\\', 'Windows') | Remove-Item -Recurse");
        no("Remove-Item ([IO.Path]::GetTempPath()) -Recurse");
        no("$x = (Get-ChildItem).FullName; Remove-Item $x");
        no("Get-ChildItem | ForEach-Object { Remove-Item $_.FullName -Recurse }");
        no("Get-ChildItem | Remove-Item -Recurse");
        no("'C:\\Windows\\x' | Remove-Item");
        no("'C:\\Windows\\win.ini' | Get-Content");
        no("Remove-Item $undefined");
        no("Remove-Item (Read-Host)");
        no("Remove-Item -Path:C:\\x");
        no("Remove-Item HKLM:\\Software\\x -Recurse");
        no("Set-Content Env:Path 'x'");
        no("Remove-Item Cert:\\CurrentUser\\My -Recurse");
        no("Set-Content build\\a.txt:stream 'x'");
        no("Set-Content PROGRA~1\\x 'x'");
        no("Set-Content build\\nul 'x'");
        no("Set-Content build\\.git. 'x'");
        no("Set-Content build\\x%TEMP%.txt 'x'");
    }

    #[test]
    fn protected_names_are_refused() {
        no("Set-Content .git\\config 'x'");
        no("Set-Content src\\.git\\hooks\\pre-commit 'x'");
        no("Remove-Item .git -Recurse -Force");
        no("Set-Content .jan\\agent\\agent.toml 'x'");
        no("Get-Content .env");
        no("Set-Content .env 'KEY=1'");
        no("Remove-Item id_rsa");
        no("Get-Content build\\server.pem");
    }

    #[test]
    fn bulk_deletes_at_the_root_still_ask() {
        no("Remove-Item * -Recurse -Force");
        no("Remove-Item .\\* -Recurse");
        no("Remove-Item . -Recurse -Force");
        no("Remove-Item -Recurse -Force -Path .");
        no(&format!("Remove-Item -Recurse -Force '{}'", root_str()));
        no(&format!("Remove-Item -Recurse -Force '{}\\*'", root_str()));
        no("Remove-Item *\\x -Recurse");
        no("Remove-Item src\\*\\a.txt");
        no("Get-ChildItem | Remove-Item -Recurse -Force");
    }

    #[test]
    fn code_execution_and_indirection_are_refused() {
        no("Invoke-Expression 'Remove-Item C:\\ -Recurse'");
        no("iex 'ls'");
        no("& 'C:\\Windows\\System32\\cmd.exe' /c dir");
        no("& $cmd");
        no(". .\\profile.ps1");
        no(".\\script.ps1");
        no("powershell -EncodedCommand AAAA");
        no("pwsh -c 'rm -rf C:\\'");
        no("Start-Process notepad");
        no("Invoke-WebRequest https://example.com -OutFile build\\x");
        no("curl https://example.com");
        no("wget https://example.com");
        no("Invoke-RestMethod https://example.com");
        no("Add-Type -TypeDefinition 'class A {}'");
        no("[System.Reflection.Assembly]::LoadFile('x')");
        no("Set-ExecutionPolicy Bypass");
        no("Set-Alias rm Get-ChildItem");
        no("New-Alias ls Remove-Item");
        no("sal ls Remove-Item");
        no("function Remove-Item { }");
        no("Get-ChildItem | sh");
        no("'rm -rf /' | bash");
        no("cmd /c rmdir /s /q build");
        no("Get-ChildItem | % { Remove-Item $_ }");
        no("Get-ChildItem | ? { $true }");
        no("Write-Output $(Remove-Item x)");
        no("Write-Output \"$(Remove-Item x)\"");
        no("$x = { Remove-Item x }; & $x");
        no("Get-Content x | ForEach-Object { iex $_ }");
        no("Get-ChildItem | ForEach-Object { & $_ }");
        no("Invoke-Command -ScriptBlock { ls }");
        no("Import-Module x");
        no("Register-ScheduledTask x");
        no("Set-ItemProperty HKCU:\\x y 1");
        no("Copy-Item build\\a build\\b");
        no("Move-Item build\\a build\\b");
        no("Rename-Item build\\a b");
    }

    #[test]
    fn links_and_junctions_are_refused() {
        no("New-Item -ItemType SymbolicLink -Path build\\l -Target C:\\Windows");
        no("New-Item -ItemType Junction -Path build\\j -Value C:\\Windows");
        no("New-Item -ItemType HardLink -Path build\\h -Value src\\a.txt");
        no("cmd /c mklink /J build\\j C:\\Windows");
        no("New-Item -Path build\\x -ItemType Directory; New-Item -Path build\\l -ItemType SymbolicLink -Value C:\\");
    }

    #[test]
    fn quoting_and_syntax_tricks_are_refused() {
        no("Remove-Item 'C:\\Win'\"dows\" -Recurse");
        no("Remove-Item C:\\Win'dows' -Recurse");
        no("Remove-Item build\\a`\nC:\\Windows");
        no("Remove-Item `C:\\Windows");
        no("Remove-Item C:\\Windows -Recurse > build\\log.txt");
        no("Get-Content build\\a < build\\b");
        no("Write-Output a 2>&1");
        no("Remove-Item build\\a && Remove-Item C:\\x");
        no("Get-ChildItem || Remove-Item C:\\x");
        no("Remove-Item @args");
        no("$h = @{ Path = 'C:\\x' }; Remove-Item @h");
        no("Remove-Item @('C:\\x')");
        no("Write-Output \u{2018}x\u{2019}");
        no("Remove-Item \u{2013}Recurse C:\\x");
        no("Remove-Item build\\a\u{00A0}C:\\x");
        no("Write-Output 'unterminated");
        no("Write-Output \"unterminated");
        no("Write-Output @'\nunterminated");
        no("Write-Output ${env:Path}");
        no("Write-Output $?");
        no("Write-Output $x:y");
        no("Write-Output (Get-Date).AddDays(1)");
        no("$a[0]");
        no("");
        no("   \n  ");
    }

    #[test]
    fn variable_and_state_tricks_are_refused() {
        no("$PSDefaultParameterValues = @{}");
        no("$env = 'x'");
        no("$PWD = 'C:\\'");
        no("$_ = 'C:\\'");
        no("$ErrorActionPreference = 'Stop'; $x = $ofs");
        no("if ($true) { $p = 'C:\\Windows' } else { $p = 'build' }\nRemove-Item $p -Recurse");
        no("$p = 'build'\nif ($true) { $p = 'C:\\Windows' }\nRemove-Item $p -Recurse");
        no("foreach ($p in 'build','C:\\Windows') { Remove-Item $p -Recurse }");
        no("foreach ($p in Get-ChildItem) { Remove-Item $p -Recurse }");
        no("Get-ChildItem | ForEach-Object { $q = 'C:\\Windows' }\nRemove-Item $q");
        no("1..1000 | ForEach-Object { 1 }; foreach ($i in 1..1000) { Write-Output $i }");
        no("if ($true) { Set-Location C:\\Windows }");
        no("foreach ($i in 1..2) { Set-Location .. }");
        no("Set-Location -");
        no("Push-Location C:\\");
        no("Set-Location build; Set-Location ..\\..; Remove-Item x");
    }

    #[test]
    fn what_posix_scripts_look_like_is_refused() {
        no("ls -la");
        no("rm -rf build");
        no("cat src/a.txt | grep x");
        no("echo hi > out.txt");
        no("mkdir -p a/b");
        no("cd .. && rm -rf x");
        no("npm test");
        no("cargo test");
        no("git push origin main");
        no("git reset --hard");
        no("git -C .. status");
        no("git status; git push --force");
        no("git log --output=build\\x");
        no("git diff --ext-diff");
    }

    // --- review findings (adversarial review of 66035d7fb) ------------------

    #[test]
    fn a_bare_word_block_argument_is_not_a_script() {
        no("Get-ChildItem -Recurse -Force | ForEach-Object Delete");
        no("Get-ChildItem | ForEach-Object 'Delete'");
        no("Get-ChildItem | Where-Object Name");
        no("Get-ChildItem | ForEach-Object -Process Delete");
        no("Get-ChildItem | ForEach-Object -MemberName Delete");
        ok("Get-ChildItem src | ForEach-Object { $_.Name }");
    }

    #[test]
    fn a_lone_carriage_return_is_a_line_break() {
        no("Write-Output hi # x\rStart-Process calc");
        no("Write-Output ok\riex 'any code'");
        no("Write-Output a\rRemove-Item C:\\x");
        no("# c\rStart-Process calc");
        ok("Write-Output a\r\nWrite-Output b");
    }

    #[test]
    fn wildcards_and_pipelines_cannot_reach_credentials_or_git() {
        no("Get-Content .env*");
        no("Get-Content *.pem");
        no("Get-Content .e?v");
        no("Get-Content *");
        no("Get-Content id_*");
        no("Select-String -Pattern 'key' -Path .env*");
        no("Remove-Item .g* -Recurse -Force");
        no("Remove-Item src\\.g* -Recurse -Force");
        no("Remove-Item src\\.j* -Recurse -Force");
        no("Remove-Item src\\* -Recurse -Force");
        ok("Get-Content src\\*.txt");
        ok("Remove-Item build\\*.tmp");
    }

    #[test]
    fn listings_that_feed_readers_are_name_checked() {
        let guarded = env().root.join("guarded");
        std::fs::create_dir_all(guarded.join(".git")).unwrap();
        std::fs::write(guarded.join(".env"), "KEY=1").unwrap();
        std::fs::write(env().root.join("src").join("note.txt"), "x").unwrap();
        no("Get-ChildItem guarded -Recurse -Force | Get-Content");
        no("Get-ChildItem guarded -Force | Get-Content");
        no("Get-ChildItem guarded -Recurse -Force | Select-String -Pattern 'password|token|key'");
        no("Get-ChildItem guarded | Where-Object { $true } | Select-String x");
        no("Remove-Item guarded -Recurse -Force");
        ok("Get-ChildItem src | Get-Content");
        ok("Get-ChildItem src -Recurse | Select-String 'x'");
        let _ = std::fs::remove_dir_all(guarded);
    }

    #[test]
    fn a_root_or_its_ancestor_is_never_deleted() {
        let base = std::env::temp_dir().join(format!("flint-pwsh-nest-{}", std::process::id()));
        let inner = base.join("project");
        std::fs::create_dir_all(&inner).unwrap();
        let outer = std::fs::canonicalize(&base).unwrap();
        let project = std::fs::canonicalize(&inner).unwrap();
        // The project sits under a granted root: still not deletable.
        let s = |script: &str| classify_in(script, &project, None, &[outer.clone()]);
        assert!(!s("Remove-Item -Recurse -Force .").is_contained());
        assert!(!s("Remove-Item -Recurse -Force ..\\project").is_contained());
        assert!(!s("Remove-Item -Recurse -Force *").is_contained());
        let abs = outer.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        assert!(!s(&format!("Remove-Item -Recurse -Force '{abs}'")).is_contained());
        assert!(s("New-Item -ItemType Directory -Path sub | Out-Null").is_contained());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn git_option_abbreviations_and_file_patterns_are_refused() {
        no("git diff --ext-d");
        no("git diff --ext");
        no("git log --out=build\\x");
        no("git show --textc");
        no("git log -Obuild\\orderfile");
        no("git grep -f build\\patterns");
        no("git grep -ffile x");
        ok("git diff --stat");
        ok("git log --oneline -3");
    }

    #[test]
    fn a_junction_inside_the_root_is_followed() {
        #[cfg(windows)]
        {
            let link = env().root.join("jlink");
            let _ = std::fs::remove_dir(&link);
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&env().outside)
                .output();
            if status.is_ok_and(|o| o.status.success()) {
                no("Set-Content jlink\\x.txt 'x'");
                no("Remove-Item jlink\\x.txt");
                no("Remove-Item jlink -Recurse");
                // Recursing over a folder that holds one is refused too.
                no("Remove-Item . -Recurse");
                no("Get-ChildItem build | Remove-Item");
                let _ = std::fs::remove_dir(&link);
            }
        }
    }
}
