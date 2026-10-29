//! Slash commands and the screens they open: the command catalog, every
//! `/command` handler, the settings, MCP, provider and login prompts, pickers
//! and thread resume. Moved verbatim out of `tui.rs`.

use super::*;

/// `/bug`: show what a diagnostic bundle for this session would hold;
/// `/bug show <member>` prints one member's redacted content; `/bug save`
/// writes exactly the bundle last shown. Local only: nothing is uploaded, and
/// writing the file is the last thing it does. Needs no model, so it works
/// even when the bug being reported froze the session.
pub(super) fn bug_report_command(app: &mut App, arg: &str) {
    let arg = arg.trim();
    if arg == "save" {
        let Some(preview) = app.pending_bug_report.take() else {
            app.note("nothing to save yet: run /bug to preview the bundle first");
            return;
        };
        match preview.save() {
            Ok(path) => app.note(&format!("bug report saved: {}", path.display())),
            Err(e) => {
                app.note(&format!("bug report not saved: {e}"));
                app.pending_bug_report = Some(preview);
            }
        }
        return;
    }
    if let Some(member) = arg.strip_prefix("show") {
        let member = member.trim();
        let Some(preview) = app.pending_bug_report.as_ref() else {
            app.note("run /bug first to prepare the bundle");
            return;
        };
        match preview.member(member) {
            Some(content) => {
                let lines: Vec<String> = content.lines().map(str::to_string).collect();
                let shown = lines.len().min(200);
                app.note(&format!("{member} ({} lines):", lines.len()));
                for line in &lines[lines.len() - shown..] {
                    app.system_detail_text(line);
                }
            }
            None => {
                let names: Vec<&str> = preview.members.iter().map(|(n, _)| n.as_str()).collect();
                app.note(&format!("no member '{member}'; members: {}", names.join(", ")));
            }
        }
        return;
    }
    let data_folder = crate::core::app::commands::resolve_jan_data_folder();
    let threads_base = app.agent_dir.clone();
    let thread_id = app.thread_id.clone();
    match super::super::doctor::prepare(&threads_base, &data_folder, thread_id.as_deref(), None) {
        Ok(preview) => {
            for line in preview.summary() {
                app.system_detail_text(&line);
            }
            app.note("/bug show <member> to read one, /bug save to write it");
            app.pending_bug_report = Some(preview);
        }
        Err(e) => app.note(&format!("bug report failed: {e}")),
    }
}

/// A slash command's name, argument hint, and description. Single source of
/// truth shared by the hint popup and the `/help` listing so they never drift
/// as commands are added or removed.
pub(super) struct SlashCommand {
    /// Includes the leading slash, e.g. `/resume`.
    pub(super) name: &'static str,
    /// Argument hint (`[id]`) or empty when the command takes none.
    pub(super) hint: &'static str,
    pub(super) description: &'static str,
    /// Name of the canonical command this row is an alias of; `None` for the
    /// command itself. `/think` and `/reasoning` alias `/effort`, so all three
    /// share one dispatch and one session-scoped effort state.
    pub(super) alias_of: Option<&'static str>,
}

/// Slash popup metadata is intentionally loaded outside the render path.
/// Plugin installation and removal explicitly refresh this snapshot.
pub(super) struct SlashCatalog {
    pub(super) commands: Vec<crate::core::agent::plugin_commands::CommandEntry>,
    pub(super) skills: Vec<crate::core::agent::skills::SkillMeta>,
}

impl SlashCatalog {
    pub(super) fn load(root: &std::path::Path) -> Self {
        Self {
            commands: crate::core::agent::plugin_commands::catalog(root, &[]),
            // Keep every user-invocable skill here. The enabled whitelist is
            // re-read below so edits to agent.toml take effect immediately.
            skills: crate::core::agent::skills::user_catalog(root, &[]),
        }
    }

    pub(super) fn command_enabled(
        command: &crate::core::agent::plugin_commands::CommandEntry,
        enabled: &[String],
    ) -> bool {
        enabled.is_empty()
            || enabled.iter().any(|entry| {
                entry == &command.plugin
                    || entry == &command.name
                    || entry == &format!("{}:{}", command.plugin, command.name)
            })
    }

    pub(super) fn skill_enabled(meta: &crate::core::agent::skills::SkillMeta, enabled: &[String]) -> bool {
        if enabled.is_empty() {
            return true;
        }
        let plain = meta
            .name
            .rsplit_once(':')
            .map(|(_, name)| name)
            .unwrap_or(&meta.name);
        enabled.iter().any(|entry| {
            entry == &meta.name
                || entry == plain
                || meta.plugin.as_ref().is_some_and(|plugin| entry == plugin)
        })
    }
}

/// One row of the slash-command popup: a built-in command, an installed
/// plugin command (`<plugin>/commands/<name>.md`), or an installed project
/// skill (`.jan/agent/skills/<name>/SKILL.md`) offered by name so `/deploy`
/// behaves like a command the user can tab-complete and run.
#[derive(Clone)]
pub(super) enum SlashMatch {
    Command(&'static SlashCommand),
    /// A plugin command prompt template. `name` is the full invocation
    /// (`/feature-dev` short form or `/command:<plugin>:<name>` explicit);
    /// `hints` are the placeholders the template accepts (`$ARGUMENTS`, `$1`).
    PluginCommand {
        name: String,
        description: String,
        hints: Vec<String>,
    },
    Skill {
        name: String,
        description: String,
    },
}

impl SlashMatch {
    /// Full invocation name including the leading slash.
    pub(super) fn name(&self) -> &str {
        match self {
            SlashMatch::Command(c) => c.name,
            SlashMatch::PluginCommand { name, .. } => name,
            SlashMatch::Skill { name, .. } => name,
        }
    }
}

/// Lowercased, slash-stripped query characters used to match slash popup
/// rows. Matching is deliberately fuzzy so typos and partial names surface
/// the right command/skill: a subsequence match ranks by how tightly it hugs
/// the front of the name (prefix first, then contiguous runs, then sparse),
/// and a near-miss within a small edit distance still shows up below real
/// matches instead of vanishing.
pub(super) fn slash_match_score(query: &[char], name: &str) -> Option<u32> {
    if query.is_empty() {
        return Some(u32::MAX);
    }
    let stripped = name.trim_start_matches('/');
    // Match against the full display name (`/command:plugin:name` or
    // `/my-skill`), its last `:`-segment, and its last `-`-segment. This way a
    // user typing the memorable tail of a longer name still lines up: e.g.
    // `simplifyer` finds the `simplifier` in `/code-simplifier`.
    let mut parts: Vec<String> = Vec::with_capacity(3);
    parts.push(stripped.to_lowercase());
    if let Some((_, last)) = stripped.rsplit_once(':') {
        let last = last.to_lowercase();
        if !last.is_empty() && !parts.contains(&last) {
            parts.push(last);
        }
    }
    if let Some((_, last)) = stripped.rsplit_once('-') {
        let last = last.to_lowercase();
        if !last.is_empty() && !parts.contains(&last) {
            parts.push(last);
        }
    }

    // A barely-started buffer (1-2 chars) matches as a prefix only, mirroring
    // the old strict-prefix behaviour so it stays tight instead of surfacing
    // every command that merely contains those two letters.
    if query.len() < 3 {
        let prefix: String = query.iter().collect();
        return parts.iter().any(|p| p.starts_with(&prefix)).then_some(100);
    }

    // Subsequence match, scored by how tightly it hugs the front of the name.
    let mut best: Option<u32> = None;
    for part in &parts {
        let chars: Vec<char> = part.chars().collect();
        if let Some(s) = subseq_score(query, &chars) {
            best = Some(best.map_or(s, |b| b.max(s)));
        }
    }
    if let Some(b) = best {
        return Some(b);
    }

    // No subsequence hit: for a longer query, still accept a close typo (e.g.
    // `simplifyer` for `simplifier`), but rank it below every real subsequence
    // match and scale the tolerance with query length so it stays a fallback,
    // never a noise source for short input.
    if query.len() >= 4 {
        let max_edits = 2.min(query.len() / 4 + 1);
        if parts
            .iter()
            .any(|p| edit_distance(query, &p.chars().collect::<Vec<char>>()) <= max_edits)
        {
            return Some(1);
        }
    }
    None
}

/// Score how well `query` appears as a subsequence of `hay`, higher is
/// better. Every start position is tried (not just the greedy one) so a
/// transposed/typo'd query like `/rse` can find the `/resume` run starting at
/// index 1 rather than only a sparse index-0 solution. Prefix and contiguous
/// matches score highest; every contribution stays positive so any
/// subsequence beats no match.
pub(super) fn subseq_score(query: &[char], hay: &[char]) -> Option<u32> {
    if query.is_empty() {
        return Some(0);
    }
    let mut best: Option<u32> = None;
    for start in 0..hay.len() {
        let mut total: u32 = 0;
        let mut qi = 0usize;
        let mut prev: Option<usize> = None;
        let mut hi = start;
        while qi < query.len() && hi < hay.len() {
            if hay[hi] != query[qi] {
                hi += 1;
                continue;
            }
            let gap = hi.saturating_sub(prev.unwrap_or(start.saturating_sub(1)));
            total += if hi == 0 {
                100
            } else if gap <= 1 {
                20
            } else {
                20u32.saturating_sub((gap as u32) * 3).max(1)
            };
            prev = Some(hi);
            qi += 1;
            hi += 1;
        }
        if qi == query.len() {
            best = Some(best.map_or(total, |b| b.max(total)));
        }
    }
    best
}

/// Classic Levenshtein edit distance, used as a typo fallback so a slightly
/// misspelled query still matches a command/skill name.
pub(super) fn edit_distance(a: &[char], b: &[char]) -> usize {
    if b.is_empty() {
        return a.len();
    }
    if a.is_empty() {
        return b.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![0usize; b.len() + 1];
        cur[0] = i;
        for j in 1..=b.len() {
            cur[j] = if a[i - 1] == b[j - 1] {
                prev[j - 1]
            } else {
                1 + prev[j - 1].min(prev[j]).min(cur[j - 1])
            };
        }
        prev = cur;
    }
    prev[b.len()]
}

pub(super) const SLASH_COMMANDS: &[SlashCommand] = &[
    SlashCommand {
        name: "/help",
        hint: "",
        description: "Show available commands",
        alias_of: None,
    },
    SlashCommand {
        name: "/new",
        hint: "",
        description: "Start a new session",
        alias_of: None,
    },
    SlashCommand {
        name: "/clear",
        hint: "",
        description: "Clear the conversation",
        alias_of: None,
    },
    SlashCommand {
        name: "/export",
        hint: "[--force] [markdown|obsidian|json] [path]",
        description: "Write this conversation to a file",
        alias_of: None,
    },
    SlashCommand {
        name: "/schedule",
        hint: "[list|run|enable|disable] [id]",
        description: "List scheduled tasks, or run, enable or disable one",
        alias_of: None,
    },
    SlashCommand {
        name: "/mode",
        hint: "[review|ask|auto|bypass]",
        description: "Show or set how freely the agent acts",
        alias_of: None,
    },
    SlashCommand {
        name: "/init",
        hint: "",
        description: "Study the project, then write JAN.md, skills, and memory",
        alias_of: None,
    },
    SlashCommand {
        name: "/compact",
        hint: "[focus]",
        description: "Summarize older turns to free up context",
        alias_of: None,
    },
    SlashCommand {
        name: "/btw",
        hint: "<question>",
        description: "Ask a side question about this thread; answered without tools, never added to history",
        alias_of: None,
    },
    SlashCommand {
        name: "/hooks",
        hint: "",
        description: "List configured hooks, their source and trust state (read-only)",
        alias_of: None,
    },
    SlashCommand {
        name: "/context",
        hint: "",
        description: "Show what is filling the context window, by category",
        alias_of: None,
    },
    SlashCommand {
        name: "/usage",
        hint: "[account|daily|requests|limits|run|<execution-id>]",
        description: "Show recorded Tokamak usage and spend",
        alias_of: None,
    },
    SlashCommand {
        name: "/goal",
        hint: "[condition|clear]",
        description: "Keep working until a condition is met (bare: status)",
        alias_of: None,
    },
    SlashCommand {
        name: "/plan",
        hint: "[exit|text]",
        description: "Enter read-only plan mode, optionally seeding it with a message; /plan exit to leave",
        alias_of: None,
    },
    SlashCommand {
        name: "/todo",
        hint: "[add [phase|] text | clear]",
        description: "Open the todo editor (bare), /todo add ... to append, /todo clear to drop all",
        alias_of: None,
    },
    SlashCommand {
        name: "/threads",
        hint: "",
        description: "List saved threads for this project",
        alias_of: None,
    },
    SlashCommand {
        name: "/resume",
        hint: "[id]",
        description: "Resume a thread (bare: pick interactively)",
        alias_of: None,
    },
    SlashCommand {
        name: "/fork",
        hint: "",
        description: "Branch this session at a past message into a new thread, keeping this one",
        alias_of: None,
    },
    SlashCommand {
        name: "/worktree",
        hint: "",
        description: "Show the dedicated checkout this session works in, and what changed there",
        alias_of: None,
    },
    SlashCommand {
        name: "/tree",
        hint: "",
        description: "Show saved threads as a fork tree (bare /threads is the flat list)",
        alias_of: None,
    },
    SlashCommand {
        name: "/model",
        hint: "[id]",
        description: "Switch model (bare: pick interactively)",
        alias_of: None,
    },
    SlashCommand {
        name: "/effort",
        hint: "[low|medium|high]",
        description: "Set reasoning effort (bare: show current; low: faster, high: deeper thinking)",
        alias_of: None,
    },
    SlashCommand {
        name: "/think",
        hint: "[low|medium|high]",
        description: "Alias of /effort: set reasoning effort (bare: show current)",
        alias_of: Some("/effort"),
    },
    SlashCommand {
        name: "/reasoning",
        hint: "[low|medium|high]",
        description: "Alias of /effort: set reasoning effort (bare: show current)",
        alias_of: Some("/effort"),
    },
    SlashCommand {
        name: "/terminal-setup",
        hint: "",
        description: "Configure this terminal so Shift+Enter inserts a newline",
        alias_of: None,
    },
    SlashCommand {
        name: "/mcp",
        hint: "",
        description: "List, add, edit, remove, or toggle MCP servers",
        alias_of: None,
    },
    SlashCommand {
        name: "/reload",
        hint: "",
        description: "Re-read provider config, skills, plugin commands and MCP servers",
        alias_of: None,
    },
    SlashCommand {
        name: "/agents",
        hint: "",
        description: "Inspect running subagents: their stats and current activity",
        alias_of: None,
    },
    SlashCommand {
        name: "/shells",
        hint: "",
        description: "Inspect background shell commands still running",
        alias_of: None,
    },
    SlashCommand {
        name: "/jobs",
        hint: "",
        description: "Alias of /shells: inspect background shell commands",
        alias_of: Some("/shells"),
    },
    SlashCommand {
        name: "/plugin",
        hint: "[list|install <spec>|remove <name>|search [query]]",
        description: "Manage plugins: install from a git URL or the marketplace, list/remove installed, search the marketplace",
        alias_of: None,
    },
    SlashCommand {
        name: "/cancel",
        hint: "[N]",
        description: "Cancel pending messages (bare: all, or index)",
        alias_of: None,
    },
    SlashCommand {
        name: "/login",
        hint: "[--paste-token]",
        description: "Sign in to a provider",
        alias_of: None,
    },
    SlashCommand {
        name: "/logout",
        hint: "<provider>",
        description: "Remove a saved provider credential and configuration",
        alias_of: None,
    },
    SlashCommand {
        name: "/config",
        hint: "",
        description: "View provider config (~/.jan/config.toml)",
        alias_of: None,
    },
    SlashCommand {
        name: "/settings",
        hint: "[max_parallel_subagents N]",
        description: "Edit agent.toml and ~/.jan settings (menu); most apply next run",
        alias_of: None,
    },
    SlashCommand {
        name: "/bug",
        hint: "[save | show <member>]",
        description: "Preview a redacted local diagnostic bundle; /bug save writes it",
        alias_of: None,
    },
    SlashCommand {
        name: "/quit",
        hint: "",
        description: "Exit the TUI",
        alias_of: None,
    },
];

pub(super) const KEY_BINDINGS: &[(&str, &str)] = &[
    ("Enter", "Send the message"),
    (
        "Alt+Enter / Ctrl-J",
        "Insert a newline (Shift+Enter where reported)",
    ),
    ("Ctrl-A/E, Alt+B/F", "Start/end of line, word left/right"),
    ("Ctrl-W, Alt+Backspace", "Delete the word before the caret"),
    ("Ctrl-U / Ctrl-K", "Delete to the start / end of the line"),
    (
        "Esc / Ctrl-C",
        "Cancel the running turn, or clear the input",
    ),
    ("Esc Esc", "Rewind to an earlier message"),
    (
        "↑/↓",
        "Recall sent messages and drafts (scrolls while typing)",
    ),
    ("PgUp/PgDn", "Scroll the transcript"),
    ("Ctrl-O", "Expand or collapse all tool calls"),
    ("Ctrl-V", "Paste an image from the clipboard"),
    ("Ctrl-L", "Redraw the screen (repairs a broadcast over it)"),
    ("Shift+Tab", "Cycle reasoning effort (low/medium/high)"),
    ("Alt+T", "Toggle reasoning effort (low / last)"),
    (
        "Drag",
        "Select text, copied on release (Alt+drag for a block)",
    ),
    ("Ctrl-C/Ctrl-D twice", "Quit"),
];

/// Split a command line into `(name, arg)`, UTF-8 safe (no byte slicing).
pub(super) fn parse_command(line: &str) -> (&str, &str) {
    match line.trim().split_once(char::is_whitespace) {
        Some((n, rest)) => (n, rest.trim()),
        None => (line.trim(), ""),
    }
}

/// Execute a `/command` typed into the input box. Runs only while idle.
pub(super) async fn run_command(
    app: &mut App,
    line: &str,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    let (name, arg) = parse_command(line);
    match name {
        "" | "help" | "?" => {
            app.note("commands:");
            for c in SLASH_COMMANDS {
                let sig = if c.hint.is_empty() {
                    c.name.to_string()
                } else {
                    format!("{} {}", c.name, c.hint)
                };
                let desc = match c.alias_of {
                    Some(canonical) => {
                        format!("alias of {canonical}; {}", c.description)
                    }
                    None => c.description.to_string(),
                };
                app.system_detail_text(&format!("{sig:18} {desc}"));
            }
            app.note("keys:");
            for (keys, description) in KEY_BINDINGS {
                app.system_detail_text(&format!("{keys:18} {description}"));
            }
        }
        // The running turn would bring the old conversation back when it ends.
        "clear" | "new" if app.status != Status::Idle => {
            app.note("a turn is running; press Esc to stop it first");
        }
        "clear" => {
            app.reset_session();
            clear_todos(app).await;
            app.push_session_banner(true);
            app.note("conversation cleared");
        }
        "new" => {
            app.reset_session();
            clear_todos(app).await;
            app.push_session_banner(true);
            app.note("started a new session");
        }
        "compact" => compact_command(app, arg),
        "context" => context_command(app),
        "hooks" => hooks_command(app),
        "btw" => btw_command(app, arg),
        "usage" => usage_command(app, arg),
        "threads" | "list" => match super::super::list_threads_in(&app.agent_dir) {
            Ok(threads) if threads.is_empty() => {
                app.note("no saved threads found");
            }
            Ok(mut threads) => {
                sort_threads_recent(&mut threads);
                let base = app.agent_dir.clone();
                app.note(&format!("{} saved thread(s):", threads.len()));
                for t in &threads {
                    let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                    let title =
                        thread_display_name(&base, id, t.get("title").and_then(|v| v.as_str()));
                    let short: String = id.chars().take(8).collect();
                    app.system_detail(vec![
                        Span::styled(format!("{short}  "), Style::new().cyan()),
                        Span::raw(title),
                    ]);
                }
                app.system_detail_text("resume with /resume");
            }
            Err(e) => app.note(&format!("failed to list threads: {e}")),
        },
        "fork" => open_fork_picker(app),
        "worktree" => worktree_command(app),
        "tree" => open_tree_picker(app),
        "resume" => {
            if arg.is_empty() {
                open_thread_picker(app);
            } else {
                resume_thread(app, arg).await;
            }
        }
        "model" => {
            if arg.is_empty() {
                open_model_picker(app).await;
            } else {
                app.set_model(arg.to_string());
            }
        }
        "mcp" => open_mcp_picker(app, mcp_servers).await,
        "reload" => reload_command(app, mcp_servers).await,
        "agents" => open_agents_picker(app),
        "shells" | "jobs" => open_background_shells_picker(app),
        "plugin" => plugin_command(app, arg).await,
        "login" => login_command(app, arg),
        "logout" => logout_command(app, arg),
        "config" => open_config_screen(app),
        "terminal-setup" => terminal_setup_command(app),
        "settings" => settings_command(app, arg),
        "goal" => goal_command(app, arg),
        "init" => init_command(app),
        "plan" => plan_command(app, arg),
        "mode" => mode_command(app, arg),
        "export" => export_command(app, arg),
        "schedule" => schedule_command(app, arg),
        "effort" | "think" | "reasoning" => effort_command(app, arg),
        "todo" => todo_command(app, arg).await,
        "cancel" => cancel_command(app, arg),
        "bug" => bug_report_command(app, arg),
        "quit" | "exit" => app.should_quit = true,
        other => {
            // A `/name` that isn't a built-in is a plugin command or an
            // installed project skill. Precedence: plugin command first,
            // then skill. `/command:<plugin>:<name>` is the explicit command
            // form (never collides); `/skill:<name>` the explicit skill form;
            // plain `/name` falls through in that order, with args threaded
            // into the prompt template / skill message. Unknown names note.
            if let Some(command) = other.strip_prefix("command:") {
                if app.dispatch_command(command, arg) {
                    return;
                }
                app.note(&format!("unknown command '/{other}' (try /help)"));
                return;
            }
            if app.dispatch_command(other, arg) {
                return;
            }
            let (skill_name, skill_args) = match other.split_once(':') {
                Some(("skill", name)) => (name, arg),
                _ => (other, arg),
            };
            if app.dispatch_skill(skill_name, skill_args) {
                return;
            }
            app.note(&format!("unknown command '/{other}' (try /help)"));
        }
    }
}

/// Open the `/context` overlay: what currently fills the window, by category.
/// Read-only -- it inspects the live session state and the same prompt/tool
/// builders a turn would use, and sends nothing to the provider.
///
/// The report is *not* computed here. Sizing the tool segment takes the MCP
/// server lock, which a turn executing an MCP tool call holds for up to the
/// tool-call timeout; computing it inline on the key-handling path would
/// freeze the whole UI. So this only sets the overlay to its loading state and
/// raises a flag the loop picks up, which computes the report on its own task
/// and fills the overlay in when it lands. Unlike the old idle-only transcript
/// row, the readout is a popup the user closes with Esc, so it stays available
/// mid-turn without ever blocking the render loop.
/// `/usage [view]`: what the provider recorded (upstream #9034).
///
/// These are the provider's own figures, fetched off the render loop. Bare
/// `/usage` is the account summary and also names the last execution id this
/// session reported, so a single request's charge is one lookup away. `run`
/// correlates every execution this session produced through the
/// `X-Client-Request-Id` the agent sends.
pub(super) fn usage_command(app: &mut App, arg: &str) {
    use crate::core::cli::tokamak::usage::Query;
    if crate::core::cli::tokamak::stored_api_key().is_none() {
        app.note("usage: not signed in to Tokamak -- run /login first");
        return;
    }
    let query = match arg.trim() {
        "" | "account" => {
            if let Some(id) = app.last_execution_id.as_deref() {
                app.note(&format!(
                    "last execution id: {id} (/usage {id} shows what it was charged)"
                ));
            }
            Query::Summary
        }
        "daily" => Query::Daily,
        "requests" => Query::Requests,
        "limits" => Query::Limits,
        "run" => {
            let session = app.args.as_ref().and_then(|a| a.session_id.clone());
            match crate::core::agent::correlation::session_request_id(session.as_deref()) {
                Some(id) => Query::Correlated(id),
                None => {
                    app.note("usage: this session has no id to correlate yet");
                    return;
                }
            }
        }
        id => Query::Generation(id.to_string()),
    };
    app.note(&format!("usage: asking Tokamak for {}...", query.label()));
    app.usage_request = Some(query);
}

/// `/btw <question>`: one tool-less completion over a snapshot of the thread.
/// Runs off the render loop and works mid-run; the answer is shown as a note
/// and never reaches `history`.
pub(super) fn btw_command(app: &mut App, question: &str) {
    let question = question.trim().to_string();
    if question.is_empty() {
        app.note("usage: /btw <question>");
        return;
    }
    let Some(args) = app.args.clone() else {
        app.note("/btw unavailable (no active session)");
        return;
    };
    app.note(&format!("◈ btw · {question}"));
    let model = app.model.clone();
    let history = app.history.clone();
    let tx = app.btw_tx.clone();
    tokio::spawn(async move {
        let text = match crate::core::agent::btw::ask(&args, &model, &history, &question).await {
            Ok(answer) => answer,
            Err(e) => format!("btw failed: {e}"),
        };
        let _ = tx.send(text);
    });
}

/// `/hooks`: read-only list of the project's hooks and the Claude Code hooks
/// imported from `~/.claude`.
pub(super) fn hooks_command(app: &mut App) {
    let mut text = tauri_plugin_agent_tools::hooks::report(&app.project_root).render();
    let imported = crate::core::agent::cc_hooks::active();
    if !imported.is_empty() {
        text.push_str("
imported from ~/.claude (add context on prompt/session start):");
        for h in &imported {
            text.push_str(&format!("
  {:?} {}s  {}", h.event, h.timeout_secs, h.command));
        }
    }
    app.note(&text);
}

pub(super) fn context_command(app: &mut App) {
    app.context_view = Some(ContextView::Loading);
    app.context_request = true;
}

/// The `/init` prompt. Onboarding a project means producing the three things a
/// later session reads back: the root `JAN.md` (ingested as project context),
/// skills for repeatable workflows, and memory for durable facts. Phrased as a
/// task for the model rather than executed here -- only the model can read the
/// project and judge what is worth writing down.
pub(super) const INIT_PROMPT: &str = "Onboard yourself to this project so future sessions start informed.\n\n\
1. Study the project first. Read the README and any contributor docs, map the directory layout, and \
find the real build, test, lint, and type-check commands (from the manifests and CI config, not from \
guesswork). Note the conventions the code actually follows.\n\n\
2. Write `JAN.md` in the project root. It is the only instructions file loaded into your system \
prompt, and it is loaded every session, so it must earn its tokens: the commands to build/test/lint, \
the architecture a newcomer cannot infer from the tree, and the conventions worth enforcing. Skip \
anything obvious from a directory listing, and do not pad it. If `JAN.md` already exists, read it and \
correct what has drifted instead of rewriting it wholesale.\n\n\
3. Write skills with `skill_write` for the project's repeatable procedures -- releasing, running \
migrations, adding a module, debugging a subsystem -- one skill per procedure, only where a real \
multi-step recipe exists. Do not invent skills to fill space.\n\n\
4. Record durable project facts with `memory_write`: decisions, constraints, and gotchas that are \
true beyond this session and not already stated in the code.\n\n\
Then report what you wrote and why, briefly.";

/// `/init`: hand the model the onboarding task as a user turn, so it runs with
/// the normal toolset, permission gate, and transcript. The prompt body itself
/// is hidden -- the note below is what the user asked for, the canned text is
/// not. Idle-only, like the other commands that start a turn -- queueing it
/// behind a running turn would have it survey a project mid-change.
pub(super) fn init_command(app: &mut App) {
    if app.status != Status::Idle {
        app.note("/init is only available while idle");
        return;
    }
    let existing = crate::core::agent::context::has_context_file(&app.project_root);
    app.note(if existing {
        "◈ init · reviewing JAN.md, skills, and memory for this project"
    } else {
        "◈ init · studying the project to write JAN.md, skills, and memory"
    });
    app.submit_user_hidden(INIT_PROMPT.to_string());
}

/// Manually compact the conversation: summarize older turns, keeping the recent
/// tail, then persist. Blocks the event loop for one model call; runs only while
/// idle (the caller gates on `Status::Idle`).
pub(super) fn compact_command(app: &mut App, focus: &str) {
    if app.compacting.is_some() {
        app.note("already compacting");
        return;
    }
    if app.args.is_none() {
        app.note("compaction unavailable (no active session)");
        return;
    }
    let focus = focus.trim();
    app.compact_focus = (!focus.is_empty()).then(|| focus.to_string());
    app.compact_request = Some(CompactKind::Manual);
}

/// Compact-and-retry attempts allowed per user turn. The loop already retries
/// within a single request (`MAX_COMPACTION_ATTEMPTS`); this bounds the outer
/// recovery so a model that overflows at any size still hands control back.
pub(super) const MAX_OVERFLOW_RETRIES: u8 = 2;

/// Which path asked for a compaction: `/compact` keeps a shorter tail than the
/// automatic one and reports itself differently.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum CompactKind {
    Manual,
    Auto,
}

impl CompactKind {
    pub(super) fn keep_recent(self, auto_keep: usize) -> usize {
        match self {
            CompactKind::Manual => crate::core::agent::compaction::MANUAL_KEEP_RECENT,
            // AH-076: the automatic tail is the shared policy's.
            CompactKind::Auto => auto_keep,
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            CompactKind::Manual => "compacting",
            CompactKind::Auto => "auto-compacting",
        }
    }

    pub(super) fn done_label(self) -> &'static str {
        match self {
            CompactKind::Manual => "compacted",
            CompactKind::Auto => "auto-compacted",
        }
    }
}

/// Await an in-flight compaction, parking forever when none is running so this
/// can sit in the loop's `select!` unconditionally.
/// A goal evaluation running off the render loop: the goal it judged and the
/// verdict.
pub(super) type GoalEvalTask = tokio::task::JoinHandle<(
    crate::core::agent::goal::GoalState,
    Result<
        crate::core::agent::goal::GoalVerdict,
        tauri_plugin_agent_tools::harness_error::HarnessError,
    >,
)>;

pub(super) async fn await_goal_eval(
    task: &mut Option<GoalEvalTask>,
) -> Option<(
    crate::core::agent::goal::GoalState,
    Result<
        crate::core::agent::goal::GoalVerdict,
        tauri_plugin_agent_tools::harness_error::HarnessError,
    >,
)> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.ok()
}

pub(super) async fn await_compaction(
    task: &mut Option<tokio::task::JoinHandle<Result<Vec<serde_json::Value>, tauri_plugin_agent_tools::harness_error::HarnessError>>>,
) -> Result<Vec<serde_json::Value>, tauri_plugin_agent_tools::harness_error::HarnessError> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    match joined {
        Ok(inner) => inner,
        Err(e) => Err(tauri_plugin_agent_tools::harness_error::HarnessError::internal(format!("compaction task failed: {e}"))),
    }
}

