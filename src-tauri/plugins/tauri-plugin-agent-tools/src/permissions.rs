//! Tool-permission gate built from the `[tools]` section of `agent.toml`.
//!
//! Rules are [`ResourceRule`]s, so a rule can name what a call touches and not
//! only which tool made it: `bash(git:force-push)` and `read(**/.ssh/**)` are
//! expressible where `bash` and `read` were the only vocabulary before. A rule
//! written the old way — a bare tool name or glob — keeps working unchanged and
//! means "this tool, whatever it touches".
//!
//! There is deliberately one representation. The name-only entry points below
//! are thin views over the same compiled rules rather than a second list that
//! could disagree with the first. Deny always wins.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::resource::{Resource, ResourceRule};
use crate::tools::{Capability, BUILTIN_TOOLS};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PermissionDefault {
    Allow,
    Deny,
    #[default]
    ReadOnly,
}

impl PermissionDefault {
    /// What an `agent.toml` with a `[tools]` policy but no `default` key means.
    /// One answer for the desktop gate, the CLI and policy export, so the
    /// policy exported is the one enforced.
    pub const UNSET: PermissionDefault = PermissionDefault::ReadOnly;

    /// The `agent.toml` spelling, inverse of [`Self::from_str_lenient`].
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionDefault::Allow => "allow",
            PermissionDefault::Deny => "deny",
            PermissionDefault::ReadOnly => "read-only",
        }
    }

    /// Lenient parser: unknown/empty falls back to the secure default (ReadOnly).
    pub fn from_str_lenient(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "allow" => PermissionDefault::Allow,
            "deny" => PermissionDefault::Deny,
            "read-only" | "readonly" => PermissionDefault::ReadOnly,
            _ => PermissionDefault::ReadOnly,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolPermissions {
    default: PermissionDefault,
    allow: Vec<ResourceRule>,
    deny: Vec<ResourceRule>,
    allow_write: Vec<ResourceRule>,
    /// Calls that must be confirmed every time, whatever the default or the
    /// allow lists say. Sits between deny and allow: deny still wins, but an
    /// `ask` rule overrides an `allow`, so a project can auto-run most tools yet
    /// still be asked before, say, a push. Empty by default (no `ask` key), so a
    /// project that never writes one behaves exactly as before.
    ask: Vec<ResourceRule>,
    /// Rules that were dropped or can never fire, with why. Loading never
    /// fails over one -- a typo must not brick a session -- but a dropped
    /// `deny` is a restriction that silently vanished, so callers surface
    /// these (`flint doctor`, the permissions settings page, stderr).
    warnings: Vec<RuleWarning>,
    /// Whether known read-only shell commands (`ls`, `cat`, `git status`, ...)
    /// run without a prompt. On unless `[tools] readonly_shell = false`.
    readonly_shell: bool,
}

/// Why a configured rule was rejected or cannot take effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleWarningKind {
    /// Does not parse; the rule was dropped.
    Malformed,
    /// Names a tool that is not built in and does not look like an MCP tool.
    UnknownTool,
    /// Carries a resource pattern the named tool never produces, so it can
    /// never match.
    IneffectiveResource,
    /// A `*` glued to a command's program name, so it also matches other
    /// programs sharing the prefix (`bash(git*)` covers `gitk`).
    UnsafeWildcard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuleWarning {
    /// The `agent.toml` list the rule came from: `allow`, `deny`, ...
    pub list: String,
    pub rule: String,
    pub kind: RuleWarningKind,
    pub reason: String,
}

impl RuleWarning {
    /// Whether the rule is a restriction (`deny`, `ask`) that is not doing its
    /// job: the cases that must be read as "less protected than written".
    pub fn weakens_restriction(&self) -> bool {
        matches!(self.list.as_str(), "deny" | "ask")
    }
}

/// The resource kinds a built-in tool's calls actually produce, as the rule
/// grammar spells them. Empty means the tool has no resources, so a
/// resource-qualified rule on it never matches.
fn resource_kinds(tool: &crate::tools::BuiltinTool) -> &'static [&'static str] {
    if !tool.path_args.is_empty() {
        return &["path"];
    }
    match (tool.name, tool.capability) {
        ("bash" | "browser", _) => &["command"],
        (_, Capability::Net) => &["net"],
        _ => &[],
    }
}

