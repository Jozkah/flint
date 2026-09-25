//! Policy an administrator sets for the machine, which a project cannot
//! loosen. AH-187.
//!
//! `.jan/agent/agent.toml` is the *project's* policy, and anyone who can write
//! the repository can write it. That is the right answer for a developer's own
//! rules and the wrong one for an organisation's: "this machine may not reach
//! the internet from a tool" has to survive a checkout that says otherwise.
//!
//! So there is a second file, outside every project, that only an
//! administrator can write:
//!
//! * Windows: `%ProgramData%\Jan\policy.toml`
//! * elsewhere: `/etc/jan/policy.toml`
//!
//! It is read where the project's own policy is read, and the two are combined
//! by one rule: **a project may tighten and may never loosen.** Denies are the
//! union of both. Network access is allowed only if both allow it. Where the
//! organisation lists the domains that may be reached, a project may choose
//! fewer, never others. Where the organisation caps the permission default, a
//! project may be stricter than the cap and not more permissive.
//!
//! Two decisions worth stating, because both are places a bypass would
//! otherwise live:
//!
//! * **`JAN_ORG_POLICY` is a fallback, not an override.** It names a policy
//!   file for a machine that has none installed -- a container, a test. When
//!   the system file exists, the environment variable is ignored, because
//!   anything a user can set is not a place administrator policy can come
//!   from.
//! * **A policy file that will not parse denies rather than disappears.** A
//!   syntax error in an organisation's deny list must never read as "no
//!   policy": it is reported, and what could be read is still applied.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::permissions::PermissionDefault;

/// The environment variable naming a policy file, honoured only on a machine
/// with no installed policy.
pub const FALLBACK_ENV: &str = "JAN_ORG_POLICY";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OrgPolicyErrorKind {
    /// The file is not valid TOML.
    Malformed,
    /// The file could not be read, though something is there.
    Io,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrgPolicyError {
    pub kind: OrgPolicyErrorKind,
    pub message: String,
}

impl OrgPolicyError {
    fn new(kind: OrgPolicyErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: crate::harness_error::scrub(&message.into()) }
    }
}

/// What this failure is in the harness's own vocabulary (AH-009).
impl From<&OrgPolicyError> for crate::harness_error::HarnessError {
    fn from(error: &OrgPolicyError) -> Self {
        use crate::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            OrgPolicyErrorKind::Malformed => ErrorKind::InvalidInput,
            OrgPolicyErrorKind::Io => ErrorKind::Io,
        };
        HarnessError::new(kind, error.message.clone()).at(Stage::Tool)
    }
}

#[derive(Debug, Default, Deserialize)]
struct PolicyToml {
    #[serde(default)]
    tools: ToolsSection,
}

#[derive(Debug, Default, Deserialize)]
struct ToolsSection {
    /// The most permissive default a project may declare.
    #[serde(default)]
    max_default: Option<String>,
    /// Denied everywhere on this machine, whatever a project says.
    #[serde(default)]
    deny: Vec<String>,
    /// When set to `false`, no project may turn network access on.
    #[serde(default)]
    allow_network: Option<bool>,
    /// When non-empty, the only destinations any project may reach.
    #[serde(default)]
    allow_domains: Vec<String>,
    /// Destinations nothing on this machine may reach.
    #[serde(default)]
    deny_domains: Vec<String>,
    /// When set to `false`, no custom certificate authority bundle is trusted
    /// on this machine (AH-190), whoever names one.
    #[serde(default)]
    allow_ca_bundle: Option<bool>,
}

/// What an administrator decided for this machine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrgPolicy {
    /// Where it was read from, for the person who has to explain a refusal.
    pub source: PathBuf,
    pub max_default: Option<PermissionDefault>,
    pub deny: Vec<String>,
    pub allow_network: Option<bool>,
    pub allow_domains: Vec<String>,
    pub deny_domains: Vec<String>,
    pub allow_ca_bundle: Option<bool>,
}

/// How permissive a default is, so two can be compared. Higher is more
/// permissive, which is the direction a project may not move in.
pub(crate) fn permissiveness(value: PermissionDefault) -> u8 {
    match value {
        PermissionDefault::Deny => 0,
        PermissionDefault::ReadOnly => 1,
        PermissionDefault::Allow => 2,
    }
}

