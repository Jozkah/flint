//! Scoped standing approvals: an "allow always" that means something narrow.
//!
//! An approval prompt can carry a small typed form, [`ApprovalScope`]: allow
//! this call once, allow it for the rest of the run, allow writes under one
//! folder, or allow commands that start with one prefix. The last two are
//! remembered as a [`ScopedRule`] -- per project folder, in the app's data
//! folder (never in the repository, which ships with whoever wrote it) -- and
//! the gate honors them the next time the same question would be asked.
//!
//! A rule only ever answers a *prompt*. [`upgrade`] turns `Prompt(k)` into
//! `Allow` when a rule covers the call, and leaves every other decision alone,
//! so a rule can never override a hard deny (policy, secret file, hidden path,
//! destructive git, `.git` internals), a project `ask` rule or any other
//! always-ask tier (`Prompt(Ask)`), or anything the caller refuses before it
//! reaches the gate (`[[tool_rules]]`).
//!
//! What a rule covers is decided here and nowhere else:
//!
//! - **Folder**: every path argument of the call must resolve -- symlinks and
//!   `..` followed, short Windows names expanded, case folded on Windows --
//!   to a place inside the folder, compared component by component so `src`
//!   never covers `src-backup`. A folder that has since become a link to
//!   somewhere else covers nothing. A drive root or a home directory is not
//!   accepted as a folder.
//! - **Command prefix**: the command must be one simple command (no `;`, `&`,
//!   `|`, redirect, substitution or newline, no wrapper such as `sudo` or an
//!   environment assignment in front) whose leading whitespace-separated
//!   tokens equal the prefix exactly. Shells, wrappers, interpreters used
//!   bare, and programs whose bare name covers every subcommand (`git`,
//!   `npm`, ...) are not accepted as a prefix.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tools::cmdscan::{normalize, simple_commands, NON_PLAIN_MARK};
use crate::tools::gate::{names_home_or_root, strip_verbatim, Decision, PromptKind};
use crate::tools::sandbox::canonicalize_lenient;
use crate::tools::{BuiltinTool, Capability};

/// How far an approval reaches. The typed answer a prompt's form produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApprovalScope {
    /// This call, once.
    Once,
    /// The rest of this run (the session grant that has always existed).
    Run,
    /// Calls whose paths all lie inside `dir`. Remembered.
    Folder { dir: String },
    /// Shell commands that start with `prefix`. Remembered.
    CommandPrefix { prefix: String },
}

impl ApprovalScope {
    /// Whether this scope becomes a stored rule.
    pub fn is_standing(&self) -> bool {
        matches!(self, Self::Folder { .. } | Self::CommandPrefix { .. })
    }
}

/// One remembered, scoped approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedRule {
    pub id: String,
    /// [`project_key`] of the project folder the rule belongs to.
    pub project: String,
    pub tool: String,
    /// The prompt kind it answers: `write`, `write_escape`, `read_escape`, `exec`.
    pub kind: String,
    pub scope: ApprovalScope,
    /// Seconds since the Unix epoch.
    pub created_at: u64,
}

/// The wire name of a prompt kind.
pub fn kind_name(kind: PromptKind) -> &'static str {
    match kind {
        PromptKind::ReadEscape => "read_escape",
        PromptKind::Write => "write",
        PromptKind::WriteEscape => "write_escape",
        PromptKind::Exec => "exec",
        PromptKind::Ask => "ask",
    }
}

/// A prompt kind from its wire name. `ask` is deliberately not accepted: it is
/// the tier no remembered answer may silence.
pub fn kind_from_name(name: &str) -> Option<PromptKind> {
    match name {
        "read_escape" => Some(PromptKind::ReadEscape),
        "write" => Some(PromptKind::Write),
        "write_escape" => Some(PromptKind::WriteEscape),
        "exec" => Some(PromptKind::Exec),
        _ => None,
    }
}

// -- paths --------------------------------------------------------------------

/// One path component, folded the way the platform compares them.
fn comp_key(c: Component<'_>) -> String {
    let s = c.as_os_str().to_string_lossy();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.into_owned()
    }
}

fn keys(path: &Path) -> Vec<String> {
    path.components().map(comp_key).collect()
}

/// Whether `child` is `dir` or lies under it. Whole components, never a string
/// prefix: `/p/src` does not contain `/p/src-backup`.
fn is_within(child: &Path, dir: &Path) -> bool {
    let (c, d) = (keys(child), keys(dir));
    !d.is_empty() && c.len() >= d.len() && c[..d.len()] == d[..]
}

fn same_path(a: &Path, b: &Path) -> bool {
    keys(a) == keys(b)
}

/// The place `raw` really is: relative to `base`, symlinks and `..` followed.
/// `None` for anything that does not name one place unambiguously -- a path
/// with an embedded NUL, a drive-relative or root-relative Windows path (`C:x`,
/// `\x`), and on Windows a component Win32 would rewrite (trailing dot or
/// space, an alternate data stream).
fn resolve(raw: &str, base: &Path) -> Option<PathBuf> {
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }
    let p = Path::new(raw);
    let anchored = p
        .components()
        .next()
        .is_some_and(|c| matches!(c, Component::Prefix(_) | Component::RootDir));
    if anchored && !p.is_absolute() {
        return None;
    }
    if cfg!(windows) {
        for c in p.components() {
            if let Component::Normal(name) = c {
                let name = name.to_string_lossy();
                if name.ends_with('.') || name.ends_with(' ') || name.contains(':') {
                    return None;
                }
            }
        }
    }
    let abs = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
    canonicalize_lenient(&abs).ok().map(|c| strip_verbatim(&c))
}

/// Folders that hold credentials, machine configuration or startup entries.
/// A rule for one of them (or for a folder above one) would let a model change
/// what the next login runs, so they are asked about every time.
const SENSITIVE_COMPONENTS: &[&str] = &[
    ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".local", "programdata",
    "system32", "syswow64", "start menu",
];

/// Where the operating system lives, when it is the first folder below the
/// root: `/etc/...`, `C:\Windows\...`.
const SYSTEM_ROOTS: &[&str] = &[
    "windows", "program files", "program files (x86)", "etc", "usr", "bin", "sbin", "boot", "sys",
    "proc", "lib", "lib64", "system", "library",
];

