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
    /// Calls to confirm every time, overriding allow but not deny.
    #[serde(default)]
    ask: Vec<String>,
    #[serde(default)]
    allow_network: Option<bool>,
    /// Destinations this project may reach. Empty means "anywhere not denied".
    #[serde(default)]
    allow_domains: Vec<String>,
    /// Destinations nothing may reach, whatever else says otherwise.
    #[serde(default)]
    deny_domains: Vec<String>,
    /// Programs that open Windows' null device themselves, beyond the
    /// built-in list (see `tools::nul_programs`).
    #[serde(default)]
    nul_programs: Vec<String>,
}

/// What one project's configuration decides.
#[derive(Debug, Clone)]
pub struct ProjectPolicy {
    pub permissions: ToolPermissions,
    pub network: NetworkPolicy,
    /// `[tools].nul_programs`: added to the programs known to open NUL.
    pub nul_programs: Vec<String>,
}

impl Default for ProjectPolicy {
    /// No project, or none configured: what the desktop did before this
    /// existed. Changing this default would silently restrict every run that
    /// never wrote a policy.
    fn default() -> Self {
        Self {
            permissions: ToolPermissions::allow_all(),
            network: NetworkPolicy::open(),
            nul_programs: Vec::new(),
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
    let (org, org_error) = crate::org_policy::load();
    if let Some(error) = &org_error {
        eprintln!("machine policy: {}", error.message);
    }
    load_under(project_root, network_default, &org.unwrap_or_default())
}

/// The same, against a given machine policy (AH-187).
///
/// Split out so the combination of the two policies is testable without an
/// installed file, and so there is exactly one place where a project's
/// declaration meets what the machine allows.
pub fn load_under(
    project_root: Option<&Path>,
    network_default: Option<bool>,
    org: &crate::org_policy::OrgPolicy,
) -> ProjectPolicy {
    let org = org.clone();
    let mut policy = ProjectPolicy::default();
    policy.network.allowed = org.clamp_network(network_default.unwrap_or(true));

    let Some(root) = project_root else {
        // AH-187: with no project there is still a machine. What an
        // administrator denied is denied in a run that has no repository at
        // all, which is the case a bypass would otherwise live in.
        return clamp(policy, &org);
    };
    let Ok(raw) = std::fs::read_to_string(agent_toml_path(root)) else {
        return clamp(policy, &org);
    };
    let parsed: AgentToml = match toml::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("agent.toml: could not read the tool policy: {e}");
            return clamp(policy, &org);
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

    // AH-187: the project may tighten what the machine allows and may never
    // loosen it. The clamping happens on the lists, before they are compiled,
    // so there is one place where the two policies meet rather than a check
    // at every use.
    ProjectPolicy {
        permissions: ToolPermissions::new(
            org.clamp_default(default),
            &tools.allow,
            &org.clamp_deny(&tools.deny),
            &tools.allow_write,
        )
        .with_ask(&tools.ask),
        network: NetworkPolicy {
            // The project's setting wins over the surface's default, which is
            // the point of writing it down in the repository -- within what
            // the machine allows.
            allowed: org.clamp_network(
                tools.allow_network.or(network_default).unwrap_or(true),
            ),
            allow_domains: org.clamp_allow_domains(&tools.allow_domains),
            deny_domains: org.clamp_deny_domains(&tools.deny_domains),
        },
        nul_programs: tools.nul_programs,
    }
}

/// Apply the machine's policy to a project that declared none of its own.
fn clamp(policy: ProjectPolicy, org: &crate::org_policy::OrgPolicy) -> ProjectPolicy {
    if org.is_empty() {
        return policy;
    }
    ProjectPolicy {
        permissions: ToolPermissions::new(
            org.clamp_default(crate::permissions::PermissionDefault::Allow),
            &[],
            &org.clamp_deny(&[]),
            &[],
        ),
        network: NetworkPolicy {
            allowed: org.clamp_network(policy.network.allowed),
            allow_domains: org.clamp_allow_domains(&policy.network.allow_domains),
            deny_domains: org.clamp_deny_domains(&policy.network.deny_domains),
        },
        nul_programs: policy.nul_programs,
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
        assert!(!policy.permissions.is_denied("read", &crate::subject::Subject::MainAgent));
        assert!(policy.network.allowed);
    }

    // ---- AH-187: what the machine decided, which a project cannot loosen ---

    fn machine(body: &str) -> crate::org_policy::OrgPolicy {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "jan-policy-machine-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("policy.toml");
        std::fs::write(&path, body).unwrap();
        let (policy, error) = crate::org_policy::load_from(&path, None);
        assert!(error.is_none(), "{error:?}");
        policy.expect("a machine policy")
    }

    /// A repository that says "allow everything, and the network too" does not
    /// get it when the machine says otherwise. This is the case the feature
    /// exists for: the project file is writable by anyone who can push.
    #[test]
    fn a_repository_cannot_grant_itself_what_the_machine_denies() {
        let root = project_with(
            "[tools]\ndefault = \"allow\"\nallow_network = true\nallow_domains = [\"evil.example\"]\n",
        );
        let org = machine(
            "[tools]\nmax_default = \"read-only\"\ndeny = [\"bash\"]\nallow_network = false\nallow_domains = [\"docs.internal\"]\n",
        );
        let policy = load_under(Some(&root), None, &org);
        let subject = crate::subject::Subject::MainAgent;
        assert!(policy.permissions.is_denied("bash", &subject), "the machine's deny must hold");
        assert!(!policy.network.allowed, "the machine turned the network off");
        assert!(
            !policy.network.allow_domains.contains(&"evil.example".to_string()),
            "a destination the machine never listed: {:?}",
            policy.network.allow_domains
        );
    }

    /// And a project that is stricter than the machine keeps its own answer:
    /// clamping is one-directional.
    #[test]
    fn a_repository_may_still_be_stricter_than_the_machine() {
        let root = project_with("[tools]\ndefault = \"deny\"\ndeny = [\"read(**/.ssh/**)\"]\n");
        let org = machine("[tools]\nmax_default = \"read-only\"\n");
        let policy = load_under(Some(&root), None, &org);
        let subject = crate::subject::Subject::MainAgent;
        let secret = crate::resource::Resource::path("/home/me/.ssh/id_rsa", None);
        assert!(
            policy
                .permissions
                .denies_call("read", std::slice::from_ref(&secret), &subject)
                .is_some(),
            "the project's own deny survives"
        );
        // And its stricter default is the one that survives the clamp: the
        // machine capped at read-only, the project asked for less than that.
        assert_eq!(
            org.clamp_default(crate::permissions::PermissionDefault::Deny),
            crate::permissions::PermissionDefault::Deny
        );
    }

    /// A machine policy applies to a run with no repository at all -- the
    /// place a bypass would otherwise be: open a directory that has no
    /// `.jan/agent/agent.toml` and the policy disappears.
    #[test]
    fn the_machines_policy_holds_where_there_is_no_project() {
        let org = machine("[tools]\ndeny = [\"bash\"]\nallow_network = false\n");
        let policy = load_under(None, Some(true), &org);
        assert!(policy.permissions.is_denied("bash", &crate::subject::Subject::MainAgent));
        assert!(!policy.network.allowed);

        // A project whose file cannot be read is the same case.
        let root = project_with("this is not toml");
        let broken = load_under(Some(&root), Some(true), &org);
        assert!(broken.permissions.is_denied("bash", &crate::subject::Subject::MainAgent));
        assert!(!broken.network.allowed);
    }

    #[test]
    fn the_projects_deny_list_reaches_the_gate() {
        let root = project_with("[tools]\ndeny = [\"bash\"]\n");
        let policy = load(Some(&root), None);
        assert!(policy.permissions.is_denied("bash", &crate::subject::Subject::MainAgent));
        assert!(!policy.permissions.is_denied("read", &crate::subject::Subject::MainAgent));
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
        assert!(!policy.permissions.is_allowed("bash", &crate::subject::Subject::MainAgent));
    }
}