impl OrgPolicy {
    /// The permission default a project ends up with.
    ///
    /// The stricter of the two, always. A project that asks for `allow` under
    /// an organisation capped at `read-only` gets `read-only`; one that asks
    /// for `deny` keeps `deny`, because tightening is always its own to do.
    pub fn clamp_default(&self, project: PermissionDefault) -> PermissionDefault {
        match self.max_default {
            Some(cap) if permissiveness(project) > permissiveness(cap) => cap,
            _ => project,
        }
    }

    /// The deny list a project ends up with: everything either of them denies.
    pub fn clamp_deny(&self, project: &[String]) -> Vec<String> {
        let mut out = self.deny.clone();
        for rule in project {
            if !out.contains(rule) {
                out.push(rule.clone());
            }
        }
        out
    }

    /// Whether the network may be reached at all.
    pub fn clamp_network(&self, project: bool) -> bool {
        match self.allow_network {
            Some(false) => false,
            _ => project,
        }
    }

    /// The destinations a project may reach.
    ///
    /// With no organisation list, the project's own. With one, the
    /// intersection -- and an empty project list means "anywhere not denied",
    /// which under an organisation list means "anywhere on the list".
    pub fn clamp_allow_domains(&self, project: &[String]) -> Vec<String> {
        if self.allow_domains.is_empty() {
            return project.to_vec();
        }
        if project.is_empty() {
            return self.allow_domains.clone();
        }
        // Subsumption, not string equality: a project that narrows
        // `docs.internal` to `api.docs.internal` has narrowed, and dropping it
        // for not matching exactly would be the wrong answer twice over --
        // because an *empty* result reads as "anywhere not denied" at the
        // gate. So a project list that shares nothing with the machine's
        // leaves the machine's list standing, which is the narrowest thing
        // that is true.
        let kept: Vec<String> = project
            .iter()
            .filter(|d| {
                let host = d.trim().trim_start_matches("*.").to_ascii_lowercase();
                self.allow_domains.iter().any(|rule| {
                    let rule = rule.trim().trim_start_matches("*.").to_ascii_lowercase();
                    host == rule || host.ends_with(&format!(".{rule}"))
                })
            })
            .cloned()
            .collect();
        if kept.is_empty() {
            return self.allow_domains.clone();
        }
        kept
    }

    /// The destinations nothing may reach: everything either of them denies.
    pub fn clamp_deny_domains(&self, project: &[String]) -> Vec<String> {
        let mut out = self.deny_domains.clone();
        for domain in project {
            if !out.contains(domain) {
                out.push(domain.clone());
            }
        }
        out
    }

    /// Whether this policy actually constrains anything.
    pub fn is_empty(&self) -> bool {
        self.max_default.is_none()
            && self.deny.is_empty()
            && self.allow_network.is_none()
            && self.allow_domains.is_empty()
            && self.deny_domains.is_empty()
            && self.allow_ca_bundle.is_none()
    }
}

/// Where an installed machine policy lives.
pub fn system_path() -> PathBuf {
    #[cfg(windows)]
    {
        program_data().join("Jan").join("policy.toml")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/etc/jan/policy.toml")
    }
}

/// The machine's ProgramData folder, asked of Windows rather than of the
/// environment.
///
/// `%ProgramData%` is an ordinary process environment variable: anyone who can
/// start Jan can set it, and pointing it at an empty directory would make an
/// administrator's policy simply disappear. The known-folder API answers from
/// the system, so it cannot be moved by the process being constrained.
#[cfg(windows)]
fn program_data() -> PathBuf {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath};

    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: the call writes one owned wide string, which is freed below, and
    // is given a null token to mean "this machine's common folder".
    let ok = unsafe {
        SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, std::ptr::null_mut(), &mut raw) == 0
    };
    if !ok || raw.is_null() {
        // Not the environment's answer: a fixed path is wrong far less often
        // than a path the caller chose.
        return PathBuf::from("C:\\ProgramData");
    }
    let mut len = 0usize;
    // SAFETY: `raw` is a null-terminated wide string owned by the shell.
    while unsafe { *raw.add(len) } != 0 {
        len += 1;
    }
    let wide = unsafe { std::slice::from_raw_parts(raw, len) };
    let path = std::ffi::OsString::from_wide(wide);
    unsafe { windows_sys::Win32::System::Com::CoTaskMemFree(raw as *mut _) };
    PathBuf::from(path)
}