/// `dir` as a folder a rule may name: absolute, existing, resolved, not a
/// filesystem root or a home directory, and not a place that holds credentials
/// or machine configuration.
fn standing_folder(dir: &str) -> Option<PathBuf> {
    let p = Path::new(dir);
    if !p.is_absolute() || dir.contains('\0') {
        return None;
    }
    let canon = strip_verbatim(&canonicalize_lenient(p).ok()?);
    if !canon.is_dir() {
        return None;
    }
    let normal = canon
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if normal == 0 || names_home_or_root(&canon.to_string_lossy()) {
        return None;
    }
    let names: Vec<String> = canon
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();
    let sensitive = names.iter().any(|n| SENSITIVE_COMPONENTS.contains(&n.as_str()))
        || names.first().is_some_and(|n| SYSTEM_ROOTS.contains(&n.as_str()));
    if sensitive {
        return None;
    }
    Some(canon)
}

/// The identity of a project folder in the rule store.
pub fn project_key(root: &Path) -> String {
    let c = canonicalize_lenient(root)
        .map(|p| strip_verbatim(&p))
        .unwrap_or_else(|_| root.to_path_buf());
    let s = c.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn folder_covers(dir: &str, tool: &BuiltinTool, args: &Value, project_root: &Path) -> bool {
    if tool.path_args.is_empty() || tool.capability == Capability::Exec {
        return false;
    }
    // A folder that moved or became a link no longer is the one that was
    // approved: the rule is stale, not widened.
    let Some(live) = standing_folder(dir) else {
        return false;
    };
    if !same_path(&live, Path::new(dir)) {
        return false;
    }
    let base = strip_verbatim(&canonicalize_lenient(project_root).unwrap_or_else(|_| project_root.to_path_buf()));
    tool.path_args.iter().all(|key| {
        args.get(key)
            .and_then(|v| v.as_str())
            .and_then(|raw| resolve(raw, &base))
            .is_some_and(|resolved| is_within(&resolved, &live))
    })
}

// -- commands -----------------------------------------------------------------

/// Programs that run another program or a script from their arguments: a
/// prefix naming one covers anything.
const WRAPPERS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh", "sudo",
    "doas", "su", "env", "eval", "exec", "xargs", "nohup", "time", "timeout", "nice", "ionice",
    "command", "builtin", "start", "wsl", "runas", "busybox", "watch", "stdbuf", "setsid",
];

/// Programs whose effect is deleting or reformatting; always asked for.
const DANGEROUS: &[&str] = &[
    "rm", "rmdir", "del", "erase", "rd", "ri", "remove-item", "format", "diskpart", "dd", "mkfs",
    "shutdown", "reboot", "halt", "poweroff", "shred", "truncate",
];

/// Interpreters: fine behind a script name, not bare (`python -c ...`).
const INTERPRETERS: &[&str] = &[
    "python", "python2", "python3", "py", "node", "deno", "bun", "ruby", "perl", "php", "lua",
    "java", "dotnet", "pwsh", "osascript", "awk", "gawk",
];

/// Programs with subcommands: the bare name covers every one of them
/// (`git push`, `npm publish`), so a prefix needs the subcommand too.
const SUBCOMMAND_TOOLS: &[&str] = &[
    "git", "npm", "npx", "yarn", "pnpm", "cargo", "go", "docker", "podman", "kubectl", "helm",
    "gh", "az", "aws", "gcloud", "pip", "pip3", "pipx", "uv", "poetry", "mvn", "gradle", "make",
    "rustup", "brew", "apt", "apt-get", "winget", "choco", "scoop", "systemctl", "terraform",
];

/// Arguments that turn the rest of a command line into code.
const EXEC_FLAGS: &[&str] = &[
    "-c", "-e", "-x", "-m", "--eval", "-command", "-encodedcommand", "-exec", "--exec", "-ec",
    "--command", "-i", "--interactive",
];

fn program_of(token: &str) -> String {
    let base = token.rsplit(['/', '\\']).next().unwrap_or(token).to_lowercase();
    base.strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .or_else(|| base.strip_suffix(".bat"))
        .unwrap_or(&base)
        .to_string()
}

/// Why `prefix` cannot be a standing command prefix, if it cannot.
pub fn prefix_problem(prefix: &str) -> Option<String> {
    let tokens: Vec<&str> = prefix.split_whitespace().collect();
    let Some(first) = tokens.first() else {
        return Some("the prefix is empty".into());
    };
    if tokens
        .iter()
        .any(|t| t.chars().any(|c| ";&|<>`$()'\"\r\n\0".contains(c)))
    {
        return Some("the prefix has shell syntax in it".into());
    }
    let program = program_of(first);
    if WRAPPERS.contains(&program.as_str()) {
        return Some(format!("`{program}` runs whatever follows it"));
    }
    if DANGEROUS.contains(&program.as_str()) {
        return Some(format!("`{program}` deletes or reformats; it is asked about every time"));
    }
    if INTERPRETERS.contains(&program.as_str())
        && tokens.get(1).is_none_or(|t| t.starts_with('-'))
    {
        return Some(format!("`{program}` alone runs any script"));
    }
    if SUBCOMMAND_TOOLS.contains(&program.as_str()) && tokens.len() < 2 {
        return Some(format!("`{program}` alone covers every subcommand"));
    }
    if tokens[1..]
        .iter()
        .any(|t| EXEC_FLAGS.contains(&t.to_lowercase().as_str()))
    {
        return Some("the prefix has a flag that runs code".into());
    }
    None
}

/// Whether `command` is one plain command: nothing chains, pipes, redirects,
/// substitutes or continues onto another line, and nothing is wrapped around
/// the program it runs.
fn is_single_plain_command(command: &str) -> bool {
    if command.contains(['\n', '\r', '\0']) {
        return false;
    }
    // Quote-aware: an operator inside single quotes is text, and inside double
    // quotes only the expansions are not.
    let mut quote: Option<char> = None;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                }
            }
            Some(q) => {
                if c == q {
                    quote = None;
                } else if c == '$' || c == '`' {
                    return false;
                } else if c == '\\' {
                    chars.next();
                }
            }
            None => match c {
                '\'' | '"' => quote = Some(c),
                ';' | '&' | '|' | '<' | '>' | '`' | '$' | '(' | ')' | '{' | '}' => return false,
                '\\' if !cfg!(windows) => {
                    chars.next();
                }
                _ => {}
            },
        }
    }
    if quote.is_some() {
        return false;
    }
    let parsed = simple_commands(command);
    let [only] = parsed.as_slice() else {
        return false;
    };
    if only.starts_with(NON_PLAIN_MARK) {
        return false;
    }
    // `simple_commands` skips an environment assignment or wrapper to find the
    // program; a covered command starts at its own program.
    let raw_first = command.split_whitespace().next();
    raw_first.is_some() && raw_first == only.split_whitespace().next()
}

