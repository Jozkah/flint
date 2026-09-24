//! Sharing a permission policy as a file somebody can read. AH-052.
//!
//! A project's policy lives in its `agent.toml`, which is reviewable and can be
//! committed -- but nothing could take one out, check it, and put it back. A
//! policy copied by hand between projects is a policy nobody diffed: a rule
//! that does not parse is dropped silently at runtime (which is right there,
//! where half a rule matching unpredictably is worse than no rule), and a
//! *deny* rule lost in the copy is an authority change that looks like nothing
//! at all.
//!
//! So the transfer path is strict where the runtime is lenient:
//!
//! * Every rule must parse. A document with a rule this build cannot read is
//!   refused whole, because the point of the file is that what it says is what
//!   will happen.
//! * Only the keys a policy has. A document carrying anything else -- a grant,
//!   an approval, a signature, a "trusted" flag -- is refused rather than
//!   quietly ignored: an unknown key is either meaningless or an attempt to
//!   bring authority along with the rules.
//! * A removal is named, not applied. Importing something that drops a deny
//!   rule the project currently has is refused unless the caller says it means
//!   to, and the refusal says exactly which rules would go.
//!
//! Nothing here grants anything. An imported policy is rules; approvals,
//! session grants and the gate's own decisions are not in it and cannot be.

use serde::{Deserialize, Serialize};

use crate::harness_error::{ErrorKind, HarnessError, Stage};

/// The document's version. A reader that meets a newer one refuses it.
pub const POLICY_DOCUMENT_VERSION: u16 = 1;

/// The keys a policy document may have. Anything else is refused.
const KNOWN_KEYS: &[&str] = &["v", "default", "allow", "deny", "allowWrite", "note"];

/// A policy, as a file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDocument {
    pub v: u16,
    /// `read-only`, `deny` or `allow`, as `[tools].default` spells them.
    pub default: String,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    #[serde(default)]
    pub allow_write: Vec<String>,
    /// A line for whoever reads the file. Never interpreted.
    #[serde(default)]
    pub note: String,
}

/// What importing a document would change about the policy in force.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyChange {
    /// Rules the document adds.
    pub allow_added: Vec<String>,
    pub deny_added: Vec<String>,
    pub allow_write_added: Vec<String>,
    /// Rules the document drops. A dropped `deny` widens what the agent may
    /// do, which is the change worth stopping on.
    pub allow_removed: Vec<String>,
    pub deny_removed: Vec<String>,
    pub allow_write_removed: Vec<String>,
    /// Whether the default mode changes, and to what.
    #[serde(default)]
    pub default_changed_to: Option<String>,
    /// What the default was before, when it changes. Whether a new default
    /// widens depends on what it replaces: `read-only` is a narrowing from
    /// `allow` and a widening from `deny`.
    #[serde(default)]
    pub default_changed_from: Option<String>,
}

impl PolicyChange {
    /// Whether this change can only widen nothing: no deny dropped, no write
    /// rule added, and the default not loosened.
    pub fn is_narrowing_or_equal(&self) -> bool {
        self.deny_removed.is_empty()
            && self.allow_write_added.is_empty()
            && self.allow_added.is_empty()
            && !self.loosens_default()
    }

    /// Whether the default moves up the `deny` < `read-only` < `allow` order,
    /// the same ranking an org policy holds a project to. Only `allow` used to
    /// count, so `deny` to `read-only` -- which advertises every MCP tool that
    /// `deny` hid -- was imported without consent (Jozkah/jan#44).
    fn loosens_default(&self) -> bool {
        let Some(to) = self.default_changed_to.as_deref() else {
            return false;
        };
        let rank = |value: &str| {
            crate::org_policy::permissiveness(crate::permissions::PermissionDefault::from_str_lenient(
                value,
            ))
        };
        // No previous value recorded: judge against the tightest default.
        let from = self.default_changed_from.as_deref().map_or(0, rank);
        rank(to) > from
    }

