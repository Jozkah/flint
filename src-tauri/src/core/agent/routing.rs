//! Rules a person writes about which model answers what (AH-194).
//!
//! Resolution already prefers a provider that has a credential, and already
//! knows a "small model" role. What it had no way to express is the thing
//! people actually want: *this* kind of work goes to *that* model. A reviewer
//! on something careful and expensive, evaluation on something cheap, and the
//! main loop on whatever the project pins.
//!
//! ```toml
//! [[routing]]
//! match = "role:smol"
//! use = "provider/small-fast-model"
//!
//! [[routing]]
//! match = "agent:reviewer"
//! use = "provider/careful-model"
//!
//! [[routing]]
//! match = "model:gpt-*"
//! use = "provider/one-we-have-a-key-for"
//! ```
//!
//! Rules are read in the order they are written and the first match wins,
//! because that is how a person reads a list of rules. What no rule matches is
//! resolved exactly as it was before: routing narrows nothing and grants
//! nothing, it only redirects what it was asked to.
//!
//! A rule is refused at startup when its `match` is not a form this
//! understands or its `use` is empty. Ignoring a rule somebody wrote is worse
//! than refusing to start: the run would go to a model they did not choose,
//! and look as though their rule had been honoured.

use serde::Deserialize;

/// What a rule matches on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Matcher {
    /// `role:task`, `role:smol` -- what the request is for.
    Role(String),
    /// `agent:<name>` -- a dispatched subagent by the name it was dispatched
    /// under.
    Agent(String),
    /// `model:<pattern>` -- the model that would otherwise be used, with `*`
    /// as the only wildcard. A wildcard language is a thing to learn; one
    /// character is not.
    Model(String),
    /// `*` -- everything that got this far.
    Any,
}

/// One rule, as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub matcher: Matcher,
    /// The model to use instead, as written: `provider/model` or a bare model
    /// id, resolved downstream exactly like any other.
    pub use_model: String,
}

/// `[[routing]]`, as it appears in agent.toml.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct RoutingRule {
    #[serde(rename = "match", default)]
    pub matcher: String,
    #[serde(rename = "use", default)]
    pub use_model: String,
}

/// What a request is, for the purpose of routing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request<'a> {
    /// `task` for the run itself, `smol` for the small-model role.
    pub role: &'a str,
    /// The subagent this request belongs to, if any.
    pub agent: Option<&'a str>,
    /// The model that would be used if no rule matched.
    pub model: &'a str,
}

fn glob_matches(pattern: &str, text: &str) -> bool {
    // One wildcard character, and it may appear anywhere: `gpt-*`, `*-mini`,
    // `*turbo*`. Anything more is a pattern language nobody asked for.
    let mut remaining = text;
    let parts: Vec<&str> = pattern.split('*').collect();
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        match (i, remaining.find(part)) {
            // A leading literal has to be at the start.
            (0, Some(0)) => remaining = &remaining[part.len()..],
            (0, _) if !pattern.starts_with('*') => return false,
            (_, Some(at)) => remaining = &remaining[at + part.len()..],
            (_, None) => return false,
        }
    }
    // A trailing literal has to end the text.
    match parts.last() {
        Some(last) if !last.is_empty() && !pattern.ends_with('*') => text.ends_with(last),
        _ => true,
    }
}

impl Matcher {
    fn matches(&self, request: &Request<'_>) -> bool {
        match self {
            Matcher::Any => true,
            Matcher::Role(role) => role.eq_ignore_ascii_case(request.role),
            Matcher::Agent(name) => request
                .agent
                .is_some_and(|agent| agent.eq_ignore_ascii_case(name)),
            Matcher::Model(pattern) => glob_matches(pattern, request.model),
        }
    }
}