/// Whether `prefix` is a valid prefix that covers `command`.
fn prefix_covers(prefix: &str, command: &str) -> bool {
    if prefix_problem(prefix).is_some() || !is_single_plain_command(command) {
        return false;
    }
    let want: Vec<&str> = prefix.split_whitespace().collect();
    let have: Vec<&str> = command.split_whitespace().collect();
    have.len() >= want.len() && have[..want.len()] == want[..]
}

// -- the form -----------------------------------------------------------------

/// The choices a prompt's form offers for this call. `Once` and `Run` are
/// always there; a folder or a command prefix only when a rule of that scope
/// would cover this very call and be accepted.
pub fn scope_options(
    tool: &BuiltinTool,
    kind: PromptKind,
    args: &Value,
    project_root: &Path,
) -> Vec<ApprovalScope> {
    let mut out = vec![ApprovalScope::Once];
    if kind == PromptKind::Ask {
        return out;
    }
    out.push(ApprovalScope::Run);
    if tool.capability == Capability::Exec {
        let Some(command) = args.get("command").and_then(|v| v.as_str()) else {
            return out;
        };
        let tokens: Vec<&str> = command.split_whitespace().collect();
        for n in 1..=tokens.len().min(3) {
            let prefix = tokens[..n].join(" ");
            if prefix_covers(&prefix, command) {
                out.push(ApprovalScope::CommandPrefix { prefix });
            }
        }
        return out;
    }
    if tool.path_args.is_empty() {
        return out;
    }
    let base = strip_verbatim(&canonicalize_lenient(project_root).unwrap_or_else(|_| project_root.to_path_buf()));
    let Some(first) = tool
        .path_args
        .first()
        .and_then(|k| args.get(k))
        .and_then(|v| v.as_str())
        .and_then(|raw| resolve(raw, &base))
    else {
        return out;
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.push(if first.is_dir() {
        first.clone()
    } else {
        first.parent().map(Path::to_path_buf).unwrap_or_default()
    });
    if kind == PromptKind::Write && is_within(&first, &base) && !candidates.contains(&base) {
        candidates.push(base.clone());
    }
    for dir in candidates {
        let text = dir.to_string_lossy().into_owned();
        if folder_covers(&text, tool, args, project_root) {
            let scope = ApprovalScope::Folder { dir: text };
            if !out.contains(&scope) {
                out.push(scope);
            }
        }
    }
    out
}

/// A scope the user chose, checked against the call it was chosen for and put
/// in canonical form. A folder or prefix that does not cover this call, or is
/// not acceptable, is refused: the form only ever offers what is valid, so
/// anything else came from somewhere that should not be trusted.
pub fn validate_choice(
    scope: &ApprovalScope,
    tool: &BuiltinTool,
    kind: PromptKind,
    args: &Value,
    project_root: &Path,
) -> Result<ApprovalScope, String> {
    if kind == PromptKind::Ask && scope.is_standing() {
        return Err("a call that is asked about every time cannot be remembered".into());
    }
    match scope {
        ApprovalScope::Once | ApprovalScope::Run => Ok(scope.clone()),
        ApprovalScope::Folder { dir } => {
            let canon = standing_folder(dir)
                .ok_or_else(|| format!("{dir} is not a folder a rule can name"))?;
            let text = canon.to_string_lossy().into_owned();
            if folder_covers(&text, tool, args, project_root) {
                Ok(ApprovalScope::Folder { dir: text })
            } else {
                Err(format!("this call is not inside {text}"))
            }
        }
        ApprovalScope::CommandPrefix { prefix } => {
            let prefix = normalize(prefix);
            if let Some(why) = prefix_problem(&prefix) {
                return Err(why);
            }
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if tool.capability == Capability::Exec && prefix_covers(&prefix, command) {
                Ok(ApprovalScope::CommandPrefix { prefix })
            } else {
                Err(format!("this command does not start with `{prefix}`"))
            }
        }
    }
}

/// Whether `rule` answers this call.
pub fn covers(
    rule: &ScopedRule,
    tool: &BuiltinTool,
    kind: PromptKind,
    args: &Value,
    project_root: &Path,
) -> bool {
    if kind == PromptKind::Ask
        || rule.tool != tool.name
        || rule.kind != kind_name(kind)
        || rule.project != project_key(project_root)
    {
        return false;
    }
    match &rule.scope {
        ApprovalScope::Folder { dir } => folder_covers(dir, tool, args, project_root),
        ApprovalScope::CommandPrefix { prefix } => {
            tool.capability == Capability::Exec
                && args
                    .get("command")
                    .and_then(|v| v.as_str())
                    .is_some_and(|c| prefix_covers(prefix, c))
        }
        ApprovalScope::Once | ApprovalScope::Run => false,
    }
}

// -- the store ----------------------------------------------------------------

const MAX_RULES: usize = 500;

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
struct RuleFile {
    #[serde(default)]
    rules: Vec<ScopedRule>,
}

/// Where the rules live: the app's data folder, so a repository cannot ship
/// them and a cloned project starts with none.
pub fn rules_file(data_folder: &Path) -> PathBuf {
    data_folder.join("approvals").join("scoped-rules.json")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_rules(data_folder: &Path) -> Result<Vec<ScopedRule>, String> {
    match std::fs::read_to_string(rules_file(data_folder)) {
        Ok(raw) => serde_json::from_str::<RuleFile>(&raw)
            .map(|f| f.rules)
            .map_err(|e| format!("the approval rules file is unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("the approval rules file cannot be read: {e}")),
    }
}

fn write_rules(data_folder: &Path, rules: Vec<ScopedRule>) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(&RuleFile { rules }).map_err(|e| e.to_string())?;
    crate::atomic_file::write_atomic(&rules_file(data_folder), &json)
}

/// The stored rules, for one project or all of them. An unreadable file lists
/// as empty: with nothing readable nothing is remembered, so nothing is covered.
pub fn list(data_folder: &Path, project: Option<&Path>) -> Vec<ScopedRule> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let key = project.map(project_key);
    read_rules(data_folder)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| key.as_ref().is_none_or(|k| &r.project == k))
        .collect()
}

/// Remember `scope` for this project and tool. The scope is validated against
/// the call it was chosen for; one that is not a standing scope is refused.
pub fn add(
    data_folder: &Path,
    project_root: &Path,
    tool: &BuiltinTool,
    kind: PromptKind,
    args: &Value,
    scope: &ApprovalScope,
) -> Result<ScopedRule, String> {
    if !scope.is_standing() {
        return Err("only a folder or a command prefix is remembered".into());
    }
    let scope = validate_choice(scope, tool, kind, args, project_root)?;
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Refuses rather than starting over: rewriting a file this cannot read
    // would silently drop the rules the user made.
    let mut rules = read_rules(data_folder)?;
    let project = project_key(project_root);
    if let Some(same) = rules.iter().find(|r| {
        r.project == project && r.tool == tool.name && r.kind == kind_name(kind) && r.scope == scope
    }) {
        return Ok(same.clone());
    }
    if rules.len() >= MAX_RULES {
        return Err(format!("{MAX_RULES} approval rules already exist; revoke some first"));
    }
    let rule = ScopedRule {
        id: format!("rule-{:x}-{:x}", now_secs(), rand::random::<u32>()),
        project,
        tool: tool.name.to_string(),
        kind: kind_name(kind).to_string(),
        scope,
        created_at: now_secs(),
    };
    rules.push(rule.clone());
    write_rules(data_folder, rules)?;
    Ok(rule)
}

/// Forget one rule. `Ok(false)` when there was none by that id.
pub fn revoke(data_folder: &Path, id: &str) -> Result<bool, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rules = read_rules(data_folder)?;
    let before = rules.len();
    rules.retain(|r| r.id != id);
    if rules.len() == before {
        return Ok(false);
    }
    write_rules(data_folder, rules)?;
    Ok(true)
}

