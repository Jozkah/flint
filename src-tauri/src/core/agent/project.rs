//! `agent.toml` project config parsing and `.jan/agent/` scaffolding.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use tauri_plugin_agent_tools::permissions::{PermissionDefault, ToolPermissions};

/// `[tools]`/`[skills]` are always modeled. `[agent]` and `[budget]` are only
/// compiled for the CLI (their sole consumer, via `flint cli agent run/step/status`).
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct AgentToml {
    #[cfg(feature = "cli")]
    #[serde(default)]
    pub agent: AgentSection,
    #[cfg(feature = "cli")]
    #[serde(default)]
    pub budget: BudgetSection,
    #[cfg(feature = "cli")]
    #[serde(default)]
    pub provider: Option<ProviderSection>,
    #[serde(default)]
    pub tools: ToolsSection,
    #[serde(default)]
    pub skills: SkillsSection,
    #[serde(default)]
    pub plugins: PluginsSection,
    /// `[notify]` -- who to tell when a run ends or wants a person (AH-185,
    /// AH-184).
    #[cfg(feature = "cli")]
    #[serde(default)]
    pub notify: crate::core::agent::notify::NotifySection,
    /// `[profiles.<name>]` -- named variations on this project's settings,
    /// chosen per run (AH-186).
    #[serde(default)]
    pub profiles: std::collections::BTreeMap<String, ProfileSection>,
    /// `[[routing]]` -- which model answers what (AH-194).
    #[serde(default)]
    pub routing: Vec<crate::core::agent::routing::RoutingRule>,
    /// `[models]` -- an allowlist and alias map over the model a run may use,
    /// applied at model-id finalization.
    #[serde(default)]
    pub models: crate::core::agent::routing::ModelPolicy,
    /// `[auto_mode]` -- the autonomous-mode safety classifier, off by default.
    #[serde(default)]
    pub auto_mode: crate::core::agent::auto_mode::AutoModePolicy,
    /// `[output]` -- how much a run says about itself (AH-181).
    #[cfg(feature = "cli")]
    #[serde(default)]
    pub output: OutputSection,
    /// `[licenses]` -- what this project's dependencies may be licensed under
    /// (AH-158).
    #[serde(default)]
    pub licenses: LicensesSection,
}

/// `[licenses]` -- the licences this project allows its dependencies to carry
/// (AH-158). Empty is a project that has not said, which is not the same as a
/// project that allows nothing.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct LicensesSection {
    #[serde(default)]
    pub allow: Vec<String>,
}

/// `[output]` -- how much a headless run prints while it works (AH-181).
#[derive(Debug, Clone, Default, Deserialize)]
#[cfg(feature = "cli")]
pub(crate) struct OutputSection {
    /// `compact`, `normal` or `verbose`. Unset is normal.
    #[serde(default)]
    pub density: Option<String>,
}

/// A named variation on a project's settings (AH-186).
///
/// Only the things a person actually varies between runs: which model, how
/// much it may generate and read, what it may do, and which skills it sees. A
/// profile that could change anything at all would be a second configuration
/// format, and the one a reader has to hold in their head would be whichever
/// they last looked at.
///
/// Every field is optional, and an unset field means "whatever the base
/// configuration says" -- not a default of its own, which would make selecting
/// a profile quietly reset settings it never mentioned.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ProfileSection {
    #[serde(default)]
    #[cfg(feature = "cli")]
    pub model: Option<String>,
    #[serde(default)]
    #[cfg(feature = "cli")]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    #[cfg(feature = "cli")]
    pub context_window: Option<u64>,
    /// `[tools].default` for this profile: `allow`, `ask` or `deny`.
    #[serde(default)]
    pub tools_default: Option<String>,
    #[serde(default)]
    pub tools_allow: Option<Vec<String>>,
    #[serde(default)]
    pub tools_deny: Option<Vec<String>>,
    #[serde(default)]
    pub allow_network: Option<bool>,
    #[serde(default)]
    pub sandbox: Option<bool>,
    #[serde(default)]
    pub format_on_edit: Option<bool>,
    /// `[skills].enabled` for this profile.
    #[serde(default)]
    pub skills: Option<Vec<String>>,
}