/// Apply a finished compaction. `base_len` is the history length the summary was
/// computed from: anything appended since (a message submitted while the call was
/// in flight) is carried over rather than dropped.
pub(super) fn finish_compaction(
    app: &mut App,
    result: Result<Vec<serde_json::Value>, tauri_plugin_agent_tools::harness_error::HarnessError>,
    base_len: usize,
) {
    let kind = app.compacting.take().unwrap_or(CompactKind::Manual);
    app.compact_started = None;
    let retrying = std::mem::take(&mut app.retry_after_compact);
    match result {
        Ok(mut compacted) if compacted.len() < base_len => {
            compacted.extend(app.history.split_off(base_len.min(app.history.len())));
            app.history = compacted;
            app.persist();
            // Estimate tokens from compacted message content (~4 chars ≈ 1 token).
            // The provider's last `usage` measured the pre-compaction history, so
            // it no longer describes this conversation.
            app.tokens = estimate_token_count(&app.history);
            app.invalidate_token_provenance();
            app.note(&format!(
                "{} {base_len} -> {} messages (ctx {}K/{}K)",
                kind.done_label(),
                app.history.len(),
                app.tokens / 1000,
                app.context_window / 1000,
            ));
            // The turn this compaction was queued for died on an overflow
            // error: resume it now that the history it failed on is smaller.
            if retrying {
                app.begin_turn();
                app.want_start = true;
            }
        }
        Ok(_) => {
            if kind == CompactKind::Manual {
                app.note("nothing to compact yet");
            }
            // Nothing shrank, so the retry would re-send the request that
            // already overflowed. Hand control back instead.
            if retrying {
                app.note("nothing left to compact: the turn cannot be retried");
                app.halt_turn();
            }
        }
        Err(e) => {
            // The words, not the classification: the kind drives what happens
            // next (below), and repeating it here only reads as noise.
            app.note(&format!("{} failed: {}", kind.label(), e.message()));
            // A target-model compaction (model switch) that itself overflows
            // must block the oversized ordinary request: history stays
            // untouched, the target model stays selected, and the turn is
            // halted rather than retried on the same oversized history.
            // `halt_turn` folds any in-flight tools and dequeues, but does not
            // disarm a queued `want_start`, so a gated ordinary request is
            // explicitly deferred too -- otherwise the loop would re-send the
            // oversized history the moment the compaction task clears.
            // AH-009: the kind says what happened; the TUI does not read the
            // wording to decide whether the history may be reused.
            let overflow =
                e.kind() == tauri_plugin_agent_tools::harness_error::ErrorKind::ContextOverflow;
            if retrying || overflow {
                app.halt_turn();
            }
            if overflow {
                app.want_start = false;
            }
        }
    }
}

/// `/goal` dispatcher: `clear` removes an active goal, a bare command shows
/// status, and any other argument sets a new goal and starts a turn toward it.
/// Runs only while idle (the caller gates on `Status::Idle`).
pub(super) fn goal_command(app: &mut App, arg: &str) {
    let arg = arg.trim();
    match arg {
        "clear" => {
            if app.goal.take().is_some() {
                app.goal_eval_pending = false;
                app.persist();
                app.note("goal cleared");
            } else {
                app.note("no active goal");
            }
        }
        "" => show_goal_status(app),
        condition => set_goal(app, condition),
    }
}

/// One editable key surfaced by `/settings`. Mirrors the templates' knobs;
/// defaults match `load_agent_config` for project keys and the
/// `global_config` accessors for user-wide ones. `model` is deliberately
/// absent: it has its own `/model` picker.
pub(super) struct AgentSettingDef {
    pub(super) key: &'static str,
    pub(super) label: &'static str,
    pub(super) desc: &'static str,
    pub(super) kind: AgentSettingKind,
    pub(super) scope: SettingScope,
}

/// Which file a `/settings` row reads and writes. Both are surfaced by the one
/// menu because the distinction is an implementation detail to the person
/// looking for a knob: they want the setting, not the file it lives in.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SettingScope {
    /// This project's `.jan/agent/agent.toml`, under `[agent]` unless the key
    /// names its own section.
    Project,
    /// The user-wide `~/.jan/config.toml`, at the document root.
    Global,
}

pub(super) enum AgentSettingKind {
    Int {
        default: Option<u64>,
        min: u64,
    },
    /// Short display glyph with a grapheme cap, and the one kind where an
    /// empty field is a *value* rather than an unset: `""` is the deliberate
    /// "off", distinct from the key being absent, which takes the default.
    /// `x` on the row still removes the key.
    Glyph {
        default: &'static str,
        max: usize,
    },
    Text {
        default: &'static str,
    },
    /// Exact-match choice: Enter writes one of `options`, cleared field
    /// unsets. Covers the `read-only | deny | allow` and `always | relevance`
    /// toggles that hand-editing agent.toml previously required.
    Enum {
        options: &'static [&'static str],
        default: &'static str,
    },
    /// Boolean toggle: Enter writes a TOML boolean (the Enum kind would emit a
    /// quoted string). Unset clears the key so its default applies.
    Bool {
        default: bool,
    },
}

/// Sentinel row value in the `/settings` picker that opens the provider
/// management screen instead of an `[agent]` edit dock.
pub(super) const PROVIDERS_SETTINGS_ROW: &str = "__providers__";

