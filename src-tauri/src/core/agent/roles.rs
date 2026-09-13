//! The agent roles Jan ships. AH-094 to AH-099.
//!
//! Six named, versioned definitions a parent can dispatch by name with the
//! `task` tool: explorer, planner, implementer, reviewer, tester, security.
//! Each is an ordinary subagent definition in a scope of its own
//! (`SubagentScope::Builtin`) with the lowest precedence, so a user's or a
//! project's definition of the same name replaces it, and the scope is
//! read-only: nothing can rewrite a shipped role.
//!
//! Authority comes from the allowlist, never from the prompt:
//!
//! * a role's `allowed_tools` is explicit, so tools it does not list -- MCP
//!   tools included -- are never offered to it;
//! * the child's toolset is that list narrowed by what the parent itself can
//!   call (`intersect_allowed_tools`), so a role never holds authority its
//!   parent lacks, and a call-site list can narrow it but never widen it;
//! * `task`, `team`, `ask` and `todo` are withheld from every child, so a role
//!   cannot dispatch further agents or define new ones;
//! * the read-only roles (explorer, planner, reviewer, security) list only
//!   read-capability tools: they cannot write, edit, run a shell, change Git
//!   state, or write memory or skills. `read_only_roles_hold_no_mutating_tool`
//!   checks that against the tool capability table, not against the names.
//!
//! The prompts describe the job and the shape of the answer. They are
//! guidance to the model; the allowlist is the enforcement.

use crate::core::agent::subagent::{SubagentDefinition, SubagentScope};

/// Bumped whenever a role's prompt, tools or contract changes, so a transcript
/// can say which version of a role did the work.
pub const ROLES_VERSION: u32 = 1;

pub struct Role {
    pub name: &'static str,
    pub description: &'static str,
    pub tools: &'static [&'static str],
    pub prompt: &'static str,
    /// Whether the role must never change anything.
    pub read_only: bool,
}

const READ: &[&str] = &["read", "ls", "find", "grep"];

pub const ROLES: &[Role] = &[
    Role {
        name: "explorer",
        description: "Read-only exploration: finds where things are and how they fit together, and reports with file and line references.",
        tools: READ,
        read_only: true,
        prompt: "You are the explorer, a read-only agent. Your job is to find out how the code in front of you works and where things are.\n\
You can read, list, find and search files. You cannot change anything, run commands or dispatch other agents; do not try.\n\
Answer with:\n\
1. A short direct answer to what you were asked.\n\
2. The evidence: each claim with a file path and line numbers.\n\
3. What you could not determine, and why.\n\
Do not guess. If something is not in the files you read, say so.",
    },
    Role {
        name: "planner",
        description: "Read-only planning: investigates, then returns a phased plan with the files each step touches and how to verify it.",
        tools: READ,
        read_only: true,
        prompt: "You are the planner, a read-only agent working in plan mode. You investigate and produce a plan; you never carry it out.\n\
You can read, list, find and search files. You cannot edit files, run commands or make any change; those tools are not available to you.\n\
Investigate first. Then answer with a plan:\n\
1. Goal, in one sentence.\n\
2. Phases, in order. For each: what changes, which files, and how to verify it (the test or check that proves it).\n\
3. Risks and open questions.\n\
Keep each phase small enough to review on its own.",
    },
    Role {
        name: "implementer",
        description: "Makes the change it is given, in the files it is given, and reports exactly what it changed.",
        tools: &["read", "ls", "find", "grep", "write", "edit"],
        read_only: false,
        prompt: "You are the implementer. You make the change described in your task, and nothing else.\n\
Change only the files the task names or clearly implies. Do not reformat, rename or tidy code you were not asked to touch. You cannot run commands or dispatch other agents.\n\
Every write goes through the same approval as the parent's; if a write is refused, stop and report it rather than working around it.\n\
Answer with:\n\
1. What you changed, file by file.\n\
2. Anything you were asked to do and did not, and why.\n\
3. How the change should be verified.",
    },
    Role {
        name: "reviewer",
        description: "Read-only review: reports real defects in the code it is pointed at, each with its location and a concrete failure.",
        tools: READ,
        read_only: true,
        prompt: "You are the reviewer, a read-only agent. You review code for real defects; you never fix them.\n\
You can read, list, find and search files. You cannot change anything or run commands.\n\
Report only what you can support: a concrete input or state that produces a wrong result, a crash or a security problem.\n\
For each finding give: file and line, what goes wrong, the scenario that triggers it, and a suggested fix.\n\
Say plainly when you found nothing. Do not pad the review with style preferences.",
    },
    Role {
        name: "tester",
        description: "Finds the tests that cover a change, runs them, and reports the exact results.",
        tools: &["read", "ls", "find", "grep", "bash"],
        read_only: false,
        prompt: "You are the tester. You select and run the tests that cover the change or area you were given, and report the results exactly.\n\
You can read, list, find and search files, and run commands. Every command goes through the same approval as the parent's. You cannot edit files: do not fix code or tests.\n\
Choose the narrowest tests that cover the change first, then broaden if asked.\n\
Answer with:\n\
1. The commands you ran.\n\
2. For each: pass or fail, with the exact failing test names and the shortest decisive error line.\n\
3. What was not tested.",
    },
    Role {
        name: "security",
        description: "Read-only security review: finds exploitable weaknesses, with the path an attacker would take.",
        tools: READ,
        read_only: true,
        prompt: "You are the security reviewer, a read-only agent. You look for exploitable weaknesses; you never fix them.\n\
You can read, list, find and search files. You cannot change anything, run commands or reach the network.\n\
Look at trust boundaries: input from users, files, the network and models; paths; commands; credentials; permissions.\n\
For each finding give: file and line, the weakness, how an attacker reaches it, the impact, and a fix.\n\
Rate each as high, medium or low. Report nothing you cannot tie to code you read.",
    },
];

