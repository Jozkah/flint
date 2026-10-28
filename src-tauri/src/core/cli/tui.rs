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

/// Which cells a drag covers. `Linear` follows reading order, taking whole rows
/// between the endpoints; `Block` takes the rectangle between them, for lifting
/// one column out of a table or a diff without its `+`/`-` markers. Alt held as
/// the drag starts picks `Block`.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SelectionMode {
    Linear,
    Block,
}

/// A mouse selection in frame cell coordinates. The TUI owns selection outright
/// because mouse tracking takes it away from the terminal: without this, a drag
/// with tracking on would do nothing at all.
#[derive(Debug, Clone, Copy)]
struct Selection {
    anchor: (u16, u16),
    head: (u16, u16),
    mode: SelectionMode,
    /// Button still held, so edge auto-scroll may run.
    dragging: bool,
    /// The pointer moved since the press. A press that never moves is a click
    /// (expand a tool row), not a selection.
    moved: bool,
}

impl Selection {
    fn new(at: (u16, u16), mode: SelectionMode) -> Self {
        Self {
            anchor: at,
            head: at,
            mode,
            dragging: true,
            moved: false,
        }
    }

    /// Covered cells as `(row, first_col, last_col)`, inclusive on both ends and
    /// clipped to `width`. Ordered top to bottom regardless of drag direction.
    fn spans(&self, width: u16) -> Vec<(u16, u16, u16)> {
        let last = width.saturating_sub(1);
        let (a, h) = (self.anchor, self.head);
        match self.mode {
            SelectionMode::Block => {
                let (c0, c1) = (a.0.min(h.0).min(last), a.0.max(h.0).min(last));
                (a.1.min(h.1)..=a.1.max(h.1)).map(|r| (r, c0, c1)).collect()
            }
            SelectionMode::Linear => {
                let (start, end) = if (a.1, a.0) <= (h.1, h.0) {
                    (a, h)
                } else {
                    (h, a)
                };
                (start.1..=end.1)
                    .map(|r| {
                        let c0 = if r == start.1 { start.0.min(last) } else { 0 };
                        let c1 = if r == end.1 { end.0.min(last) } else { last };
                        (r, c0, c1)
                    })
                    .collect()
            }
        }
    }
}

#[derive(Debug, PartialEq)]
enum Status {
    Idle,
    Running,
}

/// Kind of the last transcript block, used to insert a blank line only when the
/// block kind changes (so consecutive tool lines group, but prose/tool/user
/// turns get breathing room).
#[derive(PartialEq, Clone, Copy)]
enum Kind {
    None,
    User,
    Prose,
    Reasoning,
    Tool,
    Meta,
}

/// Gutter glyph for a system line. A category with its own established glyph
/// (`◎` for a goal) passes that instead, so the column always carries exactly
/// one marker.
const SYSTEM_GLYPH: &str = "•";

/// Gutter glyph for goal-loop lines, matching the header's `◎ /goal` badge.
const GOAL_GLYPH: &str = "◎";

/// Gutter for the body rows of a multi-line system block. Distinct from the tool
/// rows' `│` and the reasoning rows' `┊`, so three stacked blocks stay tellable
/// apart at a glance.
const SYSTEM_CONT: &str = "┆";

/// How loud a system line is. The only thing that varies between them, so it is
/// a parameter rather than a colour picked at each of the ~90 call sites.
#[derive(Copy, Clone, PartialEq)]
enum Level {
    /// A dim acknowledgement or status note.
    Info,
    /// Something the user should notice but that needs no action.
    Warn,
    /// A failed turn, tool or command.
    Error,
    /// Work that completed successfully.
    Good,
}

impl Level {
    /// `(gutter, body)` styles. The gutter always carries colour so the marker
    /// is scannable down the left edge even when the body is dim.
    fn styles(self) -> (Style, Style) {
        match self {
            Level::Info => (Style::new().light_blue(), Style::new().dim()),
            Level::Warn => (Style::new().yellow(), Style::new().yellow()),
            Level::Error => (Style::new().red().bold(), Style::new().red().bold()),
            Level::Good => (Style::new().green(), Style::new().green().bold()),
        }
    }
}

/// Blocks that read as one run of activity and so need no blank between them.
/// A turn alternating folded reasoning summaries with tool rows was spending a
/// blank line on every switch, which is most of the turn.
fn band(kind: Kind) -> u8 {
    match kind {
        Kind::Tool | Kind::Reasoning => 0,
        Kind::None => 1,
        Kind::User => 2,
        Kind::Prose => 3,
        Kind::Meta => 4,
    }
}

struct Pending {
    request_id: String,
    tool_name: String,
    capability: String,
    path: Option<String>,
    /// Shell command for exec prompts; drives the command-scoped always-grant.
    command: Option<String>,
    /// Focused diff preview for write/edit prompts, shown so the user approves
    /// with the change in view; `None` for other tools.
    diff: Option<String>,
    offers_always: bool,
    /// Why this call is being asked about when that is not obvious from the
    /// call itself: a destructive command, a paused auto-approval, a command
    /// that needs to run outside the sandbox.
    reason: Option<String>,
    /// The gate's class for the prompt (`write`, `exec`, `secret`, ...). Only
    /// `secret` changes what is offered: "Write anyway" in place of "Allow
    /// once", and never an "always".
    prompt_kind: String,
    /// Highlighted option in the docked prompt (index into `options()`).
    selected: usize,
    /// Name of the subagent that requested this, when the call originated inside
    /// a nested subagent run; `None` for the parent agent's own calls.
    subagent: Option<String>,
    /// When the prompt arrived. Decision keys are ignored for a short settle
    /// window so a key typed for something else cannot answer it.
    shown_at: Instant,
}

/// How long a new permission prompt ignores decision keys (y/a/n/Enter).
const PERMISSION_SETTLE: Duration = Duration::from_millis(400);

impl Pending {
    /// True once the prompt has been on screen long enough to take a decision.
    fn settled(&self) -> bool {
        self.shown_at.elapsed() >= PERMISSION_SETTLE
    }

    /// One-line summary for the transcript decision record.
    fn summary(&self) -> String {
        let target = self
            .path
            .as_deref()
            .map(|p| format!(" on {p}"))
            .unwrap_or_default();
        format!("{} via '{}'{target}", self.capability, self.tool_name)
    }

    /// Label for the "allow always" option: command-scoped for exec (thread
    /// only), capability-scoped otherwise. All grants are thread-scoped. For an
    /// exec prompt the label names every base the command runs, so the user
    /// sees exactly what a grant covers (`git status && rm foo` -> git AND rm);
    /// commands that can't be decomposed grant only their exact text.
    fn always_label(&self) -> String {
        use tauri_plugin_agent_tools::tools::cmdscan::{scan_command, CommandScan};
        let Some(command) = self.command.as_deref() else {
            return "Allow always (this thread)".to_string();
        };
        // The grant is the exact command (AH-037: `grant_command` records the
        // string shown, `covers_command` matches only it), so the label says
        // so. It used to name the base commands -- "Allow all 'git' commands"
        // -- a scope the grant has not had since (Jozkah/jan#126).
        match scan_command(command) {
            CommandScan::Bases(bases) if bases.is_empty() => "Allow always (this thread)".to_string(),
            CommandScan::Bases(_) | CommandScan::Opaque => {
                "Allow this exact command (this thread)".to_string()
            }
        }
    }

    /// The prompt's header rows -- who is asking, for what capability, and on
    /// which command or path -- laid out at `inner`. A command keeps its own
    /// newlines and wraps, so a heredoc is approved on what it actually says
    /// rather than on its first 60 columns.
    fn detail_lines(&self, inner: u16) -> Vec<Line<'static>> {
        let dim = Style::new().dark_gray();
        let max = inner.max(1) as usize;
        let mut out = Vec::new();
        if let Some(name) = &self.subagent {
            out.push(Line::from(vec![
                Span::styled("subagent ", dim),
                Span::styled(name.clone(), Style::new().magenta().bold()),
                Span::styled(" is asking:", dim),
            ]));
        }
        out.extend(
            wrap_spans_hard(
                vec![
                    Span::styled(self.tool_name.clone(), Style::new().cyan().bold()),
                    Span::styled(" wants ", dim),
                    Span::styled(self.capability.clone(), Style::new().yellow().bold()),
                ],
                max,
            )
            .into_iter()
            .map(Line::from),
        );
        let target = match (&self.command, &self.path) {
            (Some(command), _) => Some(("$ ", command.clone())),
            (None, Some(path)) => Some(("on ", path.clone())),
            (None, None) => None,
        };
        if let Some((lead, body)) = target {
            out.extend(gutter_lines(
                // Terminal default foreground rather than an explicit white,
                // which is invisible on a light background.
                wrap_text(&body, Style::new(), max.saturating_sub(2).max(1)),
                vec![Span::styled(lead, dim)],
                vec![Span::raw("  ")],
            ));
        }
        if let Some(reason) = &self.reason {
            out.extend(
                wrap_text(reason, Style::new().yellow(), max)
                    .into_iter()
                    .map(Line::from),
            );
        }
        out
    }

    /// Boxed diff preview for the prompt, sized to `inner` width; empty when the
    /// tool carries no diff (exec/read). No gutter: the panel sits flush in the
    /// prompt box, unlike the tool-row-aligned result diff.
    fn diff_preview(&self, inner: u16) -> Vec<Line<'static>> {
        match &self.diff {
            Some(d) => diff_lines(
                d,
                inner as usize,
                DIFF_PREVIEW_MAX_ROWS,
                "",
                self.path.as_deref(),
            ),
            None => Vec::new(),
        }
    }

    /// Selectable decisions, in display order. `AllowAlways` only when offered.
    fn options(&self) -> Vec<(PermissionDecision, String)> {
        if self.prompt_kind == "secret" {
            // This one write, nothing remembered.
            return vec![
                (PermissionDecision::AllowOnce, "Write anyway".to_string()),
                (PermissionDecision::Deny, "Deny".to_string()),
            ];
        }
        let mut opts = vec![(PermissionDecision::AllowOnce, "Allow once".to_string())];
        if self.offers_always {
            opts.push((PermissionDecision::AllowAlways, self.always_label()));
        }
        opts.push((PermissionDecision::Deny, "Deny".to_string()));
        opts
    }

    fn move_selection(&mut self, delta: isize) {
        let len = self.options().len() as isize;
        self.selected = (self.selected as isize + delta).rem_euclid(len) as usize;
    }
}

/// What a highlighted picker row does on Enter.
#[derive(PartialEq, Clone, Copy, Debug)]
enum PickerKind {
    ResumeThread,
    LoginProvider,
    ToggleMcp,
    /// Double-Esc rewind: pick a past user message to roll back to.
    RewindMessage,
    /// `/fork`: pick the past user message to branch before. Same list as
    /// `RewindMessage`; the cut is written to a new thread instead of this one.
    ForkMessage,
    /// `/tree`: the fork forest of this project's saved threads. Enter resumes
    /// the selected node.
    ThreadTree,
    /// Second step of a rewind: restore conversation only, or + workspace.
    RewindScope,
    /// Read-only view of `~/.jan/config.toml` providers (`/config`). Enter closes.
    ViewConfig,
    /// `/settings`: browse editable keys from agent.toml and `~/.jan/config.toml`;
    /// Enter opens a docked edit prompt for the selected row.
    AgentSettings,
    /// `/settings > providers`: manage `~/.jan/config.toml` providers via a
    /// docked add/edit wizard (`a`/`e`) or deletion (`d`).
    ProviderSettings,
    /// `/todo` editor: browse the phased list and mutate the selected task
    /// (done/drop/rm) through the same canonical `TodoList` the model uses.
    Todo,
    /// `/plugin install <collection>`: choose which plugins inside a collection
    /// repo to install. Space toggles a row, Enter installs everything checked.
    PluginSelect,
    /// One MCP server's detail screen: the info block plus the actions that
    /// apply to it (see `open_mcp_detail`). Reached with Enter from `ToggleMcp`.
    McpServer,
    /// `/agents`: the live fan-out inspector. Lists every running subagent with
    /// its stats and current activity, rebuilt from `App::subagents` each frame.
    Agents,
    /// One subagent's detail: its stats, brief, and collapsed call history.
    /// Reached with Enter from `Agents`; Esc steps back to the list.
    AgentDetail,
    /// `/shells`: inspect commands detached by the `bash` tool.
    BackgroundShells,
}

/// Interactive list overlay (`/resume`, `/login`, `/mcp`, etc.): rows with a
/// highlighted cursor, acted on by `PickerKind` on Enter.
struct Picker {
    kind: PickerKind,
    items: Vec<PickerItem>,
    selected: usize,
    /// Index of the provider row a first `d` armed for deletion, so a second
    /// `d` on the same row confirms it. `None` = nothing armed. Resets on
    /// navigation so an unrelated keypress can never delete by accident.
    armed_delete: Option<usize>,
}