pub(super) const AGENT_SETTINGS: &[AgentSettingDef] = &[
    AgentSettingDef {
        key: "context_window",
        label: "context_window",
        desc: "context limit in tokens",
        kind: AgentSettingKind::Int {
            default: Some(128000),
            min: 1,
        },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "compaction_reserve_tokens",
        label: "compaction_reserve_tokens",
        desc: "headroom kept free before compaction",
        kind: AgentSettingKind::Int {
            default: Some(16384),
            min: 0,
        },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "max_tokens",
        label: "max_tokens",
        desc: "cap on tokens generated per response (omitted when unset)",
        kind: AgentSettingKind::Int {
            default: None,
            min: 1,
        },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "max_parallel_subagents",
        label: "max_parallel_subagents",
        desc: "subagents that may run at once; extra dispatches queue FIFO",
        kind: AgentSettingKind::Int {
            default: Some(10),
            min: 1,
        },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "instructions_file",
        label: "instructions_file",
        desc: "markdown injected into the system prompt",
        kind: AgentSettingKind::Text {
            default: "AGENT.md",
        },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "budget.max_tokens",
        label: "budget.max_tokens",
        desc: "token-spend ceiling per run; the only cap on run length",
        kind: AgentSettingKind::Int {
            default: Some(128000),
            min: 0,
        },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "tools.default",
        label: "tools.default",
        desc: "tool permission mode; deny locks down MCP tools",
        kind: AgentSettingKind::Enum {
            options: &["read-only", "deny", "allow"],
            default: "read-only",
        },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "skills.inject",
        label: "skills.inject",
        desc: "when project skills are injected into the prompt",
        kind: AgentSettingKind::Enum {
            options: &["always", "relevance"],
            default: "always",
        },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "show_reasoning",
        label: "show_reasoning",
        desc: "expand  reasoning in the transcript (Ctrl-O still toggles)",
        kind: AgentSettingKind::Bool { default: false },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "send_reasoning",
        label: "send_reasoning",
        desc: "resend prior reasoning to the model (false drops it from requests)",
        kind: AgentSettingKind::Bool { default: true },
        scope: SettingScope::Project,
    },
    AgentSettingDef {
        key: "claude_code_alias",
        label: "claude_code_alias",
        desc: "reuse and refresh Claude Code's keychain login for Claude requests",
        kind: AgentSettingKind::Bool { default: false },
        scope: SettingScope::Global,
    },
    AgentSettingDef {
        key: "hide_secrets",
        label: "hide_secrets",
        desc: "Privacy: obfuscate secret env values and redact credential-shaped tokens before sending to AI providers",
        kind: AgentSettingKind::Bool { default: false },
        scope: SettingScope::Global,
    },
    AgentSettingDef {
        key: "wave",
        label: "wave",
        desc: "glyph swept along the working row (up to 3 chars; empty = throbber)",
        kind: AgentSettingKind::Glyph {
            default: crate::core::agent::global_config::WAVE_DEFAULT,
            max: crate::core::agent::global_config::WAVE_MAX_GRAPHEMES,
        },
        scope: SettingScope::Global,
    },
    AgentSettingDef {
        key: "ask_timeout_secs",
        label: "ask_timeout_secs",
        desc: "auto-answer an unanswered ask after N seconds with the recommended option (0 = wait forever)",
        kind: AgentSettingKind::Int { default: Some(0), min: 0 },
        scope: SettingScope::Global,
    },
];

/// Docked edit prompt for one `/settings` row: value field, inline validation
/// error, Enter saves / Esc cancels / cleared field unsets.
pub(super) struct SettingsPrompt {
    pub(super) key: &'static str,
    pub(super) input: String,
    pub(super) error: Option<String>,
}

impl SettingsPrompt {
    pub(super) fn new(def: &AgentSettingDef, current: Option<&str>) -> Self {
        Self {
            key: def.key,
            input: current.unwrap_or_default().to_string(),
            error: None,
        }
    }

    pub(super) fn def(&self) -> &'static AgentSettingDef {
        AGENT_SETTINGS
            .iter()
            .find(|d| d.key == self.key)
            .expect("settings prompt always opens for a def row")
    }

    /// Apply a bracketed paste to the field, dropping the whitespace terminals
    /// add around a paste.
    pub(super) fn paste(&mut self, text: &str) {
        self.input.push_str(super::super::secret_input::pasted(text));
    }
}

/// A docked multi-field wizard for adding or editing an MCP server. Collects
/// the fields the desktop form also asks for (name, transport, then the
/// transport-specific bits), validating on save through the shared
/// `core::cli::mcp` layer. `edit` mode prefills from the existing entry and
/// defaults `name` to it; `add` mode starts blank.
pub(super) struct McpPrompt {
    /// `Some(original_name)` when editing; `None` when adding a new server.
    pub(super) editing: Option<String>,
    /// Which field the keyboard is currently filling in.
    pub(super) field: McpField,
    pub(super) name: String,
    pub(super) transport: String,
    pub(super) command: String,
    pub(super) args: String,
    pub(super) env: String,
    pub(super) url: String,
    pub(super) headers: String,
    pub(super) active: bool,
    pub(super) error: Option<String>,
}

/// The fields of `McpPrompt`, in input order. `Transport` is a toggle row
/// rather than a free-text field, so it is navigated but not typed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum McpField {
    Name,
    Transport,
    Command,
    Args,
    Env,
    Url,
    Headers,
    Active,
}

impl McpPrompt {
    pub(super) const FIELD_ORDER: [McpField; 8] = [
        McpField::Name,
        McpField::Transport,
        McpField::Command,
        McpField::Args,
        McpField::Env,
        McpField::Url,
        McpField::Headers,
        McpField::Active,
    ];

    /// The fields relevant to the current transport, in input order. stdio
    /// servers never ask for url/headers; http/sse never ask for command/args.
    pub(super) fn visible_fields(&self) -> Vec<McpField> {
        let transport = self.transport.as_str();
        Self::FIELD_ORDER
            .iter()
            .copied()
            .filter(|f| match f {
                McpField::Command | McpField::Args | McpField::Env => transport == "stdio",
                McpField::Url | McpField::Headers => transport != "stdio",
                _ => true,
            })
            .collect()
    }

    pub(super) fn next_field(&mut self) {
        let fields = self.visible_fields();
        let pos = fields
            .iter()
            .position(|f| *f == self.field)
            .unwrap_or(usize::MAX);
        if pos + 1 < fields.len() {
            self.field = fields[pos + 1];
        } else {
            self.field = fields[0];
        }
    }

    pub(super) fn prev_field(&mut self) {
        let fields = self.visible_fields();
        let pos = fields.iter().position(|f| *f == self.field).unwrap_or(0);
        self.field = fields[if pos == 0 { fields.len() - 1 } else { pos - 1 }];
    }

    pub(super) fn from_entry(entry: &McpServerEntry) -> Self {
        let cfg = &entry.config;
        let transport = cfg
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("stdio")
            .to_string();
        let env = pairs_to_str(cfg.get("env").and_then(Value::as_object));
        let headers = pairs_to_str(cfg.get("headers").and_then(Value::as_object));
        Self {
            editing: Some(entry.name.clone()),
            field: McpField::Name,
            name: entry.name.clone(),
            transport: transport.clone(),
            command: cfg
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            args: cfg
                .get("args")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default(),
            env,
            url: cfg
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            headers,
            active: entry.active,
            error: None,
        }
    }

    /// Build and persist the entry, then (dis)connect live as needed.
    /// Returns an error string on invalid input so the caller can keep the
    /// prompt open with the reason shown.
    pub(super) async fn save(
        &mut self,
        mcp_servers: &crate::core::state::SharedMcpServers,
    ) -> Result<(), String> {
        let config = super::super::mcp::build_server_config(
            self.transport.trim(),
            Some(self.command.trim()).filter(|s| !s.is_empty()),
            super::super::mcp::parse_args(self.args.trim()),
            super::super::mcp::parse_pairs(self.env.trim(), "env")?,
            Some(self.url.trim()).filter(|s| !s.is_empty()),
            super::super::mcp::parse_pairs(self.headers.trim(), "header")?,
            self.active,
            // The form has no field for OAuth scopes (AH-135); an edit keeps
            // the ones the entry already declares instead of dropping them.
            self.editing
                .as_deref()
                .and_then(super::super::mcp::get_server)
                .map(|e| crate::core::mcp::oauth::declared_scopes(&e.config).unwrap_or_default())
                .unwrap_or_default(),
        )?;
        // Read the *previous* active flag before the write. `upsert_server` has
        // already replaced the entry by the time it lands on disk, so reading it
        // afterwards reports the new value and a server being disabled from this
        // form was left connected.
        let was_active = self
            .editing
            .as_deref()
            .is_some_and(|n| super::super::mcp::get_server(n).is_some_and(|e| e.active));
        super::super::mcp::upsert_server(self.name.trim(), &config)?;
        let name = self.name.trim().to_string();
        // Disconnect the old live service on rename/edit, then reconnect if active.
        if let Some(old) = self.editing.take() {
            if old != name {
                super::super::mcp::disconnect(&old, mcp_servers).await;
            }
        }
        if self.active {
            // Off the render loop: a cold stdio spawn or an http handshake here
            // would freeze the frame the form was submitted on.
            reconnect_mcp_server(mcp_servers, name);
        } else if was_active {
            super::super::mcp::disconnect(&name, mcp_servers).await;
        }
        Ok(())
    }

    /// Apply a bracketed paste to the active text field. Toggle fields
    /// (transport, active) ignore pastes exactly as they ignore typed
    /// characters.
    pub(super) fn paste(&mut self, text: &str) {
        let text = super::super::secret_input::pasted(text);
        match self.field {
            McpField::Name if self.editing.is_none() => self.name.push_str(text),
            McpField::Command => self.command.push_str(text),
            McpField::Args => self.args.push_str(text),
            McpField::Env => self.env.push_str(text),
            McpField::Url => self.url.push_str(text),
            McpField::Headers => self.headers.push_str(text),
            _ => {}
        }
    }
}

/// Render a `KEY=VALUE` map as a comma-separated string, for pre-filling the
/// form fields (the inverse of `parse_pairs`).
pub(super) fn pairs_to_str(map: Option<&serde_json::Map<String, Value>>) -> String {
    map.map(|m| {
        m.iter()
            .filter_map(|(k, v)| v.as_str().map(|v| format!("{k}={v}")))
            .collect::<Vec<_>>()
            .join(",")
    })
    .unwrap_or_default()
}

/// A docked multi-field wizard for adding or editing an OpenAI-compatible
/// provider in `~/.jan/config.toml`. Mirrors `McpPrompt`: Up/Down move between
/// fields, chars/backspace edit the current field, Enter saves. The API key is
/// never echoed (see `secret_input::mask`). `edit` mode prefills from the
/// existing entry and defaults `name` to it; `add` mode starts blank.
pub(super) struct ProviderPrompt {
    /// `Some(original_name)` when editing; `None` when adding a new provider.
    pub(super) editing: Option<String>,
    /// Which field the keyboard is currently filling in.
    pub(super) field: ProviderField,
    pub(super) name: String,
    pub(super) base_url: String,
    /// Wire API type: `None` = OpenAI-compatible chat/completions default,
    /// `Some("anthropic")` = Anthropic messages API.
    pub(super) api_type: Option<String>,
    pub(super) api_key: String,
    /// Whether the user edited the api-key field this session. While editing a
    /// provider the stored key is never loaded into the prompt (it must not be
    /// echoable), so an untouched field means "keep the stored key" and a
    /// touched one replaces it on save -- including with nothing, which clears
    /// it (e.g. a local endpoint that dropped auth).
    pub(super) key_touched: bool,
    /// Whitespace-separated model ids (replaces the existing list on save).
    pub(super) models: String,
    pub(super) error: Option<String>,
}

/// The fields of `ProviderPrompt`, in input order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum ProviderField {
    Name,
    BaseUrl,
    ApiType,
    ApiKey,
    Models,
}

impl ProviderPrompt {
    pub(super) const FIELD_ORDER: [ProviderField; 5] = [
        ProviderField::Name,
        ProviderField::BaseUrl,
        ProviderField::ApiType,
        ProviderField::ApiKey,
        ProviderField::Models,
    ];
    pub(super) fn next_field(&mut self) {
        if self.editing.is_some() {
            // Name is read-only while editing; cycle through the editable
            // fields only (BaseUrl -> ApiType -> ApiKey -> Models -> BaseUrl).
            self.field = match self.field {
                ProviderField::BaseUrl => ProviderField::ApiType,
                ProviderField::ApiType => ProviderField::ApiKey,
                ProviderField::ApiKey => ProviderField::Models,
                _ => ProviderField::BaseUrl,
            };
        } else {
            let pos = Self::FIELD_ORDER
                .iter()
                .position(|f| *f == self.field)
                .unwrap_or(0);
            self.field = Self::FIELD_ORDER[(pos + 1) % Self::FIELD_ORDER.len()];
        }
    }

    pub(super) fn prev_field(&mut self) {
        if self.editing.is_some() {
            // Name is read-only while editing; cycle backwards through the
            // editable fields only (BaseUrl <- ApiType <- ApiKey <- Models).
            self.field = match self.field {
                ProviderField::ApiType => ProviderField::BaseUrl,
                ProviderField::ApiKey => ProviderField::ApiType,
                ProviderField::Models => ProviderField::ApiKey,
                _ => ProviderField::Models,
            };
        } else {
            let pos = Self::FIELD_ORDER
                .iter()
                .position(|f| *f == self.field)
                .unwrap_or(0);
            self.field =
                Self::FIELD_ORDER[(pos + Self::FIELD_ORDER.len() - 1) % Self::FIELD_ORDER.len()];
        }
    }

    pub(super) fn from_entry(entry: &crate::core::state::ProviderConfig) -> Self {
        Self {
            editing: Some(entry.provider.clone()),
            field: ProviderField::BaseUrl,
            name: entry.provider.clone(),
            base_url: entry.base_url.clone().unwrap_or_default(),
            api_type: entry.api_type.clone(),
            api_key: String::new(),
            key_touched: false,
            models: entry.models.join(" "),
            error: None,
        }
    }

    pub(super) fn new() -> Self {
        Self {
            editing: None,
            field: ProviderField::Name,
            name: String::new(),
            base_url: String::new(),
            api_type: None,
            api_key: String::new(),
            key_touched: false,
            models: String::new(),
            error: None,
        }
    }

    /// Apply a bracketed paste to the active field, dropping the whitespace
    /// terminals add around a paste. The name field is read-only while editing
    /// (renaming would orphan the config entry), so a paste lands in the
    /// editable fields only.
    pub(super) fn paste(&mut self, text: &str) {
        let text = super::super::secret_input::pasted(text);
        if self.editing.is_some() && self.field == ProviderField::Name {
            return;
        }
        match self.field {
            ProviderField::Name => self.name.push_str(text),
            ProviderField::BaseUrl => self.base_url.push_str(text),
            ProviderField::ApiKey => {
                self.api_key.push_str(text);
                self.key_touched = true;
            }
            ProviderField::Models => self.models.push_str(text),
            // ApiType is a toggle, not free text; a paste has nothing to add.
            ProviderField::ApiType => {}
        }
    }

    /// API key field for rendering: the stored key is never loaded into the
    /// prompt, so an untouched field while editing says `(unchanged)`; anything
    /// typed/pasted renders masked so a key never reaches the screen or
    /// scrollback.
    pub(super) fn masked_key(&self) -> String {
        if self.editing.is_some() && !self.key_touched {
            return "(unchanged)".to_string();
        }
        super::super::secret_input::mask(self.api_key.chars().count())
    }

    /// An error explaining why a base URL is not a usable http(s) upstream.
    /// Only `https` (or `http` for a loopback host) is accepted, so a bearer
    /// key is never sent over a plaintext remote connection.
    pub(super) fn validate_base_url(&self) -> Option<String> {
        use super::super::providers::is_loopback_url;
        let url = self.base_url.trim();
        if url.is_empty() {
            return Some("base URL is required".to_string());
        }
        if url.starts_with("https://") {
            return None;
        }
        if url.starts_with("http://") && is_loopback_url(url) {
            return None;
        }
        Some("base URL must be https:// (or http:// for a localhost/loopback host)".to_string())
    }
    /// `None` renders as the OpenAI-compatible default; `Some("anthropic")`
    /// selects the Anthropic messages API.
    pub(super) fn toggle_api_type(&mut self) {
        self.api_type = match self.api_type.as_deref() {
            Some("anthropic") => None,
            _ => Some("anthropic".to_string()),
        };
    }

    /// Human label for the active api-type selection.
    pub(super) fn api_type_label(&self) -> String {
        match self.api_type.as_deref() {
            Some("anthropic") => "anthropic-compatible".to_string(),
            _ => "openai-compatible".to_string(),
        }
    }

    /// Persist the provider to `~/.jan/config.toml` via the headless config
    /// path the CLI shares. `api_type` stays default (OpenAI-compatible
    /// passthrough) unless an explicit type is chosen elsewhere. Returns an
    /// error keeping the prompt open on invalid input. The name is read-only
    /// while editing, so `save` always writes under the original key and never
    /// orphans the prior entry. An untouched api-key field keeps the stored
    /// key; a touched one replaces it -- with nothing, if emptied, which clears
    /// the key (see `key_touched`).
    pub(super) fn save(&self) -> Result<(), String> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err("provider name is required".to_string());
        }
        if let Some(err) = self.validate_base_url() {
            return Err(err);
        }
        let base_url = self.base_url.trim().to_string();
        let api_key =
            (self.key_touched || self.editing.is_none()).then(|| self.api_key.trim().to_string());
        let models: Vec<String> = self.models.split_whitespace().map(str::to_string).collect();
        super::super::cli_agent_config_set(
            name,
            api_key,
            Some(base_url),
            Some(models),
            self.api_type.clone(),
        )
        .map(|_| ())
    }
}

/// Value of an `[agent]` key in `agent.toml` as a display string, `None` when
/// unset or the file is unreadable. Reads the inner value directly so the
/// display is not padded by the document's alignment.
pub(super) fn current_agent_value(toml_path: &std::path::Path, key: &str) -> Option<String> {
    let raw = std::fs::read_to_string(toml_path).ok()?;
    let doc = raw.parse::<toml_edit::DocumentMut>().ok()?;
    let (section, key) = match key.split_once('.') {
        Some((section, key)) => (section, key),
        None => ("agent", key),
    };
    let item = doc.get(section)?.get(key)?;
    Some(match item.as_value() {
        Some(toml_edit::Value::Integer(i)) => i.value().to_string(),
        Some(toml_edit::Value::String(s)) => s.value().to_string(),
        Some(toml_edit::Value::Boolean(b)) => b.value().to_string(),
        _ => item.to_string(),
    })
}

/// Current on-disk value of a `/settings` row, from whichever file its scope
/// names. `None` when unset or the file is unreadable.
pub(super) fn current_setting_value(def: &AgentSettingDef, toml_path: &std::path::Path) -> Option<String> {
    match def.scope {
        SettingScope::Project => current_agent_value(toml_path, def.key),
        SettingScope::Global => crate::core::agent::global_config::global_value(def.key),
    }
}

/// Write a `/settings` row to whichever file its scope names. `None` removes
/// the key so its default applies again.
pub(super) fn write_setting(
    def: &AgentSettingDef,
    toml_path: &std::path::Path,
    value: Option<toml_edit::Item>,
) -> Result<(), String> {
    match def.scope {
        SettingScope::Project => {
            crate::core::agent::project::set_agent_key(toml_path, def.key, value)
        }
        SettingScope::Global => {
            crate::core::agent::global_config::set_global_key(def.key, value).map(|_| ())
        }
    }
}

/// The file a `/settings` row writes, for the error message when a write fails.
pub(super) fn setting_path(def: &AgentSettingDef, toml_path: &std::path::Path) -> String {
    match def.scope {
        SettingScope::Project => toml_path.display().to_string(),
        SettingScope::Global => crate::core::agent::global_config::global_config_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "~/.jan/config.toml".to_string()),
    }
}

