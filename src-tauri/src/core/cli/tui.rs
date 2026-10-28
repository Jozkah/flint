//! Interactive chat console over the agent loop (bare `jan`). A thin
//! renderer: the engine is shared with the plain CLI path, only the
//! presentation differs. Maintains a running conversation — the user types
//! messages into an input box, each submit spawns an agent run over the shared
//! `AgentSession`, and streamed `StreamEvent`s render as message history plus
//! inline workflow elements (turn steps, tool calls/results). Gated tool calls
//! are approved interactively via the shared `PermissionRegistry`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::pending;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::path_refs;

use ratatui::crossterm::{
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, Event, KeyCode,
        KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    },
    execute,
    style::Print,
    terminal::{
        disable_raw_mode, enable_raw_mode, BeginSynchronizedUpdate, EndSynchronizedUpdate,
        EnterAlternateScreen, LeaveAlternateScreen,
    },
};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

mod highlight;
mod markdown;
mod theme;
mod composer;
use self::composer::*;
mod clipboard;
use self::clipboard::*;
mod paste;
use self::paste::*;
mod render;
use self::render::*;
mod commands;
use self::commands::*;
mod keys;
use self::keys::*;
mod mouse;
use self::mouse::*;
mod stream;
use self::stream::*;
mod state;
use self::state::*;
pub(crate) use self::stream::answer_without_reasoning;

use markdown::{
    format_markdown_lines, live_assistant_lines, reasoning_detail_lines, reasoning_summary_row,
};

use super::agent_status::AgentStatusReporter;
use super::brand;
use super::journal::{self, DisplayEntry, ReasoningSeg};
use super::mcp::McpServerEntry;
use super::user_message::{build_user_message, image_mime, image_mime_of, PendingImage, MAX_IMAGE_BYTES};
use super::worktree::Worktree;
use super::{
    is_user_turn, sort_threads_recent, AgentSession, ResumeRequest, ResumeTarget, SessionLimits,
};
use crate::core::agent::events::{describe_tool_call, StreamEvent, Usage};
use crate::core::agent::git;
use crate::core::agent::r#loop::{
    run_orchestration_steered, OrchestrationArgs, PermissionRegistry, SteeringRequest,
};
use serde_json::Value;
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use tauri_plugin_agent_tools::workspace;

/// Mouse tracking, hand-rolled instead of crossterm's `EnableMouseCapture`,
/// which also turns on any-motion reporting (1003) -- a stream of events for
/// every idle pointer move. Buttons and the wheel (1000) plus motion *while a
/// button is held* (1002), with SGR coordinates (1006), is exactly what
/// drag-to-select needs and nothing more.
const MOUSE_TRACK_ON: &str = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
/// Alternate scroll (1007) makes the terminal translate the wheel into arrow
/// keys, which the composer reads as message-history recall -- so it is saved
/// and forced off for the session, then restored on exit. Needed whether or not
/// tracking is on, since with tracking off the wheel would otherwise type.
const ALT_SCROLL_SAVE_OFF: &str = "\x1b[?1007s\x1b[?1007l";
const ALT_SCROLL_RESTORE: &str = "\x1b[?1007r";

/// Kitty keyboard protocol, flags 1 (disambiguate escape codes) + 4 (report
/// alternate keys). Disambiguation is what makes `Shift+Enter` reachable at
/// all: legacy encoding has no room for a modifier on `Enter`, so the terminal
/// sends a bare `\r` that is indistinguishable from a plain `Enter`, and the
/// same goes for `Cmd`/`SUPER` on any key. Alternate keys ride along so a
/// shifted printable arrives as its shifted character instead of the base key
/// plus SHIFT, which would otherwise type lowercase on a terminal that reports
/// shifted text as an escape code. Event types (2) are deliberately left off:
/// they add key-release and repeat events that nothing here consumes, and
/// `handle_key` would have to filter every one of them. A terminal without the
/// protocol ignores both sequences, so the pair is safe to send unconditionally
/// -- querying support first (`supports_keyboard_enhancement`) costs a blocking
/// stdin read of up to two seconds before the first frame.
const KITTY_KEYS_ON: &str = "\x1b[>5u";
/// Pop what `KITTY_KEYS_ON` pushed, restoring whatever the shell had.
const KITTY_KEYS_OFF: &str = "\x1b[<u";

/// Whether to hand the wheel to the terminal's native alternate-scroll instead
/// of asking it to report wheel events to the app. Disabling alternate scroll
/// (`?1007l`) makes an xterm-family terminal deliver the wheel as SGR mouse
/// reports for the app to turn into scrollback. Windows Terminal accepts the
/// mode but does not do the same: with it forced off the wheel goes dead in the
/// alternate buffer, so there the app keeps `?1000h` SGR mouse as the sole wheel
/// path and leaves alternate scroll alone. Same decision on save/restore, so
/// the pair is always balanced.
fn alt_scroll_save_off() -> &'static str {
    if cfg!(windows) {
        ""
    } else {
        ALT_SCROLL_SAVE_OFF
    }
}

fn alt_scroll_restore() -> &'static str {
    if cfg!(windows) {
        ""
    } else {
        ALT_SCROLL_RESTORE
    }
}

/// The private modes to set on entry, in one write. Keyboard enhancement is
/// unconditional -- it is what the editing keys are decoded from -- while mouse
/// tracking follows the `mouse` config key.
fn startup_modes(mouse: bool) -> String {
    let mut modes = String::from(alt_scroll_save_off());
    modes.push_str(KITTY_KEYS_ON);
    if mouse {
        modes.push_str(MOUSE_TRACK_ON);
    }
    modes
}

/// Whether to wrap each repaint in synchronized output (`\x1b[?2026h/l`).
/// kitty honors DEC 2026 but can drop the resize-triggered full clear + repaint
/// while a synchronized frame is held, leaving a persistent black screen on
/// resize (konsole ignores 2026, so it never shows this). Skipping the wrapper
/// under kitty trades tearing for a reliable resize; every other terminal that
/// supports 2026 keeps the anti-tearing frame.
fn sync_output_for(kind: super::terminal_setup::Kind) -> bool {
    !matches!(kind, super::terminal_setup::Kind::Kitty)
}

fn use_synchronized_output() -> bool {
    sync_output_for(super::terminal_setup::identify(|k| std::env::var(k).ok()))
}

/// Everything `run` turns on, undone in one write for the panic hook: a held
/// synchronized frame (a panic inside `terminal.draw` lands between its begin
/// and end), bracketed paste, mouse tracking, keyboard enhancement, alternate
/// scroll, the alternate screen, and a hidden cursor. Plain bytes, because the
/// hook has no `&mut Terminal` to hand. Every sequence is a no-op when its mode
/// is not on, so it is safe whatever `startup_modes` chose.
fn panic_restore_sequence() -> String {
    format!(
        "\x1b[?2026l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l{KITTY_KEYS_OFF}{}\x1b[?1049l\x1b[?25h",
        alt_scroll_restore(),
    )
}

/// The thread running the render loop while it owns the terminal, or `None`
/// once restored. A panic hook is process-wide, but only a panic on this thread
/// ends the session; a spawned job's panic is a `JoinError` the loop survives,
/// and tearing the modes down under a TUI that keeps drawing would wreck it.
static TERMINAL_OWNER: std::sync::Mutex<Option<std::thread::ThreadId>> =
    std::sync::Mutex::new(None);

/// Give up the terminal if the current thread owns it, reporting whether it
/// did. Taking the slot makes the restore run once.
fn release_terminal() -> bool {
    let mut owner = TERMINAL_OWNER.lock().unwrap_or_else(|e| e.into_inner());
    if *owner == Some(std::thread::current().id()) {
        *owner = None;
        true
    } else {
        false
    }
}

/// Undoes what `run` set up if it leaves early (a `?` on a setup step) or
/// unwinds: raw mode and terminal modes (once `raw` is set), and the muted
/// stderr sink (always). The normal exit path restores explicitly and clears
/// `raw`; the repeated stderr write on drop is idempotent.
struct TerminalGuard {
    prev_stderr: bool,
    raw: bool,
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if self.raw {
            release_terminal();
            let _ = disable_raw_mode();
            let mut stdout = io::stdout();
            let _ = stdout.write_all(panic_restore_sequence().as_bytes());
            let _ = stdout.flush();
        }
        super::file_log::set_stderr_enabled(self.prev_stderr);
    }
}