impl Picker {
    fn title(&self) -> &'static str {
        match self.kind {
            PickerKind::ResumeThread => " resume thread ",
            PickerKind::LoginProvider => " sign in ",
            PickerKind::ToggleMcp => " mcp servers ",
            PickerKind::RewindMessage => " rewind to message ",
            PickerKind::ForkMessage => " fork before message ",
            PickerKind::ThreadTree => " thread tree ",
            PickerKind::RewindScope => " restore ",
            PickerKind::ViewConfig => " provider config ",
            PickerKind::AgentSettings => " agent settings ",
            PickerKind::ProviderSettings => " providers ",
            PickerKind::Todo => " todo ",
            PickerKind::PluginSelect => " install plugins ",
            PickerKind::McpServer => " mcp server ",
            PickerKind::Agents => " subagents ",
            PickerKind::AgentDetail => " subagent ",
            PickerKind::BackgroundShells => " background shells ",
        }
    }

    fn action_hint(&self) -> &'static str {
        match self.kind {
            PickerKind::ResumeThread => " ↑/↓ select   Enter resume   Esc cancel",
            PickerKind::LoginProvider => " ↑/↓ select   Enter sign in   x sign out   Esc cancel",
            PickerKind::ToggleMcp => {
                " ↑/↓ select   Enter open   Space toggle   a add   e edit   d delete   Esc close"
            }
            PickerKind::RewindMessage => " ↑/↓ select   Enter choose   Esc cancel",
            PickerKind::ForkMessage => " ↑/↓ select   Enter fork   Esc cancel",
            PickerKind::ThreadTree => " ↑/↓ select   Enter resume   Esc cancel",
            PickerKind::RewindScope => " ↑/↓ select   Enter restore   Esc cancel",
            PickerKind::ViewConfig => " set via: flint config set --provider <id> ...   Esc close",
            PickerKind::AgentSettings => " ↑/↓ select   Enter edit   x unset   Esc close",
            PickerKind::ProviderSettings => {
                " ↑/↓ select   Enter edit   a add   dd delete   x logout   Esc close"
            }
            PickerKind::Todo => " ↑/↓ select   d done   x abandon   r remove   Esc close",
            PickerKind::PluginSelect => " ↑/↓ select   Space toggle   Enter install   Esc cancel",
            PickerKind::McpServer => " ↑/↓ select   Enter run   Esc back",
            PickerKind::Agents => " ↑/↓ select   Enter view   Esc close",
            PickerKind::AgentDetail => " Esc back",
            PickerKind::BackgroundShells => " ↑/↓ select   Esc close",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModelPickerFocus {
    Scopes,
    Models,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ModelScope {
    provider: Option<String>,
    label: String,
    count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ModelItem {
    provider: String,
    model: String,
    value: String,
}

struct ModelPicker {
    scopes: Vec<ModelScope>,
    active_scope: usize,
    focus: ModelPickerFocus,
    all_items: Vec<ModelItem>,
    items: Vec<ModelItem>,
    query: String,
    selected: usize,
}

impl ModelPicker {
    fn from_pairs(mut pairs: Vec<(String, String)>, current_model: &str) -> Option<Self> {
        pairs.sort_by(|a, b| match (a.0 == "tokamak", b.0 == "tokamak") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.cmp(b),
        });
        pairs.dedup();
        if pairs.is_empty() {
            return None;
        }

        let all_items: Vec<ModelItem> = pairs
            .into_iter()
            .map(|(provider, model)| ModelItem {
                value: model.clone(),
                provider,
                model,
            })
            .collect();
        let mut scopes = vec![ModelScope {
            provider: None,
            label: "All models".to_string(),
            count: all_items.len(),
        }];
        for item in &all_items {
            if let Some(scope) = scopes
                .last_mut()
                .filter(|scope| scope.provider.as_deref() == Some(item.provider.as_str()))
            {
                scope.count += 1;
            } else {
                scopes.push(ModelScope {
                    provider: Some(item.provider.clone()),
                    label: item.provider.clone(),
                    count: 1,
                });
            }
        }
        let selected = all_items
            .iter()
            .position(|item| item.value == current_model)
            .unwrap_or(0);
        Some(Self {
            scopes,
            active_scope: 0,
            focus: ModelPickerFocus::Models,
            items: all_items.clone(),
            all_items,
            query: String::new(),
            selected,
        })
    }

    fn refresh_items(&mut self) {
        self.active_scope = self.active_scope.min(self.scopes.len().saturating_sub(1));
        let provider = self
            .scopes
            .get(self.active_scope)
            .and_then(|scope| scope.provider.as_deref())
            .map(str::to_string);
        let terms: Vec<String> = self
            .query
            .split_whitespace()
            .map(str::to_ascii_lowercase)
            .collect();
        self.items = self
            .all_items
            .iter()
            .filter(|item| {
                if provider.as_deref().is_some_and(|p| p != item.provider) {
                    return false;
                }
                let searchable = format!(
                    "{} {}",
                    item.provider.to_ascii_lowercase(),
                    item.model.to_ascii_lowercase()
                );
                terms.iter().all(|term| searchable.contains(term))
            })
            .cloned()
            .collect();
        self.selected = self.selected.min(self.items.len().saturating_sub(1));
    }

    fn select_scope(&mut self, index: usize) {
        let current = self.items.get(self.selected).map(|item| item.value.clone());
        self.active_scope = index.min(self.scopes.len().saturating_sub(1));
        self.refresh_items();
        self.selected = current
            .and_then(|value| self.items.iter().position(|item| item.value == value))
            .unwrap_or(0);
    }

    fn move_selection(&mut self, delta: isize) {
        if self.items.is_empty() {
            self.selected = 0;
            return;
        }
        let max = self.items.len() as isize - 1;
        self.selected = (self.selected as isize + delta).clamp(0, max) as usize;
    }
}

#[derive(Clone)]
struct PickerItem {
    value: String,
    /// Primary display text.
    label: String,
    /// Optional dim prefix (e.g. a thread's short id).
    hint: Option<String>,
    /// Enabled-state for toggle pickers (`/mcp`); `None` for one-shot pickers.
    checkbox: Option<bool>,
}

/// The `/mcp` detail screen's data: a local snapshot (config plus the cached
/// `initialize` response) and the one field that needs a round trip.
struct McpDetail {
    server: super::mcp::ServerDetail,
    tools: ToolsState,
}

/// An OAuth sign-in in flight for one server, so the `/mcp` screen can show its
/// progress in place -- a spinning status, the consent URL, and a cancel hint --
/// instead of scattering transient notes into the transcript behind the picker.
/// Lives on `App` (not `McpDetail`) so it survives leaving and reopening the
/// screen and is reachable from the header badge.
struct McpAuthFlow {
    server: String,
    stage: McpAuthStage,
}

enum McpAuthStage {
    /// `BeginAuth` is running: discovering the provider and minting the url.
    Discovering,
    /// The consent url is out; waiting on the loopback redirect (up to
    /// `CALLBACK_TIMEOUT`). The url itself lives on `browser_confirm` (to open)
    /// and, if skipped, in the transcript -- not on this screen, where a wrapped
    /// url would be click-truncated and fail PKCE.
    AwaitingRedirect,
}

/// Where the detail screen's tool list is. Split from `Option<Vec<_>>` so the
/// screen can say *why* there is no list -- "not connected" and "the listing
/// failed" are different problems.
enum ToolsState {
    /// Not connected, so there is nothing to ask for.
    Unavailable,
    Loading,
    Ready(Vec<String>),
    Failed(String),
}

/// Overlay state for the `/context` readout. Replaces the old idle-only
/// transcript row: the report now lands here off the render loop, so `/context`
/// stays responsive while a turn is running and the readout reads as a popup
/// the user closes with Esc rather than a line committed to the conversation.
enum ContextView {
    /// Requested, not yet computed. The off-loop job for it is in flight (or
    /// queued behind the loop picking up `context_request`).
    Loading,
    /// The computed report, ready to render.
    Ready(Box<ContextReport>),
}

/// Off-loop MCP work the detail screen hands to the loop. Everything here
/// either talks to a peer or waits on a browser, so none of it may run inside
/// `handle_key`.
enum McpJob {
    /// List a connected server's tools for the `Tools:` line.
    Tools(String),
    /// Discover the provider and mint a consent url. Deliberately separate from
    /// `Authorize`: the url must reach the transcript *before* anything waits on
    /// the redirect, or a user with no browser has nothing to act on.
    BeginAuth(String),
    /// Wait for the redirect and persist the tokens.
    Authorize {
        server: String,
        pending: Box<crate::core::mcp::oauth::PendingAuth>,
    },
    /// Bring a server up. Run as a job rather than detached whenever the detail
    /// screen is open, so the screen refreshes when the connect lands instead of
    /// sitting on `not connected` until the user navigates away and back.
    Connect(String),
}

/// What an `McpJob` came back with.
enum McpJobDone {
    Tools {
        server: String,
        result: Result<Vec<String>, String>,
    },
    AuthStarted {
        server: String,
        result: Result<Box<crate::core::mcp::oauth::PendingAuth>, String>,
    },
    Authorized {
        server: String,
        result: Result<(), String>,
    },
    Connected {
        server: String,
        result: Result<(), String>,
    },
}

/// A browser launch held back for confirmation, for flows with no dock of their
/// own to ask in (currently `/mcp` authorization).
struct BrowserConfirm {
    url: String,
    /// What the page is for, e.g. `authorize 'github'`.
    purpose: String,
}

/// Which sign-in the `/login` dock is running. The browser flow is the default;
/// the paste field is what a server predating it (or a failure) falls back to.
enum LoginStage {
    /// Creating the session -- one round trip before there is a code to show.
    Connecting,
    /// Waiting on the browser. The code is displayed so the user can check it
    /// against the approve page before clicking Approve.
    ///
    /// While `confirm_open` is set the user has not yet said whether to launch a
    /// browser here. The poll runs regardless, so approving from a phone still
    /// completes the sign-in without ever answering.
    Approving {
        user_code: String,
        authorize_url: String,
        confirm_open: bool,
    },
    /// Legacy paste-a-key entry. `confirm_open` gates sending the user to the
    /// API-keys page; the field only accepts a key once that is answered.
    Paste { confirm_open: bool },
}

impl LoginStage {
    /// The page this stage would send the user to, while that is still unasked.
    fn unconfirmed_url(&self) -> Option<&str> {
        match self {
            Self::Approving {
                authorize_url,
                confirm_open: true,
                ..
            } => Some(authorize_url),
            Self::Paste { confirm_open: true } => Some(super::tokamak::API_KEYS_URL),
            _ => None,
        }
    }

    /// Mark the browser question answered, whichever stage asked it.
    fn mark_confirmed(&mut self) {
        match self {
            Self::Approving { confirm_open, .. } | Self::Paste { confirm_open } => {
                *confirm_open = false
            }
            Self::Connecting => {}
        }
    }
}

/// `/login`: a docked prompt that runs the browser-approval sign-in and, when
/// that is unavailable, collects a Tokamak API key without echoing it. The
/// network work runs off the render loop (see `login_*_task` in `chat_loop`), so
/// `verifying` marks the window where the paste field is read-only.
///
/// The dock stays open for the whole flow, which is also what makes Esc a
/// reliable cancel: `chat_loop` drops every in-flight sign-in task the moment
/// `app.login` goes to `None`.
struct LoginPrompt {
    provider: String,
    /// The key as typed/pasted. Never rendered verbatim -- see `masked`.
    input: String,
    /// Why the previous attempt failed, shown above the field.
    error: Option<String>,
    verifying: bool,
    stage: LoginStage,
}

impl LoginPrompt {
    fn new(provider: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            input: String::new(),
            error: None,
            verifying: false,
            stage: LoginStage::Paste { confirm_open: true },
        }
    }

    /// The dock as `/login` opens it, before the session exists.
    /// The dock for Tokamak's browser-approval flow, before the session exists.
    fn connecting() -> Self {
        Self {
            stage: LoginStage::Connecting,
            ..Self::new("tokamak")
        }
    }

    fn unconfirmed_url(&self) -> Option<String> {
        match &self.stage {
            LoginStage::Paste { confirm_open: true } => {
                crate::core::cli::auth::provider_by_id(&self.provider)
                    .map(|provider| provider.api_key.keys_url.to_string())
            }
            _ => self.stage.unconfirmed_url().map(str::to_string),
        }
    }

    /// Only the paste field accepts input, and only once the browser question is
    /// answered; the approval stages are display-only throughout.
    fn editable(&self) -> bool {
        matches!(
            self.stage,
            LoginStage::Paste {
                confirm_open: false
            }
        ) && !self.verifying
    }

    fn masked(&self) -> String {
        super::secret_input::mask(self.input.chars().count())
    }

    fn paste(&mut self, text: &str) {
        if self.editable() {
            self.input.push_str(super::secret_input::pasted(text));
        }
    }
}

/// A spawned agent run: the event stream and its abort handle.
struct CurrentRun {
    rx: mpsc::UnboundedReceiver<StreamEvent>,
    steering: mpsc::UnboundedReceiver<SteeringRequest>,
    handle: JoinHandle<()>,
}

// One value at a time in the event loop and never stored in bulk, so the
// size of the stream variant costs nothing worth a box per event.
#[allow(clippy::large_enum_variant)]
enum RunEvent {
    Stream(Option<StreamEvent>),
    Steering(SteeringRequest),
}

struct PendingMessage {
    text: String,
    message: serde_json::Value,
    images: Vec<String>,
    display: bool,
    invocation: Option<(String, String, String)>,
    run_mode: Option<crate::core::agent::plan::RunMode>,
    /// Start this turn from an empty conversation (execute-plan-in-fresh-context).
    fresh_context: bool,
}

#[cfg(test)]
impl From<&str> for PendingMessage {
    fn from(text: &str) -> Self {
        Self {
            text: text.to_string(),
            message: serde_json::json!({ "role": "user", "content": text }),
            images: Vec::new(),
            display: true,
            invocation: None,
            run_mode: None,
            fresh_context: false,
        }
    }
}

/// One folded call's retained detail, so an expanded group can reconstruct each
/// individual call and its result without re-fetching anything.
struct GroupedCall {
    id: String,
    /// Present-tense label (e.g. "Executing grep -n foo src/"), shown on the
    /// live row while this is the group's only call.
    activity: String,
    /// Past-tense finished label (e.g. "Ran grep -n foo src/").
    done: String,
    /// Raw result content, filled when the matching `ToolResult` arrives.
    content: Option<String>,
    is_error: bool,
    diff: Option<String>,
}

/// A run of consecutive collapsible tool calls folded into one transcript row.
struct ToolGroup {
    /// Transcript index of the row this group owns.
    idx: usize,
    /// Past-tense label shown when the group finalizes as a single call.
    first_done: String,
    /// Per-call noun for the finalized breakdown, paired with whether it is a
    /// read-style op ("memory note"/true, "command"/false, ...). The flag splits
    /// the summary into a "Read ..." clause and a "ran ..." clause so the verb
    /// always agrees with its noun.
    nouns: Vec<(&'static str, bool)>,
    /// Per-call detail retained so the collapsed row can expand back to its
    /// individual calls/results (never discarded at fold time).
    calls: Vec<GroupedCall>,
    /// When the group opened, so the running row can show elapsed time.
    started: Instant,
    /// Outcome of the most recently *arrived* result, which is what the
    /// collapsed row reports. Results can land out of dispatch order, so this
    /// can't be read back off `calls`.
    last_result_error: Option<bool>,
}

impl ToolGroup {
    /// Whether any call is still awaiting its `ToolResult`. A group can stay
    /// open with every call resolved so future calls keep folding into it; the
    /// throbber must not show while that's the case. Results within a batch can
    /// land out of dispatch order, so this looks at every call, not the last.
    fn is_running(&self) -> bool {
        self.calls.iter().any(|c| c.content.is_none())
    }

    /// Terminal marker for the collapsed row: the latest result's status, so a
    /// call that failed and then succeeded on a retry reads as resolved. The
    /// per-call failure stays visible in the expanded detail. A failure still
    /// outranks an unresolved call: it is the more specific thing to report.
    fn outcome_tag(&self, interrupted: bool) -> (&'static str, Style) {
        if self.last_result_error == Some(true) {
            ("✗", Style::new().red())
        } else if interrupted && self.is_running() {
            ("○", Style::new().yellow())
        } else {
            ("✓", Style::new().green())
        }
    }

    /// Live label for an open group: the tool still in flight, so a running
    /// batch reads as that tool rather than a counted breakdown like "Running
    /// 2 commands, 5 searches" (which would wrongly imply all of them are
    /// executing at once). The past-tense summary only appears once the group
    /// resolves. Results can land out of dispatch order, so the in-flight call
    /// is the latest one still awaiting its result.
    fn activity(&self) -> String {
        self.calls
            .iter()
            .rev()
            .find(|c| c.content.is_none())
            .or_else(|| self.calls.last())
            .map(|c| c.activity.clone())
            .unwrap_or_default()
    }

    /// The group's row: present-tense `▸` only while it is open with a call in
    /// flight, otherwise a resolved tag plus past-tense summary. The label is
    /// stored untruncated; `Row::Tool` clamps it to the current draw width.
    fn row(&self, state: GroupRow) -> Row {
        if state == GroupRow::Open && self.is_running() {
            return RowKind::Tool {
                tag: "▸".to_string(),
                tag_style: Style::new().cyan(),
                label: self.activity(),
                label_style: Style::new().cyan().dim(),
                reserve: TOOL_ROW_RESERVE,
            }
            .into();
        }
        // An aborted single call that never resolved keeps its present-tense
        // `activity()` label: `first_done` ("Ran: cargo build") beside the yellow
        // interrupted mark would read as completed. Mirrors the standalone
        // edit/write orphan path (resolve_orphan_tool_rows).
        let label = if self.nouns.len() <= 1 {
            if state == GroupRow::Aborted && self.is_running() {
                self.activity()
            } else {
                self.first_done.clone()
            }
        } else {
            group_summary(&self.nouns)
        };
        let (tag, tag_style) = self.outcome_tag(state == GroupRow::Aborted);
        RowKind::Tool {
            tag: tag.to_string(),
            tag_style,
            label,
            label_style: Style::new().dim(),
            reserve: TOOL_ROW_RESERVE,
        }
        .into()
    }
}

/// How a group's row should read: still open to further calls, closed normally,
/// or closed by an abort that left calls unresolved.
#[derive(Clone, Copy, PartialEq)]
enum GroupRow {
    Open,
    Closed,
    Aborted,
}

/// A standalone (diff-producing) tool row awaiting its `ToolResult`, retained so
/// an aborted run can mark it interrupted instead of leaving a `▸` that reads as
/// work still in flight.
struct PendingToolRow {
    id: String,
    idx: usize,
    label: String,
    /// Past-tense label the row is rewritten to once its result lands.
    done: String,
}

/// What the session opens with: the `jan` wordmark plus the facts a first-time
/// reader needs (which project, how tool calls are approved) and the commands to
/// go on with. Held as data rather than rendered lines so the row re-lays out at
/// the draw width like every other width-dependent row.
struct Banner {
    version: &'static str,
    project: String,
    branch: Option<String>,
    /// How tool calls are approved this session (sandboxed, or `--safe`).
    tools: String,
    /// The dedicated checkout the tools work in, when the session has one. The
    /// splash names it because with a worktree the edits do *not* land in the
    /// directory the user started `jan` in, which is the one thing about this
    /// mode that must never be a surprise.
    workspace: Option<String>,
    /// False when `--task` already seeded the first message, so the splash does
    /// not invite one.
    awaiting_first_message: bool,
}

/// Indent shared by every splash row, matching `jan --help`.
const BANNER_INDENT: u16 = 2;

/// Commands worth putting in front of a first-time reader. The full list is
/// behind `/help` (see `SLASH_COMMANDS`).
const BANNER_HINTS: &[(&str, &str)] = &[
    ("/help", "commands"),
    ("/init", "onboard this project"),
    ("/model", "switch model"),
    ("/resume", "reopen a session"),
    ("Ctrl-C/D twice", "quit"),
];

#[cfg(test)]
thread_local! {
    /// Counts `Row::lines` calls, so a test can assert that `draw` materializes
    /// a viewport's worth of rows rather than the whole transcript.
    static ROW_CLONES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// One committed transcript entry. Width-dependent entries keep their *source*
/// rather than rendered lines, so a terminal resize re-lays them out at the new
/// width instead of leaving tables, boxed diffs and truncated labels sized for
/// the old one. `Line` holds content whose layout is width-independent (it wraps
/// naturally in the body `Paragraph`).
///
/// A row may render to several lines; transcript indices (group/reasoning/
/// pending-row `idx`, `expanded`, `reveal`) address rows, so they stay valid
/// across a resize no matter how the line count changes.
struct Row {
    kind: RowKind,
    /// Last render, keyed by the width that produced it. The whole transcript
    /// is laid out on every frame, so without this a long session would
    /// re-parse its markdown and re-highlight its diffs 20 times a second;
    /// only a width change invalidates the entry.
    cache: std::cell::RefCell<Option<RowRender>>,
}

/// A row's rendered lines plus the height they occupy once the body
/// `Paragraph` word-wraps them. `height` is what lets `draw` locate the visible
/// window without materializing (let alone wrapping) the rows above it.
struct RowRender {
    width: u16,
    lines: Vec<Line<'static>>,
    height: u16,
}

enum RowKind {
    Line(Line<'static>),
    /// Assistant prose, re-wrapped through markdown at the draw width.
    Markdown(String),
    /// The opening splash, re-laid out at the draw width (the wordmark is
    /// dropped and the hints re-packed on a terminal too narrow for them).
    Banner(Box<Banner>),
    /// A line the app is saying: `glyph` in the gutter column, body wrapped at
    /// the draw width, so the gutter owns the left edge of the whole row instead
    /// of only its first line. `cont` is what a wrapped continuation puts in the
    /// column: an edge glyph repeats, a marker glyph gives way to blanks (a
    /// second `•` would read as a second note).
    System {
        glyph: &'static str,
        cont: &'static str,
        gutter: Style,
        body: Vec<Span<'static>>,
        /// A filled bubble background spanning the row, or `None` for the plain
        /// gutter form. Set for the user turn so it reads as a distinct card the
        /// way the desktop's `bg-secondary` bubble does.
        bg: Option<Color>,
    },
    /// A tool call/summary row, re-truncated to `width - reserve`.
    Tool {
        tag: String,
        tag_style: Style,
        label: String,
        label_style: Style,
        reserve: u16,
    },
    /// A tool result summary plus its optional boxed diff panel. `content` is
    /// `None` when the call row above already says the same thing.
    Result {
        tag: &'static str,
        tag_style: Style,
        content: Option<String>,
        diff: Option<String>,
        /// Path of the edited file, for diff syntax highlighting.
        lang: Option<String>,
    },
}

impl From<RowKind> for Row {
    fn from(kind: RowKind) -> Self {
        Row {
            kind,
            cache: std::cell::RefCell::new(None),
        }
    }
}

impl Row {
    fn line(line: Line<'static>) -> Row {
        RowKind::Line(line).into()
    }

    fn lines(&self, width: u16) -> Vec<Line<'static>> {
        #[cfg(test)]
        ROW_CLONES.with(|n| n.set(n.get() + 1));
        self.fill(width);
        self.cache
            .borrow()
            .as_ref()
            .map(|r| r.lines.clone())
            .unwrap_or_default()
    }

    /// Wrapped height at `width`, without cloning the row's lines. `draw` calls
    /// this for every row on every frame and `lines` only for the visible few,
    /// so this must stay O(1) once the row is cached.
    fn height(&self, width: u16) -> u16 {
        self.fill(width);
        self.cache.borrow().as_ref().map_or(0, |r| r.height)
    }

    fn fill(&self, width: u16) {
        if self
            .cache
            .borrow()
            .as_ref()
            .is_some_and(|r| r.width == width)
        {
            return;
        }
        let lines = self.render(width);
        let height = wrapped_height(lines.clone(), width);
        *self.cache.borrow_mut() = Some(RowRender {
            width,
            lines,
            height,
        });
    }

    fn render(&self, width: u16) -> Vec<Line<'static>> {
        match &self.kind {
            RowKind::Line(line) => vec![line.clone()],
            RowKind::Markdown(text) => format_markdown_lines(text, width),
            RowKind::Banner(banner) => banner_lines(banner, width),
            RowKind::System {
                glyph,
                cont,
                gutter,
                body,
                bg,
            } => {
                let lead = glyph.chars().count() + 1;
                // A banded row reserves one column so the bubble keeps a right
                // margin instead of the text touching its tinted edge.
                let reserve = if bg.is_some() { 1 } else { 0 };
                let max = width.saturating_sub(lead as u16 + reserve).max(8) as usize;
                let lines = gutter_lines(
                    wrap_spans_hard(body.clone(), max),
                    vec![Span::styled(
                        format!("{glyph:<width$}", width = lead),
                        *gutter,
                    )],
                    vec![Span::styled(
                        format!("{cont:<width$}", width = lead),
                        *gutter,
                    )],
                );
                match bg {
                    Some(bg) => band_rows(lines, *bg),
                    None => lines,
                }
            }
            RowKind::Tool {
                tag,
                tag_style,
                label,
                label_style,
                reserve,
            } => tool_row_lines(tag, *tag_style, label, *label_style, *reserve, width, None),
            RowKind::Result {
                tag,
                tag_style,
                content,
                diff,
                lang,
            } => {
                let max = width.saturating_sub(8).max(1) as usize;
                let mut out: Vec<Line<'static>> = content
                    .iter()
                    .map(|c| {
                        Line::from(vec![
                            Span::styled("│   ", Style::new().dark_gray()),
                            Span::styled(format!("{tag} "), *tag_style),
                            Span::styled(summarize_result(c, max), Style::new().dim()),
                        ])
                    })
                    .collect();
                if let Some(diff) = diff {
                    out.extend(diff_lines(
                        diff,
                        width as usize,
                        DIFF_MAX_ROWS,
                        "│     ",
                        lang.as_deref(),
                    ));
                }
                out
            }
        }
    }

    /// Whether this row is the blank separator `gap` inserts. Only a literal
    /// blank line qualifies; a source-backed row always renders content.
    fn is_blank(&self) -> bool {
        match &self.kind {
            RowKind::Line(line) => line.spans.iter().all(|s| s.content.trim().is_empty()),
            _ => false,
        }
    }
}

/// A committed `<think>` reasoning block, folded to a one-line summary row.
/// The full dimmed lines are retained so the row can expand back to them.
struct ReasoningBlock {
    /// Transcript index of the summary row this block owns.
    idx: usize,
    /// Full dimmed reasoning lines, revealed when expanded.
    detail: Vec<Line<'static>>,
}

/// A "trace": a maximal contiguous run of committed reasoning-summary and
/// tool-group rows (the band-0 thinking+tools activity of a turn). Collapsing
/// one folds `[start..=end]` to a single `Thought`/`Worked` header. Only runs of
/// two or more rows are worth collapsing, so `steps >= 2` for every value here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TraceRun {
    start: usize,
    end: usize,
    /// Any member is a tool group (vs reasoning only): picks `Worked` over
    /// `Thought` for the header, matching the desktop's `worked`/`thought`.
    tool_ran: bool,
    /// Member rows in the run (`end - start + 1`).
    steps: usize,
}

/// A committed workspace state, one per turn that changed files. `user_index` is
/// the position (among user messages) of the message that drove the turn, so a
/// rewind to message N resets to the checkpoint recorded before N.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Checkpoint {
    user_index: usize,
    preview: String,
    sha: String,
}

/// One entry in the file-path hint popup triggered by typing `@`.
struct PathHintItem {
    /// Display path (relative to project root).
    path: String,
    /// Basename for display.
    name: String,
    /// Whether this is a directory.
    is_dir: bool,
}

struct PendingAsk {
    request_id: String,
    request: crate::core::agent::interaction::AskRequest,
    answers: Vec<crate::core::agent::interaction::QuestionResult>,
    question_index: usize,
    selected: usize,
    editing_custom: bool,
    custom_input: String,
    rect: Rect,
    row_hitboxes: Vec<(u16, usize)>,
    /// When the `ask` loop auto-selects the recommended option if unanswered.
    /// `Some` only when a timeout was configured; drives the live countdown in
    /// the prompt title. Anchored here at event receipt, a hair before the
    /// loop arms its timer, so the countdown reaches zero marginally before the
    /// loop fires - the safe direction (never show "0s left" while still
    /// waiting indefinitely).
    deadline: Option<std::time::Instant>,
}

impl PendingAsk {
    fn new(
        request_id: String,
        request: crate::core::agent::interaction::AskRequest,
        timeout: Option<std::time::Duration>,
    ) -> Self {
        let answers = request
            .questions
            .iter()
            .map(|question| crate::core::agent::interaction::QuestionResult {
                id: question.id.clone(),
                selected: Vec::new(),
                custom_input: None,
            })
            .collect();
        Self {
            request_id,
            request,
            answers,
            question_index: 0,
            selected: 0,
            editing_custom: false,
            custom_input: String::new(),
            rect: Rect::default(),
            row_hitboxes: Vec::new(),
            deadline: timeout.map(|d| std::time::Instant::now() + d),
        }
    }

    fn question(&self) -> &crate::core::agent::interaction::Question {
        &self.request.questions[self.question_index]
    }

    /// Whole seconds until `now` reaches `deadline`, rounded up (ceil): while
    /// the prompt is genuinely still live this never reports `0s`. `None` when
    /// no timeout was configured or the deadline has already passed.
    fn remaining_secs(&self, now: std::time::Instant) -> Option<u64> {
        let deadline = self.deadline?;
        let remaining = deadline.checked_duration_since(now)?;
        // `checked_duration_since` yields 0 exactly at the deadline; that is
        // "no time left", not a live 0s, so fall through to `None`. A strictly
        // positive remainder (however tiny) rounds up to at least 1s.
        if remaining.is_zero() {
            return None;
        }
        Some(remaining.as_millis().div_ceil(1000) as u64)
    }

    fn row_count(&self) -> usize {
        self.question().options.len() + 1 + usize::from(self.question().multi)
    }

    /// Cells the `List` leaves an item after `highlight_symbol`.
    const HIGHLIGHT_W: u16 = 2;

    /// The question, wrapped to `width`.
    fn question_lines(&self, width: u16) -> Vec<Line<'static>> {
        wrap_text(
            &self.question().question,
            Style::new().bold(),
            width.max(1) as usize,
        )
        .into_iter()
        .map(Line::from)
        .collect()
    }

    /// One entry per selectable row, each already laid out at `width`. Both the
    /// box height and `draw_ask` build from this, so a wrapped label cannot put
    /// the mouse hitboxes out of step with what is on screen.
    fn option_lines(&self, width: u16) -> Vec<Vec<Line<'static>>> {
        let question = self.question();
        let answer = &self.answers[self.question_index];
        let dim = Style::new().dark_gray();
        let mark_w = if question.multi { 4 } else { 2 };
        let body = width.saturating_sub(Self::HIGHLIGHT_W + mark_w).max(1) as usize;
        let indent = || vec![Span::raw(" ".repeat(mark_w as usize))];
        let mark = |selected: bool| {
            let glyph = match (question.multi, selected) {
                (true, true) => "[x] ",
                (true, false) => "[ ] ",
                (false, true) => "● ",
                (false, false) => "○ ",
            };
            vec![Span::styled(glyph, Style::new().cyan())]
        };

        let mut out: Vec<Vec<Line<'static>>> = Vec::with_capacity(self.row_count());
        for (index, option) in question.options.iter().enumerate() {
            let mut head = vec![Span::raw(option.label.clone())];
            if question.recommended == Some(index) {
                head.push(Span::styled("  recommended", Style::new().green().dim()));
            }
            let selected = answer.selected.iter().any(|label| label == &option.label);
            let mut lines = gutter_lines(wrap_spans_hard(head, body), mark(selected), indent());
            // The description gets its own rows rather than trailing the label:
            // inline, one long description pushes the next option's label off
            // the bottom of a box that has to fit above the input.
            if let Some(description) = &option.description {
                lines.extend(gutter_lines(
                    wrap_text(description, dim, body),
                    indent(),
                    indent(),
                ));
            }
            out.push(lines);
        }
        out.push(gutter_lines(
            wrap_text("Other (type your own)", Style::new(), body),
            mark(answer.custom_input.is_some()),
            indent(),
        ));
        if question.multi {
            out.push(vec![Line::styled(
                "Submit answers",
                Style::new().green().bold(),
            )]);
        }
        out
    }

    /// Rows the whole box needs at `width`: borders, question, every option and
    /// the help line.
    fn box_height(&self, width: u16) -> u16 {
        let inner = width.saturating_sub(2);
        let options: usize = self.option_lines(inner).iter().map(|item| item.len()).sum();
        let question = self.question_lines(inner).len();
        (question + options + 3).min(u16::MAX as usize) as u16
    }

    fn move_selection(&mut self, delta: isize) {
        self.selected =
            (self.selected as isize + delta).rem_euclid(self.row_count() as isize) as usize;
    }

    fn move_question(&mut self, delta: isize) {
        let last = self.request.questions.len().saturating_sub(1) as isize;
        self.question_index = (self.question_index as isize + delta).clamp(0, last) as usize;
        self.selected = 0;
        self.editing_custom = false;
        self.custom_input.clear();
    }

    fn all_answered(&self) -> bool {
        self.answers
            .iter()
            .all(|answer| !answer.selected.is_empty() || answer.custom_input.is_some())
    }

    /// Apply the highlighted row. Returns true once every question is answered.
    fn choose(&mut self) -> bool {
        let option_count = self.question().options.len();
        let multi = self.question().multi;
        if multi && self.selected == option_count + 1 {
            return self.advance_or_finish();
        }
        if self.selected == option_count {
            self.editing_custom = true;
            self.custom_input = self.answers[self.question_index]
                .custom_input
                .clone()
                .unwrap_or_default();
            return false;
        }
        let label = self.question().options[self.selected].label.clone();
        let answer = &mut self.answers[self.question_index];
        answer.custom_input = None;
        if multi {
            if let Some(index) = answer.selected.iter().position(|item| item == &label) {
                answer.selected.remove(index);
            } else {
                answer.selected.push(label);
            }
            false
        } else {
            answer.selected = vec![label];
            self.advance_or_finish()
        }
    }

    fn accept_custom(&mut self) -> bool {
        let value = self.custom_input.trim().to_string();
        if value.is_empty() {
            return false;
        }
        let id = self.question().id.clone();
        self.answers[self.question_index] = crate::core::agent::interaction::QuestionResult {
            id,
            selected: Vec::new(),
            custom_input: Some(value),
        };
        self.editing_custom = false;
        self.advance_or_finish()
    }

    fn advance_or_finish(&mut self) -> bool {
        if self.question_index + 1 < self.request.questions.len() {
            self.move_question(1);
            return false;
        }
        if self.all_answered() {
            true
        } else {
            self.question_index = self
                .answers
                .iter()
                .position(|answer| answer.selected.is_empty() && answer.custom_input.is_none())
                .unwrap_or(self.question_index);
            self.selected = 0;
            false
        }
    }
}