/// Apply a just-saved setting to the running process where that is possible,
/// returning whether it took. Most keys are snapshotted at session start and
/// genuinely need a restart; a purely cosmetic one like `wave` does not, and
/// telling someone to restart to see a glyph they just picked would be a lie
/// the code does not have to tell. `entered` is the trimmed field; empty is an
/// unset for most kinds and a written "off" for a `Glyph`, which is why this
/// passes `Some` either way and lets the setter read it.
pub(super) fn apply_live_setting(def: &AgentSettingDef, entered: &str) -> bool {
    match def.key {
        "wave" => {
            set_wave_glyph(Some(entered));
            true
        }
        _ => false,
    }
}

/// Apply a just-removed setting to the running process, returning whether it
/// took. Separate from `apply_live_setting` because removing a key and saving
/// an empty one are different outcomes for a `Glyph`: the first restores the
/// default, the second is the off switch.
pub(super) fn apply_live_unset(def: &AgentSettingDef) -> bool {
    match def.key {
        "wave" => {
            set_wave_glyph(None);
            true
        }
        _ => false,
    }
}

/// `/settings` dispatcher: bare opens the interactive settings menu (an
/// `AgentSettings` picker over every def, project-scoped or user-wide; Enter on
/// a row docks an edit prompt); `max_parallel_subagents <N>` still works as a
/// one-shot shortcut. Writes are format-preserving and take effect on the next
/// run (the current run snapshotted its config at start), except the cosmetic
/// ones `apply_live_setting` handles. Runs only while idle, like every command.
pub(super) fn settings_command(app: &mut App, arg: &str) {
    let toml_path = app.agent_dir.join("agent.toml");
    let arg = arg.trim();
    let Some((key, value)) = arg.split_once(char::is_whitespace) else {
        return open_settings_screen(app);
    };
    match key {
        "max_parallel_subagents" => {
            let n: u64 = match value.parse() {
                Ok(n) => n,
                Err(_) => return app.note(&format!("'{value}' is not an integer")),
            };
            if n < 1 {
                return app.note("max_parallel_subagents must be at least 1");
            }
            match crate::core::agent::project::set_agent_key(
                &toml_path,
                key,
                Some(toml_edit::value(n as i64)),
            ) {
                Ok(()) => app.note(&format!(
                    "max_parallel_subagents = {n} written; takes effect on the next run"
                )),
                Err(e) => app.note(&format!("failed to write {}: {e}", toml_path.display())),
            }
        }
        other => app.note(&format!(
            "unknown setting '/settings {other}' (bare /settings opens the menu)"
        )),
    }
}

/// One picker row per setting def, whatever file its scope names, plus a
/// leading "providers" entry that opens the provider-management screen (see
/// `open_provider_settings`). The hint carries the current on-disk value
/// (`= 400`) or `(unset)` when the default applies. `value` is the key so the
/// edit dock and the `x` unset shortcut can act on it.
pub(super) fn build_agent_settings_items(toml_path: &std::path::Path) -> Vec<PickerItem> {
    let mut items = vec![PickerItem {
        value: PROVIDERS_SETTINGS_ROW.to_string(),
        label: "providers".to_string(),
        hint: Some("configure OpenAI-compatible providers".to_string()),
        checkbox: None,
    }];
    items.extend(
        AGENT_SETTINGS
            .iter()
            .map(|def| {
                let current = current_setting_value(def, toml_path);
                PickerItem {
                    value: def.key.to_string(),
                    label: def.label.to_string(),
                    hint: Some(match &current {
                        Some(v) => format!("= {v}"),
                        None => "(unset)".to_string(),
                    }),
                    checkbox: None,
                }
            })
            .collect::<Vec<_>>(),
    );
    items
}

/// Open the `/settings` menu: a picker row per setting key, hint showing the
/// current value (or `unset`), Enter docking the edit prompt for that row, `x`
/// removing the key so its default applies again.
pub(super) fn open_settings_screen(app: &mut App) {
    let toml_path = app.agent_dir.join("agent.toml");
    app.picker = Some(Picker {
        kind: PickerKind::AgentSettings,
        items: build_agent_settings_items(&toml_path),
        selected: 0,
        armed_delete: None,
    });
}

/// Open the `/settings > providers` screen: a picker row per provider in
/// `~/.jan/config.toml` (the standalone-agent credential store), with `a` to
/// add, Enter to edit the selected row, and `d` pressed twice to delete it
/// (the first `d` arms, the second confirms; see the picker key handler).
pub(super) fn open_provider_settings(app: &mut App) {
    let providers = match crate::core::agent::global_config::load_global_config() {
        Ok(c) => c,
        Err(e) => return app.note(&format!("failed to read ~/.jan/config.toml: {e}")),
    };
    let mut providers: Vec<_> = providers.into_values().collect();
    providers.sort_by(|a, b| a.provider.cmp(&b.provider));

    let items: Vec<PickerItem> = if providers.is_empty() {
        vec![PickerItem {
            label: "no providers configured - press a to add an OpenAI-compatible one".to_string(),
            value: String::new(),
            hint: None,
            checkbox: None,
        }]
    } else {
        providers
            .into_iter()
            .map(|c| {
                let key = if c.api_key.is_some() {
                    "key set"
                } else {
                    "no key"
                };
                let base = c.base_url.as_deref().unwrap_or("default url");
                PickerItem {
                    label: format!("{key}  {base}  {} model(s)", c.models.len()),
                    value: c.provider.clone(),
                    hint: Some(c.provider),
                    checkbox: None,
                }
            })
            .collect()
    };
    app.picker = Some(Picker {
        kind: PickerKind::ProviderSettings,
        items,
        selected: 0,
        armed_delete: None,
    });
}

/// Truncate to the first `n` grapheme clusters. Slicing by byte or `char`
/// would split an emoji mid-sequence and leave a different glyph on screen.
pub(super) fn grapheme_prefix(s: &str, n: usize) -> String {
    use unicode_segmentation::UnicodeSegmentation;
    s.graphemes(true).take(n).collect()
}

/// Keyboard for the `/settings` edit dock: chars/backspace edit the field,
/// Enter validates and writes (an empty field clears the key, except for a
/// `Glyph`, where it writes the off value), Esc cancels. Mirrors
/// `handle_login_key`, minus the secret/verify machinery.
/// Parse the field of an `Int` setting into the TOML integer to write, or
/// `None` for a cleared field (unset). TOML integers are signed 64-bit, so a
/// value above `i64::MAX` is refused here: casting it would wrap negative,
/// and a negative value in a `u64` field makes agent.toml fail to load, which
/// stops the TUI from starting for that project (#133).
pub(super) fn parse_int_setting(input: &str, default: Option<u64>, min: u64) -> Result<Option<i64>, String> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(None);
    }
    let default = default
        .map(|d| d.to_string())
        .unwrap_or_else(|| "unset".into());
    match input.parse::<u64>() {
        Ok(n) if n < min => Err(format!("must be at least {min} (default: {default})")),
        Ok(n) => i64::try_from(n)
            .map(Some)
            .map_err(|_| format!("must be at most {} (default: {default})", i64::MAX)),
        Err(_) => Err(format!("'{input}' is not an integer")),
    }
}

/// it, and `/plan <text>` enters plan mode (if not already in it) and
/// immediately submits `<text>` as the first message to investigate — same
/// convenience as seeding the bare TUI with a task. Only settable while idle
/// so it never races the live tool set of a running turn (spec). Enforcement
/// is at the core dispatcher; this just flips the per-turn flag forwarded in
/// `App::body()` and persists it.
pub(super) fn plan_command(app: &mut App, arg: &str) {
    use crate::core::agent::plan::RunMode;
    if app.status != Status::Idle {
        app.note("plan mode is only settable while idle");
        return;
    }
    let arg = arg.trim();
    if arg == "exit" {
        if app.run_mode == RunMode::Plan {
            app.run_mode = RunMode::Normal;
            app.persist();
            app.note("exited plan mode (normal execution)");
        } else {
            app.note("not in plan mode");
        }
        return;
    }
    if app.run_mode == RunMode::Plan {
        if arg.is_empty() {
            app.note("already in plan mode (/plan exit to leave)");
        } else {
            app.submit_user(arg.to_string());
        }
        return;
    }
    app.run_mode = RunMode::Plan;
    app.persist();
    app.note("◈ PLAN · read only — investigate, then propose a plan for review");
    if app.goal.is_some() {
        app.note("active goal paused while planning; it resumes on exit");
    }
    if !arg.is_empty() {
        app.submit_user(arg.to_string());
    }
}

/// What `/export` was asked for.
#[derive(Debug, PartialEq)]
pub(super) struct ExportArg {
    pub(super) format: String,
    pub(super) path: Option<std::path::PathBuf>,
    pub(super) force: bool,
}

/// Parse `/export [--force] [format] [path...]` (CLIB-019). Everything after
/// the format is the path, spaces included, so `C:\My Docs\notes.md` stays
/// whole. A lone word that is not a format, has no folder separator or
/// extension and does not exist is taken for a mistyped format rather than
/// silently becoming a file of that name.
pub(super) fn parse_export_arg(arg: &str) -> Result<ExportArg, String> {
    use super::super::thread_export::Format;
    let mut rest = arg.trim();
    let mut force = false;
    if let Some(after) = rest.strip_prefix("--force") {
        if after.is_empty() || after.starts_with(char::is_whitespace) {
            force = true;
            rest = after.trim_start();
        }
    }
    if let Some(before) = rest.strip_suffix("--force") {
        if before.is_empty() || before.ends_with(char::is_whitespace) {
            force = true;
            rest = before.trim_end();
        }
    }
    let (first, remainder) = match rest.split_once(char::is_whitespace) {
        Some((w, r)) => (w, r.trim()),
        None => (rest, ""),
    };
    if first.is_empty() {
        return Ok(ExportArg { format: "markdown".into(), path: None, force });
    }
    if Format::parse(first).is_ok() {
        let path = (!remainder.is_empty()).then(|| std::path::PathBuf::from(remainder));
        return Ok(ExportArg { format: first.to_string(), path, force });
    }
    let looks_like_path = rest.contains(['/', '\\'])
        || std::path::Path::new(rest).extension().is_some()
        || rest.contains(char::is_whitespace)
        || std::path::Path::new(rest).exists();
    if !looks_like_path {
        return Err(format!(
            "unknown export format '{rest}': use markdown, obsidian or json, or give a path with a folder or extension"
        ));
    }
    Ok(ExportArg { format: "markdown".into(), path: Some(std::path::PathBuf::from(rest)), force })
}

/// `/export [--force] [format] [path]` -- write this conversation to a file. The format
/// is markdown (default), obsidian or json; the path is a file, or a folder to
/// get a file named after the conversation, and defaults to the project folder.
pub(super) fn export_command(app: &mut App, arg: &str) {
    use super::super::thread_export::{export_thread, Format};
    let Some(id) = app.thread_id.clone() else {
        app.note("nothing to export yet: send a message first");
        return;
    };
    let parsed = match parse_export_arg(arg) {
        Ok(p) => p,
        Err(e) => {
            app.note(&e);
            return;
        }
    };
    let format = match Format::parse(&parsed.format) {
        Ok(f) => f,
        Err(e) => {
            app.note(&e);
            return;
        }
    };
    let out = parsed.path.unwrap_or_else(|| app.project_root.clone());
    if !parsed.force && out.is_file() {
        app.note(&format!("{} already exists; add --force to overwrite it", out.display()));
        return;
    }
    match export_thread(&app.agent_dir, &id, format, false, false, Some(&out)) {
        Ok(Some(written)) => app.note(&format!("exported to {}", written.display())),
        Ok(None) => {}
        Err(e) => app.note(&format!("export failed: {e}")),
    }
}

/// `/schedule` -- the scheduled tasks, from the terminal's side. Creating and
/// editing a task is `flint cli schedule add|edit`; here you can see them and
/// run, enable or disable one.
pub(super) fn schedule_command(app: &mut App, arg: &str) {
    use super::super::schedule_manage;
    let mut words = arg.split_whitespace();
    let action = words.next().unwrap_or("list");
    let id = words.next();
    match (action, id) {
        ("list", _) => match schedule_manage::summary_lines() {
            Ok(lines) if lines.is_empty() => app.note("no scheduled tasks (flint cli schedule add ...)"),
            Ok(lines) => {
                for line in lines {
                    app.note(&line);
                }
            }
            Err(e) => app.note(&format!("could not read the schedule: {e}")),
        },
        ("run", Some(id)) => match schedule_manage::start_now(id) {
            Ok(run) => app.note(&format!("started {id}, run {run} (flint cli schedule runs {id})")),
            Err(e) => app.note(&e),
        },
        ("enable" | "disable", Some(id)) => {
            match crate::core::schedule::store::Store::new(&crate::core::app::commands::resolve_jan_data_folder())
                .set_enabled(id, action == "enable")
            {
                Ok(t) => app.note(&format!("{} is {}", t.name, if t.enabled { "on" } else { "off" })),
                Err(e) => app.note(&e.message),
            }
        }
        _ => app.note("usage: /schedule [list] | run <id> | enable <id> | disable <id>"),
    }
}

/// `/mode` -- how freely the agent acts, named like the desktop's modes.
/// Without an argument, reports the current one. Applies from the next turn.
pub(super) fn mode_command(app: &mut App, arg: &str) {
    use crate::core::agent::plan::RunMode;
    use crate::core::cli::PermissionMode;
    let current = |app: &App| {
        if app.run_mode == RunMode::Plan {
            PermissionMode::Review
        } else if app.args.as_ref().is_some_and(|a| a.bypass) {
            PermissionMode::Bypass
        } else if app.args.as_ref().is_some_and(|a| a.auto_approve) {
            PermissionMode::Auto
        } else {
            PermissionMode::Ask
        }
    };
    let arg = arg.trim();
    if arg.is_empty() {
        app.note(&format!(
            "mode: {} (use /mode review|ask|auto|bypass)",
            current(app).as_str()
        ));
        return;
    }
    if app.status != Status::Idle {
        app.note("the mode is only settable while idle");
        return;
    }
    let mode = match PermissionMode::parse(arg) {
        Ok(m) => m,
        Err(e) => {
            app.note(&e);
            return;
        }
    };
    if let Some(args) = app.args.as_mut() {
        let args = std::sync::Arc::make_mut(args);
        args.auto_approve = mode.auto_approve();
        args.bypass = mode.bypass();
    }
    app.run_mode = if mode.plan() { RunMode::Plan } else { RunMode::Normal };
    app.persist();
    app.note(&match mode {
        PermissionMode::Review => "◈ REVIEW · read only — investigate, then propose a plan for review".to_string(),
        PermissionMode::Ask => "mode: ask — writes, shell commands and MCP calls need approval".to_string(),
        PermissionMode::Auto => "mode: auto — approved actions run unprompted (inside the sandbox when it is on)".to_string(),
        PermissionMode::Bypass => "mode: bypass — everything runs without asking, including host commands (PowerShell, WSL, SSH, packages), computer and clipboard tools, destructive commands and writes outside the project. Plan mode and deny rules still refuse.".to_string(),
    });
}

pub(super) const EFFORT_LEVELS: &[&str] = &["low", "medium", "high"];

/// `/effort` -- report or change the reasoning effort level for subsequent model
/// requests. Without arguments, shows the current level. With a level argument,
/// validates and applies it.
pub(super) fn effort_command(app: &mut App, arg: &str) {
    let arg = arg.trim();
    if arg.is_empty() {
        app.note(&format!(
            "reasoning effort: {} (use /effort low|medium|high)",
            app.reasoning_effort
        ));
        return;
    }
    let level = arg.to_ascii_lowercase();
    if !EFFORT_LEVELS.contains(&level.as_str()) {
        app.note(&format!(
            "unknown effort level '{arg}' -- supported: low, medium, high"
        ));
        return;
    }
    app.reasoning_effort = level.clone();
    if level != "low" {
        app.last_non_low_effort = level.clone();
    }
    app.note(&format!("reasoning effort set to {level}"));
}

/// Apply one user-initiated todo mutation to the canonical `TodoList`. Prefers
/// the shared registry (the model's source of truth) so agent and user share one
/// state; falls back to the local projection when no live session is attached
/// (e.g. tests). Syncs the TUI projection and persists on success.
pub(super) async fn apply_todo_mutation(
    app: &mut App,
    op: impl FnOnce(&mut crate::core::agent::todo::TodoList) -> Result<(), String>,
) -> Result<(), String> {
    if let Some(args) = app.args.clone() {
        if let Some(registry) = args.todo_registry.as_ref() {
            let mut list = registry.lock().await;
            op(&mut list)?;
            app.todos = list.clone();
            app.persist();
            return Ok(());
        }
    }
    let mut list = app.todos.clone();
    op(&mut list)?;
    app.todos = list;
    app.persist();
    Ok(())
}

/// Turns (model roundtrips or user submissions) allowed to pass with a fully
/// closed-out todo list before it is dropped. One is too eager -- a model
/// often closes the last task and then appends follow-up work in the next
/// turn, and clearing between the two would destroy a list it is still using.
pub(super) const TODO_KEEP_CLOSED_TURNS: u32 = 2;

/// Clear the canonical todo list and the TUI projection together.
///
/// Goes through `apply_todo_mutation` so the registry -- the model's source of
/// truth -- is cleared too. Dropping only the projection would leave the model
/// appending to a list the user believes is gone, and the next `TodoUpdate`
/// would resurrect it on screen.
pub(super) async fn clear_todos(app: &mut App) {
    // `Target::All` clears unconditionally; the Result exists for the
    // unknown-task and unknown-phase targets.
    let _ = apply_todo_mutation(app, |list| list.rm(crate::core::agent::todo::Target::All)).await;
    app.last_todo_reminder = None;
    app.turns_since_todos_closed = 0;
}

/// Age a finished todo list, dropping it once it has survived
/// `TODO_KEEP_CLOSED_TURNS` turns without the model reopening or extending it.
/// Called on every model roundtrip (`Step`) and at each run kick, so a single
/// run's many tool-call turns all count -- a finished plan does not outlive
/// the long run that produced it.
///
/// Without this the widget is sticky: `is_empty` means "no tasks exist", and a
/// completed task is still a task, so a finished plan renders forever and only
/// a fresh `todo init` ever replaces it. Users end up reading a plan that
/// belongs to work they finished several tasks ago.
pub(super) async fn age_closed_todos(app: &mut App) {
    if app.todos.is_empty() || app.todos.has_open() {
        // Nothing to age, or the model still has open work.
        app.turns_since_todos_closed = 0;
        return;
    }
    app.turns_since_todos_closed += 1;
    if app.turns_since_todos_closed > TODO_KEEP_CLOSED_TURNS {
        clear_todos(app).await;
        app.persist();
    }
}