/// Install a hook that logs the panic and, when it lands on the render-loop
/// thread, puts the terminal back before the previous hook prints its message,
/// so the message is readable on a normal screen instead of lost in the
/// alternate buffer. Chains the previous hook; unwinding continues as before.
/// Call after `enable_raw_mode`, on the thread that runs the render loop.
fn install_panic_hook() {
    *TERMINAL_OWNER.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(std::thread::current().id());
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // The stderr sink is muted for the session; the file log still records.
        log::error!(
            "panic in thread '{}': {info}\n{}",
            std::thread::current().name().unwrap_or("unnamed"),
            std::backtrace::Backtrace::force_capture()
        );
        if release_terminal() {
            let _ = disable_raw_mode();
            let mut stdout = io::stdout();
            let _ = stdout.write_all(panic_restore_sequence().as_bytes());
            let _ = stdout.flush();
            super::file_log::set_stderr_enabled(true);
        }
        previous(info);
    }));
}
/// How long the dock advertises a finished copy.
const COPY_NOTICE: Duration = Duration::from_millis(1500);
/// Terminals cap the OSC 52 payload they will accept; past this the sequence is
/// skipped and the in-process clipboard is the only path.
const OSC52_MAX_BYTES: usize = 100_000;

#[cfg(test)]
thread_local! {
    /// Counts `Row::lines` calls, so a test can assert that `draw` materializes
    /// a viewport's worth of rows rather than the whole transcript.
    static ROW_CLONES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Owning snapshot of the `App` state the `/context` report is shaded from,
/// taken synchronously on the key path (see [`App::context_snapshot`]).
struct ContextSnapshot {
    args: Option<Arc<OrchestrationArgs>>,
    model: String,
    run_mode: crate::core::agent::plan::RunMode,
    context_window: u64,
    reserve_tokens: u64,
    reserve_pinned: bool,
    /// The Messages segment's estimate over the live history, precomputed so
    /// the off-loop task need not own a clone of the conversation.
    history_estimate: u64,
    tokens_estimated: bool,
    turn_prompt_tokens: u64,
}

/// The `/context` breakdown for the current session, computed from an owned
/// [`ContextSnapshot`] so it can run on its own task off the render loop.
///
/// The headline fill prefers the provider's number: `turn_prompt_tokens` is
/// the most recent request's `prompt_tokens`, which is by definition what
/// the window actually held. It is only authoritative while
/// `tokens_estimated` is false -- a compaction rewrites the history the
/// provider measured, so its last count describes a conversation that no
/// longer exists and the view falls back to the estimator, labelled.
///
/// The per-category numbers are always estimates (chars/4 over each
/// segment's real serialized text, via the same [`estimate_token_count`]
/// path the compaction gauge uses), which is why the section is headed
/// "Context breakdown (estimated)" regardless of the headline's source.
async fn compute_context_report(snapshot: ContextSnapshot) -> ContextReport {
    // AH-087: what the last request was actually made of, read from the
    // request itself. Every surface reads this same classification, so the
    // TUI, the headless CLI and the desktop cannot disagree about what is
    // filling the window -- and what is reported is what went out, not a
    // rebuild of it from whatever is on disk now.
    if let Some(report) = report_from_the_last_request(&snapshot) {
        return report;
    }
    // Nothing has been sent yet in this session, so there is no request to
    // read. Fall back to sizing what the next one would carry.
    let mut segments = Vec::new();
    let args = snapshot.args.as_ref();
    let root = args.and_then(|a| a.project_root.clone());

    // The three system-prompt segments are carved out of one build of the
    // real prompt: the whole thing, minus the JAN.md block, minus the
    // skills/memory catalogs. Splitting a single build (rather than
    // re-deriving each piece) is what keeps them summing to what is sent.
    //
    // Sized in bytes, not chars, because `estimate_token_count` -- which
    // sizes the Messages segment below -- divides `str::len` by four. Mixing
    // the two would make the same non-ASCII text count differently depending
    // on which segment it landed in.
    let (mut prompt_bytes, mut context_bytes, mut skills_bytes) = (0usize, 0usize, 0usize);
    if let (Some(args), Some(root)) = (args, root.as_deref()) {
        let full = crate::core::agent::r#loop::context_system_prompt_preview(
            args.system_prompt_override.as_deref(),
            root,
            args.session_id.as_deref(),
            args.subagents_enabled,
            args.sandbox,
        )
        .unwrap_or_default();
        context_bytes =
            crate::core::agent::context::load_context_files(root).map_or(0, |s| s.len());
        skills_bytes = crate::core::agent::context::load_skills(root).map_or(0, |s| s.len())
            + crate::core::agent::context::load_memory_catalog(root).map_or(0, |s| s.len());
        prompt_bytes = full.len().saturating_sub(context_bytes + skills_bytes);
    }

    // Tool schemas as actually advertised, serialized the way they go on
    // the wire.
    let tools_bytes = match args {
        Some(args) => crate::core::agent::r#loop::context_advertised_tools(
            &args.mcp_servers,
            &args.mcp_settings,
            &args.permissions,
            root.as_deref(),
            snapshot.run_mode,
            args.subagents_enabled,
            args.max_parallel_subagents,
            args.ask_requests.is_some(),
            args.todo_registry.is_some(),
            &args.host_tools,
        )
        .await
        .iter()
        .map(|t| t.to_string().len())
        .sum(),
        None => 0,
    };

    // Same divisor as `estimate_token_count`, applied to the same unit.
    let bytes_to_tokens = |bytes: usize| (bytes / 4) as u64;
    segments.push(ContextSegment {
        key: 'P',
        label: "System prompt",
        tokens: bytes_to_tokens(prompt_bytes),
    });
    segments.push(ContextSegment {
        key: 'T',
        label: "System tools",
        tokens: bytes_to_tokens(tools_bytes),
    });
    segments.push(ContextSegment {
        key: 'C',
        label: "Project context",
        tokens: bytes_to_tokens(context_bytes),
    });
    segments.push(ContextSegment {
        key: 'K',
        label: "Skills",
        tokens: bytes_to_tokens(skills_bytes),
    });
    segments.push(ContextSegment {
        key: 'M',
        label: "Messages",
        tokens: snapshot.history_estimate,
    });

    // Free space is what is left after the estimated content and the
    // reserved buffer, so the seven segments partition the window exactly
    // and the percentages sum to 100.
    let buffer = tauri_plugin_agent_tools::compaction_policy::reserve_buffer(
        snapshot.reserve_tokens,
        snapshot.context_window,
        snapshot.reserve_pinned,
    );
    let used: u64 = segments.iter().map(|s| s.tokens).sum();
    let free = snapshot.context_window.saturating_sub(used + buffer);
    segments.push(ContextSegment {
        key: '.',
        label: "Available",
        tokens: free,
    });
    segments.push(ContextSegment {
        key: 'B',
        label: "Auto-compact reserve",
        tokens: buffer,
    });

    let reported = !snapshot.tokens_estimated && snapshot.turn_prompt_tokens > 0;
    ContextReport {
        model_id: snapshot.model,
        window: snapshot.context_window,
        fill: if reported {
            snapshot.turn_prompt_tokens
        } else {
            used
        },
        fill_reported: reported,
        segments,
    }
}