struct App {
    model: String,
    /// Fast model for the `smol` role, used by `/goal` evaluation. Defaults to
    /// `model` when no smol model is configured.
    smol_model: String,
    /// Active `/goal`, if any: the loop keeps firing turns until the evaluator
    /// judges the condition met. Persisted with the thread so it survives
    /// restart/resume. `None` = no goal.
    goal: Option<crate::core::agent::goal::GoalState>,
    /// Set after a turn finishes while a goal is active: the chat loop runs the
    /// evaluator off the render loop, then auto-continues or returns control.
    goal_eval_pending: bool,
    /// A goal evaluation is running off the render loop (report-12 MED-3).
    goal_evaluating: bool,
    /// Esc was pressed while `goal_evaluating`: the loop aborts the call.
    goal_eval_cancel: bool,
    /// Read-only plan mode. `Plan` blocks mutation-capable tools at the core
    /// dispatcher (advisory prompt is defense in depth only). Persisted with
    /// the thread so it survives restart/resume.
    run_mode: crate::core::agent::plan::RunMode,
    /// Orchestration handle for out-of-run model calls (the `/compact` command).
    /// `None` in unit tests, set by `run` for the live session.
    args: Option<Arc<OrchestrationArgs>>,
    /// Context window limit for the current model. Updated on every model
    /// switch via [`Self::refresh_context_window`]: configured override, then
    /// the built-in model catalog, then a 128K fallback.
    /// The approval-mode phrasing used by the splash (e.g. "--safe: writes, ...").
    /// Captured once at startup so `/clear`, `/new` and `/resume` re-print the
    /// same branding without re-deriving it.
    approval_phrasing: String,
    /// Context window limit for the current model (default 128K).
    context_window: u64,
    /// Where `context_window` came from: configured override, catalog, or fallback.
    context_window_source: crate::core::cli::model_capabilities::ContextWindowSource,
    /// The explicit `[agent].context_window` override copied from the session
    /// limits (`None` when unset). Stays authoritative across model switches.
    configured_context_window: Option<u64>,
    /// Tokens to reserve for the model's response (compaction triggers at limit - reserve).
    reserve_tokens: u64,
    /// The reserve was set by the user or the project, so it is not scaled down
    /// for a small window (only the built-in default is).
    reserve_pinned: bool,
    /// Whether to compact proactively, and the tail an automatic compaction
    /// keeps, from the shared policy (AH-076).
    compaction_auto: bool,
    compaction_keep_recent: usize,
    /// Per-request output cap forwarded to the model as OpenAI `max_tokens`.
    /// `None` omits the field (model default).
    max_tokens: Option<u64>,
    /// Token-spend ceiling for one message's run; `0` is unbounded. The only
    /// cap on run length -- there is no turn limit.
    max_session_tokens: u64,
    /// `max_session_tokens` came from the flag or `[budget].max_tokens`; when
    /// not, it follows the model's context window across a model switch.
    max_session_tokens_pinned: bool,
    /// Repo top-level when the project is a git repo; enables workspace snapshots.
    /// Cleared if git setup fails, permanently disabling snapshots this session.
    repo_root: Option<PathBuf>,
    /// Current git branch name, if the project is inside a git repo.
    git_branch: Option<String>,
    /// Directory tool paths (`edit`/`write` "path" args) are resolved against.
    project_root: PathBuf,
    /// Absolute paths touched by `edit`/`write` tool calls so far this turn;
    /// drained into the next checkpoint's snapshot and reset per turn. Only
    /// these exact paths are staged -- checkpoints never scan the repo.
    turn_touched: Vec<PathBuf>,
    /// Destination path of each in-flight `edit`/`write` call, keyed by call id,
    /// so the diff in its `ToolResult` (which carries no path) can be
    /// syntax-highlighted for the right language. Removed as results arrive.
    diff_paths: HashMap<String, String>,
    /// Command of each in-flight `bash` call, keyed by call id, kept only until
    /// its result lands -- which is where a job id would appear.
    bash_commands: HashMap<String, String>,
    /// Commands the `bash` tool backgrounded, keyed by the `job_id` it handed
    /// out. The later call that collects a job carries only that id, and blocks
    /// until the command finishes, so without this its row -- live for as long
    /// as the command runs -- has nothing to name.
    bash_jobs: HashMap<String, String>,
    /// Output streamed by each `bash` call so far, keyed by call id, bounded to
    /// [`LIVE_OUTPUT_MAX_BYTES`] from the end. This is what turns a running
    /// command from a spinner into a terminal.
    live_output: HashMap<String, String>,
    /// Maps the call that *collects* a backgrounded job to the call that
    /// *started* it. The job keeps streaming under the original id, so without
    /// this the collecting call -- the one the user is actually waiting on --
    /// would show an empty box while the output piled up out of sight.
    live_alias: HashMap<String, String>,
    /// Call id that started each backgrounded job, keyed by `job_id`.
    job_origin: HashMap<String, String>,
    /// Job ids of `bash` commands still detached in the background: added when a
    /// result reports its command backgrounded, removed when a later call
    /// collects that job. Its count drives the status-bar shell indicator.
    active_bg_jobs: std::collections::HashSet<String>,
    /// Base snapshot (working-tree state before the first turn) for the active
    /// thread. `Some` once snapshotting is armed; `None` = no workspace restore.
    base_snapshot: Option<String>,
    /// Per-turn workspace checkpoints for the active thread, oldest first.
    checkpoints: Vec<Checkpoint>,
    /// The git worktree this session's tools work in, when it has one. Fixed for
    /// the session: it is baked into the frozen `OrchestrationArgs` the runs
    /// share, so `/resume` onto a thread that used a different one reports the
    /// mismatch rather than switching under a run.
    workspace: Option<Worktree>,
    /// The worktree pointer the *active thread* saves, which is not always the
    /// one the session works in: a fork shares the live checkout without
    /// claiming it (its own branch is minted when it is reopened), and a resumed
    /// thread that recorded another checkout keeps that pointer rather than
    /// having this session's written over it.
    workspace_record: Option<Worktree>,
    /// `metadata.forked_from` of the active thread, carried so a later save does
    /// not drop the parent pointer `fork_thread` wrote (`thread_metadata` owns
    /// the whole metadata object, not a merge into it).
    forked_from: Option<serde_json::Value>,
    /// Pending git snapshots, run off the render loop (see `SnapshotJob`).
    snap_queue: std::collections::VecDeque<SnapshotJob>,
    /// Whether a base snapshot has been requested for the active thread (queued,
    /// in flight, done, or resumed), so it is captured at most once per thread.
    base_requested: bool,
    /// Timestamp of the last idle Esc, to detect a double-Esc rewind gesture.
    last_esc: Option<Instant>,
    /// User-message index chosen in the rewind picker, carried into the scope step.
    rewind_target: Option<usize>,
    /// Project `.jan/agent` dir where this TUI's threads are saved/listed.
    agent_dir: std::path::PathBuf,
    /// OpenAI-shaped conversation history sent with each run.
    history: Vec<serde_json::Value>,
    /// Thread this conversation persists to (set on first save or on resume).
    thread_id: Option<String>,
    /// Display transcript (user turns, assistant text, workflow lines). Rows,
    /// not lines: width-dependent entries keep their source and re-render on
    /// resize (see `Row`).
    transcript: Vec<Row>,
    /// What was rendered, in emission order, so a resumed session gets its
    /// reasoning and tool calls back. `history` cannot serve this: reasoning is
    /// kept out of it and tool calls are flattened away on save. Dumped off the
    /// render loop by `persist`, replayed by `replay_display_log`.
    display_log: Vec<DisplayEntry>,
    /// Background journal writer, created on the first dump and joined on exit.
    journal_writer: Option<journal::Writer>,
    /// Background thread saver for mid-turn `MessagesUpdated` snapshots, so a
    /// model step does not stall the render loop on a full-history rewrite
    /// and fsync (#63). Flushed before every synchronous save and on exit.
    thread_saver: Option<ThreadSaver>,
    /// In-progress assistant text for the current turn, flushed on the next
    /// step/tool/terminal event.
    assistant_buf: String,
    /// How far `assistant_buf` has been scanned for `<think>` tags, so each
    /// streamed token costs the new text, not the whole answer so far.
    think_scan: std::cell::RefCell<ThinkScan>,
    /// Reasoning streamed natively via `StreamEvent::Reasoning` since the last
    /// flush, each segment anchored to the `assistant_buf` offset it arrived at.
    /// Kept apart from `assistant_buf` so it is never wrapped into the wire
    /// history: it is display-only, folded like `<think>` blocks. Anchoring
    /// (rather than one flat buffer) is what keeps a turn that interleaves
    /// reasoning with prose in emission order, and what lets `reasoning_open`
    /// tell "still reasoning" from "prose has started".
    reasoning_segs: Vec<ReasoningSeg>,
    /// The current run of consecutive collapsible tool calls, rendered as one
    /// transcript row that updates in real time and finalizes to a short summary.
    /// edit/write are excluded (they render their own diff panel).
    tool_group: Option<ToolGroup>,
    /// Ids of calls folded into a `ToolGroup`, so their `ToolResult` is swallowed
    /// (the group row already represents them). Survives group finalize.
    grouped_ids: std::collections::HashSet<String>,
    /// Finalized tool groups, retained with their per-call detail so a collapsed
    /// summary row can be expanded back to its individual calls/results.
    groups: Vec<ToolGroup>,
    /// Standalone (edit/write) call rows still awaiting their result. Several
    /// can be open at once: a batch emits every `ToolCall` before any result.
    pending_rows: Vec<PendingToolRow>,
    /// Committed reasoning blocks, folded to a summary row and expandable back to
    /// their full dimmed lines.
    reasoning_blocks: Vec<ReasoningBlock>,
    /// Start transcript index of each "trace" -- a contiguous run of
    /// reasoning-summary + tool-group rows (see `trace_runs`) -- the user has
    /// expanded. A *finished* trace (one an answer follows) folds to a single
    /// `Thought/Worked` header by default; being in this set opts it back out to
    /// the full run. The active (still-streaming) run is never folded.
    expanded_traces: std::collections::HashSet<usize>,
    /// Whether `<think>` reasoning reveals in full instead of folding. Defaults
    /// from `[agent].show_reasoning` in agent.toml (false). Ctrl-O toggles every
    /// existing block between its summary row and full detail for the session.
    show_reasoning: bool,
    /// Whether reasoning streams into the live tail while folding is on.
    /// Defaults from `stream_reasoning` in `~/.jan/config.toml` (true). The open
    /// block shows its last `LIVE_REASONING_TAIL_LINES` lines and still folds to
    /// a summary row when the turn commits; false shows nothing but the header
    /// badge, as before. Orthogonal to `show_reasoning`, which unfolds for good.
    stream_reasoning: bool,
    /// Whether a prior assistant turn's reasoning is resent to the model.
    /// Defaults from `[agent].send_reasoning` in agent.toml (true). False keeps
    /// long chains of thought out of the request (and satisfies upstreams that
    /// reject the key); the display journal keeps reasoning for a resume either
    /// way.
    send_reasoning: bool,
    /// Normalized reasoning effort level sent with each model request.
    /// Valid values: `"low"`, `"medium"`, `"high"`. Defaults to `"medium"`.
    reasoning_effort: String,
    /// The most recently selected non-low effort level, used by the Alt+T
    /// toggle to switch between `"low"` and this value.
    last_non_low_effort: String,
    /// Transcript row indices of collapsed regions (tool groups or reasoning
    /// blocks) the user has expanded to full detail.
    expanded: std::collections::HashSet<usize>,
    /// Transcript row of a region to scroll into view on the next draw (set when
    /// expanding one that may sit above the pinned-to-bottom viewport).
    reveal: Option<usize>,
    input: String,
    /// Composer entries submitted this session, oldest first, for Up/Down recall.
    input_history: Vec<String>,
    /// Position in `input_history` while recalling; `None` is the fresh buffer.
    recall_pos: Option<usize>,
    /// Images staged by `/image`, flushed into the next submitted user message.
    pending_images: Vec<PendingImage>,
    /// Caret position as a byte index into `input` (always on a char boundary).
    cursor: usize,
    /// Highlighted row in the slash-command hint popup (clamped to matches).
    slash_selected: usize,
    /// Set by Esc to hide the hint popup without clearing the buffer; cleared on
    /// the next keystroke that edits the input so typing re-shows it.
    slash_dismissed: bool,
    /// Plugin command and skill metadata loaded before interactive rendering.
    /// Refresh only after an in-app plugin mutation, never while drawing.
    slash_catalog: SlashCatalog,
    /// Filesystem-backed slash matches cached for the unchanged input buffer.
    /// Rendering asks for these every tick, so discovery must not run per frame.
    slash_matches_cache: RefCell<Option<(String, Vec<SlashMatch>)>>,
    /// File-path hint entries matching the current `@query` in the input buffer.
    path_hints: Vec<PathHintItem>,
    /// An edit asked for fresh hints. The search runs at most once per tick,
    /// off the render loop, instead of once per keystroke on it.
    path_hints_dirty: bool,
    /// Bumped by every edit; a search result for an older number is dropped.
    path_hint_gen: u64,
    /// Highlighted row in the path-hint popup (clamped to matches).
    path_hint_selected: usize,
    /// Set by Esc to dismiss the path-hint popup; cleared on next char edit.
    path_hint_dismissed: bool,
    status: Status,
    /// Orca-integration status emitter (OSC 9999 + terminal titles). Inert
    /// until `run` enables it, so test-driven state machines write nothing.
    agent_status: AgentStatusReporter,
    /// Wall-clock start of the current reasoning `<think>` block while it is
    /// open (the model is actively reasoning). `None` between blocks.
    thinking_since: Option<Instant>,
    /// Duration of the reasoning block that just closed, cached so the header
    /// can show `[thought for Ns]` transiently. `None` after the reasoning is
    /// shown inline (or none has happened yet).
    thought_for: Option<Duration>,
    /// Wall-clock time `thought_for` was last set, so the `[thought for Ns]`
    /// summary can expire back to the plain `[working]` after a short while
    /// rather than persisting for the rest of the turn. `None` when `thought_for`
    /// is `None` or not yet set.
    thought_for_since: Option<Instant>,
    turn: (u32, u32),
    tokens: u64,
    /// Whether `tokens`/`turn_prompt_tokens` still describe a conversation the
    /// provider actually measured. A compaction rewrites the history out from
    /// under the last reported `usage`, so from that point the counts are the
    /// local chars/4 estimate until a fresh response lands. `/context` reports
    /// the difference rather than presenting a stale number as measured.
    tokens_estimated: bool,
    detail: String,
    /// Outstanding permission requests, oldest first. Several subagents (or a
    /// subagent and the parent) can request approval concurrently; only the
    /// front is shown/answerable at a time, later ones queue and surface once
    /// the front resolves so no requester is silently dropped/left hanging.
    pending_queue: std::collections::VecDeque<Pending>,
    /// Structured questions waiting for this TUI, oldest first.
    ask_queue: std::collections::VecDeque<PendingAsk>,
    picker: Option<Picker>,
    model_picker: Option<ModelPicker>,
    /// Active `/login` prompt; owns the keyboard while open.
    login: Option<LoginPrompt>,
    /// Active `/settings` edit prompt (docked like `/login`); owns the
    /// keyboard while open. Holds the setting being edited and any validation
    /// error; writes go straight to agent.toml on Enter.
    settings_prompt: Option<SettingsPrompt>,
    /// Current `/context` overlay, if one is open. `None` when closed.
    context_view: Option<ContextView>,
    /// Set by `/context` to ask the loop to compute the report off the render
    /// loop (it sizes the tool segment, which takes the MCP server lock a turn
    /// may be holding). Taken once, like `mcp_job_request`.
    context_request: bool,
    /// Set by `/usage <view>` to ask the loop to query the Tokamak usage API
    /// off the render loop (upstream #9034). Taken once, like
    /// `context_request`.
    usage_request: Option<crate::core::cli::tokamak::usage::Query>,
    /// The provider's execution id for the most recent request that reported
    /// one, so `/usage` can name the handle a billing lookup is keyed by.
    last_execution_id: Option<String>,
    /// Active MCP add/edit wizard (docked); owns the keyboard while open.
    mcp_prompt: Option<McpPrompt>,
    /// The `/mcp` detail screen's data, alongside the `McpServer` picker whose
    /// rows are its actions. Held on `App` rather than in the picker so a job
    /// landing later (a tool list, a finished sign-in) can update it in place.
    mcp_detail: Option<McpDetail>,
    /// The run_id the `/agents` inspector is drilled into, or `None` at the
    /// list. The detail renders live from `App::subagents` by this id, so a
    /// finishing child updates (or empties) the screen in place.
    agent_detail: Option<String>,
    /// MCP work handed to the loop to run off the render loop. Taken once.
    mcp_job_request: Option<McpJob>,
    /// An OAuth sign-in in flight, shown in place on the `/mcp` screen and as a
    /// header badge. `None` when no sign-in is running.
    mcp_auth: Option<McpAuthFlow>,
    /// Set when the user asks to cancel the in-flight sign-in. The loop owns the
    /// job handle, so it reads this to abort the wait and drop the loopback
    /// listener; `handle_key` cannot reach the handle itself.
    mcp_auth_cancel: bool,
    /// Active OpenAI-compatible provider wizard (docked); owns the keyboard.
    provider_prompt: Option<ProviderPrompt>,
    /// Providers already probed for a missing model list this session
    /// (success or failure). A dead/unreachable upstream must not be re-contacted
    /// on every bare `/model` -- that would freeze the render loop for the whole
    /// request timeout -- so only unprobed providers are fetched once.
    probed_models: std::collections::HashSet<String>,
    /// `/model` asked for missing model lists: the loop fetches them off the
    /// render loop (report-12 MED-4). Taken once.
    model_fetch_request: bool,
    /// That fetch is in flight.
    model_fetch_running: bool,
    /// `/model` found nothing to show yet: open the picker when the fetch lands.
    model_fetch_wants_picker: bool,
    /// Key handed off to the loop to verify off the render loop. Taken once.
    login_submit: Option<(String, String)>,
    /// `/login` asked for the browser flow: `chat_loop` creates the session.
    login_device_request: bool,
    /// A `/mcp` authorization waiting on the user's yes/no before a browser is
    /// launched. Holds only the URL and what it is for - never the bound
    /// loopback listener, which stays on the task awaiting the redirect.
    browser_confirm: Option<BrowserConfirm>,
    /// `/plugin install` handed off to the loop, which runs the git clone off
    /// the render loop and notes the result when it lands. Taken once.
    plugin_install_request: Option<String>,
    /// A collection picker's chosen plugins handed off to the loop: the source
    /// URL plus the payload-root-relative paths to install. Taken once.
    plugin_select_request: Option<(String, Vec<String>)>,
    /// Source URL behind the open `PluginSelect` picker, so Enter knows which
    /// collection the checked rows came from. Cleared when the picker resolves.
    plugin_collection_url: Option<String>,
    /// A plugin install is in flight: a second request is refused.
    plugin_installing: bool,
    /// Compaction handed off to the loop, which spawns the summarizing model
    /// call off the render loop. Taken once.
    compact_request: Option<CompactKind>,
    /// `/compact <focus>`: what the next manual compaction should keep detail on.
    compact_focus: Option<String>,
    /// `!cmd` waiting to ride on the next run's body.
    scripted_command: Option<String>,
    /// `/btw` answers arriving from their tasks, shown as notes.
    btw_tx: tokio::sync::mpsc::UnboundedSender<String>,
    btw_rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    /// A compaction is in flight: the header and the input box show a throbber,
    /// a second request is refused, and no run starts until it lands (its result
    /// replaces `history`, so a run reading the old one would be clobbered).
    compacting: Option<CompactKind>,
    /// When the in-flight compaction started, for the elapsed counter.
    compact_started: Option<Instant>,
    /// The running turn is compacting itself (preflight, overflow or the
    /// session budget), and since when. Display-only: unlike `compacting` it
    /// gates nothing, because the run that compacts is the one already going.
    run_compacting: Option<Instant>,
    /// The running turn's upstream request failed before anything streamed and
    /// the loop is waiting to resend it. Display-only; cleared by the next event
    /// of the parent run, and by the run ending or being cancelled.
    retrying: Option<RetryWait>,
    /// The in-flight compaction was triggered by a context-overflow error, so
    /// the errored turn is resumed once it lands.
    retry_after_compact: bool,
    /// Overflow retries spent in the current user turn, capped so a model that
    /// overflows no matter how small the context cannot spin forever.
    overflow_retries: u8,
    /// The context-pressure warning (AH-077) has been shown for this fill;
    /// cleared when the fill drops back below the line, so it is said once per
    /// approach rather than every turn.
    context_warned: bool,
    /// Lines scrolled back from the tail; 0 pins the view to the bottom so new
    /// content follows. Non-zero survives streaming so scroll-back stays usable.
    scrollback: u16,
    /// A full repaint is owed before the next frame. Set by Ctrl-L and by a
    /// terminal resize, never per frame: a foreign write to the TTY (a
    /// `wall(1)` broadcast) or an emulator's own reflow changes the physical
    /// screen without touching ratatui's buffers, so the cell diff alone sees
    /// nothing to redraw and the damage stays for the rest of the session.
    repaint: bool,
    /// A diagnostic bundle `/bug` has shown but not written. `/bug save`
    /// writes exactly this, so what was reviewed is what lands on disk.
    pending_bug_report: Option<super::doctor::Preview>,
    /// Set when the user submits a message; the loop spawns a run next tick.
    want_start: bool,
    /// Turns (model roundtrips, plus the submission that kicked off a run)
    /// since the todo list last had open work. The list is the model's own
    /// scratchpad, so a finished one lingers until it declares a new plan --
    /// which may never happen. This counts down a grace period instead of
    /// clearing the moment the last task closes, so a model that is still
    /// mid-flow (about to append, or reopening a task) keeps its list.
    turns_since_todos_closed: u32,
    /// When the plan last went from having open work to having none. Drives the
    /// dock's own, wall-clock hide: `turns_since_todos_closed` only advances on
    /// model roundtrips, so a run that finishes its plan and stops would pin a
    /// fully checked-off list on screen indefinitely.
    todos_closed_at: Option<Instant>,
    /// Transcript viewport width in cells, refreshed each `draw`; tables wrap to
    /// it. 0 until the first draw (callers fall back to a default).
    view_width: u16,
    last_kind: Kind,
    should_quit: bool,
    /// A blank idle composer has armed the exit: the first Ctrl-C/Ctrl-D only
    /// warns,
    /// so leaving the TUI always takes a deliberate second one. Cleared by any
    /// key that resumes composing.
    exit_armed: bool,
    /// Live panels for background subagents currently streaming, one per run.
    /// Several may be active at once; each renders its own rolling window.
    subagents: Vec<SubagentPanel>,
    /// Committed finished-subagent summary rows, expandable to their full
    /// tool-call list via Ctrl-O (parallel to `groups`/`reasoning_blocks`).
    subagent_blocks: Vec<SubagentBlock>,
    /// In-flight `await_subagent` calls, `(tool_call_id, run_id, subagent_name)`.
    /// Cleared on the matching `ToolResult` or `SubagentEnd`, whichever comes
    /// first (the two can race).
    awaiting: Vec<(String, String, String)>,
    /// How each child ended and what it used, by run id, from `SubagentFinished`.
    /// Read when its `SubagentEnd` closes the panel, so the summary row can say
    /// the cost and a turn-limit stop instead of only "finished".
    subagent_finish: std::collections::HashMap<String, String>,
    /// The short name a dispatch gave each child, by run id (`SubagentTitle`).
    subagent_titles: std::collections::HashMap<String, String>,
    /// Tool calls whose arguments are still streaming. Rendered live -- a file
    /// body previews as it arrives, anything else gets a throbber -- and
    /// cleared on the matching `ToolCall` (full args) or on the next `Step`,
    /// whichever comes first.
    starting: Vec<StartingCall>,
    /// Monotonic frame counter driving the throbber. Advanced by whole
    /// `SPINNER_ADVANCE_MS` steps elapsed since `last_spinner_advance`, not once
    /// per tick, so the animation runs at a fixed cadence and catches up after a
    /// stalled loop instead of lagging.
    spinner_frame: usize,
    /// Wall-clock baseline for the last spinner advance; moved forward by whole
    /// frames only so leftover sub-frame time carries into the next tick.
    last_spinner_advance: Instant,
    /// Output tokens/sec of the last completed turn, cached so the header holds a
    /// steady value between turns instead of flickering to 0. Cleared at turn
    /// start; recomputed from the turn's `usage` sample at `on_done`.
    tokens_per_sec: Option<f64>,
    /// Output tokens produced across every request in the current turn. Summed
    /// from `TurnUsage` rather than read off `Done`, which reports only the
    /// final request and so undercounts any turn that used tools.
    turn_output_tokens: u64,
    /// Context size of the current turn's most recent request.
    turn_prompt_tokens: u64,
    /// Transcript viewport rect from the last draw, for mapping mouse clicks
    /// to rows.
    transcript_rect: Rect,
    /// Wrapped-line scroll offset from the last draw (`0` = top). Only the
    /// selection anchor uses it now, to follow content that moved under it.
    last_scroll: u16,
    /// Body screen row -> source transcript index from the last draw (`None`
    /// for synthetic rows: top padding, awaiting throbbers, streaming prose).
    /// One entry per visible row, in wrapped coordinates, so a click maps
    /// straight through even where a row wrapped.
    row_index: Vec<Option<usize>>,
    /// When the current run started, so the header can show elapsed time.
    /// `None` while idle.
    run_started: Option<Instant>,
    /// Mouse selection, live or finished. Cleared by any key, wheel notch or
    /// fresh press.
    selection: Option<Selection>,
    /// Set when a drag ends: the next `draw` lifts the text out of the buffer it
    /// just rendered (only `draw` holds one) and hands it to `chat_loop`.
    copy_armed: bool,
    /// Selected text waiting to reach the clipboard.
    copy_request: Option<String>,
    /// (when, line count) of the last copy, for the transient dock notice.
    copied: Option<(Instant, usize)>,
    /// Pending input, consumed at the next safe loop boundary or next run.
    message_queue: std::collections::VecDeque<PendingMessage>,
    /// Canonical session todo list projection, kept in sync via
    /// `StreamEvent::TodoUpdate`. Empty = no todos declared this session.
    todos: crate::core::agent::todo::TodoList,
    /// Set when the model issued a `todo` tool call in the current turn; cleared
    /// at each turn start. Drives the reminder suppression / retry policy.
    todo_call_this_turn: bool,
    /// Set when a `todo` mutation succeeded this turn (a `TodoUpdate` arrived);
    /// a call without a success means the mutation failed (retry reminder).
    todo_ok_this_turn: bool,
    /// Open-work summary last surfaced as a reminder, so the same reminder never
    /// fires twice in a row without the state changing (reminder dedup).
    last_todo_reminder: Option<String>,
    /// Stop-time reminders sent so far this prompt cycle; caps at
    /// `TODO_REMINDER_MAX` so a summary that keeps changing slightly can't
    /// nag indefinitely even though the same-summary dedup above wouldn't
    /// catch it.
    reminder_count: u32,
    /// True right after a reminder fires, cleared the moment any tool result
    /// lands. Blocks a second reminder from piling onto one the model hasn't
    /// had a chance to act on yet.
    reminder_awaiting_progress: bool,
}