/// Build the `/todo` editor rows: one per task, in phase/task order, prefixed by
/// a status glyph. `value` is the task content (its stable mutation id).
pub(super) fn build_todo_items(todos: &crate::core::agent::todo::TodoList) -> Vec<PickerItem> {
    use crate::core::agent::todo::TodoStatus;
    let mut items = Vec::new();
    for phase in &todos.phases {
        for task in &phase.tasks {
            let marker = match task.status {
                TodoStatus::InProgress => "▸",
                TodoStatus::Pending => "○",
                TodoStatus::Completed => "✔",
                TodoStatus::Abandoned => "✗",
            };
            items.push(PickerItem {
                value: task.content.clone(),
                label: format!("{marker} {}", task.content),
                hint: (!phase.name.is_empty()).then(|| phase.name.clone()),
                checkbox: None,
            });
        }
    }
    items
}

/// Open the `/todo` editor overlay over the current phased list.
pub(super) fn open_todo_picker(app: &mut App) {
    if app.todos.is_empty() {
        app.note("no todos yet — the agent declares them, or add one: /todo add TEXT");
        return;
    }
    app.picker = Some(Picker {
        kind: PickerKind::Todo,
        items: build_todo_items(&app.todos),
        selected: 0,
        armed_delete: None,
    });
}

/// `/todo` handler. Bare opens the editor overlay; `/todo add [PHASE |] TEXT`
/// appends a pending task through the canonical `append` op (default phase
/// "Tasks"), so a user-added task is indistinguishable from a model-added one.
pub(super) async fn todo_command(app: &mut App, arg: &str) {
    let arg = arg.trim();
    if arg.is_empty() {
        open_todo_picker(app);
        return;
    }
    // Drop the whole list in one step. A finished (or abandoned) task set
    // otherwise lingers in the HUD until every item is removed by hand in the
    // editor, since the model does not always close its own todos out.
    if arg == "clear" {
        if app.todos.is_empty() {
            app.note("no todos to clear");
            return;
        }
        match apply_todo_mutation(app, |list| list.rm(crate::core::agent::todo::Target::All)).await
        {
            Ok(()) => app.note("cleared all todos"),
            Err(e) => app.note(&format!("todo clear failed: {e}")),
        }
        return;
    }
    let Some(rest) = arg.strip_prefix("add") else {
        app.note("usage: /todo   (open editor)   |   /todo add [PHASE |] TEXT   |   /todo clear");
        return;
    };
    let rest = rest.trim();
    let (phase, text) = match rest.split_once('|') {
        Some((p, t)) => (p.trim().to_string(), t.trim().to_string()),
        None => ("Tasks".to_string(), rest.to_string()),
    };
    if text.is_empty() {
        app.note("usage: /todo add [PHASE |] TEXT");
        return;
    }
    let phase_label = phase.clone();
    match apply_todo_mutation(app, move |list| list.append(&phase, vec![text])).await {
        Ok(()) => app.note(&format!("added todo to '{phase_label}'")),
        Err(e) => app.note(&format!("todo add failed: {e}")),
    }
}

/// `/cancel` handler: without an argument, clears ALL queued messages.
/// With a numeric argument `/cancel N` (1-indexed), removes the Nth queued
/// message. Notes the result or when the queue is empty.
pub(super) fn cancel_command(app: &mut App, arg: &str) {
    if app.message_queue.is_empty() {
        app.note("no pending messages to cancel");
        return;
    }
    if arg.is_empty() {
        let n = app.message_queue.len();
        app.message_queue.clear();
        app.note(&format!("cancelled all {n} pending message(s)"));
        return;
    }
    // Try to parse as a 1-indexed position
    if let Ok(idx) = arg.parse::<usize>() {
        if idx == 0 || idx > app.message_queue.len() {
            app.note(&format!(
                "no message at position {idx} (queue has {} messages)",
                app.message_queue.len()
            ));
            return;
        }
        let removed = app.message_queue.remove(idx - 1);
        if let Some(text) = removed {
            let preview = truncate(&text.text, 40);
            app.note(&format!(
                "cancelled message #{idx}: \"{preview}\" ({} remaining)",
                app.message_queue.len()
            ));
        }
        return;
    }
    app.note(&format!(
        "usage: /cancel [N]  — cancel all or the Nth queued message (queue has {})",
        app.message_queue.len()
    ));
}

/// `/plugin` handler: manage plugins installed under `.jan/agent/plugins/`.
///   - `/plugin` or `/plugin list`   — installed plugins + the skills they ship
///   - `/plugin install <spec>`      — git URL (optionally `#ref`) or a name
///     from the configured `[plugins] marketplace`
///   - `/plugin remove <name>`       — uninstall by directory name
///   - `/plugin search [query]`      — marketplace listing, name/description match
///
/// Install and search hit the network, so this is async like `/todo`.
pub(super) async fn plugin_command(app: &mut App, arg: &str) {
    let root = app.project_root.clone();
    let mut parts = arg.split_whitespace();
    let op = parts.next().unwrap_or("list");
    let rest = parts.collect::<Vec<_>>().join(" ");
    // One compact summary per plugin: name, version, and payload counts.
    fn summary_line(p: &crate::core::agent::plugins::InstalledPlugin) -> String {
        let noun = if p.skills == 1 { "skill" } else { "skills" };
        let mut bits: Vec<String> = Vec::new();
        if p.skills > 0 {
            bits.push(format!("{} {}", p.skills, noun));
        }
        if p.commands > 0 {
            bits.push(format!(
                "{} command{}",
                p.commands,
                if p.commands == 1 { "" } else { "s" }
            ));
        }
        if p.agents > 0 {
            bits.push(format!(
                "{} agent{}",
                p.agents,
                if p.agents == 1 { "" } else { "s" }
            ));
        }
        if bits.is_empty() {
            bits.push("no payload".into());
        }
        format!("plugin {} (v{} - {})", p.name, p.version, bits.join(", "))
    }
    match op {
        "list" => {
            let plugins = crate::core::agent::plugins::installed(&root);
            if rest.is_empty() {
                if plugins.is_empty() {
                    app.note("no plugins installed (try /plugin install <git-url>)");
                    return;
                }
                for p in &plugins {
                    app.push(Line::styled(summary_line(p), Style::new().cyan().bold()));
                }
            } else {
                match crate::core::agent::plugins::find_installed(&root, &rest) {
                    Some((directory, p)) => {
                        app.push(Line::styled(summary_line(&p), Style::new().cyan().bold()));
                        if !p.description.is_empty() {
                            app.push(Line::styled(
                                format!("  {}", p.description),
                                Style::new().dim(),
                            ));
                        }
                        let metas =
                            crate::core::agent::skills::plugin_skill_metas(&root, &directory);
                        if !metas.is_empty() {
                            app.push(Line::styled("  skills:", Style::new().dim()));
                            for meta in metas {
                                app.push(Line::styled(
                                    format!("    {}", meta.name),
                                    Style::new().dim(),
                                ));
                            }
                        }
                        let commands = crate::core::agent::plugin_commands::discover(&root)
                            .into_iter()
                            .filter(|e| e.plugin == directory)
                            .collect::<Vec<_>>();
                        if !commands.is_empty() {
                            app.push(Line::styled("  commands:", Style::new().dim()));
                            for cmd in &commands {
                                app.push(Line::styled(
                                    format!("    {}", cmd.name),
                                    Style::new().dim(),
                                ));
                            }
                        }
                        let agents =
                            crate::core::agent::subagent::plugin_agent_metas(&root, &directory);
                        if !agents.is_empty() {
                            app.push(Line::styled("  agents:", Style::new().dim()));
                            for (name, _) in &agents {
                                app.push(Line::styled(format!("    {name}"), Style::new().dim()));
                            }
                        }
                    }
                    None => app.note(&format!("plugin '{}' is not installed", rest)),
                }
            }
            app.gap(Kind::Meta);
        }
        "install" => {
            if rest.is_empty() {
                app.note("usage: /plugin install <git-url[#ref]> | <marketplace-name>");
                return;
            }
            // The clone is network-bound, so the install runs off the render
            // loop (see the loop's `plugin_install_request` handling); if we
            // awaited it inline, the TUI would freeze for the whole clone.
            // Refuse a second request while one is in flight.
            if app.plugin_installing {
                app.note("a plugin install is already in progress");
                return;
            }
            app.plugin_install_request = Some(rest);
            app.note("installing plugin...");
        }
        "remove" => {
            if rest.is_empty() {
                app.note("usage: /plugin remove <name>");
                return;
            }
            match crate::core::agent::plugins::remove(&root, &rest) {
                Ok(()) => {
                    app.refresh_slash_catalog();
                    app.note(&format!("removed plugin '{rest}'"));
                }
                Err(e) => app.note(&e),
            }
        }
        "search" => match crate::core::agent::plugins::search(&root, &rest).await {
            Ok(entries) if entries.is_empty() => {
                app.note("no marketplace plugins match (set [plugins] marketplace in agent.toml to enable)");
            }
            Ok(entries) => {
                for e in &entries {
                    app.push(Line::styled(
                        format!("plugin {}", e.name),
                        Style::new().cyan().bold(),
                    ));
                    app.push(Line::styled(
                        format!("  {}  ({})", e.description, e.repo),
                        Style::new().dim(),
                    ));
                }
                app.gap(Kind::Meta);
            }
            Err(e) => app.note(&e),
        },
        other => app.note(&format!(
            "unknown /plugin subcommand '{other}' (try list|install|remove|search)"
        )),
    }
}

/// Print the active goal's condition, turn count, duration, and the evaluator's
/// latest reason. Notes when there is no goal.
pub(super) fn show_goal_status(app: &mut App) {
    use crate::core::agent::goal::GoalStatus;
    let Some(goal) = app.goal.clone() else {
        app.note("no active goal (set one with /goal <condition>)");
        return;
    };
    let state = match goal.status {
        GoalStatus::Active => "active",
        GoalStatus::Achieved => "achieved",
    };
    app.system_marked(GOAL_GLYPH, Level::Info, &format!("goal [{state}]"));
    app.system_detail_text(&format!("condition: {}", goal.condition));
    app.system_detail_text(&format!(
        "turns: {}   duration: {}",
        goal.turns,
        fmt_duration(goal.elapsed_secs())
    ));
    let reason = if goal.last_reason.is_empty() {
        "(not evaluated yet)"
    } else {
        &goal.last_reason
    };
    app.system_detail_text(&format!("evaluator: {reason}"));
}

/// Set a new goal from `condition` and immediately start a turn toward it (the
/// condition is the first prompt). Replaces any existing goal.
pub(super) fn set_goal(app: &mut App, condition: &str) {
    use crate::core::agent::goal::GoalState;
    if app.status != Status::Idle {
        app.note("cannot set a goal while a turn is running");
        return;
    }
    let goal = GoalState::new(condition);
    let cond = goal.condition.clone();
    app.goal = Some(goal);
    app.goal_eval_pending = false;
    app.note(&format!("◎ goal set: {cond}"));
    // Start the first turn with the condition as the prompt; on_done triggers
    // the evaluator, which drives the loop from there.
    app.submit_user(cond);
}

/// Format a duration in whole seconds as `Nh Nm Ns` / `Nm Ns` / `Ns`.
pub(super) fn fmt_duration(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h {m}m {s}s")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

/// Display name for a saved thread: its summarized `title` when present, else a
/// snippet of the last user message (so untitled threads still show content),
/// else `(untitled)`.
pub(super) fn thread_display_name(base: &std::path::Path, id: &str, title: Option<&str>) -> String {
    if let Some(t) = title.map(str::trim).filter(|s| !s.is_empty()) {
        return t.to_string();
    }
    if let Ok(messages) = super::super::cli_list_messages_in(base, id) {
        if let Some(last_user) = messages.iter().rev().find(|m| {
            m.get("role").and_then(|v| v.as_str()) == Some("user")
                && !crate::core::agent::reminder::is_reminder_text(&message_text(m))
        }) {
            let collapsed = message_text(last_user)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !collapsed.is_empty() {
                return truncate(&collapsed, 60);
            }
        }
    }
    "(untitled)".to_string()
}

/// Load saved threads and open the interactive picker (Enter selects). Falls
/// back to a note when there is nothing to resume.
pub(super) fn open_thread_picker(app: &mut App) {
    match super::super::list_threads_in(&app.agent_dir) {
        Ok(threads) if threads.is_empty() => app.note("no saved threads found"),
        Ok(mut threads) => {
            sort_threads_recent(&mut threads);
            let base = app.agent_dir.clone();
            let items = threads
                .iter()
                .filter_map(|t| {
                    let id = t.get("id").and_then(|v| v.as_str())?.to_string();
                    let label =
                        thread_display_name(&base, &id, t.get("title").and_then(|v| v.as_str()));
                    let hint = Some(id.chars().take(8).collect());
                    Some(PickerItem {
                        value: id,
                        label,
                        hint,
                        checkbox: None,
                    })
                })
                .collect::<Vec<_>>();
            if items.is_empty() {
                app.note("no saved threads found");
            } else {
                app.picker = Some(Picker {
                    kind: PickerKind::ResumeThread,
                    items,
                    selected: 0,
                    armed_delete: None,
                });
            }
        }
        Err(e) => app.note(&format!("failed to list threads: {e}")),
    }
}

/// Open the `/model` hub listing the `provider / model` pairs this build can
/// actually run, with the current raw model pre-highlighted. Providers with no
/// configured list are probed by the chat loop off the render loop, and the
/// picker is refreshed when their models arrive.
pub(super) async fn open_model_picker(app: &mut App) {
    if !app.model_fetch_running {
        app.model_fetch_request = true;
    }
    if !show_model_picker(app, false) {
        app.model_fetch_wants_picker = true;
        app.note("fetching models...");
    }
}

/// Show the model picker from the providers on disk. With `final_answer`, an
/// empty list is reported; otherwise the caller waits for the fetch. Returns
/// whether a picker is open.
pub(super) fn show_model_picker(app: &mut App, final_answer: bool) -> bool {
    let pairs = super::super::providers::list_provider_models(Some(&app.project_root));
    match ModelPicker::from_pairs(pairs, &app.model) {
        Some(picker) => {
            app.picker = None;
            app.model_picker = Some(picker);
            true
        }
        None => {
            if final_answer {
                app.note(
                    "no models available (add a provider with `flint config set`, or configure one in the desktop app)",
                );
            }
            false
        }
    }
}

/// What a background model-list fetch returns: its result and the probed set.
pub(super) type ModelFetchDone = (Result<bool, String>, std::collections::HashSet<String>);

pub(super) async fn fetch_models_job(
    project_root: PathBuf,
    mut probed: std::collections::HashSet<String>,
) -> ModelFetchDone {
    let result = super::super::providers::fetch_missing_models(Some(&project_root), &mut probed).await;
    (result, probed)
}

pub(super) async fn await_model_fetch(
    task: &mut Option<tokio::task::JoinHandle<ModelFetchDone>>,
) -> Option<ModelFetchDone> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.ok()
}

/// Apply a finished model-list fetch: record what was probed, reload the
/// providers when lists were discovered, and refresh or open the picker.
pub(super) async fn finish_model_fetch(app: &mut App, (result, probed): ModelFetchDone) {
    app.model_fetch_running = false;
    app.probed_models.extend(probed);
    let wants_picker = std::mem::take(&mut app.model_fetch_wants_picker);
    match result {
        Ok(true) => {
            // The discovered ids now live on disk; refresh the session's
            // in-memory provider snapshot so a picked model resolves on the
            // next run without a restart (#8688 parallels the /login reload).
            reload_provider_configs(app).await;
            app.note("fetched models for provider(s) with no configured list");
            if wants_picker || app.model_picker.is_some() {
                show_model_picker(app, wants_picker);
            }
        }
        Ok(_) => {
            if wants_picker {
                show_model_picker(app, true);
            }
        }
        Err(e) => {
            app.note(&format!("could not fetch models: {e}"));
            if wants_picker {
                show_model_picker(app, true);
            }
        }
    }
}

/// Run a fetch `/model` queued, inline: what the chat loop does in the
/// background, for tests that drive commands without the loop.
#[cfg(test)]
pub(super) async fn run_pending_model_fetch(app: &mut App) {
    if std::mem::take(&mut app.model_fetch_request) {
        app.model_fetch_running = true;
        let done = fetch_models_job(app.project_root.clone(), app.probed_models.clone()).await;
        finish_model_fetch(app, done).await;
    }
}

/// Action ids for the `McpServer` detail screen. String values rather than an
/// enum because `PickerItem::value` is the picker's one payload; keeping them
/// as constants is what stops the key handler and the row builder from drifting.
pub(super) const MCP_ACTION_TOOLS: &str = "tools";

pub(super) const MCP_ACTION_AUTH: &str = "auth";

pub(super) const MCP_ACTION_CLEAR_AUTH: &str = "clear-auth";

pub(super) const MCP_ACTION_RECONNECT: &str = "reconnect";

pub(super) const MCP_ACTION_TOGGLE: &str = "toggle";

pub(super) const MCP_ACTION_EDIT: &str = "edit";

pub(super) const MCP_ACTION_REMOVE: &str = "remove";

/// Open the `/mcp` screen: one row per configured server, with its live state.
///
/// An empty config opens the screen anyway, on a watermark row (the same shape
/// `open_provider_settings` uses). Returning a note instead left a fresh install
/// with no way *in* to the thing `/mcp` manages -- `a` to add is only reachable
/// once the picker exists, so the one state that most needs the add wizard was
/// the one state that could not reach it.
pub(super) async fn open_mcp_picker(app: &mut App, mcp_servers: &crate::core::state::SharedMcpServers) {
    let servers = super::super::mcp::list_servers();
    let items: Vec<PickerItem> = if servers.is_empty() {
        vec![PickerItem {
            label: "no MCP servers configured - press a to add one".to_string(),
            value: String::new(),
            hint: None,
            checkbox: None,
        }]
    } else {
        // One lock for the whole list: `describe` per row would take and drop it
        // N times, and nothing here goes to the network.
        let connected: std::collections::HashSet<String> =
            mcp_servers.lock().await.keys().cloned().collect();
        servers
            .into_iter()
            .map(|s| {
                let state = if !s.active {
                    "disabled".to_string()
                } else if connected.contains(&s.name) {
                    "connected".to_string()
                } else {
                    match super::super::mcp::auth_status(&s.name, &s.config) {
                        crate::core::mcp::oauth::AuthStatus::Unauthenticated
                        | crate::core::mcp::oauth::AuthStatus::Expired { .. }
                        | crate::core::mcp::oauth::AuthStatus::StaleResource
                        | crate::core::mcp::oauth::AuthStatus::ScopeMismatch { .. } => {
                            "needs auth".to_string()
                        }
                        crate::core::mcp::oauth::AuthStatus::InvalidScopes { .. } => {
                            "invalid oauth scopes".to_string()
                        }
                        _ => "not connected".to_string(),
                    }
                };
                PickerItem {
                    label: format!("{}  {state}", s.name),
                    value: s.name,
                    hint: None,
                    checkbox: Some(s.active),
                }
            })
            .collect()
    };
    app.mcp_detail = None;
    app.picker = Some(Picker {
        kind: PickerKind::ToggleMcp,
        items,
        selected: 0,
        armed_delete: None,
    });
}