/// The `/context` view built from the session's last dispatched request
/// (AH-087), or `None` when the session has not sent one.
fn report_from_the_last_request(snapshot: &ContextSnapshot) -> Option<ContextReport> {
    use tauri_plugin_agent_tools::context_report::Category;
    let session = snapshot.args.as_ref()?.session_id.clone()?;
    let data = crate::core::app::commands::resolve_jan_data_folder();
    let window = (snapshot.context_window > 0).then_some(snapshot.context_window);
    let breakdown =
        tauri_plugin_agent_tools::context_report::of_snapshot(&data, &session, None, window, 0)
            .ok()?;

    // The same marker letters the legend has always used, so a reader who
    // knows the view still knows it.
    let key = |category: Category| match category {
        Category::SystemPrompt => Some(('P', "System prompt")),
        Category::ProjectContext => Some(('C', "Project context")),
        Category::Skills => Some(('K', "Skills")),
        Category::Memory => Some(('Y', "Memory")),
        Category::CustomAgents => Some(('A', "Custom agents")),
        Category::ToolsTransmitted => Some(('T', "System tools")),
        Category::CompactedHistory => Some(('H', "Compacted history")),
        Category::Messages => Some(('M', "Messages")),
        Category::Attachments => Some(('F', "Attachments")),
        // Reported by the breakdown, but not part of the window's fill: a
        // definition that was not sent cost nothing, and free space and the
        // reserve are added below in the view's own terms.
        Category::ToolsDeferred | Category::ReservedOutput | Category::FreeSpace => None,
    };
    let mut segments: Vec<ContextSegment> = breakdown
        .slices
        .iter()
        .filter_map(|slice| {
            key(slice.category).map(|(key, label)| ContextSegment {
                key,
                label,
                tokens: slice.tokens,
            })
        })
        .collect();

    // The provider's own count for the last turn is the authority on the fill
    // when the history it measured is still the history (`tokens_estimated`
    // goes true the moment a compaction rewrites it).
    let reported = !snapshot.tokens_estimated && snapshot.turn_prompt_tokens > 0;
    let used: u64 = segments.iter().map(|s| s.tokens).sum();
    let buffer = tauri_plugin_agent_tools::compaction_policy::reserve_buffer(
        snapshot.reserve_tokens,
        snapshot.context_window,
        snapshot.reserve_pinned,
    );
    let free = snapshot.context_window.saturating_sub(used + buffer);
    segments.push(ContextSegment {
        key: '.',
        label: "Available",
        tokens: free,
    });
    segments.push(ContextSegment {
        key: 'B',
        label: "Auto-compact reserve",
        tokens: buffer,
    });
    Some(ContextReport {
        model_id: snapshot.model.clone(),
        window: snapshot.context_window,
        fill: if reported {
            snapshot.turn_prompt_tokens
        } else {
            used
        },
        fill_reported: reported,
        segments,
    })
}

/// Truncate to `max` chars with a trailing ellipsis (char-safe).
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max.max(1) {
        return s.to_string();
    }
    let head: String = s.chars().take(max.saturating_sub(1).max(1)).collect();
    format!("{head}…")
}

/// `s` on one line: every newline (and the whitespace around it) becomes a
/// single space. For the surfaces whose height is fixed at one row -- the live
/// group row, the subagent panel -- where an embedded `\n` would either be
/// swallowed by ratatui or silently change the row's height.
fn single_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Per-message envelope (role, delimiters) in the estimate below, the usual
/// OpenAI-accounting constant.
const TOKENS_PER_MESSAGE: u64 = 4;

/// Rough token count (~4 chars per token) for a history the provider has not
/// reported usage for: the window between a compaction and the next response.
/// Counts what actually goes on the wire -- text content including multimodal
/// text parts, tool-call names and arguments, tool-result ids -- so a
/// tool-heavy history is not scored as empty. Image parts are left out: their
/// cost is a provider-specific function of resolution, and inventing a number
/// there is worse than omitting one.
fn estimate_token_count(messages: &[serde_json::Value]) -> u64 {
    let mut total_chars: usize = 0;
    for msg in messages {
        match msg.get("content") {
            Some(serde_json::Value::String(text)) => total_chars += text.len(),
            Some(serde_json::Value::Array(parts)) => {
                for part in parts {
                    total_chars += part
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map_or(0, str::len);
                }
            }
            _ => {}
        }
        for call in msg
            .get("tool_calls")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
        {
            // Arguments live under `function`, not on the call itself.
            if let Some(f) = call.get("function") {
                total_chars += f.get("name").and_then(|n| n.as_str()).map_or(0, str::len);
                total_chars += f
                    .get("arguments")
                    .and_then(|a| a.as_str())
                    .map_or(0, str::len);
            }
        }
        total_chars += msg
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .map_or(0, str::len);
    }
    let envelope = TOKENS_PER_MESSAGE * messages.len() as u64;
    ((total_chars / 4) as u64 + envelope).max(1)
}

/// One bank in the `/context` breakdown. `key` is the monochrome-safe category
/// marker; `label` is the compact uppercase name shown beside its bar.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ContextSegment {
    key: char,
    label: &'static str,
    tokens: u64,
}

/// The full `/context` model: the authoritative window fill, whether that fill
/// is provider-reported or estimated, and the per-category breakdown.
#[derive(Debug, Clone)]
struct ContextReport {
    /// Bare model id as configured.
    model_id: String,
    window: u64,
    /// Total window fill. Provider-reported when `fill_reported`, else the
    /// chars/4 estimate over the same history.
    fill: u64,
    /// Whether `fill` came from the provider's `usage.prompt_tokens`. False
    /// makes every number on the headline an estimate, and the view says so.
    fill_reported: bool,
    /// Content categories plus free space and the autocompact buffer. Always
    /// exactly the seven bars rendered by the context view.
    segments: Vec<ContextSegment>,
}

impl ContextReport {
    /// Percentage of the effective whole each bank occupies. Normally the
    /// segments partition the configured window exactly. If an estimate
    /// overshoots, normalize over the larger segment total so the banks still
    /// sum to 100% instead of presenting impossible negative free space.
    fn percents(&self) -> Vec<f64> {
        let total: u64 = self.segments.iter().map(|s| s.tokens).sum();
        let denom = self.window.max(total).max(1) as f64;
        self.segments
            .iter()
            .map(|s| s.tokens as f64 / denom * 100.0)
            .collect()
    }
}

/// Compact token count for display: `6K`, `2.1K`, `950`. Sub-1K counts stay
/// exact; 1K-10K keeps one decimal so a 2.1K segment is not flattened to `2K`.
///
/// Done in integer tenths rather than by formatting an `f64`: the branch and
/// the displayed digit must come from the same value. The old branch inspected
/// `k * 10.0`, while the decimal renderer formatted `k` itself. For 2050, `k`
/// is slightly below 2.05 but `k * 10.0` lands on exactly 20.5, so the branch
/// selected decimal output while the renderer produced the self-defeating
/// `2.0K`. Integer math removes that representation mismatch.
pub(crate) fn format_tokens(tokens: u64) -> String {
    if tokens < 1_000 {
        return tokens.to_string();
    }
    // Tenths of a thousand, half-up. Exact for every u64 below ~1.8e15.
    let tenths = (tokens + 50) / 100;
    if tokens < 10_000 && !tenths.is_multiple_of(10) {
        format!("{}.{}K", tenths / 10, tenths % 10)
    } else {
        // 6.0K reads as noise; report it as 6K. Above 10K the decimal is
        // meaningless precision on an estimate, so it is always dropped.
        format!("{}K", (tokens + 500) / 1000)
    }
}

/// The context window's own size. Lowercase `k`, matching the header gauge and
/// the way model catalogs advertise a window (`234k`), which keeps it visually
/// distinct from the uppercase `K` used for live token counts.
fn format_window(tokens: u64) -> String {
    format!("{}k", (tokens + 500) / 1000)
}

/// Summarize tool output to one transcript line: first non-empty line with its
/// internal whitespace collapsed, truncated to `max`, plus a `(+N lines)`
/// suffix when more follow.
fn summarize_result(s: &str, max: usize) -> String {
    let mut lines = s.lines().filter(|l| !l.trim().is_empty());
    let first = lines.next().unwrap_or("");
    let collapsed = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let extra = lines.count();
    let head = truncate(&collapsed, max);
    if extra > 0 {
        format!("{head}  (+{extra} lines)")
    } else {
        head
    }
}