/// How long a fully checked-off plan stays in the dock before it hides: just
/// long enough to see the last task tick over. The list itself lives on until
/// `age_closed_todos` drops it, and `/todo` reopens it at any point.
const TODO_HIDE_AFTER: Duration = Duration::from_secs(3);

/// Braille throbber frames for in-progress rows (e.g. awaiting a subagent).
const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Milliseconds per spinner frame, decoupled from the 50ms render tick.
const SPINNER_ADVANCE_MS: u64 = 80;

/// Rotating action words for the running input placeholder, replacing a static
/// "working…" so a long turn does not read as a hung UI.
const WORKING_WORDS: [&str; 12] = [
    "working",
    "computing",
    "processing",
    "analyzing",
    "crunching",
    "grinding",
    "executing",
    "running",
    "handling",
    "compiling",
    "operating",
    "fetching",
];

/// Rotating action words shown while the model is reasoning (a ` think>` block
/// is streaming), coloured orange. Mirrors the working list so the two states
/// read as the same kind of progress, just distinct in wording and colour.
const THINKING_WORDS: [&str; 12] = [
    "thinking",
    "reasoning",
    "pondering",
    "reflecting",
    "deliberating",
    "musing",
    "ruminating",
    "meditating",
    "contemplating",
    "weighing",
    "cogitating",
    "calculating",
];

/// Spinner frames per placeholder-word change, so the action word turns over
/// at a relaxed pace (60 frames x 80ms ~= 4.8s) rather than shifting under
/// the eye alongside the braille spinner.
const WORD_ROTATE_FRAMES: usize = 60;

/// How long the `[thought for Ns]` header summary lingers after a reasoning
/// block closes before it falls back to the plain `[working]` status. The
/// summary is only a transient cue that a block finished; it should not pin the
/// header for the rest of the turn once the model gets back to work.
const THOUGHT_FOR_TTL: Duration = Duration::from_secs(3);

/// Live rolling view of an in-flight subagent's tool calls. The panel shows only
/// the most recent [`SUBAGENT_WINDOW`] calls, but the full list is retained so
/// the finished summary row can expand back to every call (Ctrl-O).
struct SubagentPanel {
    run_id: String,
    name: String,
    /// The task this child was dispatched with. Shown above the agent list so
    /// the block says what the fan-out is *for*, not just who is running.
    task: String,
    calls: Vec<String>,
    /// Upstream requests this child has made, counted from its `Step` events.
    /// Distinct from `calls.len()`: one request can carry several tool calls,
    /// and a request can carry none.
    requests: u32,
    /// Context occupied by the child's most recent request. The high-water
    /// mark of how full its window is, which is the number worth watching --
    /// a subagent silently filling its context is the failure this surfaces.
    prompt_tokens: u64,
    /// The call the child is currently assembling, if any. Without this a
    /// child streaming a large `write` reports nothing at all for the whole
    /// request -- no completed tool call yet, so a stats line frozen at
    /// "0 tools" and an activity line stuck on "starting…".
    active: Option<StartingCall>,
    /// True while the dispatch is parked on the parent run's
    /// `max_parallel_subagents` cap (reported via `SubagentQueued`); flipped
    /// off when the child's `SubagentStart` arrives. Queued panels render
    /// "queued (N waiting)" instead of live stats, so a capped fan-out reads
    /// as a queue rather than a wall of silently-idle agents.
    queued: bool,
    /// 1-based position in the queue at the time the child was queued.
    waiting: u32,
}

/// A committed finished-subagent summary row, folded to one line but retaining
/// its full tool-call list so the row can expand back to it (like a tool group).
struct SubagentBlock {
    /// Transcript index of the summary row this block owns.
    idx: usize,
    /// Tool-call labels, revealed when expanded. Held as text, not lines, so
    /// they re-truncate to the draw width.
    calls: Vec<String>,
}

impl SubagentBlock {
    /// The child's call list, revealed by Ctrl-O. Wrapped, not elided, for the
    /// same reason as `group_detail_lines`: this is the surface the folded
    /// summary row sends the user to, so it is the one that has to be complete.
    fn detail_lines(&self, width: u16) -> Vec<Line<'static>> {
        let max = width.saturating_sub(8).max(1) as usize;
        self.calls
            .iter()
            .flat_map(|label| {
                gutter_lines(
                    wrap_text(label, Style::new().dim(), max),
                    vec![
                        Span::styled("│   ", Style::new().dark_gray()),
                        Span::styled("▸ ", Style::new().magenta()),
                    ],
                    vec![Span::styled("│     ", Style::new().dark_gray())],
                )
            })
            .collect()
    }
}

/// A queued git workspace snapshot. Snapshots only stage the paths the agent
/// actually touched this turn (see `App::turn_touched`), never the whole
/// working tree, so this stays cheap on a large repo. Still run off the
/// render loop (via `spawn_blocking`) and serialized (each checkpoint parents
/// the previous), driven from the main loop rather than inline in
/// `submit_user`/`on_done`.
enum SnapshotJob {
    /// Base state captured before the first turn; gates the first run.
    Base,
    /// Per-turn checkpoint keyed to the driving user message, carrying the
    /// paths touched by `edit`/`write` tool calls since the previous one.
    Checkpoint {
        user_index: usize,
        preview: String,
        changed: Vec<PathBuf>,
    },
}

/// `(repo, parent sha, commit message, thread id, changed paths)` resolved
/// from a queued [`SnapshotJob`], ready to hand to `git::snapshot`.
type SnapshotInputs = (PathBuf, Option<String>, String, String, Vec<PathBuf>);

impl App {
    #[allow(clippy::too_many_arguments)]
    fn new(
        model: String,
        limits: SessionLimits,
        show_reasoning: bool,
        agent_dir: std::path::PathBuf,
        project_root: PathBuf,
        repo_root: Option<PathBuf>,
    ) -> Self {
        let slash_catalog = SlashCatalog::load(&project_root);
        let (btw_tx, btw_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            smol_model: model.clone(),
            model,
            goal: None,
            goal_eval_pending: false,
            goal_evaluating: false,
            goal_eval_cancel: false,
            run_mode: crate::core::agent::plan::RunMode::Normal,
            args: None,
            approval_phrasing: String::new(),
            context_window: limits.context_window,
            context_window_source: limits.context_window_source,
            // The explicit override, when present, is the resolved window with a
            // `Configured` source; otherwise there was none to carry forward.
            configured_context_window: match limits.context_window_source {
                crate::core::cli::model_capabilities::ContextWindowSource::Configured => {
                    Some(limits.context_window)
                }
                _ => None,
            },
            reserve_tokens: limits.reserve_tokens,
            reserve_pinned: limits.compaction.origins.reserve_tokens
                != tauri_plugin_agent_tools::compaction_policy::Origin::Default,
            compaction_auto: limits.compaction.auto,
            compaction_keep_recent: limits.compaction.keep_recent,
            max_tokens: limits.max_tokens,
            max_session_tokens: limits.max_session_tokens,
            max_session_tokens_pinned: limits.max_session_tokens_pinned,
            repo_root,
            git_branch: git::current_branch(&project_root),
            project_root,
            turn_touched: Vec::new(),
            diff_paths: HashMap::new(),
            bash_commands: HashMap::new(),
            bash_jobs: HashMap::new(),
            live_output: HashMap::new(),
            live_alias: HashMap::new(),
            job_origin: HashMap::new(),
            active_bg_jobs: std::collections::HashSet::new(),
            base_snapshot: None,
            checkpoints: Vec::new(),
            workspace: None,
            workspace_record: None,
            forked_from: None,
            snap_queue: std::collections::VecDeque::new(),
            base_requested: false,
            last_esc: None,
            rewind_target: None,
            agent_dir,
            history: Vec::new(),
            thread_id: None,
            transcript: Vec::new(),
            display_log: Vec::new(),
            journal_writer: None,
            thread_saver: None,
            assistant_buf: String::new(),
            think_scan: Default::default(),
            reasoning_segs: Vec::new(),
            tool_group: None,
            grouped_ids: std::collections::HashSet::new(),
            groups: Vec::new(),
            pending_rows: Vec::new(),
            reasoning_blocks: Vec::new(),
            expanded_traces: std::collections::HashSet::new(),
            show_reasoning,
            // Overwritten from the session config right after construction.
            stream_reasoning: true,
            send_reasoning: true,
            reasoning_effort: "medium".into(),
            last_non_low_effort: "medium".into(),
            expanded: std::collections::HashSet::new(),
            reveal: None,
            input: String::new(),
            input_history: Vec::new(),
            recall_pos: None,
            pending_images: Vec::new(),
            cursor: 0,
            slash_selected: 0,
            slash_dismissed: false,
            slash_matches_cache: RefCell::new(None),
            slash_catalog,
            path_hints: Vec::new(),
            path_hints_dirty: false,
            path_hint_gen: 0,
            path_hint_selected: 0,
            path_hint_dismissed: false,
            status: Status::Idle,
            agent_status: AgentStatusReporter::new(),
            thinking_since: None,
            thought_for: None,
            thought_for_since: None,
            turn: (0, 0),
            tokens: 0,
            tokens_estimated: false,
            detail: String::new(),
            pending_queue: std::collections::VecDeque::new(),
            ask_queue: std::collections::VecDeque::new(),
            picker: None,
            model_picker: None,
            login: None,
            settings_prompt: None,
            context_view: None,
            context_request: false,
            usage_request: None,
            last_execution_id: None,
            mcp_prompt: None,
            mcp_detail: None,
            agent_detail: None,
            mcp_job_request: None,
            mcp_auth: None,
            mcp_auth_cancel: false,
            provider_prompt: None,
            probed_models: std::collections::HashSet::new(),
            model_fetch_request: false,
            model_fetch_running: false,
            model_fetch_wants_picker: false,
            login_submit: None,
            login_device_request: false,
            browser_confirm: None,
            plugin_install_request: None,
            plugin_select_request: None,
            plugin_collection_url: None,
            plugin_installing: false,
            compact_request: None,
            compact_focus: None,
            scripted_command: None,
            btw_tx,
            btw_rx,
            compacting: None,
            compact_started: None,
            run_compacting: None,
            retrying: None,
            retry_after_compact: false,
            overflow_retries: 0,
            context_warned: false,
            scrollback: 0,
            repaint: false,
            pending_bug_report: None,
            want_start: false,
            turns_since_todos_closed: 0,
            todos_closed_at: None,
            view_width: 0,
            last_kind: Kind::None,
            should_quit: false,
            exit_armed: false,
            subagents: Vec::new(),
            subagent_blocks: Vec::new(),
            awaiting: Vec::new(),
            subagent_finish: std::collections::HashMap::new(),
            subagent_titles: std::collections::HashMap::new(),
            starting: Vec::new(),
            spinner_frame: 0,
            last_spinner_advance: Instant::now(),
            tokens_per_sec: None,
            turn_output_tokens: 0,
            turn_prompt_tokens: 0,
            transcript_rect: Rect::default(),
            last_scroll: 0,
            row_index: Vec::new(),
            run_started: None,
            selection: None,
            copy_armed: false,
            copy_request: None,
            copied: None,
            message_queue: std::collections::VecDeque::new(),
            todos: crate::core::agent::todo::TodoList::default(),
            todo_call_this_turn: false,
            todo_ok_this_turn: false,
            last_todo_reminder: None,
            reminder_count: 0,
            reminder_awaiting_progress: false,
        }
    }

    /// The permission request currently shown/answerable, if any (the front of
    /// `pending_queue`). Later queued requests stay hidden until this resolves.
    fn pending(&self) -> Option<&Pending> {
        self.pending_queue.front()
    }

    /// Effective width for table wrapping (fallback before the first draw).
    fn render_width(&self) -> u16 {
        if self.view_width == 0 {
            80
        } else {
            self.view_width
        }
    }

    fn push(&mut self, line: Line<'static>) {
        self.transcript.push(Row::line(line));
    }

    fn push_row(&mut self, row: impl Into<Row>) {
        self.transcript.push(row.into());
    }

    /// Insert a blank separator when the block *band* changes, then record the
    /// kind. Keeps consecutive same-kind lines tight while spacing turn
    /// boundaries.
    fn gap(&mut self, next: Kind) {
        let last_blank = self.transcript.last().map(Row::is_blank).unwrap_or(true);
        if !self.transcript.is_empty() && band(self.last_kind) != band(next) && !last_blank {
            self.transcript.push(Row::line(Line::raw("")));
        }
        self.last_kind = next;
    }

    /// Put the session in a checkout and let the active thread claim it. The two
    /// fields are separate only where a thread must not claim what it works in
    /// (a fork, a resume from elsewhere); everywhere else they move together.
    fn set_workspace(&mut self, workspace: Option<Worktree>) {
        self.workspace_record = workspace.clone();
        self.workspace = workspace;
    }

    /// Where the agent's tools read and write: the session's worktree when it
    /// has one, else the project. Relative tool paths and `@path` refs resolve
    /// here, not against the original checkout.
    fn work_root(&self) -> &std::path::Path {
        self.workspace.as_ref().map_or(self.project_root.as_path(), |w| w.path.as_path())
    }

    /// Drop the current conversation and all transient turn state, detaching from
    /// the saved thread so the next message starts a fresh one. Backs `/clear` and
    /// `/new`; the model/MCP setup and picker state are untouched.
    fn reset_session(&mut self) {
        self.history.clear();
        self.thread_id = None;
        // A fresh session drops any active goal along with the conversation.
        self.goal = None;
        self.goal_eval_pending = false;
        // Detach snapshots; the next submit arms a fresh base + thread id.
        self.base_snapshot = None;
        self.checkpoints.clear();
        // A fresh session is a root, whatever the one it replaced was, and it
        // owns the checkout this session is working in.
        self.forked_from = None;
        self.workspace_record = self.workspace.clone();
        self.snap_queue.clear();
        self.base_requested = false;
        self.last_esc = None;
        self.transcript.clear();
        self.display_log.clear();
        self.tool_group = None;
        self.grouped_ids.clear();
        self.starting.clear();
        self.groups.clear();
        self.pending_rows.clear();
        // Job pairings belong to the session being dropped (Jozkah/jan#134).
        self.bash_jobs.clear();
        self.job_origin.clear();
        self.reasoning_blocks.clear();
        self.expanded_traces.clear();
        self.subagent_blocks.clear();
        self.subagents.clear();
        self.expanded.clear();
        self.reveal = None;
        self.assistant_buf.clear();
        self.reasoning_segs.clear();
        self.message_queue.clear();
        self.pending_queue.clear();
        self.ask_queue.clear();
        self.pending_images.clear();
        self.tokens = 0;
        // An empty history is exactly known, not an estimate of anything.
        self.tokens_estimated = false;
        self.turn_prompt_tokens = 0;
        self.tokens_per_sec = None;
        self.turn = (0, 0);
        self.detail.clear();
        self.scrollback = 0;
        self.last_kind = Kind::None;
        // A fresh session drops the todo projection and reminder state; the
        // model re-declares work with a new `todo init`.
        self.todos = crate::core::agent::todo::TodoList::default();
        self.todos_closed_at = None;
        self.todo_call_this_turn = false;
        self.todo_ok_this_turn = false;
        self.last_todo_reminder = None;
        self.reminder_count = 0;
        self.reminder_awaiting_progress = false;
    }

    /// Drop the provider's token measurement, because the history it measured is
    /// no longer the history we hold.
    ///
    /// Any edit to the conversation behind the model's back -- a compaction, a
    /// rewind, resuming a different thread -- invalidates the last reported
    /// `prompt_tokens`: it describes turns that are gone. `/context` then falls
    /// back to the estimator and says so, rather than presenting a stale count
    /// as measured. Callers that *empty* the history use [`App::reset_session`]
    /// instead, where zero is exact rather than an estimate.
    fn invalidate_token_provenance(&mut self) {
        self.tokens_estimated = true;
        self.turn_prompt_tokens = 0;
    }

    /// Drop any selection, and with it a copy armed but not yet lifted out of a
    /// frame -- otherwise it would fire against whatever is selected next.
    fn clear_selection(&mut self) {
        self.selection = None;
        self.copy_armed = false;
    }

    /// Owe a full repaint on the next frame. Display only: the draft, scroll
    /// position and any running turn are left alone, so it is safe from any
    /// mode, mid-turn included.
    fn request_repaint(&mut self) {
        self.repaint = true;
    }

    /// Take the pending full-repaint request, if there is one.
    fn take_repaint(&mut self) -> bool {
        std::mem::take(&mut self.repaint)
    }

    /// Line count of a copy recent enough to still advertise, if any.
    fn copy_notice(&self) -> Option<usize> {
        self.copied
            .filter(|(at, _)| at.elapsed() < COPY_NOTICE)
            .map(|(_, lines)| lines)
    }

    /// Open the session with the splash: the hand-wave logo and wordmark, this
    /// session's project and approval mode, and where to go next.
    fn push_banner(&mut self, tools: &str, awaiting_first_message: bool) {
        let banner = Banner {
            version: super::version::build_version(),
            project: tilde_path(&self.project_root),
            branch: self.git_branch.clone(),
            tools: tools.to_string(),
            workspace: self
                .workspace
                .as_ref()
                .map(|w| format!("{} ⎇ {}", tilde_path(&w.path), w.branch)),
            awaiting_first_message,
        };
        self.gap(Kind::Meta);
        self.push_row(RowKind::Banner(Box::new(banner)));
        // Whatever follows -- a startup note, or the first message -- gets a
        // blank line off the splash instead of butting against its last row.
        self.last_kind = Kind::None;
    }