/// Fold a named profile into a configuration (AH-186).
///
/// An unknown name is refused, naming what this project does declare: silently
/// running the base configuration because a profile was misspelled is a run
/// with the wrong settings that looks like the right one.
pub(crate) fn apply_profile(mut cfg: AgentToml, name: &str) -> Result<AgentToml, String> {
    let Some(profile) = cfg.profiles.get(name).cloned() else {
        let mut known: Vec<&String> = cfg.profiles.keys().collect();
        known.sort();
        return Err(if known.is_empty() {
            format!("no profile named {name:?}: this project declares none")
        } else {
            format!(
                "no profile named {name:?}: this project declares {}",
                known
                    .iter()
                    .map(|n| format!("{n:?}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        });
    };
    #[cfg(feature = "cli")]
    {
        if let Some(model) = profile.model.clone() {
            cfg.agent.model = Some(model);
        }
        if let Some(max_tokens) = profile.max_tokens {
            cfg.agent.max_tokens = Some(max_tokens);
        }
        if let Some(window) = profile.context_window {
            cfg.agent.context_window = Some(window);
        }
    }
    if let Some(default) = profile.tools_default.clone() {
        cfg.tools.default = Some(default);
    }
    if let Some(allow) = profile.tools_allow.clone() {
        cfg.tools.allow = allow;
    }
    if let Some(deny) = profile.tools_deny.clone() {
        cfg.tools.deny = deny;
    }
    if let Some(network) = profile.allow_network {
        cfg.tools.allow_network = Some(network);
    }
    if let Some(sandbox) = profile.sandbox {
        cfg.tools.sandbox = Some(sandbox);
    }
    if let Some(format_on_edit) = profile.format_on_edit {
        cfg.tools.format_on_edit = Some(format_on_edit);
    }
    if let Some(skills) = profile.skills.clone() {
        cfg.skills.enabled = skills;
    }
    Ok(cfg)
}

/// The project's configuration with a profile folded in, when one was chosen
/// (AH-186).
pub(crate) fn load_agent_config_with_profile(
    project_root: &Path,
    profile: Option<&str>,
) -> Result<AgentToml, String> {
    let cfg = load_agent_config(project_root)?;
    match profile.map(str::trim).filter(|p| !p.is_empty()) {
        Some(name) => apply_profile(cfg, name),
        None => Ok(cfg),
    }
}

/// `[plugins]` — plugin installs and marketplace. Installed plugins live in
/// `.jan/agent/plugins/`; this section only carries configuration.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct PluginsSection {
    /// URL of a JSON marketplace index (`[{ name, description, repo, ref? }]`).
    /// Unset disables name-based installs; direct git URLs still work.
    #[serde(default)]
    pub marketplace: Option<String>,
    /// Installed plugins (by directory name) that stay on disk but contribute
    /// nothing: their skills, commands and agents are skipped by discovery.
    /// Absent or empty means every installed plugin is enabled.
    #[serde(default)]
    pub disabled: Vec<String>,
}

/// The project's `[plugins].disabled` list. A missing or malformed agent.toml
/// yields an empty list, the same fallback every other discovery path uses.
pub(crate) fn disabled_plugins(project_root: &Path) -> Vec<String> {
    load_agent_config(project_root)
        .map(|c| c.plugins.disabled)
        .unwrap_or_default()
}

/// Persist a string array at `[section].key` in the agent.toml at `path`,
/// format-preserving (comments and unrelated keys kept).
pub(crate) fn set_string_array_in_agent_toml(
    path: &Path,
    section: &str,
    key: &str,
    values: &[String],
) -> Result<(), String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut doc = raw
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    let table = doc[section].or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
    let mut arr = toml_edit::Array::new();
    for value in values {
        arr.push(value.as_str());
    }
    table[key] = toml_edit::value(arr);

    std::fs::write(path, doc.to_string())
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// `[provider]` — project-local override of a single provider's config,
/// highest priority in the resolution chain (wins over the global
/// `~/.jan/config.toml` and the desktop-inherited config). Optional: most
/// projects rely on the global scope instead. CLI-only, like `AgentSection`.
#[cfg(feature = "cli")]
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ProviderSection {
    pub name: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub api_type: Option<String>,
}

/// `[skills]` — which project skills are advertised to the model. An empty
/// `enabled` list means "all skills" (backward-compatible with the scaffold
/// template, which ships `enabled = []`); a non-empty list is a whitelist.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct SkillsSection {
    #[serde(default)]
    pub enabled: Vec<String>,
}

/// `[budget]` — the only cap on how long a run may go. The agent takes as many
/// turns as the task needs; `max_tokens` bounds the run's *marginal* token
/// spend (see `SessionBudget`: replayed context is not recharged each turn).
/// Unset applies `DEFAULT_MAX_SESSION_TOKENS`; an explicit `0` disables the
/// ceiling, leaving cancellation as the only guard.
#[cfg(feature = "cli")]
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct BudgetSection {
    #[serde(default)]
    pub max_tokens: Option<u64>,
}

/// `[agent]` — resolves the model and per-run knobs for CLI agent runs.
#[cfg(feature = "cli")]
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct AgentSection {
    #[serde(default)]
    pub model: Option<String>,
    /// Providers to try, in order, when the configured model cannot be
    /// reached at all (AH-193). Each entry is a model id, optionally
    /// provider-qualified (`provider/model`), resolved the same way `model`
    /// is. Empty by default: a fallback nobody asked for is a surprise, and a
    /// reply from a provider the user did not choose is worse than an error.
    #[serde(default)]
    pub fallback: Vec<String>,
    /// Context window limit in tokens for the model (defaults to 128K if unset).
    /// Set this to match your model's actual context length so compaction
    /// triggers at the right threshold.
    #[serde(default)]
    pub context_window: Option<u64>,
    /// Tokens to hold back from the context window when deciding whether to
    /// compact (defaults to 16K if unset). Compaction triggers at
    /// `context_window - compaction_reserve_tokens`. This is a compaction
    /// heuristic only — it is NOT sent to the API as `max_tokens`.
    #[serde(default)]
    pub compaction_reserve_tokens: Option<u64>,
    /// Per-request output cap forwarded to the model as the OpenAI-compatible
    /// `max_tokens` field. Limits how many tokens the model may generate in a
    /// single response. Omitted from the request when unset (model default).
    #[serde(default)]
    pub max_tokens: Option<u64>,
    /// Cap on concurrently-running background subagents for a run (defaults to
    /// 10 if unset). Dispatches beyond the cap queue FIFO and start as running
    /// ones finish. Snapshot at run start: a mid-run change affects the next
    /// run only.
    #[serde(default)]
    pub max_parallel_subagents: Option<u32>,
    /// Expand `<think>` reasoning blocks in the TUI transcript instead of
    /// folding them to a `[thinking]`/`[thought for Ns]` status and a summary
    /// row. Default false (hidden); Ctrl-O still reveals a folded block, and
    /// this flips the default for every block in the session.
    #[serde(default)]
    pub show_reasoning: Option<bool>,
    /// Resend a prior assistant turn's `reasoning_content` to the model with the
    /// rest of the conversation. Default true: providers that expose reasoning
    /// natively generally expect it back, and local llama.cpp templates with
    /// `preserve_thinking` re-emit prior reasoning from this field (dropping it
    /// shrinks earlier turns and forces the KV-cache prefix to be reprocessed).
    /// Set false for a strict upstream that rejects the key on assistant turns
    /// (Groq's validator is the known case), or to keep long chains of thought
    /// out of the context budget.
    #[serde(default)]
    pub send_reasoning: Option<bool>,
    /// Give each session in this project its own git worktree, so the agent's
    /// edits land in a separate checkout instead of the user's. `None` = defer
    /// to the global `worktree` setting, then the default, off.
    #[serde(default)]
    pub worktree: Option<bool>,
}

// `default`/`allow`/`deny`/`allow_write` are consumed by `permissions_from`,
// which only the CLI calls: the desktop's tool gate lives in the plugin. They
// stay parsed regardless so the desktop round-trips an `agent.toml` written by
// the CLI instead of silently dropping the user's policy on save.
#[derive(Debug, Clone, Default, Deserialize)]
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) struct ToolsSection {
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    #[serde(default)]
    pub allow_write: Vec<String>,
    /// Rules that force a confirmation every time, even when an allow rule
    /// also matches. Read here too, not only by the desktop's
    /// `policy::load`, so the CLI honours them (Jozkah/jan#226).
    #[serde(default)]
    pub ask: Vec<String>,
    /// Hosts the network tools may reach, when non-empty; capped by the
    /// machine policy (AH-187).
    #[serde(default)]
    pub allow_domains: Vec<String>,
    /// Hosts the network tools may never reach; the machine policy's are added.
    #[serde(default)]
    pub deny_domains: Vec<String>,
    /// Whether the sandboxed shell keeps its network namespace. `None` (unset)
    /// leaves the choice to the surface running the loop, which differ: the CLI
    /// prompts before every exec and allows it, the desktop's ephemeral chat
    /// sandbox does not and denies it.
    #[serde(default)]
    pub allow_network: Option<bool>,
    /// Whether the sandboxed shell may read the user's home directory (the
    /// CLI, for `git`/`ssh` credential helpers). `None` (unset) leaves the
    /// choice to the surface: the CLI defaults to true, the desktop masks
    /// `$HOME` entirely. Writes are confined to the workspace either way.
    #[serde(default)]
    pub allow_home_read: Option<bool>,
    /// Whether the shell runs under OS confinement. `None` (unset) leaves the
    /// choice to the surface: the desktop always confines, the CLI defaults to
    /// off and opts in with `--sandbox` or the global `sandbox` setting.
    /// Setting it here is how a repo requires confinement for everyone who
    /// checks it out.
    #[serde(default)]
    pub sandbox: Option<bool>,
    /// Whether a file the agent edits is handed to this project's own
    /// formatter before its diff is shown (AH-149). Off unless asked for: a
    /// formatter is a program, and running one nobody asked for is a change
    /// nobody asked for. It only ever runs where the project itself says which
    /// formatter it uses (AH-150).
    #[serde(default)]
    pub format_on_edit: Option<bool>,
}

const AGENT_TOML_TEMPLATE: &str = r#"[agent]
# model = "Jan-V4"
# context_window = 128000  # tokens; defaults to 128K if unset
# compaction_reserve_tokens = 16384  # headroom before auto-compaction; defaults to 16K
# max_tokens = 4096  # cap on tokens the model generates per response (OpenAI max_tokens); omitted if unset
# max_parallel_subagents = 10  # max concurrently-running subagents per run; extra dispatches queue FIFO
# show_reasoning = false  # expand  reasoning in the transcript (Ctrl-O still toggles)
# send_reasoning = true  # resend prior reasoning to the model; false drops it from the request
#                        # (a provider that rejects the field is detected and stripped automatically)

# Project-local provider override. Wins over ~/.jan/config.toml and any
# provider inherited from Jan Desktop's settings.json. Most projects don't
# need this and should rely on the global scope instead.
# [provider]
# name = "openai"
# api_key = "sk-..."
# base_url = "https://api.openai.com/v1"
# models = ["gpt-4o"]

# The run's only cap: new token spend across all turns (replayed context is not
# recharged each turn). There is no turn limit. Defaults to 128000 when unset;
# 0 disables the cap so the agent runs until the task is done or cancelled.
[budget]
# max_tokens = 128000

[tools]
# read-only | deny | allow. read-only (default) exposes MCP tools and built-in
# reads; built-in writes/exec go through the permission gate. deny locks down
# all MCP tools.
default = "read-only"
# Exposed even under deny; deny-list wins over everything:
allow = []
deny = []
# Write tools are opt-in only:
# allow_write = ["fs.write"]
allow_write = []
# Whether the sandboxed shell can reach the network. Unset follows the surface
# running the agent: the CLI allows it, the desktop's throwaway chat sandbox
# does not.
# allow_network = true
# Whether the sandboxed shell can read your home directory (for git/ssh
# credential helpers and ~/.ssh/config). Unset follows the surface: the CLI
# allows it (true), the desktop masks $HOME. Writes stay in the workspace.
# allow_home_read = true
# Whether `bash` runs under OS confinement at all. Unset follows the surface:
# the CLI runs unconfined unless you pass --sandbox or set sandbox = true in
# ~/.jan/config.toml; the desktop always confines. Set it here to require
# confinement for anyone working in this project.
# sandbox = true
# Whether a file the agent edits is run through this project's own formatter
# before you are shown the diff. Only ever runs a formatter the project itself
# declares (rustfmt.toml/Cargo.toml, .prettierrc, pyproject [tool.ruff]/[tool.black],
# go.mod) and that is actually installed.
# format_on_edit = true

[skills]
enabled = []
# always | relevance
inject = "always"

# Who to tell when a run ends, or stops to wait for you. Nothing is sent but
# which run, what happened and when -- never the prompt, the answer or any tool
# output.
# [notify]
# command = ["notify-send", "Jan"]      # argument vector; no shell
# webhook = "https://example.invalid/hooks/jan"
# events = ["run.ended", "needs.attention"]

# Licences this project's dependencies may carry. Unset checks nothing; "*"
# allows anything that declares a licence at all.
# [licenses]
# allow = ["MIT", "Apache-2.0", "BSD-3-Clause"]

# How much a headless run prints while it works: compact, normal or verbose.
# The answer on stdout is the same either way; this is the progress on stderr.
# [output]
# density = "compact"

# Which model answers what. Rules are read in order and the first match wins;
# anything no rule matches resolves exactly as it would have.
# [[routing]]
# match = "role:smol"          # role:<name>, agent:<name>, model:<pattern>, or *
# use = "provider/small-fast-model"

# Named variations on the settings above, chosen with `--profile <name>`.
# What a profile does not mention is left exactly as it is above.
# [profiles.review]
# model = "provider/a-careful-model"
# tools_default = "ask"
# tools_deny = ["bash"]
# skills = ["review"]
"#;

/// Path to `<project_root>/.jan/agent/agent.toml`.
pub(crate) fn agent_toml_path(project_root: &Path) -> PathBuf {
    project_root.join(".jan").join("agent").join("agent.toml")
}

/// Load + parse agent.toml. Err if missing or malformed (path included in message).
pub(crate) fn load_agent_config(project_root: &Path) -> Result<AgentToml, String> {
    load_agent_config_at(&agent_toml_path(project_root))
}

/// [`load_agent_config`] at an explicit path rather than a project root's
/// `.jan/agent/agent.toml` -- used for the global agent config, which lives
/// directly at `<store>/agent.toml`.
pub(crate) fn load_agent_config_at(path: &Path) -> Result<AgentToml, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    toml::from_str(&raw).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

/// The per-run knobs a `ToolContext` needs from agent.toml.
///
/// The toolset owns no config format, so this is the one place that maps
/// agent.toml onto a `ToolContext`. Resolved once per run rather than per tool
/// call, and in a single parse rather than one per field.
#[derive(Debug, Clone, Default)]
pub(crate) struct RunSettings {
    /// `[skills].enabled` (empty = every skill).
    pub enabled_skills: Vec<String>,
    /// `[tools].allow_network`; `None` when unset, so the caller applies the
    /// default appropriate to its surface.
    pub allow_network: Option<bool>,
    /// `[tools].allow_home_read`; `None` when unset, so the caller applies the
    /// default appropriate to its surface.
    pub allow_home_read: Option<bool>,
    /// `[tools].sandbox`; `None` when unset, so the caller applies the default
    /// appropriate to its surface.
    pub sandbox: Option<bool>,
    /// `[tools].format_on_edit` (AH-149); unset is off.
    pub format_on_edit: bool,
    /// `[tools].allow_domains`, capped by the machine policy (Jozkah/jan#226).
    pub allow_domains: Vec<String>,
    /// `[tools].deny_domains` plus the machine policy's.
    pub deny_domains: Vec<String>,
    /// `[agent].worktree`: give each session its own git checkout. Merged with
    /// the global setting and the `--worktree` flag by the caller. CLI-only,
    /// like the `[agent]` section it comes from.
    #[cfg(feature = "cli")]
    pub worktree: Option<bool>,
}

/// A missing or malformed config yields defaults rather than an error: a project
/// without an agent.toml should still run, advertising all of its skills.
pub(crate) fn run_settings(project_root: &Path) -> RunSettings {
    run_settings_for(project_root, None)
}

/// The same, with a profile folded in (AH-186). A profile that does not exist
/// leaves the base settings: the run itself has already refused by then, and a
/// second refusal from here would say the same thing twice.
pub(crate) fn run_settings_for(project_root: &Path, profile: Option<&str>) -> RunSettings {
    let (org, _) = tauri_plugin_agent_tools::org_policy::load();
    let org = org.unwrap_or_default();
    let Ok(cfg) = load_agent_config_with_profile(project_root, profile) else {
        // No readable project file still leaves the machine's lists in force.
        return RunSettings {
            allow_domains: org.clamp_allow_domains(&[]),
            deny_domains: org.clamp_deny_domains(&[]),
            ..RunSettings::default()
        };
    };
    RunSettings {
        allow_domains: org.clamp_allow_domains(&cfg.tools.allow_domains),
        deny_domains: org.clamp_deny_domains(&cfg.tools.deny_domains),
        enabled_skills: cfg.skills.enabled,
        allow_network: cfg.tools.allow_network,
        allow_home_read: cfg.tools.allow_home_read,
        sandbox: cfg.tools.sandbox,
        format_on_edit: cfg.tools.format_on_edit.unwrap_or(false),
        #[cfg(feature = "cli")]
        worktree: cfg.agent.worktree,
    }
}

/// The licences this project allows its dependencies to carry (AH-158). A
/// project with no configuration allows nothing in particular, which is not
/// the same as allowing nothing: see `licenses::scan`.
pub fn allowed_licenses(project_root: &Path) -> Vec<String> {
    load_agent_config(project_root)
        .map(|cfg| cfg.licenses.allow)
        .unwrap_or_default()
}

/// Put `section` where the file's `[tools]` block was, keeping everything
/// else exactly as it is: a policy import (AH-052) or a bundle import
/// (AH-145) must not rewrite a project's model, budget or skills.
pub(crate) fn replace_tools_section(existing: &str, section: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    let mut replaced = false;
    for line in existing.lines() {
        let heading = line.trim_start().starts_with('[') && line.trim_end().ends_with(']');
        if heading {
            if line.trim() == "[tools]" {
                out.push_str(section);
                // A blank line before whatever section follows, so the file
                // reads the way the user wrote it.
                out.push('\n');
                skipping = true;
                replaced = true;
                continue;
            }
            skipping = false;
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !replaced {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(section);
    }
    out
}

pub(crate) fn enabled_skills(project_root: &Path) -> Vec<String> {
    run_settings(project_root).enabled_skills
}

/// Build a `ToolPermissions` from the parsed `[tools]` section.
///
/// CLI-only: the desktop no longer runs the agent loop in Rust, so its tool
/// gating is the plugin's, not this one.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn permissions_from(cfg: &AgentToml) -> ToolPermissions {
    let (org, error) = tauri_plugin_agent_tools::org_policy::load();
    if let Some(error) = &error {
        eprintln!("machine policy: {}", error.message);
    }
    permissions_under(cfg, &org.unwrap_or_default())
}

/// The same, against a given machine policy (AH-187).
///
/// The project file is writable by anyone who can push to the repository, so
/// what it says is a request, not a decision: the machine's policy caps the
/// default and adds its denies, and a project can only be stricter than that.
/// Split out so the combination is testable without an installed file.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn permissions_under(
    cfg: &AgentToml,
    org: &tauri_plugin_agent_tools::org_policy::OrgPolicy,
) -> ToolPermissions {
    let default = cfg
        .tools
        .default
        .as_deref()
        .map(PermissionDefault::from_str_lenient)
        .unwrap_or_default();
    ToolPermissions::new(
        org.clamp_default(default),
        &cfg.tools.allow,
        &org.clamp_deny(&cfg.tools.deny),
        &cfg.tools.allow_write,
    )
    .with_ask(&cfg.tools.ask)
}

/// Whether this run may reach the network, given what the project asked for.
///
/// The machine's answer is a ceiling: a project may decline the network it was
/// offered and may never take one it was not.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn network_allowed(project_asked: bool) -> bool {
    let (org, _) = tauri_plugin_agent_tools::org_policy::load();
    org.unwrap_or_default().clamp_network(project_asked)
}

/// Ensure a usable `.jan/agent/{agent.toml, skills/, memory/}` exists under
/// `project_root`, creating only the pieces that don't already exist.
/// Idempotent and clobber-safe: preserves user edits on re-runs. Auto-managed
/// on both the CLI and desktop agent-run paths (there is no explicit init step).
///
/// The project instructions file (`<project_root>/JAN.md`) is deliberately not
/// scaffolded: an empty placeholder costs prompt space and teaches nothing, so
/// it is written by `/init` or by hand.
pub(crate) fn ensure_project(project_root: &Path) -> Result<PathBuf, String> {
    if !project_root.is_dir() {
        return Err(format!(
            "project directory does not exist: {}. Pass --project with a path to an existing directory (paths are case-sensitive).",
            project_root.display()
        ));
    }
    let agent_dir = project_root.join(".jan").join("agent");
    std::fs::create_dir_all(agent_dir.join("skills"))
        .map_err(|e| format!("Failed to create skills dir: {e}"))?;
    std::fs::create_dir_all(agent_dir.join("memory"))
        .map_err(|e| format!("Failed to create memory dir: {e}"))?;

    let toml_path = agent_dir.join("agent.toml");
    if !toml_path.exists() {
        std::fs::write(&toml_path, AGENT_TOML_TEMPLATE)
            .map_err(|e| format!("Failed to write {}: {e}", toml_path.display()))?;
    }

    Ok(agent_dir)
}

/// Persist `[agent].model` into the agent.toml at `path`, format-preserving
/// (comments kept). Remembers a TUI `/model` selection across sessions.
#[cfg(feature = "cli")]
pub(crate) fn set_model_in_agent_toml(path: &Path, model: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut doc = raw
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    let agent = doc["agent"].or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
    agent["model"] = toml_edit::value(model);

    std::fs::write(path, doc.to_string())
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Persist a scalar key into the agent.toml at `path`, format-preserving
/// (comments kept). Keys are `section.key` with `agent` the default section,
/// so the `/settings` menu can reach `[agent]`, `[budget]`, `[tools]` and
/// `[skills]` scalars alike. `None` removes the key (default applies).
#[cfg(feature = "cli")]
pub(crate) fn set_agent_key(
    path: &Path,
    key: &str,
    value: Option<toml_edit::Item>,
) -> Result<(), String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut doc = raw
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    let (section, key) = match key.split_once('.') {
        Some((section, key)) => (section, key),
        None => ("agent", key),
    };

    match value {
        Some(v) => {
            let table = doc[section].or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
            table[key] = v;
        }
        None => {
            if let Some(table) = doc.get_mut(section).and_then(|t| t.as_table_mut()) {
                table.remove(key);
            }
        }
    }

    std::fs::write(path, doc.to_string())
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Persist `[skills].enabled` into the agent.toml at `path`, format-preserving
/// (comments kept). An empty list clears the whitelist (= all skills enabled).
#[cfg(not(feature = "cli"))]
pub(crate) fn set_skills_enabled_in_agent_toml(
    path: &Path,
    enabled: &[String],
) -> Result<(), String> {
    set_string_array_in_agent_toml(path, "skills", "enabled", enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project with the profile written into its agent.toml.
    fn project_with(toml: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan_profile_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        let dir = root.join(".jan").join("agent");
        std::fs::create_dir_all(&dir).expect("project");
        std::fs::write(dir.join("agent.toml"), toml).expect("agent.toml");
        root
    }

    const BASE: &str = r#"
[agent]
model = "base/model"
max_tokens = 1000

[tools]
default = "allow"
deny = ["bash"]
allow_network = true

[skills]
enabled = ["one"]

[profiles.review]
model = "careful/model"
tools_default = "ask"
skills = ["review"]

[profiles.quiet]
max_tokens = 10
"#;

    /// AH-186: what a profile mentions changes; what it does not mention is
    /// left exactly as the project had it. A profile that quietly reset
    /// settings it never named would be a run with settings nobody chose.
    #[test]
    fn a_profile_changes_what_it_names_and_nothing_else() {
        let root = project_with(BASE);
        let base = load_agent_config_with_profile(&root, None).expect("base");
        #[cfg(feature = "cli")]
        assert_eq!(base.agent.model.as_deref(), Some("base/model"));
        assert_eq!(base.tools.default.as_deref(), Some("allow"));
        assert_eq!(base.skills.enabled, vec!["one".to_string()]);

        let review = load_agent_config_with_profile(&root, Some("review")).expect("review");
        #[cfg(feature = "cli")]
        assert_eq!(review.agent.model.as_deref(), Some("careful/model"));
        assert_eq!(review.tools.default.as_deref(), Some("ask"));
        assert_eq!(review.skills.enabled, vec!["review".to_string()]);
        // Untouched by this profile:
        #[cfg(feature = "cli")]
        assert_eq!(review.agent.max_tokens, Some(1000));
        assert_eq!(review.tools.deny, vec!["bash".to_string()]);
        assert_eq!(review.tools.allow_network, Some(true));

        let quiet = load_agent_config_with_profile(&root, Some("quiet")).expect("quiet");
        #[cfg(feature = "cli")]
        {
            assert_eq!(quiet.agent.max_tokens, Some(10));
            assert_eq!(quiet.agent.model.as_deref(), Some("base/model"));
        }
        assert_eq!(quiet.skills.enabled, vec!["one".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A profile nobody declared is refused, naming what the project does
    /// declare: running the base settings because a name was misspelled is a
    /// run with the wrong settings that looks like the right one.
    #[test]
    fn a_profile_that_does_not_exist_is_refused_by_name() {
        let root = project_with(BASE);
        let err = load_agent_config_with_profile(&root, Some("reveiw")).unwrap_err();
        assert!(err.contains("\"reveiw\""), "{err}");
        assert!(err.contains("\"review\"") && err.contains("\"quiet\""), "{err}");

        let bare = project_with("[tools]\ndefault = \"allow\"\n");
        let err = load_agent_config_with_profile(&bare, Some("anything")).unwrap_err();
        assert!(err.contains("declares none"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
    }

    /// The settings a run actually uses follow the profile, not just the file:
    /// this is the path `resolve_run_settings` reads.
    #[test]
    fn the_runs_own_settings_follow_the_chosen_profile() {
        let root = project_with(
            r#"
[tools]
allow_network = true
format_on_edit = false

[skills]
enabled = ["one"]

[profiles.offline]
allow_network = false
format_on_edit = true
skills = ["two", "three"]
"#,
        );
        let base = run_settings_for(&root, None);
        assert_eq!(base.allow_network, Some(true));
        assert!(!base.format_on_edit);
        assert_eq!(base.enabled_skills, vec!["one".to_string()]);

        let offline = run_settings_for(&root, Some("offline"));
        assert_eq!(offline.allow_network, Some(false));
        assert!(offline.format_on_edit);
        assert_eq!(
            offline.enabled_skills,
            vec!["two".to_string(), "three".to_string()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Naming no profile is the project's own configuration, and an empty
    /// `--profile ""` is the same as naming none rather than an error about a
    /// profile called nothing.
    #[test]
    fn naming_no_profile_is_the_projects_own_configuration() {
        let root = project_with(BASE);
        for none in [None, Some(""), Some("   ")] {
            let cfg = load_agent_config_with_profile(&root, none).expect("base");
            #[cfg(feature = "cli")]
            assert_eq!(cfg.agent.model.as_deref(), Some("base/model"));
            assert_eq!(cfg.tools.default.as_deref(), Some("allow"));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// The pid keeps the path unique across concurrently-running test binaries
    /// (the `cli` and `tauri` feature configs both compile this module), which a
    /// per-process counter alone does not: a leftover root from one run makes
    /// `ensure_project` skip scaffolding in the next.
    fn unique_root(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let root = std::env::temp_dir().join(format!("jan_agent_test_{tag}_{pid}_{n}"));
        std::fs::create_dir_all(&root).expect("create test project root");
        root
    }

    /// `ensure_project` scaffolds `.jan/agent/{skills,memory}` by hand, while the
    /// toolset resolves those same directories through `workspace::project_store`.
    /// Nothing but this test ties the two together, and if they ever drift a
    /// user's existing skills and memories simply stop being found.
    #[test]
    fn scaffolded_dirs_match_the_toolset_store_layout() {
        use tauri_plugin_agent_tools::workspace;

        let root = unique_root("store_layout");
        ensure_project(&root).expect("scaffold project");

        let store = workspace::project_store(&root);
        assert_eq!(store, root.join(".jan").join("agent"));
        assert!(
            tauri_plugin_agent_tools::skills::skills_dir(&store).is_dir(),
            "skills dir the toolset reads is not the one ensure_project created"
        );
        assert!(
            workspace::store_dir(&store, "memory").is_dir(),
            "memory dir the toolset reads is not the one ensure_project created"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    fn write_agent_toml(root: &Path, body: &str) {
        let dir = root.join(".jan").join("agent");
        std::fs::create_dir_all(&dir).expect("create agent dir");
        std::fs::write(dir.join("agent.toml"), body).expect("write agent.toml");
    }

    #[test]
    fn run_settings_reads_allow_network_both_ways() {
        let root = unique_root("allow_net");
        write_agent_toml(&root, "[tools]\nallow_network = true\n");
        assert_eq!(run_settings(&root).allow_network, Some(true));

        write_agent_toml(&root, "[tools]\nallow_network = false\n");
        assert_eq!(run_settings(&root).allow_network, Some(false));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Unset must stay `None` rather than collapsing to `false`, or the caller
    /// cannot tell "explicitly denied" from "not configured" and every CLI
    /// project silently loses the network.
    #[test]
    fn run_settings_leaves_unset_allow_network_undecided() {
        let root = unique_root("allow_net_unset");

        write_agent_toml(&root, "[tools]\ndefault = \"read-only\"\n");
        assert_eq!(run_settings(&root).allow_network, None);

        // A project with no agent.toml at all resolves the same way.
        let bare = unique_root("allow_net_bare");
        assert_eq!(run_settings(&bare).allow_network, None);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
    }

    /// The scaffold documents the key, so it has to stay parseable as written.
    #[test]
    fn scaffold_template_parses_with_allow_network_documented() {
        let cfg: AgentToml = toml::from_str(AGENT_TOML_TEMPLATE).expect("scaffold template parses");
        assert_eq!(cfg.tools.allow_network, None);
        assert!(AGENT_TOML_TEMPLATE.contains("allow_network"));
    }

    #[test]
    fn ensure_errors_when_project_dir_missing() {
        // A mistyped --project (e.g. wrong case) must fail fast, not scaffold a
        // phantom project dir from nothing.
        let root = std::env::temp_dir().join(format!(
            "jan_agent_missing_{}",
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        assert!(!root.exists());
        let err = ensure_project(&root).expect_err("must reject missing dir");
        assert!(err.contains("does not exist"), "err: {err}");
        assert!(!root.exists(), "must not create the missing project dir");
    }

    /// The instructions file lives at the project root as `JAN.md` and is the
    /// user's (or `/init`'s) to create -- the scaffold must not plant an empty
    /// one under `.jan/agent/`, which nothing reads.
    #[test]
    fn ensure_does_not_scaffold_an_instructions_file() {
        let root = unique_root("no_instructions");
        let dir = ensure_project(&root).expect("ensure");
        assert!(!dir.join("AGENT.md").exists());
        assert!(!root.join("JAN.md").exists());
        assert!(!AGENT_TOML_TEMPLATE.contains("instructions_file"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_creates_artifacts_and_is_idempotent() {
        let root = unique_root("ensure");
        let dir = ensure_project(&root).expect("ensure");
        assert!(dir.join("agent.toml").exists());
        assert!(dir.join("skills").is_dir());
        assert!(dir.join("memory").is_dir());

        // Second call must not error and must preserve user edits.
        std::fs::write(dir.join("agent.toml"), "[tools]\ndefault = \"deny\"\n").unwrap();
        ensure_project(&root).expect("ensure again");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.tools.default.as_deref(), Some("deny"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_roundtrips_template() {
        let root = unique_root("roundtrip");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.tools.default.as_deref(), Some("read-only"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_missing_errors() {
        let root = unique_root("missing");
        assert!(load_agent_config(&root).is_err());
    }

    #[cfg(feature = "cli")]
    #[test]
    fn template_provider_section_absent_by_default() {
        let root = unique_root("provider_absent");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert!(cfg.provider.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn provider_section_parses_when_present() {
        let root = unique_root("provider_present");
        ensure_project(&root).expect("scaffold");
        let path = agent_toml_path(&root);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str(
            "\n[provider]\nname = \"openai\"\napi_key = \"sk-test\"\nmodels = [\"gpt-4o\"]\n",
        );
        std::fs::write(&path, raw).unwrap();

        let cfg = load_agent_config(&root).expect("load");
        let provider = cfg.provider.expect("provider section present");
        assert_eq!(provider.name, "openai");
        assert_eq!(provider.api_key.as_deref(), Some("sk-test"));
        assert_eq!(provider.models, vec!["gpt-4o".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn max_parallel_subagents_parses_and_defaults_to_none() {
        let root = unique_root("max_parallel");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(
            cfg.agent.max_parallel_subagents, None,
            "template leaves it unset"
        );

        // Explicit value round-trips through the /settings writer; unset removes.
        let path = agent_toml_path(&root);
        set_agent_key(
            &path,
            "max_parallel_subagents",
            Some(toml_edit::value(4i64)),
        )
        .expect("write");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.max_parallel_subagents, Some(4));
        set_agent_key(&path, "max_parallel_subagents", None).expect("unset");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.max_parallel_subagents, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn show_reasoning_parses_and_defaults_to_false() {
        let root = unique_root("show_reasoning");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.show_reasoning, None, "template leaves it unset");

        // Explicit value round-trips through the /settings writer; unset removes.
        let path = agent_toml_path(&root);
        set_agent_key(&path, "show_reasoning", Some(toml_edit::value(true))).expect("write");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.show_reasoning, Some(true));
        set_agent_key(&path, "show_reasoning", None).expect("unset");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.show_reasoning, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `send_reasoning` is unset in the template, which the callers read as the
    /// resend-by-default policy; an explicit false round-trips so a strict
    /// upstream can be opted out of it.
    #[cfg(feature = "cli")]
    #[test]
    fn send_reasoning_parses_and_round_trips() {
        let root = unique_root("send_reasoning");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.send_reasoning, None, "template leaves it unset");

        let path = agent_toml_path(&root);
        set_agent_key(&path, "send_reasoning", Some(toml_edit::value(false))).expect("write");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.send_reasoning, Some(false));
        set_agent_key(&path, "send_reasoning", None).expect("unset");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.send_reasoning, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn dotted_keys_write_and_remove_under_their_section() {
        let root = unique_root("dotted");
        ensure_project(&root).expect("scaffold");
        let path = agent_toml_path(&root);

        set_agent_key(&path, "budget.max_tokens", Some(toml_edit::value(60i64))).expect("write");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("max_tokens = 60"),
            "written under [budget]: {raw}"
        );

        set_agent_key(&path, "budget.max_tokens", None).expect("unset");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("max_tokens = 60"), "removed: {raw}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn full_template_parses() {
        let root = unique_root("full");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.tools.default.as_deref(), Some("read-only"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The scaffold leaves the key commented out, so a fresh project picks up
    /// `DEFAULT_MAX_SESSION_TOKENS` rather than a hardcoded template value.
    #[cfg(feature = "cli")]
    #[test]
    fn scaffold_template_leaves_session_budget_unset() {
        let cfg: AgentToml = toml::from_str(AGENT_TOML_TEMPLATE).expect("scaffold template parses");
        assert_eq!(cfg.budget.max_tokens, None);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn budget_max_tokens_parses_when_set() {
        let cfg: AgentToml = toml::from_str("[budget]\nmax_tokens = 200000\n").expect("parses");
        assert_eq!(cfg.budget.max_tokens, Some(200_000));
    }

    #[cfg(feature = "cli")]
    #[test]
    fn context_window_defaults_to_none_when_unset() {
        // The scaffolded template leaves context_window commented out, so the
        // parsed value is None and callers fall back to their default (128K).
        let root = unique_root("ctx_unset");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.context_window, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn context_window_parses_when_present() {
        let root = unique_root("ctx_present");
        ensure_project(&root).expect("scaffold");
        let path = agent_toml_path(&root);
        let raw = std::fs::read_to_string(&path).unwrap();
        // Prepend an explicit context_window under [agent].
        let raw = raw.replace("[agent]", "[agent]\ncontext_window = 32000");
        std::fs::write(&path, raw).unwrap();
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.context_window, Some(32000));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn compaction_reserve_tokens_defaults_to_none_when_unset() {
        let root = unique_root("reserve_unset");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.compaction_reserve_tokens, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn compaction_reserve_tokens_parses_when_present() {
        let root = unique_root("reserve_present");
        ensure_project(&root).expect("scaffold");
        let path = agent_toml_path(&root);
        let raw = std::fs::read_to_string(&path).unwrap();
        let raw = raw.replace("[agent]", "[agent]\ncompaction_reserve_tokens = 8192");
        std::fs::write(&path, raw).unwrap();
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.compaction_reserve_tokens, Some(8192));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn max_tokens_defaults_to_none_when_unset() {
        let root = unique_root("maxtok_unset");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.max_tokens, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(feature = "cli")]
    #[test]
    fn max_tokens_parses_when_present() {
        let root = unique_root("maxtok_present");
        ensure_project(&root).expect("scaffold");
        let path = agent_toml_path(&root);
        let raw = std::fs::read_to_string(&path).unwrap();
        let raw = raw.replace("[agent]", "[agent]\nmax_tokens = 4096");
        std::fs::write(&path, raw).unwrap();
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.max_tokens, Some(4096));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Jozkah/jan#226: the CLI reads the project's `[tools]` itself, and
    /// `ask`, `allow_domains` and `deny_domains` were dropped on the floor. An
    /// ask rule must still ask, and the domain lists -- capped by the machine
    /// policy -- must reach the run.
    #[test]
    fn ask_rules_and_domain_lists_reach_a_cli_run() {
        let root = unique_root("ask-domains");
        ensure_project(&root).expect("scaffold");
        std::fs::write(
            root.join(".jan/agent/agent.toml"),
            "[tools]\nallow = [\"bash\"]\nask = [\"bash(git push*)\"]\n\
             allow_domains = [\"docs.rs\"]\ndeny_domains = [\"pastebin.com\"]\n",
        )
        .unwrap();
        let cfg = load_agent_config(&root).expect("load");
        let org = tauri_plugin_agent_tools::org_policy::OrgPolicy::default();
        let perms = permissions_under(&cfg, &org);
        let push = [tauri_plugin_agent_tools::resource::Resource::command("git push origin main")];
        assert!(
            perms
                .asks_call("bash", &push, &tauri_plugin_agent_tools::subject::Subject::MainAgent)
                .is_some(),
            "the ask rule must ask"
        );
        let settings = run_settings_for(&root, None);
        assert_eq!(settings.allow_domains, vec!["docs.rs".to_string()]);
        assert!(settings.deny_domains.contains(&"pastebin.com".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn permissions_from_default_template_advertises_mcp() {
        // The scaffolded read-only default must still advertise MCP tools.
        let root = unique_root("perms");
        ensure_project(&root).expect("scaffold");
        let cfg = load_agent_config(&root).expect("load");
        let perms = permissions_from(&cfg);
        assert!(perms.advertises_mcp("mcp.search", &tauri_plugin_agent_tools::subject::Subject::MainAgent));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn permissions_from_deny_default_blocks_mcp() {
        let mut cfg = AgentToml::default();
        cfg.tools.default = Some("deny".to_string());
        let perms = permissions_from(&cfg);
        assert!(!perms.advertises_mcp("mcp.search", &tauri_plugin_agent_tools::subject::Subject::MainAgent));

        cfg.tools.allow = vec!["mcp.search".to_string()];
        let perms = permissions_from(&cfg);
        assert!(perms.advertises_mcp("mcp.search", &tauri_plugin_agent_tools::subject::Subject::MainAgent));
    }

    #[cfg(feature = "cli")]
    #[test]
    fn set_model_persists_and_reloads_and_keeps_comments() {
        let root = unique_root("setmodel");
        ensure_project(&root).expect("scaffold");
        let path = agent_toml_path(&root);

        set_model_in_agent_toml(&path, "claude-sonnet-5").expect("set");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.model.as_deref(), Some("claude-sonnet-5"));

        // Overwrites on a second set; template comment survives.
        set_model_in_agent_toml(&path, "gpt-4o").expect("set again");
        let cfg = load_agent_config(&root).expect("load");
        assert_eq!(cfg.agent.model.as_deref(), Some("gpt-4o"));
        let raw = std::fs::read_to_string(&path).expect("read");
        assert!(raw.contains("read-only | deny | allow"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