    /// Everything this change would let the agent do that it cannot do now:
    /// a denial lifted, a rule that permits something added, or the default
    /// opened. This is what an import must not do quietly.
    pub fn widenings(&self) -> Vec<String> {
        let mut out = Vec::new();
        out.extend(self.deny_removed.iter().map(|r| format!("stops denying {r}")));
        out.extend(self.allow_added.iter().map(|r| format!("allows {r}")));
        out.extend(
            self.allow_write_added
                .iter()
                .map(|r| format!("allows writing with {r}")),
        );
        if self.loosens_default() {
            let to = self.default_changed_to.as_deref().unwrap_or_default();
            let from = self.default_changed_from.as_deref().unwrap_or("unknown");
            out.push(if to == "allow" {
                format!("allows everything by default (was {from})")
            } else {
                format!("loosens the default from {from} to {to}")
            });
        }
        out
    }

    /// Everything this change would take away.
    pub fn removals(&self) -> Vec<String> {
        let mut out = Vec::new();
        out.extend(self.deny_removed.iter().map(|r| format!("deny {r}")));
        out.extend(self.allow_removed.iter().map(|r| format!("allow {r}")));
        out.extend(
            self.allow_write_removed
                .iter()
                .map(|r| format!("allow_write {r}")),
        );
        out
    }

    pub fn is_empty(&self) -> bool {
        self.allow_added.is_empty()
            && self.deny_added.is_empty()
            && self.allow_write_added.is_empty()
            && self.removals().is_empty()
            && self.default_changed_to.is_none()
    }
}

/// Take the policy out as a document.
pub fn export(default: &str, allow: &[String], deny: &[String], allow_write: &[String]) -> PolicyDocument {
    PolicyDocument {
        v: POLICY_DOCUMENT_VERSION,
        default: default.to_string(),
        allow: allow.to_vec(),
        deny: deny.to_vec(),
        allow_write: allow_write.to_vec(),
        note: String::new(),
    }
}

/// The document as JSON somebody can read and a diff can show.
pub fn render(document: &PolicyDocument) -> String {
    serde_json::to_string_pretty(document).unwrap_or_else(|_| "{}".to_string())
}

/// Read a document, refusing anything this build cannot promise to honour.
pub fn parse(text: &str) -> Result<PolicyDocument, HarnessError> {
    let refuse = |message: String| HarnessError::new(ErrorKind::InvalidInput, message).at(Stage::Startup);
    let raw: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| refuse(format!("this is not a policy document: {e}")))?;
    let Some(object) = raw.as_object() else {
        return Err(refuse("a policy document is an object".to_string()));
    };
    let version = object.get("v").and_then(serde_json::Value::as_u64).unwrap_or(0);
    if version == 0 || version > u64::from(POLICY_DOCUMENT_VERSION) {
        return Err(refuse(format!(
            "policy document version {version} is not one this build reads"
        )));
    }
    // An unknown key is either meaningless or is trying to bring something
    // along that a policy does not contain.
    let unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|k| !KNOWN_KEYS.contains(k))
        .collect();
    if !unknown.is_empty() {
        return Err(refuse(format!(
            "a policy document holds rules and nothing else; this one also has: {}",
            unknown.join(", ")
        )));
    }
    let document: PolicyDocument = serde_json::from_value(raw)
        .map_err(|e| refuse(format!("this policy document cannot be read: {e}")))?;

    if !matches!(document.default.as_str(), "read-only" | "deny" | "allow") {
        return Err(refuse(format!(
            "{:?} is not a permission default (read-only, deny or allow)",
            document.default
        )));
    }
    // Strict where the runtime is lenient: a rule that would be dropped at
    // load time must not pass review as though it did something.
    for (field, rules) in [
        ("allow", &document.allow),
        ("deny", &document.deny),
        ("allow_write", &document.allow_write),
    ] {
        for rule in rules {
            if crate::resource::ResourceRule::parse(rule).is_none() {
                return Err(refuse(format!(
                    "{field} rule {rule:?} cannot be read, so the file does not say what would happen"
                )));
            }
        }
    }
    Ok(document)
}

/// What importing `document` would change, against the policy in force.
pub fn compare(current: &PolicyDocument, document: &PolicyDocument) -> PolicyChange {
    let added = |before: &[String], after: &[String]| -> Vec<String> {
        after.iter().filter(|r| !before.contains(r)).cloned().collect()
    };
    PolicyChange {
        allow_added: added(&current.allow, &document.allow),
        deny_added: added(&current.deny, &document.deny),
        allow_write_added: added(&current.allow_write, &document.allow_write),
        allow_removed: added(&document.allow, &current.allow),
        deny_removed: added(&document.deny, &current.deny),
        allow_write_removed: added(&document.allow_write, &current.allow_write),
        default_changed_to: (current.default != document.default)
            .then(|| document.default.clone()),
        default_changed_from: (current.default != document.default)
            .then(|| current.default.clone()),
    }
}