    /// Push the splash using the startup approval phrasing, to re-brand the
    /// screen after a slash command opens a fresh view (`/clear`, `/new`,
    /// `/resume`). `awaiting_first_message` starts false once a thread is
    /// loaded or a task is seeded.
    fn push_session_banner(&mut self, awaiting_first_message: bool) {
        let phrasing = self.approval_phrasing.clone();
        self.push_banner(&phrasing, awaiting_first_message);
        // Safe mode stays visible: the banner is re-pushed on every new session.
        if tauri_plugin_agent_tools::safe_mode::active() {
            self.system(Level::Warn, tauri_plugin_agent_tools::safe_mode::BANNER);
        }
    }

    /// Append a line the *app* is saying, in its own gutter column. Every other
    /// transcript class owns one (`> ` user, `│ ` tool, `┊ ` reasoning), so
    /// without it a note is indistinguishable from model prose. `glyph` names the
    /// category and `level` carries severity.
    fn system_marked(&mut self, glyph: &'static str, level: Level, text: &str) {
        self.scrollback = 0;
        self.gap(Kind::Meta);
        let (gutter, body) = level.styles();
        self.push_row(RowKind::System {
            glyph,
            cont: " ",
            gutter,
            body: vec![Span::styled(text.to_string(), body)],
            bg: None,
        });
    }

    fn system(&mut self, level: Level, text: &str) {
        self.system_marked(SYSTEM_GLYPH, level, text);
    }

    /// A dim informational note: the common case, and what every `/command`
    /// acknowledgement and background result goes through.
    fn note(&mut self, text: &str) {
        self.system(Level::Info, text);
    }

    /// A body row of a multi-line system block (`/help`, `/threads`, a goal
    /// status), under the header its `system*` call pushed. The gutter keeps
    /// running so the block reads as one unit instead of leaving its body
    /// unattributed, and the body starts in the header's column.
    ///
    /// Fixed dim styling rather than the header's `Level`: blocks are
    /// informational -- a warning or an error is a single line.
    fn system_detail(&mut self, body: Vec<Span<'static>>) {
        self.push_row(RowKind::System {
            glyph: SYSTEM_CONT,
            cont: SYSTEM_CONT,
            gutter: Style::new().dark_gray(),
            body,
            bg: None,
        });
    }

    fn system_detail_text(&mut self, text: &str) {
        self.system_detail(vec![Span::styled(text.to_string(), Style::new().dim())]);
    }

    fn flush_assistant(&mut self) {
        let segs = std::mem::take(&mut self.reasoning_segs);
        let prose = self.assistant_buf.trim_end().to_string();
        self.assistant_buf.clear();
        // How long this turn's reasoning took, for the `Thought for Ns` label:
        // an open block being closed by this flush (a mid-block tool call) is
        // still timing on `thinking_since`; one that closed earlier (prose
        // arrived) stashed its elapsed in `thought_for`.
        let open = self.thinking_since.take();
        let reasoning_dur = open.map(|s| s.elapsed()).or(self.thought_for);
        // A block still open at flush time is closed by this flush (a reason ->
        // tool turn): stamp the header badge state so it shows `[thought for Ns]`
        // exactly as a reason -> answer turn does, where a content Token stamps
        // it. A block that closed earlier already stamped itself.
        if let Some(started) = open {
            self.thought_for = Some(started.elapsed());
            self.thought_for_since = Some(Instant::now());
        }
        // No-op (and, crucially, don't finalize the tool group) on an empty or
        // whitespace-only turn, so silent consecutive tool calls keep folding.
        if !assistant_has_content(&prose, &segs) {
            return;
        }
        // Model prose ends the current run of tool calls.
        self.finalize_tool_group();
        // Display-logged here (out of `history` on purpose) so the replay folds
        // reasoning like the live turn did. Prose and reasoning are journaled
        // apart, exactly as they arrived; the reasoning duration rides along so
        // a resumed session keeps its `Thought for Ns` label.
        self.display_log.push(DisplayEntry::Assistant {
            text: prose.clone(),
            reasoning: segs.clone(),
            reasoning_ms: reasoning_dur.map(|d| d.as_millis() as u64),
        });
        self.push_assistant_blocks(&prose, &segs, reasoning_dur);
    }

    /// Commit assistant `text` to the transcript in emission order: answer prose
    /// through markdown, each `<think>` block folded to a one-line summary row
    /// whose full dimmed detail is retained for expansion.
    fn push_assistant_blocks(
        &mut self,
        prose: &str,
        segs: &[ReasoningSeg],
        reasoning_dur: Option<Duration>,
    ) {
        let runs = assistant_runs(prose, segs);
        // `reasoning_dur` is a single turn-wide figure, so it is only meaningful
        // when the turn has one reasoning block; stamping it on each of several
        // would misreport all but one (per-block timing is not tracked). With
        // more than one, they fall back to a plain `Thought`.
        let single_reasoning = runs
            .iter()
            .filter(|(reasoning, seg)| *reasoning && !seg.trim().is_empty())
            .count()
            == 1;
        for (reasoning, seg) in runs {
            // Only answer prose can carry an injected `<system>` block; stripping
            // per run rather than over the whole turn keeps the reasoning
            // offsets meaningful.
            let seg = if reasoning {
                seg
            } else {
                strip_system_xml_tags(&seg).to_string()
            };
            if seg.trim().is_empty() {
                continue;
            }
            if reasoning {
                let detail = reasoning_detail_lines(&seg);
                if detail.is_empty() {
                    continue;
                }
                // Distinct Kind so the reasoning->prose transition still gaps
                // (both sharing Kind::Prose would collapse to no separator).
                self.gap(Kind::Reasoning);
                if self.show_reasoning {
                    self.transcript.extend(detail.into_iter().map(Row::line));
                } else {
                    let dur = single_reasoning.then_some(reasoning_dur).flatten();
                    self.push(reasoning_summary_row(dur));
                    let idx = self.transcript.len() - 1;
                    self.reasoning_blocks.push(ReasoningBlock { idx, detail });
                }
            } else {
                // Kept as source: the markdown re-wraps at the draw width, so a
                // resize re-flows tables and code blocks instead of stranding
                // them at the width they were committed at. Markup that renders
                // to nothing (a bare HTML comment) still emits no row.
                let row: Row = RowKind::Markdown(seg.to_string()).into();
                if !row.lines(self.render_width()).is_empty() {
                    self.gap(Kind::Prose);
                    self.push_row(row);
                }
            }
        }
    }

    /// Fold a collapsible tool call into the current group row (extending it and
    /// updating its live status) or open a new group row.
    fn push_grouped_call(&mut self, id: &str, name: &str, label: String, done: String) {
        let (noun, is_read) = tool_kind(name);
        self.grouped_ids.insert(id.to_string());
        let call = GroupedCall {
            id: id.to_string(),
            activity: label.clone(),
            done: done.clone(),
            content: None,
            is_error: false,
            diff: None,
        };
        let extend = self
            .tool_group
            .as_ref()
            .is_some_and(|g| g.idx < self.transcript.len());
        if extend {
            let g = self.tool_group.as_mut().expect("group checked above");
            g.nouns.push((noun, is_read));
            g.calls.push(call);
            self.refresh_group_row();
            return;
        }
        self.gap(Kind::Tool);
        self.push_row(RowKind::Tool {
            tag: "▸".to_string(),
            tag_style: Style::new().cyan(),
            label,
            label_style: Style::new().cyan().dim(),
            reserve: TOOL_ROW_RESERVE,
        });
        self.tool_group = Some(ToolGroup {
            idx: self.transcript.len() - 1,
            first_done: done,
            nouns: vec![(noun, is_read)],
            calls: vec![call],
            started: Instant::now(),
            last_result_error: None,
        });
    }

    /// Rewrite the open group's row for its current state, leaving it open so
    /// later calls keep folding in. Called as each result lands so the status
    /// resolves then, rather than lagging until the group closes (which only
    /// happens once the model starts answering).
    fn refresh_group_row(&mut self) {
        let Some((idx, row)) = self
            .tool_group
            .as_ref()
            .filter(|g| g.idx < self.transcript.len())
            .map(|g| (g.idx, g.row(GroupRow::Open)))
        else {
            return;
        };
        self.transcript[idx] = row;
    }

    /// Close the current tool group, rewriting its row to a short summary: the
    /// single activity label for one call, else a counted breakdown.
    fn finalize_tool_group(&mut self) {
        self.close_tool_group(false);
    }

    /// `interrupted` marks calls that never received a result as unresolved
    /// rather than done. Only an abort knows that: a normal finalize can land
    /// while a call is legitimately still running (a `dispatch_subagent`
    /// resolves after its child's panel opens).
    fn close_tool_group(&mut self, interrupted: bool) {
        let Some(g) = self.tool_group.take() else {
            return;
        };
        if g.idx >= self.transcript.len() {
            return;
        }
        let state = if interrupted {
            GroupRow::Aborted
        } else {
            GroupRow::Closed
        };
        self.transcript[g.idx] = g.row(state);
        self.groups.push(g);
    }

    /// The committed traces (contiguous runs of reasoning-summary + tool-group
    /// rows), each of 2+ rows -- a lone reasoning block or tool group is already
    /// one line and not worth a collapse header. Members are the finalized
    /// reasoning blocks and tool groups; the still-running group is the active
    /// tail and never part of a collapsible run.
    fn trace_runs(&self) -> Vec<TraceRun> {
        let mut members: Vec<(usize, bool)> = Vec::new();
        for g in &self.groups {
            members.push((g.idx, true));
        }
        for r in &self.reasoning_blocks {
            members.push((r.idx, false));
        }
        members.sort_by_key(|(i, _)| *i);

        let mut runs = Vec::new();
        let mut iter = members.into_iter().peekable();
        while let Some((start, first_is_tool)) = iter.next() {
            let mut end = start;
            let mut tool_ran = first_is_tool;
            while let Some(&(next, is_tool)) = iter.peek() {
                if next != end + 1 {
                    break;
                }
                end = next;
                tool_ran |= is_tool;
                iter.next();
            }
            let steps = end - start + 1;
            if steps >= 2 {
                runs.push(TraceRun {
                    start,
                    end,
                    tool_ran,
                    steps,
                });
            }
        }
        runs
    }

    /// The live run's *settled* steps, folded behind one header so the condensed
    /// view shows only the step in flight. Settled steps are the reasoning-summary
    /// and tool-group rows after the last answer that are not the running box.
    ///
    /// The fold is stable for the whole run: it depends only on the run being live
    /// (`Status::Running`) and on how many settled steps exist -- never on a
    /// transient frontier or a per-event marker -- so the header cannot toggle
    /// open as one step hands off to the next, in the gap before a step's content
    /// arrives, or when a background (monitor/subagent/notice) event lands. The
    /// frontier below the header is the only moving part. Gating on status also
    /// means the fold ends the instant the run does: `draw` never gets an animated
    /// header over an idle transcript, and the committed `trace_runs` fold (static,
    /// past-tense) takes over the same rows, so nothing moves on wrap-up.
    ///
    /// Returns `None` until two settled steps exist: a lone step is already one
    /// line, so a header would save no space and only read as "1 step".
    fn active_fold(&self) -> Option<TraceRun> {
        if self.status != Status::Running {
            return None;
        }
        let running = self
            .tool_group
            .as_ref()
            .filter(|g| g.is_running())
            .map(|g| g.idx);
        let last_answer = self.last_answer_idx();
        let mut settled: Vec<(usize, bool)> = Vec::new();
        for g in &self.groups {
            settled.push((g.idx, true));
        }
        for r in &self.reasoning_blocks {
            settled.push((r.idx, false));
        }
        // A finished-but-not-yet-closed command is a settled prior step too.
        if let Some(g) = &self.tool_group {
            if !g.is_running() {
                settled.push((g.idx, true));
            }
        }
        settled.retain(|(i, _)| last_answer.is_none_or(|a| *i > a) && Some(*i) != running);
        if settled.len() < 2 {
            return None;
        }
        settled.sort_by_key(|(i, _)| *i);
        let tool_ran =
            running.is_some() || !self.starting.is_empty() || settled.iter().any(|(_, t)| *t);
        Some(TraceRun {
            start: settled[0].0,
            end: settled.last().unwrap().0,
            tool_ran,
            steps: settled.len(),
        })
    }

    /// Expand/fold the trace that starts at `start` (toggles its opt-out of the
    /// default fold). A no-op if `start` is not a trace or active-fold start.
    fn toggle_trace(&mut self, start: usize) {
        let is_start = self.trace_runs().iter().any(|r| r.start == start)
            || self.active_fold().is_some_and(|r| r.start == start);
        if !is_start {
            return;
        }
        if !self.expanded_traces.remove(&start) {
            self.expanded_traces.insert(start);
        }
    }

    /// Highest transcript index holding answer prose, or `None` when the turn
    /// has produced none yet. A trace whose last row precedes some answer is
    /// "finished" and folds by default; the run after the latest answer is the
    /// active one and stays open.
    fn last_answer_idx(&self) -> Option<usize> {
        self.transcript
            .iter()
            .rposition(|row| matches!(row.kind, RowKind::Markdown(_)))
    }

    /// Fold one finished child into a summary row, retaining its call list so
    /// the row can expand back to it (like a tool group). `finished` separates a
    /// clean `SubagentEnd` from a child the run ended out from under.
    fn push_subagent_summary(&mut self, name: &str, calls: Vec<String>, finished: bool) {
        self.push_subagent_summary_with(name, calls, finished, None);
    }

    /// [`Self::push_subagent_summary`] with the child's cost or stop reason
    /// appended to its label, when the loop reported one.
    fn push_subagent_summary_with(
        &mut self,
        name: &str,
        calls: Vec<String>,
        finished: bool,
        extra: Option<String>,
    ) {
        self.display_log.push(DisplayEntry::Subagent {
            name: name.to_string(),
            calls: calls.clone(),
            finished,
        });
        let total = calls.len();
        let noun = if total == 1 { "call" } else { "calls" };
        let verb = if finished { "finished" } else { "interrupted" };
        let style = if finished {
            Style::new().magenta().dim()
        } else {
            Style::new().yellow()
        };
        self.gap(Kind::Tool);
        self.push_row(RowKind::Tool {
            tag: "↲".to_string(),
            tag_style: style,
            label: match &extra {
                Some(extra) => format!("subagent {name} {verb} ({total} tool {noun}, {extra})"),
                None => format!("subagent {name} {verb} ({total} tool {noun})"),
            },
            label_style: if finished { style } else { Style::new().dim() },
            reserve: TOOL_ROW_RESERVE,
        });
        if total > 0 {
            let idx = self.transcript.len() - 1;
            self.subagent_blocks.push(SubagentBlock { idx, calls });
        }
    }

    /// Close every live child panel, for a run that ended without their own
    /// `SubagentEnd` events (an upstream error mid-fan-out, a `Done` that beats
    /// the children, a cancel). The panel is live state and must not outlive the
    /// run -- a stranded block spins in the dock on an idle session -- but a
    /// child that did work still earns its summary row, so the calls it made are
    /// accounted for rather than vanishing with the panel.
    fn close_live_subagents(&mut self) {
        for panel in std::mem::take(&mut self.subagents) {
            self.push_subagent_summary(&panel.name, panel.calls, false);
        }
        self.awaiting.clear();
    }

