//! Where tokens and tool calls went, by skill, MCP server, plugin and subagent,
//! and what is configured but never used.
//!
//! `spend` totals by model. This reads the per-session event logs instead:
//! `usage.reported` carries a run's tokens, `agent.dispatched` names the
//! subagent a child run belongs to, and `tool.requested` / `tool.succeeded`
//! carry the tool, its resource and (bounded) output. Nothing new is written.
//!
//! Token spend is exact only for subagents (a child run is that subagent's
//! alone). A skill, MCP server or plugin has no dispatch of its own, so those
//! are attributed by calls and by the size of what their results put into the
//! context (`resultTokens`, characters over four, a floor because the log bounds
//! each recorded output).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;
use tauri_plugin_agent_tools::event_log::{self, Envelope};

const CHARS_PER_TOKEN: u64 = 4;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub name: String,
    pub calls: usize,
    /// Tokens the results of these calls added to the context, at least.
    pub result_tokens: u64,
    /// Model tokens spent by runs that belong to this item. Only subagents have
    /// them; `None` means not attributable, never zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Unused {
    /// `skill`, `plugin`, `mcp` or `subagent`.
    pub kind: String,
    pub name: String,
    /// What it costs the context just by being configured, where known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub since: Option<String>,
    pub skills: Vec<Bucket>,
    pub mcp_servers: Vec<Bucket>,
    pub plugins: Vec<Bucket>,
    pub subagents: Vec<Bucket>,
    pub unused: Vec<Unused>,
}

/// What is installed, as names (and a context cost for those that have one).
#[derive(Default, Clone)]
pub struct Configured {
    /// `(name, plugin it ships in, description chars)`.
    pub skills: Vec<(String, Option<String>, u64)>,
    pub mcp_servers: Vec<String>,
    pub subagents: Vec<String>,
}

impl Configured {
    /// From the data folder's MCP config, the built-in and user subagent
    /// definitions, and the skills visible from `root`.
    pub fn load(data_folder: &Path, root: Option<&Path>) -> Self {
        let mut out = Configured::default();
        if let Some(root) = root {
            for entry in crate::core::agent::skills::discover_all(root) {
                let Ok(text) = std::fs::read_to_string(&entry.file) else { continue };
                let parsed = crate::core::agent::skills::parse(&text);
                let name = crate::core::agent::skills::qualified_name(&entry);
                let chars = parsed.description.as_deref().unwrap_or_default().chars().count() as u64 + name.chars().count() as u64;
                out.skills.push((name, entry.plugin.clone(), chars));
            }
        }
        if let Ok(text) = std::fs::read_to_string(data_folder.join("mcp_config.json")) {
            if let Some(map) = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("mcpServers").and_then(|m| m.as_object().cloned()))
            {
                out.mcp_servers = map.keys().cloned().collect();
            }
        }
        out.subagents = crate::core::agent::roles::definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        out
    }
}

fn skill_name_of(event: &serde_json::Value, known: &[(String, Option<String>, u64)]) -> Option<String> {
    let resource = event.get("resource").and_then(|v| v.as_str()).unwrap_or_default();
    // The resource names the skill; free-form input is consulted only when the
    // event carries no resource, so a skill mentioned in prose is not credited.
    let text = if resource.is_empty() {
        event.get("input").and_then(|v| v.as_str()).unwrap_or_default()
    } else {
        resource
    };
    // Longest name first so `review` does not claim `review-pr`.
    let mut names: Vec<&String> = known.iter().map(|(n, _, _)| n).collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    names.into_iter().find(|n| contains_word(text, n)).cloned()
}

/// `name` in `text` with no identifier character on either side.
fn contains_word(text: &str, name: &str) -> bool {
    let ident = |c: char| c.is_alphanumeric() || matches!(c, '-' | '_');
    text.match_indices(name).any(|(i, m)| {
        text[..i].chars().next_back().is_none_or(|c| !ident(c))
            && text[i + m.len()..].chars().next().is_none_or(|c| !ident(c))
    })
}