/// Present-tense activity label for the running tool row ("Executing grep",
/// "Searching"). Completed rows use `tool_finished` / `group_summary`.
/// The subagent name embedded in a `sub-<name>-<seq>` run id (falls back to the
/// raw id when it doesn't match that shape).
fn subagent_name_from_run_id(run_id: &str) -> &str {
    let s = run_id.strip_prefix("sub-").unwrap_or(run_id);
    match s.rfind('-') {
        Some(i) if i + 1 < s.len() && s[i + 1..].bytes().all(|b| b.is_ascii_digit()) => &s[..i],
        _ => s,
    }
}

/// The `job_id` of a `bash` poll: a call that collects an already-backgrounded
/// command instead of starting a new one. Blank is treated as absent.
fn bash_job_id(args: &serde_json::Value) -> Option<&str> {
    args.get("job_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The job id in a `bash` result reporting that its command was backgrounded.
/// Matched on the `job_id=` marker the tool prints and stopping at the first
/// character that cannot be part of an id, so the instruction text repeating
/// the id parses to the same value.
fn backgrounded_job_id(content: &str) -> Option<&str> {
    let at = content.find("job_id=")? + "job_id=".len();
    let rest = &content[at..];
    let end = rest
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        .unwrap_or(rest.len());
    Some(&rest[..end]).filter(|id| !id.is_empty())
}

/// Whether inline `<think>` tags in model content are parsed as reasoning.
/// Process-wide rather than a session field because the split runs on every
/// rendered row, from free functions a `Row` reaches with no session in hand.
/// Seeded once from `~/.jan/config.toml` by `set_think_tags_parsed`; `true`
/// until then, which is also the default.
static PARSE_THINK_TAGS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[cfg(test)]
thread_local! {
    /// Per-test override. A test flips its own thread's answer instead of the
    /// shared static, so a gate-off test cannot race the rest of the suite.
    static PARSE_THINK_TAGS_OVERRIDE: std::cell::Cell<Option<bool>> =
        const { std::cell::Cell::new(None) };
}

/// Apply the `think_tags` setting for the process. Called once per session from
/// `prepare_agent_session`, the chokepoint every agent surface goes through.
pub(crate) fn set_think_tags_parsed(enabled: bool) {
    PARSE_THINK_TAGS.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

fn think_tags_parsed() -> bool {
    #[cfg(test)]
    {
        if let Some(over) = PARSE_THINK_TAGS_OVERRIDE.with(|c| c.get()) {
            return over;
        }
    }
    PARSE_THINK_TAGS.load(std::sync::atomic::Ordering::Relaxed)
}

/// The glyph swept along the working row, or `None` for the static throbber.
/// Process-wide for the same reason as `PARSE_THINK_TAGS`: `input_box` is a free
/// function with no session in hand. Resolved from the config on first use
/// rather than per frame, since the row redraws every 50ms and this would
/// otherwise be a file read on each one.
///
/// Behind a lock rather than a `LazyLock` value because `/settings` edits it
/// live: a glyph you have to restart the console to see is not a toggle.
static WAVE_GLYPH: std::sync::LazyLock<std::sync::RwLock<Option<String>>> =
    std::sync::LazyLock::new(|| {
        std::sync::RwLock::new(crate::core::agent::global_config::wave_glyph())
    });

/// Apply a new wave glyph to the process, as `/settings` does on save.
///
/// `None` means the key was removed, so the default sweep comes back -- not
/// that the sweep is off. Off is `Some("")`, which resolves to no glyph here
/// for the reason `wave_glyph` gives: an all-whitespace traveller reads as
/// letters going missing.
pub(crate) fn set_wave_glyph(glyph: Option<&str>) {
    let value = match glyph {
        None => Some(crate::core::agent::global_config::WAVE_DEFAULT.to_string()),
        Some(g) if g.trim().is_empty() => None,
        Some(g) => Some(g.to_string()),
    };
    if let Ok(mut slot) = WAVE_GLYPH.write() {
        *slot = value;
    }
}

#[cfg(test)]
thread_local! {
    /// Per-test override, for the same reason as `PARSE_THINK_TAGS_OVERRIDE`: a
    /// test sets its own thread's glyph rather than the shared cell, which is
    /// resolved once per process and reads the real `~/.jan/config.toml`.
    static WAVE_GLYPH_OVERRIDE: std::cell::RefCell<Option<Option<String>>> =
        const { std::cell::RefCell::new(None) };
}

fn wave_glyph() -> Option<String> {
    #[cfg(test)]
    {
        if let Some(over) = WAVE_GLYPH_OVERRIDE.with(|c| c.borrow().clone()) {
            return over;
        }
    }
    WAVE_GLYPH.read().ok().and_then(|g| g.clone())
}

/// Run `f` with `glyph` as this thread's wave setting.
#[cfg(test)]
fn with_wave_glyph<T>(glyph: Option<&str>, f: impl FnOnce() -> T) -> T {
    let value = glyph.map(str::to_string);
    WAVE_GLYPH_OVERRIDE.with(|c| *c.borrow_mut() = Some(value));
    let out = f();
    WAVE_GLYPH_OVERRIDE.with(|c| *c.borrow_mut() = None);
    out
}

pub async fn run(
    session: AgentSession,
    agent_dir: std::path::PathBuf,
    project_root: PathBuf,
    initial_task: Option<String>,
    initial_images: Vec<String>,
    resume: Option<ResumeRequest>,
) -> Result<(), String> {
    let AgentSession {
        mut args,
        permission_requests,
        model,
        smol_model,
        limits,
        show_reasoning,
        stream_reasoning,
        send_reasoning,
        mcp_servers,
        mcp_task,
        workspace,
        workspace_note,
    } = session;
    let ask_requests = crate::core::agent::interaction::new_registry();
    args.ask_requests = Some(ask_requests.clone());
    let todo_registry = crate::core::agent::todo::new_registry();
    args.todo_registry = Some(todo_registry.clone());
    let session_scratch = args.session_id.clone();
    let args = Arc::new(args);

    // Resolve the colour theme before anything highlights: `warm` below caches
    // the syntect theme, and the diff bands read the flag live. The auto path
    // queries the terminal, so it has to run under raw mode (enabled below);
    // an explicit `theme =` in config skips the query entirely.
    let theme_pref = crate::core::agent::global_config::theme_setting();

    // `env_logger` writes to stderr, which is still the user's terminal once we
    // switch to the alternate screen -- a single `log::warn!` from anywhere
    // (MCP, http, a dependency) then paints raw text over the frame and stays
    // there until the next full repaint. Nothing may write to the terminal
    // except the renderer, so mute the stderr sink for the duration and
    // restore it on the way out. Anything worth the user's attention is a
    // transcript note; see `connect_active` for the MCP case. Only stderr is
    // muted: the persistent log keeps recording, and an interactive session
    // that hangs is exactly what `jan bug-report` needs a trail for.
    let prev_stderr_log = super::file_log::set_stderr_enabled(false);
    let mut guard = TerminalGuard {
        prev_stderr: prev_stderr_log,
        raw: false,
    };

    enable_raw_mode().map_err(|e| e.to_string())?;
    guard.raw = true;
    // From here a panic must not leave the shell in raw mode on the alternate
    // screen: install before anything that can panic runs.
    install_panic_hook();
    // Under raw mode (so an OSC 11 reply is not echoed) but before the alternate
    // screen, so a query the terminal ignores leaves no stray bytes on the frame.
    theme::resolve_and_apply(theme_pref);
    // Deserializing syntect's syntax/theme dumps takes tens of milliseconds.
    // Doing it here, off the render loop, keeps the first code block of a
    // response from stalling a frame mid-stream. Spawned after the theme is
    // resolved so it caches the right variant.
    tokio::task::spawn_blocking(highlight::warm);
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableBracketedPaste).map_err(|e| e.to_string())?;
    let modes = startup_modes(crate::core::agent::global_config::mouse_enabled());
    let _ = stdout.write_all(modes.as_bytes());
    let _ = stdout.flush();
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).map_err(|e| e.to_string())?;

    // A git repo enables workspace snapshots (rewind can restore files); a
    // non-repo runs exactly as before with conversation-only rewind. With a
    // worktree the snapshots follow the tools into it, so a rewind restores the
    // checkout the edits actually landed in.
    let repo_root = git::repo_root(
        workspace
            .as_ref()
            .map_or(project_root.as_path(), |w| w.path.as_path()),
    );
    let mut app = App::new(
        model,
        limits,
        show_reasoning,
        agent_dir,
        project_root,
        repo_root,
    );
    app.set_workspace(workspace);
    app.smol_model = smol_model;
    app.stream_reasoning = stream_reasoning;
    app.send_reasoning = send_reasoning;
    app.args = Some(args.clone());
    // Adopt the session's startup run mode (e.g. `--plan`) so the header badge
    // shows immediately; a resumed thread overrides this via restore_run_mode.
    app.run_mode = args.run_mode;
    let seeded = initial_task
        .as_deref()
        .is_some_and(|t| !t.trim().is_empty());
    // The banner has to name the confinement, not assume it: "auto-approved
    // inside the OS sandbox" is a promise, and with the sandbox off it is the
    // wrong one. Unconfined, an approved command has exactly the access the
    // user does, and that is the thing worth saying up front.
    let sandboxed = args
        .sandbox
        .unwrap_or_else(|| crate::core::agent::r#loop::effective_sandbox(&app.project_root));
    app.approval_phrasing = match (args.auto_approve, sandboxed) {
        (true, true) => "auto-approved inside the OS sandbox (start with --safe to be asked first)".to_string(),
        (true, false) => "auto-approved and unsandboxed: commands run with your own access (--safe to be asked first, --sandbox to confine)".to_string(),
        (false, true) => "--safe: writes, shell commands and MCP tool calls need approval".to_string(),
        (false, false) => "--safe: approval needed, but unsandboxed - what you approve runs with your own access (--sandbox to confine)".to_string(),
    };
    app.push_session_banner(!seeded);
    if let Some(note) = workspace_note {
        app.note(&note);
    }
    if app.model.is_empty() {
        app.note("not signed in - run /login to choose a provider");
    } else if let Some(warning) = super::tokamak::expiry_warning() {
        // Say it at launch rather than letting the key expire into a 401 in the
        // middle of a run.
        app.note(&warning);
    }
    // Only when there is nothing to load: a project that already has JAN.md needs
    // no invitation, and the splash hint covers re-running /init deliberately.
    if !crate::core::agent::context::has_context_file(&app.project_root) {
        app.note("no JAN.md here — run /init to study this project and write one");
    }
    // A modified key the terminal is dropping looks like a bug in the composer,
    // so say so once, and only where a config file proves it is unconfigured
    // (see `terminal_setup::setup_hint`): the note disappears on its own once
    // /terminal-setup has run.
    if let Some(hint) = crate::core::app::commands::jan_home_dir()
        .filter(|_| crate::core::agent::global_config::terminal_hint_enabled())
        .and_then(|home| {
            super::terminal_setup::setup_hint(&home, cfg!(target_os = "macos"), |k| {
                std::env::var(k).ok()
            })
        })
    {
        app.note(&hint);
        app.system_detail_text("(terminal_hint = false in ~/.jan/config.toml silences this)");
    }
    // A failed resume is not fatal: the note explains why and the blank session
    // the user already has stays usable.
    if let Some(request) = &resume {
        apply_resume(&mut app, request).await;
        // `resolve_workspace` resolved the checkout for *this* thread, so it owns
        // it even when it had none recorded before (`--worktree` on a thread that
        // ran in the project directory).
        app.workspace_record = app
            .workspace_record
            .take()
            .or_else(|| app.workspace.clone());
        if app.thread_id.is_none() {
            app.note("starting a new session");
        }
    }
    if app.run_mode == crate::core::agent::plan::RunMode::Plan {
        app.note("◈ PLAN · read only — investigate, then propose a plan for review");
    }
    for path in &initial_images {
        match load_image_file(path) {
            Ok(img) => app.pending_images.push(img),
            Err(e) => app.note(&format!("could not attach image: {e}")),
        }
    }
    // From here on the terminal is ours: status sequences reach the real PTY.
    app.agent_status.enable();
    app.publish_agent_status();
    let res = chat_loop(
        &mut terminal,
        &args,
        &permission_requests,
        &ask_requests,
        &mut app,
        initial_task,
        mcp_task,
        &mcp_servers,
    )
    .await;

    // The last turn's journal may still be queued on the writer thread; a
    // process that exits now would lose it, and with it that turn's resume.
    app.join_journal();

    // Clean exit: the terminal is restored below, so a later panic (the hook
    // stays installed for the process) must not restore it a second time.
    release_terminal();
    let _ = disable_raw_mode();
    let _ = execute!(
        terminal.backend_mut(),
        DisableBracketedPaste,
        DisableMouseCapture,
        Print(KITTY_KEYS_OFF),
        Print(alt_scroll_restore()),
        LeaveAlternateScreen,
    );
    let _ = terminal.show_cursor();
    super::file_log::set_stderr_enabled(prev_stderr_log);
    guard.raw = false;
    // The session is closed: leave a copyable continuation command on the real
    // terminal, the same line the non-interactive path prints after a save.
    // Only a persisted thread can be resumed, so an empty session stays quiet.
    if let Some(id) = app.thread_id.as_deref() {
        if !app.history.is_empty() {
            eprintln!("{}", resume_hint(id));
        }
    }
    // The interactive session is over: wipe the persistent bash `/tmp` scratch
    // that its turns shared.
    if let Some(session) = session_scratch.as_deref() {
        let _ = workspace::remove_scratch_dir(session).await;
    }
    res
}

/// The off-loop work `chat_loop` owns: the run in flight and every background
/// job the interface waits on, one slot each. Grouped so the loop's steps can be
/// separate functions instead of one body closing over twenty locals.
struct LoopTasks {
    current: Option<CurrentRun>,
    /// Active MCP servers connect in the background; the first run is gated on
    /// them so the model's tools (collected once per run) are ready.
    mcp_task: Option<tokio::task::JoinHandle<crate::core::cli::mcp::ConnectOutcome>>,
    mcp_ready: bool,
    loading_noted: bool,
    /// Off-loop git snapshotting: one job at a time (checkpoints must stay
    /// ordered), driven from the queue `App` fills in submit_user/on_done.
    snap_task: Option<tokio::task::JoinHandle<Result<String, String>>>,
    snap_inflight: Option<SnapshotJob>,
    /// `/login` key verification: an HTTP round trip, so it runs off the render
    /// loop and the prompt keeps repainting ("verifying...") while it's in flight.
    login_task: Option<
        tokio::task::JoinHandle<
            Result<crate::core::cli::auth::LoginResult, crate::core::cli::auth::LoginError>,
        >,
    >,
    /// The browser-approval sign-in, in two off-loop halves: `begin` creates the
    /// session (one round trip), then the claim polls until the user approves --
    /// which can take minutes, so it must never touch the render loop.
    login_begin_task: Option<
        tokio::task::JoinHandle<
            Result<super::device_auth::PendingAuth, super::device_auth::BeginError>,
        >,
    >,
    login_claim_task: Option<tokio::task::JoinHandle<Result<super::tokamak::Login, String>>>,
    /// `/mcp` work that must not run on the render loop: a tool listing is a
    /// round trip to the peer, and an authorization waits on a browser for up to
    /// five minutes. One at a time -- the detail screen only ever asks for one.
    mcp_job: Option<tokio::task::JoinHandle<McpJobDone>>,
    /// `/context` computing the report: takes the MCP server lock (a turn
    /// executing an MCP tool call holds it for up to the tool-call timeout), so
    /// it must never run on the render loop. One at a time.
    context_task: Option<tokio::task::JoinHandle<ContextReport>>,
    /// `/usage <view>`: a round trip to the provider's usage API, so it runs off
    /// the render loop too. One at a time.
    usage_task: Option<tokio::task::JoinHandle<UsageDone>>,
    /// `/plugin install` clones a git repo, so it runs off the render loop via
    /// the installer's internal `spawn_blocking`; one at a time. A collection
    /// source resolves in two steps (list -> picker -> install the chosen set),
    /// and `plugin_install_url` remembers the source across them.
    plugin_install_task:
        Option<tokio::task::JoinHandle<Result<crate::core::agent::plugins::GitInstall, String>>>,
    plugin_install_url: Option<String>,
    /// Compaction is a summarizing model call, so it runs off the render loop
    /// too; `compact_base` is the history length it was computed from.
    compact_task: Option<tokio::task::JoinHandle<Result<Vec<serde_json::Value>, tauri_plugin_agent_tools::harness_error::HarnessError>>>,
    compact_base: usize,
    /// `/goal` evaluation: one stateless model call, off the render loop.
    goal_task: Option<GoalEvalTask>,
    /// `/model`'s probe of providers with no model list: network, so off-loop.
    model_fetch_task: Option<tokio::task::JoinHandle<ModelFetchDone>>,
    /// The dock's branch indicator is captured once at startup; re-read it on a
    /// slow timer so a checkout made outside the TUI (another terminal, an
    /// editor) is reflected without a restart. `None` once the project proves
    /// not to be a git repo, so a plain directory never shells out every tick.
    branch_task: Option<tokio::task::JoinHandle<Option<String>>>,
    /// `@path` hints: edits mark them dirty, the 50 ms tick starts one search.
    hint_task: Option<PathHintTask>,
}

impl LoopTasks {
    fn new(mcp_task: Option<tokio::task::JoinHandle<crate::core::cli::mcp::ConnectOutcome>>) -> Self {
        LoopTasks {
            current: None,
            mcp_ready: mcp_task.is_none(),
            mcp_task,
            loading_noted: false,
            snap_task: None,
            snap_inflight: None,
            login_task: None,
            login_begin_task: None,
            login_claim_task: None,
            mcp_job: None,
            context_task: None,
            usage_task: None,
            plugin_install_task: None,
            plugin_install_url: None,
            compact_task: None,
            compact_base: 0,
            goal_task: None,
            model_fetch_task: None,
            branch_task: None,
            hint_task: None,
        }
    }


    /// Start every background job the interface asked for since the last frame:
    /// snapshots, sign-in, `/mcp`, `/context`, `/usage`, plugin install,
    /// compaction, model probing and goal evaluation. Each slot runs one job at
    /// a time.
    fn start_requested_jobs(
        &mut self,
        app: &mut App,
        args: &Arc<OrchestrationArgs>,
        mcp_servers: &crate::core::state::SharedMcpServers,
    ) {
        // Drive the snapshot queue: run one job off-loop at a time. A job whose
        // inputs no longer resolve (snapshots disabled) is dropped.
        if self.snap_task.is_none() {
            while let Some(job) = app.snap_queue.pop_front() {
                if let Some((repo, parent, msg, id, changed)) = app.resolve_snapshot(&job) {
                    self.snap_task = Some(spawn_snapshot(repo, parent, msg, id, changed));
                    self.snap_inflight = Some(job);
                    break;
                }
            }
        }

        // Esc closed the dock while sign-in work was in flight: drop all of it,
        // so a late reply can't report a sign-in the user walked away from. The
        // dock stays open for the whole flow, so this is the one cancel path.
        if app.login.is_none() {
            if let Some(task) = self.login_task.take() {
                task.abort();
            }
            if let Some(task) = self.login_claim_task.take() {
                task.abort();
            }
            if let Some(task) = self.login_begin_task.take() {
                task.abort();
            }
            app.login_device_request = false;
        }
        // The detail screen asked for something off-loop. One job at a time, and
        // a request arriving while one is in flight *waits* rather than being
        // dropped: an authorization owns the slot for up to `CALLBACK_TIMEOUT`
        // while the browser is out, and a tool listing dropped in that window
        // would leave the screen on `listing...` with nothing to retrigger it.
        // The slot holds the latest request only -- a newer one replaces it, and
        // a request whose server the screen has since left is discarded on
        // arrival by `finish_mcp_job`.
        // The user cancelled the in-flight sign-in. Abort the job (dropping the
        // bound loopback listener that `PendingAuth` holds), so the wait ends now
        // instead of running out its `CALLBACK_TIMEOUT`.
        if app.mcp_auth_cancel {
            app.mcp_auth_cancel = false;
            if let Some(job) = self.mcp_job.take() {
                job.abort();
            }
            app.browser_confirm = None;
            if let Some(flow) = app.mcp_auth.take() {
                app.note(&format!("sign-in for '{}' cancelled", flow.server));
            }
        }
        if self.mcp_job.is_none() {
            if let Some(job) = app.mcp_job_request.take() {
                let servers = mcp_servers.clone();
                self.mcp_job = Some(tokio::spawn(run_mcp_job(job, servers)));
            }
        }
        // `/context` asked for a report. Compute it off the render loop (it
        // takes the MCP server lock), one at a time. The snapshot carries the
        // state the computation needs, so nothing borrows `App` across the
        // spawn.
        if self.context_task.is_none() && app.context_request {
            app.context_request = false;
            let snapshot = app.context_snapshot();
            self.context_task = Some(tokio::spawn(compute_context_report(snapshot)));
        }
        if self.usage_task.is_none() {
            if let Some(query) = app.usage_request.take() {
                self.usage_task = Some(tokio::spawn(async move {
                    let result = crate::core::cli::tokamak::usage::fetch(&query).await;
                    (query, result)
                }));
            }
        }
        // A key was submitted at the `/login` prompt: verify it off-loop. One at
        // a time - the prompt is read-only while `verifying`.
        if self.login_task.is_none() {
            if let Some((provider, key)) = app.login_submit.take() {
                self.login_task = Some(tokio::spawn(async move {
                    let definition =
                        crate::core::cli::auth::provider_by_id(&provider).ok_or_else(|| {
                            crate::core::cli::auth::LoginError::InvalidKey(
                                "selected provider is unavailable".to_string(),
                            )
                        })?;
                    crate::core::cli::auth::providers::login_with_api_key(&definition, &key).await
                }));
            }
        }

        // `/login` asked for the browser flow: create the session off-loop. Only
        // when nothing else sign-in shaped is already running, so a repeated
        // `/login` cannot open two sessions.
        if app.login_device_request
            && self.login_begin_task.is_none()
            && self.login_claim_task.is_none()
            && self.login_task.is_none()
        {
            app.login_device_request = false;
            self.login_begin_task = Some(tokio::spawn(async move {
                super::device_auth::begin(&super::tokamak::base_url()).await
            }));
        }

        // `/plugin install` was typed: clone off-loop (the network-bound git
        // work runs inside the installer's `spawn_blocking`), and refuse a
        // second while one is in flight. `list_collection` installs a plain
        // source outright and only *lists* an ambiguous collection, which
        // `finish_plugin_install` turns into the picker.
        if self.plugin_install_task.is_none() {
            if let Some(spec) = app.plugin_install_request.take() {
                app.plugin_installing = true;
                let root = app.project_root.clone();
                self.plugin_install_url = Some(spec.clone());
                self.plugin_install_task = Some(tokio::spawn(async move {
                    crate::core::agent::plugins::list_collection(&root, &spec).await
                }));
            } else if let Some((spec, paths)) = app.plugin_select_request.take() {
                // Second step: the picker's chosen subset of a collection.
                app.plugin_installing = true;
                let root = app.project_root.clone();
                self.plugin_install_url = Some(spec.clone());
                self.plugin_install_task = Some(tokio::spawn(async move {
                    crate::core::agent::plugins::install_selected(&root, &spec, paths)
                        .await
                        .map(crate::core::agent::plugins::GitInstall::Installed)
                }));
            }
        }

        // `/compact` (or the auto trigger) was requested: summarize off-loop.
        // One at a time -- both request sites already refuse while one is in
        // flight, and the result replaces `history` wholesale.
        while let Ok(answer) = app.btw_rx.try_recv() {
            for (i, line) in answer.lines().enumerate() {
                if i == 0 {
                    app.note(line);
                } else {
                    app.system_detail_text(line);
                }
            }
        }
        if self.compact_task.is_none() {
            if let Some(kind) = app.compact_request.take() {
                let args = args.clone();
                let model = app.model.clone();
                let history = app.history.clone();
                let keep = kind.keep_recent(app.compaction_keep_recent);
                let focus = app.compact_focus.take();
                self.compact_base = history.len();
                app.compacting = Some(kind);
                app.compact_started = Some(Instant::now());
                self.compact_task = Some(tokio::spawn(async move {
                    crate::core::agent::r#loop::compact_history(
                        &args,
                        &model,
                        &history,
                        keep,
                        focus.as_deref(),
                    )
                    .await
                }));
            }
        }

        // A turn finished under an active goal: run the (stateless) evaluator
        // before anything else. It either auto-submits the next turn (setting
        // want_start) or hands control back. Gated on an idle, run-free state so
        // it never races an in-flight turn.
        if self.model_fetch_task.is_none() && std::mem::take(&mut app.model_fetch_request) {
            app.model_fetch_running = true;
            self.model_fetch_task = Some(tokio::spawn(fetch_models_job(
                app.project_root.clone(),
                app.probed_models.clone(),
            )));
        }
        if self.goal_task.is_none() && app.goal_eval_pending && self.current.is_none() && !app.want_start {
            self.goal_task = app.begin_goal_evaluation();
        }
        // Esc, or the user submitting a message themselves, stops the
        // evaluation: its verdict would otherwise start a second turn.
        if app.goal_evaluating && (app.goal_eval_cancel || app.want_start) {
            if let Some(task) = self.goal_task.take() {
                task.abort();
            }
            app.stop_goal_evaluation();
        }
    }

    /// Kick off a queued run once the previous one has cleared, the MCP servers
    /// (if any) are connected, and the base snapshot (if any) is captured.
    async fn start_queued_run(&mut self, app: &mut App, args: &Arc<OrchestrationArgs>) {
        // Kick off a queued run once the previous one has cleared, the MCP
        // servers (if any) are connected, and the base snapshot (if any) is
        // captured. `submit_user` already flipped status to Running and reset
        // the counter.
        // A compaction in flight is also a gate: it replaces `history`, so a run
        // started against the pre-compaction copy would be clobbered.
        if app.want_start && self.current.is_none() && self.compact_task.is_none() {
            let base_ready = app.repo_root.is_none() || app.base_snapshot.is_some();
            if self.mcp_ready && base_ready {
                app.want_start = false;
                // The submission itself is one human turn toward the aging
                // grace period; model roundtrips count via `Step` events.
                age_closed_todos(app).await;
                let mut body = app.body();
                if let Some(command) = app.scripted_command.take() {
                    body["jan_scripted_command"] = serde_json::json!(command);
                }
                self.current = Some(spawn_run(&run_args(app, args), body));
            } else if !self.loading_noted && !self.mcp_ready {
                // The base snapshot gates silently; only the MCP connect notes.
                self.loading_noted = true;
                app.note("connecting MCP servers...");
            }
        }
    }

    /// The 50 ms tick: start a queued path-hint search, advance the animations
    /// and handle every terminal event queued since the last tick.
    async fn on_tick(
        &mut self,
        app: &mut App,
        ask_requests: &crate::core::agent::interaction::AskRegistry,
        registry: &PermissionRegistry,
        mcp_servers: &crate::core::state::SharedMcpServers,
    ) {
        if let Some((generation, root, query)) = app.take_path_hint_request() {
            self.hint_task = Some(spawn_path_hint_search(generation, root, query));
        }
        // Advance the throbber at its own fixed cadence, catching up
        // whole frames if a tick stalled (a burst of deltas / slow term).
        app.advance_spinner(Instant::now());
        // Animate the working-title spinner on the same cadence; the
        // OSC 9999 payload is not re-sent, only the title frame.
        app.agent_status.animate();
        let mut queued = Vec::new();
        while event::poll(Duration::ZERO).unwrap_or(false) {
            match event::read() {
                Ok(event) => queued.push(event),
                Err(_) => break,
            }
        }
        // The legacy Windows console has no bracketed paste: a paste
        // arrives as one key event per character. Everything queued
        // since the last tick that reads as one paste is handed over as
        // one, so its newlines are text and not a submit per line.
        let queued = if cfg!(windows) { coalesce_burst(queued) } else { queued };
        for event in queued {
            match Ok::<Event, ()>(event) {
                Ok(Event::Key(key)) => {
                    // Typing moves the content under a highlight, and the
                    // copy already happened on release.
                    app.clear_selection();
                    if !handle_ask_key(app, key, ask_requests).await {
                        handle_key(app, key, registry, &mut self.current, mcp_servers).await;
                    }
                }
                Ok(event @ Event::Paste(_)) => route_paste_event(app, event),
                Ok(event @ Event::Resize(_, _)) => route_resize_event(app, event),
                // `handle_ask_mouse` mutates app state, so it stays in the
                // arm body rather than a match guard that hides the effect.
                #[allow(clippy::collapsible_match)]
                Ok(Event::Mouse(mouse)) => {
                    if !handle_ask_mouse(app, mouse, ask_requests).await {
                        handle_mouse(app, mouse);
                    }
                }
                _ => {}
            }
        }
    }

    /// The background MCP connect finished: open the gate on the first run and
    /// say how it went.
    fn on_mcp_connected(&mut self, app: &mut App, outcome: crate::core::cli::mcp::ConnectOutcome) {
        self.mcp_ready = true;
        if !outcome.connected.is_empty() {
            app.note(&format!("MCP ready: {}", outcome.connected.join(", ")));
        }
        // Right after the ready line, so a server that didn't come up
        // is visible at start/resume instead of being lost to a log
        // line painted over the frame.
        for failure in &outcome.failed {
            app.note(&format!("MCP: {failure}"));
        }
        // A server that only needs signing in is separated from a
        // broken one: the fix is a keypress away, so name it.
        if !outcome.needs_auth.is_empty() {
            app.note(&format!(
                "MCP: {} need authentication - open /mcp to sign in",
                outcome.needs_auth.join(", ")
            ));
        }
    }

    /// The browser sign-in session was created (or could not be).
    fn on_login_begun(
        &mut self,
        app: &mut App,
        begun: Result<super::device_auth::PendingAuth, super::device_auth::BeginError>,
    ) {
        match begun {
            Ok(pending) => {
                show_login_approval(app, pending.session());
                self.login_claim_task =
                    Some(tokio::spawn(super::tokamak::device_login(pending)));
            }
            // Not a failure, but say it: an unexplained paste field
            // reads as the browser sign-in having silently broken.
            Err(super::device_auth::BeginError::Unsupported) => {
                app.note("this Tokamak deployment does not support browser sign-in yet");
                open_login_prompt(app, "tokamak");
            }
            Err(e) => {
                app.note(&format!(
                    "browser sign-in unavailable: {}",
                    e.message(&super::tokamak::base_url())
                ));
                open_login_prompt(app, "tokamak");
            }
        }
    }

    /// A snapshot job finished: record the base or checkpoint, or disable
    /// snapshots when the base cannot be taken.
    fn on_snapshot_done(&mut self, app: &mut App, snap_res: Result<String, String>) {
        match (self.snap_inflight.take(), snap_res) {
            (Some(SnapshotJob::Base), Ok(sha)) => {
                app.base_snapshot = Some(sha);
                app.persist();
            }
            (Some(SnapshotJob::Checkpoint { user_index, preview, .. }), Ok(sha)) => {
                app.checkpoints.push(Checkpoint { user_index, preview, sha });
                app.persist();
            }
            (Some(SnapshotJob::Base), Err(e)) => {
                // Base failed: disable snapshots for the session and drop
                // any queued checkpoints (they have no base to parent).
                app.note(&format!("workspace snapshots disabled: {e}"));
                app.repo_root = None;
                app.snap_queue.clear();
            }
            (Some(SnapshotJob::Checkpoint { .. }), Err(e)) => {
                app.detail = format!("checkpoint failed: {e}");
            }
            (None, _) => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn chat_loop<B: Backend>(
    terminal: &mut Terminal<B>,
    args: &Arc<OrchestrationArgs>,
    registry: &PermissionRegistry,
    ask_requests: &crate::core::agent::interaction::AskRegistry,
    app: &mut App,
    initial_task: Option<String>,
    mcp_task: Option<tokio::task::JoinHandle<crate::core::cli::mcp::ConnectOutcome>>,
    mcp_servers: &crate::core::state::SharedMcpServers,
) -> Result<(), String> {
    let mut tasks = LoopTasks::new(mcp_task);
    let mut ticker = tokio::time::interval(Duration::from_millis(50));
    let mut branch_poll = tokio::time::interval(BRANCH_POLL_INTERVAL);
    branch_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Nothing to say when there is no seed message: the splash already invites
    // the first one (`Banner::awaiting_first_message`).
    if let Some(task) = initial_task.filter(|t| !t.trim().is_empty()) {
        app.submit_user(task.trim().to_string());
    }

    // kitty drops the resize repaint behind a held synchronized frame, so it is
    // gated off there; see `use_synchronized_output`.
    let sync_output = use_synchronized_output();

    while !app.should_quit {
        // Drive the background jobs the last frame asked for, then start a queued
        // run if everything it waits on is ready.
        tasks.start_requested_jobs(app, args, mcp_servers);
        tasks.start_queued_run(app, args).await;

        // Wrap the repaint in synchronized-output (`\x1b[?2026h/l`) so the
        // terminal buffers the whole frame and flips it atomically, eliminating
        // tearing. Written straight to stdout (not the generic `Backend`) for the
        // same reason the clipboard write below is: `chat_loop` is generic over
        // B for TestBackend, which isn't `io::Write`. ratatui already diffs the
        // buffer and emits ANSI only for changed cells. Skipped under kitty,
        // whose resize handling drops the frame behind a held synchronized
        // frame (see `use_synchronized_output`).
        if sync_output {
            let _ = execute!(io::stdout(), BeginSynchronizedUpdate);
        }
        // A repaint was asked for (Ctrl-L, or a resize): reset the diff
        // baseline so this draw re-emits every cell. Inside the synchronized
        // frame, so the terminal flips from the damaged frame straight to the
        // repaired one and never presents the cleared screen in between.
        if app.take_repaint() {
            apply_repaint(terminal);
        }
        let draw_result = terminal.draw(|f| draw(f, app)).map_err(|e| e.to_string());
        if sync_output {
            let _ = execute!(io::stdout(), EndSynchronizedUpdate);
        }
        draw_result?;
        // Outside the synchronized block: `draw` only extracts the text, so the
        // OSC 52 write can't land in the middle of a frame.
        if let Some(text) = app.copy_request.take() {
            copy_to_clipboard(&text);
        }


        tokio::select! {
            _ = ticker.tick() => {
                tasks.on_tick(app, ask_requests, registry, mcp_servers).await;
            }
            _ = branch_poll.tick() => {
                if tasks.branch_task.is_none() {
                    tasks.branch_task = Some(spawn_branch_poll(&app.project_root));
                }
            }
            branch = await_branch_poll(&mut tasks.branch_task) => {
                app.git_branch = branch;
            }
            found = await_path_hints(&mut tasks.hint_task) => {
                if let Some((generation, items)) = found {
                    app.apply_path_hints(generation, items);
                }
            }
            outcome = await_mcp(&mut tasks.mcp_task) => {
                tasks.on_mcp_connected(app, outcome);
            }
            Some(done) = await_mcp_job(&mut tasks.mcp_job) => {
                finish_mcp_job(app, done, mcp_servers, &mut tasks.mcp_job).await;
            }
            Some(done) = await_usage(&mut tasks.usage_task) => {
                finish_usage(app, done);
            }
            Some(report) = await_context(&mut tasks.context_task) => {
                // Only apply a report the user is still looking at: a result
                // landing after the overlay was closed must not reopen it.
                finish_context_report(app, report);
            }
            login_res = await_login(&mut tasks.login_task) => {
                let login_ok = login_res.is_ok();
                finish_login(app, login_res);
                if login_ok {
                    reload_provider_configs(app).await;
                }
            }
            begun = await_login_begin(&mut tasks.login_begin_task) => {
                tasks.on_login_begun(app, begun);
            }
            claimed = await_tokamak_login(&mut tasks.login_claim_task) => {
                if finish_tokamak_login(app, claimed) {
                    reload_provider_configs(app).await;
                }
            }
            plugin_res = await_plugin_install(&mut tasks.plugin_install_task) => {
                finish_plugin_install(app, tasks.plugin_install_url.take(), plugin_res);
            }
            compacted = await_compaction(&mut tasks.compact_task) => {
                finish_compaction(app, compacted, tasks.compact_base);
            }
            Some(done) = await_model_fetch(&mut tasks.model_fetch_task) => {
                finish_model_fetch(app, done).await;
            }
            evaluated = await_goal_eval(&mut tasks.goal_task) => {
                match evaluated {
                    Some((goal, verdict)) => app.finish_goal_evaluation(goal, verdict),
                    None => {
                        app.goal_evaluating = false;
                        app.note("◎ goal evaluation failed (goal kept; /goal clear to stop)");
                    }
                }
            }
            snap_res = await_snapshot(&mut tasks.snap_task) => {
                tasks.on_snapshot_done(app, snap_res);
            }
            ev = next_event(&mut tasks.current) => {
                match ev {
                    RunEvent::Stream(ev) => apply_stream_event(app, ev, &mut tasks.current).await,
                    RunEvent::Steering(request) => app.steer_run(request),
                }
                drain_stream_events(app, &mut tasks.current).await;
            }
        }
    }

    if let Some(c) = tasks.current {
        c.handle.abort();
    }
    crate::core::agent::interaction::cancel_all(ask_requests).await;
    Ok(())
}

/// Route a terminal resize to a full repaint. ratatui notices a *changed*
/// size on the next `draw` and redraws, but an emulator that reflows during a
/// drag can damage the screen and come back to the same size before that draw
/// runs -- and then the diff sees nothing to do. Display only.
fn route_resize_event(app: &mut App, event: Event) {
    if matches!(event, Event::Resize(_, _)) {
        app.request_repaint();
    }
}

/// Clear the screen and reset ratatui's diff baseline, so the next `draw`
/// re-emits every cell instead of only those its buffers say changed.
///
/// `Terminal::resize` rather than `Terminal::clear`: both clear and reset the
/// baseline, but `clear` first asks the backend for the cursor position, which
/// on crossterm is a blocking DSR (`\x1b[6n`) round trip of up to two seconds.
/// A terminal that never answers would freeze streaming and input for that
/// long and then skip the clear anyway. `size` is a local ioctl.
///
/// Best-effort, like the synchronized-update markers: a terminal that will not
/// report its size is no reason to end the session, and the frame still draws.
fn apply_repaint<B: Backend>(terminal: &mut Terminal<B>) {
    if let Ok(size) = terminal.size() {
        let _ = terminal.resize(size.into());
    }
}

/// Resolve the display label for `model`: the `provider/model` pair when the
/// bare id maps to a configured provider (mirroring upstream resolution:
/// an exact hit in a provider's `models` list, or a `<provider>/<model>`
/// prefix). A bare id stays bare when no provider claims it, so a fresh or
/// custom id is not mislabeled.
fn provider_label_for_model(
    model: &str,
    pc: &HashMap<String, crate::core::state::ProviderConfig>,
) -> String {
    use crate::core::cli::providers::is_cli_reachable;
    // Explicit `<provider>/<model>` form: verify the prefix names a provider.
    if let Some(sep) = model.find('/') {
        if pc.contains_key(&model[..sep]) {
            return model.to_string();
        }
    }
    // Bare id: find the (preferentially reachable, credentialed) provider that
    // offers it, matching `resolve_upstream_for_model`'s deterministic pick.
    let offers = |c: &&crate::core::state::ProviderConfig| c.models.iter().any(|m| m == model);
    let reachable = pc
        .iter()
        .filter(|(_, c)| is_cli_reachable(c) && offers(c))
        .min_by_key(|(name, c)| (std::cmp::Reverse(c.api_key.is_some()), (*name).clone()))
        .or_else(|| pc.iter().find(|(_, c)| offers(c)));
    match reachable {
        Some((name, _)) if name != model => format!("{name}/{model}"),
        Some(_) => model.to_string(),
        None => model.to_string(),
    }
}

#[cfg(test)]
mod tests;
