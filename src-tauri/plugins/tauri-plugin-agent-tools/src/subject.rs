//! Who a permission rule is about (AH-007).
//!
//! Rules used to say only *what* a call did -- which tool, which resource.
//! That made every actor in a run equally powerful: a subagent spawned to read
//! a file was bound by exactly the rules its parent was, so "let the main agent
//! push, but never a subagent" could not be written down at all.
//!
//! A [`Subject`] names the actor. A rule may be qualified with one, and a
//! decision is always made *for* one. The two other properties that matter are
//! enforced here rather than left to call sites:
//!
//! * **Narrowing only.** [`Authority::narrow`] intersects; there is no
//!   operation that widens. A child cannot reach past its parent however its
//!   own rules are written, because the parent's authority is the ceiling the
//!   child is built from.
//! * **Fail closed.** An unparseable or unknown subject is [`Subject::Unknown`],
//!   which matches no rule and is denied by [`Authority::permits`]. A renamed
//!   agent is a different subject, so renaming can only ever lose authority.

use std::fmt;

/// The actor a permission decision is about.
///
/// Ordered from broadest to narrowest only for readability; the variants are
/// not ranked, and no variant implies another. Authority relationships are
/// expressed by [`Authority`], never by the subject alone.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Subject {
    /// The person at the keyboard. Their own actions are not agent actions.
    User,
    /// The top-level agent of a run.
    MainAgent,
    /// A subagent, by the name it was dispatched under.
    NamedAgent(String),
    /// A role several agents may share (`reviewer`, `implementer`).
    AgentRole(String),
    /// A skill executing on behalf of an agent.
    Skill(String),
    /// A tool call arriving from a specific MCP server.
    McpServer(String),
    /// A session, for rules scoped to one conversation.
    Session(String),
    /// A project, for rules scoped to one checkout.
    Project(String),
    /// Anything that could not be identified.
    ///
    /// Never matches a rule and is never permitted. A caller that cannot say
    /// who it is acting for does not get the benefit of the doubt.
    Unknown,
}

impl Subject {
    /// The wire/config spelling: `kind:name`, or a bare word for the two
    /// subjects that need no name.
    ///
    /// `user`, `agent` (the main agent), `agent:<name>`, `role:<name>`,
    /// `skill:<name>`, `mcp:<name>`, `session:<id>`, `project:<id>`.
    pub fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        if raw.is_empty() {
            return Subject::Unknown;
        }
        // A trailing colon is a typo, not a subject: `agent:` is someone who
        // meant to name an agent and did not, and must not silently become the
        // main agent. So "no colon at all" and "colon with nothing after it"
        // are kept apart.
        let (kind, name) = match raw.split_once(':') {
            Some((kind, name)) => (kind.trim(), Some(name.trim())),
            None => (raw, None),
        };
        let named = |name: &str| !name.is_empty();
        match (kind.to_ascii_lowercase().as_str(), name) {
            ("user", None) => Subject::User,
            ("agent", None) => Subject::MainAgent,
            ("agent", Some(n)) if named(n) => Subject::NamedAgent(n.to_string()),
            ("role", Some(n)) if named(n) => Subject::AgentRole(n.to_string()),
            ("skill", Some(n)) if named(n) => Subject::Skill(n.to_string()),
            ("mcp", Some(n)) if named(n) => Subject::McpServer(n.to_string()),
            ("session", Some(n)) if named(n) => Subject::Session(n.to_string()),
            ("project", Some(n)) if named(n) => Subject::Project(n.to_string()),
            _ => Subject::Unknown,
        }
    }

    /// Whether this subject can be named in a rule and used in a decision.
    pub fn is_known(&self) -> bool {
        !matches!(self, Subject::Unknown)
    }

    /// The kind word, for audit records and messages.
    pub fn kind(&self) -> &'static str {
        match self {
            Subject::User => "user",
            Subject::MainAgent => "agent",
            Subject::NamedAgent(_) => "agent",
            Subject::AgentRole(_) => "role",
            Subject::Skill(_) => "skill",
            Subject::McpServer(_) => "mcp",
            Subject::Session(_) => "session",
            Subject::Project(_) => "project",
            Subject::Unknown => "unknown",
        }
    }
}