/// Whether a caller said it means to widen what the agent may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Widening {
    /// Refuse an import that would let the agent do anything more.
    Refuse,
    /// Apply it: the caller has seen exactly what it opens.
    Accept,
}

/// Check a document against the policy in force and say what to apply.
///
/// Refuses an import that would take a rule away unless the caller has said it
/// means to -- and names exactly which rules those are, because "your policy
/// changed" is not review.
pub fn plan_import(
    current: &PolicyDocument,
    text: &str,
    widening: Widening,
) -> Result<(PolicyDocument, PolicyChange), HarnessError> {
    let document = parse(text)?;
    let change = compare(current, &document);
    // A policy that only takes things away applies freely; one that gives the
    // agent anything it does not have must be asked for out loud, and the
    // refusal says exactly what it would open. An import is a file arriving
    // from somewhere else: the one thing it must not do is quietly widen.
    if widening == Widening::Refuse && !change.widenings().is_empty() {
        return Err(HarnessError::new(
            ErrorKind::PolicyViolation,
            format!(
                "importing this policy would widen what the agent may do: {}. Nothing was changed.",
                change.widenings().join(", ")
            ),
        )
        .at(Stage::Startup));
    }
    Ok((document, change))
}

/// The `[tools]` section an imported document becomes, for `agent.toml`.
///
/// Written rather than merged: the file is the policy, and a merge would leave
/// the project holding something no document describes.
pub fn to_toml(document: &PolicyDocument) -> String {
    let list = |rules: &[String]| {
        let items: Vec<String> = rules.iter().map(|r| format!("{r:?}")).collect();
        format!("[{}]", items.join(", "))
    };
    let mut out = String::from("[tools]\n");
    if !document.note.trim().is_empty() {
        for line in document.note.lines().take(5) {
            out.push_str(&format!("# {}\n", line.trim()));
        }
    }
    out.push_str(&format!("default = {:?}\n", document.default));
    out.push_str(&format!("allow = {}\n", list(&document.allow)));
    out.push_str(&format!("deny = {}\n", list(&document.deny)));
    out.push_str(&format!("allow_write = {}\n", list(&document.allow_write)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current() -> PolicyDocument {
        export(
            "read-only",
            &["mcp.search".to_string()],
            &["bash".to_string(), "write(/etc/**)".to_string()],
            &[],
        )
    }

    /// Jozkah/jan#44: any move up deny < read-only < allow is a widening, not
    /// only a move to allow; moves down are still accepted without consent.
    #[test]
    fn loosening_the_default_to_read_only_is_a_widening() {
        let doc = |default: &str| export(default, &[], &[], &[]);
        for (from, to) in [("deny", "read-only"), ("deny", "allow"), ("read-only", "allow")] {
            let refusal = plan_import(&doc(from), &render(&doc(to)), Widening::Refuse)
                .expect_err("a looser default needs consent");
            assert_eq!(refusal.kind(), ErrorKind::PolicyViolation, "{from} -> {to}");
            let (_, change) = plan_import(&doc(from), &render(&doc(to)), Widening::Accept)
                .expect("accepted when asked");
            assert!(!change.is_narrowing_or_equal(), "{from} -> {to}");
            assert!(
                change.widenings().iter().any(|w| w.contains(from) && w.contains(to)),
                "{from} -> {to}: {:?}",
                change.widenings()
            );
        }
        for (from, to) in [("read-only", "deny"), ("allow", "read-only"), ("allow", "deny")] {
            let (_, change) = plan_import(&doc(from), &render(&doc(to)), Widening::Refuse)
                .expect("a tighter default needs no consent");
            assert!(change.is_narrowing_or_equal(), "{from} -> {to}");
            assert!(change.widenings().is_empty(), "{from} -> {to}");
        }
    }

    /// A policy goes out as a file and comes back as the same policy.
    #[test]
    fn a_policy_round_trips_through_a_reviewable_file() {
        let document = current();
        let text = render(&document);
        assert!(text.contains("\"deny\""), "{text}");
        let back = parse(&text).expect("reads back");
        assert_eq!(back, document);
        assert!(compare(&document, &back).is_empty(), "a round trip changed something");

        // And the section it becomes says the same thing.
        let toml = to_toml(&back);
        assert!(toml.contains("default = \"read-only\""), "{toml}");
        assert!(toml.contains("\"bash\""), "{toml}");
        assert!(toml.starts_with("[tools]"), "{toml}");
    }

    /// Security: nothing may come along with the rules, and a rule this build
    /// cannot read is a refusal rather than a rule that silently does nothing.
    #[test]
    fn a_document_cannot_smuggle_authority_or_an_unreadable_rule() {
        // A grant, an approval, a "trusted" flag: refused by name.
        for smuggled in [
            r#"{"v":1,"default":"deny","grants":["bash"]}"#,
            r#"{"v":1,"default":"deny","approved":true}"#,
            r#"{"v":1,"default":"deny","signature":"trust me"}"#,
            r#"{"v":1,"default":"deny","sessionGrants":{"bash":"always"}}"#,
        ] {
            let refusal = parse(smuggled).expect_err("must refuse");
            assert_eq!(refusal.kind(), ErrorKind::InvalidInput, "{smuggled}");
            assert!(
                refusal.message().contains("rules and nothing else"),
                "{}",
                refusal.message()
            );
        }
        // A default nobody defined.
        assert!(parse(r#"{"v":1,"default":"everything"}"#).is_err());
        // A newer document.
        assert!(parse(r#"{"v":99,"default":"deny"}"#).is_err());
        // A rule that cannot be read: refused here, though the runtime drops
        // it, because a file that does not say what will happen is worse.
        let unreadable = parse(r#"{"v":1,"default":"deny","deny":["(oops)"]}"#);
        assert!(unreadable.is_err(), "an unreadable rule passed review");
    }

    /// Security: an import cannot quietly take a deny rule away.
    #[test]
    fn an_import_that_would_widen_authority_is_refused_and_says_what_it_would_drop() {
        let mine = current();
        // The same policy with the bash denial gone and a write rule added.
        let widened = render(&export(
            "read-only",
            &["mcp.search".to_string()],
            &["write(/etc/**)".to_string()],
            &["write".to_string()],
        ));
        let refusal = plan_import(&mine, &widened, Widening::Refuse).expect_err("must refuse");
        assert_eq!(refusal.kind(), ErrorKind::PolicyViolation);
        assert!(refusal.message().contains("stops denying bash"), "{}", refusal.message());
        assert!(
            refusal.message().contains("allows writing with write"),
            "{}",
            refusal.message()
        );
        assert!(refusal.message().contains("Nothing was changed"), "{}", refusal.message());

        // Said out loud, it is allowed -- and what it does is named.
        let (document, change) =
            plan_import(&mine, &widened, Widening::Accept).expect("accepted deliberately");
        assert_eq!(change.deny_removed, vec!["bash"]);
        assert_eq!(change.allow_write_added, vec!["write"]);
        assert!(!change.is_narrowing_or_equal(), "a widening change called itself narrowing");
        assert!(document.deny.iter().all(|r| r != "bash"));

        // A policy that only adds a denial is narrowing, and never refused.
        let narrowed = render(&export(
            "read-only",
            &["mcp.search".to_string()],
            &["bash".to_string(), "write(/etc/**)".to_string(), "web".to_string()],
            &[],
        ));
        let (_, change) = plan_import(&mine, &narrowed, Widening::Refuse).expect("narrowing is fine");
        assert_eq!(change.deny_added, vec!["web"]);
        assert!(change.is_narrowing_or_equal());

        // Turning the default to "allow" is widening even with no rule changes.
        let opened = render(&export("allow", &mine.allow, &mine.deny, &mine.allow_write));
        let refusal = plan_import(&mine, &opened, Widening::Refuse)
            .expect_err("opening the default is a widening");
        assert!(
            refusal.message().contains("allows everything by default"),
            "{}",
            refusal.message()
        );
        let (_, change) = plan_import(&mine, &opened, Widening::Accept).expect("said out loud");
        assert_eq!(change.default_changed_to.as_deref(), Some("allow"));
        assert!(!change.is_narrowing_or_equal(), "opening the default is not narrowing");
    }
}