/// Check one rule string; empty when it is sound.
fn lint_rule(list: &str, raw: &str) -> Vec<RuleWarning> {
    let warn = |kind, reason: String| RuleWarning {
        list: list.to_string(),
        rule: raw.to_string(),
        kind,
        reason,
    };
    let rule = raw.trim();
    if rule.is_empty() {
        return vec![warn(RuleWarningKind::Malformed, "the rule is empty".into())];
    }
    if ResourceRule::parse(rule).is_none() {
        return vec![warn(
            RuleWarningKind::Malformed,
            "it is not a valid rule (bad glob, empty tool name, or an unrecognised subject prefix) and was dropped".into(),
        )];
    }
    // The grammar is `[subject/]tool[(pattern)]`; split it the way `parse` does.
    let head_end = rule.find('(').unwrap_or(rule.len());
    let rest = match rule[..head_end].find('/') {
        Some(slash) => rule[slash + 1..].trim(),
        None => rule,
    };
    let (tool, resource) = match rest.strip_suffix(')').and_then(|r| r.split_once('(')) {
        Some((tool, inner)) => (tool.trim(), Some(inner.trim())),
        None => (rest, None),
    };
    if tool.contains(['(', ')']) {
        return vec![warn(
            RuleWarningKind::Malformed,
            "unbalanced parentheses: the rule names a tool that cannot exist, so it never matches".into(),
        )];
    }

    let mut out = Vec::new();
    let builtin = BUILTIN_TOOLS.iter().find(|t| t.name == tool);
    let is_glob = tool.contains(['*', '?', '[']);
    // MCP tools are `server.tool` or `mcp.*`-shaped; anything else that is not
    // built in is most likely a misspelling of a built-in name.
    if builtin.is_none() && !is_glob && !tool.contains(['.', ':']) {
        out.push(warn(
            RuleWarningKind::UnknownTool,
            format!("`{tool}` is not a built-in tool and does not look like an MCP tool, so the rule matches nothing"),
        ));
    }

    let Some(pattern) = resource.filter(|p| !p.is_empty()) else {
        return out;
    };
    // `git:` names an operation class of a command, so it counts as one.
    let (kind, body) = match pattern.split_once(':') {
        Some(("git", _)) => (Some("command"), pattern),
        Some((k, rest)) if ["path", "command", "mcp", "net", "process", "unknown"].contains(&k) => {
            (Some(k), rest)
        }
        _ => (None, pattern),
    };
    if let Some(tool) = builtin {
        let kinds = resource_kinds(tool);
        if kinds.is_empty() {
            out.push(warn(
                RuleWarningKind::IneffectiveResource,
                format!("`{}` has no path, command or address for `({pattern})` to match, so the rule never fires; write the bare tool name", tool.name),
            ));
        } else if let Some(k) = kind.filter(|k| !kinds.contains(k)) {
            out.push(warn(
                RuleWarningKind::IneffectiveResource,
                format!("`{}` works on {} resources, so a `{k}:` pattern never matches", tool.name, kinds.join("/")),
            ));
        }
        if kinds == ["command"] && kind != Some("path") && !body.starts_with("git:") {
            let program = body.split_whitespace().next().unwrap_or("");
            if program != "*" && program.contains(['*', '?']) {
                out.push(warn(
                    RuleWarningKind::UnsafeWildcard,
                    format!("the wildcard in `{program}` also matches other programs that share the prefix; put a space before `*` to match arguments only"),
                ));
            }
        }
    }
    out
}

/// Lint every rule of a list, for `ToolPermissions` and for callers that want
/// to check a rule set without compiling it.
pub fn lint_rules(list: &str, patterns: &[String]) -> Vec<RuleWarning> {
    patterns.iter().flat_map(|p| lint_rule(list, p)).collect()
}

/// A rule that will not parse is dropped rather than guessed at: half a rule
/// matches unpredictably, which is worse than no rule at all.
fn compile(patterns: &[String]) -> Vec<ResourceRule> {
    patterns
        .iter()
        .filter_map(|p| ResourceRule::parse(p))
        .collect()
}