impl fmt::Display for Subject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Subject::User => f.write_str("user"),
            Subject::MainAgent => f.write_str("agent"),
            Subject::NamedAgent(n) => write!(f, "agent:{n}"),
            Subject::AgentRole(n) => write!(f, "role:{n}"),
            Subject::Skill(n) => write!(f, "skill:{n}"),
            Subject::McpServer(n) => write!(f, "mcp:{n}"),
            Subject::Session(n) => write!(f, "session:{n}"),
            Subject::Project(n) => write!(f, "project:{n}"),
            Subject::Unknown => f.write_str("unknown"),
        }
    }
}

/// What a rule says about *who* it applies to.
///
/// A rule with no qualifier applies to every known subject, which is what every
/// rule written before subjects existed means. It still does not apply to
/// [`Subject::Unknown`]: an unidentified caller is not "everyone".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubjectPattern {
    /// Any identified subject.
    Any,
    /// One exact subject.
    Exactly(Subject),
    /// Any agent, main or named.
    AnyAgent,
}

impl SubjectPattern {
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "" | "*" => SubjectPattern::Any,
            "agent:*" => SubjectPattern::AnyAgent,
            other => SubjectPattern::Exactly(Subject::parse(other)),
        }
    }

    pub fn matches(&self, subject: &Subject) -> bool {
        // Unidentified callers match nothing, including `Any`.
        if !subject.is_known() {
            return false;
        }
        match self {
            SubjectPattern::Any => true,
            SubjectPattern::AnyAgent => {
                matches!(subject, Subject::MainAgent | Subject::NamedAgent(_))
            }
            SubjectPattern::Exactly(want) => want == subject,
        }
    }
}

/// The frozen authority a dispatch runs under.
///
/// Built once when a call is dispatched and never recomputed mid-flight, so a
/// rule edited, an agent renamed, or a parent's grant revoked while a call is
/// running cannot change what that call is allowed to do. The decision a call
/// was admitted under is the decision it finishes under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authority {
    subject: Subject,
    /// `None` means "no ceiling from a parent" -- a top-level actor.
    ceiling: Option<Box<Authority>>,
}

impl Authority {
    /// A top-level authority for `subject`, bounded by nothing above it.
    pub fn root(subject: Subject) -> Self {
        Self {
            subject,
            ceiling: None,
        }
    }

    /// A child authority under this one.
    ///
    /// The only way to build a child, and it can only ever be narrower: the
    /// parent is retained as a ceiling every decision must also satisfy. There
    /// is deliberately no constructor that takes a parent and returns something
    /// broader, so "widen" is not an operation this type can express.
    pub fn narrow(&self, child: Subject) -> Self {
        Self {
            subject: child,
            ceiling: Some(Box::new(self.clone())),
        }
    }

    pub fn subject(&self) -> &Subject {
        &self.subject
    }

    /// The chain from this subject up to the root, nearest first. Recorded in
    /// audit events so a decision can be read back with the delegation that
    /// produced it.
    pub fn chain(&self) -> Vec<Subject> {
        let mut out = vec![self.subject.clone()];
        let mut here = self;
        while let Some(parent) = &here.ceiling {
            out.push(parent.subject.clone());
            here = parent;
        }
        out
    }