    /// The live terminal box for `group`'s newest unresolved *command*, streamed
    /// from the moment the command starts -- before any output -- so it reads as
    /// a terminal opening rather than a spinner that later becomes one. No rows
    /// when nothing in the group is a command in flight (a `read`/`grep` run
    /// keeps its plain activity row).
    ///
    /// One box per command still in flight, in dispatch order: a group runs its
    /// calls in parallel, so several commands can be streaming at once and each
    /// gets its own terminal rather than one hiding the rest. A `read`/`grep` in
    /// the group has no command and contributes no box. Follows the job alias,
    /// so a call *waiting on* a backgrounded job shows the output the detached
    /// job is still producing under the id of the call that started it.
    fn live_shell_panel(&self, group: &ToolGroup, spinner_frame: usize, width: u16) -> Vec<Line<'static>> {
        // The detached job streams under the id of the call that started it, so a
        // collecting call reads its output through the alias.
        fn output_key<'a>(alias: &'a HashMap<String, String>, call: &'a GroupedCall) -> &'a str {
            alias.get(&call.id).map_or(call.id.as_str(), String::as_str)
        }
        let elapsed = group.started.elapsed().as_secs();
        let mut out = Vec::new();
        for call in group
            .calls
            .iter()
            .filter(|c| c.content.is_none() && self.bash_commands.contains_key(&c.id))
        {
            // A blank row between stacked boxes so two terminals do not run their
            // borders together.
            if !out.is_empty() {
                out.push(Line::raw(""));
            }
            let command = &self.bash_commands[&call.id];
            let output = self
                .live_output
                .get(output_key(&self.live_alias, call))
                .map_or("", String::as_str);
            out.extend(running_terminal_lines(
                command, output, elapsed, spinner_frame, width,
            ));
        }
        out
    }

    /// Pair a `bash` call with the backgrounded command it is about.
    ///
    /// Both directions run off the same maps: a call carrying a `command` is
    /// remembered against its call id until its result lands (which is where a
    /// `job_id` would appear), and a call carrying only a `job_id` gets that
    /// command filled back in, so every row labelling the call names the work
    /// rather than an opaque id. Labels are built from the returned value; the
    /// journal keeps the arguments as they arrived, so a replay rebuilds the
    /// pairing from the same events in the same order.
    fn track_bash_job(
        &mut self,
        id: &str,
        name: &str,
        mut args: serde_json::Value,
    ) -> serde_json::Value {
        if !matches!(name, "bash" | "shell" | "exec") {
            return args;
        }
        let cmd = args
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !cmd.is_empty() {
            self.bash_commands.insert(id.to_string(), cmd);
            return args;
        }
        // Collecting a backgrounded job: the detached command still streams under
        // the id of the call that started it, so point this call at that buffer.
        // Without the alias the row the user is waiting on shows an empty box.
        let mut remembered = None;
        if let Some(job) = bash_job_id(&args).map(str::to_string) {
            // The collecting call blocks until the job finishes, so it is no
            // longer running unattended: drop it from the status-bar count.
            // Its pairing entries are consumed here too, or both maps would
            // keep one entry per backgrounded job for the whole session
            // (Jozkah/jan#134).
            self.active_bg_jobs.remove(&job);
            if let Some(origin) = self.job_origin.remove(&job) {
                self.live_alias.insert(id.to_string(), origin);
            }
            remembered = self.bash_jobs.remove(&job);
        }
        if let (Some(cmd), Some(obj)) = (remembered, args.as_object_mut()) {
            self.bash_commands.insert(id.to_string(), cmd.clone());
            obj.insert("command".to_string(), serde_json::Value::String(cmd));
        }
        args
    }

    /// Rewrite a standalone tool row to its resolved form once its result lands:
    /// past-tense label plus an outcome tag, matching how a tool group's row
    /// resolves. Without this a finished `edit` keeps reading as "Editing X".
    /// Returns whether the row was found and rewritten.
    fn resolve_pending_row(&mut self, id: &str, is_error: bool) -> bool {
        let Some(pos) = self.pending_rows.iter().position(|row| row.id == id) else {
            return false;
        };
        let row = self.pending_rows.remove(pos);
        if row.idx >= self.transcript.len() {
            return false;
        }
        let (tag, tag_style) = if is_error {
            ("✗", Style::new().red())
        } else {
            ("✓", Style::new().green())
        };
        self.transcript[row.idx] = RowKind::Tool {
            tag: tag.to_string(),
            tag_style,
            label: row.done,
            label_style: Style::new().dim(),
            reserve: TOOL_ROW_RESERVE,
        }
        .into();
        true
    }

    /// Resolve every row still awaiting a result: the run ended (cancel, error,
    /// aborted stream) and no `ToolResult` is coming, so a `▸`/`✓` would read as
    /// work that is still running or that succeeded.
    fn abort_tool_rows(&mut self) {
        self.close_tool_group(true);
        self.resolve_orphan_tool_rows();
    }

    /// Retire every in-flight tool row the stream will never speak for again.
    /// Shared by the abort paths and by `on_done`: a run that ends normally can
    /// still leave both behind (an upstream that stops mid tool call, or a soft
    /// stop that returns before the calls are dispatched), and neither a
    /// "Preparing X" throbber nor a `▸` row has anything left to resolve it.
    fn resolve_orphan_tool_rows(&mut self) {
        // A call whose args were still streaming never gets its "Preparing X"
        // throbber cleared by the `ToolCall` that would have superseded it, so
        // it animates on past the end of the run, naming a tool that never ran.
        self.starting.clear();
        // Same for a wait whose `ToolResult` never landed: its child cannot
        // outlive the run, so the row has nothing left to wait for.
        self.awaiting.clear();
        for row in std::mem::take(&mut self.pending_rows) {
            if row.idx < self.transcript.len() {
                self.transcript[row.idx] = RowKind::Tool {
                    tag: "○".to_string(),
                    tag_style: Style::new().yellow(),
                    label: row.label,
                    label_style: Style::new().dim(),
                    reserve: TOOL_ROW_RESERVE,
                }
                .into();
            }
        }
    }

    /// Stamp the moment the plan ran out of open work, and clear the stamp the
    /// moment it has some again. Called once per frame rather than at each
    /// mutation site, so the four places that write `todos` cannot disagree.
    fn refresh_todo_deadline(&mut self) {
        if self.todos.is_empty() || self.todos.has_open() {
            self.todos_closed_at = None;
        } else if self.todos_closed_at.is_none() {
            self.todos_closed_at = Some(Instant::now());
        }
    }

    /// True once a fully checked-off plan has sat closed for `TODO_HIDE_AFTER`.
    /// Only the dock hides: the list still exists, `/todo` still opens it, and
    /// `age_closed_todos` still owns actually dropping it. A finished plan stops
    /// being live state the moment it is read, and holding those rows costs the
    /// conversation the space they take.
    fn todos_expired(&self) -> bool {
        self.todos_closed_at
            .is_some_and(|closed| closed.elapsed() >= TODO_HIDE_AFTER)
    }

    /// True while a reasoning block is streaming and nothing of it is on screen:
    /// the one stretch of a run with no visible motion, which is what the
    /// header's shimmering `[thinking]` badge stands in for. With
    /// `stream_reasoning` on the tail itself is moving, so the badge stays flat.
    fn is_thinking(&self) -> bool {
        self.status != Status::Idle
            && !self.show_reasoning
            && !self.stream_reasoning
            && self.reasoning_open()
    }

    /// The open dock that owns the keyboard, phrased as what the user has to do
    /// in it. `None` when the composer is live.
    ///
    /// Must mirror the guard list at the top of `handle_key`: a dock that takes
    /// every keystroke but leaves a cursor blinking in the composer promises a
    /// field that is not there.
    /// True while a permission or ask prompt is queued: it is the single owner
    /// of the screen and keyboard, ahead of any picker.
    fn prompt_owns_screen(&self) -> bool {
        !self.pending_queue.is_empty() || !self.ask_queue.is_empty()
    }

    /// Close any open picker when a prompt arrives, so `draw` and `handle_key`
    /// agree on who owns the screen. Live inspectors reopen from their command.
    fn yield_screen_to_prompt(&mut self) {
        self.model_picker = None;
        self.picker = None;
        self.agent_detail = None;
    }

    fn blocking_dock(&self) -> Option<&'static str> {
        if self.login.is_some() {
            Some("sign in in the dock above")
        } else if self.browser_confirm.is_some() {
            Some("answer the question above")
        } else if self.context_view.is_some() {
            Some("close the context view above")
        } else if self.settings_prompt.is_some() {
            Some("edit the setting above")
        } else if self.mcp_prompt.is_some() || self.provider_prompt.is_some() {
            Some("finish the wizard above")
        } else {
            None
        }
    }

    /// True while the model is mid-reasoning: either a `<think>` block is live
    /// in the answer buffer (inline-tag providers) or the newest native segment
    /// is still at the tail, i.e. no content token has arrived since
    /// (`reasoning_content` providers). The tail check is what closes the window
    /// when prose starts, since native segments live on until the next flush.
    fn reasoning_open(&self) -> bool {
        self.think_scan.borrow_mut().state(&self.assistant_buf).0
            || self
                .reasoning_segs
                .last()
                .is_some_and(|seg| seg.at == self.assistant_buf.len())
    }

    /// Header status while a turn is running with reasoning folding on:
    /// `[thinking]` while a reasoning block is actively streaming, `[thought for
    /// Ns]` for a short while after a block closes, then back to `None` (the
    /// plain `[working]`) once the model is working again. `None` when no
    /// reasoning has happened recently this turn.
    fn reasoning_status(&self) -> Option<(String, Style)> {
        if self.reasoning_open() {
            Some(("thinking".to_string(), Style::new().yellow().bold()))
        } else {
            // The summary is transient: it lasts only `THOUGHT_FOR_TTL` after the
            // block closed, so a long tool call or answer prose falls back to the
            // plain [working] instead of pinning [thought for Ns] till turn end.
            match (self.thought_for, self.thought_for_since) {
                (Some(d), Some(since)) if since.elapsed() < THOUGHT_FOR_TTL => Some((
                    format!("thought for {}", format_elapsed(d.as_secs())),
                    Style::new().yellow(),
                )),
                _ => None,
            }
        }
    }

    /// Toggle full detail for every collapsed region (tool groups and reasoning
    /// blocks): collapse all when all are already expanded, else expand all and
    /// scroll the most-recent one into view.
    fn toggle_regions(&mut self) {
        let all: Vec<usize> = self
            .groups
            .iter()
            .map(|g| g.idx)
            .chain(self.reasoning_blocks.iter().map(|r| r.idx))
            .chain(self.subagent_blocks.iter().map(|b| b.idx))
            .collect();
        // Ctrl-O also unfolds every collapsed trace (finished runs and the
        // active fold), so one keystroke opens both the folds and the per-row
        // detail.
        let mut trace_starts: Vec<usize> = self.trace_runs().iter().map(|r| r.start).collect();
        if let Some(run) = self.active_fold() {
            trace_starts.push(run.start);
        }
        if all.is_empty() && trace_starts.is_empty() {
            return;
        }
        let fully_open = all.iter().all(|i| self.expanded.contains(i))
            && trace_starts.iter().all(|s| self.expanded_traces.contains(s));
        if fully_open {
            self.expanded.clear();
            self.expanded_traces.clear();
            self.reveal = None;
        } else {
            self.expanded = all.iter().copied().collect();
            self.expanded_traces = trace_starts.iter().copied().collect();
            // The regions sit above the answer that follows; scroll the latest
            // into view rather than staying pinned to the bottom.
            self.reveal = all.iter().copied().max();
        }
    }

    /// Whether transcript row `idx` is currently drawn as a folded trace header
    /// (a finished trace start or the active fold's start, not expanded), so a
    /// click there unfolds the trace rather than toggling that row's own detail.
    fn is_folded_trace_start(&self, idx: usize) -> bool {
        if self.expanded_traces.contains(&idx) {
            return false;
        }
        let last_answer = self.last_answer_idx();
        let finished = self
            .trace_runs()
            .iter()
            .any(|r| r.start == idx && last_answer.is_some_and(|a| r.end < a));
        finished || self.active_fold().is_some_and(|r| r.start == idx)
    }

    /// Toggle a single collapsed region by its transcript row index (a click on
    /// its summary row); no-op if `idx` isn't an expandable region.
    fn toggle_region(&mut self, idx: usize) {
        let is_region = self.groups.iter().any(|g| g.idx == idx)
            || self.reasoning_blocks.iter().any(|r| r.idx == idx)
            || self.subagent_blocks.iter().any(|b| b.idx == idx)
            || self.tool_group.as_ref().is_some_and(|g| g.idx == idx);
        if !is_region {
            return;
        }
        if !self.expanded.remove(&idx) {
            self.expanded.insert(idx);
        }
    }

    fn input_clear(&mut self) {
        self.input.clear();
        self.cursor = 0;
        self.reset_slash_hint();
        self.path_hints.clear();
        self.path_hint_selected = 0;
        self.reset_recall();
    }

    /// Leave recall: the next Up starts again from the newest entry.
    fn reset_recall(&mut self) {
        self.recall_pos = None;
    }

    /// Record a submitted line for recall, skipping a repeat of the newest entry.
    fn record_submitted(&mut self, text: &str) {
        if self.input_history.last().map(String::as_str) != Some(text) {
            self.input_history.push(text.to_string());
        }
        self.reset_recall();
    }

    /// Record a typed-but-never-submitted draft into recall history, so a
    /// Ctrl-C that wipes the composer is recoverable with Up. Same dedupe and
    /// recall-reset rules as `record_submitted`; a blank draft is not worth a
    /// history slot.
    fn record_draft(&mut self) {
        if self.input.trim().is_empty() {
            return;
        }
        let text = self.input.clone();
        self.record_submitted(&text);
    }

    /// Replace the buffer with a recalled entry, caret at the end.
    fn set_input(&mut self, text: String) {
        self.input = text;
        self.cursor = self.input.len();
        self.reset_slash_hint();
        self.path_hints.clear();
        self.path_hint_selected = 0;
    }

    /// Up: step back through submitted messages. Recall only starts on an empty
    /// buffer, so Up still scrolls the transcript while something is typed;
    /// once recalling, it keeps stepping even though the buffer is now full.
    /// Returns false when the key should fall through to scrollback.
    fn recall_prev(&mut self) -> bool {
        if self.input_history.is_empty() {
            return false;
        }
        match self.recall_pos {
            Some(pos) => {
                let next = pos.saturating_sub(1);
                self.recall_pos = Some(next);
                self.set_input(self.input_history[next].clone());
            }
            None => {
                if !self.input.is_empty() {
                    return false;
                }
                let last = self.input_history.len() - 1;
                self.recall_pos = Some(last);
                self.set_input(self.input_history[last].clone());
            }
        }
        true
    }

    /// Down: step forward through recalled messages; past the newest, the
    /// composer returns to an empty new message (recall only ever starts from
    /// an empty buffer, so there is no draft to restore). Returns false when
    /// not recalling, so Down still scrolls the transcript.
    fn recall_next(&mut self) -> bool {
        let Some(pos) = self.recall_pos else {
            return false;
        };
        if pos + 1 < self.input_history.len() {
            self.recall_pos = Some(pos + 1);
            self.set_input(self.input_history[pos + 1].clone());
        } else {
            self.input_clear();
        }
        true
    }

    fn input_insert(&mut self, c: char) {
        // Tab must never be inserted as a literal character; some terminals
        // deliver it as KeyCode::Char('\t') instead of KeyCode::Tab.
        if c == '\t' {
            return;
        }
        self.input.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        // IME bursts can desync crossterm so an SGR mouse report arrives as
        // characters. Drop a completed (or prefix-truncated) report at the
        // caret rather than leaving `65;50;42M` in the composer.
        drain_trailing_sgr_mouse_reports(&mut self.input, &mut self.cursor, true);
        self.reset_slash_hint();
        // Refresh path hints on any character edit
        self.refresh_path_hints();
    }

    /// Insert `text` at the caret in one edit (pasted text): one string insert
    /// and one hint refresh instead of one per character.
    fn input_insert_str(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.input.insert_str(self.cursor, text);
        self.cursor += text.len();
        drain_trailing_sgr_mouse_reports(&mut self.input, &mut self.cursor, false);
        self.reset_slash_hint();
        self.refresh_path_hints();
    }

    /// Delete the char before the caret (Backspace).
    fn input_backspace(&mut self) {
        if let Some(prev) = self.input[..self.cursor].chars().next_back() {
            self.cursor -= prev.len_utf8();
            self.input.remove(self.cursor);
        }
        self.reset_slash_hint();
        self.refresh_path_hints();
    }

    /// Delete the char at the caret (Delete); caret stays put.
    fn input_delete(&mut self) {
        if self.cursor < self.input.len() {
            self.input.remove(self.cursor);
        }
        self.reset_slash_hint();
        self.refresh_path_hints();
    }

    /// Reset hint selection and un-dismiss so an edited buffer re-shows the popup.
    fn reset_slash_hint(&mut self) {
        self.slash_selected = 0;
        self.slash_dismissed = false;
        self.path_hint_dismissed = false;
        self.slash_matches_cache.replace(None);
    }

    fn refresh_slash_catalog(&mut self) {
        self.slash_catalog = SlashCatalog::load(&self.project_root);
        self.slash_matches_cache.replace(None);
    }

    /// Slash commands and installed project skills whose name prefixes the
    /// current buffer, or empty when the popup should not show: not idle,
    /// buffer isn't a bare `/name` token (no whitespace yet), the popup was
    /// Esc-dismissed, or nothing matches. Skills honor the `[skills].enabled`
    /// whitelist and the `user-invocable` frontmatter flag: the popup offers
    /// exactly what the human may fire, which is a subset of what the model
    /// sees via `skill_list`.
    fn slash_matches(&self) -> Vec<SlashMatch> {
        if self.status != Status::Idle
            || self.slash_dismissed
            || !self.input.starts_with('/')
            || self.input.chars().any(char::is_whitespace)
        {
            return Vec::new();
        }
        if let Some((input, matches)) = self.slash_matches_cache.borrow().as_ref() {
            if input == &self.input {
                return matches.clone();
            }
        }
        let query: Vec<char> = self
            .input
            .trim_start_matches('/')
            .chars()
            .map(|c| c.to_ascii_lowercase())
            .collect();
        let mut out: Vec<SlashMatch> = SLASH_COMMANDS
            .iter()
            .filter(|c| slash_match_score(&query, c.name).is_some())
            .map(SlashMatch::Command)
            .collect();
        // A command wins a name collision: a skill named `cancel` is dropped
        // from the short form (it could never run - the command arm wins) but
        // stays reachable via its unambiguous `/skill:cancel` form.
        let taken: std::collections::HashSet<String> = out
            .iter()
            .filter_map(|m| match m {
                SlashMatch::Command(c) => Some(c.name.to_string()),
                SlashMatch::PluginCommand { name, .. } => Some(name.clone()),
                SlashMatch::Skill { .. } => None,
            })
            .collect();
        let skill_colon = self.input.starts_with("/skill:");
        let command_colon = self.input.starts_with("/command:");
        let enabled = crate::core::agent::project::load_agent_config(&self.project_root)
            .ok()
            .map(|c| c.skills.enabled)
            .unwrap_or_default();
        // Plugin commands sit between built-ins and skills in precedence.
        // Short-form ownership: a command's plain name is claimed by the
        // command - a skill of the same name loses its short form (explicit
        // `/command:` and `/skill:` forms always stay).
        let commands = &self.slash_catalog.commands;
        let mut command_plain_counts: std::collections::HashMap<&str, usize> =
            std::collections::HashMap::new();
        let mut command_owned: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for cmd in commands {
            if !SlashCatalog::command_enabled(cmd, &enabled) {
                continue;
            }
            command_owned.insert(cmd.name.as_str());
            *command_plain_counts.entry(cmd.name.as_str()).or_insert(0) += 1;
        }
        for cmd in commands {
            if !SlashCatalog::command_enabled(cmd, &enabled) {
                continue;
            }
            if !command_colon {
                // Short form: built-in wins, ambiguity drops the form.
                if taken.contains(&format!("/{}", cmd.name))
                    || command_plain_counts
                        .get(cmd.name.as_str())
                        .copied()
                        .unwrap_or(0)
                        > 1
                {
                    continue;
                }
            }
            let name = if command_colon {
                format!("/command:{}:{}", cmd.plugin, cmd.name)
            } else {
                format!("/{}", cmd.name)
            };
            if slash_match_score(&query, &name).is_some()
                && (command_colon || !taken.contains(&name))
            {
                out.push(SlashMatch::PluginCommand {
                    name,
                    description: cmd.description.clone(),
                    hints: cmd.hints.clone(),
                });
            }
        }
        // User-invocable skills only: `user-invocable: false` skills stay out
        // of the human's popup (the agent can still fire them via skill_read).
        let catalog = &self.slash_catalog.skills;
        // Short-form ownership: a project skill owns its plain name; a plain
        // name shared by two plugins is ambiguous, so everyone loses the short
        // form (the explicit `/skill:<plugin>:<name>` form always stays).
        let mut project_names: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut plugin_plain_counts: std::collections::HashMap<&str, usize> =
            std::collections::HashMap::new();
        for meta in catalog {
            if !SlashCatalog::skill_enabled(meta, &enabled) {
                continue;
            }
            if meta.plugin.is_none() {
                project_names.insert(meta.name.as_str());
            } else {
                let plain = meta
                    .name
                    .rsplit_once(':')
                    .map(|(_, s)| s)
                    .unwrap_or(&meta.name);
                *plugin_plain_counts.entry(plain).or_insert(0) += 1;
            }
        }
        let mut seen_short: std::collections::HashSet<String> = std::collections::HashSet::new();
        for meta in catalog {
            if !SlashCatalog::skill_enabled(meta, &enabled) {
                continue;
            }
            if meta.plugin.is_some() {
                let plain = meta
                    .name
                    .rsplit_once(':')
                    .map(|(_, s)| s)
                    .unwrap_or(&meta.name);
                if !skill_colon {
                    // Short form: command wins, project wins, ambiguity drops.
                    if taken.contains(&format!("/{plain}"))
                        || command_owned.contains(plain)
                        || project_names.contains(plain)
                        || plugin_plain_counts.get(plain).copied().unwrap_or(0) > 1
                        || !seen_short.insert(plain.to_string())
                    {
                        continue;
                    }
                }
            } else if !skill_colon
                && (!seen_short.insert(meta.name.clone())
                    || command_owned.contains(meta.name.as_str()))
            {
                continue;
            }
            let name = if skill_colon {
                format!("/skill:{}", meta.name)
            } else {
                let plain = meta
                    .plugin
                    .as_ref()
                    .map(|_| {
                        meta.name
                            .rsplit_once(':')
                            .map(|(_, s)| s)
                            .unwrap_or(&meta.name)
                    })
                    .unwrap_or(&meta.name);
                format!("/{plain}")
            };
            if slash_match_score(&query, &name).is_some() && (skill_colon || !taken.contains(&name))
            {
                out.push(SlashMatch::Skill {
                    name,
                    description: meta.description.clone(),
                });
            }
        }
        // Best match first: rank by fuzzy score, keeping collision/precedence
        // order (commands before plugin commands before skills) on ties.
        out.sort_by(|a, b| {
            let sa = slash_match_score(&query, a.name()).unwrap_or(0);
            let sb = slash_match_score(&query, b.name()).unwrap_or(0);
            sb.cmp(&sa)
        });
        self.slash_matches_cache
            .replace(Some((self.input.clone(), out.clone())));
        out
    }

    /// Move the hint selection, wrapping within the current match count.
    fn slash_move(&mut self, delta: isize) {
        let len = self.slash_matches().len();
        if len == 0 {
            return;
        }
        let cur = self.slash_selected.min(len - 1) as isize;
        self.slash_selected = (cur + delta).rem_euclid(len as isize) as usize;
    }

    /// Fill the buffer with the highlighted command or skill name plus a
    /// trailing space, ready for arguments; the space hides the popup via
    /// `slash_matches`.
    fn accept_slash(&mut self) {
        let matches = self.slash_matches();
        if matches.is_empty() {
            return;
        }
        let name = matches[self.slash_selected.min(matches.len() - 1)].name();
        self.input = format!("{name} ");
        self.cursor = self.input.len();
        self.slash_selected = 0;
    }

    /// Extract the current `@query` from the input buffer, if any.
    /// Returns `None` when the cursor is not inside or immediately after
    /// a `@`-prefixed token (no space since the `@`), or when the `@` does
    /// not start a token (e.g. `user@host` is not a file reference).
    ///
    /// Supports quoted references: `@"path with spaces"` - the query is the
    /// text between the quotes, and the closing quote is optional (the user
    /// may still be typing).
    fn path_hint_query(&self) -> Option<String> {
        let before = &self.input[..self.cursor];
        let at_idx = path_refs::last_ref_start(before)?;
        let after_at = &before[at_idx + 1..];

        // Quoted reference: @"query..."
        if let Some(inner) = after_at.strip_prefix('"') {
            // If the cursor is right after the opening quote, return empty query.
            if inner.is_empty() {
                return Some(String::new());
            }
            // Find the closing quote within the typed text.
            if let Some(close) = inner.find('"') {
                // Cursor is inside or at the closing quote - extract the query.
                return Some(inner[..close].to_string());
            }
            // No closing quote yet - the user is still typing inside quotes.
            return Some(inner.to_string());
        }

        if after_at.contains(' ') {
            return None; // space after @ means the token ended
        }
        if after_at.is_empty() {
            return Some(String::new());
        }
        Some(after_at.to_string())
    }

    /// An edit happened: note that the hints need refreshing. Cheap -- the
    /// directory search itself is [`App::take_path_hint_request`] plus
    /// [`search_path_hints`], run off the loop once per tick. Clearing is
    /// immediate, so a popup never outlives its `@` token.
    fn refresh_path_hints(&mut self) {
        if self.path_hint_dismissed || self.status != Status::Idle || self.path_hint_query().is_none() {
            self.path_hints.clear();
            self.path_hints_dirty = false;
            self.path_hint_gen += 1;
            return;
        }
        self.path_hints_dirty = true;
        self.path_hint_gen += 1;
    }

    /// The search an edit is owed, if any: `(generation, root, query)`. Taking
    /// it clears the flag, so a burst of edits becomes one search per tick.
    fn take_path_hint_request(&mut self) -> Option<(u64, PathBuf, String)> {
        if !std::mem::take(&mut self.path_hints_dirty) {
            return None;
        }
        let query = self.path_hint_query()?;
        Some((self.path_hint_gen, self.work_root().to_path_buf(), query))
    }

    /// Install a finished search, unless the buffer has moved on since.
    fn apply_path_hints(&mut self, generation: u64, items: Vec<PathHintItem>) {
        if generation != self.path_hint_gen || self.path_hint_dismissed || self.status != Status::Idle {
            return;
        }
        self.path_hints = items;
        self.path_hint_selected = 0;
    }

    /// Search now and install the result (tests, and callers with no loop).
    #[cfg(test)]
    fn flush_path_hints(&mut self) {
        if let Some((generation, root, query)) = self.take_path_hint_request() {
            let items = search_path_hints(&root, &query);
            self.apply_path_hints(generation, items);
        }
    }

    /// Accept the highlighted path hint: replace the `@query` token with the
    /// selected path. Quoted references (`@"query"`) are replaced with the
    /// quoted form (`@"selected/path"`).
    fn accept_path_hint(&mut self) {
        if self.path_hints.is_empty() {
            return;
        }
        let sel = self.path_hint_selected.min(self.path_hints.len() - 1);
        let selected = &self.path_hints[sel];
        let before = &self.input[..self.cursor];
        let at_idx = match path_refs::last_ref_start(before) {
            Some(i) => i,
            None => return,
        };
        let after_at = &before[at_idx + 1..];
        let after = &self.input[self.cursor..];

        // Quoted reference: replace @"..." with @"selected/path"
        if after_at.starts_with('"') {
            // rest[0] is the opening quote; the closing quote may be past the
            // cursor. A missing closing quote means the user is still typing
            // the token, so delete through the end of the input.
            let rest = &self.input[at_idx + 1..];
            let full_len = rest[1..].find('"').map(|i| i + 2).unwrap_or(rest.len());
            let replacement = format!("@\"{}\"", selected.path);
            let new_input = format!(
                "{}{}{}",
                &self.input[..at_idx],
                replacement,
                &self.input[at_idx + 1 + full_len..]
            );
            self.input = new_input;
            self.cursor = at_idx + replacement.len();
        } else {
            // Replace the `@query` token but keep the `@` marker so the result
            // stays a reference, and append `/` for directories so the user
            // can keep drilling into them.
            let marker = "@";
            let path = &selected.path;
            let trailing = if selected.is_dir { "/" } else { "" };
            // A path with whitespace or a character the unquoted form stops at
            // would be cut short, so it goes in quotes. A directory keeps the
            // quote open so the user can keep drilling in.
            let needs_quotes = path
                .chars()
                .any(|c| c.is_whitespace() || ",;:!?'\"`[](){}<>".contains(c));
            let replacement = if needs_quotes {
                let close = if selected.is_dir { "" } else { "\"" };
                format!("{marker}\"{path}{trailing}{close}")
            } else {
                format!("{marker}{path}{trailing}")
            };
            let new_input = format!("{}{}{}", &self.input[..at_idx], replacement, after);
            self.input = new_input;
            self.cursor = at_idx + replacement.len();
        }
        self.path_hints.clear();
        self.path_hint_dismissed = false;
    }

    fn path_hint_move(&mut self, delta: isize) {
        if self.path_hints.is_empty() {
            return;
        }
        let len = self.path_hints.len();
        let cur = self.path_hint_selected.min(len - 1) as isize;
        self.path_hint_selected = (cur + delta).rem_euclid(len as isize) as usize;
    }

    /// True when the path-hint popup has entries to show.
    fn has_path_hints(&self) -> bool {
        if self.path_hint_dismissed || self.status != Status::Idle {
            return false;
        }
        self.path_hint_query().is_some() && !self.path_hints.is_empty()
    }

    fn cursor_left(&mut self) {
        if let Some(prev) = self.input[..self.cursor].chars().next_back() {
            self.cursor -= prev.len_utf8();
        }
    }

    fn cursor_right(&mut self) {
        if let Some(next) = self.input[self.cursor..].chars().next() {
            self.cursor += next.len_utf8();
        }
    }

    /// Cut `start..end` out of the buffer and leave the caret at `start`.
    /// Every kill below funnels through here so none of them can forget the
    /// hint refresh that an edit owes the popups.
    fn delete_span(&mut self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        self.input.replace_range(start..end, "");
        self.cursor = start;
        self.reset_slash_hint();
        self.refresh_path_hints();
    }

    fn cursor_word_left(&mut self) {
        self.cursor = prev_word_start(&self.input, self.cursor);
    }

    fn cursor_word_right(&mut self) {
        self.cursor = next_word_end(&self.input, self.cursor);
    }

    fn cursor_line_start(&mut self) {
        self.cursor = line_bounds(&self.input, self.cursor).0;
    }

    fn cursor_line_end(&mut self) {
        self.cursor = line_bounds(&self.input, self.cursor).1;
    }

    /// Alt+Backspace / Ctrl+Backspace.
    fn delete_word_left(&mut self) {
        let start = prev_word_start(&self.input, self.cursor);
        self.delete_span(start, self.cursor);
    }

    /// Ctrl-W, on the wider whitespace-delimited word.
    fn delete_unix_word_left(&mut self) {
        let start = prev_unix_word_start(&self.input, self.cursor);
        self.delete_span(start, self.cursor);
    }

    /// Alt+D / Ctrl+Delete.
    fn delete_word_right(&mut self) {
        let end = next_word_end(&self.input, self.cursor);
        self.delete_span(self.cursor, end);
    }

    /// Ctrl-U (and Cmd+Backspace).
    fn delete_to_line_start(&mut self) {
        let start = line_bounds(&self.input, self.cursor).0;
        self.delete_span(start, self.cursor);
    }

    /// Ctrl-K. Already at the end of a line, it swallows the newline instead of
    /// doing nothing, so repeated presses join the buffer up as readline does.
    fn delete_to_line_end(&mut self) {
        let end = line_bounds(&self.input, self.cursor).1;
        if end == self.cursor {
            self.delete_span(self.cursor, (self.cursor + 1).min(self.input.len()));
        } else {
            self.delete_span(self.cursor, end);
        }
    }

    /// Ctrl-T: swap the chars either side of the caret and step past the pair.
    /// At the end of the buffer there is nothing after the caret, so the last
    /// two chars swap in place, matching readline.
    fn transpose_chars(&mut self) {
        let before = &self.input[..self.cursor];
        let Some(prev) = before.chars().next_back() else {
            return;
        };
        let (first, second, start, end) = match self.input[self.cursor..].chars().next() {
            Some(next) => (
                prev,
                next,
                self.cursor - prev.len_utf8(),
                self.cursor + next.len_utf8(),
            ),
            None => {
                let head = &before[..before.len() - prev.len_utf8()];
                let Some(prev2) = head.chars().next_back() else {
                    return;
                };
                (prev2, prev, head.len() - prev2.len_utf8(), self.cursor)
            }
        };
        self.input
            .replace_range(start..end, &format!("{second}{first}"));
        self.cursor = end;
        self.reset_slash_hint();
        self.refresh_path_hints();
    }

    /// Advance the spinner by however many whole `SPINNER_ADVANCE_MS` frames
    /// have elapsed since the last advance (0 if under one frame, >1 on catch-up
    /// after a stalled tick). The baseline moves forward by whole frames only so
    /// leftover sub-frame milliseconds are not lost across ticks.
    fn advance_spinner(&mut self, now: Instant) {
        let elapsed = now.duration_since(self.last_spinner_advance).as_millis() as u64;
        let frames = (elapsed / SPINNER_ADVANCE_MS) as usize;
        if frames > 0 {
            self.spinner_frame = self.spinner_frame.wrapping_add(frames);
            self.last_spinner_advance += Duration::from_millis(frames as u64 * SPINNER_ADVANCE_MS);
        }
    }

    /// `!cmd`: run a shell command directly. It goes through the agent's own
    /// `bash` path (same sandbox, same approvals), as the first step of a run
    /// that makes no model call; the command and its output join the thread.
    fn submit_shell(&mut self, command: &str) {
        if command.is_empty() {
            self.note("usage: !<command>");
            return;
        }
        if self.status != Status::Idle {
            self.note("!command runs only while idle");
            return;
        }
        self.scripted_command = Some(command.to_string());
        self.submit_user_text(format!("!{command}"), true);
        if self.status != Status::Running {
            // Refused (not signed in): nothing will consume it.
            self.scripted_command = None;
        }
    }

    fn submit_user(&mut self, text: String) {
        self.submit_user_text(text, true)
    }

    /// Start a user turn whose text the model sees but the transcript never
    /// shows. For commands that expand into a long canned prompt (`/init`): the
    /// command's own note already says what is happening, and pasting the
    /// prompt body into the transcript is noise. Hidden turns leave
    /// `pending_images` staged for the user's next real message rather than
    /// attaching them to a prompt they did not write.
    fn submit_user_hidden(&mut self, text: String) {
        self.submit_user_text(text, false)
    }

    fn submit_user_text(&mut self, text: String, display: bool) {
        if self.model.is_empty() {
            self.note("not signed in — run /login to choose a provider first");
            return;
        }
        let images = if display {
            std::mem::take(&mut self.pending_images)
        } else {
            Vec::new()
        };
        let names: Vec<String> = images.iter().map(|i| i.name.clone()).collect();
        // Resolve @path file references before sending
        let (clean_text, injected_contents) =
            path_refs::resolve_references(&text, self.work_root());
        let final_text = if injected_contents.is_empty() {
            clean_text
        } else {
            format!("{clean_text}\n\n---\nReferenced file contents:\n\n{injected_contents}")
        };
        let invocation =
            crate::core::agent::skills::parse_invocation(&text).and_then(|(name, args)| {
                crate::core::agent::skills::build_invocation_message(
                    &self.project_root,
                    &name,
                    &args,
                )
                .ok()
                .map(|(message, description)| (name, args, message, description))
            });
        let model_text = invocation
            .as_ref()
            .map_or(final_text.as_str(), |(_, _, message, _)| message.as_str());
        let pending = PendingMessage {
            message: build_user_message(model_text, &images),
            invocation: invocation.map(|(name, args, _, description)| (name, args, description)),
            text,
            images: names,
            display,
            run_mode: Some(self.run_mode),
            fresh_context: false,
        };
        if self.status == Status::Running {
            self.message_queue.push_back(pending);
            self.note(&format!(
                "message pending for next agent step ({} pending)",
                self.message_queue.len()
            ));
            return;
        }
        self.start_pending_message(pending);
    }

    fn record_pending_message(&mut self, pending: PendingMessage) {
        self.history.push(pending.message);
        if pending.display {
            let text = if let Some((name, args, description)) = pending.invocation {
                self.push_invocation_row(&format!("[skill:{name}]"), &args, &description);
                format!("[skill:{name}] {args}")
            } else {
                self.push_user_line(&pending.text, &pending.images);
                pending.text
            };
            self.display_log.push(DisplayEntry::User {
                text,
                images: pending.images,
            });
        }
    }

    fn start_pending_message(&mut self, pending: PendingMessage) {
        if pending.fresh_context {
            // Execute-in-fresh-context: the plan text in this message is all the
            // model gets. The staged todos live outside the history and stay.
            self.history.clear();
            self.tokens = 0;
            self.note("◈ context cleared; implementing from the plan alone");
        }
        self.ensure_base_snapshot();
        self.record_pending_message(pending);
        self.begin_turn();
        // A fresh user turn is new context: allow the next boundary to remind
        // again even if the open work is unchanged (dedup is "twice in a row"),
        // and rearm the per-cycle reminder budget. A reminder's own follow-up
        // turn (`submit_reminder`, below) deliberately does NOT reset these --
        // the count must persist across the very continuation it triggers, or
        // the cap could never actually be reached.
        self.last_todo_reminder = None;
        self.reminder_count = 0;
        self.reminder_awaiting_progress = false;
        // A fresh turn gets a fresh overflow-recovery budget: the previous
        // turn's failures say nothing about this one's size.
        self.overflow_retries = 0;
        self.want_start = true;
        self.persist();
    }

    /// While a turn runs, queue a skill or command invocation like a chat
    /// message instead of pushing it into a history the run will overwrite.
    /// Returns whether it was queued.
    fn queue_invocation(&mut self, name: &str, args: &str, msg: &str, description: &str) -> bool {
        if self.status != Status::Running {
            return false;
        }
        let args = args.trim();
        self.message_queue.push_back(PendingMessage {
            text: format!("/{name} {args}").trim_end().to_string(),
            message: serde_json::json!({ "role": "user", "content": msg }),
            images: Vec::new(),
            display: true,
            invocation: Some((name.to_string(), args.to_string(), description.to_string())),
            run_mode: Some(self.run_mode),
            fresh_context: false,
        });
        self.note(&format!(
            "message pending for next agent step ({} pending)",
            self.message_queue.len()
        ));
        true
    }

    /// Invoke an enabled project skill by name: load its full instructions and
    /// submit them as the user message so the agent follows the procedure
    /// directly (no `skill_read` round trip). The transcript shows one compact
    /// `[skill:<name>]` row with the user's args, never the body text. `args`
    /// are threaded into the message like a command's arguments. Returns false
    /// when the skill is unknown or disabled, leaving the caller to treat the
    /// text as a plain message. Message assembly lives in
    /// `skills::build_invocation_message` so other UIs (desktop/web) invoke
    /// skills with identical semantics.
    fn dispatch_skill(&mut self, name: &str, args: &str) -> bool {
        let root = &self.project_root;
        let (msg, description) =
            match crate::core::agent::skills::build_invocation_message(root, name, args) {
                Ok(pair) => pair,
                Err(_) => return false,
            };
        // Handled, but no turn without a provider: the same guard a plain
        // message gets in `submit_user_text` (#141).
        if self.model.is_empty() {
            self.note("not signed in — run /login to choose a provider first");
            return true;
        }
        if self.queue_invocation(name, args, &msg, &description) {
            return true;
        }
        self.ensure_base_snapshot();
        let args = args.trim();
        self.history
            .push(serde_json::json!({ "role": "user", "content": msg }));
        self.push_invocation_row(&format!("[skill:{name}]"), args, &description);
        self.begin_turn();
        // A fresh user turn is new context: same reminder reset as submit_user.
        self.last_todo_reminder = None;
        self.reminder_count = 0;
        self.reminder_awaiting_progress = false;
        self.want_start = true;
        self.persist();
        true
    }

    /// Invoke a plugin command by name: substitute `$ARGUMENTS`/`$N`
    /// placeholders into its prompt template and submit the result as the
    /// user message, so the agent follows the procedure directly. The
    /// transcript shows one compact `[command:<name>]` row with the user's
    /// args, never the template text. Returns false when the command is
    /// unknown, leaving the caller to fall through to skills.
    fn dispatch_command(&mut self, name: &str, args: &str) -> bool {
        let root = &self.project_root;
        let (msg, description) =
            match crate::core::agent::plugin_commands::build_message(root, name, args) {
                Ok(pair) => pair,
                Err(_) => return false,
            };
        // Handled, but no turn without a provider: the same guard a plain
        // message gets in `submit_user_text` (#141).
        if self.model.is_empty() {
            self.note("not signed in — run /login to choose a provider first");
            return true;
        }
        if self.queue_invocation(name, args, &msg, &description) {
            return true;
        }
        self.ensure_base_snapshot();
        let args = args.trim();
        self.history
            .push(serde_json::json!({ "role": "user", "content": msg }));
        self.push_invocation_row(&format!("[command:{name}]"), args, &description);
        self.begin_turn();
        // A fresh user turn is new context: same reminder reset as submit_user.
        self.last_todo_reminder = None;
        self.reminder_count = 0;
        self.reminder_awaiting_progress = false;
        self.want_start = true;
        self.persist();
        true
    }

    /// Inject a hidden todo reminder and continue with one more model turn. The
    /// reminder text enters the conversation (so the model sees it) but renders
    /// as a dim system note, never a user-authored transcript row -- and is
    /// marked, so `is_user_turn` keeps it out of the rewind picker, recall and
    /// checkpoint keys.
    fn submit_reminder(&mut self, text: String) {
        crate::core::agent::reminder::attach(&mut self.history, &text);
        self.note("todo reminder — unfinished work, continuing");
        self.begin_turn();
        self.want_start = true;
        self.persist();
    }

    /// Reminder policy (spec: one bounded reminder at a clean turn boundary).
    /// Fires at most one hidden reminder when open work remains and the assistant
    /// yielded as if finished. Suppressed while an ask/permission is pending, a
    /// goal/plan transition already queued the next turn, another message is
    /// armed, the agent already updated todos this turn, the assistant's own
    /// final text is itself asking the user something, a prior reminder is
    /// still unanswered, or the per-cycle reminder budget is spent. A todo
    /// mutation that failed this turn queues one retry reminder instead.
    fn maybe_inject_todo_reminder(&mut self, normal: bool, no_answer: bool, answer: &str) {
        /// Reminders fired per prompt cycle before the policy goes quiet, even
        /// if the open-work summary keeps changing slightly (the same-summary
        /// dedup below only catches an unchanged summary, not a moving one).
        const TODO_REMINDER_MAX: u32 = 3;
        // A goal/plan continuation or a queued message already owns the next
        // turn; a pending ask/permission blocks the boundary; plan mode is a
        // read-only exploration where todos are only staged for handoff.
        if self.want_start
            || self.goal_eval_pending
            || self.goal_evaluating
            || self.run_mode == crate::core::agent::plan::RunMode::Plan
            || !self.ask_queue.is_empty()
        {
            return;
        }
        let failed = self.todo_call_this_turn && !self.todo_ok_this_turn;
        if !failed {
            // The agent actively managed todos this turn (or the turn ended
            // abnormally/emptily): don't nag.
            if self.todo_call_this_turn || !normal || no_answer {
                return;
            }
        }
        // The assistant may be legitimately waiting on the user (a plain-text
        // question, or a "let me know"/"please confirm" cue) rather than
        // idling mid-task -- nudging "keep working" here would talk over its
        // own question.
        if assistant_is_awaiting_user_answer(answer) {
            return;
        }
        // A prior reminder hasn't seen any follow-up action yet, or the
        // per-cycle budget is already spent: stay silent rather than pile on.
        if self.reminder_awaiting_progress || self.reminder_count >= TODO_REMINDER_MAX {
            return;
        }
        let Some(summary) = self.todos.open_summary() else {
            return;
        };
        // Dedup: the same open-work summary never reminds twice in a row.
        if self.last_todo_reminder.as_deref() == Some(summary.as_str()) {
            return;
        }
        let text = if failed {
            format!(
                "Reminder: your last todo update failed and unfinished work remains:\n{summary}\n\nRetry the update or continue the work; call `todo` to record progress."
            )
        } else {
            format!(
                "Reminder: unfinished todos remain:\n{summary}\n\nContinue the work, or call `todo` to mark items done/abandoned."
            )
        };
        self.last_todo_reminder = Some(summary);
        self.reminder_count += 1;
        self.reminder_awaiting_progress = true;
        self.submit_reminder(text);
    }

    /// Dequeue the next message from the queue and submit it. Called after
    /// `on_done` / `on_error` / `cancel_run` to continue processing.
    fn dequeue_next(&mut self) {
        if self.message_queue.is_empty() {
            return;
        }
        let next = self
            .message_queue
            .pop_front()
            .expect("checked non-empty above");
        if !next.text.is_empty() || !next.images.is_empty() {
            self.note(&format!(
                "⏩ dequeuing next message ({} remaining)",
                self.message_queue.len()
            ));
            self.start_pending_message(next);
        }
    }

    fn steer_run(&mut self, request: SteeringRequest) {
        // A plan-mode transition needs a fresh run with rebuilt tool policy.
        // Dedicated permission/ask replies remain separate from chat input.
        let count = if self.pending_queue.is_empty() && self.ask_queue.is_empty() {
            self.message_queue
                .iter()
                .take_while(|m| {
                    m.run_mode.is_none_or(|mode| mode == request.run_mode) && !self.want_start
                })
                .count()
        } else {
            0
        };
        let messages = self
            .message_queue
            .iter()
            .take(count)
            .map(|m| m.message.clone())
            .collect();
        if request.reply.send(messages).is_err() || count == 0 {
            return;
        }
        self.flush_assistant();
        self.finalize_tool_group();
        self.history = request.messages;
        for _ in 0..count {
            let pending = self
                .message_queue
                .pop_front()
                .expect("counted pending messages");
            self.record_pending_message(pending);
        }
        self.last_todo_reminder = None;
        self.reminder_count = 0;
        self.reminder_awaiting_progress = false;
        self.persist();
    }

    /// Render a user turn: the prompt line, then one dotted connector row per
    /// attached image ending in an `[IMAGE]` label (basename when known).
    fn push_user_line(&mut self, text: &str, images: &[String]) {
        self.gap(Kind::User);
        // A `System` row rather than a `Line`: a pasted or shift-entered message
        // carries its own newlines, and a single `Line` renders those as blank
        // cells in one run-on row.
        self.push_row(RowKind::System {
            glyph: "",
            cont: "",
            gutter: Style::new().light_magenta().bold(),
            body: vec![Span::styled(
                text.to_string(),
                Style::new().bold().fg(user_bubble_fg()),
            )],
            bg: Some(user_bubble_bg()),
        });
        for name in images {
            let label = if name.is_empty() {
                "[IMAGE]".to_string()
            } else {
                format!("[IMAGE] {name}")
            };
            self.push(Line::from(vec![
                Span::styled("  ┊ ", Style::new().dim()),
                Span::styled(label, Style::new().cyan()),
            ]));
        }
    }

    /// One compact transcript row for a persisted skill/command invocation:
    /// the label only, never the template body (see `super::invocation_label`).
    fn push_invocation_label(&mut self, label: String) {
        self.gap(Kind::User);
        self.push_row(RowKind::System {
            glyph: ">",
            cont: " ",
            gutter: Style::new().light_magenta().bold(),
            body: vec![Span::styled(label, Style::new().cyan().bold())],
            bg: None,
        });
    }

    /// The `> [skill:foo] <args>` row a slash invocation commits. A `System`
    /// row for the same reason as `push_user_line`: `args` is user text and can
    /// arrive pasted and multi-line, which a single `Line` renders as blank
    /// cells in one run-on row.
    fn push_invocation_row(&mut self, label: &str, args: &str, description: &str) {
        let mut body = vec![Span::styled(label.to_string(), Style::new().cyan().bold())];
        if !args.is_empty() {
            body.push(Span::raw(format!(" {args}")));
        } else if !description.is_empty() {
            body.push(Span::raw(format!(" - {description}")));
        }
        self.gap(Kind::User);
        self.push_row(RowKind::System {
            glyph: "",
            cont: "",
            gutter: Style::new().light_magenta().bold(),
            body,
            bg: Some(user_bubble_bg()),
        });
    }

    /// Stage the OS clipboard's image for the next message, noting the result.
    fn attach_clipboard_image(&mut self) {
        match clipboard_image() {
            Ok(img) => {
                let name = img.name.clone();
                self.pending_images.push(img);
                self.note(&format!(
                    "attached {name} ({} image(s) pending)",
                    self.pending_images.len()
                ));
            }
            Err(e) => self.note(&format!("no image in clipboard: {e}")),
        }
    }

    fn body(&self) -> serde_json::Value {
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": self.history,
            "max_session_tokens": self.max_session_tokens,
            "stream": true,
        });
        // Forward the per-request output cap only when configured; it reaches
        // the upstream via `copy_optional_chat_params`.
        if let Some(max) = self.max_tokens {
            body["max_tokens"] = serde_json::json!(max);
        }
        // Live plan-mode toggle: the backend reads this per turn and falls back
        // to the session default when absent. Only forwarded in Plan so normal
        // turns keep an unchanged body.
        if self.run_mode == crate::core::agent::plan::RunMode::Plan {
            body["run_mode"] =
                serde_json::to_value(self.run_mode).unwrap_or(serde_json::Value::Null);
        }
        // Only an active `/goal` forces the model to stage a todo plan; a normal
        // turn leaves that to its own judgement. Forwarded only while the goal
        // runs, so an achieved or cleared goal reverts to an unchanged body.
        if self.goal.as_ref().is_some_and(|g| g.is_active()) {
            body["goal_mode"] = serde_json::json!(true);
        }
        // Reasoning resend policy: forwarded only when the user opted out, so a
        // default session sends an unchanged body (the loop defaults to true).
        if !self.send_reasoning {
            body["send_reasoning"] = serde_json::json!(false);
        }
        // Reasoning effort: forwarded to the upstream via
        // `copy_optional_chat_params` so compatible providers (OpenAI, Gemini)
        // adjust their reasoning depth. Incompatible providers ignore it.
        body["reasoning_effort"] = serde_json::json!(self.reasoning_effort);
        body
    }

    /// Arm workspace snapshots by queuing the base capture before the first turn.
    /// No-op when the project is not a git repo or the base is already armed. The
    /// blocking `git` work runs off the render loop; the run start gates on it.
    /// Allocates the thread id up front so the snapshot ref and the persisted
    /// thread share one id.
    fn ensure_base_snapshot(&mut self) {
        if self.repo_root.is_none() || self.base_requested {
            return;
        }
        if self.thread_id.is_none() {
            self.thread_id = Some(uuid::Uuid::new_v4().to_string());
        }
        self.base_requested = true;
        self.snap_queue.push_back(SnapshotJob::Base);
    }

    /// Thread metadata persisted alongside the conversation: the base snapshot and
    /// per-turn checkpoints, so `/resume` can restore and rewind. `None` when
    /// snapshots are inactive (keeps a plain `{}` metadata block).
    fn thread_metadata(&self) -> Option<serde_json::Value> {
        // Persist metadata when snapshots, a goal, or plan mode are present; each
        // must survive restart/resume even in a non-git project (no snapshots).
        let planning = self.run_mode == crate::core::agent::plan::RunMode::Plan;
        if self.base_snapshot.is_none()
            && self.goal.is_none()
            && !planning
            && self.todos.is_empty()
            && self.forked_from.is_none()
            && self.workspace_record.is_none()
        {
            return None;
        }
        let mut meta = serde_json::Map::new();
        if let Some(workspace) = self.workspace_record.as_ref() {
            meta.insert(
                super::worktree::WORKTREE_KEY.to_string(),
                super::worktree::to_metadata(workspace),
            );
        }
        if let Some(parent) = self.forked_from.as_ref() {
            meta.insert(super::FORKED_FROM_KEY.to_string(), parent.clone());
        }
        if let Some(base) = self.base_snapshot.as_ref() {
            meta.insert("base_snapshot".to_string(), serde_json::json!(base));
            // So `flint threads delete` can drop the snapshot ref (#143).
            if let Some(repo) = self.repo_root.as_ref() {
                meta.insert(
                    super::SNAPSHOT_REPO_KEY.to_string(),
                    serde_json::json!(repo.to_string_lossy()),
                );
            }
            meta.insert(
                "checkpoints".to_string(),
                serde_json::json!(self.checkpoints),
            );
        }
        if let Some(goal) = self.goal.as_ref() {
            meta.insert(
                "goal".to_string(),
                serde_json::to_value(goal).unwrap_or(serde_json::Value::Null),
            );
        }
        // Only persisted in Plan (Normal is the default; keeps old threads clean).
        if planning {
            meta.insert(
                "run_mode".to_string(),
                serde_json::to_value(self.run_mode).unwrap_or(serde_json::Value::Null),
            );
        }
        // Persist the canonical todos so resume/branch reconstructs the list.
        if !self.todos.is_empty() {
            meta.insert(
                "todos".to_string(),
                serde_json::to_value(&self.todos).unwrap_or(serde_json::Value::Null),
            );
        }
        Some(serde_json::Value::Object(meta))
    }

    /// Queue a checkpoint of the working tree produced by the just-finished turn,
    /// keyed to the driving user message. A turn that changed no files still
    /// snapshots (its tree equals the previous), keeping the message->snapshot map
    /// complete for rewind. The blocking `git` work runs off the render loop.
    fn checkpoint_turn(&mut self) {
        if self.repo_root.is_none() || !self.base_requested {
            return;
        }
        let user_index = self
            .history
            .iter()
            .filter(|m| is_user_turn(m))
            .count()
            .saturating_sub(1);
        let preview = self
            .history
            .iter()
            .rev()
            .find(|m| is_user_turn(m))
            .map(|m| truncate_preview(&user_content_parts(&m["content"]).0))
            .unwrap_or_default();
        self.snap_queue.push_back(SnapshotJob::Checkpoint {
            user_index,
            preview,
            changed: std::mem::take(&mut self.turn_touched),
        });
    }

    /// Resolve the git inputs for the next queued snapshot from current state:
    /// `(repo, parent, message, thread_id, changed paths)`. `None` when
    /// snapshotting is unavailable (not a git repo, or no thread id yet), so the
    /// job is dropped. Changed paths are made relative to `repo`; anything
    /// outside it is dropped rather than passed to `git`.
    fn resolve_snapshot(&self, job: &SnapshotJob) -> Option<SnapshotInputs> {
        let repo = self.repo_root.clone()?;
        let id = self.thread_id.clone()?;
        match job {
            SnapshotJob::Base => Some((repo, None, "flint agent base".to_string(), id, Vec::new())),
            SnapshotJob::Checkpoint { changed, .. } => {
                let parent = self
                    .checkpoints
                    .last()
                    .map(|c| c.sha.clone())
                    .or_else(|| self.base_snapshot.clone());
                let n = self.checkpoints.len() + 1;
                let changed = changed
                    .iter()
                    .filter_map(|p| p.strip_prefix(&repo).ok().map(|p| p.to_path_buf()))
                    .collect();
                Some((repo, parent, format!("flint agent turn {n}"), id, changed))
            }
        }
    }

    /// Save the conversation to a thread on disk so it survives and appears in
    /// `/resume`. Fire-and-forget: failures surface in the status detail only.
    fn persist(&mut self) {
        if self.history.is_empty() {
            return;
        }
        // A queued background save must land first, or it could overwrite
        // this newer snapshot after the fact.
        self.flush_thread_saves();
        match super::cli_save_thread(
            &self.agent_dir,
            self.thread_id.as_deref(),
            &self.model,
            &self.history,
            self.thread_metadata(),
        ) {
            Ok(id) => {
                self.thread_id = Some(id);
                self.dump_display_log();
            }
            Err(e) => self.detail = format!("save failed: {e}"),
        }
    }

    /// `persist` off the render loop: the mid-turn save on every model step
    /// hands the snapshot to a writer thread instead of rewriting the whole
    /// history (with an fsync) inside a frame. The first save of a new thread
    /// still runs inline, because it is what assigns the thread id.
    fn persist_in_background(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let Some(id) = self.thread_id.clone() else {
            self.persist();
            return;
        };
        // Built first: `thread_metadata` borrows `self`, which the saver below
        // holds mutably.
        let job = ThreadSave {
            base: self.agent_dir.clone(),
            id,
            model: self.model.clone(),
            history: self.history.clone(),
            metadata: self.thread_metadata(),
        };
        let saver = self.thread_saver.get_or_insert_with(ThreadSaver::new);
        if let Some(err) = saver.take_error() {
            self.detail = format!("save failed: {err}");
        }
        saver.save(job);
        self.dump_display_log();
    }

    /// Wait for queued background thread saves to reach disk, surfacing the
    /// last failure in the status line.
    fn flush_thread_saves(&mut self) {
        if let Some(saver) = self.thread_saver.as_ref() {
            saver.flush();
            if let Some(err) = saver.take_error() {
                self.detail = format!("save failed: {err}");
            }
        }
    }

    /// Hand the rendered transcript to the writer thread, so a turn boundary (or
    /// a cancel) leaves a resumable journal without a frame paying for the write.
    fn dump_display_log(&mut self) {
        let Some(id) = self.thread_id.clone() else {
            return;
        };
        let path = journal::journal_path(&self.agent_dir, &id);
        self.journal_writer
            .get_or_insert_with(journal::Writer::new)
            .dump(path, self.display_log.clone());
    }

    /// Wait for queued journal dumps to reach disk (session exit, tests).
    fn join_journal(&mut self) {
        self.flush_thread_saves();
        self.thread_saver = None;
        if let Some(writer) = self.journal_writer.as_mut() {
            writer.join();
        }
        self.journal_writer = None;
    }

    /// Take `model` as the active one and re-resolve its context window, without
    /// persisting it or compacting. For paths that adopt a model the user did
    /// not just pick (resuming a thread, a fresh sign-in).
    fn adopt_model(&mut self, model: String) {
        self.model = model;
        self.refresh_context_window();
    }

    /// Switch the active model and remember it in the project's agent.toml so it
    /// persists across sessions. The context window is re-resolved for the new
    /// model immediately, and if the target window shrinks below the current
    /// usage a target-model compaction is queued before the next ordinary request.
    fn set_model(&mut self, model: String) {
        self.adopt_model(model);
        // Persistence warning preserved verbatim from the prior behaviour.
        let persistence = match super::cli_set_project_model(&self.agent_dir, &self.model) {
            Ok(()) => String::new(),
            Err(e) => format!(" (not saved: {e})"),
        };
        self.note(&format!(
            "model set to {} (context {}K, {}){}",
            self.model,
            self.context_window / 1000,
            self.context_window_source.label(),
            persistence,
        ));
        // A smaller-window target must be compacted onto before the next request:
        // run the bounded summary through the *target* model (see the chat loop,
        // which uses `app.model` for `CompactKind::Auto`).
        if self.should_auto_compact() {
            self.compact_request = Some(CompactKind::Auto);
            self.detail = format!("compacting for {}", self.model);
        }
    }

    /// Re-resolve the effective context window from the current model and the
    /// configured override. Returns whether the effective limit changed, so a
    /// caller can decide whether a compaction is now warranted. The catalog
    /// matching lives only in `model_capabilities`, never duplicated here.
    fn refresh_context_window(&mut self) -> bool {
        let resolved = crate::core::cli::model_capabilities::resolve_context_window(
            &self.model,
            self.configured_context_window,
        );
        let changed = resolved.tokens != self.context_window;
        self.context_window = resolved.tokens;
        self.context_window_source = resolved.source;
        // A window-derived session budget follows the model; one the user set
        // (flag or `[budget].max_tokens`) stays put. An unknown model's guess
        // is not a window, so it falls back to the default.
        if !self.max_session_tokens_pinned {
            self.max_session_tokens = match resolved.source {
                crate::core::cli::model_capabilities::ContextWindowSource::Fallback => {
                    super::DEFAULT_MAX_SESSION_TOKENS
                }
                _ => resolved.tokens,
            };
        }
        changed
    }
    /// Header label for the current selection: `provider/model` when the bare
    /// model id resolves to exactly one provider, so the reader can tell where
    /// it is served from (the picker already shows the pair) instead of a bare
    /// `mimo-v2.5` that could route through any of several gateways. Falls back
    /// to the raw model id when no provider is reachable or the lock is busy.
    fn header_model_label(&self) -> String {
        let Some(args) = self.args.as_ref() else {
            return self.model.clone();
        };
        if let Ok(pc) = args.provider_configs.try_lock() {
            provider_label_for_model(&self.model, &pc)
        } else {
            self.model.clone()
        }
    }

    /// Build the `/context` breakdown for the current session.
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
    #[cfg(test)]
    async fn context_report(&self) -> ContextReport {
        compute_context_report(self.context_snapshot()).await
    }
    /// Owning snapshot of the `App` state the `/context` report is shaded
    /// from, taken synchronously on the key path. The async computation runs
    /// on its own task (a spawned task cannot borrow `&App`), and specifically
    /// off the render loop: sizing the tool segment takes the MCP server lock,
    /// which a turn executing an MCP tool call holds for up to the tool-call
    /// timeout. Snapshotting here keeps that await off the key-handling path
    /// while leaving the numbers exactly what [`Self::context_report`] would
    /// have produced. The Messages segment's chars/4 estimate over the whole
    /// history is folded in synchronously (rather than cloning the history into
    /// the task) precisely so the value is identical either way.
    fn context_snapshot(&self) -> ContextSnapshot {
        ContextSnapshot {
            args: self.args.clone(),
            model: self.model.clone(),
            run_mode: self.run_mode,
            context_window: self.context_window,
            reserve_tokens: self.reserve_tokens,
            reserve_pinned: self.reserve_pinned,
            history_estimate: if self.history.is_empty() {
                0
            } else {
                estimate_token_count(&self.history)
            },
            tokens_estimated: self.tokens_estimated,
            turn_prompt_tokens: self.turn_prompt_tokens,
        }
    }
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