/// Read the declared rules, refusing what cannot be honoured (AH-194).
pub fn rules(
    declared: &[RoutingRule],
) -> Result<Vec<Rule>, tauri_plugin_agent_tools::harness_error::HarnessError> {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
    let invalid = |message: String| {
        HarnessError::new(ErrorKind::InvalidInput, message).at(Stage::Startup)
    };
    let mut out = Vec::new();
    for rule in declared {
        let use_model = rule.use_model.trim().to_string();
        if use_model.is_empty() {
            return Err(invalid(format!(
                "the routing rule for {:?} says nothing to use",
                rule.matcher
            )));
        }
        let raw = rule.matcher.trim();
        let matcher = match raw.split_once(':') {
            Some(("role", value)) if !value.trim().is_empty() => {
                Matcher::Role(value.trim().to_string())
            }
            Some(("agent", value)) if !value.trim().is_empty() => {
                Matcher::Agent(value.trim().to_string())
            }
            Some(("model", value)) if !value.trim().is_empty() => {
                Matcher::Model(value.trim().to_string())
            }
            _ if raw == "*" => Matcher::Any,
            _ => {
                return Err(invalid(format!(
                    "{raw:?} is not a routing match this understands (role:<name>, \
                     agent:<name>, model:<pattern>, or *)"
                )))
            }
        };
        out.push(Rule { matcher, use_model });
    }
    Ok(out)
}

/// The model a request should go to, when a rule says so.
///
/// `None` means no rule matched, and the caller's own resolution stands. The
/// first matching rule wins, because that is how a person reads a list.
pub fn route(rules: &[Rule], request: &Request<'_>) -> Option<String> {
    rules
        .iter()
        .find(|rule| rule.matcher.matches(request))
        .map(|rule| rule.use_model.clone())
        // A rule that redirects a model to itself is not a redirection, and
        // reporting it as one would make a log read as though something had
        // been changed.
        .filter(|model| model != request.model)
}

/// What the rules do, as a person reads them.
pub fn render(rules: &[Rule]) -> String {
    if rules.is_empty() {
        return "no routing rules are declared\n".to_string();
    }
    let mut out = String::new();
    for rule in rules {
        let matcher = match &rule.matcher {
            Matcher::Any => "*".to_string(),
            Matcher::Role(r) => format!("role:{r}"),
            Matcher::Agent(a) => format!("agent:{a}"),
            Matcher::Model(m) => format!("model:{m}"),
        };
        out.push_str(&format!("  {matcher} -> {}\n", rule.use_model));
    }
    out
}

/// `[models]` -- an allowlist and alias map over the model a run may use.
///
/// This is the allowlist/alias/override capability the old `model_routing.rs`
/// provided, reimplemented on the current architecture *alongside* the redirect
/// `[[routing]]` rules above rather than replacing them: routing redirects a
/// request to a different model, while this restricts and renames the model a
/// request finally lands on.
///
/// Both lists empty is a project that has restricted nothing: [`resolve`]
/// returns the requested model unchanged, so a project with no `[models]`
/// section behaves exactly as before.
///
/// ```toml
/// [models]
/// allowed = ["provider/careful", "provider/fast"]
///
/// [models.aliases]
/// default = "provider/careful"
/// quick = "provider/fast"
/// ```
///
/// [`resolve`]: ModelPolicy::resolve
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct ModelPolicy {
    /// Canonical model ids a run may use. Empty means no restriction.
    #[serde(default)]
    pub allowed: Vec<String>,
    /// `alias = "target"`, applied transitively (cycle-guarded) before the
    /// allowlist is checked, so a project can pin a friendly name to a concrete
    /// id and move it in one place.
    #[serde(default)]
    pub aliases: std::collections::BTreeMap<String, String>,
}

/// The outcome of resolving a requested model against a [`ModelPolicy`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedModel {
    /// The concrete model id to use.
    pub model: String,
    /// Whether an alias was followed to reach it, for logging.
    pub via_alias: bool,
}

/// Why a model could not be resolved. Reported to the user rather than silently
/// switched: a run that quietly went to a model nobody chose is the failure the
/// allowlist exists to prevent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelPolicyError {
    /// An alias chain that never terminates, naming where it loops.
    AliasCycle(String),
    /// A model outside a non-empty allowlist.
    NotAllowed { requested: String, resolved: String },
}