    /// Whether `pattern` permits this authority.
    ///
    /// Every level must be satisfied, not just the leaf: a subagent is allowed
    /// only what both it and every ancestor may do. An unidentified subject
    /// anywhere in the chain denies the whole chain.
    pub fn permits(&self, pattern: &SubjectPattern) -> bool {
        if !pattern.matches(&self.subject) {
            return false;
        }
        match &self.ceiling {
            Some(parent) => parent.permits(pattern),
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_subject_spelling() {
        assert_eq!(Subject::parse("user"), Subject::User);
        assert_eq!(Subject::parse("agent"), Subject::MainAgent);
        assert_eq!(
            Subject::parse("agent:reviewer"),
            Subject::NamedAgent("reviewer".into())
        );
        assert_eq!(
            Subject::parse("role:implementer"),
            Subject::AgentRole("implementer".into())
        );
        assert_eq!(Subject::parse("skill:fmt"), Subject::Skill("fmt".into()));
        assert_eq!(Subject::parse("mcp:github"), Subject::McpServer("github".into()));
        assert_eq!(Subject::parse("session:s1"), Subject::Session("s1".into()));
        assert_eq!(Subject::parse("project:p1"), Subject::Project("p1".into()));
    }

    /// Anything unrecognised is `Unknown`, and `Unknown` is not a wildcard.
    #[test]
    fn unrecognised_subjects_fail_closed() {
        for raw in ["", "   ", "nonsense", "agent:", "role:", "mcp:", ":name", "user:bob"] {
            assert_eq!(Subject::parse(raw), Subject::Unknown, "{raw:?}");
        }
        assert!(!SubjectPattern::Any.matches(&Subject::Unknown));
        assert!(!SubjectPattern::AnyAgent.matches(&Subject::Unknown));
        assert!(!Authority::root(Subject::Unknown).permits(&SubjectPattern::Any));
    }

    #[test]
    fn an_unqualified_rule_applies_to_any_identified_subject() {
        let any = SubjectPattern::parse("");
        assert!(any.matches(&Subject::MainAgent));
        assert!(any.matches(&Subject::User));
        assert!(any.matches(&Subject::NamedAgent("x".into())));
        assert!(!any.matches(&Subject::Unknown));
    }

    #[test]
    fn agent_wildcard_covers_main_and_named_agents_only() {
        let agents = SubjectPattern::parse("agent:*");
        assert!(agents.matches(&Subject::MainAgent));
        assert!(agents.matches(&Subject::NamedAgent("reviewer".into())));
        assert!(!agents.matches(&Subject::User));
        assert!(!agents.matches(&Subject::McpServer("github".into())));
    }

    /// The property the whole type exists for.
    #[test]
    fn a_child_cannot_widen_its_parents_authority() {
        let parent = Authority::root(Subject::MainAgent);
        let child = parent.narrow(Subject::NamedAgent("reviewer".into()));

        // A rule for the parent alone does not reach the child.
        let only_main = SubjectPattern::Exactly(Subject::MainAgent);
        assert!(parent.permits(&only_main));
        assert!(!child.permits(&only_main), "child inherited a parent-only rule");

        // A rule naming the child does not escape the parent's ceiling either:
        // the parent must satisfy it too.
        let only_child = SubjectPattern::Exactly(Subject::NamedAgent("reviewer".into()));
        assert!(!child.permits(&only_child), "child escaped its parent's ceiling");

        // What both satisfy is what the child may do.
        assert!(child.permits(&SubjectPattern::AnyAgent));
        assert!(child.permits(&SubjectPattern::Any));
    }

    /// Renaming is not a way to acquire authority: a different name is a
    /// different subject, and the ceiling still applies.
    #[test]
    fn renaming_an_agent_cannot_transfer_authority() {
        let parent = Authority::root(Subject::NamedAgent("privileged".into()));
        let renamed = Authority::root(Subject::NamedAgent("privileged-v2".into()));
        let rule = SubjectPattern::Exactly(Subject::NamedAgent("privileged".into()));
        assert!(parent.permits(&rule));
        assert!(!renamed.permits(&rule), "a rename inherited the old authority");

        // And a child that renames itself to the parent's name gains nothing,
        // because the chain is still checked in full.
        let impostor = Authority::root(Subject::NamedAgent("restricted".into()))
            .narrow(Subject::NamedAgent("privileged".into()));
        assert!(!impostor.permits(&rule));
    }

    /// Delegation composes: every level in the chain must permit.
    #[test]
    fn nested_delegation_keeps_every_ceiling() {
        let chain = Authority::root(Subject::MainAgent)
            .narrow(Subject::NamedAgent("a".into()))
            .narrow(Subject::NamedAgent("b".into()));
        assert_eq!(
            chain.chain(),
            vec![
                Subject::NamedAgent("b".into()),
                Subject::NamedAgent("a".into()),
                Subject::MainAgent,
            ]
        );
        assert!(chain.permits(&SubjectPattern::AnyAgent));
        // One unidentified link denies the whole chain.
        let broken = Authority::root(Subject::Unknown).narrow(Subject::NamedAgent("b".into()));
        assert!(!broken.permits(&SubjectPattern::Any));
    }

    #[test]
    fn display_round_trips_through_parse() {
        for subject in [
            Subject::User,
            Subject::MainAgent,
            Subject::NamedAgent("reviewer".into()),
            Subject::AgentRole("impl".into()),
            Subject::Skill("fmt".into()),
            Subject::McpServer("github".into()),
            Subject::Session("s1".into()),
            Subject::Project("p1".into()),
        ] {
            assert_eq!(Subject::parse(&subject.to_string()), subject);
        }
    }
}