/// Read this machine's policy, if it has one.
pub fn load() -> (Option<OrgPolicy>, Option<OrgPolicyError>) {
    let fallback = std::env::var_os(FALLBACK_ENV).map(PathBuf::from);
    load_from(&system_path(), fallback.as_deref())
}

/// The same, with the two paths given.
///
/// Split out so the rule that matters can be tested: when the installed file
/// exists, the environment variable is not consulted at all. A policy a user
/// can point somewhere else is not administrator policy.
pub fn load_from(
    system: &Path,
    fallback: Option<&Path>,
) -> (Option<OrgPolicy>, Option<OrgPolicyError>) {
    let path = if system.is_file() {
        system.to_path_buf()
    } else {
        match fallback {
            Some(path) if path.is_file() => path.to_path_buf(),
            _ => return (None, None),
        }
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        // A file that is there and cannot be read is not "no policy". It is a
        // policy this process was not allowed to see -- an ACL, another
        // process holding it open -- and reading that as permission is the
        // failure this whole module exists to prevent. Strictest reading, and
        // the administrator is told.
        Err(e) => {
            return (
                Some(OrgPolicy {
                    source: path,
                    max_default: Some(PermissionDefault::ReadOnly),
                    allow_network: Some(false),
                    allow_ca_bundle: Some(false),
                    ..OrgPolicy::default()
                }),
                Some(OrgPolicyError::new(
                    OrgPolicyErrorKind::Io,
                    format!(
                        "the machine policy is there and could not be read, so the strictest \
                         reading of it is in force: {e}"
                    ),
                )),
            )
        }
    };
    let parsed: PolicyToml = match toml::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            // Deliberately not "no policy": a syntax error in an
            // organisation's deny list must never read as permission.
            return (
                Some(OrgPolicy {
                    source: path,
                    max_default: Some(PermissionDefault::ReadOnly),
                    allow_network: Some(false),
                    allow_ca_bundle: Some(false),
                    ..OrgPolicy::default()
                }),
                Some(OrgPolicyError::new(
                    OrgPolicyErrorKind::Malformed,
                    format!("the machine policy could not be understood, so the strictest \
                             reading of it is in force: {e}"),
                )),
            );
        }
    };
    let tools = parsed.tools;
    (
        Some(OrgPolicy {
            source: path,
            max_default: tools.max_default.as_deref().map(PermissionDefault::from_str_lenient),
            deny: tools.deny,
            allow_network: tools.allow_network,
            allow_domains: tools.allow_domains,
            deny_domains: tools.deny_domains,
            allow_ca_bundle: tools.allow_ca_bundle,
        }),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-org-policy-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    const STRICT: &str = r#"
[tools]
max_default = "read-only"
deny = ["bash(rm *)"]
allow_network = false
deny_domains = ["evil.example"]
"#;

    /// AH-190: an administrator can forbid custom CA bundles, and a policy
    /// that cannot be read or understood forbids them too.
    #[test]
    fn a_machine_policy_can_forbid_custom_certificate_authorities() {
        let d = dir("ca");
        let forbid = write(&d, "forbid.toml", "[tools]\nallow_ca_bundle = false\n");
        let (policy, error) = load_from(&forbid, None);
        assert!(error.is_none());
        let policy = policy.unwrap();
        assert_eq!(policy.allow_ca_bundle, Some(false));
        assert!(!policy.is_empty());
        let silent = write(&d, "silent.toml", "[tools]\ndeny = [\"bash\"]\n");
        assert_eq!(load_from(&silent, None).0.unwrap().allow_ca_bundle, None, "saying nothing forbids nothing");
        let broken = write(&d, "broken.toml", "[tools\nallow_ca_bundle = ");
        assert_eq!(load_from(&broken, None).0.unwrap().allow_ca_bundle, Some(false), "a malformed policy is read at its strictest");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_machine_with_no_policy_constrains_nothing() {
        let d = dir("none");
        let (policy, error) = load_from(&d.join("absent.toml"), None);
        assert!(policy.is_none() && error.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The property the whole feature exists for.
    #[test]
    fn a_project_may_tighten_and_may_never_loosen() {
        let d = dir("clamp");
        let (policy, error) = load_from(&write(&d, "policy.toml", STRICT), None);
        let policy = policy.expect("a policy was installed");
        assert!(error.is_none());

        // A project that asks for everything gets the cap.
        assert_eq!(policy.clamp_default(PermissionDefault::Allow), PermissionDefault::ReadOnly);
        // A project stricter than the cap keeps its own answer.
        assert_eq!(policy.clamp_default(PermissionDefault::Deny), PermissionDefault::Deny);
        // The organisation's denies survive a project that lists none.
        assert_eq!(policy.clamp_deny(&[]), ["bash(rm *)"]);
        // And a project's own denies are added, not replaced.
        let both = policy.clamp_deny(&["read(**/.ssh/**)".to_string()]);
        assert!(both.contains(&"bash(rm *)".to_string()));
        assert!(both.contains(&"read(**/.ssh/**)".to_string()));
        // The network stays off however loudly the project asks.
        assert!(!policy.clamp_network(true));
        // A denied destination cannot be un-denied.
        assert!(policy
            .clamp_deny_domains(&["other.example".to_string()])
            .contains(&"evil.example".to_string()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn where_the_organisation_names_destinations_a_project_may_choose_fewer_not_others() {
        let d = dir("domains");
        let (policy, _) = load_from(
            &write(
                &d,
                "policy.toml",
                "[tools]\nallow_domains = [\"docs.internal\", \"registry.internal\"]\n",
            ),
            None,
        );
        let policy = policy.unwrap();
        // Fewer: allowed.
        assert_eq!(policy.clamp_allow_domains(&["docs.internal".to_string()]), ["docs.internal"]);
        // Others: not reachable, however the project lists them -- and the
        // answer is the machine's list rather than an empty one, because an
        // empty allow list reads as "anywhere not denied" at the gate.
        assert_eq!(
            policy.clamp_allow_domains(&["evil.example".to_string()]),
            ["docs.internal", "registry.internal"]
        );
        // A project narrowing to a subdomain has narrowed, and keeps it.
        assert_eq!(
            policy.clamp_allow_domains(&["api.docs.internal".to_string()]),
            ["api.docs.internal"]
        );
        // "Anywhere" under an organisation list means "anywhere on the list".
        assert_eq!(
            policy.clamp_allow_domains(&[]),
            ["docs.internal", "registry.internal"]
        );
        // A project's network setting is untouched where the organisation did
        // not speak to it.
        assert!(policy.clamp_network(true));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The bypass this feature would otherwise have: an environment variable
    /// anyone can set, naming a policy of their own.
    #[test]
    fn the_environment_cannot_replace_an_installed_policy() {
        let d = dir("env");
        let installed = write(&d, "system.toml", STRICT);
        let permissive = write(
            &d,
            "mine.toml",
            "[tools]\nmax_default = \"allow\"\nallow_network = true\n",
        );

        // With a policy installed, the variable is not consulted.
        let (policy, _) = load_from(&installed, Some(&permissive));
        let policy = policy.unwrap();
        assert_eq!(policy.source, installed);
        assert_eq!(policy.clamp_default(PermissionDefault::Allow), PermissionDefault::ReadOnly);
        assert!(!policy.clamp_network(true));

        // With none installed, it is the only way a container gets one.
        let (fallback, _) = load_from(&d.join("absent.toml"), Some(&permissive));
        assert_eq!(fallback.unwrap().source, permissive);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A policy that cannot be read is not permission.
    #[test]
    fn a_policy_that_will_not_parse_is_read_at_its_strictest() {
        let d = dir("malformed");
        let (policy, error) = load_from(&write(&d, "policy.toml", "this is not toml"), None);
        let error = error.expect("the administrator has to be told");
        assert_eq!(error.kind, OrgPolicyErrorKind::Malformed);
        let policy = policy.expect("a broken policy is still a policy");
        assert_eq!(policy.clamp_default(PermissionDefault::Allow), PermissionDefault::ReadOnly);
        assert!(!policy.clamp_network(true), "a file nobody can read does not grant the network");

        // AH-009: the administrator's mistake is theirs to fix, and is never
        // retried into working.
        let harness: crate::harness_error::HarnessError = (&error).into();
        assert_eq!(harness.kind(), crate::harness_error::ErrorKind::InvalidInput);
        assert_eq!(harness.retry(), crate::harness_error::Retry::Never);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_policy_that_says_nothing_is_reported_as_saying_nothing() {
        let d = dir("empty");
        let (policy, error) = load_from(&write(&d, "policy.toml", "[tools]\n"), None);
        assert!(error.is_none());
        assert!(policy.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