#[allow(clippy::too_many_arguments)]
async fn chat_loop<B: Backend>(
    terminal: &mut Terminal<B>,
    args: &Arc<OrchestrationArgs>,
    registry: &PermissionRegistry,
    ask_requests: &crate::core::agent::interaction::AskRegistry,
    app: &mut App,
    initial_task: Option<String>,
    mut mcp_task: Option<tokio::task::JoinHandle<crate::core::cli::mcp::ConnectOutcome>>,
    mcp_servers: &crate::core::state::SharedMcpServers,
) -> Result<(), String> {
    let mut current: Option<CurrentRun> = None;
    let mut ticker = tokio::time::interval(Duration::from_millis(50));
    // Active MCP servers connect in the background; gate the first run on them
    // so the model's tools (collected once per run) are ready.
    let mut mcp_ready = mcp_task.is_none();
    let mut loading_noted = false;

    // Off-loop git snapshotting: one job at a time (checkpoints must stay
    // ordered), driven from the queue `App` fills in submit_user/on_done.
    let mut snap_task: Option<tokio::task::JoinHandle<Result<String, String>>> = None;
    let mut snap_inflight: Option<SnapshotJob> = None;

    // `/login` key verification: an HTTP round trip, so it runs off the render
    // loop and the prompt keeps repainting ("verifying...") while it's in flight.
    let mut login_task: Option<
        tokio::task::JoinHandle<
            Result<crate::core::cli::auth::LoginResult, crate::core::cli::auth::LoginError>,
        >,
    > = None;

    // The browser-approval sign-in, in two off-loop halves: `begin` creates the
    // session (one round trip), then the claim polls until the user approves --
    // which can take minutes, so it must never touch the render loop.
    let mut login_begin_task: Option<
        tokio::task::JoinHandle<
            Result<super::device_auth::PendingAuth, super::device_auth::BeginError>,
        >,
    > = None;
    let mut login_claim_task: Option<
        tokio::task::JoinHandle<Result<super::tokamak::Login, String>>,
    > = None;
    // `/mcp` work that must not run on the render loop: a tool listing is a
    // round trip to the peer, and an authorization waits on a browser for up to
    // five minutes. One at a time -- the detail screen only ever asks for one.
    let mut mcp_job: Option<tokio::task::JoinHandle<McpJobDone>> = None;
    // `/context` computing the report: takes the MCP server lock (a turn
    // executing an MCP tool call holds it for up to the tool-call timeout), so
    // it must never run on the render loop. One at a time.
    let mut context_task: Option<tokio::task::JoinHandle<ContextReport>> = None;
    // `/usage <view>`: a round trip to the provider's usage API, so it runs off
    // the render loop too. One at a time.
    let mut usage_task: Option<tokio::task::JoinHandle<UsageDone>> = None;
    // `/plugin install` clones a git repo, so it runs off the render loop via
    // the installer's internal `spawn_blocking`; one at a time. A collection
    // source resolves in two steps (list -> picker -> install the chosen set),
    // and `plugin_install_url` remembers the source across them.
    let mut plugin_install_task: Option<
        tokio::task::JoinHandle<Result<crate::core::agent::plugins::GitInstall, String>>,
    > = None;
    let mut plugin_install_url: Option<String> = None;

    // Compaction is a summarizing model call, so it runs off the render loop
    // too; `compact_base` is the history length it was computed from.
    let mut compact_task: Option<
        tokio::task::JoinHandle<
            Result<Vec<serde_json::Value>, tauri_plugin_agent_tools::harness_error::HarnessError>,
        >,
    > =
        None;
    let mut compact_base = 0usize;
    // `/goal` evaluation: one stateless model call, off the render loop.
    let mut goal_task: Option<GoalEvalTask> = None;
    // `/model`'s probe of providers with no model list: network, so off-loop.
    let mut model_fetch_task: Option<tokio::task::JoinHandle<ModelFetchDone>> = None;

    // The dock's branch indicator is captured once at startup; re-read it on a
    // slow timer so a checkout made outside the TUI (another terminal, an
    // editor) is reflected without a restart. `None` once the project proves
    // not to be a git repo, so a plain directory never shells out every tick.
    let mut branch_task: Option<tokio::task::JoinHandle<Option<String>>> = None;
    let mut branch_poll = tokio::time::interval(BRANCH_POLL_INTERVAL);
    branch_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // `@path` hints: edits mark them dirty, the 50 ms tick starts one search.
    let mut hint_task: Option<PathHintTask> = None;

    // Nothing to say when there is no seed message: the splash already invites
    // the first one (`Banner::awaiting_first_message`).
    if let Some(task) = initial_task.filter(|t| !t.trim().is_empty()) {
        app.submit_user(task.trim().to_string());
    }

    // kitty drops the resize repaint behind a held synchronized frame, so it is
    // gated off there; see `use_synchronized_output`.
    let sync_output = use_synchronized_output();

    while !app.should_quit {
        // Drive the snapshot queue: run one job off-loop at a time. A job whose
        // inputs no longer resolve (snapshots disabled) is dropped.
        if snap_task.is_none() {
            while let Some(job) = app.snap_queue.pop_front() {
                if let Some((repo, parent, msg, id, changed)) = app.resolve_snapshot(&job) {
                    snap_task = Some(spawn_snapshot(repo, parent, msg, id, changed));
                    snap_inflight = Some(job);
                    break;
                }
            }
        }

        // Esc closed the dock while sign-in work was in flight: drop all of it,
        // so a late reply can't report a sign-in the user walked away from. The
        // dock stays open for the whole flow, so this is the one cancel path.
        if app.login.is_none() {
            if let Some(task) = login_task.take() {
                task.abort();
            }
            if let Some(task) = login_claim_task.take() {
                task.abort();
            }
            if let Some(task) = login_begin_task.take() {
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
            if let Some(job) = mcp_job.take() {
                job.abort();
            }
            app.browser_confirm = None;
            if let Some(flow) = app.mcp_auth.take() {
                app.note(&format!("sign-in for '{}' cancelled", flow.server));
            }
        }
        if mcp_job.is_none() {
            if let Some(job) = app.mcp_job_request.take() {
                let servers = mcp_servers.clone();
                mcp_job = Some(tokio::spawn(run_mcp_job(job, servers)));
            }
        }
        // `/context` asked for a report. Compute it off the render loop (it
        // takes the MCP server lock), one at a time. The snapshot carries the
        // state the computation needs, so nothing borrows `App` across the
        // spawn.
        if context_task.is_none() && app.context_request {
            app.context_request = false;
            let snapshot = app.context_snapshot();
            context_task = Some(tokio::spawn(compute_context_report(snapshot)));
        }
        if usage_task.is_none() {
            if let Some(query) = app.usage_request.take() {
                usage_task = Some(tokio::spawn(async move {
                    let result = crate::core::cli::tokamak::usage::fetch(&query).await;
                    (query, result)
                }));
            }
        }
        // A key was submitted at the `/login` prompt: verify it off-loop. One at
        // a time - the prompt is read-only while `verifying`.
        if login_task.is_none() {
            if let Some((provider, key)) = app.login_submit.take() {
                login_task = Some(tokio::spawn(async move {
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
            && login_begin_task.is_none()
            && login_claim_task.is_none()
            && login_task.is_none()
        {
            app.login_device_request = false;
            login_begin_task = Some(tokio::spawn(async move {
                super::device_auth::begin(&super::tokamak::base_url()).await
            }));
        }

        // `/plugin install` was typed: clone off-loop (the network-bound git
        // work runs inside the installer's `spawn_blocking`), and refuse a
        // second while one is in flight. `list_collection` installs a plain
        // source outright and only *lists* an ambiguous collection, which
        // `finish_plugin_install` turns into the picker.
        if plugin_install_task.is_none() {
            if let Some(spec) = app.plugin_install_request.take() {
                app.plugin_installing = true;
                let root = app.project_root.clone();
                plugin_install_url = Some(spec.clone());
                plugin_install_task = Some(tokio::spawn(async move {
                    crate::core::agent::plugins::list_collection(&root, &spec).await
                }));
            } else if let Some((spec, paths)) = app.plugin_select_request.take() {
                // Second step: the picker's chosen subset of a collection.
                app.plugin_installing = true;
                let root = app.project_root.clone();
                plugin_install_url = Some(spec.clone());
                plugin_install_task = Some(tokio::spawn(async move {
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
        if compact_task.is_none() {
            if let Some(kind) = app.compact_request.take() {
                let args = args.clone();
                let model = app.model.clone();
                let history = app.history.clone();
                let keep = kind.keep_recent(app.compaction_keep_recent);
                let focus = app.compact_focus.take();
                compact_base = history.len();
                app.compacting = Some(kind);
                app.compact_started = Some(Instant::now());
                compact_task = Some(tokio::spawn(async move {
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
        if model_fetch_task.is_none() && std::mem::take(&mut app.model_fetch_request) {
            app.model_fetch_running = true;
            model_fetch_task = Some(tokio::spawn(fetch_models_job(
                app.project_root.clone(),
                app.probed_models.clone(),
            )));
        }
        if goal_task.is_none() && app.goal_eval_pending && current.is_none() && !app.want_start {
            goal_task = app.begin_goal_evaluation();
        }
        // Esc, or the user submitting a message themselves, stops the
        // evaluation: its verdict would otherwise start a second turn.
        if app.goal_evaluating && (app.goal_eval_cancel || app.want_start) {
            if let Some(task) = goal_task.take() {
                task.abort();
            }
            app.stop_goal_evaluation();
        }

        // Kick off a queued run once the previous one has cleared, the MCP
        // servers (if any) are connected, and the base snapshot (if any) is
        // captured. `submit_user` already flipped status to Running and reset
        // the counter.
        // A compaction in flight is also a gate: it replaces `history`, so a run
        // started against the pre-compaction copy would be clobbered.
        if app.want_start && current.is_none() && compact_task.is_none() {
            let base_ready = app.repo_root.is_none() || app.base_snapshot.is_some();
            if mcp_ready && base_ready {
                app.want_start = false;
                // The submission itself is one human turn toward the aging
                // grace period; model roundtrips count via `Step` events.
                age_closed_todos(app).await;
                let mut body = app.body();
                if let Some(command) = app.scripted_command.take() {
                    body["jan_scripted_command"] = serde_json::json!(command);
                }
                current = Some(spawn_run(&run_args(app, args), body));
            } else if !loading_noted && !mcp_ready {
                // The base snapshot gates silently; only the MCP connect notes.
                loading_noted = true;
                app.note("connecting MCP servers...");
            }
        }

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
                if let Some((generation, root, query)) = app.take_path_hint_request() {
                    hint_task = Some(spawn_path_hint_search(generation, root, query));
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
                                handle_key(app, key, registry, &mut current, mcp_servers).await;
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
            _ = branch_poll.tick() => {
                if branch_task.is_none() {
                    branch_task = Some(spawn_branch_poll(&app.project_root));
                }
            }
            branch = await_branch_poll(&mut branch_task) => {
                app.git_branch = branch;
            }
            found = await_path_hints(&mut hint_task) => {
                if let Some((generation, items)) = found {
                    app.apply_path_hints(generation, items);
                }
            }
            outcome = await_mcp(&mut mcp_task) => {
                mcp_ready = true;
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
            Some(done) = await_mcp_job(&mut mcp_job) => {
                finish_mcp_job(app, done, mcp_servers, &mut mcp_job).await;
            }
            Some(done) = await_usage(&mut usage_task) => {
                finish_usage(app, done);
            }
            Some(report) = await_context(&mut context_task) => {
                // Only apply a report the user is still looking at: a result
                // landing after the overlay was closed must not reopen it.
                finish_context_report(app, report);
            }
            login_res = await_login(&mut login_task) => {
                let login_ok = login_res.is_ok();
                finish_login(app, login_res);
                if login_ok {
                    reload_provider_configs(app).await;
                }
            }
            begun = await_login_begin(&mut login_begin_task) => {
                match begun {
                    Ok(pending) => {
                        show_login_approval(app, pending.session());
                        login_claim_task =
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
            claimed = await_tokamak_login(&mut login_claim_task) => {
                if finish_tokamak_login(app, claimed) {
                    reload_provider_configs(app).await;
                }
            }
            plugin_res = await_plugin_install(&mut plugin_install_task) => {
                finish_plugin_install(app, plugin_install_url.take(), plugin_res);
            }
            compacted = await_compaction(&mut compact_task) => {
                finish_compaction(app, compacted, compact_base);
            }
            Some(done) = await_model_fetch(&mut model_fetch_task) => {
                finish_model_fetch(app, done).await;
            }
            evaluated = await_goal_eval(&mut goal_task) => {
                match evaluated {
                    Some((goal, verdict)) => app.finish_goal_evaluation(goal, verdict),
                    None => {
                        app.goal_evaluating = false;
                        app.note("◎ goal evaluation failed (goal kept; /goal clear to stop)");
                    }
                }
            }
            snap_res = await_snapshot(&mut snap_task) => {
                match (snap_inflight.take(), snap_res) {
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
            ev = next_event(&mut current) => {
                match ev {
                    RunEvent::Stream(ev) => apply_stream_event(app, ev, &mut current).await,
                    RunEvent::Steering(request) => app.steer_run(request),
                }
                drain_stream_events(app, &mut current).await;
            }
        }
    }

    if let Some(c) = current {
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

impl App {
    /// Cycle reasoning effort between `"low"` and the most recent non-low level.
    /// `Alt+T` in the TUI toggles between a quiet and a deep run without typing
    /// `/effort`; the last non-low selection is remembered so toggling back off
    /// low restores the user's preferred depth.
    fn toggle_reasoning_effort(&mut self) {
        if self.reasoning_effort == "low" {
            self.reasoning_effort = self.last_non_low_effort.clone();
        } else {
            self.last_non_low_effort = self.reasoning_effort.clone();
            self.reasoning_effort = "low".into();
        }
        self.note(&format!("reasoning effort: {}", self.reasoning_effort));
    }

    /// Advance through the effort levels (low -> medium -> high -> low),
    /// Claude Code-style. `Shift+Tab` calls this; it always updates
    /// `last_non_low_effort` so a subsequent `Alt+T` low/non-low toggle stays
    /// coherent.
    fn cycle_reasoning_effort(&mut self) {
        let next = match self.reasoning_effort.as_str() {
            "low" => "medium",
            "medium" => "high",
            "high" => "low",
            _ => "medium",
        };
        self.reasoning_effort = next.to_string();
        if next != "low" {
            self.last_non_low_effort = next.to_string();
        }
        self.note(&format!("reasoning effort: {}", self.reasoning_effort));
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
