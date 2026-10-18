//! Tool profiles: how much of the toolset a model is shown.
//!
//! A small local model with an 8-32k window loses most of it to the schemas of
//! the ~48 built-in tools. `[tools] profile = "minimal"` offers only the
//! coding set (read, ls, grep, find, write, edit, bash) plus `ask`, and hides
//! everything else: MCP tools, browser, git helpers, memory, skills, messaging,
//! image tools and the rest.
//!
//! ```toml
//! [tools]
//! profile = "full"          # default: today's behaviour, untouched
//!
//! [[tool_profiles]]         # per model, first match wins
//! model = "qwen3*"          # `*` is the only wildcard, case-insensitive
//! profile = "minimal"
//! ```
//!
//! A profile only ever REMOVES tools. It is applied as an intersection with the
//! run's other allowlist (a role's tools, a request's `allowed_tools`), so it
//! can never offer a tool those did not, and permission rules still decide
//! whether an offered tool runs. The result is the run's allowlist, so a hidden
//! tool is both unadvertised and refused (`ToolNotOffered`) if called anyway.
//!
//! Like `[models]`, an unknown profile name is refused rather than ignored: a
//! typo that silently fell back to `full` would put 48 schemas in front of the
//! very model the person meant to protect.

use std::collections::HashSet;

use serde::Deserialize;

/// Tools the `minimal` profile offers, by name. `ask` is the interactive
/// question tool (`ask_tool_schema`).
pub const MINIMAL_TOOLS: &[&str] = &["read", "ls", "grep", "find", "write", "edit", "bash", "ask"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolProfile {
    #[default]
    Full,
    Minimal,
}

impl ToolProfile {
    fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "full" => Ok(Self::Full),
            "minimal" => Ok(Self::Minimal),
            other => Err(format!(
                "unknown tool profile {other:?}: expected \"full\" or \"minimal\""
            )),
        }
    }
}

/// `[[tool_profiles]]`, as written.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct ToolProfileRule {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub profile: String,
}

/// The profile for `model`: the first matching `[[tool_profiles]]` rule, else
/// the `[tools] profile`, else `full`. Refuses an unknown profile value or an
/// empty model pattern anywhere in the config, matched or not, so a typo is
/// seen on the first run rather than the day that model is used.
pub fn resolve(
    tools_profile: Option<&str>,
    rules: &[ToolProfileRule],
    model: &str,
) -> Result<ToolProfile, String> {
    let default = match tools_profile {
        Some(p) => ToolProfile::parse(p).map_err(|e| format!("[tools] profile: {e}"))?,
        None => ToolProfile::Full,
    };
    let mut chosen = None;
    for (i, rule) in rules.iter().enumerate() {
        if rule.model.trim().is_empty() {
            return Err(format!("[[tool_profiles]] #{}: `model` is empty", i + 1));
        }
        let profile = ToolProfile::parse(&rule.profile)
            .map_err(|e| format!("[[tool_profiles]] #{} ({}): {e}", i + 1, rule.model))?;
        if chosen.is_none()
            && crate::core::agent::routing::glob_matches(
                &rule.model.trim().to_ascii_lowercase(),
                &model.to_ascii_lowercase(),
            )
        {
            chosen = Some(profile);
        }
    }
    Ok(chosen.unwrap_or(default))
}