impl ToolPermissions {
    pub fn new(
        default: PermissionDefault,
        allow: &[String],
        deny: &[String],
        allow_write: &[String],
    ) -> Self {
        Self {
            default,
            allow: compile(allow),
            deny: compile(deny),
            allow_write: compile(allow_write),
            ask: Vec::new(),
            warnings: [
                lint_rules("allow", allow),
                lint_rules("deny", deny),
                lint_rules("allow_write", allow_write),
            ]
            .concat(),
            readonly_shell: true,
        }
    }

    /// Turn the built-in read-only shell allowlist on or off. On by default;
    /// it only ever removes a prompt, in the modes that prompt.
    pub fn with_readonly_shell(mut self, on: bool) -> Self {
        self.readonly_shell = on;
        self
    }

    pub fn readonly_shell(&self) -> bool {
        self.readonly_shell
    }

    /// Rules dropped or ineffective, with why. See [`RuleWarning`].
    pub fn warnings(&self) -> &[RuleWarning] {
        &self.warnings
    }

    /// Add the confirm-every-time `ask` rules, compiled the same way as the
    /// others. A builder rather than another `new` argument so the many
    /// existing call sites and tests are untouched.
    pub fn with_ask(mut self, patterns: &[String]) -> Self {
        self.ask = compile(patterns);
        self.warnings.extend(lint_rules("ask", patterns));
        self
    }

    /// Permissive: allow-by-default with no lists. Used when no `[tools]` section
    /// is configured, preserving the loop's historical "run all tools" behavior.
    pub fn allow_all() -> Self {
        Self {
            default: PermissionDefault::Allow,
            allow: Vec::new(),
            deny: Vec::new(),
            allow_write: Vec::new(),
            ask: Vec::new(),
            warnings: Vec::new(),
            readonly_shell: true,
        }
    }

    /// Whether a deny rule names this tool for this subject, ignoring what the
    /// call touches.
    ///
    /// The conservative view of the resource dimension, kept for callers that
    /// have no resources to hand -- advertising a toolset, mostly: a
    /// resource-qualified deny still reports the tool as denied here, so a
    /// caller without resources never under-reports a restriction.
    ///
    /// The subject dimension is the opposite, and is not optional (AH-007).
    /// Answering "is this denied for anyone" is what made a rule about one
    /// subagent hide the tool from every agent: `agent:reviewer/bash` stripped
    /// `bash` from the main agent's toolset too, which is the opposite of what
    /// writing it means.
    pub fn is_denied(&self, name: &str, subject: &crate::subject::Subject) -> bool {
        self.deny
            .iter()
            .any(|r| r.matches_name(name) && r.restricts_subject(subject))
    }

    /// Explicit allow-list membership (allow OR allow_write); does NOT consider deny or default.
    pub fn is_allowed(&self, name: &str, subject: &crate::subject::Subject) -> bool {
        self.allow
            .iter()
            .any(|r| r.matches_name(name) && r.covers_subject(subject))
            || self
                .allow_write
                .iter()
                .any(|r| r.matches_name(name) && r.covers_subject(subject))
    }

    /// Whether this specific call is denied.
    ///
    /// Unlike [`is_denied`], this consults the resources the call actually
    /// touches, so `bash(git:force-push)` denies a force push and leaves
    /// `git status` alone. A resource the gate could not determine is denied by
    /// any rule that names the tool.
    pub fn denies_call(
        &self,
        name: &str,
        resources: &[Resource],
        subject: &crate::subject::Subject,
    ) -> Option<&ResourceRule> {
        self.deny
            .iter()
            .find(|r| r.matches_deny(name, resources, subject))
    }

    /// Whether this specific call is explicitly allowed.
    ///
    /// A call carrying a resource the gate could not determine is never allowed
    /// here: `matches_allow` refuses to vouch for what it could not read.
    pub fn allows_call(
        &self,
        name: &str,
        resources: &[Resource],
        subject: &crate::subject::Subject,
    ) -> Option<&ResourceRule> {
        self.allow
            .iter()
            .chain(self.allow_write.iter())
            .find(|r| r.matches_allow(name, resources, subject))
    }