/// Open the `/agents` inspector: the live list of running subagents. The rows
/// are rebuilt from `App::subagents` every frame (see `draw`), so this only
/// seeds the initial list; the empty state is a single watermark row.
pub(super) fn open_agents_picker(app: &mut App) {
    app.agent_detail = None;
    app.picker = Some(Picker {
        kind: PickerKind::Agents,
        items: agent_picker_items(&app.subagents),
        selected: 0,
        armed_delete: None,
    });
}

/// Open the live list of shell commands detached by the `bash` tool.
pub(super) fn open_background_shells_picker(app: &mut App) {
    app.picker = Some(Picker {
        kind: PickerKind::BackgroundShells,
        items: background_shell_picker_items(&app.active_bg_jobs, &app.bash_jobs),
        selected: 0,
        armed_delete: None,
    });
}

/// One row per detached shell. The TUI only knows jobs started in this session;
/// the command is retained when the backgrounding notice lands so the row is
/// useful without exposing the opaque job id alone.
pub(super) fn background_shell_picker_items(
    active: &std::collections::HashSet<String>,
    commands: &HashMap<String, String>,
) -> Vec<PickerItem> {
    if active.is_empty() {
        return vec![PickerItem {
            label: "no background shells running".to_string(),
            value: String::new(),
            hint: None,
            checkbox: None,
        }];
    }
    let mut jobs: Vec<&String> = active.iter().collect();
    jobs.sort();
    jobs.into_iter()
        .map(|job| PickerItem {
            label: commands
                .get(job)
                .map(|command| format!("{job}  {command}"))
                .unwrap_or_else(|| job.clone()),
            value: job.clone(),
            hint: Some("running".to_string()),
            checkbox: None,
        })
        .collect()
}

/// One row per running subagent (`name  ·  Nt · w-K  ·  <activity>`), or a
/// single watermark row when the fan-out is empty. The row `value` is the
/// child's `run_id`, which Enter drills into.
pub(super) fn agent_picker_items(subagents: &[SubagentPanel]) -> Vec<PickerItem> {
    if subagents.is_empty() {
        return vec![PickerItem {
            label: "no subagents running".to_string(),
            value: String::new(),
            hint: None,
            checkbox: None,
        }];
    }
    subagents
        .iter()
        .map(|p| {
            PickerItem {
                label: format!(
                    "{}  ·  {}t  ·  {}",
                    p.name,
                    p.calls.len(),
                    panel_activity_summary(p)
                ),
                value: p.run_id.clone(),
                hint: None,
                checkbox: None,
            }
        })
        .collect()
}

/// A one-line "what this agent is doing now" for an immutable panel (the
/// `/agents` inspector), mirroring the live dock's logic in `agents_column` but
/// without the streaming argument preview (`StartingCall::activity_label` needs
/// `&mut`; the tool name is enough here). A spin of identical calls collapses to
/// `label ×N` so a stuck worker reads as stuck.
pub(super) fn panel_activity_summary(panel: &SubagentPanel) -> String {
    let repeats = trailing_repeat(&panel.calls);
    if repeats >= STUCK_REPEAT_THRESHOLD {
        return format!("{} ×{repeats}", panel.calls.last().cloned().unwrap_or_default());
    }
    if let Some(call) = panel.active.as_ref() {
        return format!("{}…", call.name);
    }
    match panel.calls.last() {
        Some(last) if repeats > 1 => format!("{last} ×{repeats}"),
        Some(last) => last.clone(),
        None if panel.queued => format!("queued ({})", panel.waiting),
        None => "starting…".to_string(),
    }
}

/// Group consecutive identical labels into `(label, count)` runs, preserving
/// order, so a repeated call renders once as `label ×N` instead of N rows.
pub(super) fn collapse_runs(calls: &[String]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    for c in calls {
        match out.last_mut() {
            Some(run) if &run.0 == c => run.1 += 1,
            _ => out.push((c.clone(), 1)),
        }
    }
    out
}

pub(super) fn open_login_picker(app: &mut App) {
    open_login_picker_at(app, None);
}

/// Open the detail screen for one server: the info block plus the actions that
/// apply to it. Everything shown is local, so this opens in one frame; the tool
/// list is requested as a job and fills in when it lands.
pub(super) async fn open_mcp_detail(
    app: &mut App,
    name: &str,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    let Some(server) = super::super::mcp::describe(name, mcp_servers).await else {
        app.mcp_detail = None;
        return app.note(&format!("server '{name}' no longer exists"));
    };
    let tools = if server.connected {
        app.mcp_job_request = Some(McpJob::Tools(name.to_string()));
        ToolsState::Loading
    } else {
        ToolsState::Unavailable
    };
    app.picker = Some(Picker {
        kind: PickerKind::McpServer,
        items: mcp_action_items(&server),
        selected: 0,
        armed_delete: None,
    });
    app.mcp_detail = Some(McpDetail { server, tools });
}

/// The actions offered for one server, filtered to what its state can actually
/// do: a stdio server has nothing to authenticate, and a disconnected one has no
/// tools to list.
pub(super) fn mcp_action_items(server: &super::super::mcp::ServerDetail) -> Vec<PickerItem> {
    use crate::core::mcp::oauth::AuthStatus;
    let mut actions: Vec<(&str, String)> = Vec::new();
    if server.connected {
        actions.push((MCP_ACTION_TOOLS, "View tools".to_string()));
    }
    match server.auth {
        // A pipe has nothing to authorize, and a hand-written header is the
        // user's own credential -- offering to overwrite it with OAuth would be
        // offering to break it.
        AuthStatus::NotApplicable | AuthStatus::StaticHeader => {}
        // Anything with tokens on disk can be renewed *and* forgotten, whether
        // they still work or not.
        // A configuration that cannot be read has to be fixed first: signing in
        // under scopes nobody can state would authorize nothing sensible.
        AuthStatus::InvalidScopes { .. } => {}
        AuthStatus::Authenticated { .. }
        | AuthStatus::Expired { .. }
        | AuthStatus::StaleResource
        | AuthStatus::ScopeMismatch { .. } => {
            actions.push((MCP_ACTION_AUTH, "Re-authenticate".to_string()));
            actions.push((MCP_ACTION_CLEAR_AUTH, "Clear authentication".to_string()));
        }
        AuthStatus::Unauthenticated => {
            actions.push((MCP_ACTION_AUTH, "Authenticate".to_string()));
        }
    }
    if server.active {
        actions.push((MCP_ACTION_RECONNECT, "Reconnect".to_string()));
        actions.push((MCP_ACTION_TOGGLE, "Disable".to_string()));
    } else {
        actions.push((MCP_ACTION_TOGGLE, "Enable".to_string()));
    }
    actions.push((MCP_ACTION_EDIT, "Edit configuration".to_string()));
    actions.push((MCP_ACTION_REMOVE, "Remove server".to_string()));

    actions
        .into_iter()
        .enumerate()
        .map(|(i, (value, label))| PickerItem {
            // Numbered like the rest of the screen reads: the hint column is
            // already the dim prefix slot, so this costs no extra layout.
            hint: Some(format!("{}.", i + 1)),
            label,
            value: value.to_string(),
            checkbox: None,
        })
        .collect()
}

pub(super) fn open_login_picker_at(app: &mut App, selected_provider: Option<&str>) {
    let mut providers = crate::core::cli::auth::provider_catalog();
    // Pin Tokamak to the top (the default provider), then list the rest in
    // name order so the picker is stable and predictable.
    providers.sort_by(|a, b| match (a.id == "tokamak", b.id == "tokamak") {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(b.name),
    });
    let items = providers
        .into_iter()
        .map(|provider| {
            let status =
                if super::super::providers::provider_is_signed_in(Some(&app.project_root), provider.id) {
                    "signed in"
                } else {
                    "not signed in"
                };
            PickerItem {
                value: provider.id.to_string(),
                label: format!("{} ({})", provider.name, provider.id),
                hint: Some(status.to_string()),
                checkbox: None,
            }
        })
        .collect::<Vec<_>>();
    let selected = selected_provider
        .and_then(|provider| items.iter().position(|item| item.value == provider))
        .unwrap_or(0);
    app.picker = Some(Picker {
        kind: PickerKind::LoginProvider,
        items,
        selected,
        armed_delete: None,
    });
}

/// `/login [--paste-token]`: choose a provider, or skip directly to Tokamak's
/// legacy API-key field.
pub(super) fn login_command(app: &mut App, arg: &str) {
    if app.login.is_some()
        || app
            .picker
            .as_ref()
            .is_some_and(|picker| picker.kind == PickerKind::LoginProvider)
    {
        app.note("a sign-in is already in progress - press Esc to cancel it first");
        return;
    }
    match arg.split_whitespace().next() {
        Some("--paste-token" | "--paste") => open_login_prompt(app, "tokamak"),
        Some(other) => app.note(&format!(
            "/login: unknown option {other} (try --paste-token)"
        )),
        None => open_login_picker(app),
    }
}

/// Start `/login`: the browser-approval flow. The dock opens immediately, so
/// there is something to Esc out of while the session is being created, and
/// `chat_loop` picks the request up off the render loop.
pub(super) fn open_login(app: &mut App) {
    app.login = Some(LoginPrompt::connecting());
    app.login_device_request = true;
}

/// The session exists: show the code to check and the page to approve on, and
/// open the browser. The URL goes to the transcript as well as the dock, so a
/// remote or headless session can still be finished by hand -- or from a phone.
pub(super) fn show_login_approval(app: &mut App, session: &super::super::device_auth::Session) {
    app.note("sign in to Tokamak in your browser - confirm this code matches:");
    app.system_detail(vec![Span::styled(
        session.user_code.clone(),
        Style::new().cyan().bold(),
    )]);
    app.system_detail(vec![Span::styled(
        session.authorize_url.clone(),
        Style::new().cyan(),
    )]);
    app.login = Some(LoginPrompt {
        stage: LoginStage::Approving {
            user_code: session.user_code.clone(),
            authorize_url: session.authorize_url.clone(),
            confirm_open: true,
        },
        ..LoginPrompt::new("tokamak")
    });
}

/// Act on an answered "open a browser?" question: launch it, or say we didn't.
/// Either way the URL is already in the transcript, so declining is a valid way
/// to finish the flow on another device rather than a way to abandon it. Shared
/// by `/login` and `/mcp`, which ask the same question in different docks.
pub(super) fn open_browser_reporting(app: &mut App, url: &str, open: bool) {
    if !open {
        app.system_detail_text("not opening a browser - use the URL above on any device");
        return;
    }
    match super::super::browser::open(url) {
        Ok(()) => app.system_detail_text("opening that page in your browser"),
        Err(e) => app.system_detail_text(&format!("could not open a browser ({e})")),
    }
}

/// Answer the question the `/login` dock is holding. The dock moves on either
/// way, so the sign-in is never blocked on a browser.
pub(super) fn resolve_login_browser(app: &mut App, open: bool) {
    let Some(url) = app.login.as_ref().and_then(LoginPrompt::unconfirmed_url) else {
        return;
    };
    open_browser_reporting(app, &url, open);
    if let Some(prompt) = app.login.as_mut() {
        prompt.stage.mark_confirmed();
    }
}

/// Answer the standalone `/mcp` question. The authorization is already waiting on
/// its loopback listener, so declining just means the user opens the URL
/// themselves -- the redirect still completes the sign-in.
pub(super) fn resolve_mcp_browser(app: &mut App, open: bool) {
    let Some(confirm) = app.browser_confirm.take() else {
        return;
    };
    if open {
        open_browser_reporting(app, &confirm.url, true);
    } else {
        // The url is pinned on the `/mcp` screen, but a session that can't open
        // a browser also gets a durable transcript copy so it survives leaving
        // the screen and can be copied on a remote host.
        app.note("open this URL to finish signing in:");
        app.system_detail(vec![Span::styled(
            confirm.url.clone(),
            Style::new().cyan(),
        )]);
    }
}

pub(super) fn logout_command(app: &mut App, provider: &str) {
    if provider.trim().is_empty() {
        return app.note("usage: /logout <provider>");
    }
    let owned_model = crate::core::agent::global_config::load_global_config()
        .ok()
        .and_then(|configs| configs.get(provider).cloned())
        .is_some_and(|config| config.models.iter().any(|model| model == &app.model));
    match crate::core::cli::auth::providers::logout(provider) {
        Ok(()) => {
            if owned_model {
                app.set_model(String::new());
            }
            app.note(&format!("signed out of {provider}"));
        }
        Err(error) => app.note(&format!("could not sign out: {error:?}")),
    }
}

/// Sign out of a provider from the pickers: clear the stored credential (API
/// key or OAuth token) but keep the provider entry and its model list in
/// `~/.jan/config.toml`, so a re-login is one Enter away. Distinct from
/// [`logout_command`] (which also removes the config entry) and from the
/// provider-settings `d` delete.
pub(super) fn sign_out_provider(app: &mut App, provider: &str) {
    match crate::core::cli::auth::CredentialStore::delete(provider) {
        Ok(()) => app.note(&format!("signed out of {provider} (provider config kept)")),
        Err(error) => app.note(&format!("could not sign out: {error}")),
    }
}

pub(super) fn open_login_prompt(app: &mut App, provider: &str) {
    let Some(definition) = crate::core::cli::auth::provider_by_id(provider) else {
        return app.note("selected provider is unavailable");
    };
    if crate::core::cli::auth::has_removed_account_login(provider) {
        app.note(crate::core::cli::auth::REMOVED_ACCOUNT_LOGIN_NOTICE);
    }
    app.note(&format!("sign in to {} with an API key:", definition.name));
    app.system_detail(vec![Span::styled(
        definition.api_key.keys_url,
        Style::new().cyan(),
    )]);
    app.login = Some(LoginPrompt::new(provider));
}

pub(super) fn finish_login(
    app: &mut App,
    result: Result<crate::core::cli::auth::LoginResult, crate::core::cli::auth::LoginError>,
) {
    match result {
        Ok(login) => {
            app.login = None;
            app.note(&login_success_message(&login.provider));
            adopt_login_model(app, &login);
        }
        Err(error) => {
            let Some((provider, retryable)) = app.login.as_ref().map(|prompt| {
                (
                    prompt.provider.clone(),
                    prompt.editable() || prompt.verifying,
                )
            }) else {
                return;
            };
            let message = login_error_message(&provider, error);
            if retryable {
                if let Some(prompt) = app.login.as_mut() {
                    prompt.verifying = false;
                    prompt.input.clear();
                    prompt.error = Some(message);
                }
            } else {
                app.login = None;
                app.note(&format!("sign-in failed: {message}"));
            }
        }
    }
}

pub(super) fn finish_tokamak_login(app: &mut App, result: Result<super::super::tokamak::Login, String>) -> bool {
    match result {
        Ok(login) => {
            let super::super::tokamak::Login {
                models,
                config_path,
                default_model,
                replaced_default,
                account,
            } = login;
            if replaced_default {
                app.note("your previous default model is no longer offered by any provider; it was replaced");
            }
            finish_login(
                app,
                Ok(crate::core::cli::auth::LoginResult {
                    provider: "tokamak".to_string(),
                    models,
                    config_path,
                    default_model,
                }),
            );
            if let Some(account) = account {
                app.note(&format!("signed in to Tokamak as {account}"));
            }
            if let Some(warning) = super::super::tokamak::expiry_warning() {
                app.note(&warning);
            }
            true
        }
        Err(error) => {
            finish_login(app, Err(crate::core::cli::auth::LoginError::OAuth(error)));
            false
        }
    }
}

pub(super) fn login_success_message(provider: &str) -> String {
    format!("signed in to {provider}. Use /model to select a model.")
}

pub(super) fn login_error_message(provider: &str, error: crate::core::cli::auth::LoginError) -> String {
    let message = match error {
        crate::core::cli::auth::LoginError::InvalidKey(message)
        | crate::core::cli::auth::LoginError::Unavailable(message) => message,
        crate::core::cli::auth::LoginError::Persist(_) => {
            "could not save sign-in securely".to_string()
        }
        crate::core::cli::auth::LoginError::OAuth(_) => {
            "could not complete browser sign-in".to_string()
        }
        crate::core::cli::auth::LoginError::Unauthorized => {
            "that API key was not accepted".to_string()
        }
        crate::core::cli::auth::LoginError::RateLimited => {
            "that API key is rate limited - wait and try again".to_string()
        }
    };
    format!("{provider} sign-in failed: {message}")
}

pub(super) fn adopt_login_model(app: &mut App, login: &crate::core::cli::auth::LoginResult) {
    let runnable = super::super::providers::list_provider_models(Some(&app.project_root));
    if runnable.iter().any(|(_, model)| *model == app.model) {
        return;
    }
    if let Some(model) = login.models.first() {
        app.adopt_model(model.clone());
        let _ = super::super::cli_set_project_model(&app.agent_dir, &app.model);
    }
}

/// Re-read `~/.jan/config.toml` (plus desktop and project layers) into the
/// session's in-memory `args.provider_configs` map. Must be called after any
/// mid-session credential write (`/login`, `flint config set`) because
/// `prepare_agent_session` snapshots the provider map once at startup and
/// never re-reads it. Without this, the first turn after sign-in fails
/// upstream resolution (`"No upstream session found for model ..."`) and
/// requires a restart.
pub(super) async fn reload_provider_configs(app: &mut App) {
    let Some(args) = app.args.clone() else {
        return;
    };
    let project_root = app.project_root.clone();
    match super::super::providers::load_provider_configs(
        Some(&project_root),
        &super::super::providers::ProviderOverrides::default().with_env(),
    ) {
        Ok(configs) => {
            *args.provider_configs.lock().await = configs;
        }
        Err(e) => {
            app.note(&format!(
                "could not reload provider config after sign-in: {e}"
            ));
        }
    }
}

/// `/reload`: re-read what is normally read once at startup, without leaving
/// the session -- provider config, the skills and plugin commands the slash
/// popup offers, and the MCP servers in `mcp_config.json`.
///
/// Skills are read from disk when a turn starts, so this only has to refresh
/// the popup's snapshot. MCP is reconciled against the file: a server that is
/// no longer configured or no longer enabled is disconnected, and every enabled
/// one is reconnected in the background so a changed command, URL or header
/// takes effect. Runs only while idle (see `run_command`).
pub(super) async fn reload_command(app: &mut App, mcp_servers: &crate::core::state::SharedMcpServers) {
    reload_provider_configs(app).await;
    app.refresh_slash_catalog();

    let enabled: Vec<String> = super::super::mcp::list_servers()
        .into_iter()
        .filter(|entry| entry.active)
        .map(|entry| entry.name)
        .collect();
    let connected: Vec<String> = mcp_servers.lock().await.keys().cloned().collect();
    let mut dropped = 0usize;
    for name in connected.iter().filter(|n| !enabled.contains(n)) {
        super::super::mcp::disconnect(name, mcp_servers).await;
        dropped += 1;
    }
    for name in &enabled {
        let servers = mcp_servers.clone();
        let name = name.clone();
        tokio::spawn(async move {
            super::super::mcp::disconnect(&name, &servers).await;
            if let Err(e) = connect_mcp_server(&name, &servers).await {
                log::warn!("MCP: {e}");
            }
        });
    }

    app.note(&format!(
        "reloaded: provider config, {} skill(s), {} plugin command(s); \
         MCP: {} server(s) reconnecting in the background, {} disconnected",
        app.slash_catalog.skills.len(),
        app.slash_catalog.commands.len(),
        enabled.len(),
        dropped,
    ));
}

