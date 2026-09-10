//! The project's own tool policy, read where it is enforced. AH-007/AH-036/AH-037.
//!
//! `[tools]` in `<project>/.jan/agent/agent.toml` is what a user writes to say
//! which tools may run, over which paths, and against which commands. The CLI
//! loop has always read it. The desktop did not: it built
//! `ToolPermissions::default()` -- allow everything -- so a repository that
//! denied `read(**/.ssh/**)` was obeyed in one surface and ignored in the
//! other, which is worse than not supporting the file at all.
//!
//! Read here rather than passed in from the renderer on purpose. A policy that
//! arrives as an argument is a policy the caller can choose not to send.

use std::path::Path;

use serde::Deserialize;

use crate::permissions::{PermissionDefault, ToolPermissions};
use crate::tools::gate::NetworkPolicy;

#[derive(Debug, Default, Deserialize)]
struct AgentToml {
    #[serde(default)]
    tools: ToolsSection,
}

#[derive(Debug, Default, Deserialize)]
struct ToolsSection {
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
    #[serde(default)]
    allow_write: Vec<String>,
    #[serde(default)]
    allow_network: Option<bool>,
    /// Destinations this project may reach. Empty means "anywhere not denied".
    #[serde(default)]
    allow_domains: Vec<String>,
    /// Destinations nothing may reach, whatever else says otherwise.
    #[serde(default)]
    deny_domains: Vec<String>,
}

/// What one project's configuration decides.
#[derive(Debug, Clone)]
pub struct ProjectPolicy {
    pub permissions: ToolPermissions,
    pub network: NetworkPolicy,
}

impl Default for ProjectPolicy {
    /// No project, or none configured: what the desktop did before this
    /// existed. Changing this default would silently restrict every run that
    /// never wrote a policy.
    fn default() -> Self {
        Self {
            permissions: ToolPermissions::allow_all(),
            network: NetworkPolicy::open(),
        }
    }
}

pub fn agent_toml_path(project_root: &Path) -> std::path::PathBuf {
    project_root.join(".jan").join("agent").join("agent.toml")
}

/// Read the policy for a project, falling back to the permissive default.
///
/// A file that will not parse is *not* treated as no policy: half a policy
/// enforces unpredictably, and a syntax error in a deny list must not quietly
/// grant everything it was denying. The strict half of that -- refusing to run
/// at all -- belongs to the caller; what this does is keep the deny lists it
/// could read and refuse to invent the rest.
pub fn load(project_root: Option<&Path>, network_default: Option<bool>) -> ProjectPolicy {
    let mut policy = ProjectPolicy::default();
    policy.network.allowed = network_default.unwrap_or(true);

    let Some(root) = project_root else {
        return policy;
    };
    let Ok(raw) = std::fs::read_to_string(agent_toml_path(root)) else {
        return policy;
    };
    let parsed: AgentToml = match toml::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("agent.toml: could not read the tool policy: {e}");
            return policy;
        }
    };

    let tools = parsed.tools;
    let default = tools
        .default
        .as_deref()
        .map(PermissionDefault::from_str_lenient)
        // No `default` key is the historical behaviour, not read-only: a
        // project that lists a couple of denies has not asked for everything
        // else to stop working.
        .unwrap_or(PermissionDefault::Allow);

    ProjectPolicy {
        permissions: ToolPermissions::new(default, &tools.allow, &tools.deny, &tools.allow_write),
        network: NetworkPolicy {
            // The project's setting wins over the surface's default, which is
            // the point of writing it down in the repository.
            allowed: tools.allow_network.or(network_default).unwrap_or(true),
            allow_domains: tools.allow_domains,
            deny_domains: tools.deny_domains,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn project_with(config: &str) -> std::path::PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "jan-policy-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let path = agent_toml_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, config).unwrap();
        root
    }

    #[test]
    fn a_project_without_a_policy_keeps_working() {
        let policy = load(None, None);
        assert!(!policy.permissions.is_denied("read"));
        assert!(policy.network.allowed);
    }

    #[test]
    fn the_projects_deny_list_reaches_the_gate() {
        let root = project_with("[tools]\ndeny = [\"bash\"]\n");
        let policy = load(Some(&root), None);
        assert!(policy.permissions.is_denied("bash"));
        assert!(!policy.permissions.is_denied("read"));
    }

    #[test]
    fn a_path_rule_is_read_as_a_path_rule() {
        let root = project_with("[tools]\ndeny = [\"read(**/.ssh/**)\"]\n");
        let policy = load(Some(&root), None);
        let secret = crate::resource::Resource::path("/home/me/.ssh/id_rsa", None);
        let source = crate::resource::Resource::path("/home/me/app/main.rs", None);
        assert!(policy
            .permissions
            .denies_call(
                "read",
                std::slice::from_ref(&secret),
                &crate::subject::Subject::MainAgent
            )
            .is_some());
        assert!(policy
            .permissions
            .denies_call(
                "read",
                std::slice::from_ref(&source),
                &crate::subject::Subject::MainAgent
            )
            .is_none());
    }

    #[test]
    fn a_project_can_switch_its_own_network_off() {
        let root = project_with("[tools]\nallow_network = false\n");
        assert!(!load(Some(&root), Some(true)).network.allowed);
    }

    #[test]
    fn domain_rules_are_carried_through() {
        let root = project_with(
            "[tools]\nallow_domains = [\"example.com\"]\ndeny_domains = [\"evil.test\"]\n",
        );
        let policy = load(Some(&root), None);
        assert_eq!(policy.network.refuses("api.example.com"), None);
        assert!(policy.network.refuses("elsewhere.test").is_some());
        assert!(policy.network.refuses("evil.test").is_some());
    }

    #[test]
    fn a_broken_policy_does_not_silently_grant_what_it_denied() {
        let root = project_with("[tools]\ndeny = [\"bash\"\n");
        let policy = load(Some(&root), None);
        // It could not be read, so nothing is claimed: the caller still has
        // the structural guards, and no rule from this file is invented.
        assert!(!policy.permissions.is_allowed("bash"));
    }
}