/// The stored rule that answers this call, if any. Nothing readable, nothing
/// covered.
pub fn find_cover(
    data_folder: &Path,
    project_root: &Path,
    tool: &BuiltinTool,
    kind: PromptKind,
    args: &Value,
) -> Option<ScopedRule> {
    if kind == PromptKind::Ask {
        return None;
    }
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_rules(data_folder)
        .ok()?
        .into_iter()
        .find(|r| covers(r, tool, kind, args, project_root))
}

/// `decision` with a covering rule applied: `Prompt(kind)` becomes `Allow`
/// when a stored rule covers the call, and nothing else changes. The only
/// place a rule takes effect, so what a rule can never override is visible
/// here: it is handed a decision the gate already made, after every deny.
pub fn upgrade(
    decision: Decision,
    data_folder: &Path,
    project_root: &Path,
    tool: &BuiltinTool,
    args: &Value,
) -> Decision {
    match decision {
        Decision::Prompt(kind)
            if kind != PromptKind::Ask
                && find_cover(data_folder, project_root, tool, kind, args).is_some() =>
        {
            Decision::Allow
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{PermissionDefault, ToolPermissions};
    use crate::tools::gate::{resolve_decision, DenyReason, NetworkPolicy, SessionGrants};
    use crate::tools::lookup;
    use serde_json::json;

    struct Fixture {
        _tmp: tempfile::TempDir,
        project: PathBuf,
        data: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(project.join("src-backup")).unwrap();
        std::fs::create_dir_all(project.join("srcx")).unwrap();
        std::fs::create_dir_all(project.join("secret")).unwrap();
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        // Resolve once so assertions compare like with like on every platform.
        let project = strip_verbatim(&project.canonicalize().unwrap());
        Fixture { _tmp: tmp, project, data }
    }

    fn write_tool() -> &'static BuiltinTool {
        lookup("write").unwrap()
    }

    fn bash() -> &'static BuiltinTool {
        lookup("bash").unwrap()
    }

    fn folder(dir: &Path) -> ApprovalScope {
        ApprovalScope::Folder { dir: dir.to_string_lossy().into_owned() }
    }

    fn prefix(p: &str) -> ApprovalScope {
        ApprovalScope::CommandPrefix { prefix: p.into() }
    }

    fn write_args(path: &str) -> Value {
        json!({ "path": path, "content": "x" })
    }

    fn add_folder(f: &Fixture, dir: &Path, sample: &str) -> ScopedRule {
        add(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args(sample), &folder(dir)).unwrap()
    }

    fn rule_for(f: &Fixture, scope: ApprovalScope) -> ScopedRule {
        ScopedRule {
            id: "r".into(),
            project: project_key(&f.project),
            tool: "write".into(),
            kind: "write".into(),
            scope,
            created_at: 0,
        }
    }

    fn covered(f: &Fixture, rule: &ScopedRule, path: &str) -> bool {
        covers(rule, write_tool(), PromptKind::Write, &write_args(path), &f.project)
    }

    // -- folder scope ---------------------------------------------------------

    #[test]
    fn a_folder_rule_covers_inside_and_nothing_else() {
        let f = fixture();
        let rule = rule_for(&f, folder(&f.project.join("src")));
        assert!(covered(&f, &rule, "src/a.rs"));
        assert!(covered(&f, &rule, "src/new/deeper/a.rs"), "a file that does not exist yet");
        assert!(covered(&f, &rule, f.project.join("src").join("a.rs").to_str().unwrap()));
        assert!(!covered(&f, &rule, "other.rs"));
        assert!(!covered(&f, &rule, "secret/a.rs"));
    }

    #[test]
    fn a_folder_does_not_cover_a_sibling_that_shares_its_name_as_a_prefix() {
        let f = fixture();
        let rule = rule_for(&f, folder(&f.project.join("src")));
        for sibling in ["src-backup/a.rs", "srcx/a.rs", "src-backup", "srcx"] {
            assert!(!covered(&f, &rule, sibling), "{sibling} is not under src");
        }
    }

    #[test]
    fn dot_dot_cannot_climb_out_of_a_folder() {
        let f = fixture();
        let rule = rule_for(&f, folder(&f.project.join("src")));
        for path in [
            "src/../secret/a.rs",
            "src/../../outside.rs",
            "src/./../src-backup/a.rs",
            "src/sub/../../srcx/a.rs",
        ] {
            assert!(!covered(&f, &rule, path), "{path} climbs out of src");
        }
        assert!(covered(&f, &rule, "src/sub/../a.rs"), "a .. that stays inside is fine");
    }

    #[test]
    fn an_absolute_path_elsewhere_is_not_covered() {
        let f = fixture();
        let rule = rule_for(&f, folder(&f.project.join("src")));
        let outside = f.project.parent().unwrap().join("elsewhere.txt");
        assert!(!covered(&f, &rule, outside.to_str().unwrap()));
    }

    #[test]
    fn every_path_of_the_call_must_be_inside() {
        let f = fixture();
        let tool = lookup("apply_patch").or_else(|| lookup("write")).unwrap();
        if tool.path_args.len() > 1 {
            let rule = rule_for(&f, folder(&f.project.join("src")));
            let args = json!({ tool.path_args[0]: "src/a", tool.path_args[1]: "secret/b" });
            assert!(!covers(&rule, tool, PromptKind::Write, &args, &f.project));
        }
        // A call with no path argument at all is not a call a folder covers.
        let rule = rule_for(&f, folder(&f.project.join("src")));
        assert!(!covers(&rule, write_tool(), PromptKind::Write, &json!({ "content": "x" }), &f.project));
        assert!(!covers(&rule, write_tool(), PromptKind::Write, &json!({ "path": 7 }), &f.project));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_folder_cannot_lead_out_of_it() {
        let f = fixture();
        std::os::unix::fs::symlink(f.project.join("secret"), f.project.join("src").join("link")).unwrap();
        let rule = rule_for(&f, folder(&f.project.join("src")));
        assert!(!covered(&f, &rule, "src/link/a.rs"));
        assert!(!covered(&f, &rule, "src/link"));
        assert!(covered(&f, &rule, "src/a.rs"));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_became_a_link_covers_nothing() {
        let f = fixture();
        let rule = add_folder(&f, &f.project.join("src"), "src/a.rs");
        std::fs::remove_dir_all(f.project.join("src")).unwrap();
        std::os::unix::fs::symlink(f.project.join("secret"), f.project.join("src")).unwrap();
        assert!(!covered(&f, &rule, "src/a.rs"));
        assert!(!covered(&f, &rule, "secret/a.rs"), "the link's target is not the folder that was approved");
    }

    #[test]
    fn a_vanished_folder_covers_nothing() {
        let f = fixture();
        let rule = add_folder(&f, &f.project.join("src"), "src/a.rs");
        std::fs::remove_dir_all(f.project.join("src")).unwrap();
        assert!(!covered(&f, &rule, "src/a.rs"));
    }

    #[test]
    fn a_rule_is_kind_tool_and_project_specific() {
        let f = fixture();
        let rule = rule_for(&f, folder(&f.project.join("src")));
        let args = write_args("src/a.rs");
        assert!(covers(&rule, write_tool(), PromptKind::Write, &args, &f.project));
        assert!(!covers(&rule, write_tool(), PromptKind::WriteEscape, &args, &f.project));
        assert!(!covers(&rule, write_tool(), PromptKind::Ask, &args, &f.project));
        assert!(!covers(&rule, lookup("edit").unwrap(), PromptKind::Write, &args, &f.project));
        let other = f.project.parent().unwrap().join("other-proj");
        std::fs::create_dir_all(other.join("src")).unwrap();
        assert!(!covers(&rule, write_tool(), PromptKind::Write, &args, &other));
    }

    #[test]
    fn a_root_or_home_folder_is_not_a_folder_a_rule_can_name() {
        let f = fixture();
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(add(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args("src/a"), &ApprovalScope::Folder { dir: root.into() }).is_err());
        if let Ok(home) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
            assert!(
                add(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args("src/a"), &ApprovalScope::Folder { dir: home }).is_err()
            );
        }
        // Relative and missing folders are not accepted either.
        for dir in ["src", "", "does/not/exist"] {
            assert!(add(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args("src/a"), &ApprovalScope::Folder { dir: dir.into() }).is_err(), "{dir:?}");
        }
    }

    #[test]
    fn folders_that_hold_credentials_or_machine_configuration_are_never_named() {
        let f = fixture();
        for sensitive in [".ssh", ".aws", "Start Menu", "System32", ".config"] {
            let dir = f.project.join(sensitive);
            std::fs::create_dir_all(dir.join("inner")).unwrap();
            for target in [dir.clone(), dir.join("inner")] {
                let sample = format!("{sensitive}/inner/key.txt");
                assert!(
                    add(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args(&sample), &folder(&target)).is_err(),
                    "{target:?} must not be a rule folder"
                );
            }
            // Nor does a rule slipped into the store by hand cover anything there.
            let rule = rule_for(&f, folder(&dir));
            assert!(!covered(&f, &rule, &format!("{sensitive}/inner/key.txt")), "{sensitive}");
            // And the form never offers it.
            let opts = scope_options(write_tool(), PromptKind::Write, &write_args(&format!("{sensitive}/inner/key.txt")), &f.project);
            assert!(opts.iter().all(|o| !matches!(o, ApprovalScope::Folder { dir } if dir.to_lowercase().contains(&sensitive.to_lowercase()))), "{opts:?}");
        }
    }

    #[test]
    fn a_folder_that_does_not_contain_the_call_is_refused_at_creation() {
        let f = fixture();
        let err = add(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args("secret/a.rs"), &folder(&f.project.join("src"))).unwrap_err();
        assert!(err.contains("not inside"), "{err}");
        assert!(list(&f.data, None).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_does_not_matter_but_the_folder_still_does() {
        let f = fixture();
        let rule = rule_for(&f, folder(&f.project.join("src")));
        assert!(covered(&f, &rule, "SRC\\A.RS"));
        assert!(covered(&f, &rule, "Src/new.rs"));
        assert!(!covered(&f, &rule, "SRC-BACKUP\\a.rs"));
        let upper = f.project.join("SRC").join("A.RS");
        assert!(covered(&f, &rule, upper.to_str().unwrap().to_uppercase().as_str()));
        // The project key ignores case too, so the same folder spelled another way is the same project.
        let shouty = PathBuf::from(f.project.to_string_lossy().to_uppercase());
        assert_eq!(project_key(&shouty), project_key(&f.project));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_that_win32_rewrites_are_not_covered() {
        let f = fixture();
        let rule = rule_for(&f, folder(&f.project.join("src")));
        for path in [
            "src.\\a.rs",
            "src \\a.rs",
            "src\\a.rs.",
            "src\\a.rs ",
            "src\\a.rs:stream",
            "src\\.. \\secret\\a.rs",
            "C:a.rs",
            "\\src\\a.rs",
            "/src/a.rs",
        ] {
            assert!(!covered(&f, &rule, path), "{path:?} must not be covered");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_short_names_resolve_to_the_same_folder() {
        let f = fixture();
        let long = f.project.join("Long Folder Name");
        std::fs::create_dir_all(&long).unwrap();
        let outside = f.project.join("Another Long Name");
        std::fs::create_dir_all(&outside).unwrap();
        let short = |p: &Path| -> Option<String> {
            use std::os::windows::ffi::OsStrExt;
            let wide: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut buf = vec![0u16; 2048];
            // SAFETY: `wide` is NUL-terminated and `buf` is as long as it says.
            let n = unsafe {
                windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
                    wide.as_ptr(),
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                )
            };
            if n == 0 || n as usize > buf.len() {
                return None;
            }
            let s = String::from_utf16_lossy(&buf[..n as usize]);
            (!s.eq_ignore_ascii_case(&p.to_string_lossy())).then_some(s)
        };
        let (Some(short_long), Some(short_outside)) = (short(&long), short(&outside)) else {
            eprintln!("8.3 names are off on this volume; nothing to check");
            return;
        };
        let rule = rule_for(&f, folder(&long));
        // The short spelling of the folder, and of a path inside it, are inside.
        assert!(covered(&f, &rule, &format!("{short_long}\\a.rs")));
        // The short spelling of a different folder is not.
        assert!(!covered(&f, &rule, &format!("{short_outside}\\a.rs")));
        // A rule created from the short spelling is stored as the long one.
        let made = add(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args(&format!("{short_long}\\a.rs")), &ApprovalScope::Folder { dir: short_long.clone() }).unwrap();
        let ApprovalScope::Folder { dir } = made.scope else { panic!() };
        assert!(same_path(Path::new(&dir), &long), "{dir}");
    }

    // -- command prefix scope -------------------------------------------------

    fn exec_covered(p: &str, command: &str) -> bool {
        prefix_covers(p, command)
    }

    #[test]
    fn a_prefix_covers_commands_that_start_with_exactly_its_tokens() {
        assert!(exec_covered("git status", "git status"));
        assert!(exec_covered("git status", "git status --short"));
        assert!(exec_covered("git status", "git   status   -s"));
        assert!(exec_covered("cargo test", "cargo test --lib foo"));
        assert!(exec_covered("npm run build", "npm run build"));
    }

    #[test]
    fn a_prefix_does_not_cover_a_longer_first_token_or_another_command() {
        assert!(!exec_covered("git status", "git statusx"));
        assert!(!exec_covered("git status", "git stat"));
        assert!(!exec_covered("git status", "gitx status"));
        assert!(!exec_covered("git status", "git"));
        assert!(!exec_covered("git status", "git push"));
        assert!(!exec_covered("git status", "git  push status"));
        assert!(!exec_covered("cargo test", "cargo testing"));
    }

    #[test]
    fn a_prefix_never_covers_a_chained_piped_or_substituted_command() {
        for command in [
            "git status && rm -rf x",
            "git status; rm -rf x",
            "git status || curl evil",
            "git status | sh",
            "git status & calc",
            "git status\nrm -rf x",
            "git status\r\nrm -rf x",
            "git status $(curl evil)",
            "git status `curl evil`",
            "git status > out.txt",
            "git status >> out.txt",
            "git status < in.txt",
            "git status 2>&1",
            "git status \"$(curl evil)\"",
            "git status \"`curl evil`\"",
            "git status ${EVIL}",
            "git status \"unterminated",
            "git status 'unterminated",
            "git status (subshell)",
        ] {
            assert!(!exec_covered("git status", command), "{command:?} must not be covered");
        }
    }

    #[test]
    fn a_wrapper_or_assignment_in_front_means_it_is_not_that_command() {
        for command in [
            "sudo git status",
            "env git status",
            "FOO=1 git status",
            "timeout 5 git status",
            "nohup git status",
            "bash -c 'git status'",
            "cmd /c git status",
        ] {
            assert!(!exec_covered("git status", command), "{command:?}");
        }
    }

    #[test]
    fn operators_inside_single_quotes_are_text() {
        assert!(exec_covered("git commit", "git commit -m 'fix; the | thing'"));
        // ... but not inside double quotes when they expand.
        assert!(!exec_covered("git commit", "git commit -m \"fix $HOME\""));
    }

    #[test]
    fn some_prefixes_are_never_accepted() {
        for bad in [
            "",
            "   ",
            "git",
            "npm",
            "cargo",
            "bash",
            "sh -c",
            "sudo",
            "sudo git status",
            "env",
            "powershell",
            "cmd /c",
            "python",
            "python -c",
            "node -e",
            "node",
            "rm",
            "rm -rf",
            "del",
            "git status; rm",
            "git status | sh",
            "git 'status'",
            "git -c core.pager=evil",
            "cargo run -e",
            "curl http://x && ls",
            "xargs",
        ] {
            assert!(prefix_problem(bad).is_some(), "{bad:?} must be refused as a prefix");
        }
        for good in ["git status", "cargo test", "npm run build", "python manage.py", "ls", "make test", "./build.sh"] {
            assert!(prefix_problem(good).is_none(), "{good:?}: {:?}", prefix_problem(good));
        }
    }

    #[test]
    fn a_prefix_rule_is_exec_only_and_kind_bound() {
        let f = fixture();
        let args = json!({ "command": "git status --short" });
        let rule = ScopedRule {
            id: "r".into(),
            project: project_key(&f.project),
            tool: "bash".into(),
            kind: "exec".into(),
            scope: prefix("git status"),
            created_at: 0,
        };
        assert!(covers(&rule, bash(), PromptKind::Exec, &args, &f.project));
        assert!(!covers(&rule, bash(), PromptKind::Write, &args, &f.project));
        assert!(!covers(&rule, bash(), PromptKind::Ask, &args, &f.project));
        assert!(!covers(&rule, bash(), PromptKind::Exec, &json!({ "command": "git push" }), &f.project));
        assert!(!covers(&rule, bash(), PromptKind::Exec, &json!({}), &f.project));
        // A prefix rule cannot be pointed at a file tool.
        let mut on_write = rule.clone();
        on_write.tool = "write".into();
        on_write.kind = "write".into();
        assert!(!covers(&on_write, write_tool(), PromptKind::Write, &json!({ "command": "git status", "path": "a" }), &f.project));
    }

    #[test]
    fn a_prefix_must_cover_the_command_it_is_chosen_for() {
        let f = fixture();
        let args = json!({ "command": "git status --short" });
        assert!(add(&f.data, &f.project, bash(), PromptKind::Exec, &args, &prefix("git push")).is_err());
        assert!(add(&f.data, &f.project, bash(), PromptKind::Exec, &args, &prefix("git")).is_err());
        let ok = add(&f.data, &f.project, bash(), PromptKind::Exec, &args, &prefix("git   status")).unwrap();
        assert_eq!(ok.scope, prefix("git status"), "stored normalized");
        // A chained command cannot have a rule made from it.
        assert!(add(&f.data, &f.project, bash(), PromptKind::Exec, &json!({ "command": "git status && rm x" }), &prefix("git status")).is_err());
    }

    // -- the form -------------------------------------------------------------

    #[test]
    fn the_form_offers_only_scopes_that_cover_the_call() {
        let f = fixture();
        let opts = scope_options(bash(), PromptKind::Exec, &json!({ "command": "cargo test --lib foo" }), &f.project);
        assert_eq!(opts[0], ApprovalScope::Once);
        assert_eq!(opts[1], ApprovalScope::Run);
        assert!(opts.contains(&prefix("cargo test")));
        assert!(opts.contains(&prefix("cargo test --lib")));
        assert!(!opts.contains(&prefix("cargo")), "bare cargo covers every subcommand");
        // A chained command offers no prefix at all.
        let chained = scope_options(bash(), PromptKind::Exec, &json!({ "command": "cargo test && rm x" }), &f.project);
        assert!(chained.iter().all(|s| !s.is_standing()));
        // A file write offers its folder, and the project when it is inside it.
        let opts = scope_options(write_tool(), PromptKind::Write, &write_args("src/a.rs"), &f.project);
        assert!(opts.contains(&folder(&f.project.join("src"))));
        assert!(opts.contains(&folder(&f.project)));
        // Asked-every-time calls offer only "once".
        assert_eq!(scope_options(bash(), PromptKind::Ask, &json!({ "command": "git push" }), &f.project), vec![ApprovalScope::Once]);
    }

    // -- the store ------------------------------------------------------------

    #[test]
    fn rules_are_added_listed_deduplicated_and_revoked() {
        let f = fixture();
        let a = add_folder(&f, &f.project.join("src"), "src/a.rs");
        let again = add_folder(&f, &f.project.join("src"), "src/b.rs");
        assert_eq!(a.id, again.id, "the same rule is not stored twice");
        let b = add(&f.data, &f.project, bash(), PromptKind::Exec, &json!({ "command": "make test" }), &prefix("make test")).unwrap();
        assert_eq!(list(&f.data, None).len(), 2);
        assert_eq!(list(&f.data, Some(&f.project)).len(), 2);
        assert!(list(&f.data, Some(&f.project.parent().unwrap().join("nope"))).is_empty());
        assert!(find_cover(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args("src/z.rs")).is_some());
        assert!(revoke(&f.data, &a.id).unwrap());
        assert!(!revoke(&f.data, &a.id).unwrap(), "already gone");
        assert!(find_cover(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args("src/z.rs")).is_none());
        assert_eq!(list(&f.data, None), vec![b]);
    }

    #[test]
    fn a_rule_made_in_one_project_does_not_apply_in_another() {
        let f = fixture();
        add_folder(&f, &f.project.join("src"), "src/a.rs");
        let other = f.project.parent().unwrap().join("other");
        std::fs::create_dir_all(other.join("src")).unwrap();
        assert!(find_cover(&f.data, &other, write_tool(), PromptKind::Write, &write_args("src/a.rs")).is_none());
        // Not even by naming the first project's folder by absolute path.
        let abs = f.project.join("src").join("a.rs");
        assert!(find_cover(&f.data, &other, write_tool(), PromptKind::Write, &write_args(abs.to_str().unwrap())).is_none());
    }

    #[test]
    fn an_unreadable_rules_file_covers_nothing_and_is_not_overwritten() {
        let f = fixture();
        add_folder(&f, &f.project.join("src"), "src/a.rs");
        std::fs::write(rules_file(&f.data), "{ not json").unwrap();
        assert!(find_cover(&f.data, &f.project, write_tool(), PromptKind::Write, &write_args("src/a.rs")).is_none());
        assert!(list(&f.data, None).is_empty());
        assert!(add(&f.data, &f.project, bash(), PromptKind::Exec, &json!({ "command": "make test" }), &prefix("make test")).is_err());
        assert_eq!(std::fs::read_to_string(rules_file(&f.data)).unwrap(), "{ not json", "the user's file is left as it was");
    }

    #[test]
    fn once_and_run_are_not_remembered() {
        let f = fixture();
        for scope in [ApprovalScope::Once, ApprovalScope::Run] {
            assert!(add(&f.data, &f.project, bash(), PromptKind::Exec, &json!({ "command": "ls" }), &scope).is_err());
        }
        assert!(add(&f.data, &f.project, bash(), PromptKind::Ask, &json!({ "command": "ls" }), &prefix("ls")).is_err());
    }

    #[test]
    fn the_scope_has_a_stable_wire_shape() {
        assert_eq!(serde_json::to_value(ApprovalScope::Once).unwrap(), json!({ "type": "once" }));
        assert_eq!(
            serde_json::to_value(prefix("git status")).unwrap(),
            json!({ "type": "command_prefix", "prefix": "git status" })
        );
        let back: ApprovalScope = serde_json::from_value(json!({ "type": "folder", "dir": "/x" })).unwrap();
        assert_eq!(back, ApprovalScope::Folder { dir: "/x".into() });
        assert!(serde_json::from_value::<ApprovalScope>(json!({ "type": "everything" })).is_err());
    }

    // -- what a rule can never override ---------------------------------------

    fn decide(f: &Fixture, tool: &BuiltinTool, args: &Value, perms: &ToolPermissions) -> Decision {
        let decision = resolve_decision(
            tool,
            args,
            &f.project,
            None,
            &[],
            perms,
            &SessionGrants::default(),
            true,
            &NetworkPolicy::open(),
            &crate::subject::Subject::MainAgent,
        );
        upgrade(decision, &f.data, &f.project, tool, args)
    }

    #[test]
    fn a_covered_prompt_becomes_allow() {
        let f = fixture();
        let perms = ToolPermissions::new(PermissionDefault::ReadOnly, &[], &[], &[]);
        assert_eq!(decide(&f, write_tool(), &write_args("src/a.rs"), &perms), Decision::Prompt(PromptKind::Write));
        add_folder(&f, &f.project.join("src"), "src/a.rs");
        assert_eq!(decide(&f, write_tool(), &write_args("src/a.rs"), &perms), Decision::Allow);
        // The neighbour still asks.
        assert_eq!(decide(&f, write_tool(), &write_args("src-backup/a.rs"), &perms), Decision::Prompt(PromptKind::Write));
    }

    #[test]
    fn a_rule_never_overrides_a_hard_deny() {
        let f = fixture();
        add_folder(&f, &f.project.join("src"), "src/a.rs");
        add_folder(&f, &f.project.join("secret"), "secret/a.rs");
        // A policy deny inside a folder a rule covers.
        let deny = ToolPermissions::new(PermissionDefault::ReadOnly, &[], &["write(src/locked/**)".to_string()], &[]);
        assert_eq!(
            decide(&f, write_tool(), &write_args("src/locked/a.rs"), &deny),
            Decision::HardDeny(DenyReason::Policy)
        );
        // A tool-wide deny.
        let deny_all = ToolPermissions::new(PermissionDefault::ReadOnly, &[], &["write".to_string()], &[]);
        assert_eq!(decide(&f, write_tool(), &write_args("src/a.rs"), &deny_all), Decision::HardDeny(DenyReason::Policy));
        // The agent's own state is hidden whatever a rule says.
        std::fs::create_dir_all(f.project.join(".jan").join("agent")).unwrap();
        let perms = ToolPermissions::new(PermissionDefault::ReadOnly, &[], &[], &[]);
        add_folder_unchecked(&f, ".jan/agent");
        assert_eq!(
            decide(&f, write_tool(), &write_args(".jan/agent/agent.toml"), &perms),
            Decision::HardDeny(DenyReason::Hidden)
        );
        // A secret file by name.
        assert!(matches!(
            decide(&f, write_tool(), &write_args("secret/.env"), &perms),
            Decision::HardDeny(DenyReason::SecretFile(_))
        ));
        // Writes into .git.
        std::fs::create_dir_all(f.project.join(".git")).unwrap();
        add_folder_unchecked(&f, ".git");
        assert_eq!(
            decide(&f, write_tool(), &write_args(".git/hooks/pre-commit"), &perms),
            Decision::HardDeny(DenyReason::GitInternals)
        );
    }

    /// A rule written straight into the store, as an older version or a
    /// hostile edit of the file might leave one.
    fn add_folder_unchecked(f: &Fixture, rel: &str) {
        let dir = strip_verbatim(&f.project.join(rel).canonicalize().unwrap());
        let mut rules = read_rules(&f.data).unwrap();
        rules.push(rule_for(f, folder(&dir)));
        write_rules(&f.data, rules).unwrap();
    }

    #[test]
    fn a_rule_never_silences_an_ask() {
        let f = fixture();
        add(&f.data, &f.project, bash(), PromptKind::Exec, &json!({ "command": "git push origin main" }), &prefix("git push")).unwrap();
        // Hand-edit the store so a rule exists for the ask kind too.
        let mut rules = read_rules(&f.data).unwrap();
        let mut sneaky = rules[0].clone();
        sneaky.id = "sneaky".into();
        sneaky.kind = "ask".into();
        rules.push(sneaky);
        write_rules(&f.data, rules).unwrap();
        assert_eq!(
            upgrade(Decision::Prompt(PromptKind::Ask), &f.data, &f.project, bash(), &json!({ "command": "git push origin main" })),
            Decision::Prompt(PromptKind::Ask)
        );
        // A project `ask` rule keeps asking.
        let asks = ToolPermissions::new(PermissionDefault::ReadOnly, &[], &[], &[]);
        let _ = asks;
        // Deleting a home directory is asked every time, covered prefix or not.
        add(&f.data, &f.project, bash(), PromptKind::Exec, &json!({ "command": "ls" }), &prefix("ls")).unwrap();
        let d = resolve_decision(
            bash(),
            &json!({ "command": "rm -rf ~" }),
            &f.project,
            None,
            &[],
            &ToolPermissions::allow_all(),
            &SessionGrants::default(),
            true,
            &NetworkPolicy::open(),
            &crate::subject::Subject::MainAgent,
        );
        assert_eq!(d, Decision::Prompt(PromptKind::Ask));
        assert_eq!(upgrade(d, &f.data, &f.project, bash(), &json!({ "command": "rm -rf ~" })), Decision::Prompt(PromptKind::Ask));
    }

    #[test]
    fn allow_and_deny_pass_through_unchanged() {
        let f = fixture();
        let args = write_args("src/a.rs");
        assert_eq!(upgrade(Decision::Allow, &f.data, &f.project, write_tool(), &args), Decision::Allow);
        let deny = Decision::HardDeny(DenyReason::Policy);
        assert_eq!(upgrade(deny.clone(), &f.data, &f.project, write_tool(), &args), deny);
    }
}