impl std::fmt::Display for ModelPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelPolicyError::AliasCycle(at) => {
                write!(f, "the model alias chain loops at {at:?}")
            }
            ModelPolicyError::NotAllowed { requested, resolved } => {
                if requested == resolved {
                    write!(f, "model {requested:?} is not in this project's allowed models")
                } else {
                    write!(
                        f,
                        "model {requested:?} resolves to {resolved:?}, which is not in \
                         this project's allowed models"
                    )
                }
            }
        }
    }
}

impl ModelPolicy {
    /// Whether this policy restricts anything at all.
    pub fn is_empty(&self) -> bool {
        self.allowed.is_empty() && self.aliases.is_empty()
    }

    /// Follow the alias chain (cycle-guarded), then enforce the allowlist.
    ///
    /// An empty allowlist restricts nothing, so only the alias mapping applies.
    pub fn resolve(&self, requested: &str) -> Result<ResolvedModel, ModelPolicyError> {
        let mut current = requested.trim().to_string();
        let mut via_alias = false;
        let mut seen = std::collections::BTreeSet::new();
        while let Some(next) = self.aliases.get(&current) {
            if !seen.insert(current.clone()) {
                return Err(ModelPolicyError::AliasCycle(current));
            }
            current = next.trim().to_string();
            via_alias = true;
        }
        if !self.allowed.is_empty() && !self.allowed.iter().any(|m| m.trim() == current) {
            return Err(ModelPolicyError::NotAllowed {
                requested: requested.trim().to_string(),
                resolved: current,
            });
        }
        Ok(ResolvedModel { model: current, via_alias })
    }

