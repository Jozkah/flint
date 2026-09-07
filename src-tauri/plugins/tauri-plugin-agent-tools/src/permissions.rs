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
    patterns.iter().filter_map(|p| ResourceRule::parse(p)).collect()
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

    /// Whether any deny rule names this tool, ignoring what the call touches.
    ///
    /// The conservative view, kept for callers that have no resources to hand:
    /// a resource-qualified deny still reports the tool as denied here, so a
    /// caller without resources never under-reports a restriction.
    pub fn is_denied(&self, name: &str) -> bool {
        self.deny.iter().any(|r| r.matches_name(name))
    }

    /// Explicit allow-list membership (allow OR allow_write); does NOT consider deny or default.
    pub fn is_allowed(&self, name: &str) -> bool {
        self.allow.iter().any(|r| r.matches_name(name))
            || self.allow_write.iter().any(|r| r.matches_name(name))
    }

    /// Whether this specific call is denied.
    ///
    /// Unlike [`is_denied`], this consults the resources the call actually
    /// touches, so `bash(git:force-push)` denies a force push and leaves
    /// `git status` alone. A resource the gate could not determine is denied by
    /// any rule that names the tool.
    pub fn denies_call(&self, name: &str, resources: &[Resource]) -> Option<&ResourceRule> {
        self.deny.iter().find(|r| r.matches_deny(name, resources))
    }

    /// Whether this specific call is explicitly allowed.
    ///
    /// A call carrying a resource the gate could not determine is never allowed
    /// here: `matches_allow` refuses to vouch for what it could not read.
    pub fn allows_call(&self, name: &str, resources: &[Resource]) -> Option<&ResourceRule> {
        self.allow
            .iter()
            .chain(self.allow_write.iter())
            .find(|r| r.matches_allow(name, resources))
    }

    /// Whether a *write* was explicitly pre-approved for this call.
    pub fn allows_write_call(&self, name: &str, resources: &[Resource]) -> Option<&ResourceRule> {
        self.allow_write
            .iter()
            .find(|r| r.matches_allow(name, resources))
    }

    /// Whether an MCP tool is advertised to the model. Deny always wins. Otherwise
    /// an explicit allow, or any default except `deny`, advertises it. Unlike
    /// built-in fs/exec tools, MCP tools are opaque and the user opted into them by
    /// configuring the server, so `read-only` does not suppress them (`deny` locks
    /// everything down). Execution of built-ins is gated separately at call time.
    pub fn advertises_mcp(&self, tool_name: &str) -> bool {
        if self.is_denied(tool_name) {
            return false;
        }
        self.is_allowed(tool_name) || !matches!(self.default, PermissionDefault::Deny)
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
        assert!(perms.advertises_mcp("mcp.search"));
    }

    #[test]
    fn deny_default_locks_down_mcp_unless_allowed() {
        let perms = ToolPermissions::new(PermissionDefault::Deny, &[], &[], &[]);
        assert!(!perms.advertises_mcp("mcp.search"));

        let perms = ToolPermissions::new(PermissionDefault::Deny, &s(&["mcp.search"]), &[], &[]);
        assert!(perms.advertises_mcp("mcp.search"));
    }

    #[test]
    fn deny_wins_over_default_and_allow() {
        let perms = ToolPermissions::new(
            PermissionDefault::Allow,
            &s(&["fs.*"]),
            &s(&["fs.delete"]),
            &[],
        );
        assert!(perms.advertises_mcp("fs.read"));
        assert!(!perms.advertises_mcp("fs.delete"));
    }

    #[test]
    fn is_allowed_matches_globs_only() {
        let perms = ToolPermissions::new(PermissionDefault::ReadOnly, &s(&["rag.*"]), &[], &[]);
        assert!(perms.is_allowed("rag.query"));
        assert!(!perms.is_allowed("mcp.search"));
    }

    #[test]
    fn allow_all_advertises_everything() {
        assert!(ToolPermissions::allow_all().advertises_mcp("x"));
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
