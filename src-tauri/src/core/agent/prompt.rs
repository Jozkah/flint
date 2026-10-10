//! Who may write above the cache line, and who decides.
//!
//! A provider reuses a request's leading bytes only while every one of them is
//! identical to the previous request. Everything that writes into the front of a
//! request -- the assistant's instructions, the guides, project context, skills,
//! memory, the environment -- therefore shares one cache line, and one writer
//! that changes invalidates every byte behind it.
//!
//! That failure is compositional: each writer is locally fine, and none of them
//! is obviously the culprit. So placement is declared rather than conventional:
//!
//! - every writer is a named [`Composer`], enumerated once, in code. The
//!   composition in `context.rs` matches on the enum exhaustively, so a new
//!   writer does not compile until someone decides what it is and where it goes;
//! - a writer that is not fixed when the run composes the prompt can never sit
//!   above the line, and a policy that would put it there refuses the run
//!   instead of quietly costing a cache miss;
//! - `[prompt]` in `agent.toml` can only *narrow* what sits above the line.
//!   Widening it is a code change, where "is this constant" can be reviewed.
//!
//! "Below the line" is a position inside the one system prompt: the allowed
//! writers come first, in registry order, and everything demoted follows them.
//! The leading bytes a provider can reuse are then exactly the allowed writers.
//! Flint's loop re-applies the system prompt append-only
//! (`upstream::set_system_prompt`), so a demoted block that changes costs a
//! new tail of the prompt and leaves the head, and the conversation behind it,
//! alone.
//!
//! Writers that vary between turns (the todo upkeep nudge, prompt-submit hook
//! output) never enter the system prompt at all: they travel through the
//! reminder channel after the conversation. They are in the registry so the
//! status report names every writer, and so listing one above the line fails.

use serde::Deserialize;

/// Where a writer's content sits relative to the cache line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placement {
    /// Above the cache line: part of the leading bytes a provider can reuse.
    Prefix,
    /// Below it: free to change without invalidating the writers above.
    Tail,
}

impl Placement {
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Placement::Prefix => "prefix",
            Placement::Tail => "tail",
        }
    }
}

/// How a writer's content reaches the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    /// A block of the system prompt, placed by [`PromptPolicy`].
    PromptBlock,
    /// A request field outside the prompt (the advertised tool array). The wire
    /// format has no tail for it, so it is always above the line and the policy
    /// does not apply to it.
    RequestField,
    /// Marked guidance folded in after the conversation. Always below the line.
    Reminder,
}

impl Source {
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Source::PromptBlock => "prompt",
            Source::RequestField => "request_field",
            Source::Reminder => "reminder",
        }
    }
}

/// Every writer to the front of a request, as the code declares it.
///
/// This enum *is* the registry: [`Composer::ALL`] enumerates it and every
/// property below is an exhaustive match, so adding a writer without deciding
/// its placement does not compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Composer {
    AssistantInstructions,
    Guidelines,
    SubagentGuide,
    SkillGuide,
    WebToolsGuide,
    MemoryPrecedence,
    ProjectContext,
    Skills,
    ProjectTooling,
    MemoryCatalog,
    RuntimeEnvironment,
    RememberedMemories,
    Date,
    SessionHooks,
    PlanAddendum,
    EagerTodoAddendum,
    ToolSchemas,
    PromptSubmitHooks,
    TodoUpkeep,
}