    /// Startup validation: every alias chain terminates and, when an allowlist
    /// exists, resolves into it. Returns all problems, so a person fixing a
    /// config sees them at once rather than one run at a time.
    pub fn validate(&self) -> Vec<String> {
        let mut problems = Vec::new();
        for start in self.aliases.keys() {
            if let Err(err) = self.resolve(start) { problems.push(err.to_string()) }
        }
        problems
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared(pairs: &[(&str, &str)]) -> Vec<RoutingRule> {
        pairs
            .iter()
            .map(|(m, u)| RoutingRule {
                matcher: m.to_string(),
                use_model: u.to_string(),
            })
            .collect()
    }

    fn request<'a>(role: &'a str, agent: Option<&'a str>, model: &'a str) -> Request<'a> {
        Request { role, agent, model }
    }

    /// The first rule that matches wins, the way a person reads a list.
    #[test]
    fn the_first_matching_rule_decides() {
        let rules = rules(&declared(&[
            ("role:smol", "cheap/model"),
            ("agent:reviewer", "careful/model"),
            ("*", "default/model"),
        ]))
        .expect("read");

        assert_eq!(
            route(&rules, &request("smol", None, "base/model")).as_deref(),
            Some("cheap/model")
        );
        assert_eq!(
            route(&rules, &request("task", Some("reviewer"), "base/model")).as_deref(),
            Some("careful/model")
        );
        // Falls through to the catch-all.
        assert_eq!(
            route(&rules, &request("task", Some("someone-else"), "base/model")).as_deref(),
            Some("default/model")
        );
    }

    /// With no rules, nothing is redirected: routing narrows nothing and
    /// grants nothing.
    #[test]
    fn no_rules_redirect_nothing() {
        let rules = rules(&[]).expect("read");
        assert_eq!(route(&rules, &request("task", None, "base/model")), None);
    }

    /// A model pattern matches the way a person expects, with one wildcard
    /// character and no pattern language to learn.
    #[test]
    fn a_model_pattern_has_exactly_one_wildcard() {
        let rules = rules(&declared(&[("model:gpt-*", "ours/model")])).expect("read");
        assert_eq!(
            route(&rules, &request("task", None, "gpt-5.6-luna")).as_deref(),
            Some("ours/model")
        );
        assert_eq!(route(&rules, &request("task", None, "claude-opus")), None);

        let suffix = super::rules(&declared(&[("model:*-mini", "ours/model")])).expect("read");
        assert_eq!(
            route(&suffix, &request("task", None, "some-mini")).as_deref(),
            Some("ours/model")
        );
        assert_eq!(route(&suffix, &request("task", None, "some-mini-plus")), None);

        let middle = super::rules(&declared(&[("model:*turbo*", "ours/model")])).expect("read");
        assert_eq!(
            route(&middle, &request("task", None, "x-turbo-9")).as_deref(),
            Some("ours/model")
        );
    }

    /// A rule that redirects a model to itself is not a redirection, and is
    /// not reported as one.
    #[test]
    fn a_rule_that_changes_nothing_reports_nothing() {
        let rules = rules(&declared(&[("*", "base/model")])).expect("read");
        assert_eq!(route(&rules, &request("task", None, "base/model")), None);
    }

    /// A rule that cannot be honoured refuses the run: ignoring it would send
    /// the run to a model nobody chose while looking as though the rule had
    /// been honoured.
    #[test]
    fn a_rule_that_cannot_be_honoured_is_refused() {
        use tauri_plugin_agent_tools::harness_error::ErrorKind;
        let err = rules(&declared(&[("whenever", "x/y")])).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(err.message().contains("not a routing match"), "{err}");

        let err = rules(&declared(&[("role:", "x/y")])).unwrap_err();
        assert!(err.message().contains("not a routing match"), "{err}");

        let err = rules(&declared(&[("role:smol", "  ")])).unwrap_err();
        assert!(err.message().contains("says nothing to use"), "{err}");
    }

    // ---- [models] allowlist / aliases -------------------------------------

    fn policy(allowed: &[&str], aliases: &[(&str, &str)]) -> ModelPolicy {
        ModelPolicy {
            allowed: allowed.iter().map(|s| s.to_string()).collect(),
            aliases: aliases
                .iter()
                .map(|(a, t)| (a.to_string(), t.to_string()))
                .collect(),
        }
    }

    /// No `[models]` section restricts nothing: the request is unchanged.
    #[test]
    fn an_empty_model_policy_passes_through() {
        let p = ModelPolicy::default();
        assert!(p.is_empty());
        let r = p.resolve("provider/anything").expect("passes through");
        assert_eq!(r.model, "provider/anything");
        assert!(!r.via_alias);
    }

    /// An alias maps to its target, transitively, and reports it was followed.
    #[test]
    fn an_alias_resolves_transitively() {
        let p = policy(&[], &[("default", "fast"), ("fast", "provider/fast")]);
        let r = p.resolve("default").expect("resolves");
        assert_eq!(r.model, "provider/fast");
        assert!(r.via_alias);
    }

    /// A model outside a non-empty allowlist is refused, not switched.
    #[test]
    fn a_model_outside_the_allowlist_is_refused() {
        let p = policy(&["provider/a", "provider/b"], &[]);
        assert_eq!(
            p.resolve("provider/a").expect("allowed").model,
            "provider/a"
        );
        let err = p.resolve("provider/c").unwrap_err();
        assert_eq!(
            err,
            ModelPolicyError::NotAllowed {
                requested: "provider/c".to_string(),
                resolved: "provider/c".to_string(),
            }
        );
    }

    /// An alias that resolves into the allowlist is allowed.
    #[test]
    fn an_alias_into_the_allowlist_is_allowed() {
        let p = policy(&["provider/careful"], &[("default", "provider/careful")]);
        assert_eq!(
            p.resolve("default").expect("allowed").model,
            "provider/careful"
        );
    }

    /// A cyclic alias chain is refused rather than looping forever.
    #[test]
    fn a_cyclic_alias_is_refused() {
        let p = policy(&[], &[("a", "b"), ("b", "a")]);
        assert!(matches!(
            p.resolve("a"),
            Err(ModelPolicyError::AliasCycle(_))
        ));
    }

    /// `validate` surfaces a dangling alias and a cycle up front.
    #[test]
    fn validate_reports_config_problems() {
        let cycle = policy(&[], &[("a", "b"), ("b", "a")]);
        assert!(!cycle.validate().is_empty());

        let dangling = policy(&["provider/a"], &[("x", "provider/missing")]);
        let problems = dangling.validate();
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("not in this project's allowed models"));

        let clean = policy(&["provider/a"], &[("x", "provider/a")]);
        assert!(clean.validate().is_empty());
    }
}