/// `/terminal-setup`: teach the host terminal to send `Shift+Enter`. See
/// `terminal_setup` for why a terminal-side binding is the only reliable route.
pub(super) fn terminal_setup_command(app: &mut App) {
    use super::super::terminal_setup::{apply, Outcome};
    let Some(home) = crate::core::app::commands::jan_home_dir() else {
        app.system(Level::Error, "no home directory for terminal config");
        return;
    };
    app.note("terminal setup:");
    for outcome in apply(&home, cfg!(target_os = "macos"), |k| std::env::var(k).ok()) {
        match outcome {
            Outcome::Works(why) => {
                app.system_detail_text(&format!("Shift+Enter already works -- {why}"));
            }
            Outcome::AlreadyDone(path) => {
                app.system_detail_text(&format!("already configured: {}", tilde_path(&path)));
            }
            Outcome::Wrote { path, detail } => {
                app.system_detail_text(&format!("wrote {} -- {detail}", tilde_path(&path)));
            }
            Outcome::Failed { path, error } => {
                app.system_detail_text(&format!("could not write {}: {error}", tilde_path(&path)));
            }
            Outcome::Manual { title, steps } => {
                app.system_detail_text(&title);
                for step in steps {
                    app.system_detail_text(&format!("  - {step}"));
                }
            }
        }
    }
    app.system_detail_text("Alt+Enter and Ctrl-J insert a newline on every terminal");
}

/// Open the `/config` screen: a read-only view of the providers configured in
/// `~/.jan/config.toml` (the standalone-agent credential store), with API keys
/// redacted. Editing is headless via `flint config set/unset` (shown in the
/// footer), since a TUI is not the safe place to type secrets.
pub(super) fn open_config_screen(app: &mut App) {
    let configs = match crate::core::agent::global_config::load_global_config() {
        Ok(c) => c,
        Err(e) => return app.note(&format!("failed to read ~/.jan/config.toml: {e}")),
    };
    let mut providers: Vec<_> = configs.into_values().collect();
    providers.sort_by(|a, b| a.provider.cmp(&b.provider));

    let items: Vec<PickerItem> = if providers.is_empty() {
        vec![PickerItem {
            label: "no providers configured - run: flint config set --provider <id> --api-key <key>"
                .to_string(),
            value: String::new(),
            hint: None,
            checkbox: None,
        }]
    } else {
        providers
            .into_iter()
            .map(|c| {
                let key = if c.api_key.is_some() {
                    "key set"
                } else {
                    "no key"
                };
                let base = c.base_url.as_deref().unwrap_or("default url");
                PickerItem {
                    label: format!("{key}  {base}  {} model(s)", c.models.len()),
                    value: c.provider.clone(),
                    hint: Some(c.provider),
                    checkbox: None,
                }
            })
            .collect()
    };
    app.picker = Some(Picker {
        kind: PickerKind::ViewConfig,
        items,
        selected: 0,
        armed_delete: None,
    });
}

/// Run one `McpJob`. Off the render loop: every arm either talks to a peer or
/// waits on the user's browser.
pub(super) async fn run_mcp_job(job: McpJob, servers: crate::core::state::SharedMcpServers) -> McpJobDone {
    match job {
        McpJob::Tools(server) => {
            let result = super::super::mcp::list_tools(&server, &servers).await;
            McpJobDone::Tools { server, result }
        }
        McpJob::BeginAuth(server) => {
            let result = super::super::mcp::begin_auth(&server).await.map(Box::new);
            McpJobDone::AuthStarted { server, result }
        }
        McpJob::Authorize { server, pending } => {
            let result = super::super::mcp::finish_auth(*pending).await.map(|_| ());
            McpJobDone::Authorized { server, result }
        }
        McpJob::Connect(server) => {
            let result = connect_mcp_server(&server, &servers).await;
            McpJobDone::Connected { server, result }
        }
    }
}

/// Fold a finished job back into the screen. `job` is passed in so the
/// two-phase authorization can chain its second half without going back through
/// `mcp_job_request` -- the loop owns the slot, and round-tripping a `PendingAuth`
/// through `App` would park a bound listener in UI state.
pub(super) async fn finish_mcp_job(
    app: &mut App,
    done: McpJobDone,
    mcp_servers: &crate::core::state::SharedMcpServers,
    job: &mut Option<tokio::task::JoinHandle<McpJobDone>>,
) {
    match done {
        McpJobDone::Tools { server, result } => {
            // Only apply it if the screen is still showing that server: the user
            // may have navigated on while the listing was in flight.
            let Some(detail) = app.mcp_detail.as_mut() else {
                return;
            };
            if detail.server.name != server {
                return;
            }
            detail.tools = match result {
                Ok(names) => ToolsState::Ready(names),
                Err(e) => ToolsState::Failed(e),
            };
        }
        McpJobDone::AuthStarted { server, result } => match result {
            Ok(pending) => {
                // The `/mcp` screen shows a spinning "waiting for sign-in" with a
                // cancel hint; the consent url is carried on `browser_confirm`
                // (below) to open, never printed on this screen where it would
                // wrap and be click-truncated.
                if let Some(flow) = app.mcp_auth.as_mut().filter(|f| f.server == server) {
                    flow.stage = McpAuthStage::AwaitingRedirect;
                }
                // Ask before launching anything. The authorization is spawned
                // regardless: its listener is already bound, so the redirect
                // completes the sign-in whether the page is opened here or by
                // hand somewhere else.
                app.browser_confirm = Some(BrowserConfirm {
                    url: pending.authorization_url.clone(),
                    purpose: format!("authorize '{server}'"),
                });
                let servers = mcp_servers.clone();
                *job = Some(tokio::spawn(run_mcp_job(
                    McpJob::Authorize { server, pending },
                    servers,
                )));
            }
            Err(e) => {
                app.mcp_auth = None;
                app.note(&format!("could not start sign-in for '{server}': {e}"));
            }
        },
        McpJobDone::Authorized { server, result } => match result {
            Ok(()) => {
                // Answered or not, there is nothing left to open, and the
                // sign-in is done.
                app.browser_confirm = None;
                app.mcp_auth = None;
                app.note(&format!("authorized '{server}' - reconnecting..."));
                // The live connection (if any) predates the token, so it is
                // replaced rather than left unauthorized.
                super::super::mcp::disconnect(&server, mcp_servers).await;
                let servers = mcp_servers.clone();
                *job = Some(tokio::spawn(run_mcp_job(McpJob::Connect(server), servers)));
            }
            Err(e) => {
                app.browser_confirm = None;
                app.mcp_auth = None;
                app.note(&format!("sign-in for '{server}' failed: {e}"));
            }
        },
        McpJobDone::Connected { server, result } => {
            match result {
                Ok(()) => app.note(&format!("'{server}' connected")),
                Err(e) => app.note(&format!("MCP: {e}")),
            }
            if app
                .mcp_detail
                .as_ref()
                .is_some_and(|d| d.server.name == server)
            {
                open_mcp_detail(app, &server, mcp_servers).await;
            }
        }
    }
}

/// Fold a computed `/context` report into the overlay. Only applied when the
/// overlay is still open: a report that lands after the user closed it must
/// not reopen a popup they walked away from (mirrors how `finish_mcp_job`
/// drops a listing whose screen has been left).
pub(super) fn finish_context_report(app: &mut App, report: ContextReport) {
    if app.context_view.is_some() {
        app.context_view = Some(ContextView::Ready(Box::new(report)));
    }
}

/// Open the add/edit wizard prefilled from a configured server.
pub(super) fn edit_mcp_server(app: &mut App, name: &str) {
    match super::super::mcp::get_server(name) {
        Some(entry) => {
            app.picker = None;
            app.mcp_detail = None;
            app.mcp_prompt = Some(McpPrompt::from_entry(&entry));
        }
        None => app.note(&format!("server '{name}' no longer exists")),
    }
}

/// Drop a server from the config and disconnect it. Its OAuth tokens go too:
/// leaving them behind would silently re-authorize a later server that happened
/// to reuse the name.
pub(super) async fn remove_mcp_server(
    app: &mut App,
    name: &str,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    if let Err(e) = super::super::mcp::remove_server(name) {
        return app.note(&format!("failed to remove '{name}': {e}"));
    }
    super::super::mcp::disconnect(name, mcp_servers).await;
    let _ = super::super::mcp::clear_auth(name);
    app.mcp_detail = None;
    app.note(&format!("removed MCP server '{name}'"));
}

/// Run one detail-screen action. Anything that talks to a peer or waits on a
/// browser leaves as an `McpJob` instead of running here -- `handle_key` is on
/// the render loop.
pub(super) async fn run_mcp_action(
    app: &mut App,
    action: &str,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    let Some(detail) = app.mcp_detail.as_ref() else {
        return;
    };
    let name = detail.server.name.clone();
    match action {
        MCP_ACTION_TOOLS => show_mcp_tools(app),
        MCP_ACTION_AUTH => {
            app.mcp_auth = Some(McpAuthFlow {
                server: name.clone(),
                stage: McpAuthStage::Discovering,
            });
            app.mcp_job_request = Some(McpJob::BeginAuth(name));
        }
        MCP_ACTION_CLEAR_AUTH => {
            match super::super::mcp::clear_auth(&name) {
                Ok(true) => app.note(&format!("cleared stored credentials for '{name}'")),
                Ok(false) => app.note(&format!("'{name}' had no stored credentials")),
                Err(e) => app.note(&format!("could not clear credentials for '{name}': {e}")),
            }
            // The connection still holds the old bearer token, so it is dropped
            // too: leaving it up would report "authenticated" work against
            // credentials the user just asked to forget.
            super::super::mcp::disconnect(&name, mcp_servers).await;
            open_mcp_detail(app, &name, mcp_servers).await;
        }
        MCP_ACTION_RECONNECT => {
            super::super::mcp::disconnect(&name, mcp_servers).await;
            app.note(&format!("reconnecting '{name}'..."));
            open_mcp_detail(app, &name, mcp_servers).await;
            // Set after `open_mcp_detail`, which requests the tool list and
            // would otherwise overwrite this.
            app.mcp_job_request = Some(McpJob::Connect(name));
        }
        MCP_ACTION_TOGGLE => {
            let enable = !detail.server.active;
            let connect = set_mcp_active(app, mcp_servers, &name, enable)
                .await
                .unwrap_or(false);
            open_mcp_detail(app, &name, mcp_servers).await;
            if connect {
                // After `open_mcp_detail`, which requests the tool list and
                // would otherwise overwrite this.
                app.mcp_job_request = Some(McpJob::Connect(name));
            }
        }
        MCP_ACTION_EDIT => edit_mcp_server(app, &name),
        MCP_ACTION_REMOVE => {
            app.picker = None;
            remove_mcp_server(app, &name, mcp_servers).await;
        }
        _ => {}
    }
}

/// Write the fetched tool list into the transcript. The detail screen shows a
/// count; the names belong in the conversation, where they scroll and persist.
pub(super) fn show_mcp_tools(app: &mut App) {
    let Some(detail) = app.mcp_detail.as_ref() else {
        return;
    };
    let name = detail.server.name.clone();
    match &detail.tools {
        ToolsState::Ready(names) if names.is_empty() => {
            app.note(&format!("'{name}' exposes no tools"))
        }
        ToolsState::Ready(names) => {
            let names = names.clone();
            app.note(&format!("{} tool(s) on '{name}':", names.len()));
            for tool in names {
                app.system_detail_text(&tool);
            }
        }
        ToolsState::Loading => app.note("still listing tools..."),
        ToolsState::Unavailable => app.note(&format!("'{name}' is not connected")),
        ToolsState::Failed(e) => {
            let e = e.clone();
            app.note(&e)
        }
    }
}

/// Bring one server up, reading its config fresh from disk. The single
/// connect implementation behind every surface: the detail screen's `Reconnect`
/// runs it as a job (so the screen refreshes), while the list's toggle and the
/// edit wizard detach it (nothing there is waiting on the answer).
pub(super) async fn connect_mcp_server(
    name: &str,
    servers: &crate::core::state::SharedMcpServers,
) -> Result<(), String> {
    let cfg = super::super::mcp::list_servers()
        .into_iter()
        .find(|s| s.name == name)
        .map(|s| s.config)
        .ok_or_else(|| format!("'{name}' is no longer in mcp_config.json"))?;
    super::super::mcp::connect(name, &cfg, servers)
        .await
        .map_err(|e| e.to_string())
}

/// `connect_mcp_server`, detached: for the paths with no screen waiting on the
/// result. Off the render loop, so a cold stdio spawn never freezes a frame.
pub(super) fn reconnect_mcp_server(mcp_servers: &crate::core::state::SharedMcpServers, name: String) {
    let servers = mcp_servers.clone();
    tokio::spawn(async move {
        if let Err(e) = connect_mcp_server(&name, &servers).await {
            log::warn!("MCP: {e}");
        }
    });
}

/// Persist a server's enabled flag, tear down its connection when disabling,
/// and say so. Returns whether the caller now owes a *connect* -- which it
/// does, rather than connecting here, because the two callers want it delivered
/// differently: the list detaches it, the detail screen runs it as a job so the
/// screen can refresh when it lands.
///
/// Later turns read the shared map fresh, so tools appear/vanish once that
/// connect completes.
pub(super) async fn set_mcp_active(
    app: &mut App,
    mcp_servers: &crate::core::state::SharedMcpServers,
    name: &str,
    enable: bool,
) -> Option<bool> {
    if let Err(e) = super::super::mcp::set_active(name, enable) {
        app.note(&format!("failed to update mcp_config.json: {e}"));
        return None;
    }
    if enable {
        app.note(&format!("enabling MCP server '{name}'..."));
    } else {
        super::super::mcp::disconnect(name, mcp_servers).await;
        app.note(&format!("disabled MCP server '{name}'"));
    }
    Some(enable)
}

/// Resolve a thread by id (exact or unique prefix), load its messages into the
/// conversation history, and render them into the transcript.
/// Reload workspace-snapshot bookkeeping for a resumed thread from its persisted
/// metadata. Snapshots live in the git object store (kept alive by the thread's
/// ref), so there is nothing on disk to reattach; a later rewind restores them.
pub(super) fn restore_snapshots(app: &mut App, metadata: Option<&serde_json::Value>) {
    app.base_snapshot = None;
    app.checkpoints.clear();
    app.snap_queue.clear();
    app.base_requested = false;
    let Some(meta) = metadata else { return };
    let Some(base) = meta
        .get("base_snapshot")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return;
    };
    app.checkpoints = meta
        .get("checkpoints")
        .and_then(|v| serde_json::from_value::<Vec<Checkpoint>>(v.clone()).ok())
        .unwrap_or_default();
    app.base_snapshot = Some(base);
    // A resumed thread already has its base; don't re-snapshot on next submit.
    app.base_requested = true;
}

/// Reload an active `/goal` for a resumed thread from its persisted metadata.
/// An old thread with no goal (or a malformed one) simply clears the goal.
pub(super) fn restore_goal(app: &mut App, metadata: Option<&serde_json::Value>) {
    app.goal = None;
    app.goal_eval_pending = false;
    let Some(meta) = metadata else { return };
    if let Some(goal) = meta
        .get("goal")
        .and_then(|v| serde_json::from_value::<crate::core::agent::goal::GoalState>(v.clone()).ok())
    {
        if goal.is_active() {
            app.note(&format!("resumed active goal: {}", goal.condition));
        }
        app.goal = Some(goal);
    }
}

/// Reload the persisted `RunMode` for a resumed thread. Defaults to `Normal` on
/// absence/malformed metadata. Resume restores the mode only; the run stays at
/// `Status::Idle` (set by the resume path), so a saved plan never auto-executes.
pub(super) fn restore_run_mode(app: &mut App, metadata: Option<&serde_json::Value>) {
    use crate::core::agent::plan::RunMode;
    app.run_mode = RunMode::Normal;
    let Some(meta) = metadata else { return };
    if let Some(mode) = meta
        .get("run_mode")
        .and_then(|v| serde_json::from_value::<RunMode>(v.clone()).ok())
    {
        app.run_mode = mode;
        if mode == RunMode::Plan {
            app.note("resumed in plan mode (read only); /plan exit to leave");
        }
    }
}

/// Reload the canonical todo list for a resumed thread from its persisted
/// metadata into the TUI projection. The caller also mirrors it into the shared
/// registry so the model's next `todo` op operates on the reconstructed state.
pub(super) fn restore_todos(app: &mut App, metadata: Option<&serde_json::Value>) {
    app.todos = crate::core::agent::todo::TodoList::default();
    app.last_todo_reminder = None;
    let Some(meta) = metadata else { return };
    if let Some(todos) = meta
        .get("todos")
        .and_then(|v| serde_json::from_value::<crate::core::agent::todo::TodoList>(v.clone()).ok())
    {
        app.todos = todos;
    }
}

/// Say so when a loaded thread last worked in a different checkout than this
/// session does. The session's worktree is baked into the frozen
/// `OrchestrationArgs` its runs share, so this cannot switch to the thread's --
/// and silently continuing in the wrong tree would have the model reading files
/// that do not match the conversation it just loaded.
pub(super) fn note_workspace_mismatch(app: &mut App, thread: &serde_json::Value) {
    let Some(recorded) = super::super::worktree::from_metadata(thread.get("metadata")) else {
        return;
    };
    let here = match app.workspace.as_ref() {
        Some(live) if live.path == recorded.path => return,
        Some(live) => tilde_path(&live.path),
        None => tilde_path(&app.project_root),
    };
    app.note(&format!(
        "this thread last worked in {}; this session stays in {here}",
        tilde_path(&recorded.path)
    ));
}