    /// Whether an allow rule names this call specifically rather than covering
    /// it along with everything else.
    ///
    /// The rule must be resource-qualified, allow `resources`, and *not* allow
    /// `probe` -- the same call with the sensitive part swapped for a harmless
    /// one. The hard denies for credential files and destructive git used to
    /// accept any parenthesised rule, so `read(**)` or `bash(git *)` -- rules
    /// people write to widen reads or enable git -- quietly unlocked `.env` and
    /// `git push --force` (Jozkah/jan#47).
    pub fn names_call(
        &self,
        name: &str,
        resources: &[Resource],
        probe: &[Resource],
        subject: &crate::subject::Subject,
    ) -> bool {
        self.allow.iter().chain(self.allow_write.iter()).any(|r| {
            r.is_resource_qualified()
                && r.matches_allow(name, resources, subject)
                && !r.matches_allow(name, probe, subject)
        })
    }

    /// Whether this specific call must be confirmed every time.
    ///
    /// Consulted between deny and allow: a matching `ask` rule turns an
    /// otherwise-allowed call into a prompt. Resource-aware, like
    /// [`allows_call`], so `ask = ["bash(git:push)"]` asks about a push and
    /// leaves `git status` alone.
    pub fn asks_call(
        &self,
        name: &str,
        resources: &[Resource],
        subject: &crate::subject::Subject,
    ) -> Option<&ResourceRule> {
        self.ask
            .iter()
            .find(|r| r.matches_ask(name, resources, subject))
    }

    /// Filesystem directories the allow rules make readable, derived from their
    /// path patterns, so a project can widen what reads reach without a prompt
    /// by writing `allow = ["read(C:/data/**)"]`. Only absolute patterns
    /// contribute: a relative pattern names something inside the project, which
    /// is already a read root. Deny is not subtracted here -- the gate's deny
    /// check runs first and still blocks a denied path -- so this only widens.
    pub fn sandbox_read_dirs(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for rule in self.allow.iter().chain(self.allow_write.iter()) {
            let Some(pattern) = rule.read_root_pattern() else {
                continue;
            };
            if let Some(dir) = literal_read_dir(pattern) {
                if !out.contains(&dir) {
                    out.push(dir);
                }
            }
        }
        out
    }

    /// Whether a *write* was explicitly pre-approved for this call.
    pub fn allows_write_call(
        &self,
        name: &str,
        resources: &[Resource],
        subject: &crate::subject::Subject,
    ) -> Option<&ResourceRule> {
        self.allow_write
            .iter()
            .find(|r| r.matches_allow(name, resources, subject))
    }

    /// Whether an MCP tool is advertised to the model. Deny always wins. Otherwise
    /// an explicit allow, or any default except `deny`, advertises it. Unlike
    /// built-in fs/exec tools, MCP tools are opaque and the user opted into them by
    /// configuring the server, so `read-only` does not suppress them (`deny` locks
    /// everything down). Execution of built-ins is gated separately at call time.
    pub fn advertises_mcp(&self, tool_name: &str, subject: &crate::subject::Subject) -> bool {
        if self.is_denied(tool_name, subject) {
            return false;
        }
        self.is_allowed(tool_name, subject) || !matches!(self.default, PermissionDefault::Deny)
    }

    pub fn default_mode(&self) -> PermissionDefault {
        self.default
    }
}

impl Default for ToolPermissions {
    fn default() -> Self {
        Self::allow_all()
    }
}