/// The shipped roles as subagent definitions.
pub fn definitions() -> Vec<SubagentDefinition> {
    ROLES
        .iter()
        .map(|r| SubagentDefinition {
            name: r.name.to_string(),
            description: format!("{} (built-in role, v{ROLES_VERSION})", r.description),
            system_prompt: r.prompt.to_string(),
            allowed_tools: Some(r.tools.iter().map(|t| t.to_string()).collect()),
            model: None,
            scope: SubagentScope::Builtin,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::subagent::intersect_allowed_tools;
    use tauri_plugin_agent_tools::tools::{Capability, BUILTIN_TOOLS};

    fn capability(tool: &str) -> Option<Capability> {
        BUILTIN_TOOLS.iter().find(|t| t.name == tool).map(|t| t.capability)
    }

    /// Checked against the capability table, so renaming a tool or giving a
    /// read-only role a new one cannot slip a mutation past this.
    #[test]
    fn read_only_roles_hold_no_mutating_tool() {
        for role in ROLES.iter().filter(|r| r.read_only) {
            for tool in role.tools {
                assert_eq!(
                    capability(tool),
                    Some(Capability::Read),
                    "read-only role {} lists {tool}",
                    role.name
                );
            }
        }
    }

    #[test]
    fn every_role_lists_only_real_tools_and_no_dispatch() {
        for role in ROLES {
            assert!(!role.tools.is_empty(), "{} has no tools", role.name);
            for tool in role.tools {
                assert!(capability(tool).is_some(), "{} lists unknown tool {tool}", role.name);
                assert!(!["task", "team", "ask", "todo"].contains(tool), "{} can dispatch", role.name);
            }
        }
        let names: Vec<&str> = ROLES.iter().map(|r| r.name).collect();
        assert_eq!(names, ["explorer", "planner", "implementer", "reviewer", "tester", "security"]);
        // The ones that change things, and only those.
        for (name, writes) in [("implementer", true), ("tester", false)] {
            let r = ROLES.iter().find(|r| r.name == name).unwrap();
            assert_eq!(r.tools.iter().any(|t| capability(t) == Some(Capability::Write)), writes, "{name}");
        }
        let tester = ROLES.iter().find(|r| r.name == "tester").unwrap();
        assert!(tester.tools.contains(&"bash"));
    }

    /// A role never holds more than its parent: a parent without `write` gets
    /// an implementer that cannot write, and asking a read-only role for
    /// `write` at the call site is refused, not granted.
    #[test]
    fn a_role_is_narrowed_by_its_parent_and_never_widened() {
        use tauri_plugin_agent_tools::permissions::{PermissionDefault, ToolPermissions};
        use tauri_plugin_agent_tools::subject::Subject;
        let defs = definitions();
        let def = |name: &str| defs.iter().find(|d| d.name == name).unwrap().allowed_tools.clone();

        // A parent that may not write or edit gets an implementer that cannot.
        let no_writes = ToolPermissions::new(
            PermissionDefault::ReadOnly,
            &[],
            &["write".to_string(), "edit".to_string()],
            &[],
        );
        let child = Subject::NamedAgent("implementer".to_string());
        let got = intersect_allowed_tools(def("implementer").as_deref(), None, &no_writes, &child)
            .unwrap()
            .unwrap_or_default();
        assert!(!got.iter().any(|t| t == "write" || t == "edit"), "{got:?}");

        // A parent that may do anything still cannot hand the reviewer `write`:
        // asking for it at the call site is refused, not granted.
        let everything = ToolPermissions::allow_all();
        let reviewer = Subject::NamedAgent("reviewer".to_string());
        let ask_write = vec!["write".to_string()];
        assert!(intersect_allowed_tools(def("reviewer").as_deref(), Some(&ask_write), &everything, &reviewer).is_err());
        let got = intersect_allowed_tools(def("reviewer").as_deref(), None, &everything, &reviewer)
            .unwrap()
            .unwrap_or_default();
        assert!(!got.iter().any(|t| t == "write" || t == "edit" || t == "bash"), "{got:?}");
        assert!(got.iter().any(|t| t == "read"));
    }

    #[test]
    fn every_role_is_a_versioned_builtin_definition() {
        for d in definitions() {
            assert_eq!(d.scope, SubagentScope::Builtin);
            assert!(d.description.contains(&format!("v{ROLES_VERSION}")));
            assert!(d.model.is_none(), "a role inherits the parent's model");
        }
    }
}