/// Narrow a run's allowlist by the profile. `Full` returns it unchanged.
/// `Minimal` returns the intersection with [`MINIMAL_TOOLS`]; with no
/// allowlist (`None` = everything) that is exactly the minimal set.
pub fn restrict(allowed: Option<HashSet<String>>, profile: ToolProfile) -> Option<HashSet<String>> {
    match profile {
        ToolProfile::Full => allowed,
        ToolProfile::Minimal => Some(match allowed {
            Some(set) => set
                .into_iter()
                .filter(|name| MINIMAL_TOOLS.contains(&name.as_str()))
                .collect(),
            None => MINIMAL_TOOLS.iter().map(|s| s.to_string()).collect(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(model: &str, profile: &str) -> ToolProfileRule {
        ToolProfileRule { model: model.into(), profile: profile.into() }
    }

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn default_is_full_and_values_parse() {
        assert_eq!(resolve(None, &[], "m").unwrap(), ToolProfile::Full);
        assert_eq!(resolve(Some("Minimal"), &[], "m").unwrap(), ToolProfile::Minimal);
        assert_eq!(resolve(Some("full"), &[], "m").unwrap(), ToolProfile::Full);
    }

    #[test]
    fn unknown_values_are_refused_not_ignored() {
        assert!(resolve(Some("tiny"), &[], "m").unwrap_err().contains("[tools] profile"));
        // Refused even when the bad rule would not match this model.
        assert!(resolve(None, &[rule("zzz", "tiny")], "m").is_err());
        assert!(resolve(None, &[rule("", "minimal")], "m").is_err());
    }

    #[test]
    fn model_rules_glob_case_insensitively_and_first_match_wins() {
        let rules = [rule("qwen3*", "minimal"), rule("*", "full"), rule("*-mini", "minimal")];
        assert_eq!(resolve(None, &rules, "Qwen3-8B").unwrap(), ToolProfile::Minimal);
        assert_eq!(resolve(Some("minimal"), &rules, "gpt-4o").unwrap(), ToolProfile::Full);
        let suffix = [rule("*-MINI", "minimal")];
        assert_eq!(resolve(None, &suffix, "gpt-4o-mini").unwrap(), ToolProfile::Minimal);
        assert_eq!(resolve(None, &suffix, "gpt-4o").unwrap(), ToolProfile::Full);
    }

    #[test]
    fn no_match_falls_back_to_the_tools_profile() {
        let rules = [rule("qwen3*", "full")];
        assert_eq!(resolve(Some("minimal"), &rules, "llama3").unwrap(), ToolProfile::Minimal);
        assert_eq!(resolve(Some("minimal"), &rules, "qwen3-8b").unwrap(), ToolProfile::Full);
    }

    #[test]
    fn minimal_set_is_exactly_the_coding_set() {
        let got = restrict(None, ToolProfile::Minimal).unwrap();
        assert_eq!(got, set(&["read", "ls", "grep", "find", "write", "edit", "bash", "ask"]));
        // Every named built-in really exists, so a rename cannot silently shrink it.
        for name in MINIMAL_TOOLS.iter().filter(|n| **n != "ask") {
            assert!(tauri_plugin_agent_tools::tools::lookup(name).is_some(), "{name}");
        }
    }

    #[test]
    fn minimal_intersects_and_never_adds() {
        let role = Some(set(&["read", "git", "browser", "bash", "mcp__x__y"]));
        assert_eq!(restrict(role, ToolProfile::Minimal).unwrap(), set(&["read", "bash"]));
        // An empty allowlist (no tools) stays empty: the profile grants nothing.
        assert_eq!(restrict(Some(HashSet::new()), ToolProfile::Minimal).unwrap(), HashSet::new());
    }

    #[test]
    fn full_leaves_the_allowlist_alone() {
        assert_eq!(restrict(None, ToolProfile::Full), None);
        let role = Some(set(&["read", "git"]));
        assert_eq!(restrict(role.clone(), ToolProfile::Full), role);
    }

    #[test]
    fn config_parses_from_toml() {
        let cfg: crate::core::agent::project::AgentToml = toml::from_str(
            "[tools]\nprofile = \"minimal\"\n[[tool_profiles]]\nmodel = \"qwen3*\"\nprofile = \"full\"\n",
        )
        .unwrap();
        assert_eq!(cfg.tools.profile.as_deref(), Some("minimal"));
        assert_eq!(cfg.tool_profiles, vec![rule("qwen3*", "full")]);
        let none: crate::core::agent::project::AgentToml = toml::from_str("").unwrap();
        assert!(none.tools.profile.is_none() && none.tool_profiles.is_empty());
    }
}