impl Composer {
    /// Every writer, in the order their blocks enter the prompt.
    pub(crate) const ALL: &'static [Composer] = &[
        Composer::AssistantInstructions,
        Composer::Guidelines,
        Composer::SubagentGuide,
        Composer::SkillGuide,
        Composer::WebToolsGuide,
        Composer::MemoryPrecedence,
        Composer::ProjectContext,
        Composer::Skills,
        Composer::ProjectTooling,
        Composer::MemoryCatalog,
        Composer::RuntimeEnvironment,
        Composer::RememberedMemories,
        Composer::Date,
        Composer::SessionHooks,
        Composer::PlanAddendum,
        Composer::EagerTodoAddendum,
        Composer::ToolSchemas,
        Composer::PromptSubmitHooks,
        Composer::TodoUpkeep,
    ];

    /// The stable id `[prompt]` names and `agent status` prints.
    pub(crate) fn id(self) -> &'static str {
        match self {
            Composer::AssistantInstructions => "assistant_instructions",
            Composer::Guidelines => "guidelines",
            Composer::SubagentGuide => "subagent_guide",
            Composer::SkillGuide => "skill_guide",
            Composer::WebToolsGuide => "web_tools_guide",
            Composer::MemoryPrecedence => "memory_precedence",
            Composer::ProjectContext => "project_context",
            Composer::Skills => "skills",
            Composer::ProjectTooling => "project_tooling",
            Composer::MemoryCatalog => "memory_catalog",
            Composer::RuntimeEnvironment => "runtime_environment",
            Composer::RememberedMemories => "remembered_memories",
            Composer::Date => "date",
            Composer::SessionHooks => "session_hooks",
            Composer::PlanAddendum => "plan_addendum",
            Composer::EagerTodoAddendum => "eager_todo_addendum",
            Composer::ToolSchemas => "tool_schemas",
            Composer::PromptSubmitHooks => "prompt_submit_hooks",
            Composer::TodoUpkeep => "todo_upkeep",
        }
    }

    /// One line for `agent status` and the docs.
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) fn what(self) -> &'static str {
        match self {
            Composer::AssistantInstructions => {
                "the assistant's instructions, or the default identity"
            }
            Composer::Guidelines => "the always-on behavioral and safety guidelines",
            Composer::SubagentGuide => "how to delegate context-heavy exploration",
            Composer::SkillGuide => "the skills and memory file conventions",
            Composer::WebToolsGuide => "the native web tools and when to reach for them",
            Composer::MemoryPrecedence => "which instruction outranks which",
            Composer::ProjectContext => "FLINT.md (or JAN.md) from the project and its ancestors",
            Composer::Skills => "the installed skill catalog",
            Composer::ProjectTooling => "how the project builds and tests",
            Composer::MemoryCatalog => "the curated memory note catalog",
            Composer::RuntimeEnvironment => {
                "working directory, OS, shell, scratch space, date and git branch"
            }
            Composer::RememberedMemories => "memories selected for this session and project",
            Composer::Date => "today's date, for runs without a project environment block",
            Composer::SessionHooks => "output of the imported SessionStart hooks",
            Composer::PlanAddendum => "the plan-mode instructions",
            Composer::EagerTodoAddendum => "the goal-mode instruction to stage a todo plan",
            Composer::ToolSchemas => "the advertised tool array (a request field)",
            Composer::PromptSubmitHooks => "output of the imported UserPromptSubmit hooks",
            Composer::TodoUpkeep => "the nudge to keep the todo list current",
        }
    }

    pub(crate) fn source(self) -> Source {
        match self {
            Composer::ToolSchemas => Source::RequestField,
            Composer::PromptSubmitHooks | Composer::TodoUpkeep => Source::Reminder,
            _ => Source::PromptBlock,
        }
    }

    /// Whether this writer's bytes are fixed once the run has composed the
    /// prompt.
    ///
    /// Composition happens once per run and every request of that run reuses
    /// the result, so a writer that can only change when a new run composes
    /// (project files, skills, memory, the environment, the day, a mode chosen
    /// for the run) may sit above the line: the change lands as an appended
    /// prompt update, which is a new run's doing on purpose. A writer that
    /// reads state that moves while a run is working -- whether a todo list
    /// exists, the prompt a hook reacts to -- cannot.
    pub(crate) fn constant(self) -> bool {
        match self {
            Composer::AssistantInstructions
            | Composer::Guidelines
            | Composer::SubagentGuide
            | Composer::SkillGuide
            | Composer::WebToolsGuide
            | Composer::MemoryPrecedence
            | Composer::ProjectContext
            | Composer::Skills
            | Composer::ProjectTooling
            | Composer::MemoryCatalog
            | Composer::RuntimeEnvironment
            | Composer::RememberedMemories
            | Composer::Date
            | Composer::SessionHooks
            | Composer::PlanAddendum
            | Composer::EagerTodoAddendum
            | Composer::ToolSchemas => true,
            Composer::PromptSubmitHooks | Composer::TodoUpkeep => false,
        }
    }

    /// The placement this writer asks for, from the code. A constant writer
    /// asks for the prefix; one that varies declares the tail.
    pub(crate) fn declared(self) -> Placement {
        if self.constant() {
            Placement::Prefix
        } else {
            Placement::Tail
        }
    }

    /// Look a writer up by its id, as `[prompt]` and the status report spell it.
    pub(crate) fn from_id(id: &str) -> Option<Composer> {
        Composer::ALL.iter().copied().find(|c| c.id() == id)
    }
}