/// `/worktree`: what this session is working in, and what has changed there.
///
/// Read-only on purpose. Getting the work out is the user's own git: this
/// session must never write to the branch they left behind.
pub(super) fn worktree_command(app: &mut App) {
    let Some(workspace) = app.workspace.clone() else {
        app.note(
            "working in the project directory; start with --worktree for a dedicated checkout",
        );
        return;
    };
    app.note("worktree:");
    app.system_detail_text(&format!("path    {}", tilde_path(&workspace.path)));
    app.system_detail_text(&format!("branch  {}", workspace.branch));
    let changed = git::changed_paths(&workspace.path);
    if changed.is_empty() {
        app.system_detail_text("changes nothing yet");
        return;
    }
    app.system_detail_text(&format!("changes {} file(s)", changed.len()));
    for path in changed.iter().take(WORKTREE_CHANGE_ROWS) {
        app.system_detail_text(&format!("        {path}"));
    }
    if changed.len() > WORKTREE_CHANGE_ROWS {
        app.system_detail_text(&format!(
            "        ... and {} more",
            changed.len() - WORKTREE_CHANGE_ROWS
        ));
    }
    app.system_detail_text(&format!(
        "review with: git -C {} diff",
        workspace.path.display()
    ));
}

/// Changed paths `/worktree` lists before eliding; the rest are a `git diff`
/// away and the point of the row is the shape of the change, not the manifest.
pub(super) const WORKTREE_CHANGE_ROWS: usize = 20;

/// Branch the session before its `target`-th user message into a new thread and
/// switch to it, leaving the source whole on disk. The cut turn lands in the
/// input, as a rewind's does, so the branch opens ready to re-ask it.
pub(super) async fn fork_at(app: &mut App, target: usize) {
    // The fork is cut from what is on disk, so this turn's history and journal
    // have to be there first; the journal writer is asynchronous.
    app.persist();
    app.join_journal();
    let Some(source) = app.thread_id.clone() else {
        return app.note("nothing to fork: this session has not been saved yet");
    };
    let fill = super::super::user_turn_index(&app.history, target)
        .and_then(|i| app.history.get(i))
        .and_then(|m| m.get("content"))
        .map(|c| user_content_parts(c).0)
        .unwrap_or_default();

    let forked = super::super::fork_thread(&app.agent_dir, &source, Some(target))
        .and_then(|id| super::super::cli_get_thread_in(&app.agent_dir, &id));
    let thread = match forked {
        Ok(thread) => thread,
        Err(e) => return app.note(&format!("fork failed: {e}")),
    };
    let id: String = thread
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .chars()
        .take(8)
        .collect();
    load_thread(app, &thread, "forked").await;
    app.input_clear();
    app.input = fill;
    app.cursor = app.input.len();
    app.note(&format!(
        "forked before message #{} into {id}; the original is still in /resume",
        target + 1
    ));
    // The checkout cannot change under a live session, so the branch shares this
    // one for now. Its thread records no worktree, so opening it later with
    // worktrees on gets it one of its own.
    if let Some(workspace) = app.workspace.as_ref() {
        let path = tilde_path(&workspace.path);
        app.note(&format!(
            "both branches share {path} until you reopen this one with --worktree"
        ));
    }
}

/// Indent for a `/tree` row: the branch glyph at its own depth, plain spaces for
/// the levels above it.
pub(super) fn tree_prefix(depth: usize, last: bool) -> String {
    if depth == 0 {
        return String::new();
    }
    let arm = if last { "└─ " } else { "├─ " };
    format!("{}{arm}", "   ".repeat(depth - 1))
}

/// Open `/tree`: this project's saved threads arranged by the forks taken from
/// them. Enter resumes the selected node; a store with no forks is the flat list
/// `/resume` shows.
pub(super) fn open_tree_picker(app: &mut App) {
    let threads = match super::super::list_threads_in(&app.agent_dir) {
        Ok(threads) => threads,
        Err(e) => return app.note(&format!("failed to list threads: {e}")),
    };
    let base = app.agent_dir.clone();
    let current = app.thread_id.clone();
    let items: Vec<PickerItem> = super::super::thread_forest(threads)
        .into_iter()
        .filter_map(|node| {
            let id = node.thread.get("id").and_then(|v| v.as_str())?.to_string();
            let name = thread_display_name(
                &base,
                &id,
                node.thread.get("title").and_then(|v| v.as_str()),
            );
            let here = if current.as_deref() == Some(id.as_str()) {
                " (current)"
            } else {
                ""
            };
            Some(PickerItem {
                label: format!("{}{name}{here}", tree_prefix(node.depth, node.last)),
                hint: Some(id.chars().take(8).collect()),
                value: id,
                checkbox: None,
            })
        })
        .collect();
    if items.is_empty() {
        return app.note("no saved threads found");
    }
    let selected = items
        .iter()
        .position(|i| current.as_deref() == Some(i.value.as_str()))
        .unwrap_or(0);
    app.picker = Some(Picker {
        kind: PickerKind::ThreadTree,
        items,
        selected,
        armed_delete: None,
    });
}

/// Open the double-Esc rewind picker listing the conversation's user messages.
pub(super) fn open_rewind_picker(app: &mut App) {
    open_turn_picker(app, PickerKind::RewindMessage, "nothing to rewind to");
}

/// Open the `/fork` picker: the same list of user messages, branching before the
/// chosen one instead of truncating this thread at it.
pub(super) fn open_fork_picker(app: &mut App) {
    open_turn_picker(app, PickerKind::ForkMessage, "nothing to fork");
}

/// List the conversation's user messages for a picker that acts on a past turn.
pub(super) fn open_turn_picker(app: &mut App, kind: PickerKind, empty: &str) {
    let mut items = Vec::new();
    let mut ui = 0usize;
    for m in &app.history {
        if is_user_turn(m) {
            let text = user_content_parts(&m["content"]).0;
            items.push(PickerItem {
                value: ui.to_string(),
                label: truncate_preview(&text),
                hint: Some(format!("#{}", ui + 1)),
                checkbox: None,
            });
            ui += 1;
        }
    }
    if items.is_empty() {
        return app.note(empty);
    }
    let selected = items.len() - 1;
    app.picker = Some(Picker {
        kind,
        items,
        selected,
        armed_delete: None,
    });
}

/// Second rewind step: choose whether to also reset the isolated workspace. The
/// workspace option is offered only when the session has a worktree.
pub(super) fn open_rewind_scope(app: &mut App, user_index: usize) {
    app.rewind_target = Some(user_index);
    let mut items = vec![PickerItem {
        value: "conversation".to_string(),
        label: "conversation only".to_string(),
        hint: None,
        checkbox: None,
    }];
    if app.base_snapshot.is_some() {
        items.push(PickerItem {
            value: "workspace".to_string(),
            label: "conversation + workspace".to_string(),
            hint: None,
            checkbox: None,
        });
    }
    app.picker = Some(Picker {
        kind: PickerKind::RewindScope,
        items,
        selected: 0,
        armed_delete: None,
    });
}

/// Roll the conversation back to just before the `target`-th user message,
/// dropping it and everything after. When `restore_workspace`, also hard-reset
/// the worktree to the checkpoint that preceded that message (or the base commit).
pub(super) fn rewind_to(app: &mut App, target: usize, restore_workspace: bool) {
    let Some(cut) = super::super::user_turn_index(&app.history, target) else {
        return app.note("rewind target not found");
    };

    if restore_workspace {
        if let (Some(repo), Some(base)) = (app.repo_root.clone(), app.base_snapshot.clone()) {
            // State before the target turn = the newest checkpoint that predates
            // it, else the base snapshot. `latest` (newest snapshot) tells restore
            // which files were added since, so they can be removed.
            let sha = app
                .checkpoints
                .iter()
                .rev()
                .find(|c| c.user_index < target)
                .map(|c| c.sha.clone())
                .unwrap_or(base.clone());
            let latest = app
                .checkpoints
                .last()
                .map(|c| c.sha.clone())
                .unwrap_or(base);
            match git::restore(&repo, &sha, &latest) {
                Ok(()) => app.note("workspace restored"),
                Err(e) => app.note(&format!("workspace restore failed: {e}")),
            }
        }
    }

    // Lift the target user message's text into the input area so the user
    // can re-submit (or edit) it after the rewind. Image-only content yields
    // no text.
    let fill = user_content_parts(
        app.history
            .get(cut)
            .and_then(|m| m.get("content"))
            .unwrap_or(&serde_json::Value::Null),
    )
    .0;

    app.history.truncate(cut);
    // The rewound-away turns are exactly what the provider's last `prompt_tokens`
    // measured, so that count now overstates the window by the removed prefix.
    app.invalidate_token_provenance();
    app.tokens = estimate_token_count(&app.history);
    // The journal is keyed by its own user entries, not by history indices: it
    // holds rows (tool calls, reasoning) that history never had.
    app.display_log
        .truncate(journal::truncate_at_user(&app.display_log, target));
    app.checkpoints.retain(|c| c.user_index < target);
    rebuild_transcript(app);
    rebuild_recall(app);
    app.status = Status::Idle;
    app.run_started = None;
    app.scrollback = 0;
    app.input_clear();
    app.input = fill;
    app.cursor = app.input.len();
    app.note(&format!("rewound to message #{}", target + 1));
    app.persist();
}

/// Rebuild Up/Down recall from `history`, the conversation being the one source
/// of truth for it. Anything that replaces or truncates the conversation
/// (resume, rewind) calls this, so recall can never offer a message the thread
/// no longer contains -- nor lose the ones it does.
pub(super) fn rebuild_recall(app: &mut App) {
    app.input_history.clear();
    app.reset_recall();
    let texts: Vec<String> = app
        .history
        .iter()
        .filter(|m| is_user_turn(m))
        .filter_map(|m| m.get("content"))
        .map(|c| user_content_parts(c).0)
        .filter(|t| !t.is_empty())
        .collect();
    for text in texts {
        app.record_submitted(&text);
    }
}

/// Replay a display journal through the very paths that rendered it live, so a
/// resumed or rewound transcript keeps its reasoning, tool rows and diff panels.
/// The replayed events journal themselves again, so `entries` is reinstated as
/// the log afterwards instead of whatever the replay appended.
pub(super) fn replay_display_log(app: &mut App, entries: Vec<DisplayEntry>) {
    for entry in &entries {
        match entry {
            DisplayEntry::User { text, images } => {
                app.finalize_tool_group();
                app.push_user_line(text, images);
            }
            // Through `flush_assistant`, not `push_assistant_blocks`: the prose
            // is also what closes the preceding run of grouped calls. Rendering
            // the blocks directly leaves the group open, so every later call
            // folds back into one row that is never committed -- the whole turn's
            // tool calls then render as nothing at all.
            DisplayEntry::Assistant {
                text,
                reasoning,
                reasoning_ms,
            } => {
                app.assistant_buf = text.clone();
                app.reasoning_segs = reasoning.clone();
                // Seed the recorded duration so the replay stamps the same
                // `Thought for Ns`; flush reads it via `thought_for`. Cleared
                // after so it cannot leak onto the next reasoning block.
                app.thought_for = reasoning_ms.map(Duration::from_millis);
                app.flush_assistant();
                app.thought_for = None;
            }
            DisplayEntry::ToolCall { id, name, args } => app.apply(StreamEvent::ToolCall {
                id: id.clone(),
                name: name.clone(),
                args: args.clone(),
            }),
            DisplayEntry::ToolResult {
                id,
                content,
                is_error,
                diff,
            } => app.apply(StreamEvent::ToolResult {
                id: id.clone(),
                content: content.clone(),
                is_error: *is_error,
                diff: diff.clone(),
            }),
            DisplayEntry::Subagent {
                name,
                calls,
                finished,
            } => {
                app.finalize_tool_group();
                app.push_subagent_summary(name, calls.clone(), *finished);
            }
        }
    }
    // A replay is rendering, not work: the calls it re-renders must not stage
    // files for the next checkpoint, leave a call awaiting a diff, or read as
    // todo activity in the turn that follows.
    app.finalize_tool_group();
    app.turn_touched.clear();
    app.diff_paths.clear();
    app.todo_call_this_turn = false;
    app.display_log = entries;
}

/// Re-render the transcript after a rewind: from the display journal when there
/// is one (so the kept turns keep their reasoning and tool rows), else from the
/// `history` the rewind left behind.
pub(super) fn rebuild_transcript(app: &mut App) {
    app.transcript.clear();
    app.tool_group = None;
    app.grouped_ids.clear();
    app.starting.clear();
    app.groups.clear();
    app.pending_rows.clear();
    app.reasoning_blocks.clear();
    app.expanded_traces.clear();
    app.subagent_blocks.clear();
    app.expanded.clear();
    app.reveal = None;
    app.assistant_buf.clear();
    app.reasoning_segs.clear();
    app.last_kind = Kind::None;
    if !app.display_log.is_empty() {
        let logged = std::mem::take(&mut app.display_log);
        return replay_display_log(app, logged);
    }
    let history = app.history.clone();
    for m in &history {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role == "user" {
            let (text, images) =
                user_content_parts(m.get("content").unwrap_or(&serde_json::Value::Null));
            if text.is_empty() && images.is_empty() {
                continue;
            }
            // Same compact treatment as resume: invocation templates are stored
            // verbatim in history but must not flood the transcript.
            match super::super::invocation_label(&text) {
                Some(label) => app.push_invocation_label(label),
                None => app.push_user_line(&text, &images),
            }
        } else if role == "assistant" {
            let text = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if !text.is_empty() {
                app.push_assistant_blocks(text, &[], None);
            }
        }
    }
}

pub(super) async fn resume_thread(app: &mut App, id_arg: &str) {
    // Re-brand the fresh view before the saved conversation is replayed.
    app.push_session_banner(false);
    apply_resume(
        app,
        &ResumeRequest::resume(ResumeTarget::Id(id_arg.to_string())),
    )
    .await;
}

/// Resolve a resume request and load it into the app, reporting why not when it
/// cannot be resolved. The session is left untouched on failure.
pub(super) async fn apply_resume(app: &mut App, request: &ResumeRequest) {
    match super::super::resolve_resume(&app.agent_dir, request) {
        Ok(thread) => load_thread(app, &thread, "resumed").await,
        Err(e) => app.note(&e),
    }
}

/// Replace the live session with a saved thread's state: history, transcript,
/// snapshots, goal, and model. Only user/assistant text is replayed (tool calls
/// are not persisted as messages). `verb` names how the thread was opened, so a
/// fork does not report itself as a resume.
pub(super) async fn load_thread(app: &mut App, thread: &serde_json::Value, verb: &str) {
    // The running turn would save its conversation over the thread opened
    // here when it finishes.
    if app.status != Status::Idle {
        return app.note("a turn is running; press Esc to stop it before switching threads");
    }
    let full_id = thread
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let (messages, skipped) = match super::super::cli_read_messages_lenient(&app.agent_dir, full_id) {
        Ok(m) => m,
        Err(e) => return app.note(&format!("failed to load messages: {e}")),
    };

    app.history.clear();
    app.thread_id = Some(full_id.to_string());
    app.transcript.clear();
    app.tool_group = None;
    app.grouped_ids.clear();
    app.groups.clear();
    app.pending_rows.clear();
    app.reasoning_blocks.clear();
    app.expanded_traces.clear();
    app.subagent_blocks.clear();
    app.expanded.clear();
    app.reveal = None;
    app.assistant_buf.clear();
    app.reasoning_segs.clear();
    app.turn = (0, 0);
    app.scrollback = 0;
    app.message_queue.clear();
    restore_snapshots(app, thread.get("metadata"));
    restore_goal(app, thread.get("metadata"));
    restore_run_mode(app, thread.get("metadata"));
    restore_todos(app, thread.get("metadata"));
    app.forked_from = thread
        .get("metadata")
        .and_then(|m| m.get(super::super::FORKED_FROM_KEY))
        .cloned();
    // A loaded thread brings its own worktree pointer, or none: this session
    // cannot switch checkouts under a frozen run, so writing the live one into a
    // thread that did not ask for it would hand two conversations one branch.
    app.workspace_record = super::super::worktree::from_metadata(thread.get("metadata"));
    note_workspace_mismatch(app, thread);
    // Mirror the reconstructed todos into the shared registry so the model's
    // next `todo` mutation operates on the resumed state, not an empty list.
    if let Some(args) = app.args.as_ref() {
        if let Some(registry) = args.todo_registry.as_ref() {
            *registry.lock().await = app.todos.clone();
        }
    }

    // Adopt the thread's model so continuation stays coherent.
    if let Some(model) = thread
        .get("model")
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
    {
        app.adopt_model(model.to_string());
    }

    // The journal holds what was rendered (reasoning, tool rows, diffs); the
    // messages hold what the model is sent. Prefer the journal for the
    // transcript, and fall back to replaying the messages for a thread saved
    // before journaling (or whose journal was lost).
    let logged = journal::read_journal(&journal::journal_path(&app.agent_dir, full_id));
    app.history = super::super::rebuild_wire_history(&messages);
    // A resumed thread was never measured by *this* session's provider calls, and
    // any count left over from the thread we were on describes a different
    // conversation entirely. Estimate until a fresh response lands.
    app.invalidate_token_provenance();
    app.tokens = estimate_token_count(&app.history);
    let count = app
        .history
        .iter()
        .filter(|m| {
            matches!(
                m.get("role").and_then(|v| v.as_str()),
                Some("user" | "assistant")
            )
        })
        .count();
    app.display_log.clear();
    if logged.is_empty() {
        rebuild_transcript(app);
    } else {
        replay_display_log(app, logged);
    }
    // Recall follows the conversation, so the replaced session's lines go with
    // it and the resumed thread's come back.
    rebuild_recall(app);

    let title = thread
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("(untitled)");
    app.note(&format!("{verb} \"{title}\" ({count} messages)"));
    if skipped > 0 {
        app.note(&format!("{skipped} unreadable message(s) were skipped"));
    }
}

/// Split a user message's `content` into display text and one label per attached
/// image. Handles plain-string content and the `image_url` content-part array;
/// data-URL parts carry no filename, so their label is empty.
pub(super) fn user_content_parts(content: &serde_json::Value) -> (String, Vec<String>) {
    match content {
        serde_json::Value::String(s) => (crate::core::agent::reminder::strip(s), Vec::new()),
        serde_json::Value::Array(parts) => {
            let mut text = String::new();
            let mut images = Vec::new();
            for p in parts {
                match p.get("type").and_then(|v| v.as_str()) {
                    Some("text") => {
                        if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                            text.push_str(&crate::core::agent::reminder::strip(t));
                        }
                    }
                    Some("image_url") => images.push(String::new()),
                    _ => {}
                }
            }
            (text, images)
        }
        _ => (String::new(), Vec::new()),
    }
}

/// Extract plain text from a stored thread message (`content` is an array of
/// `{type,text:{value}}` parts, or occasionally a bare string).
pub(super) fn message_text(msg: &serde_json::Value) -> String {
    super::super::thread_message_text(msg)
}

/// Whitespace-collapsed, char-truncated one-liner for checkpoint/rewind labels.
pub(super) fn truncate_preview(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 60 {
        let head: String = collapsed.chars().take(57).collect();
        format!("{head}...")
    } else {
        collapsed
    }
}