/// Attribution over `envelopes` newer than `cutoff` (an RFC-3339 instant).
pub fn attribute(
    envelopes: &[Envelope],
    configured: &Configured,
    cutoff: Option<&str>,
) -> Attribution {
    let in_window = |e: &Envelope| cutoff.is_none_or(|c| e.at.as_str() >= c);

    // Child run id to the subagent that ran it.
    let mut agent_of_run: BTreeMap<&str, String> = BTreeMap::new();
    for e in envelopes.iter().filter(|e| e.kind == "agent.dispatched") {
        if let (Some(child), Some(agent)) = (
            e.payload.get("child").and_then(|v| v.as_str()),
            e.payload.get("agent").and_then(|v| v.as_str()),
        ) {
            agent_of_run.insert(child, agent.to_string());
        }
    }

    let mut skills: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut mcp: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut plugins: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut subagents: BTreeMap<String, Bucket> = BTreeMap::new();
    let bump = |map: &mut BTreeMap<String, Bucket>, name: &str| -> usize {
        let b = map.entry(name.to_string()).or_insert_with(|| Bucket {
            name: name.to_string(),
            ..Default::default()
        });
        b.calls += 1;
        b.calls
    };
    let add_result = |map: &mut BTreeMap<String, Bucket>, name: &str, tokens: u64| {
        if let Some(b) = map.get_mut(name) {
            b.result_tokens += tokens;
        }
    };

    // call id to (kind, name) so `tool.succeeded` can add its output size.
    let mut calls: BTreeMap<(String, String), Vec<(u8, String)>> = BTreeMap::new();
    let plugin_of_skill: BTreeMap<&str, &str> = configured
        .skills
        .iter()
        .filter_map(|(n, p, _)| p.as_deref().map(|p| (n.as_str(), p)))
        .collect();

    for e in envelopes.iter().filter(|e| in_window(e)) {
        match e.kind.as_str() {
            "usage.reported" => {
                let input = e.payload.get("inputTokens").and_then(|v| v.as_u64());
                let output = e.payload.get("outputTokens").and_then(|v| v.as_u64());
                let (Some(input), Some(output)) = (input, output) else { continue };
                if let Some(agent) = agent_of_run.get(e.run.as_str()) {
                    let b = subagents.entry(agent.clone()).or_insert_with(|| Bucket {
                        name: agent.clone(),
                        ..Default::default()
                    });
                    *b.input_tokens.get_or_insert(0) += input;
                    *b.output_tokens.get_or_insert(0) += output;
                }
            }
            "agent.dispatched" => {
                if let Some(agent) = e.payload.get("agent").and_then(|v| v.as_str()) {
                    bump(&mut subagents, agent);
                }
            }
            "tool.requested" => {
                let tool = e.payload.get("tool").and_then(|v| v.as_str()).unwrap_or_default();
                let kind = e.payload.get("kind").and_then(|v| v.as_str()).unwrap_or_default();
                let key = (e.run.clone(), e.payload.get("call").and_then(|v| v.as_str()).unwrap_or_default().to_string());
                if kind == "mcp" {
                    let server = e
                        .payload
                        .get("resource")
                        .and_then(|v| v.as_str())
                        .and_then(|r| r.split('/').next())
                        .unwrap_or("(unknown)")
                        .to_string();
                    bump(&mut mcp, &server);
                    calls.entry(key).or_default().push((1, server));
                } else if tool.starts_with("skill_") {
                    if let Some(name) = skill_name_of(&e.payload, &configured.skills) {
                        bump(&mut skills, &name);
                        calls.entry(key.clone()).or_default().push((0, name.clone()));
                        if let Some(plugin) = plugin_of_skill.get(name.as_str()) {
                            bump(&mut plugins, plugin);
                            calls.entry(key).or_default().push((2, plugin.to_string()));
                        }
                    }
                }
            }
            "tool.succeeded" => {
                let key = (e.run.clone(), e.payload.get("call").and_then(|v| v.as_str()).unwrap_or_default().to_string());
                let chars = e.payload.get("output").and_then(|v| v.as_str()).map_or(0, |s| s.chars().count() as u64);
                if let Some(items) = calls.get(&key) {
                    for (which, name) in items {
                        let map = match which {
                            0 => &mut skills,
                            1 => &mut mcp,
                            _ => &mut plugins,
                        };
                        add_result(map, name, chars / CHARS_PER_TOKEN);
                    }
                }
            }
            _ => {}
        }
    }

    let used = |map: &BTreeMap<String, Bucket>| -> BTreeSet<String> { map.keys().cloned().collect() };
    let (used_skills, used_mcp, used_plugins, used_agents) =
        (used(&skills), used(&mcp), used(&plugins), used(&subagents));
    let mut unused = Vec::new();
    let mut seen_plugins = BTreeSet::new();
    for (name, plugin, chars) in &configured.skills {
        if !used_skills.contains(name) {
            unused.push(Unused {
                kind: "skill".into(),
                name: name.clone(),
                context_tokens: Some(chars / CHARS_PER_TOKEN),
            });
        }
        if let Some(plugin) = plugin {
            if !used_plugins.contains(plugin) && seen_plugins.insert(plugin.clone()) {
                unused.push(Unused { kind: "plugin".into(), name: plugin.clone(), context_tokens: None });
            }
        }
    }
    for name in &configured.mcp_servers {
        if !used_mcp.contains(name) {
            unused.push(Unused { kind: "mcp".into(), name: name.clone(), context_tokens: None });
        }
    }
    for name in &configured.subagents {
        if !used_agents.contains(name) {
            unused.push(Unused { kind: "subagent".into(), name: name.clone(), context_tokens: None });
        }
    }

    let sorted = |map: BTreeMap<String, Bucket>| -> Vec<Bucket> {
        let mut v: Vec<Bucket> = map.into_values().collect();
        v.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.name.cmp(&b.name)));
        v
    };
    Attribution {
        since: cutoff.map(str::to_string),
        skills: sorted(skills),
        mcp_servers: sorted(mcp),
        plugins: sorted(plugins),
        subagents: sorted(subagents),
        unused,
    }
}

