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

use crate::resource::{Resource, ResourceRule};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PermissionDefault {
    Allow,
    Deny,
    #[default]
    ReadOnly,
}

impl PermissionDefault {
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
        }
    }

    /// Permissive: allow-by-default with no lists. Used when no `[tools]` section
    /// is configured, preserving the loop's historical "run all tools" behavior.
    pub fn allow_all() -> Self {
        Self {
            default: PermissionDefault::Allow,
            allow: Vec::new(),
            deny: Vec::new(),
            allow_write: Vec::new(),
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
            .any(|r| r.matches_name(name) && r.covers_subject(subject))
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