/// The directory an absolute allow-path pattern makes readable: the literal
/// prefix before the first glob metacharacter, taken as a directory (its parent
/// when the literal names a file). `None` for a relative or empty pattern, so a
/// project-relative rule never widens the host read roots.
fn literal_read_dir(pattern: &str) -> Option<PathBuf> {
    let cut = pattern
        .find(['*', '?', '['])
        .unwrap_or(pattern.len());
    let literal = &pattern[..cut];
    if literal.is_empty() {
        return None;
    }
    let path = Path::new(literal);
    // Host-correct absoluteness: `C:/x` is absolute on Windows, `/x` on unix.
    if !path.is_absolute() {
        return None;
    }
    let dir = if literal.ends_with('/') || literal.ends_with('\\') {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    (!dir.as_os_str().is_empty()).then_some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn read_only_advertises_unlisted_mcp_tools() {
        // read-only (the CLI default) must not suppress opaque MCP tools.
        let perms = ToolPermissions::new(PermissionDefault::ReadOnly, &[], &[], &[]);
        assert!(perms.advertises_mcp("mcp.search", &crate::subject::Subject::MainAgent));
    }

    #[test]
    fn deny_default_locks_down_mcp_unless_allowed() {
        let perms = ToolPermissions::new(PermissionDefault::Deny, &[], &[], &[]);
        assert!(!perms.advertises_mcp("mcp.search", &crate::subject::Subject::MainAgent));

        let perms = ToolPermissions::new(PermissionDefault::Deny, &s(&["mcp.search"]), &[], &[]);
        assert!(perms.advertises_mcp("mcp.search", &crate::subject::Subject::MainAgent));
    }

    #[test]
    fn deny_wins_over_default_and_allow() {
        let perms = ToolPermissions::new(
            PermissionDefault::Allow,
            &s(&["fs.*"]),
            &s(&["fs.delete"]),
            &[],
        );
        assert!(perms.advertises_mcp("fs.read", &crate::subject::Subject::MainAgent));
        assert!(!perms.advertises_mcp("fs.delete", &crate::subject::Subject::MainAgent));
    }

    #[test]
    fn is_allowed_matches_globs_only() {
        let perms = ToolPermissions::new(PermissionDefault::ReadOnly, &s(&["rag.*"]), &[], &[]);
        assert!(perms.is_allowed("rag.query", &crate::subject::Subject::MainAgent));
        assert!(!perms.is_allowed("mcp.search", &crate::subject::Subject::MainAgent));
    }

    #[test]
    fn allow_all_advertises_everything() {
        assert!(ToolPermissions::allow_all().advertises_mcp("x", &crate::subject::Subject::MainAgent));
    }

    #[test]
    fn lenient_parse() {
        assert_eq!(
            PermissionDefault::from_str_lenient("allow"),
            PermissionDefault::Allow
        );
        assert_eq!(
            PermissionDefault::from_str_lenient("DENY"),
            PermissionDefault::Deny
        );
        assert_eq!(
            PermissionDefault::from_str_lenient("read-only"),
            PermissionDefault::ReadOnly
        );
        assert_eq!(
            PermissionDefault::from_str_lenient("readonly"),
            PermissionDefault::ReadOnly
        );
        assert_eq!(
            PermissionDefault::from_str_lenient("bogus"),
            PermissionDefault::ReadOnly
        );
    }
}

/// AH-007: a rule that names a subject binds that subject and no other.
///
/// Rules have parsed `[subject/]tool[(pattern)]` since they were written, and
/// nothing compared the subject -- so `agent:reviewer/write` compiled, was
/// accepted, and then bound the main agent and every subagent identically. A
/// child could never be narrower than its parent, which is the one thing a
/// subject qualifier exists to express.
///
/// The negative cases come first here on purpose. A guard is only worth
/// anything if it refuses; these fail if `covers_subject` is made to return
/// `true` unconditionally, which is what the bug was.
#[cfg(test)]
mod subject_rules {
    use super::*;
    use crate::subject::Subject;

    fn rule(text: &str) -> ResourceRule {
        ResourceRule::parse(text).unwrap_or_else(|| panic!("{text} should parse"))
    }

    fn reviewer() -> Subject {
        Subject::NamedAgent("reviewer".to_string())
    }

    /// Advertising, not just execution.
    ///
    /// `is_denied` used to answer "is this tool denied for anyone", so a rule
    /// naming one subagent removed the tool from every agent's advertised
    /// toolset -- the main agent could not run `bash` because the reviewer was
    /// not allowed to. Both halves are asserted: the reviewer loses it, and
    /// nobody else does.
    #[test]
    fn a_rule_about_one_subagent_hides_the_tool_from_that_subagent_only() {
        let perms = ToolPermissions::new(
            PermissionDefault::Allow,
            &[],
            &["agent:reviewer/bash".to_string()],
            &[],
        );
        assert!(perms.is_denied("bash", &reviewer()));
        assert!(!perms.is_denied("bash", &Subject::MainAgent));
        assert!(!perms.is_denied(
            "bash",
            &Subject::NamedAgent("implementer".to_string())
        ));

        // And the same for the MCP advertising path, which reads `is_denied`.
        let mcp = ToolPermissions::new(
            PermissionDefault::Allow,
            &[],
            &["agent:reviewer/mcp.search".to_string()],
            &[],
        );
        assert!(!mcp.advertises_mcp("mcp.search", &reviewer()));
        assert!(mcp.advertises_mcp("mcp.search", &Subject::MainAgent));
    }

    /// An unqualified rule keeps meaning what it always meant.
    #[test]
    fn an_unqualified_deny_still_binds_every_subject() {
        let perms =
            ToolPermissions::new(PermissionDefault::Allow, &[], &["bash".to_string()], &[]);
        assert!(perms.is_denied("bash", &Subject::MainAgent));
        assert!(perms.is_denied("bash", &reviewer()));
    }

    fn no_resources() -> Vec<Resource> {
        Vec::new()
    }

    #[test]
    fn a_subject_qualified_rule_does_not_bind_another_subject() {
        let r = rule("agent:reviewer/write");
        assert!(r.covers_subject(&reviewer()));
        // The bug: these were all true.
        assert!(!r.covers_subject(&Subject::MainAgent));
        assert!(!r.covers_subject(&Subject::NamedAgent("implementer".to_string())));
        assert!(!r.covers_subject(&Subject::User));
    }

    #[test]
    fn an_unqualified_rule_still_covers_everyone() {
        // Existing rule sets must keep their meaning exactly.
        let r = rule("write");
        for subject in [
            Subject::MainAgent,
            Subject::User,
            reviewer(),
            Subject::Skill("formatter".to_string()),
            Subject::McpServer("github".to_string()),
        ] {
            assert!(r.covers_subject(&subject), "{subject:?}");
        }
    }

    #[test]
    fn a_deny_for_one_agent_does_not_deny_the_others() {
        let r = rule("agent:reviewer/write");
        assert!(r.matches_deny("write", &no_resources(), &reviewer()));
        assert!(!r.matches_deny("write", &no_resources(), &Subject::MainAgent));
    }

    /// O05-020: a deny or ask about the main agent binds the subagents it
    /// dispatches; an allow about it does not widen them.
    #[test]
    fn a_main_agent_deny_binds_its_subagents_but_its_allow_does_not() {
        let child = Subject::NamedAgent("child".to_string());
        assert!(rule("agent/write").matches_deny("write", &no_resources(), &child));
        assert!(rule("agent/write").matches_ask("write", &no_resources(), &child));
        let perms =
            ToolPermissions::new(PermissionDefault::Allow, &[], &["agent/bash".to_string()], &[]);
        assert!(perms.is_denied("bash", &child));
        assert!(!perms.is_denied("bash", &Subject::User));
        let inside = vec![Resource::Path(std::path::PathBuf::from("/proj/src/main.rs"))];
        assert!(!rule("agent/read").matches_allow("read", &inside, &child));
        assert!(!rule("agent:child/write").matches_deny("write", &no_resources(), &Subject::MainAgent));
    }

    #[test]
    fn an_allow_for_one_agent_does_not_allow_the_others() {
        let r = rule("agent:reviewer/read");
        let inside = vec![Resource::Path(std::path::PathBuf::from(
            "/proj/src/main.rs",
        ))];
        assert!(r.matches_allow("read", &inside, &reviewer()));
        assert!(!r.matches_allow(
            "read",
            &inside,
            &Subject::NamedAgent("implementer".to_string())
        ));
    }

    /// A child narrows; it never widens. A parent's deny still binds a
    /// subagent that has an allow of its own.
    #[test]
    fn a_subagent_allow_cannot_escape_a_blanket_deny() {
        let perms = ToolPermissions::new(
            PermissionDefault::ReadOnly,
            &["agent:reviewer/write".to_string()],
            &["write".to_string()],
            &[],
        );
        let resources = vec![Resource::Path(std::path::PathBuf::from(
            "/proj/src/main.rs",
        ))];
        // Deny is unqualified, so it covers the reviewer too -- and deny wins.
        assert!(perms
            .denies_call("write", &resources, &reviewer())
            .is_some());
    }

    #[test]
    fn the_other_subject_kinds_are_matched_too() {
        assert!(
            rule("skill:formatter/write").covers_subject(&Subject::Skill("formatter".to_string()))
        );
        assert!(
            !rule("skill:formatter/write").covers_subject(&Subject::Skill("linter".to_string()))
        );
        assert!(rule("mcp:github/read").covers_subject(&Subject::McpServer("github".to_string())));
        assert!(!rule("mcp:github/read").covers_subject(&Subject::McpServer("gitlab".to_string())));
    }
}

#[cfg(test)]
mod rule_warnings {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|v| v.to_string()).collect()
    }

    fn kinds(list: &str, rules: &[&str]) -> Vec<RuleWarningKind> {
        lint_rules(list, &s(rules)).into_iter().map(|w| w.kind).collect()
    }

    #[test]
    fn sound_rules_raise_no_warning() {
        for rule in [
            "bash",
            "bash(git:force-push)",
            "bash(git push*)",
            "bash(*)",
            "read(**/.ssh/**)",
            "read(path:/etc/**)",
            "write(src/locked/**)",
            "agent:reviewer/bash(git:push)",
            "web_fetch(net:example.com)",
            "mcp.search",
            "fs.*",
            "rag*",
            "browser(open*)",
        ] {
            assert!(kinds("deny", &[rule]).is_empty(), "{rule} wrongly warned");
        }
    }

    #[test]
    fn malformed_rules_are_reported_not_silently_dropped() {
        for rule in ["[", "", "  ", "bash([)", "nobody:x/bash"] {
            assert_eq!(kinds("deny", &[rule]), vec![RuleWarningKind::Malformed], "{rule:?}");
        }
        // A missing close paren parses, but as a tool that cannot exist.
        assert_eq!(kinds("deny", &["bash(git push"]), vec![RuleWarningKind::Malformed]);
    }

    #[test]
    fn a_misspelled_tool_is_reported() {
        assert_eq!(kinds("deny", &["bsh"]), vec![RuleWarningKind::UnknownTool]);
        assert_eq!(kinds("deny", &["rread(**/.env)"]), vec![RuleWarningKind::UnknownTool]);
        // Dotted and globbed names may be MCP tools.
        assert!(kinds("deny", &["server.tool", "mcp*"]).is_empty());
    }

    #[test]
    fn a_resource_rule_on_a_tool_without_that_resource_is_reported() {
        // `web_search` and `memory_write` have no path to match.
        assert_eq!(kinds("deny", &["memory_write(secrets/**)"]), vec![RuleWarningKind::IneffectiveResource]);
        // Wrong kind for the tool.
        assert_eq!(kinds("deny", &["read(git:force-push)"]), vec![RuleWarningKind::IneffectiveResource]);
        assert_eq!(kinds("deny", &["bash(path:/etc/**)"]), vec![RuleWarningKind::IneffectiveResource]);
        assert_eq!(kinds("deny", &["web_fetch(command:curl*)"]), vec![RuleWarningKind::IneffectiveResource]);
    }

    #[test]
    fn a_wildcard_glued_to_the_program_is_reported() {
        assert_eq!(kinds("allow", &["bash(git*)"]), vec![RuleWarningKind::UnsafeWildcard]);
        assert_eq!(kinds("allow", &["bash(rm?)"]), vec![RuleWarningKind::UnsafeWildcard]);
        assert_eq!(kinds("allow", &["bash(command:npm*)"]), vec![RuleWarningKind::UnsafeWildcard]);
        // Spaced wildcards and the git class are fine.
        assert!(kinds("allow", &["bash(git *)", "bash(git:push)", "bash(npm run *)"]).is_empty());
    }

    #[test]
    fn load_succeeds_and_carries_warnings_with_their_list() {
        let perms = ToolPermissions::new(
            PermissionDefault::Allow,
            &s(&["bash(git*)"]),
            &s(&["rread(**/.env)", "["]),
            &s(&["write(src/**)"]),
        )
        .with_ask(&s(&["bash(path:/x)"]));
        let got: Vec<(&str, RuleWarningKind)> =
            perms.warnings().iter().map(|w| (w.list.as_str(), w.kind)).collect();
        assert_eq!(
            got,
            vec![
                ("allow", RuleWarningKind::UnsafeWildcard),
                ("deny", RuleWarningKind::UnknownTool),
                ("deny", RuleWarningKind::Malformed),
                ("ask", RuleWarningKind::IneffectiveResource),
            ]
        );
        assert!(perms.warnings().iter().filter(|w| w.list == "deny").all(RuleWarning::weakens_restriction));
        assert!(!perms.warnings()[0].weakens_restriction());
        // Rules that survived still work.
        assert!(perms.advertises_mcp("x", &crate::subject::Subject::MainAgent));
    }
}