/// The attribution for a data folder over a window like `7d`.
pub fn report(
    data_folder: &Path,
    period: Option<&str>,
    root: Option<&Path>,
) -> Result<Attribution, crate::core::agent::spend::SpendError> {
    let cutoff = crate::core::agent::spend::since(period)?;
    let envelopes = event_log::read_all_sessions(data_folder);
    Ok(attribute(&envelopes, &Configured::load(data_folder, root), cutoff.as_deref()))
}

/// The attribution, as a person reads it.
pub fn render(a: &Attribution) -> String {
    let mut out = String::new();
    match &a.since {
        Some(s) => out.push_str(&format!("Attribution since {s}:\n")),
        None => out.push_str("Attribution, everything recorded:\n"),
    }
    let section = |out: &mut String, title: &str, buckets: &[Bucket]| {
        if buckets.is_empty() {
            return;
        }
        out.push_str(&format!("{title}:\n"));
        for b in buckets {
            out.push_str(&format!("  {}: {} calls, ~{} result tokens", b.name, b.calls, b.result_tokens));
            if let (Some(i), Some(o)) = (b.input_tokens, b.output_tokens) {
                out.push_str(&format!(", {i} in / {o} out"));
            }
            out.push('\n');
        }
    };
    section(&mut out, "Subagents", &a.subagents);
    section(&mut out, "Skills", &a.skills);
    section(&mut out, "MCP servers", &a.mcp_servers);
    section(&mut out, "Plugins", &a.plugins);
    if !a.unused.is_empty() {
        out.push_str("Configured, never used in this window:\n");
        for u in &a.unused {
            match u.context_tokens {
                Some(t) => out.push_str(&format!("  {} {} (~{t} context tokens)\n", u.kind, u.name)),
                None => out.push_str(&format!("  {} {}\n", u.kind, u.name)),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_skill_named_only_in_free_text_is_not_credited() {
        let known = vec![("review".to_string(), None, 0u64), ("deploy".to_string(), None, 0u64)];
        let ev = serde_json::json!({"resource": "deploy", "input": "please review this"});
        assert_eq!(skill_name_of(&ev, &known).as_deref(), Some("deploy"));
        let ev = serde_json::json!({"resource": "other", "input": "review"});
        assert_eq!(skill_name_of(&ev, &known), None);
        let ev = serde_json::json!({"resource": "review-pr"});
        assert_eq!(skill_name_of(&ev, &known), None, "word boundary");
        let ev = serde_json::json!({"input": "review"});
        assert_eq!(skill_name_of(&ev, &known).as_deref(), Some("review"));
    }

    use super::*;
    use serde_json::json;

    fn env(run: &str, kind: &str, payload: serde_json::Value) -> Envelope {
        Envelope {
            v: 1,
            id: format!("{run}{kind}{payload}"),
            session: "s".into(),
            run: run.into(),
            invocation: String::new(),
            seq: 0,
            at: "2026-10-20T10:00:00Z".into(),
            kind: kind.into(),
            payload,
            redactions: vec![],
        }
    }

    #[test]
    fn attributes_subagent_tokens_mcp_calls_and_reports_unused() {
        let configured = Configured {
            skills: vec![("deploy".into(), None, 40), ("lint".into(), Some("qa".into()), 80)],
            mcp_servers: vec!["github".into(), "idle".into()],
            subagents: vec!["scout".into(), "idle-agent".into()],
        };
        let events = vec![
            env("main", "agent.dispatched", json!({ "child": "c1", "agent": "scout" })),
            env("c1", "usage.reported", json!({ "inputTokens": 100, "outputTokens": 10 })),
            env("main", "usage.reported", json!({ "inputTokens": 999, "outputTokens": 9 })),
            env("main", "tool.requested", json!({ "tool": "gh", "call": "k1", "kind": "mcp", "resource": "github/list_prs" })),
            env("main", "tool.succeeded", json!({ "call": "k1", "output": "x".repeat(400) })),
            env("main", "tool.requested", json!({ "tool": "skill_read", "call": "k2", "resource": "lint" })),
        ];
        let a = attribute(&events, &configured, None);
        assert_eq!(a.subagents[0].name, "scout");
        assert_eq!(a.subagents[0].input_tokens, Some(100));
        assert_eq!(a.mcp_servers[0].name, "github");
        assert_eq!(a.mcp_servers[0].result_tokens, 100);
        assert_eq!(a.skills[0].name, "lint");
        assert_eq!(a.plugins[0].name, "qa");
        let unused: Vec<_> = a.unused.iter().map(|u| (u.kind.as_str(), u.name.as_str())).collect();
        assert_eq!(unused, [("skill", "deploy"), ("mcp", "idle"), ("subagent", "idle-agent")]);
        assert_eq!(a.unused[0].context_tokens, Some(10));
    }

    #[test]
    fn window_excludes_older_events() {
        let events = vec![env("main", "agent.dispatched", json!({ "child": "c", "agent": "scout" }))];
        let a = attribute(&events, &Configured::default(), Some("2026-10-21T00:00:00Z"));
        assert!(a.subagents.is_empty());
    }
}