/// `[prompt]` in `agent.toml`: which writers may sit above the cache line.
///
/// Deny wins, like `[tools]`: a writer named in `prefix_deny` is below the line
/// whatever else says.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub(crate) struct PromptSection {
    /// Writer ids allowed above the cache line. Unset keeps each writer's own
    /// placement; setting it narrows the prefix to exactly the ids listed. An
    /// id that names nothing is an error, not a silent no-op.
    #[serde(default)]
    pub prefix_allow: Option<Vec<String>>,
    /// Writer ids kept below the cache line, applied after `prefix_allow`.
    #[serde(default)]
    pub prefix_deny: Vec<String>,
}

/// The resolved `[prompt]` policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PromptPolicy {
    prefix_allow: Option<Vec<String>>,
    prefix_deny: Vec<String>,
}

/// The system prompt after the policy has placed every block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Arranged {
    /// The whole prompt: writers above the line first, then the demoted ones.
    pub prompt: String,
    /// The writers `[prompt]` moved below the line that their own declaration
    /// would have put above it, in prompt order.
    pub demoted: Vec<Composer>,
}

impl PromptPolicy {
    pub(crate) fn new(section: PromptSection) -> Self {
        Self {
            prefix_allow: section.prefix_allow,
            prefix_deny: section.prefix_deny,
        }
    }

    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) fn prefix_allow(&self) -> Option<&[String]> {
        self.prefix_allow.as_deref()
    }

    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) fn prefix_deny(&self) -> &[String] {
        &self.prefix_deny
    }

    /// Reject a list that names something that is not a writer: a typo would
    /// otherwise read as an empty prefix policy instead of saying what is wrong.
    pub(crate) fn validate(&self) -> Result<(), String> {
        let unknown: Vec<&str> = self
            .prefix_allow
            .iter()
            .flatten()
            .chain(self.prefix_deny.iter())
            .filter(|id| Composer::from_id(id).is_none())
            .map(String::as_str)
            .collect();
        if unknown.is_empty() {
            return Ok(());
        }
        let registered: Vec<&str> = Composer::ALL.iter().map(|c| c.id()).collect();
        Err(format!(
            "`[prompt]` names no such contributor: {}. Registered contributors: {}.",
            unknown.join(", "),
            registered.join(", ")
        ))
    }

    fn allowed(&self, composer: Composer) -> bool {
        self.prefix_allow
            .as_ref()
            .is_some_and(|allow| allow.iter().any(|id| id == composer.id()))
    }

    fn denied(&self, composer: Composer) -> bool {
        self.prefix_deny.iter().any(|id| id == composer.id())
    }

    /// Where `composer`'s content goes, or why the policy cannot be honored.
    ///
    /// A hard failure, not a warning: a writer that varies cannot quietly reach
    /// the cache line, and asking for it in `[prompt]` is a config bug to be
    /// told about.
    pub(crate) fn placement_of(&self, composer: Composer) -> Result<Placement, String> {
        // A request field has no tail to move to: no policy applies.
        if composer.source() == Source::RequestField {
            return Ok(Placement::Prefix);
        }
        if !composer.constant() {
            if self.allowed(composer) {
                return Err(format!(
                    "`[prompt].prefix_allow` lists `{}`, which changes while a run is working. \
                     Only a contributor that is fixed for the run can sit above the cache line; \
                     remove it from the list.",
                    composer.id()
                ));
            }
            return Ok(Placement::Tail);
        }
        if self.denied(composer) {
            return Ok(Placement::Tail);
        }
        Ok(match &self.prefix_allow {
            // An allowlist is the whole answer, not a starting point: what it
            // names sits above the line and everything else below it.
            Some(_) if self.allowed(composer) => Placement::Prefix,
            Some(_) => Placement::Tail,
            None => composer.declared(),
        })
    }

    /// Every writer's resolved placement, for `agent status`. Fails on the same
    /// contradiction composition would.
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) fn placements(&self) -> Result<Vec<(Composer, Placement)>, String> {
        self.validate()?;
        Composer::ALL
            .iter()
            .copied()
            .map(|composer| self.placement_of(composer).map(|p| (composer, p)))
            .collect()
    }

    /// Order the prompt's blocks by the policy: writers above the cache line
    /// first, demoted ones after, each group in the order given. With no
    /// `[prompt]` policy every block keeps its position, so the prompt is the
    /// bytes it was before the registry existed.
    pub(crate) fn arrange(&self, blocks: Vec<(Composer, String)>) -> Result<Arranged, String> {
        // Resolve every contributor, not only the ones with a block this run:
        // a policy that cannot be honored fails the same way whatever the
        // project happens to contain.
        self.placements()?;
        let mut above: Vec<String> = Vec::new();
        let mut below: Vec<String> = Vec::new();
        let mut demoted: Vec<Composer> = Vec::new();
        for (composer, block) in blocks {
            match self.placement_of(composer)? {
                Placement::Prefix => above.push(block),
                Placement::Tail => {
                    if composer.declared() == Placement::Prefix {
                        demoted.push(composer);
                    }
                    below.push(block);
                }
            }
        }
        above.extend(below);
        Ok(Arranged {
            prompt: above.join("\n\n"),
            demoted,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(allow: Option<&[&str]>, deny: &[&str]) -> PromptPolicy {
        PromptPolicy::new(PromptSection {
            prefix_allow: allow.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
            prefix_deny: deny.iter().map(|s| s.to_string()).collect(),
        })
    }

    #[test]
    fn the_default_policy_keeps_every_declaration() {
        let policy = PromptPolicy::default();
        for composer in Composer::ALL.iter().copied() {
            assert_eq!(
                policy.placement_of(composer).unwrap(),
                composer.declared(),
                "{}",
                composer.id()
            );
        }
    }

    /// The guard test #8966 asked for: the contributors allowed above the line
    /// are listed here, so a new writer that declares the prefix shows up as a
    /// diff to this list and has to be reviewed, not added silently.
    #[test]
    fn the_prefix_contributors_are_pinned() {
        let prefix: Vec<&str> = Composer::ALL
            .iter()
            .filter(|c| c.declared() == Placement::Prefix)
            .map(|c| c.id())
            .collect();
        assert_eq!(
            prefix,
            [
                "assistant_instructions",
                "guidelines",
                "subagent_guide",
                "skill_guide",
                "web_tools_guide",
                "memory_precedence",
                "project_context",
                "skills",
                "project_tooling",
                "memory_catalog",
                "runtime_environment",
                "remembered_memories",
                "date",
                "session_hooks",
                "plan_addendum",
                "eager_todo_addendum",
                "tool_schemas",
            ]
        );
    }

    #[test]
    fn ids_are_unique_and_resolvable() {
        let mut ids: Vec<&str> = Composer::ALL.iter().map(|c| c.id()).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "ids name writers in config");
        for composer in Composer::ALL {
            assert_eq!(Composer::from_id(composer.id()), Some(*composer));
        }
        assert_eq!(Composer::from_id("nope"), None);
    }

    #[test]
    fn a_writer_that_varies_is_declared_in_the_tail() {
        for composer in Composer::ALL.iter().copied().filter(|c| !c.constant()) {
            assert_eq!(composer.declared(), Placement::Tail, "{}", composer.id());
            assert_ne!(composer.source(), Source::PromptBlock, "{}", composer.id());
            assert_eq!(
                PromptPolicy::default().placement_of(composer).unwrap(),
                Placement::Tail
            );
        }
    }

    #[test]
    fn the_allowlist_narrows_the_prefix() {
        let policy = policy(Some(&["assistant_instructions"]), &[]);
        assert_eq!(
            policy.placement_of(Composer::AssistantInstructions).unwrap(),
            Placement::Prefix
        );
        assert_eq!(
            policy.placement_of(Composer::Skills).unwrap(),
            Placement::Tail,
            "a declared-prefix writer the list omits is below the line"
        );
        assert_eq!(
            policy.placement_of(Composer::ToolSchemas).unwrap(),
            Placement::Prefix,
            "a request field has no tail to move to"
        );
    }

    #[test]
    fn deny_wins_over_allow() {
        let policy = policy(Some(&["skills", "guidelines"]), &["skills"]);
        assert_eq!(
            policy.placement_of(Composer::Skills).unwrap(),
            Placement::Tail
        );
        assert_eq!(
            policy.placement_of(Composer::Guidelines).unwrap(),
            Placement::Prefix
        );
    }

    #[test]
    fn deny_alone_demotes_one_writer_and_keeps_the_rest() {
        let policy = policy(None, &["project_context"]);
        assert_eq!(
            policy.placement_of(Composer::ProjectContext).unwrap(),
            Placement::Tail
        );
        assert_eq!(
            policy.placement_of(Composer::Skills).unwrap(),
            Placement::Prefix
        );
    }

    #[test]
    fn allowing_a_writer_that_varies_is_a_hard_failure() {
        let policy = policy(Some(&["todo_upkeep"]), &[]);
        let error = policy
            .placement_of(Composer::TodoUpkeep)
            .expect_err("a per-turn writer cannot be allowed above the line");
        assert!(error.contains("todo_upkeep"), "{error}");
        assert!(error.contains("prefix_allow"), "{error}");
        assert!(policy.placements().is_err());
        assert!(policy.arrange(Vec::new()).is_err());
    }

    #[test]
    fn an_unknown_id_is_an_error_not_an_empty_policy() {
        for policy in [policy(Some(&["skils"]), &[]), policy(None, &["skils"])] {
            let error = policy.validate().expect_err("typo");
            assert!(error.contains("skils"), "{error}");
            assert!(error.contains("skills"), "lists the registered ids: {error}");
        }
    }

    fn blocks() -> Vec<(Composer, String)> {
        vec![
            (Composer::AssistantInstructions, "BASE".to_string()),
            (Composer::Guidelines, "RULES".to_string()),
            (Composer::ProjectContext, "CONTEXT".to_string()),
            (Composer::Skills, "SKILLS".to_string()),
            (Composer::RuntimeEnvironment, "ENV".to_string()),
        ]
    }

    /// With no policy the prompt is the blocks joined in the order given: the
    /// registry formalizes the prompt, it does not rewrite it.
    #[test]
    fn the_default_policy_leaves_the_prompt_byte_identical() {
        let arranged = PromptPolicy::default().arrange(blocks()).unwrap();
        assert_eq!(arranged.prompt, "BASE\n\nRULES\n\nCONTEXT\n\nSKILLS\n\nENV");
        assert!(arranged.demoted.is_empty());
    }

    #[test]
    fn a_demoted_block_moves_behind_the_allowed_ones_and_is_reported() {
        let policy = policy(Some(&["assistant_instructions", "guidelines", "skills"]), &[]);
        let arranged = policy.arrange(blocks()).unwrap();
        assert_eq!(arranged.prompt, "BASE\n\nRULES\n\nSKILLS\n\nCONTEXT\n\nENV");
        assert_eq!(
            arranged.demoted,
            vec![Composer::ProjectContext, Composer::RuntimeEnvironment]
        );
    }

    #[test]
    fn an_empty_allowlist_demotes_everything_but_loses_nothing() {
        let arranged = policy(Some(&[]), &[]).arrange(blocks()).unwrap();
        assert_eq!(arranged.prompt, "BASE\n\nRULES\n\nCONTEXT\n\nSKILLS\n\nENV");
        assert_eq!(arranged.demoted.len(), 5);
    }
}
