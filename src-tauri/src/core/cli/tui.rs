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

impl App {
    /// Non-terminal stream events. `Done`/`Error` are handled by the loop since
    /// they mutate history and the run handle.
    fn apply(&mut self, ev: StreamEvent) {
        // Whatever the parent run sends next -- a token, a tool call -- means
        // the wait for a resend is over. A child's events say nothing about the
        // parent's request.
        if !matches!(ev, StreamEvent::Retry { .. } | StreamEvent::Subagent { .. }) {
            self.retrying = None;
        }
        match ev {
            StreamEvent::Token { text } => {
                self.assistant_buf.push_str(&text);
                // Track the live thinking state so the header can fold reasoning
                // to `[thinking]` / `[thought for Ns]`. Start the timer when
                // reasoning is open; close it (stashing the duration) once the
                // block ends. `reasoning_open` covers both inline ` think>` tags
                // and native reasoning_buf, so a content token after reasoning
                // closes the window (and prose arriving with no reasoning leaves
                // it closed).
                let open = self.reasoning_open();
                if open && self.thinking_since.is_none() {
                    self.thinking_since = Some(Instant::now());
                } else if !open {
                    if let Some(started) = self.thinking_since.take() {
                        self.thought_for = Some(started.elapsed());
                        self.thought_for_since = Some(Instant::now());
                    }
                }
                // Commit the tool group as `✓` once real answer prose begins, so
                // it lands above the streaming response. Reasoning tokens must
                // not trigger this, or every call by a reasoning model splits
                // into its own row.
                if self.tool_group.is_some() && self.think_scan.borrow_mut().state(&self.assistant_buf).1 {
                    self.finalize_tool_group();
                }
            }
            StreamEvent::Reasoning { text } => {
                // Native reasoning stays out of the answer buffer entirely; it is
                // folded into the display log on the next flush. Deltas that
                // arrive with no prose in between extend the open segment;
                // reasoning after prose starts a new one, so the timeline keeps
                // emission order instead of hoisting every thought to the top.
                if !text.is_empty() {
                    let at = self.assistant_buf.len();
                    match self.reasoning_segs.last_mut() {
                        Some(seg) if seg.at == at => seg.text.push_str(&text),
                        _ => self.reasoning_segs.push(ReasoningSeg { at, text }),
                    }
                    if self.thinking_since.is_none() {
                        self.thinking_since = Some(Instant::now());
                    }
                }
            }
            StreamEvent::Step { index, max } => {
                // Only flush (and thereby close the tool group) once the model
                // has produced answer prose; a turn that only reasoned or only
                // called tools keeps the group open so the next turn's calls
                // keep folding into one summary row instead of a row per turn.
                if self.think_scan.borrow_mut().state(&self.assistant_buf).1 {
                    self.flush_assistant();
                }
                self.starting.clear();
                self.turn = (index, max);
            }
            StreamEvent::ToolCallStarted { id, name } => {
                // Commit buffered prose/reasoning so it renders above the
                // in-progress throbber, matching the grouped-call ordering.
                self.flush_assistant();
                if !self.starting.iter().any(|c| c.id == id) {
                    self.starting.push(StartingCall::new(id, name));
                }
            }
            StreamEvent::ToolCallArgsDelta { id, delta } => {
                if let Some(call) = self.starting.iter_mut().find(|c| c.id == id) {
                    call.args.push_str(&delta);
                }
            }
            StreamEvent::ToolOutputDelta { id, delta } => {
                // Bounded from the end: a runaway command must not be able to
                // grow the TUI's memory. The tool keeps the authoritative full
                // output (spilling to disk past its own cap) and hands it over
                // with the result; this buffer only has to feed the live view.
                let buf = self.live_output.entry(id).or_default();
                buf.push_str(&delta);
                if buf.len() > LIVE_OUTPUT_MAX_BYTES {
                    // Trim on a char boundary so the buffer stays valid UTF-8.
                    let cut = buf.len() - LIVE_OUTPUT_MAX_BYTES;
                    let at = (cut..buf.len())
                        .find(|i| buf.is_char_boundary(*i))
                        .unwrap_or(buf.len());
                    buf.drain(..at);
                }
            }
            StreamEvent::ToolCall { id, name, args } => {
                // The full call supersedes its in-progress throbber. Clearing the
                // whole set, not just this id: `ToolCall` events are emitted only
                // once the model's stream is fully assembled (see `loop.rs`), so
                // by the time any arrives no arguments are still streaming and
                // every "Preparing" throbber is stale. An id-only clear left a
                // throbber whose id did not line up (or a duplicate) lingering on
                // screen through the whole command.
                self.starting.clear();
                // Commit buffered prose/reasoning before anything else: every
                // branch below does it anyway (so the timeline stays in emission
                // order), and doing it here keeps the journal in that order too
                // -- text that preceded the call, then the call. `flush_assistant`
                // no-ops on an empty buffer, so silent consecutive calls still
                // fold into one group row.
                self.flush_assistant();
                // `await_subagent` renders a live throbber that its result
                // clears, so journaling the call would replay a spinner nothing
                // ever stops; its result row is journaled below either way.
                if name != "await_subagent" {
                    self.display_log.push(DisplayEntry::ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        args: args.clone(),
                    });
                }
                // Track todo activity this turn so the reminder policy can tell
                // an engaged turn (mutated todos) from a stalled one.
                if name == "todo" {
                    self.todo_call_this_turn = true;
                }
                // Awaiting a subagent is a long block: show a live throbber row
                // (advanced each render tick) instead of a static grouped row,
                // cleared when its result arrives.
                if name == "await_subagent" {
                    let run_id = args.get("run_id").and_then(|v| v.as_str()).unwrap_or("");
                    let sub = subagent_name_from_run_id(run_id).to_string();
                    self.awaiting.push((id, run_id.to_string(), sub));
                    return;
                }
                let args = self.track_bash_job(&id, &name, args);
                // Untruncated: every row that shows these clamps to the width it
                // is drawn at, so they survive a resize either way.
                let label = tool_activity(&name, &args);
                let done = tool_finished(&name, &args);
                if matches!(name.as_str(), "edit" | "write") {
                    // Record the touched path so the next checkpoint snapshots
                    // exactly this file instead of scanning the whole repo.
                    if let Some(p) = args.get("path").and_then(|v| v.as_str()) {
                        self.turn_touched.push(self.work_root().join(p));
                        self.diff_paths.insert(id.clone(), p.to_string());
                    }
                    // Diff-producing tools render standalone (call row & panel).
                    self.finalize_tool_group();
                    self.gap(Kind::Tool);
                    self.push_row(RowKind::Tool {
                        tag: "▸".to_string(),
                        tag_style: Style::new().cyan(),
                        label: label.clone(),
                        label_style: Style::new().cyan().dim(),
                        reserve: TOOL_ROW_RESERVE,
                    });
                    self.pending_rows.push(PendingToolRow {
                        id: id.clone(),
                        idx: self.transcript.len() - 1,
                        label,
                        done,
                    });
                } else {
                    self.push_grouped_call(&id, &name, label, done);
                }
            }
            StreamEvent::ToolResult {
                id,
                content,
                is_error,
                diff,
            } => {
                // Clear the throbber for an awaited subagent once its result lands.
                self.awaiting.retain(|(await_id, ..)| await_id != &id);
                self.display_log.push(DisplayEntry::ToolResult {
                    id: id.clone(),
                    content: content.clone(),
                    is_error,
                    diff: diff.clone(),
                });
                // Before the grouped-call early return: a backgrounded command
                // is reported by its result, and the call that later collects it
                // needs the pairing whichever way this row renders.
                if let Some(cmd) = self.bash_commands.remove(&id) {
                    if let Some(job) = backgrounded_job_id(&content) {
                        self.bash_jobs.insert(job.to_string(), cmd);
                        self.job_origin.insert(job.to_string(), id.clone());
                        self.active_bg_jobs.insert(job.to_string());
                    }
                }
                // The command is over, so its live buffer is dead weight: the
                // authoritative output is in this result. A call that backgrounded
                // itself keeps its buffer -- the detached job is still writing to
                // it, under this same id.
                if backgrounded_job_id(&content).is_none() {
                    let key = self.live_alias.remove(&id).unwrap_or_else(|| id.clone());
                    self.live_output.remove(&key);
                }
                let resolved = self.resolve_pending_row(&id, is_error);
                // Any tool result means the model took some action since the last
                // reminder fired; let a later stop remind again if work is still
                // open. Set unconditionally, before the grouped-call early return
                // below, so it applies no matter how the result renders.
                self.reminder_awaiting_progress = false;
                // Grouped calls are already represented by the group row; retain
                // their result on the group so an expand can show it later.
                if self.grouped_ids.contains(&id) {
                    // A group can be finalized (closed) before a folded call's
                    // result lands - committing reasoning above a later call
                    // closes the open group, then a new one opens. The result
                    // must reach whichever group owns the id; routing it only
                    // into the open group would drop it (and leave a stale
                    // `✓` on the closed group).
                    let open_owns = self
                        .tool_group
                        .as_ref()
                        .is_some_and(|g| g.calls.iter().any(|c| c.id == id));
                    if open_owns {
                        let group = self.tool_group.as_mut().expect("checked above");
                        if let Some(call) = group.calls.iter_mut().find(|c| c.id == id) {
                            call.is_error = is_error;
                            call.diff = diff;
                            call.content = Some(content);
                            group.last_result_error = Some(is_error);
                            self.refresh_group_row();
                            return;
                        }
                    }
                    // A standalone edit/write or intervening display block can
                    // close a group before its batch's results arrive.
                    // Owned by a group already closed (e.g. by the reasoning
                    // flush above): update its retained call and rewrite the
                    // row so a late error reads as `✗`, not `✓`.
                    for group in self.groups.iter_mut() {
                        if let Some(call) = group.calls.iter_mut().find(|c| c.id == id) {
                            call.is_error = is_error;
                            call.diff = diff;
                            call.content = Some(content);
                            group.last_result_error = Some(is_error);
                            let idx = group.idx;
                            let row = group.row(GroupRow::Closed);
                            self.transcript[idx] = row;
                            break;
                        }
                    }
                    return;
                }
                self.flush_assistant();
                let (tag, tag_style) = if is_error {
                    ("✗", Style::new().red())
                } else {
                    ("✓", Style::new().green())
                };
                let lang = diff
                    .is_some()
                    .then(|| self.diff_paths.remove(&id))
                    .flatten();
                // The resolved call row above already names the tool and file in
                // past tense, so a successful "Applied N edit(s) to X" only
                // repeats it; the diff is the informative part. Errors keep their
                // text -- the row says nothing about why the call failed.
                let content = (!(resolved && !is_error && diff.is_some())).then_some(content);
                self.gap(Kind::Tool);
                self.push_row(RowKind::Result {
                    tag,
                    tag_style,
                    content,
                    diff,
                    lang,
                });
            }
            StreamEvent::PermissionRequest {
                request_id,
                tool_name,
                capability,
                path,
                command,
                diff,
                prompt_kind,
                offers_always,
                reason,
                ..
            } => {
                // Don't close the tool group here: the prompt renders docked
                // above the input, and finalizing would break the running row
                // for every gated call (i.e. every exec) into its own line.
                self.pending_queue.push_back(Pending {
                    request_id,
                    tool_name,
                    capability,
                    path,
                    command,
                    diff,
                    offers_always: offers_always && prompt_kind != "secret",
                    reason,
                    prompt_kind,
                    selected: 0,
                    subagent: None,
                    shown_at: Instant::now(),
                });
                self.yield_screen_to_prompt();
                self.publish_agent_status();
            }
            StreamEvent::AskRequest {
                request_id,
                request,
                timeout_secs,
                ..
            } => {
                self.ask_queue.push_back(PendingAsk::new(
                    request_id,
                    request,
                    timeout_secs.map(std::time::Duration::from_secs),
                ));
                self.yield_screen_to_prompt();
                self.publish_agent_status();
            }
            // Host tools belong to a headless run driven by a host process.
            // The TUI is that host's opposite number -- there is no peer on
            // stdin to execute a callback -- so it never declares them and
            // cannot receive this.
            StreamEvent::ToolRequest { .. }
            | StreamEvent::ToolRequestCancelled { .. }
            | StreamEvent::ToolDetails { .. } => {}
            // The loop auto-answered a timed-out ask; drop its now-dead prompt.
            // A user answer clears the queue in `resolve_front_ask` instead, so
            // this only fires for the timeout path.
            StreamEvent::AskResolved { request_id } => {
                self.ask_queue.retain(|ask| ask.request_id != request_id);
                self.publish_agent_status();
            }
            StreamEvent::SubagentStart { run_id, name, task } => {
                // A queued dispatch already opened a panel for this run; promote
                // it to running instead of pushing a duplicate. Otherwise open a
                // fresh live panel (several may be active).
                if let Some(panel) = self.subagents.iter_mut().find(|p| p.run_id == run_id) {
                    panel.queued = false;
                } else {
                    self.finalize_tool_group();
                    self.flush_assistant();
                    self.subagents.push(SubagentPanel {
                        run_id,
                        name,
                        task: task.unwrap_or_default(),
                        calls: Vec::new(),
                        requests: 0,
                        prompt_tokens: 0,
                        active: None,
                        queued: false,
                        waiting: 0,
                    });
                }
            }
            StreamEvent::SubagentQueued {
                run_id,
                name,
                task,
                waiting,
            } => {
                // The cap is exhausted; this dispatch will start when a running
                // child finishes. Open its panel now, marked queued, so the
                // fan-out shows the queue instead of hiding dispatches.
                self.finalize_tool_group();
                self.flush_assistant();
                self.subagents.push(SubagentPanel {
                    run_id,
                    name,
                    task: task.unwrap_or_default(),
                    calls: Vec::new(),
                    requests: 0,
                    prompt_tokens: 0,
                    active: None,
                    queued: true,
                    waiting,
                });
            }
            StreamEvent::SubagentTitle { run_id, title, .. } => {
                self.subagent_titles.insert(run_id, title);
            }
            StreamEvent::SubagentEnd { run_id, name } => {
                // "explorer: Map the lexer" when the dispatch named the errand.
                let name = match self.subagent_titles.remove(&run_id) {
                    Some(title) => format!("{name}: {title}"),
                    None => name,
                };
                let calls = self
                    .subagents
                    .iter()
                    .find(|p| p.run_id == run_id)
                    .map(|p| p.calls.clone())
                    .unwrap_or_default();
                self.subagents.retain(|p| p.run_id != run_id);
                self.awaiting.retain(|(_, r, _)| r != &run_id);
                let extra = self.subagent_finish.remove(&run_id);
                self.push_subagent_summary_with(&name, calls, true, extra);
            }
            StreamEvent::SubagentFinished {
                run_id,
                status,
                usage,
                ..
            } => {
                let tokens = usage
                    .as_ref()
                    .and_then(|u| u.get("total_tokens"))
                    .and_then(|t| t.as_u64())
                    .filter(|t| *t > 0)
                    .map(|t| format!("{} tokens", format_tokens(t)));
                let note = match (status.as_str(), tokens) {
                    ("turn_limit", _) => Some("stopped at its turn limit".to_string()),
                    ("error", _) => Some("failed".to_string()),
                    (_, tokens) => tokens,
                };
                if let Some(note) = note {
                    self.subagent_finish.insert(run_id, note);
                }
            }
            StreamEvent::Subagent {
                run_id,
                name,
                event,
            } => self.apply_subagent_event(&run_id, &name, *event),
            StreamEvent::TurnUsage {
                usage,
                execution_id,
            } => {
                if let Some(id) = execution_id {
                    self.last_execution_id = Some(id);
                }
                self.turn_output_tokens += usage.completion_tokens.unwrap_or(0);
                // Latest request's context, not a sum: each request resends the
                // whole conversation, so adding them would be meaningless.
                if let Some(prompt) = usage.prompt_tokens {
                    self.turn_prompt_tokens = prompt;
                    // Keep the header's context gauge live during the turn
                    // instead of jumping only when the run ends.
                    self.tokens = prompt + usage.completion_tokens.unwrap_or(0);
                    // A fresh measurement of the *current* history supersedes
                    // any post-compaction estimate.
                    self.tokens_estimated = false;
                }
            }
            // AH-078. The record is written by the dispatcher and is already
            // redacted; the TUI holds the identity so the run can be pointed at
            // it, and never the payload. Matched explicitly, not through a
            // wildcard, so a new event breaks this build rather than being
            // silently dropped from the interface.
            StreamEvent::PromptSnapshot { .. } => {}
            // Machine-facing identity record (upstream #9056): nothing to draw.
            StreamEvent::RequestProvenance { .. } => {}
            // AH-174: the run's resource figures are recorded with its end and
            // shown on the timeline; the TUI's transcript does not repeat them.
            // The typed ending (`end_reason`) rides along with the terminal
            // event the TUI already renders; the transcript says it once.
            StreamEvent::Done { .. }
            | StreamEvent::Error { .. }
            | StreamEvent::RunEnded { .. }
            | StreamEvent::RunResources { .. } => {}
            // The loop's own compaction: a summarizer round trip the run is
            // blocked on, which nothing else on screen would explain. The
            // header and input row carry the throbber while it runs; the
            // outcome is one transcript line saying why.
            StreamEvent::Compaction { phase, reason, messages } => {
                use crate::core::agent::events::{CompactionPhase, CompactionReason};
                match phase {
                    CompactionPhase::Started => self.run_compacting = Some(Instant::now()),
                    CompactionPhase::Finished => {
                        self.run_compacting = None;
                        let why = match reason {
                            CompactionReason::Preflight => "the prompt neared the context window",
                            CompactionReason::ContextOverflow => {
                                "the provider rejected the prompt as too long"
                            }
                            CompactionReason::SessionBudget => {
                                "the session token budget was used up"
                            }
                        };
                        self.finalize_tool_group();
                        self.flush_assistant();
                        match messages {
                            Some(n) => self.note(&format!(
                                "compacted {n} messages into a summary: {why}"
                            )),
                            None => self.note(&format!("compacted the conversation: {why}")),
                        }
                        // The next `MessagesUpdated` carries the shorter
                        // history; the gauge is re-estimated against it.
                        self.tokens_estimated = true;
                    }
                    CompactionPhase::Failed => {
                        self.run_compacting = None;
                        self.note("compaction did not shrink the conversation");
                    }
                }
            }
            // The live countdown carries every attempt; the transcript notes
            // only the first, so a flaky link leaves one line, not ten.
            StreamEvent::Retry {
                attempt,
                max_attempts,
                delay_ms,
                reason,
            } => {
                if attempt == 2 {
                    self.finalize_tool_group();
                    self.flush_assistant();
                    self.note(&format!("{reason}; retrying"));
                }
                self.retrying = Some(RetryWait {
                    attempt,
                    max_attempts,
                    at: Instant::now() + Duration::from_millis(delay_ms),
                    reason,
                });
            }
            StreamEvent::MessagesUpdated { messages } => {
                self.history = messages;
                self.persist_in_background();
            }
            StreamEvent::TodoUpdate { list } => {
                self.todos = list;
                // A snapshot only arrives on a successful mutation; its absence
                // after a todo call means the mutation failed (retry reminder).
                self.todo_ok_this_turn = true;
            }
        }
    }

    /// Route one backgrounded subagent's internal event to its run's live panel.
    /// Only tool calls populate the rolling window; the child's own prose/steps/
    /// results are internal. A permission request docks the shared prompt,
    /// attributed to the asking subagent.
    fn apply_subagent_event(&mut self, run_id: &str, name: &str, event: StreamEvent) {
        match event {
            StreamEvent::ToolCall {
                id,
                name: tool,
                args,
            } => {
                // Stored untruncated; the panel clamps it to the draw width.
                let label = subagent_activity(&tool, &args);
                if let Some(panel) = self.subagents.iter_mut().find(|p| p.run_id == run_id) {
                    // The completed call supersedes its in-progress view.
                    if panel.active.as_ref().is_some_and(|c| c.id == id) {
                        panel.active = None;
                    }
                    // Full history retained for expansion; the panel renders only
                    // the last SUBAGENT_WINDOW.
                    panel.calls.push(label);
                }
            }
            // A child's arguments stream just like the parent's, and for a big
            // `write` that window is most of the run. Track it so the panel
            // reports the call being built instead of going silent until it
            // lands.
            StreamEvent::ToolCallStarted { id, name: tool } => {
                if let Some(panel) = self.subagents.iter_mut().find(|p| p.run_id == run_id) {
                    panel.active = Some(StartingCall::new(id, tool));
                }
            }
            StreamEvent::ToolCallArgsDelta { id, delta } => {
                if let Some(panel) = self.subagents.iter_mut().find(|p| p.run_id == run_id) {
                    if let Some(call) = panel.active.as_mut().filter(|c| c.id == id) {
                        call.args.push_str(&delta);
                    }
                }
            }
            StreamEvent::PermissionRequest {
                request_id,
                tool_name,
                capability,
                path,
                command,
                diff,
                prompt_kind,
                offers_always,
                reason,
                ..
            } => {
                self.pending_queue.push_back(Pending {
                    request_id,
                    tool_name,
                    capability,
                    path,
                    command,
                    diff,
                    offers_always: offers_always && prompt_kind != "secret",
                    reason,
                    prompt_kind,
                    selected: 0,
                    subagent: Some(name.to_string()),
                    shown_at: Instant::now(),
                });
                self.yield_screen_to_prompt();
                self.publish_agent_status();
            }
            // Each child request bumps its counter, so the panel shows work
            // happening even during a long think with no tool calls.
            StreamEvent::Step { .. } => {
                if let Some(panel) = self.subagents.iter_mut().find(|p| p.run_id == run_id) {
                    panel.requests += 1;
                }
            }
            StreamEvent::TurnUsage { usage, .. } => {
                if let Some(panel) = self.subagents.iter_mut().find(|p| p.run_id == run_id) {
                    panel.prompt_tokens = usage.prompt_tokens.unwrap_or(panel.prompt_tokens);
                }
            }
            // Token/ToolResult, a child's live tool output (`ToolOutputDelta`)
            // and any nested bracket are internal to the child run and not
            // surfaced in the parent transcript: a subagent panel is a one-line
            // activity summary, so a child's shell output would have nowhere to
            // go and would push the parent's own live panel off screen. Deliberate
            // -- the child's output still reaches its `ToolResult`.
            _ => {}
        }
    }

    /// Recompute and publish the Orca-visible agent status from primary state
    /// (turn status plus pending prompts). The reporter dedupes, so calling
    /// this after every transition is cheap. The prompt preview carries the
    /// pending permission summary (what Jan is blocked on) or the active
    /// subagent task, matching Orca's card fields.
    fn publish_agent_status(&mut self) {
        use super::agent_status::AgentStatusState as S;
        let state = match self.status {
            Status::Idle => S::Done,
            Status::Running if !self.pending_queue.is_empty() => S::Blocked,
            Status::Running if !self.ask_queue.is_empty() => S::Waiting,
            Status::Running => S::Working,
        };
        let prompt = match state {
            S::Waiting => self
                .ask_queue
                .front()
                .and_then(|ask| ask.request.questions.first())
                .map(|q| q.question.clone()),
            _ => None,
        };
        self.agent_status.set_state(state, prompt.as_deref());
    }

    /// Arm the per-turn state shared by a user submit and a reminder
    /// continuation. Both paths start a run, so both must reset every
    /// turn-scoped counter -- keeping two hand-maintained copies in sync is how
    /// a new counter ends up reset on one path and accumulating on the other.
    fn begin_turn(&mut self) {
        self.status = Status::Running;
        self.run_started = Some(Instant::now());
        self.turn = (0, 0);
        self.tokens_per_sec = None;
        self.turn_output_tokens = 0;
        self.turn_prompt_tokens = 0;
        self.scrollback = 0;
        self.todo_call_this_turn = false;
        self.todo_ok_this_turn = false;
        // A fresh turn starts with no active reasoning.
        self.thinking_since = None;
        self.thought_for = None;
        self.thought_for_since = None;
        // A call cancelled before its result would otherwise leave its path
        // behind for the life of the session.
        self.diff_paths.clear();
        self.publish_agent_status();
    }

    /// Current throbber frame. `spinner_frame` is advanced on a fixed cadence
    /// by the render loop, so every animated row in a frame shows the same
    /// glyph and they turn together instead of drifting apart.
    fn spinner(&self) -> &'static str {
        SPINNER[self.spinner_frame % SPINNER.len()]
    }

    /// Flush the current turn and return its text as the final assistant answer.
    fn take_answer(&mut self) -> String {
        let answer = self.assistant_buf.trim().to_string();
        self.flush_assistant();
        answer
    }

    /// The concatenated natively-streamed reasoning text for the current turn.
    /// Used to resend the final answer's reasoning on the wire. Inline
    /// `<think>` blocks (which arrive through `Token` and live in the buffer)
    /// are handled separately by `answer_without_reasoning` and the loop path;
    /// this covers the `reasoning_content` delta case, which never touches the
    /// buffer.
    fn native_reasoning_text(&self) -> String {
        self.reasoning_segs
            .iter()
            .map(|s| s.text.clone())
            .collect::<String>()
    }
    fn on_done(&mut self, stop_reason: String, usage: Option<Usage>) {
        self.finalize_tool_group();
        // Done is terminal: nothing more arrives on this stream, so a call that
        // never completed cannot be left animating for the rest of the session.
        self.resolve_orphan_tool_rows();
        // Children cannot outlive the run that dispatched them: their events
        // arrive on its stream. Any panel still open here never got its own
        // `SubagentEnd`.
        self.close_live_subagents();
        // Capture the turn's reasoning before `take_answer` flushes it: native
        // reasoning lives in `reasoning_segs` until the flush, and inline
        // ` thinking` blocks are folded into the buffer. Preserved so the
        // final assistant turn can be resent with its reasoning (see below).
        let reasoning = self.native_reasoning_text();
        let answer = self.take_answer();
        let wire = answer_without_reasoning(&answer);
        if !wire.is_empty() {
            let mut msg = serde_json::json!({ "role": "assistant", "content": wire });
            // Resend the final answer's reasoning on the wire turn, mirroring
            // how tool-call turns are threaded in the loop. Kept out of
            // `content`; only added when the upstream actually streamed it, so
            // non-reasoning providers send an unchanged shape.
            if !reasoning.is_empty() {
                msg["reasoning_content"] = serde_json::json!(reasoning);
            }
            self.history.push(msg);
        }
        // Some OpenAI-compatible servers send usage only with the terminal
        // event. Keep the same context accounting path for that case instead
        // of leaving the header at zero when no intermediate TurnUsage arrived.
        if self.turn_prompt_tokens == 0 {
            if let Some(prompt) = usage.as_ref().and_then(|u| u.prompt_tokens) {
                self.turn_prompt_tokens = prompt;
                self.tokens = prompt
                    + usage
                        .as_ref()
                        .and_then(|u| u.completion_tokens)
                        .unwrap_or(0);
                self.tokens_estimated = false;
            }
        }
        // If a provider does not report prompt usage at all, show a useful
        // estimate. The old OpenAI accumulator always had a prompt estimate
        // available; genai cannot manufacture one when the upstream omits
        // usage metadata. Do this per turn so a missing sample cannot leave a
        // stale measured value from the previous turn in the header.
        if self.turn_prompt_tokens == 0 && !self.history.is_empty() {
            self.tokens = estimate_token_count(&self.history);
            self.tokens_estimated = true;
        }
        // A closing receipt for the turn: when, how much context went up, how
        // much came back, how long it took, how fast. Cheap to skim, and the
        // only place the cost of a turn is visible after the fact.
        if let Some(started) = self.run_started {
            // Normally `TurnUsage` has already reported every request. Fall
            // back to the terminal usage only for an upstream that reports
            // nothing until the end, so the receipt isn't blank.
            if self.turn_output_tokens == 0 {
                self.turn_output_tokens = usage
                    .as_ref()
                    .and_then(|u| u.completion_tokens)
                    .unwrap_or(0);
            }
            let stats = turn_stats_line(
                self.turn_prompt_tokens,
                self.turn_output_tokens,
                started.elapsed(),
            );
            self.gap(Kind::Meta);
            self.push(stats);
        }
        // Cache this turn's output rate from the single `usage` sample and its
        // streaming duration, before `run_started` is cleared below. Holds
        // steady in the header until the next turn resets it.
        if let (Some(out), Some(started)) = (
            usage.as_ref().and_then(|u| u.completion_tokens),
            self.run_started,
        ) {
            self.tokens_per_sec =
                Some(tokens_per_second(out, started.elapsed().as_millis() as u64));
        }
        self.tokens = usage.and_then(|u| u.total_tokens).unwrap_or(self.tokens);
        self.status = Status::Idle;
        self.run_started = None;
        self.run_compacting = None;
        self.retrying = None;
        self.detail = format!("stop_reason={stop_reason}");
        self.scrollback = 0;
        self.publish_agent_status();
        // Surface abnormal completions in the timeline, not just the footer: a
        // truncated/filtered finish, or a "stop" that yielded no answer (an
        // empty/malformed upstream completion defaults to stop_reason=stop).
        let normal = matches!(stop_reason.as_str(), "stop" | "end_turn" | "stop_sequence");
        let no_answer = !has_answer_text(&answer);
        if !normal || no_answer {
            let msg = if no_answer {
                format!("finished with no answer (stop_reason={stop_reason})")
            } else {
                format!("finished early (stop_reason={stop_reason})")
            };
            self.system(Level::Warn, &msg);
        }
        self.checkpoint_turn();
        // A turn just completed under an active goal: count it and queue an
        // evaluation. The chat loop runs the (stateless) evaluator off the
        // render loop, then auto-continues or hands control back.
        // Plan mode pauses the goal loop: never auto-continue a goal while
        // planning (spec: entering plan pauses an active goal).
        let planning = self.run_mode == crate::core::agent::plan::RunMode::Plan;
        if let Some(goal) = self.goal.as_mut() {
            if goal.is_active() && !planning {
                goal.turns = goal.turns.saturating_add(1);
                // Only evaluate on a normal completion; an early/no-answer finish
                // is surfaced above and the user decides what to do next.
                self.goal_eval_pending = normal && !no_answer;
            }
        }
        // Auto-dequeue the next queued message, if any
        self.dequeue_next();
        // Reminder policy runs last: only if nothing else already claimed the
        // next turn (goal eval, a dequeued message) and open work remains.
        self.maybe_inject_todo_reminder(normal, no_answer, &answer);
        self.persist();
    }

    /// Whether auto-compaction should trigger: a non-zero token use above the
    /// active resolved threshold (window minus reserve) with enough history to
    /// shrink. The window is authoritative for the selected model (configured
    /// override, catalog, or fallback), so proactive compaction never silently
    /// stands down on accepted prompt usage.
    fn should_auto_compact(&self) -> bool {
        // AH-076: `auto = false` in the shared policy turns this off on every
        // surface; an overflow still compacts reactively.
        // The reserve never exceeds a quarter of the window, the same rule
        // `compaction_policy::Policy::effective_reserve` applies everywhere.
        let reserve = tauri_plugin_agent_tools::compaction_policy::reserve_buffer(
            self.reserve_tokens,
            self.context_window,
            self.reserve_pinned,
        );
        let limit = self.context_window.saturating_sub(reserve);
        self.compaction_auto && self.tokens > limit && self.tokens > 0 && self.history.len() > 4
    }

    /// Warn once as the context window fills (AH-077), before auto-compaction
    /// or an overflow takes the decision out of the user's hands. Said again
    /// only after the fill has dropped back below the line. Nothing is said
    /// when the window is unknown: there is no fraction to report.
    fn check_context_pressure(&mut self) {
        use crate::core::agent::context_pressure::{line, pressure};
        // `tokens_estimated` is the difference between "the provider counted
        // this" and "Flint measured the history itself", and the warning says
        // which it is rather than letting an estimate read as a measurement.
        let Some(found) = pressure(
            self.tokens,
            self.context_window,
            tauri_plugin_agent_tools::compaction_policy::reserve_buffer(
                self.reserve_tokens,
                self.context_window,
                self.reserve_pinned,
            ),
            !self.tokens_estimated,
        ) else {
            // Below the line again (a compaction, a new conversation, a bigger
            // window): the next approach is worth saying out loud.
            self.context_warned = false;
            return;
        };
        if self.context_warned {
            return;
        }
        self.context_warned = true;
        self.system(Level::Warn, &line(&found));
    }

    /// Queue a compaction and a retry for a context-overflow error, reporting
    /// whether recovery was taken up. Declines when the error is something
    /// else, the turn's retry budget is spent, a compaction is already in
    /// flight, or there is too little history for compaction to shrink -- in
    /// those cases a retry would re-send the request that just failed.
    fn request_overflow_recovery(&mut self, message: &str) -> bool {
        if !crate::core::agent::upstream::is_context_overflow_error(message)
            || self.overflow_retries >= MAX_OVERFLOW_RETRIES
            || self.compacting.is_some()
            || self.history.len() <= 4
        {
            return false;
        }
        self.overflow_retries += 1;
        self.retry_after_compact = true;
        self.compact_request = Some(CompactKind::Auto);
        self.detail = "context overflow: compacting".to_string();
        self.note("context overflow: compacting and retrying the turn");
        true
    }

    fn on_error(&mut self, code: String, message: String) {
        self.abort_tool_rows();
        self.close_live_subagents();
        self.flush_assistant();
        self.status = Status::Idle;
        self.run_started = None;
        self.run_compacting = None;
        self.retrying = None;
        self.detail = if message.contains("budget") {
            format!("budget exhausted: {message}")
        } else {
            format!("{code}: {message}")
        };
        self.publish_agent_status();
        self.system(Level::Error, &format!("error: {message}"));
        // A context overflow is the one error the session can recover from by
        // itself: compact, then resume the turn that failed. The goal loop and
        // the message queue are left alone until the retry resolves, so neither
        // acts on a turn that is about to run again.
        if self.request_overflow_recovery(&message) {
            return;
        }
        self.halt_turn();
    }

    /// Hand control back after a turn ended abnormally. Also reached from
    /// `finish_compaction` when an overflow recovery is abandoned, so the two
    /// paths cannot drift.
    fn halt_turn(&mut self) {
        // A run that died on an error rather than Esc is still an abnormal exit:
        // it may well have run tools whose side effects exist on disk, and the
        // calls of a step still in progress when the stream errored were never
        // published (the loop publishes after each completed step), so they
        // are absent from `history`.
        // Fold them in exactly as a hard cancel does, so a later prompt or
        // /resume sees the tools it ran and what they returned. The overflow-
        // retry path deliberately avoids this (see `on_error`): that turn
        // re-runs, so folding now would resend completed calls into the retried
        // request before the model asks for them again.
        self.append_cancelled_turn_tools();
        // An errored turn halts the goal loop; the user decides how to recover.
        self.goal_eval_pending = false;
        if let Some(goal) = self.goal.as_ref() {
            if goal.is_active() {
                self.note("goal paused (turn errored); /goal to review, /goal clear to stop");
            }
        }
        // Auto-dequeue the next queued message, if any
        self.dequeue_next();
    }

    /// Start one goal evaluation. Called by the chat loop when a turn finished
    /// under an active goal (`goal_eval_pending`). Returns the stateless
    /// `smol`-model call (no tools) for the loop to run off the render loop, so
    /// the UI keeps drawing and Esc can abort it; `finish_goal_evaluation`
    /// acts on the verdict.
    fn begin_goal_evaluation(&mut self) -> Option<GoalEvalTask> {
        self.goal_eval_pending = false;
        let goal = self.goal.clone()?;
        if !goal.is_active() {
            return None;
        }
        // No live session (e.g. tests): cannot evaluate. Leave control with
        // the user rather than looping blindly.
        let args = self.args.clone()?;
        self.note("◎ evaluating goal... (Esc to stop)");
        self.goal_evaluating = true;
        self.goal_eval_cancel = false;
        self.detail = "evaluating goal".to_string();
        let model = self.smol_model.clone();
        let history = self.history.clone();
        Some(tokio::spawn(async move {
            let verdict = crate::core::agent::r#loop::evaluate_goal(
                &args,
                &model,
                &goal.condition,
                &history,
            )
            .await;
            (goal, verdict)
        }))
    }

    /// The evaluation was stopped (Esc, or the user took over by submitting):
    /// the goal is kept, nothing is auto-submitted.
    fn stop_goal_evaluation(&mut self) {
        self.goal_evaluating = false;
        self.goal_eval_cancel = false;
        self.detail.clear();
        self.note("◎ goal evaluation stopped (goal kept; /goal clear to stop)");
        self.persist();
    }

    /// Act on a finished goal evaluation: auto-submit the next turn (goal
    /// unmet) or mark the goal achieved and return control (goal met).
    fn finish_goal_evaluation(
        &mut self,
        goal: crate::core::agent::goal::GoalState,
        verdict: Result<
            crate::core::agent::goal::GoalVerdict,
            tauri_plugin_agent_tools::harness_error::HarnessError,
        >,
    ) {
        self.goal_evaluating = false;
        self.goal_eval_cancel = false;
        self.detail.clear();
        // Cleared or replaced while the call was out: the verdict is stale.
        if self.goal.as_ref().map(|g| &g.condition) != Some(&goal.condition)
            || !self.goal.as_ref().is_some_and(|g| g.is_active())
        {
            return;
        }
        match verdict {
            Ok(v) => {
                if let Some(g) = self.goal.as_mut() {
                    g.last_reason = v.reason.clone();
                }
                if v.met {
                    if let Some(g) = self.goal.as_mut() {
                        g.status = crate::core::agent::goal::GoalStatus::Achieved;
                    }
                    let turns = self.goal.as_ref().map(|g| g.turns).unwrap_or(0);
                    let elapsed = self.goal.as_ref().map(|g| g.elapsed_secs()).unwrap_or(0);
                    self.system_marked(
                        GOAL_GLYPH,
                        Level::Good,
                        &format!(
                            "goal achieved in {turns} turn(s), {}",
                            fmt_duration(elapsed)
                        ),
                    );
                    self.system_detail_text(&v.reason);
                    self.persist();
                } else {
                    // Goal unmet: surface the reason as guidance and start the
                    // next turn automatically, no user prompt needed.
                    self.system_marked(
                        GOAL_GLYPH,
                        Level::Info,
                        &format!("goal not met: {} — continuing", v.reason),
                    );
                    let prompt =
                        crate::core::agent::goal::continuation_prompt(&goal.condition, &v.reason);
                    self.submit_user(prompt);
                }
            }
            Err(e) => {
                // Evaluation failed: don't loop blindly. Keep the goal so the
                // user can retry, and hand control back.
                self.note(&format!(
                    "◎ goal evaluation failed: {e} (goal kept; /goal clear to stop)"
                ));
                self.persist();
            }
        }
    }

    /// Cancel the in-flight run, keeping the conversation intact.
    fn cancel_run(&mut self) {
        // Commit whatever was streamed before the cancel so partial prose and the
        // preceding tool calls stay in the transcript, and record the partial
        // answer in history so the next turn and a later /resume both see it.
        self.abort_tool_rows();
        self.append_cancelled_turn_tools();
        // Captured before the flush clears it, like `on_done`, so a cancelled
        // turn's partial answer keeps the reasoning that produced it.
        let reasoning = self.native_reasoning_text();
        let answer = answer_without_reasoning(&self.take_answer());
        if !answer.is_empty() {
            let mut msg = serde_json::json!({ "role": "assistant", "content": answer });
            if !reasoning.is_empty() {
                msg["reasoning_content"] = serde_json::json!(reasoning);
            }
            self.history.push(msg);
        }
        self.status = Status::Idle;
        self.run_started = None;
        // A cancel sends no further event to close the compaction.
        self.run_compacting = None;
        // A cancel sends no further event to clear it.
        self.retrying = None;
        // Drop any run queued but not yet spawned (still gated on model/MCP/
        // snapshot readiness); otherwise the loop starts it once ready and the
        // cancel is silently undone.
        self.want_start = false;
        self.close_live_subagents();
        self.publish_agent_status();
        self.detail = "cancelled".to_string();
        self.scrollback = 0;
        self.system(Level::Warn, "cancelled");
        // A cancel stops the goal loop mid-flight; the goal itself is kept so
        // the user can inspect it (/goal) or clear it (/goal clear).
        self.goal_eval_pending = false;
        // Auto-dequeue the next queued message, if any
        self.dequeue_next();
        self.persist();
    }

    /// Fold this cancelled turn's completed tool calls and their results into
    /// `history` (wire form), so the model on the next prompt sees the tools it
    /// ran and what they returned instead of only the streamed prose. Without
    /// this, `self.history` only ever carries tool exchanges when the backend
    /// publishes a `MessagesUpdated` at a natural stop -- a run killed mid-way
    /// by a cancel loses them from the model's view (they still render from the
    /// display journal). Calls still in flight at the cancel are paired with a
    /// placeholder result so the exchange stays protocol-valid.
    fn append_cancelled_turn_tools(&mut self) {
        let start = self
            .display_log
            .iter()
            .rposition(|e| matches!(e, DisplayEntry::User { .. }))
            .map(|i| i + 1)
            .unwrap_or(0);
        // `display_log` is not cleared by a cancel and the fold is reached from
        // several terminal paths, so a call can already be in `history`: the
        // backend publishes a mid-turn `MessagesUpdated` on a compaction retry
        // and on the budget soft-stop, and a cancel is routinely followed by a
        // late `Error` or stream close from the aborted task. Folding it twice
        // puts the exchange on the wire twice, which invites a double execution
        // and wastes context, so ids already folded are skipped.
        let folded: std::collections::HashSet<&str> = self
            .history
            .iter()
            .filter_map(|m| m.get("tool_calls").and_then(|v| v.as_array()))
            .flatten()
            .filter_map(|tc| tc.get("id").and_then(|v| v.as_str()))
            .collect();
        let mut calls: Vec<(String, String, serde_json::Value)> = Vec::new();
        let mut results: Vec<(String, String)> = Vec::new();
        for entry in self.display_log.iter().skip(start) {
            match entry {
                DisplayEntry::ToolCall { id, name, args } if !folded.contains(id.as_str()) => {
                    calls.push((id.clone(), name.clone(), args.clone()));
                }
                DisplayEntry::ToolResult { id, content, .. } => {
                    results.push((id.clone(), content.clone()));
                }
                _ => {}
            }
        }
        if calls.is_empty() {
            return;
        }
        let tool_calls: serde_json::Value = calls
            .iter()
            .map(|(id, name, args)| {
                serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args.to_string(),
                    }
                })
            })
            .collect();
        self.history.push(serde_json::json!({
            "role": "assistant",
            "content": serde_json::Value::Null,
            "tool_calls": tool_calls,
        }));
        // Results are paired to the ids of the `tool_calls` array and emitted in
        // its order, not in the order they finished: the loop dispatches calls
        // concurrently, so an out-of-order or partial completion would otherwise
        // hand a strict endpoint results it cannot match to the calls above.
        for (id, _, _) in &calls {
            let content = results
                .iter()
                .find(|(rid, _)| rid == id)
                .map(|(_, c)| c.clone())
                .unwrap_or_else(|| super::MISSING_TOOL_RESULT.to_string());
            self.history.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": id,
                "content": content,
            }));
        }
    }
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

/// True if `buf` contains any answer prose outside `<think>` reasoning. Used to
/// decide when a tool group closes: reasoning streamed between tool calls must
/// not end the run (a reasoning model thinks before every call), only real
/// answer text does.
fn has_answer_text(buf: &str) -> bool {
    split_reasoning(buf)
        .iter()
        .any(|(reasoning, seg)| !reasoning && !seg.trim().is_empty())
}

/// Incremental form of [`thinking_open`] and [`has_answer_text`] over a buffer
/// that only grows by appending: the part already scanned is never read again.
///
/// A tag can be cut by a token boundary (`<thi` then `nk>`), so the scan stops
/// at the last `<` that could still become one and resumes there. Replaced or
/// shortened buffers are detected and rescanned from the start.
#[derive(Default, Debug)]
struct ThinkScan {
    /// Everything before this byte has been consumed.
    pos: usize,
    /// Inside an unclosed think block as of `pos`.
    open: bool,
    /// Answer prose seen outside think blocks before `pos`.
    prose: bool,
    /// The bytes just before `pos`, to notice a buffer that was swapped out.
    window: Vec<u8>,
}

impl ThinkScan {
    const WINDOW: usize = 32;

    /// `(thinking_open(buf), has_answer_text(buf))`, scanning only new text.
    fn state(&mut self, buf: &str) -> (bool, bool) {
        if !think_tags_parsed() {
            *self = Self::default();
            return (false, buf.chars().any(|c| !c.is_whitespace()));
        }
        let intact = self.pos <= buf.len()
            && buf.is_char_boundary(self.pos)
            && buf.as_bytes()[self.pos.saturating_sub(Self::WINDOW)..self.pos] == self.window[..];
        if !intact {
            *self = Self::default();
        }
        self.advance(buf);
        // What is held back as a possible partial tag still reads as prose to a
        // full scan until the tag completes.
        let tail_prose = !self.open && buf[self.pos..].chars().any(|c| !c.is_whitespace());
        (self.open, self.prose || tail_prose)
    }

    fn advance(&mut self, buf: &str) {
        let region = &buf[self.pos..];
        let mut last_end = 0;
        let mut in_think = self.open;
        for m in think_re().find_iter(region) {
            if !in_think && region[last_end..m.start()].chars().any(|c| !c.is_whitespace()) {
                self.prose = true;
            }
            in_think = !m.as_str().starts_with("</");
            last_end = m.end();
        }
        let tail = &region[last_end..];
        let hold = tail
            .rfind('<')
            .filter(|&i| tail[i + 1..].trim_start_matches('/').chars().all(|c| c.is_ascii_alphabetic() || c == ':'))
            .unwrap_or(tail.len());
        if !in_think && tail[..hold].chars().any(|c| !c.is_whitespace()) {
            self.prose = true;
        }
        self.open = in_think;
        self.pos += last_end + hold;
        let from = self.pos.saturating_sub(Self::WINDOW);
        self.window = buf.as_bytes()[from..self.pos].to_vec();
    }
}

/// `text` with its reasoning removed, for the copy that goes into `history`.
/// Reasoning never belongs in `content`; it rides along on the message's
/// `reasoning_content` instead (see `on_done`), and the display journal is what
/// keeps it for a resume.
pub(crate) fn answer_without_reasoning(text: &str) -> String {
    split_reasoning(text)
        .into_iter()
        .filter_map(|(reasoning, seg)| (!reasoning).then_some(seg))
        .collect::<String>()
        .trim()
        .to_string()
}

/// A leading markdown list/blockquote marker (`> `, `- `, `1. `), stripped
/// before checking whether a line reads as a question.
fn markdown_prefix_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*").unwrap())
}

/// A leading label like `Q:`, `Question 2:`, `Ask:`.
fn prompt_label_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*").unwrap())
}

/// A line starting with a question word (what/how/can/should/...).
fn question_word_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b",
        )
        .unwrap()
    })
}

/// A line directly addressing the user ("you", "your", "we", "our").
fn user_directed_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)\b(?:you|your|we|our)\b").unwrap())
}

/// An explicit request for the user to respond ("let me know", "please
/// confirm"), independent of a trailing question mark.
fn response_cue_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b",
        )
        .unwrap()
    })
}

/// True when the assistant's final line reads as a question or an explicit
/// request for the user to respond, rather than the model idling mid-task
/// with work still open. A plain-text cue counts just as much as the
/// structured `ask` tool -- either way, the todo reminder must not talk over
/// the assistant's own question by nudging it to "keep working."
fn assistant_is_awaiting_user_answer(text: &str) -> bool {
    let Some(last_line) = text
        .split(['\n', '\r'])
        .map(str::trim)
        .rfind(|l| !l.is_empty())
    else {
        return false;
    };
    let without_markdown = markdown_prefix_re().replace(last_line, "");
    let without_markdown = without_markdown.trim();
    let without_label = prompt_label_re().replace(without_markdown, "");
    let without_label = without_label.trim();
    let had_label = without_label != without_markdown;
    let is_question = without_label.ends_with('?') || without_label.ends_with('？');
    if is_question
        && (had_label
            || question_word_re().is_match(without_label)
            || user_directed_re().is_match(without_label))
    {
        return true;
    }
    let without_trailing_punct = without_label.trim_end_matches(['.', '!', '?', '。', '！', '？']);
    response_cue_re().is_match(without_trailing_punct)
}

fn think_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"</?[a-zA-Z:]*think>").unwrap())
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

/// Run `f` with `<think>` parsing off on this thread only.
#[cfg(test)]
fn without_think_tags<T>(f: impl FnOnce() -> T) -> T {
    PARSE_THINK_TAGS_OVERRIDE.with(|c| c.set(Some(false)));
    let out = f();
    PARSE_THINK_TAGS_OVERRIDE.with(|c| c.set(None));
    out
}

/// Split assistant text into `(is_reasoning, segment)` runs by `<think>` /
/// `<mm:think>` tags (tags themselves dropped). An unterminated open tag makes
/// the trailing text reasoning, which keeps live streaming clean.
///
/// With `think_tags = false` in `~/.jan/config.toml` the tags carry no meaning:
/// the whole text is one answer run, so it renders verbatim and stays in the
/// answer that goes back as history.
fn split_reasoning(text: &str) -> Vec<(bool, String)> {
    if !think_tags_parsed() {
        return if text.is_empty() {
            Vec::new()
        } else {
            vec![(false, text.to_string())]
        };
    }
    let mut out = Vec::new();
    let mut in_think = false;
    let mut last = 0;
    for m in think_re().find_iter(text) {
        let seg = &text[last..m.start()];
        if !seg.is_empty() {
            out.push((in_think, seg.to_string()));
        }
        in_think = !m.as_str().starts_with("</");
        last = m.end();
    }
    let seg = &text[last..];
    if !seg.is_empty() {
        out.push((in_think, seg.to_string()));
    }
    out
}

/// Interleave a turn's answer prose with its natively streamed reasoning
/// segments into `(is_reasoning, run)` in emission order -- the one form every
/// consumer (live tail, committed rows, replay) reads.
///
/// The two sources stay apart end to end: native reasoning arrives structurally
/// and is placed by its offset, never encoded into the prose, while an
/// inline-tag provider's `<think>` markers are found by `split_reasoning` inside
/// the prose runs alone. So a model writing about `<think>` tags cannot close a
/// native block, and the `think_tags` gate governs only the inline case.
///
/// Offsets come from `prose.len()` at emission time, so they are always char
/// boundaries and always ascending.
fn assistant_runs(prose: &str, segs: &[ReasoningSeg]) -> Vec<(bool, String)> {
    if segs.is_empty() {
        return split_reasoning(prose);
    }
    let mut out = Vec::new();
    let mut last = 0;
    for seg in segs {
        let at = seg.at.min(prose.len()).max(last);
        out.extend(split_reasoning(&prose[last..at]));
        let text = seg.text.trim_end();
        if !text.is_empty() {
            out.push((true, text.to_string()));
        }
        last = at;
    }
    out.extend(split_reasoning(&prose[last..]));
    out
}

/// True if `text` ends inside an unclosed ` think>` block (an opening tag whose
/// matching close has not yet streamed). Used to show `[thinking]` while
/// reasoning streams. Re-uses the same tag matcher as `split_reasoning`.
#[cfg(test)]
fn thinking_open(text: &str) -> bool {
    if !think_tags_parsed() {
        return false;
    }
    let mut open = false;
    for m in think_re().find_iter(text) {
        open = !m.as_str().starts_with("</");
    }
    open
}

/// True if the turn has any non-whitespace content in any reasoning/answer run.
fn assistant_has_content(prose: &str, segs: &[ReasoningSeg]) -> bool {
    assistant_runs(prose, segs)
        .iter()
        .any(|(_, seg)| !seg.trim().is_empty())
}

/// `Kind` of the first non-empty run the live tail will render, so the leading
/// separator can mirror `gap` exactly: reasoning shares the `Tool` band, so a
/// tool call followed by streaming reasoning gets no blank, while streaming
/// prose still opens with one.
fn live_leading_kind(prose: &str, segs: &[ReasoningSeg]) -> Option<Kind> {
    assistant_runs(prose, segs)
        .into_iter()
        .find(|(_, seg)| !seg.trim().is_empty())
        .map(|(reasoning, _)| if reasoning { Kind::Reasoning } else { Kind::Prose })
}

/// `Kind` of the last non-empty run the live tail renders, so a row appended
/// below it (an awaiting/starting throbber) can gap against what actually
/// precedes it rather than always inserting a blank.
fn live_trailing_kind(prose: &str, segs: &[ReasoningSeg]) -> Option<Kind> {
    assistant_runs(prose, segs)
        .into_iter()
        .rev()
        .find(|(_, seg)| !seg.trim().is_empty())
        .map(|(reasoning, _)| if reasoning { Kind::Reasoning } else { Kind::Prose })
}

/// Regex matching `<system>`, `<system-notice>`, `<system-directive>`,
/// `<system-conventions>`, etc. - any XML tag named `system` or `system-*`.
/// Complete tags (`<system-notice>...</system-notice>`) are matched first; when
/// no closing tag exists, everything from the opening tag to end-of-string is
/// consumed. A bare word like `<systemic>` is not a tag and passes through.
fn system_tag_re() -> &'static regex::Regex {
    use std::sync::LazyLock;
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?s)<system(?:-[a-zA-Z]+)?>.*?</system(?:-[a-zA-Z]+)?>|<system(?:-[a-zA-Z]+)?>.*$",
        )
        .unwrap()
    });
    &RE
}

/// Strip harness-injected `<system...>` XML tags from assistant text so the
/// user never sees raw markup. These tags carry internal instructions that
/// should not be rendered in the TUI transcript.
fn strip_system_xml_tags(text: &str) -> String {
    system_tag_re().replace_all(text, "").to_string()
}

/// The args a new run starts from: the session's, with the approval mode
/// `/mode` set on `app.args` (a copy-on-write clone the session's args never
/// see), so `/mode ask` actually gates the next run.
fn run_args(app: &App, args: &Arc<OrchestrationArgs>) -> Arc<OrchestrationArgs> {
    match app.args.as_ref() {
        Some(set) if set.auto_approve != args.auto_approve || set.bypass != args.bypass => {
            let mut next = (**args).clone();
            next.auto_approve = set.auto_approve;
            next.bypass = set.bypass;
            Arc::new(next)
        }
        _ => Arc::clone(args),
    }
}

fn spawn_run(args: &Arc<OrchestrationArgs>, body: serde_json::Value) -> CurrentRun {
    let (tx, rx) = mpsc::unbounded_channel::<StreamEvent>();
    let (steering_tx, steering) = mpsc::unbounded_channel();
    let args = Arc::clone(args);
    let handle = tokio::spawn(async move {
        let _ = run_orchestration_steered(&tx, &body, &args, Some(&steering_tx)).await;
    });
    CurrentRun {
        rx,
        steering,
        handle,
    }
}

/// Await the next event of the active run, or park forever when idle.
async fn next_event(current: &mut Option<CurrentRun>) -> RunEvent {
    match current {
        Some(c) => tokio::select! {
            // Preserve event order: commit streamed prose/tool results before
            // showing the user message accepted at their boundary.
            biased;
            event = c.rx.recv() => RunEvent::Stream(event),
            Some(request) = c.steering.recv() => RunEvent::Steering(request),
        },
        None => pending().await,
    }
}

/// Await the background MCP-connect task once, returning the connected server
/// names (empty if none / on task failure).
///
/// The handle is borrowed, not taken: this future is rebuilt (and dropped) every
/// select iteration, so taking it would discard the still-running task the first
/// time another branch wins the race. The slot is cleared only on completion.
async fn await_mcp(
    task: &mut Option<tokio::task::JoinHandle<crate::core::cli::mcp::ConnectOutcome>>,
) -> crate::core::cli::mcp::ConnectOutcome {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.unwrap_or_default()
}

/// Run one git snapshot (and ref update) off the render loop. Returns the
/// snapshot sha. Only `changed` (the paths touched this turn) are staged, so
/// this stays fast regardless of repo size; the blocking `git` work still runs
/// on a blocking thread so the UI stays responsive.
fn spawn_snapshot(
    repo: PathBuf,
    parent: Option<String>,
    msg: String,
    thread_id: String,
    changed: Vec<PathBuf>,
) -> tokio::task::JoinHandle<Result<String, String>> {
    tokio::task::spawn_blocking(move || {
        let sha = git::snapshot(&repo, parent.as_deref(), &msg, &thread_id, &changed)?;
        git::update_ref(&repo, &thread_id, &sha)?;
        Ok(sha)
    })
}

/// Await the in-flight snapshot task once, clearing the slot. Same cancel-safe
/// borrow as `await_mcp`; pends forever when idle.
async fn await_snapshot(
    task: &mut Option<tokio::task::JoinHandle<Result<String, String>>>,
) -> Result<String, String> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    match joined {
        Ok(inner) => inner,
        Err(e) => Err(format!("snapshot task failed: {e}")),
    }
}

/// Await an in-flight `/mcp` job, parking forever when none is running so this
/// can sit in the loop's `select!` unconditionally.
async fn await_mcp_job(
    task: &mut Option<tokio::task::JoinHandle<McpJobDone>>,
) -> Option<McpJobDone> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    // A cancelled or panicked job is dropped rather than reported: the only
    // paths that abort it have already told the user why.
    joined.ok()
}

/// Await an in-flight `/context` report, parking forever when none is running
/// so this can sit in the loop's `select!` unconditionally.
/// A `/usage` lookup's query and what the provider answered.
type UsageDone = (
    crate::core::cli::tokamak::usage::Query,
    Result<crate::core::cli::tokamak::usage::Payload, crate::core::cli::tokamak::usage::UsageError>,
);

async fn await_usage(task: &mut Option<tokio::task::JoinHandle<UsageDone>>) -> Option<UsageDone> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.ok()
}

/// Write a `/usage` answer into the transcript. Every line says it is what the
/// provider recorded; a failure is reported as one, never as a zero charge.
fn finish_usage(app: &mut App, (query, result): UsageDone) {
    match result {
        Ok(payload) => {
            app.note(&format!("usage ({}), as recorded by Tokamak:", query.label()));
            for line in crate::core::cli::usage_view::reported_usage_lines(
                &query,
                &payload,
                crate::core::cli::usage_view::Fold::Fixed,
            ) {
                app.system_detail_text(&line);
            }
        }
        Err(e) => app.note(&format!("usage ({}): {e}", query.label())),
    }
}

async fn await_context(
    task: &mut Option<tokio::task::JoinHandle<ContextReport>>,
) -> Option<ContextReport> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    // A panicked job is dropped rather than reported: the overlay stays on
    // its loading state and the user just closes it.
    joined.ok()
}

/// Await an in-flight `/login` verification, parking forever when none is
/// running so this can sit in the loop's `select!` unconditionally.
async fn await_login(
    task: &mut Option<
        tokio::task::JoinHandle<
            Result<crate::core::cli::auth::LoginResult, crate::core::cli::auth::LoginError>,
        >,
    >,
) -> Result<crate::core::cli::auth::LoginResult, crate::core::cli::auth::LoginError> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    match joined {
        Ok(inner) => inner,
        Err(e) => Err(crate::core::cli::auth::LoginError::Unavailable(format!(
            "sign-in task failed: {e}"
        ))),
    }
}

async fn await_tokamak_login(
    task: &mut Option<tokio::task::JoinHandle<Result<super::tokamak::Login, String>>>,
) -> Result<super::tokamak::Login, String> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.map_err(|e| format!("Tokamak sign-in task failed: {e}"))?
}

/// Await the session-creation half of the browser sign-in, parking forever when
/// none is running so this can sit in the loop's `select!` unconditionally.
async fn await_login_begin(
    task: &mut Option<
        tokio::task::JoinHandle<
            Result<super::device_auth::PendingAuth, super::device_auth::BeginError>,
        >,
    >,
) -> Result<super::device_auth::PendingAuth, super::device_auth::BeginError> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    match joined {
        Ok(inner) => inner,
        Err(e) => Err(super::device_auth::BeginError::Failed(format!(
            "sign-in task failed: {e}"
        ))),
    }
}

/// How often the dock's branch indicator re-reads `HEAD`, so a checkout made
/// outside the TUI (another terminal, an editor) shows up without needing a
/// restart. Cheap (`rev-parse --abbrev-ref HEAD`) but still shells out, so this
/// is a poll, not every tick.
const BRANCH_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The hint rows for an `@query`, from a blocking directory read. A query that
/// climbs out of the project (`..`) gets none: hints are for the project.
fn search_path_hints(root: &std::path::Path, query: &str) -> Vec<PathHintItem> {
    if query.split(['/', '\\']).any(|part| part == "..") {
        return Vec::new();
    }
    path_refs::search_files_sync(root, query, 30)
        .into_iter()
        .map(|(path, name, is_dir)| PathHintItem { path, name, is_dir })
        .collect()
}

type PathHintTask = tokio::task::JoinHandle<(u64, Vec<PathHintItem>)>;

fn spawn_path_hint_search(generation: u64, root: PathBuf, query: String) -> PathHintTask {
    tokio::task::spawn_blocking(move || (generation, search_path_hints(&root, &query)))
}

/// Await the in-flight hint search once, clearing the slot. Same cancel-safe
/// borrow as `await_branch_poll`; pends forever when idle.
async fn await_path_hints(task: &mut Option<PathHintTask>) -> Option<(u64, Vec<PathHintItem>)> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.ok()
}

/// Re-read the current git branch off-loop (a blocking `git` call), only when
/// no poll is already in flight. A no-op when the project isn't a git repo.
fn spawn_branch_poll(project_root: &std::path::Path) -> tokio::task::JoinHandle<Option<String>> {
    let root = project_root.to_path_buf();
    tokio::task::spawn_blocking(move || git::current_branch(&root))
}

/// Await an in-flight branch poll once, clearing the slot. Same cancel-safe
/// borrow as `await_mcp`; pends forever when idle.
async fn await_branch_poll(
    task: &mut Option<tokio::task::JoinHandle<Option<String>>>,
) -> Option<String> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.ok().flatten()
}

/// Await an in-flight `/plugin install`, parking forever when none is running.
/// Same cancel-safe borrow as `await_mcp`.
async fn await_plugin_install(
    task: &mut Option<
        tokio::task::JoinHandle<Result<crate::core::agent::plugins::GitInstall, String>>,
    >,
) -> Result<crate::core::agent::plugins::GitInstall, String> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    match joined {
        Ok(inner) => inner,
        Err(e) => Err(format!("plugin install task failed: {e}")),
    }
}

/// Hint text marking a plugin row already installed (see `finish_plugin_install`
/// and the PluginSelect Space guard). Kept as a named constant so a label rename
/// can't silently re-enable toggling on installed rows.
const INSTALLED_HINT: &str = "installed";

/// Report a plugin install. Clears the in-flight flag so the next request is
/// accepted. A collection source installed nothing yet: it opens the picker so
/// the user chooses which plugins to install. The flag is cleared here the
/// moment the listing opens the picker, so a second `/plugin install` during
/// that picker-open window is allowed and, if it is also a collection,
/// replaces the open picker (only one clone is ever in flight -- the
/// `plugin_install_task` guard holds).
fn finish_plugin_install(
    app: &mut App,
    url: Option<String>,
    result: Result<crate::core::agent::plugins::GitInstall, String>,
) {
    use crate::core::agent::plugins::GitInstall;
    app.plugin_installing = false;
    match result {
        Ok(GitInstall::Installed(plugins)) => {
            app.refresh_slash_catalog();
            if plugins.is_empty() {
                app.note("nothing installed");
            }
            for p in plugins {
                app.note(&format!(
                    "installed plugin '{}' ({} skills)",
                    p.name, p.skills
                ));
            }
        }
        Ok(GitInstall::Collection(candidates)) => {
            let Some(url) = url else {
                app.note("ERROR: lost the collection source URL");
                return;
            };
            app.note(&format!(
                "{} is a collection of {} plugins - pick which to install",
                url,
                candidates.len()
            ));
            app.picker = Some(Picker {
                kind: PickerKind::PluginSelect,
                items: candidates
                    .into_iter()
                    .map(|c| PickerItem {
                        value: c.path.clone(),
                        label: c.path,
                        hint: c.installed.then(|| INSTALLED_HINT.to_string()),
                        checkbox: Some(false),
                    })
                    .collect(),
                selected: 0,
                armed_delete: None,
            });
            app.plugin_collection_url = Some(url);
        }
        Err(e) => app.note(&e),
    }
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

/// Apply one event from the active run's stream, clearing `current` on a
/// terminal one. `None` is a stream that closed without a terminal event (an
/// aborted task).
async fn apply_stream_event(
    app: &mut App,
    ev: Option<StreamEvent>,
    current: &mut Option<CurrentRun>,
) {
    match ev {
        Some(StreamEvent::Done { stop_reason, usage }) => {
            app.on_done(stop_reason, usage);
            *current = None;
            app.check_context_pressure();
            // Auto-compact when approaching the context limit. Handed to
            // the loop like `/compact` so the summarizing call runs off
            // the render loop.
            if app.should_auto_compact() && app.compacting.is_none() {
                app.compact_request = Some(CompactKind::Auto);
            }
        }
        Some(StreamEvent::Error { code, message }) => {
            app.on_error(code, message);
            *current = None;
        }
        // Each model roundtrip is one turn toward the finished-todo
        // aging grace period. A single run can span many tool-call
        // turns, so aging must count turns, not runs -- otherwise a
        // finished plan lingers through the rest of a long run.
        Some(ev @ StreamEvent::Step { .. }) => {
            app.apply(ev);
            age_closed_todos(app).await;
        }
        Some(other) => app.apply(other),
        None => {
            // Stream closed without a terminal event (aborted task).
            // Keep any partial prose/tool calls already streamed.
            app.pending_queue.clear();
            if app.status == Status::Running {
                app.flush_assistant();
                app.abort_tool_rows();
                // The task was killed without a natural stop, so calls of the
                // step in progress were never published -- fold them here,
                // exactly as the cancel/error paths do; calls already
                // published are skipped by id.
                app.append_cancelled_turn_tools();
                app.status = Status::Idle;
                app.run_started = None;
            }
            // A closed stream must not leave the terminal reporting a running turn.
            app.publish_agent_status();
            // Auto-dequeue the next queued message
            app.dequeue_next();
            *current = None;
        }
    }
}

/// How many events one drain pass applies before handing control back to the
/// render loop, so a run that emits faster than the loop can drain still
/// yields to the keyboard poll.
const EVENT_DRAIN_MAX: usize = 512;

/// Apply every event already sitting in the run's channel, then return how many
/// landed. A file-sized `write` streams its arguments in thousands of deltas
/// (measured: 7000 for a 314KB file), and the loop draws once per iteration, so
/// handling one event per pass means thousands of full repaints for a preview
/// that only ever shows its last few lines. Draining first collapses a burst
/// into a single frame. Stops early on a terminal event, which clears `current`
/// -- nothing queued behind it belongs to a finished run.
async fn drain_stream_events(app: &mut App, current: &mut Option<CurrentRun>) -> usize {
    let mut applied = 0;
    while applied < EVENT_DRAIN_MAX {
        let Some(ev) = current.as_mut().and_then(|c| c.rx.try_recv().ok()) else {
            break;
        };
        apply_stream_event(app, Some(ev), current).await;
        applied += 1;
    }
    applied
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

/// Wheel, drag-to-select and click-to-expand. Press/release are split: the
/// toggle fires on release and only when the pointer never moved, so a drag that
/// starts on a folded row selects text instead of expanding it.
fn handle_mouse(app: &mut App, mouse: MouseEvent) {
    // Wheel scrolls the transcript (clamped to `max_back` on the next draw);
    // one notch matches a single arrow-key step. Scrolling moves the content out
    // from under a finished selection, so it drops one.
    match mouse.kind {
        MouseEventKind::ScrollUp => {
            app.clear_selection();
            app.scrollback = app.scrollback.saturating_add(1);
        }
        MouseEventKind::ScrollDown => {
            app.clear_selection();
            app.scrollback = app.scrollback.saturating_sub(1);
        }
        MouseEventKind::Down(MouseButton::Left) => {
            app.copy_armed = false;
            let mode = if mouse.modifiers.contains(KeyModifiers::ALT) {
                SelectionMode::Block
            } else {
                SelectionMode::Linear
            };
            app.selection = Some(Selection::new((mouse.column, mouse.row), mode));
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if let Some(sel) = app.selection.as_mut() {
                let at = (mouse.column, mouse.row);
                sel.moved |= at != sel.anchor;
                sel.head = at;
            }
        }
        MouseEventKind::Up(MouseButton::Left) => {
            let Some(sel) = app.selection.as_mut() else {
                return;
            };
            sel.dragging = false;
            if sel.moved {
                // The text lives in the rendered buffer, which only `draw` has;
                // it copies on the next frame (<=50ms).
                app.copy_armed = true;
            } else {
                app.clear_selection();
                click_region(app, mouse.column, mouse.row);
            }
        }
        _ => {}
    }
}

/// A click that never became a drag: expand or collapse the region whose summary
/// row it landed on. Ignores clicks outside the transcript viewport or on rows
/// that aren't a region's own summary row (detail lines, blank padding, etc).
fn click_region(app: &mut App, column: u16, row: u16) {
    let rect = app.transcript_rect;
    if column < rect.x
        || column >= rect.x + rect.width
        || row <= rect.y
        || row >= rect.y + rect.height.saturating_sub(1)
    {
        return;
    }
    // Top border consumes one row; the rest maps 1:1 onto `row_index`, which is
    // built in the body's own wrapped screen coordinates.
    let body_row = (row - rect.y - 1) as usize;
    if let Some(Some(idx)) = app.row_index.get(body_row) {
        // A folded trace header expands its whole run; any other row toggles its
        // own detail.
        if app.is_folded_trace_start(*idx) {
            app.toggle_trace(*idx);
        } else {
            app.toggle_region(*idx);
        }
    }
}

/// Extend a held drag past the top or bottom edge of the transcript by scrolling
/// a row per frame toward the pointer. Only nudges `scrollback`; `draw` clamps it
/// and shifts the anchor by however much the view actually moved.
fn autoscroll_selection(app: &mut App) {
    let Some(sel) = app.selection.filter(|s| s.dragging) else {
        return;
    };
    let rect = app.transcript_rect;
    if rect.height <= 2 {
        return;
    }
    if sel.head.1 <= rect.y {
        app.scrollback = app.scrollback.saturating_add(1);
    } else if sel.head.1 >= rect.y + rect.height.saturating_sub(1) {
        app.scrollback = app.scrollback.saturating_sub(1);
    }
}

/// Lift the selected cells out of a rendered frame. Rows are joined with
/// newlines and stripped of trailing padding, so a copied command pastes as the
/// command and not as the width of the terminal.
fn selection_text(buf: &Buffer, sel: Selection, area: Rect) -> String {
    sel.spans(area.width)
        .into_iter()
        .filter(|(row, _, _)| *row < area.height)
        .filter_map(|(row, c0, c1)| {
            // Wide glyphs park an empty symbol in their second cell, so plain
            // concatenation already reconstructs them.
            let cells = (c0..=c1).filter_map(|col| buf.cell((col, row))).collect();
            copy_selection_line(cells)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn copy_selection_line(cells: Vec<&ratatui::buffer::Cell>) -> Option<String> {
    let is_panel_chrome = |cell: &&ratatui::buffer::Cell| {
        cell.style().fg == Some(ratatui::style::Color::DarkGray)
            && matches!(cell.symbol(), "│" | "┌" | "└" | "┐" | "┘" | "─" | "┊" | " ")
    };

    let Some(start) = cells.iter().position(|cell| !is_panel_chrome(cell)) else {
        let has_corner_or_rule = cells
            .iter()
            .any(|cell| matches!(cell.symbol(), "┌" | "└" | "┐" | "┘" | "─"));
        return if has_corner_or_rule {
            None
        } else {
            Some(String::new())
        };
    };
    let Some(end) = cells.iter().rposition(|cell| !is_panel_chrome(cell)) else {
        return Some(String::new());
    };
    let line: String = cells[start..=end]
        .iter()
        .map(|cell| cell.symbol())
        .collect();

    Some(line.trim_end().to_string())
}

/// Writes `text` to the macOS pasteboard through `pbcopy`.
///
/// Not `arboard`: its AppKit write logs `-[NSPasteboard _setData:...] returns
/// false` to stderr whenever the pasteboard is contended, and stderr is the
/// terminal the TUI is drawing on, so the line lands on top of the screen.
#[cfg(target_os = "macos")]
fn set_system_clipboard(text: String) {
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = std::io::Write::write_all(&mut stdin, text.as_bytes());
    }
    let _ = child.wait();
}

#[cfg(not(target_os = "macos"))]
fn set_system_clipboard(text: String) {
    let Ok(mut clip) = arboard::Clipboard::new() else {
        return;
    };
    // X11/Wayland ownership lives with the setter, so this thread parks
    // inside `wait()` until something else claims the clipboard; returning
    // immediately would drop the text on the floor.
    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        let _ = clip.set().wait().text(text);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = clip.set_text(text);
    }
}

/// Put a selection on the system clipboard by both routes available to a TUI:
/// the OS clipboard, which serves it for as long as this process runs, and
/// OSC 52, which hands it to the terminal emulator so it survives `jan`
/// exiting and crosses an ssh/tmux session. OSC 52 goes second so that where it
/// is supported the terminal ends up owning the selection.
fn copy_to_clipboard(text: &str) {
    let owned = text.to_string();
    std::thread::spawn(move || set_system_clipboard(owned));
    if text.len() <= OSC52_MAX_BYTES {
        use base64::Engine;
        let payload = base64::engine::general_purpose::STANDARD.encode(text);
        let mut out = io::stdout();
        let _ = write!(out, "\x1b]52;c;{payload}\x07");
        let _ = out.flush();
    }
}

async fn resolve_front_ask(
    app: &mut App,
    registry: &crate::core::agent::interaction::AskRegistry,
    cancelled: bool,
) {
    let Some(ask) = app.ask_queue.pop_front() else {
        return;
    };
    app.publish_agent_status();
    // Reserved plan-review ask: a single question with the exact id drives the
    // mode transition. Capture the chosen label before `answers` is moved into
    // the outcome. Skipped on cancel so a cancelled review never changes mode.
    let plan_choice = (!cancelled
        && ask.request.questions.len() == 1
        && ask.request.questions[0].id == crate::core::agent::plan::PLAN_REVIEW_QUESTION_ID)
        .then(|| {
            ask.answers
                .first()
                .and_then(|a| a.selected.first().cloned())
        })
        .flatten();
    let plan_summary = ask
        .request
        .questions
        .first()
        .map(|q| q.question.clone())
        .unwrap_or_default();
    let outcome = if cancelled {
        Err(crate::core::agent::interaction::AskError::Cancelled)
    } else {
        Ok(ask.answers)
    };
    // Always respond so the model's in-flight turn completes normally.
    let _ = crate::core::agent::interaction::respond(registry, &ask.request_id, outcome).await;
    if let Some(label) = plan_choice {
        apply_plan_review(app, &label, &plan_summary);
    }
}

/// Drive the plan-mode transition from a `plan_review` answer. The model has
/// already staged todos via `todo(init)` earlier in the same turn; here we only
/// flip the mode (and, for Execute, queue the continuation turn). Persists so
/// the mode survives resume.
/// The only thing a fresh-context execution starts from: the plan summary and
/// every staged todo, phase by phase.
fn fresh_plan_message(summary: &str, todos: &crate::core::agent::todo::TodoList) -> String {
    let mut out = String::from(
        "Implement the plan below. The earlier conversation was cleared on purpose, so work from this plan alone and read the project as needed.\n\n",
    );
    if !summary.trim().is_empty() {
        out.push_str(&format!("Plan: {}\n\n", summary.trim()));
    }
    for phase in &todos.phases {
        out.push_str(&format!("## {}\n", phase.name));
        for task in &phase.tasks {
            out.push_str(&format!("- {}\n", task.content));
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

fn apply_plan_review(app: &mut App, label: &str, summary: &str) {
    use crate::core::agent::plan::{self, RunMode};
    match label {
        plan::EXECUTE_PLAN_LABEL => {
            // Atomic handoff: refuse to leave Plan unless the plan was actually
            // staged (spec: failed todo init keeps the agent in Plan intact).
            if app.todos.is_empty() {
                app.note("cannot execute: no plan staged (todo init first); staying in plan mode");
                return;
            }
            app.run_mode = RunMode::Normal;
            app.persist();
            app.note("▶ executing plan (normal mode)");
            // Enqueues while the ask turn is still running; on_done dequeues it,
            // starting execution only after the mode switch has committed.
            app.submit_user("Proceed with the plan.".to_string());
        }
        plan::EXECUTE_FRESH_LABEL => {
            if app.todos.is_empty() {
                app.note("cannot execute: no plan staged (todo init first); staying in plan mode");
                return;
            }
            app.run_mode = RunMode::Normal;
            app.persist();
            app.note("▶ executing plan in a fresh context (normal mode)");
            let message = fresh_plan_message(summary, &app.todos);
            // Queued like "Execute plan": the ask turn finishes first, then the
            // conversation is cleared and this is the only thing the model sees.
            app.message_queue.push_back(PendingMessage {
                text: "Implement the plan (fresh context).".to_string(),
                message: serde_json::json!({ "role": "user", "content": message }),
                images: Vec::new(),
                display: true,
                invocation: None,
                run_mode: Some(app.run_mode),
                fresh_context: true,
            });
            if app.status != Status::Running {
                app.dequeue_next();
            }
        }
        plan::KEEP_PLANNING_LABEL => app.note("continuing to plan (read only)"),
        plan::EXIT_PLAN_LABEL => {
            app.run_mode = RunMode::Normal;
            app.persist();
            app.note("exited plan mode (no execution)");
        }
        other => app.note(&format!("unknown plan review choice: {other}")),
    }
}

/// Handle keys owned by the front interactive question. Returns false only for
/// global Ctrl-C/Ctrl-D, which must continue into the normal run cancellation
/// path after every ask waiter has been released.
async fn handle_ask_key(
    app: &mut App,
    key: KeyEvent,
    registry: &crate::core::agent::interaction::AskRegistry,
) -> bool {
    // A docked prompt owns the keyboard, and `handle_ask_key` runs before
    // `handle_key` -- without this an ask queued by the running agent would
    // swallow the secret being typed into `/login` and echo it into a custom
    // answer that is then submitted to the model.
    if app.ask_queue.is_empty() || app.blocking_dock().is_some() {
        return false;
    }
    if key.kind == KeyEventKind::Release {
        return true;
    }
    let ctrl = key_is_ctrl(&key);
    // A docked ask runs before `handle_key`, so the repaint key is honoured
    // here too -- otherwise a broadcast landing during a question stays on
    // screen until it is answered. Consumed, never typed into the answer.
    if ctrl && key.code == KeyCode::Char('l') {
        app.request_repaint();
        return true;
    }
    if ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')) {
        crate::core::agent::interaction::cancel_all(registry).await;
        app.ask_queue.clear();
        return false;
    }
    if key.code == KeyCode::Esc {
        resolve_front_ask(app, registry, true).await;
        return true;
    }

    let mut submit = false;
    {
        let ask = app.ask_queue.front_mut().expect("checked non-empty above");
        if ask.editing_custom {
            match key.code {
                KeyCode::Enter => submit = ask.accept_custom(),
                KeyCode::Backspace => {
                    ask.custom_input.pop();
                }
                KeyCode::Char(ch) if !ctrl => ask.custom_input.push(ch),
                _ => {}
            }
        } else {
            match key.code {
                KeyCode::Up => ask.move_selection(-1),
                KeyCode::Down => ask.move_selection(1),
                KeyCode::Left => ask.move_question(-1),
                KeyCode::Right => ask.move_question(1),
                KeyCode::Char(' ') if ask.question().multi => {
                    submit = ask.choose();
                }
                KeyCode::Enter => submit = ask.choose(),
                _ => {}
            }
        }
    }
    if submit {
        resolve_front_ask(app, registry, false).await;
    }
    true
}

/// `/bug`: show what a diagnostic bundle for this session would hold;
/// `/bug show <member>` prints one member's redacted content; `/bug save`
/// writes exactly the bundle last shown. Local only: nothing is uploaded, and
/// writing the file is the last thing it does. Needs no model, so it works
/// even when the bug being reported froze the session.
fn bug_report_command(app: &mut App, arg: &str) {
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
    match super::doctor::prepare(&threads_base, &data_folder, thread_id.as_deref(), None) {
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

/// One snapshot for [`ThreadSaver`].
struct ThreadSave {
    base: std::path::PathBuf,
    id: String,
    model: String,
    history: Vec<serde_json::Value>,
    metadata: Option<serde_json::Value>,
}

enum ThreadSaveJob {
    Save(ThreadSave),
    Flush(std::sync::mpsc::Sender<()>),
}

/// Writes thread snapshots on a dedicated thread, in the order queued, so the
/// newest snapshot is always the last one written.
struct ThreadSaver {
    tx: Option<std::sync::mpsc::Sender<ThreadSaveJob>>,
    handle: Option<std::thread::JoinHandle<()>>,
    error: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl ThreadSaver {
    fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<ThreadSaveJob>();
        let error = std::sync::Arc::new(std::sync::Mutex::new(None));
        let sink = error.clone();
        let handle = std::thread::spawn(move || {
            for job in rx {
                match job {
                    ThreadSaveJob::Save(s) => {
                        if let Err(e) = super::cli_save_thread(
                            &s.base,
                            Some(&s.id),
                            &s.model,
                            &s.history,
                            s.metadata,
                        ) {
                            if let Ok(mut slot) = sink.lock() {
                                *slot = Some(e);
                            }
                        }
                    }
                    ThreadSaveJob::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        Self {
            tx: Some(tx),
            handle: Some(handle),
            error,
        }
    }

    fn save(&self, save: ThreadSave) {
        if let Some(tx) = self.tx.as_ref() {
            let _ = tx.send(ThreadSaveJob::Save(save));
        }
    }

    /// Block until every save queued before this call has been written.
    fn flush(&self) {
        let Some(tx) = self.tx.as_ref() else {
            return;
        };
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        if tx.send(ThreadSaveJob::Flush(done_tx)).is_ok() {
            let _ = done_rx.recv();
        }
    }

    fn take_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|mut slot| slot.take())
    }
}

impl Drop for ThreadSaver {
    fn drop(&mut self) {
        drop(self.tx.take());
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

async fn handle_ask_mouse(
    app: &mut App,
    mouse: MouseEvent,
    registry: &crate::core::agent::interaction::AskRegistry,
) -> bool {
    if app.blocking_dock().is_some() {
        return false;
    }
    let Some(ask) = app.ask_queue.front_mut() else {
        return false;
    };
    if !matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
        return true;
    }
    let inside = mouse.column >= ask.rect.x
        && mouse.column < ask.rect.x.saturating_add(ask.rect.width)
        && mouse.row >= ask.rect.y
        && mouse.row < ask.rect.y.saturating_add(ask.rect.height);
    if !inside {
        return true;
    }
    let Some((_, selected)) = ask
        .row_hitboxes
        .iter()
        .find(|(row, _)| *row == mouse.row)
        .copied()
    else {
        return true;
    };
    ask.selected = selected;
    let submit = ask.choose();
    if submit {
        resolve_front_ask(app, registry, false).await;
    }
    true
}

/// Keys for the `/login` prompt. Enter hands the key to the loop for
/// verification (`login_submit`); Esc or Ctrl-C abandons sign-in. While a
/// verification is in flight the field is read-only, so a stray keystroke cannot
/// edit the key being checked -- but Esc still cancels, so the prompt can never
/// wedge the TUI.
fn handle_login_key(app: &mut App, key: KeyEvent, ctrl: bool) {
    let cancel = key.code == KeyCode::Esc
        || (ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')));
    if cancel {
        app.login = None;
        app.login_submit = None;
        return;
    }
    // The browser question owns the keyboard until it is answered, so a
    // keystroke meant for it can never fall through into the key field.
    if app
        .login
        .as_ref()
        .is_some_and(|p| p.unconfirmed_url().is_some())
    {
        if ctrl {
            return;
        }
        match key.code {
            KeyCode::Enter | KeyCode::Char('y') | KeyCode::Char('Y') => {
                resolve_login_browser(app, true)
            }
            KeyCode::Char('n') | KeyCode::Char('N') => resolve_login_browser(app, false),
            _ => {}
        }
        return;
    }

    // Ctrl-V: terminals deliver a normal paste as `Event::Paste`, but some send
    // Ctrl-V through as a key, so read the clipboard directly for those.
    if ctrl && key.code == KeyCode::Char('v') {
        if !app.login.as_ref().is_some_and(LoginPrompt::editable) {
            return;
        }
        match super::secret_input::clipboard_text() {
            Ok(text) => {
                if let Some(prompt) = app.login.as_mut() {
                    prompt.paste(&text);
                }
            }
            Err(e) => {
                if let Some(prompt) = app.login.as_mut() {
                    prompt.error = Some(format!("could not read the clipboard: {e}"));
                }
            }
        }
        return;
    }

    let Some(prompt) = app.login.as_mut() else {
        return;
    };
    // The browser stages have no field to edit -- only Esc, handled above, does
    // anything. Same for a paste being verified.
    if !prompt.editable() {
        return;
    }
    match key.code {
        KeyCode::Enter => match crate::core::cli::auth::providers::sanitize_key(&prompt.input) {
            Ok(key) => {
                prompt.verifying = true;
                prompt.error = None;
                app.login_submit = Some((prompt.provider.clone(), key));
            }
            Err(e) => {
                prompt.input.clear();
                prompt.error = Some(e);
            }
        },
        KeyCode::Backspace => {
            prompt.input.pop();
        }
        KeyCode::Char(ch) if !ctrl => prompt.input.push(ch),
        _ => {}
    }
}

fn handle_model_picker_key(app: &mut App, key: KeyEvent, ctrl: bool) {
    if key.code == KeyCode::Esc
        || (ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')))
    {
        app.model_picker = None;
        return;
    }

    let mut chosen = None;
    if let Some(picker) = app.model_picker.as_mut() {
        match key.code {
            KeyCode::Left => picker.focus = ModelPickerFocus::Scopes,
            KeyCode::Right => {
                picker.focus = ModelPickerFocus::Models;
                picker.move_selection(0);
            }
            KeyCode::Up => match picker.focus {
                ModelPickerFocus::Scopes => {
                    picker.select_scope(picker.active_scope.saturating_sub(1))
                }
                ModelPickerFocus::Models => picker.move_selection(-1),
            },
            KeyCode::Down => match picker.focus {
                ModelPickerFocus::Scopes => {
                    let max = picker.scopes.len().saturating_sub(1);
                    picker.select_scope((picker.active_scope + 1).min(max));
                }
                ModelPickerFocus::Models => picker.move_selection(1),
            },
            KeyCode::Char('k') if picker.focus == ModelPickerFocus::Models && !ctrl => {
                picker.move_selection(-1);
            }
            KeyCode::Char('j') if picker.focus == ModelPickerFocus::Models && !ctrl => {
                picker.move_selection(1);
            }
            KeyCode::Backspace if picker.focus == ModelPickerFocus::Models => {
                picker.query.pop();
                picker.refresh_items();
            }
            KeyCode::Char(ch) if picker.focus == ModelPickerFocus::Models && !ctrl => {
                picker.query.push(ch);
                picker.refresh_items();
            }
            KeyCode::Enter if picker.focus == ModelPickerFocus::Scopes => {
                picker.select_scope(picker.active_scope);
                picker.focus = ModelPickerFocus::Models;
            }
            KeyCode::Enter if picker.focus == ModelPickerFocus::Models => {
                chosen = picker
                    .items
                    .get(picker.selected)
                    .map(|item| item.value.clone());
            }
            _ => {}
        }
    }
    if let Some(value) = chosen {
        app.set_model(value);
        app.model_picker = None;
    }
}
/// The copyable continuation command shown when a session closes, mirroring
/// the non-interactive resume line in `cli`/`mod.rs`. The id is the same
/// short thread id `--resume` accepts, taken from the thread the session
/// persists to rather than a separately minted one.
fn resume_hint(thread_id: &str) -> String {
    let id: String = thread_id.chars().take(8).collect();
    format!("\x1b[2m[session {id} - resume with `flint --resume={id}`]\x1b[0m")
}
/// True when the key is a Ctrl chord. On Windows, AltGr arrives as Ctrl+Alt, so
/// Ctrl+Alt with a character that is not an ASCII letter or digit is text
/// (`@`, `{`, a non-ASCII letter), not a chord.
fn key_is_ctrl(key: &KeyEvent) -> bool {
    let mods = key.modifiers;
    if !mods.contains(KeyModifiers::CONTROL) {
        return false;
    }
    let altgr_text = cfg!(windows)
        && mods.contains(KeyModifiers::ALT)
        && matches!(key.code, KeyCode::Char(c) if !c.is_ascii_alphanumeric() && !c.is_ascii_control());
    !altgr_text
}

async fn handle_key(
    app: &mut App,
    key: KeyEvent,
    registry: &PermissionRegistry,
    current: &mut Option<CurrentRun>,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    if key.kind != KeyEventKind::Press {
        return;
    }

    let ctrl = key_is_ctrl(&key);
    // Ctrl-L is the readline/less spelling of "redraw". It sits ahead of every
    // mode guard below because the screen can be damaged at any moment,
    // including while a prompt or picker owns the keyboard. It changes only
    // the display.
    if ctrl && key.code == KeyCode::Char('l') {
        app.request_repaint();
        return;
    }
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let sup = key.modifiers.contains(KeyModifiers::SUPER);
    // A modified Enter is a newline, never a submit or a completion, so the
    // hint popups below have to let it through to the editing keys.
    let newline =
        key.code == KeyCode::Enter && (alt || key.modifiers.contains(KeyModifiers::SHIFT));
    let ctrl_c = ctrl && key.code == KeyCode::Char('c');
    let ctrl_d = ctrl && key.code == KeyCode::Char('d');

    // The `/login` prompt owns the keyboard while open: every keystroke is part
    // of a secret being typed, so none of it may reach the input box or the
    // transcript shortcuts.
    if app.login.is_some() {
        handle_login_key(app, key, ctrl);
        return;
    }

    // A pending browser question owns the keyboard the same way, so a `y`/`n`
    // meant for it can never reach the input box or a transcript shortcut.
    if app.browser_confirm.is_some() {
        if !ctrl {
            match key.code {
                KeyCode::Enter | KeyCode::Char('y') | KeyCode::Char('Y') => {
                    resolve_mcp_browser(app, true)
                }
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                    resolve_mcp_browser(app, false)
                }
                _ => {}
            }
        }
        return;
    }
    // The `/context` overlay owns the keyboard while open, matching the
    // pickers: Esc (and `q` when not ctrl) closes it, and Ctrl-C closes it
    // without cancelling the running turn. Nothing else reaches the input box
    // or the transcript shortcuts (e.g. a bare `q` must not quit) while it is
    // up.
    if app.context_view.is_some() {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') if !ctrl => {
                app.context_view = None;
            }
            _ if ctrl_c => {
                app.context_view = None;
            }
            _ => {}
        }
        return;
    }

    // The `/settings` edit dock owns the keyboard while open, same as `/login`.
    if app.settings_prompt.is_some() {
        handle_settings_key(app, key, ctrl);
        return;
    }

    // The MCP add/edit wizard owns the keyboard while open.
    if app.mcp_prompt.is_some() {
        handle_mcp_prompt_key(app, key, ctrl, mcp_servers).await;
        return;
    }

    // The provider add/edit wizard owns the keyboard while open.
    if app.provider_prompt.is_some() {
        handle_provider_prompt_key(app, key, ctrl);
        return;
    }

    // A pending permission prompt captures y/a/n; Ctrl-C or Ctrl-D cancels the
    // run and denies everything queued, so it can't be wedged waiting on an
    // unanswered prompt. Several subagents can have requests queued at once
    // (see `pending_queue`), so cancelling denies all of them, not just the
    // one on screen. Quitting itself stays with the two-press exit below.
    if !app.pending_queue.is_empty() {
        if ctrl_c || ctrl_d {
            for pending in app.pending_queue.drain(..) {
                deny(registry, &pending.request_id).await;
            }
            abort_run(current);
            app.cancel_run();
            return;
        }
        let pending = app
            .pending_queue
            .front_mut()
            .expect("checked non-empty above");
        // Decision keys are plain keystrokes (Ctrl-A / Alt-N / Ctrl-Y are not
        // answers) and wait out the settle window; arrows and Esc stay live.
        let plain = !ctrl && !alt && !sup;
        let settled = pending.settled();
        let decision = match key.code {
            KeyCode::Up => {
                pending.move_selection(-1);
                None
            }
            KeyCode::Down => {
                pending.move_selection(1);
                None
            }
            KeyCode::Enter if !newline && settled => Some(pending.options()[pending.selected].0),
            KeyCode::Char('y') | KeyCode::Char('Y') if plain && settled => {
                Some(PermissionDecision::AllowOnce)
            }
            KeyCode::Char('a') | KeyCode::Char('A')
                if plain && settled && pending.offers_always =>
            {
                Some(PermissionDecision::AllowAlways)
            }
            KeyCode::Char('n') | KeyCode::Char('N') if plain && settled => {
                Some(PermissionDecision::Deny)
            }
            KeyCode::Esc => Some(PermissionDecision::Deny),
            _ => None,
        };
        if let Some(d) = decision {
            // Only the front request resolves here; any others stay queued and
            // surface on the next draw once this one is popped.
            let pending = app
                .pending_queue
                .pop_front()
                .expect("checked non-empty above");
            // Only record denials: the tool row that follows an allow
            // already shows the call proceeded, so an "allowed" line is
            // pure noise once granted.
            if matches!(d, PermissionDecision::Deny) {
                app.system(Level::Error, &format!("denied: {}", pending.summary()));
            }
            if let Some(sender) = registry.lock().await.remove(&pending.request_id) {
                let _ = sender.send(d);
            }
            // The run resumes now that a prompt was answered (unless more are
            // queued) — publish the recomputed status either way.
            app.publish_agent_status();
        }
        return;
    }

    if app.model_picker.is_some() {
        handle_model_picker_key(app, key, ctrl);
        return;
    }

    // Ctrl-C and Ctrl-D both cancel a run, clear a draft, or (on a blank idle
    // composer, and only on a second press) quit.

    // An open picker owns navigation/Enter/Esc. One-shot pickers (thread/model)
    // act and close; the `/mcp` picker toggles the selected row in place.
    if let Some(picker) = app.picker.as_mut() {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                picker.armed_delete = None;
                picker.selected = picker.selected.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') if !picker.items.is_empty() => {
                picker.armed_delete = None;
                picker.selected = (picker.selected + 1).min(picker.items.len() - 1);
            }
            // Space toggles the row in place; Enter opens its detail screen.
            // Enter used to be the toggle, but with a detail screen to reach it
            // is the row's primary action, and Space is already the toggle in
            // the one other checkbox picker (`PluginSelect`).
            KeyCode::Char(' ') if picker.kind == PickerKind::ToggleMcp => {
                let item = &mut picker.items[picker.selected];
                if item.value.is_empty() {
                    return;
                }
                let name = item.value.clone();
                let enable = !item.checkbox.unwrap_or(false);
                // The row flips only once mcp_config.json has been written: a
                // failed write leaves it showing the state that is on disk.
                let Some(connect) = set_mcp_active(app, mcp_servers, &name, enable).await else {
                    return;
                };
                if let Some(item) = app
                    .picker
                    .as_mut()
                    .and_then(|p| p.items.iter_mut().find(|i| i.value == name))
                {
                    item.checkbox = Some(enable);
                }
                if connect {
                    // Nothing on this screen is waiting on the answer, so it is
                    // detached rather than taking the single job slot.
                    reconnect_mcp_server(mcp_servers, name);
                }
            }
            KeyCode::Enter if picker.kind == PickerKind::ToggleMcp => {
                let name = picker.items[picker.selected].value.clone();
                // The watermark row of an empty config: nothing to open.
                if name.is_empty() {
                    return;
                }
                open_mcp_detail(app, &name, mcp_servers).await;
            }
            // The detail screen's rows are actions on one server.
            KeyCode::Enter if picker.kind == PickerKind::McpServer => {
                let action = picker.items[picker.selected].value.clone();
                run_mcp_action(app, &action, mcp_servers).await;
            }
            // `/agents`: Enter drills into the selected subagent's detail.
            KeyCode::Enter if picker.kind == PickerKind::Agents => {
                let run_id = picker
                    .items
                    .get(picker.selected)
                    .map(|i| i.value.clone())
                    .unwrap_or_default();
                // The watermark row (no subagents running) has no id to open.
                if run_id.is_empty() {
                    return;
                }
                picker.kind = PickerKind::AgentDetail;
                app.agent_detail = Some(run_id);
            }
            // `/mcp` picker: `a` opens the add wizard, `e` opens the edit
            // wizard prefilled from the selected row, `d` removes the selected
            // server. All act through the shared config layer.
            KeyCode::Char('a') if picker.kind == PickerKind::ToggleMcp => {
                app.picker = None;
                app.mcp_prompt = Some(McpPrompt {
                    editing: None,
                    field: McpField::Name,
                    name: String::new(),
                    transport: "stdio".to_string(),
                    command: String::new(),
                    args: String::new(),
                    env: String::new(),
                    url: String::new(),
                    headers: String::new(),
                    active: false,
                    error: None,
                });
            }
            KeyCode::Char('e') if picker.kind == PickerKind::ToggleMcp => {
                let name = picker.items[picker.selected].value.clone();
                if name.is_empty() {
                    return;
                }
                edit_mcp_server(app, &name);
            }
            KeyCode::Char('d') if picker.kind == PickerKind::ToggleMcp => {
                let name = picker.items[picker.selected].value.clone();
                if name.is_empty() {
                    return;
                }
                app.picker = None;
                remove_mcp_server(app, &name, mcp_servers).await;
            }
            // `/settings > providers` picker: `a` opens the add wizard, `d`
            // deletes the selected provider only after a confirmation `d` on
            // the same row (an API key is unrecoverable). The leading
            // watermark row (an empty list) is inert. All writes go through
            // the shared headless `~/.jan/config.toml` path.
            KeyCode::Char('a') if picker.kind == PickerKind::ProviderSettings => {
                app.picker = None;
                app.provider_prompt = Some(ProviderPrompt::new());
            }
            KeyCode::Char('d') if picker.kind == PickerKind::ProviderSettings => {
                let Some(item) = picker.items.get(picker.selected) else {
                    return;
                };
                let name = item.value.clone();
                if name.is_empty() {
                    // The watermark row: nothing to delete.
                    return;
                }
                let sel = picker.selected;
                if picker.armed_delete == Some(sel) {
                    // Second `d` on the same row confirms the delete.
                    app.picker = None;
                    if crate::core::agent::global_config::remove_provider(&name).unwrap_or(false) {
                        app.note(&format!("removed provider '{name}'"));
                    } else {
                        app.note(&format!("provider '{name}' was not configured"));
                    }
                } else {
                    // First `d` arms; a second `d` on this row confirms.
                    picker.armed_delete = Some(sel);
                    app.note(&format!("press d again to delete provider '{name}'"));
                }
            }
            // `/settings > providers`: `x` signs out the selected provider.
            // Distinct from `d` delete: logout clears the stored credential
            // (and its OAuth token) but keeps the provider entry and its
            // model list, so a re-login is one Enter away.
            KeyCode::Char('x') if picker.kind == PickerKind::ProviderSettings => {
                let name = picker.items[picker.selected].value.clone();
                if name.is_empty() {
                    return;
                }
                sign_out_provider(app, &name);
            }
            // `/todo` editor: d/Enter = done, x = abandon (drop), r = remove.
            // Each mutates the canonical list and rebuilds the overlay in place;
            // opening/closing the view itself never mutates state.
            KeyCode::Char('d') | KeyCode::Char('x') | KeyCode::Char('r') | KeyCode::Enter
                if picker.kind == PickerKind::Todo =>
            {
                let code = key.code;
                let content = picker.items.get(picker.selected).map(|i| i.value.clone());
                // (picker borrow ends here; nothing below reads it before rebuild)
                if let Some(content) = content {
                    use crate::core::agent::todo::Target;
                    let result = match code {
                        KeyCode::Char('x') => {
                            apply_todo_mutation(app, |l| l.drop_target(Target::Task(&content)))
                                .await
                        }
                        KeyCode::Char('r') => {
                            apply_todo_mutation(app, |l| l.rm(Target::Task(&content))).await
                        }
                        _ => apply_todo_mutation(app, |l| l.done(Target::Task(&content))).await,
                    };
                    if let Err(e) = result {
                        app.note(&format!("todo update failed: {e}"));
                    }
                    // Rebuild from the mutated list; close once nothing remains.
                    if app.todos.is_empty() {
                        app.picker = None;
                    } else if let Some(picker) = app.picker.as_mut() {
                        picker.items = build_todo_items(&app.todos);
                        picker.selected = picker.selected.min(picker.items.len().saturating_sub(1));
                    }
                }
            }
            // `/settings` picker: `x` restores the selected key to its default
            // by removing it from the file its scope names - same write as
            // clearing the field in the edit dock, one keypress instead of two.
            KeyCode::Char('x') if picker.kind == PickerKind::AgentSettings => {
                let key = picker.items[picker.selected].value.clone();
                // (picker borrow ends here; nothing below reads it before rebuild)
                let toml_path = app.agent_dir.join("agent.toml");
                let Some(def) = AGENT_SETTINGS.iter().find(|d| d.key == key) else {
                    // The leading "providers" row has no key to unset.
                    return;
                };
                match write_setting(def, &toml_path, None) {
                    Ok(()) => {
                        // `None`, not `""`: this removed the key, so a `Glyph`
                        // goes back to its default rather than to off, which
                        // is what a cleared edit field means.
                        let when = if apply_live_unset(def) {
                            "in effect now"
                        } else {
                            "takes effect on the next run"
                        };
                        app.note(&format!("{key} unset (default applies); {when}"));
                        if let Some(picker) = app.picker.as_mut() {
                            picker.items = build_agent_settings_items(&toml_path);
                            picker.selected =
                                picker.selected.min(picker.items.len().saturating_sub(1));
                        }
                    }
                    Err(e) => app.note(&format!(
                        "failed to write {}: {e}",
                        setting_path(def, &toml_path)
                    )),
                }
            }
            // `/login`: `x` signs out the selected provider without leaving
            // the picker, so it doubles as a sign-out list. Only meaningful
            // for a provider that is currently signed in.
            KeyCode::Char('x') if picker.kind == PickerKind::LoginProvider => {
                let name = picker.items[picker.selected].value.clone();
                if !crate::core::cli::providers::provider_is_signed_in(
                    Some(&app.project_root),
                    &name,
                ) {
                    app.note(&format!("{name} is not signed in"));
                    return;
                }
                sign_out_provider(app, &name);
                // Refresh the status labels so the row flips to
                // "not signed in" without reopening the picker.
                if let Some(p) = app.picker.as_mut() {
                    for item in &mut p.items {
                        if item.value == name {
                            item.hint = Some("not signed in".to_string());
                        }
                    }
                }
            }
            // Collection picker: Space toggles the selected plugin, Enter hands
            // the checked set to the loop (see `plugin_select_request`). Rows
            // already installed stay displayed but are not toggleable -- checking
            // one and pressing Enter would make the batch install skip everything
            // and error with "nothing installed". A Space on such a row is a
            // no-op note so the confusion stays out.
            KeyCode::Char(' ') if picker.kind == PickerKind::PluginSelect => {
                let already_installed =
                    picker.items[picker.selected].hint.as_deref() == Some(INSTALLED_HINT);
                if already_installed {
                    app.note("already installed - nothing to install");
                } else {
                    let item = &mut picker.items[picker.selected];
                    item.checkbox = Some(!item.checkbox.unwrap_or(false));
                }
            }
            KeyCode::Enter if picker.kind == PickerKind::PluginSelect => {
                let paths: Vec<String> = picker
                    .items
                    .iter()
                    .filter(|i| i.checkbox.unwrap_or(false))
                    .map(|i| i.value.clone())
                    .collect();
                app.picker = None;
                if paths.is_empty() {
                    app.note("no plugin selected - install aborted");
                } else if let Some(url) = app.plugin_collection_url.take() {
                    app.note(&format!("installing {} plugin(s)...", paths.len()));
                    app.plugin_select_request = Some((url, paths));
                }
            }
            KeyCode::Enter => {
                let kind = picker.kind;
                let value = picker.items[picker.selected].value.clone();
                app.picker = None;
                match kind {
                    PickerKind::ResumeThread | PickerKind::ThreadTree => {
                        resume_thread(app, &value).await
                    }
                    PickerKind::LoginProvider => {
                        if value == "tokamak" {
                            open_login(app);
                        } else {
                            open_login_prompt(app, &value);
                        }
                    }
                    PickerKind::ToggleMcp => {}
                    PickerKind::RewindMessage => {
                        if let Ok(idx) = value.parse::<usize>() {
                            open_rewind_scope(app, idx);
                        }
                    }
                    PickerKind::ForkMessage => {
                        if let Ok(idx) = value.parse::<usize>() {
                            fork_at(app, idx).await;
                        }
                    }
                    PickerKind::RewindScope => {
                        if let Some(idx) = app.rewind_target.take() {
                            rewind_to(app, idx, value == "workspace");
                        }
                    }
                    PickerKind::ViewConfig => {}
                    // `/settings`: open the edit dock for the selected row,
                    // or the provider screen for the leading "providers" row.
                    PickerKind::AgentSettings => {
                        if value == PROVIDERS_SETTINGS_ROW {
                            open_provider_settings(app);
                        } else if let Some(def) =
                            AGENT_SETTINGS.iter().find(|d| d.key == value)
                        {
                            let toml_path = app.agent_dir.join("agent.toml");
                            let current = current_setting_value(def, &toml_path);
                            app.settings_prompt =
                                Some(SettingsPrompt::new(def, current.as_deref()));
                        }
                    }
                    // `/settings > providers`: open the wizard for the row.
                    PickerKind::ProviderSettings => {
                        let entry = crate::core::agent::global_config::load_global_config()
                            .ok()
                            .and_then(|c| c.get(&value).cloned());
                        if let Some(entry) = entry {
                            app.provider_prompt = Some(ProviderPrompt::from_entry(&entry));
                        }
                    }
                    // Todo Enter is handled by the guarded action arm above.
                    PickerKind::Todo => {}
                    // PluginSelect Enter is handled by the guarded arm above.
                    PickerKind::PluginSelect => {}
                    // McpServer Enter is handled by the guarded arm above.
                    PickerKind::McpServer => {}
                    // Agents Enter is handled by the guarded arm above; the
                    // detail has no Enter action of its own.
                    PickerKind::Agents | PickerKind::AgentDetail | PickerKind::BackgroundShells => {}
                }
            }
            // Esc on the detail screen steps back to the server list rather
            // than closing outright: the detail is one level *inside* `/mcp`,
            // and dropping the user to the prompt loses the place they were at.
            // When a sign-in is in flight for this server, Esc cancels it first
            // (the loop owns the job handle, so it does the actual abort) and
            // keeps the screen open.
            KeyCode::Esc | KeyCode::Char('q') if !ctrl && picker.kind == PickerKind::McpServer => {
                let signing_in = app
                    .mcp_detail
                    .as_ref()
                    .zip(app.mcp_auth.as_ref())
                    .is_some_and(|(d, f)| d.server.name == f.server);
                if signing_in {
                    app.mcp_auth_cancel = true;
                } else {
                    open_mcp_picker(app, mcp_servers).await;
                }
            }
            // Esc on a subagent's detail steps back to the `/agents` list, one
            // level up, rather than closing the inspector outright.
            KeyCode::Esc | KeyCode::Char('q') if !ctrl && picker.kind == PickerKind::AgentDetail => {
                picker.kind = PickerKind::Agents;
                app.agent_detail = None;
            }
            KeyCode::Esc | KeyCode::Char('q') if !ctrl => {
                app.plugin_collection_url = None;
                app.picker = None;
                app.mcp_detail = None;
                app.agent_detail = None;
            }
            _ if ctrl_c || ctrl_d => {
                app.plugin_collection_url = None;
                app.picker = None;
                app.mcp_detail = None;
                app.agent_detail = None;
            }
            _ => {}
        }
        return;
    }
    if ctrl_c || ctrl_d {
        if app.status == Status::Running {
            // Cancel-first: an in-flight task is what Ctrl-C interrupts, and
            // the session stays open with the partial turn intact.
            abort_run(current);
            app.cancel_run();
            app.exit_armed = false;
        } else if !app.input.trim().is_empty() {
            // Idle with something typed: clear the draft rather than quit, and
            // keep it in recall history so Up brings it back.
            app.record_draft();
            app.input_clear();
            app.exit_armed = false;
        } else if app.exit_armed {
            app.should_quit = true;
        } else {
            // Blank and idle: leaving takes a deliberate second Ctrl-C/Ctrl-D.
            app.exit_armed = true;
            app.system(Level::Warn, "press Ctrl-C or Ctrl-D again to quit");
        }
        return;
    }

    // Slash-command hint popup: while typing a `/command` name (idle, no space
    // yet) with at least one match, it owns Up/Down/Tab/Esc and Enter-to-accept.
    // Enter on a fully-typed command falls through to run it; typed chars fall
    // through to normal editing (which re-filters the popup live).
    if !app.slash_matches().is_empty() {
        match key.code {
            KeyCode::Up => {
                app.slash_move(-1);
                return;
            }
            KeyCode::Down => {
                app.slash_move(1);
                return;
            }
            KeyCode::Tab => {
                app.accept_slash();
                return;
            }
            KeyCode::Esc => {
                app.slash_dismissed = true;
                return;
            }
            KeyCode::Enter if !newline => {
                let matches = app.slash_matches();
                let sel = app.slash_selected.min(matches.len() - 1);
                if app.input.trim() != matches[sel].name() {
                    app.accept_slash();
                    return;
                }
                // Exact match: fall through to the normal Enter path to run it.
            }
            _ => {}
        }
    }

    // Path-hint popup: while `@query` is active with at least one match,
    // it owns Up/Down/Tab/Esc/Enter in the same pattern as slash hints.
    if app.has_path_hints() {
        match key.code {
            KeyCode::Up => {
                app.path_hint_move(-1);
                return;
            }
            KeyCode::Down => {
                app.path_hint_move(1);
                return;
            }
            KeyCode::Tab | KeyCode::Enter if !newline => {
                app.accept_path_hint();
                return;
            }
            KeyCode::Esc => {
                app.path_hint_dismissed = true;
                app.path_hints.clear();
                return;
            }
            _ => {}
        }
    }

    // Any composer key that isn't the blank-idle Ctrl-C means composing has
    // resumed, so it disarms a pending second-Ctrl-C exit.
    app.exit_armed = false;

    match key.code {
        KeyCode::Esc => {
            // Esc cancels a run or clears typed input; it never quits (that's
            // Ctrl-D / Ctrl-C when idle), so a stray Esc can't close the app.
            if app.status == Status::Running {
                abort_run(current);
                app.cancel_run();
                app.last_esc = None;
            } else if app.goal_evaluating {
                // The chat loop aborts the evaluation call.
                app.goal_eval_cancel = true;
                app.last_esc = None;
            } else {
                // A second idle Esc within the window opens the rewind picker;
                // a lone Esc clears the input as before.
                let double = app
                    .last_esc
                    .is_some_and(|t| t.elapsed() < Duration::from_millis(600));
                if double {
                    app.last_esc = None;
                    open_rewind_picker(app);
                } else {
                    app.last_esc = Some(Instant::now());
                    // Keep what was typed so Up brings it back.
                    app.record_draft();
                    app.input_clear();
                }
            }
        }
        // Alt+Enter, Shift+Enter or Ctrl+J insert a newline for multi-line
        // input; plain Enter submits. Shift+Enter only reaches us from a
        // terminal that disambiguates it (kitty keyboard protocol / CSI-u);
        // the other two work everywhere.
        KeyCode::Enter if newline => {
            app.input_insert('\n');
        }
        KeyCode::Char('j') if ctrl => {
            app.input_insert('\n');
        }
        // Ctrl-O expands/collapses all folded regions (tool groups and reasoning
        // blocks), scrolling the latest into view.
        KeyCode::Char('o') if ctrl => {
            app.toggle_regions();
        }
        // Alt+T toggles reasoning effort between "low" and the last non-low
        // level (default medium). A quick way to quiet or deepen a model run
        // without typing the full `/effort` command.
        KeyCode::Char('t') if alt => {
            app.toggle_reasoning_effort();
        }
        // Ctrl-V stages an image from the OS clipboard (terminal paste is
        // text-only, so we read the clipboard directly) for the next message.
        KeyCode::Char('v') if ctrl => {
            app.attach_clipboard_image();
        }
        // Readline editing keys, so the composer behaves like the shell the
        // user just came from. Motion and word-kills are line-wise because the
        // buffer is multi-line.
        KeyCode::Char('a') if ctrl => app.cursor_line_start(),
        KeyCode::Char('e') if ctrl => app.cursor_line_end(),
        KeyCode::Char('b') if ctrl => app.cursor_left(),
        KeyCode::Char('f') if ctrl => app.cursor_right(),
        KeyCode::Char('h') if ctrl => app.input_backspace(),
        KeyCode::Char('w') if ctrl => app.delete_unix_word_left(),
        KeyCode::Char('u') if ctrl => app.delete_to_line_start(),
        KeyCode::Char('k') if ctrl => app.delete_to_line_end(),
        KeyCode::Char('t') if ctrl => app.transpose_chars(),
        // Ctrl-P/Ctrl-N are Up/Down's shell spelling; recall declines when
        // there is nothing to recall, and unlike the arrows they never fall
        // through to scrolling.
        KeyCode::Char('p') if ctrl => {
            app.recall_prev();
        }
        KeyCode::Char('n') if ctrl => {
            app.recall_next();
        }
        KeyCode::Char('b') if alt => app.cursor_word_left(),
        KeyCode::Char('f') if alt => app.cursor_word_right(),
        KeyCode::Char('d') if alt => app.delete_word_right(),
        KeyCode::Enter => {
            let text = app.input.trim().to_string();
            app.input_clear();
            if !text.is_empty() {
                app.record_submitted(&text);
                if let Some(cmd) = text.strip_prefix('/') {
                    run_command(app, cmd, mcp_servers).await;
                } else if let Some(cmd) = text.strip_prefix('!') {
                    app.submit_shell(cmd.trim());
                } else {
                    app.submit_user(text);
                }
            }
        }
        // Cmd (SUPER) is line-wise, Alt/Ctrl word-wise, bare char-wise. SUPER
        // only arrives from a terminal with the keyboard enhancement flags on,
        // so the macOS Cmd bindings degrade to nothing rather than misfiring.
        KeyCode::Backspace if sup => {
            app.delete_to_line_start();
        }
        KeyCode::Backspace if alt || ctrl => {
            app.delete_word_left();
        }
        KeyCode::Backspace => {
            app.input_backspace();
        }
        KeyCode::Delete if alt || ctrl => {
            app.delete_word_right();
        }
        KeyCode::Delete => {
            app.input_delete();
        }
        KeyCode::Left if sup => {
            app.cursor_line_start();
        }
        KeyCode::Left if alt || ctrl => {
            app.cursor_word_left();
        }
        KeyCode::Left => {
            app.cursor_left();
        }
        KeyCode::Right if sup => {
            app.cursor_line_end();
        }
        KeyCode::Right if alt || ctrl => {
            app.cursor_word_right();
        }
        KeyCode::Right => {
            app.cursor_right();
        }
        KeyCode::Home => {
            app.cursor_line_start();
        }
        // Shift+Tab (crossterm sends it as BackTab, not Tab+SHIFT) cycles
        // reasoning effort low -> medium -> high -> low, matching Claude Code.
        KeyCode::BackTab => {
            app.cycle_reasoning_effort();
        }
        KeyCode::End => {
            app.cursor_line_end();
        }
        // Tab is a no-op in normal input mode; slash-command and path-hint
        // popups intercept it before reaching this arm.
        KeyCode::Tab => {}
        KeyCode::Char(c) if !ctrl => {
            app.input_insert(c);
        }
        // Up/Down recall submitted messages into the composer when there is
        // something to recall; otherwise they scroll the transcript as before.
        // PageUp/PageDown always scroll, so scrollback is never unreachable.
        KeyCode::Up | KeyCode::PageUp => {
            if key.code == KeyCode::Up && app.recall_prev() {
                return;
            }
            let step = if key.code == KeyCode::PageUp { 10 } else { 1 };
            app.scrollback = app.scrollback.saturating_add(step);
        }
        KeyCode::Down | KeyCode::PageDown => {
            if key.code == KeyCode::Down && app.recall_next() {
                return;
            }
            let step = if key.code == KeyCode::PageDown { 10 } else { 1 };
            app.scrollback = app.scrollback.saturating_sub(step);
        }
        _ => {}
    }
}

async fn deny(registry: &PermissionRegistry, request_id: &str) {
    if let Some(sender) = registry.lock().await.remove(request_id) {
        let _ = sender.send(PermissionDecision::Deny);
    }
}

fn abort_run(current: &mut Option<CurrentRun>) {
    if let Some(c) = current.take() {
        c.handle.abort();
    }
}

/// A slash command's name, argument hint, and description. Single source of
/// truth shared by the hint popup and the `/help` listing so they never drift
/// as commands are added or removed.
struct SlashCommand {
    /// Includes the leading slash, e.g. `/resume`.
    name: &'static str,
    /// Argument hint (`[id]`) or empty when the command takes none.
    hint: &'static str,
    description: &'static str,
    /// Name of the canonical command this row is an alias of; `None` for the
    /// command itself. `/think` and `/reasoning` alias `/effort`, so all three
    /// share one dispatch and one session-scoped effort state.
    alias_of: Option<&'static str>,
}

/// Slash popup metadata is intentionally loaded outside the render path.
/// Plugin installation and removal explicitly refresh this snapshot.
struct SlashCatalog {
    commands: Vec<crate::core::agent::plugin_commands::CommandEntry>,
    skills: Vec<crate::core::agent::skills::SkillMeta>,
}

impl SlashCatalog {
    fn load(root: &std::path::Path) -> Self {
        Self {
            commands: crate::core::agent::plugin_commands::catalog(root, &[]),
            // Keep every user-invocable skill here. The enabled whitelist is
            // re-read below so edits to agent.toml take effect immediately.
            skills: crate::core::agent::skills::user_catalog(root, &[]),
        }
    }

    fn command_enabled(
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

    fn skill_enabled(meta: &crate::core::agent::skills::SkillMeta, enabled: &[String]) -> bool {
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
enum SlashMatch {
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
    fn name(&self) -> &str {
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
fn slash_match_score(query: &[char], name: &str) -> Option<u32> {
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
fn subseq_score(query: &[char], hay: &[char]) -> Option<u32> {
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
fn edit_distance(a: &[char], b: &[char]) -> usize {
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

const SLASH_COMMANDS: &[SlashCommand] = &[
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
        hint: "[markdown|obsidian|json] [path]",
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

/// Every keybinding worth advertising, as `(keys, description)`. Single source
/// of truth for the `/help` listing and the first-run footer hint, so the two
/// can't drift. Deliberately not rendered on every frame -- the footer is for
/// transient state (running, prompts, pickers), not a permanent cheat sheet.
/// A word character for the emacs-style motions (Alt+B/F/D, Alt+Backspace,
/// Ctrl/Alt+arrows), matching readline: alphanumerics plus `_`.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Byte offset of the emacs word boundary before `at`: skip any run of
/// non-word chars, then the word itself, so `"foo bar"` with the caret at the
/// end lands on `b` and `"foo   "` lands on 0.
fn prev_word_start(s: &str, at: usize) -> usize {
    let mut i = at;
    let mut in_word = false;
    while let Some(c) = s[..i].chars().next_back() {
        if is_word_char(c) {
            in_word = true;
        } else if in_word {
            break;
        }
        i -= c.len_utf8();
    }
    i
}

/// The mirror of [`prev_word_start`], scanning forward from `at`.
fn next_word_end(s: &str, at: usize) -> usize {
    let mut i = at;
    let mut in_word = false;
    while let Some(c) = s[i..].chars().next() {
        if is_word_char(c) {
            in_word = true;
        } else if in_word {
            break;
        }
        i += c.len_utf8();
    }
    i
}

/// `Ctrl-W`'s boundary: whitespace-delimited, like the shell's
/// unix-word-rubout, so it takes a whole `src/core/cli/tui.rs` token rather
/// than stopping at every `/`.
fn prev_unix_word_start(s: &str, at: usize) -> usize {
    let mut i = at;
    for stop_on_space in [false, true] {
        while let Some(c) = s[..i].chars().next_back() {
            if c.is_whitespace() == stop_on_space {
                break;
            }
            i -= c.len_utf8();
        }
    }
    i
}

/// Byte offsets bounding the line `at` sits on, newlines excluded. The
/// composer is multi-line (Alt/Shift+Enter), so "line" is not the whole buffer.
fn line_bounds(s: &str, at: usize) -> (usize, usize) {
    let start = s[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = s[at..].find('\n').map_or(s.len(), |i| at + i);
    (start, end)
}

const KEY_BINDINGS: &[(&str, &str)] = &[
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
fn parse_command(line: &str) -> (&str, &str) {
    match line.trim().split_once(char::is_whitespace) {
        Some((n, rest)) => (n, rest.trim()),
        None => (line.trim(), ""),
    }
}

/// Execute a `/command` typed into the input box. Runs only while idle.
async fn run_command(
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
        "threads" | "list" => match super::list_threads_in(&app.agent_dir) {
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
fn usage_command(app: &mut App, arg: &str) {
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
fn btw_command(app: &mut App, question: &str) {
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
fn hooks_command(app: &mut App) {
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

fn context_command(app: &mut App) {
    app.context_view = Some(ContextView::Loading);
    app.context_request = true;
}

/// The `/init` prompt. Onboarding a project means producing the three things a
/// later session reads back: the root `JAN.md` (ingested as project context),
/// skills for repeatable workflows, and memory for durable facts. Phrased as a
/// task for the model rather than executed here -- only the model can read the
/// project and judge what is worth writing down.
const INIT_PROMPT: &str = "Onboard yourself to this project so future sessions start informed.\n\n\
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
fn init_command(app: &mut App) {
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
fn compact_command(app: &mut App, focus: &str) {
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
const MAX_OVERFLOW_RETRIES: u8 = 2;

/// Which path asked for a compaction: `/compact` keeps a shorter tail than the
/// automatic one and reports itself differently.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CompactKind {
    Manual,
    Auto,
}

impl CompactKind {
    fn keep_recent(self, auto_keep: usize) -> usize {
        match self {
            CompactKind::Manual => crate::core::agent::compaction::MANUAL_KEEP_RECENT,
            // AH-076: the automatic tail is the shared policy's.
            CompactKind::Auto => auto_keep,
        }
    }

    fn label(self) -> &'static str {
        match self {
            CompactKind::Manual => "compacting",
            CompactKind::Auto => "auto-compacting",
        }
    }

    fn done_label(self) -> &'static str {
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
type GoalEvalTask = tokio::task::JoinHandle<(
    crate::core::agent::goal::GoalState,
    Result<
        crate::core::agent::goal::GoalVerdict,
        tauri_plugin_agent_tools::harness_error::HarnessError,
    >,
)>;

async fn await_goal_eval(
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

async fn await_compaction(
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
fn finish_compaction(
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
fn goal_command(app: &mut App, arg: &str) {
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
struct AgentSettingDef {
    key: &'static str,
    label: &'static str,
    desc: &'static str,
    kind: AgentSettingKind,
    scope: SettingScope,
}

/// Which file a `/settings` row reads and writes. Both are surfaced by the one
/// menu because the distinction is an implementation detail to the person
/// looking for a knob: they want the setting, not the file it lives in.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SettingScope {
    /// This project's `.jan/agent/agent.toml`, under `[agent]` unless the key
    /// names its own section.
    Project,
    /// The user-wide `~/.jan/config.toml`, at the document root.
    Global,
}

enum AgentSettingKind {
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
const PROVIDERS_SETTINGS_ROW: &str = "__providers__";

const AGENT_SETTINGS: &[AgentSettingDef] = &[
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
struct SettingsPrompt {
    key: &'static str,
    input: String,
    error: Option<String>,
}

impl SettingsPrompt {
    fn new(def: &AgentSettingDef, current: Option<&str>) -> Self {
        Self {
            key: def.key,
            input: current.unwrap_or_default().to_string(),
            error: None,
        }
    }

    fn def(&self) -> &'static AgentSettingDef {
        AGENT_SETTINGS
            .iter()
            .find(|d| d.key == self.key)
            .expect("settings prompt always opens for a def row")
    }

    /// Apply a bracketed paste to the field, dropping the whitespace terminals
    /// add around a paste.
    fn paste(&mut self, text: &str) {
        self.input.push_str(super::secret_input::pasted(text));
    }
}

/// A docked multi-field wizard for adding or editing an MCP server. Collects
/// the fields the desktop form also asks for (name, transport, then the
/// transport-specific bits), validating on save through the shared
/// `core::cli::mcp` layer. `edit` mode prefills from the existing entry and
/// defaults `name` to it; `add` mode starts blank.
struct McpPrompt {
    /// `Some(original_name)` when editing; `None` when adding a new server.
    editing: Option<String>,
    /// Which field the keyboard is currently filling in.
    field: McpField,
    name: String,
    transport: String,
    command: String,
    args: String,
    env: String,
    url: String,
    headers: String,
    active: bool,
    error: Option<String>,
}

/// The fields of `McpPrompt`, in input order. `Transport` is a toggle row
/// rather than a free-text field, so it is navigated but not typed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum McpField {
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
    const FIELD_ORDER: [McpField; 8] = [
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
    fn visible_fields(&self) -> Vec<McpField> {
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

    fn next_field(&mut self) {
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

    fn prev_field(&mut self) {
        let fields = self.visible_fields();
        let pos = fields.iter().position(|f| *f == self.field).unwrap_or(0);
        self.field = fields[if pos == 0 { fields.len() - 1 } else { pos - 1 }];
    }

    fn from_entry(entry: &McpServerEntry) -> Self {
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
    async fn save(
        &mut self,
        mcp_servers: &crate::core::state::SharedMcpServers,
    ) -> Result<(), String> {
        let config = super::mcp::build_server_config(
            self.transport.trim(),
            Some(self.command.trim()).filter(|s| !s.is_empty()),
            super::mcp::parse_args(self.args.trim()),
            super::mcp::parse_pairs(self.env.trim(), "env")?,
            Some(self.url.trim()).filter(|s| !s.is_empty()),
            super::mcp::parse_pairs(self.headers.trim(), "header")?,
            self.active,
            // The form has no field for OAuth scopes (AH-135); an edit keeps
            // the ones the entry already declares instead of dropping them.
            self.editing
                .as_deref()
                .and_then(super::mcp::get_server)
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
            .is_some_and(|n| super::mcp::get_server(n).is_some_and(|e| e.active));
        super::mcp::upsert_server(self.name.trim(), &config)?;
        let name = self.name.trim().to_string();
        // Disconnect the old live service on rename/edit, then reconnect if active.
        if let Some(old) = self.editing.take() {
            if old != name {
                super::mcp::disconnect(&old, mcp_servers).await;
            }
        }
        if self.active {
            // Off the render loop: a cold stdio spawn or an http handshake here
            // would freeze the frame the form was submitted on.
            reconnect_mcp_server(mcp_servers, name);
        } else if was_active {
            super::mcp::disconnect(&name, mcp_servers).await;
        }
        Ok(())
    }

    /// Apply a bracketed paste to the active text field. Toggle fields
    /// (transport, active) ignore pastes exactly as they ignore typed
    /// characters.
    fn paste(&mut self, text: &str) {
        let text = super::secret_input::pasted(text);
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
fn pairs_to_str(map: Option<&serde_json::Map<String, Value>>) -> String {
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
struct ProviderPrompt {
    /// `Some(original_name)` when editing; `None` when adding a new provider.
    editing: Option<String>,
    /// Which field the keyboard is currently filling in.
    field: ProviderField,
    name: String,
    base_url: String,
    /// Wire API type: `None` = OpenAI-compatible chat/completions default,
    /// `Some("anthropic")` = Anthropic messages API.
    api_type: Option<String>,
    api_key: String,
    /// Whether the user edited the api-key field this session. While editing a
    /// provider the stored key is never loaded into the prompt (it must not be
    /// echoable), so an untouched field means "keep the stored key" and a
    /// touched one replaces it on save -- including with nothing, which clears
    /// it (e.g. a local endpoint that dropped auth).
    key_touched: bool,
    /// Whitespace-separated model ids (replaces the existing list on save).
    models: String,
    error: Option<String>,
}

/// The fields of `ProviderPrompt`, in input order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ProviderField {
    Name,
    BaseUrl,
    ApiType,
    ApiKey,
    Models,
}
impl ProviderPrompt {
    const FIELD_ORDER: [ProviderField; 5] = [
        ProviderField::Name,
        ProviderField::BaseUrl,
        ProviderField::ApiType,
        ProviderField::ApiKey,
        ProviderField::Models,
    ];
    fn next_field(&mut self) {
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

    fn prev_field(&mut self) {
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

    fn from_entry(entry: &crate::core::state::ProviderConfig) -> Self {
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

    fn new() -> Self {
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
    fn paste(&mut self, text: &str) {
        let text = super::secret_input::pasted(text);
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
    fn masked_key(&self) -> String {
        if self.editing.is_some() && !self.key_touched {
            return "(unchanged)".to_string();
        }
        super::secret_input::mask(self.api_key.chars().count())
    }

    /// An error explaining why a base URL is not a usable http(s) upstream.
    /// Only `https` (or `http` for a loopback host) is accepted, so a bearer
    /// key is never sent over a plaintext remote connection.
    fn validate_base_url(&self) -> Option<String> {
        use super::providers::is_loopback_url;
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
    fn toggle_api_type(&mut self) {
        self.api_type = match self.api_type.as_deref() {
            Some("anthropic") => None,
            _ => Some("anthropic".to_string()),
        };
    }

    /// Human label for the active api-type selection.
    fn api_type_label(&self) -> String {
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
    fn save(&self) -> Result<(), String> {
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
        super::cli_agent_config_set(
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
fn current_agent_value(toml_path: &std::path::Path, key: &str) -> Option<String> {
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
fn current_setting_value(def: &AgentSettingDef, toml_path: &std::path::Path) -> Option<String> {
    match def.scope {
        SettingScope::Project => current_agent_value(toml_path, def.key),
        SettingScope::Global => crate::core::agent::global_config::global_value(def.key),
    }
}

/// Write a `/settings` row to whichever file its scope names. `None` removes
/// the key so its default applies again.
fn write_setting(
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
fn setting_path(def: &AgentSettingDef, toml_path: &std::path::Path) -> String {
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
fn apply_live_setting(def: &AgentSettingDef, entered: &str) -> bool {
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
fn apply_live_unset(def: &AgentSettingDef) -> bool {
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
fn settings_command(app: &mut App, arg: &str) {
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
fn build_agent_settings_items(toml_path: &std::path::Path) -> Vec<PickerItem> {
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
fn open_settings_screen(app: &mut App) {
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
fn open_provider_settings(app: &mut App) {
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
fn grapheme_prefix(s: &str, n: usize) -> String {
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
fn parse_int_setting(input: &str, default: Option<u64>, min: u64) -> Result<Option<i64>, String> {
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

fn handle_settings_key(app: &mut App, key: KeyEvent, ctrl: bool) {
    if (key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c')))
        && app.settings_prompt.is_some()
    {
        app.settings_prompt = None;
        return;
    }
    let Some(prompt) = app.settings_prompt.as_mut() else {
        return;
    };
    match key.code {
        KeyCode::Enter => {
            let toml_path = app.agent_dir.join("agent.toml");
            let value: Option<toml_edit::Item> = match prompt.def().kind {
                AgentSettingKind::Int { default, min } => {
                    match parse_int_setting(&prompt.input, default, min) {
                        Ok(v) => v.map(toml_edit::value),
                        Err(err) => {
                            prompt.error = Some(err);
                            return;
                        }
                    }
                }
                AgentSettingKind::Glyph { .. } => {
                    // Not trimmed to empty-means-unset like `Text`: a cleared
                    // field writes `""`, which is the off switch. `x` on the
                    // row is how you get back to the default.
                    let input = prompt.input.trim();
                    if let Some(err) = crate::core::agent::global_config::wave_error(input) {
                        prompt.error = Some(err);
                        return;
                    }
                    Some(toml_edit::value(input.to_string()))
                }
                AgentSettingKind::Text { .. } => (!prompt.input.trim().is_empty())
                    .then(|| toml_edit::value(prompt.input.trim().to_string())),
                AgentSettingKind::Enum { options, default } => {
                    let input = prompt.input.trim();
                    if input.is_empty() {
                        None
                    } else if options.contains(&input) {
                        Some(toml_edit::value(input.to_string()))
                    } else {
                        prompt.error = Some(format!(
                            "must be one of: {} (default: {default})",
                            options.join(" | ")
                        ));
                        return;
                    }
                }
                AgentSettingKind::Bool { default } => {
                    let input = prompt.input.trim();
                    if input.is_empty() {
                        None
                    } else if let Ok(b) = input.parse::<bool>() {
                        Some(toml_edit::value(b))
                    } else {
                        prompt.error = Some(format!("must be true or false (default: {default})"));
                        return;
                    }
                }
            };
            match write_setting(prompt.def(), &toml_path, value) {
                Ok(()) => {
                    let entered = prompt.input.trim().to_string();
                    let glyph_kind = matches!(prompt.def().kind, AgentSettingKind::Glyph { .. });
                    let what = match (entered.is_empty(), glyph_kind) {
                        // A cleared glyph is a written value, not an unset, so
                        // saying "default applies" would be a lie.
                        (true, true) => format!("{} off (throbber)", prompt.key),
                        (true, false) => format!("{} unset (default applies)", prompt.key),
                        (false, _) => format!("{} = {entered} written", prompt.key),
                    };
                    let when = if apply_live_setting(prompt.def(), &entered) {
                        "in effect now"
                    } else {
                        "takes effect on the next run"
                    };
                    app.note(&format!("{what}; {when}"));
                    app.settings_prompt = None;
                }
                Err(e) => {
                    let path = setting_path(prompt.def(), &toml_path);
                    prompt.error = Some(format!("failed to write {path}: {e}"));
                }
            }
        }
        KeyCode::Backspace => {
            // Whole cluster for a glyph field: popping one `char` off `👁️`
            // leaves `👁`, so the row looks unchanged and the key reads as
            // broken. Other kinds keep the plain char pop.
            if matches!(prompt.def().kind, AgentSettingKind::Glyph { .. }) {
                let keep =
                    crate::core::agent::global_config::wave_len(&prompt.input).saturating_sub(1);
                prompt.input = grapheme_prefix(&prompt.input, keep);
            } else {
                prompt.input.pop();
            }
        }
        KeyCode::Char(ch) if !ctrl => {
            prompt.input.push(ch);
            // Checked on the result rather than by counting up: a skin-tone
            // modifier or ZWJ joins the cluster before it, so the string can
            // grow by a `char` without growing by a grapheme, and that must
            // still be allowed at the cap.
            if let AgentSettingKind::Glyph { max, .. } = prompt.def().kind {
                if crate::core::agent::global_config::wave_len(&prompt.input) > max {
                    prompt.input.pop();
                }
            }
        }
        _ => {}
    }
}

/// Keyboard for the MCP add/edit wizard: Up/Down move between fields, chars/
/// backspace edit the current text field, Space toggles the transport/active
/// rows, Enter saves and connects, Esc cancels. Only arrow keys steer: `k`/`j`
/// are ordinary characters in these fields (URLs, paths), so they always type.
#[allow(clippy::too_many_lines)]
async fn handle_mcp_prompt_key(
    app: &mut App,
    key: KeyEvent,
    ctrl: bool,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    if (key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c')))
        && app.mcp_prompt.is_some()
    {
        app.mcp_prompt = None;
        return;
    }
    let Some(prompt) = app.mcp_prompt.as_mut() else {
        return;
    };
    match key.code {
        KeyCode::Up => prompt.prev_field(),
        KeyCode::Down => prompt.next_field(),
        KeyCode::Tab => prompt.next_field(),
        KeyCode::Enter => {
            // Take the prompt out so `save` can borrow `app` freely for notes
            // and put it back on error.
            let mut taken = app.mcp_prompt.take().expect("prompt is Some");
            match taken.save(mcp_servers).await {
                Ok(()) => {
                    let name = taken.name.trim().to_string();
                    app.note(&format!("saved MCP server '{name}'"));
                }
                Err(e) => {
                    taken.error = Some(e);
                    app.mcp_prompt = Some(taken);
                }
            }
        }
        KeyCode::Char(' ') | KeyCode::Left | KeyCode::Right => {
            match prompt.field {
                McpField::Transport => {
                    prompt.transport = if prompt.transport == "stdio" {
                        "http".to_string()
                    } else {
                        "stdio".to_string()
                    };
                    // Reset to a valid field for the new transport.
                    prompt.field = prompt.visible_fields()[0];
                }
                McpField::Active => prompt.active = !prompt.active,
                _ => {}
            }
        }
        KeyCode::Backspace => match prompt.field {
            // Renaming an entry on edit would leave the old one behind, so the
            // name is fixed while editing.
            McpField::Name if prompt.editing.is_none() => {
                prompt.name.pop();
            }
            McpField::Command => {
                prompt.command.pop();
            }
            McpField::Args => {
                prompt.args.pop();
            }
            McpField::Env => {
                prompt.env.pop();
            }
            McpField::Url => {
                prompt.url.pop();
            }
            McpField::Headers => {
                prompt.headers.pop();
            }
            _ => {}
        },
        KeyCode::Char(ch) if !ctrl => match prompt.field {
            McpField::Name if prompt.editing.is_none() => prompt.name.push(ch),
            McpField::Command => prompt.command.push(ch),
            McpField::Args => prompt.args.push(ch),
            McpField::Env => prompt.env.push(ch),
            McpField::Url => prompt.url.push(ch),
            McpField::Headers => prompt.headers.push(ch),
            _ => {}
        },
        _ => {}
    }
}

/// Keyboard for the provider add/edit wizard: Up/Down move between fields,
/// chars/backspace edit the current field, Enter saves, Esc cancels. The API
/// key field masks what is typed (see `ProviderPrompt::masked_key`). Only
/// arrow keys steer: `k`/`j` are ordinary characters in these fields (API keys
/// start with `sk-...`), so they always type.
fn handle_provider_prompt_key(app: &mut App, key: KeyEvent, ctrl: bool) {
    if (key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c')))
        && app.provider_prompt.is_some()
    {
        app.provider_prompt = None;
        return;
    }
    let Some(prompt) = app.provider_prompt.as_mut() else {
        return;
    };
    match key.code {
        KeyCode::Up => prompt.prev_field(),
        KeyCode::Down => prompt.next_field(),
        KeyCode::Tab => prompt.next_field(),
        // Left/Right toggle the wire API type while that field is selected.
        KeyCode::Left | KeyCode::Right if prompt.field == ProviderField::ApiType => {
            prompt.toggle_api_type();
        }
        KeyCode::Enter => {
            // Take the prompt out so `save` can borrow `app` freely for notes
            // and put it back on error.
            let mut taken = app.provider_prompt.take().expect("prompt is Some");
            match taken.save() {
                Ok(()) => {
                    let name = taken.name.trim().to_string();
                    if taken.editing.is_some() {
                        app.note(&format!("updated provider '{name}'"));
                    } else {
                        app.note(&format!("added provider '{name}'"));
                    }
                }
                Err(e) => {
                    taken.error = Some(e);
                    app.provider_prompt = Some(taken);
                }
            }
        }
        KeyCode::Backspace => {
            if prompt.editing.is_some() && prompt.field == ProviderField::Name {
                return;
            }
            match prompt.field {
                ProviderField::Name => {
                    prompt.name.pop();
                }
                ProviderField::BaseUrl => {
                    prompt.base_url.pop();
                }
                ProviderField::ApiType => {}
                ProviderField::ApiKey => {
                    prompt.api_key.pop();
                    prompt.key_touched = true;
                }
                ProviderField::Models => {
                    prompt.models.pop();
                }
            }
        }
        KeyCode::Char(ch) if !ctrl => match prompt.field {
            ProviderField::Name if prompt.editing.is_some() => {}
            ProviderField::Name => prompt.name.push(ch),
            ProviderField::BaseUrl => prompt.base_url.push(ch),
            ProviderField::ApiType => {}
            ProviderField::ApiKey => {
                prompt.api_key.push(ch);
                prompt.key_touched = true;
            }
            ProviderField::Models => prompt.models.push(ch),
        },
        _ => {}
    }
}
/// it, and `/plan <text>` enters plan mode (if not already in it) and
/// immediately submits `<text>` as the first message to investigate — same
/// convenience as seeding the bare TUI with a task. Only settable while idle
/// so it never races the live tool set of a running turn (spec). Enforcement
/// is at the core dispatcher; this just flips the per-turn flag forwarded in
/// `App::body()` and persists it.
fn plan_command(app: &mut App, arg: &str) {
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

/// `/export [format] [path]` -- write this conversation to a file. The format
/// is markdown (default), obsidian or json; the path is a file, or a folder to
/// get a file named after the conversation, and defaults to the project folder.
fn export_command(app: &mut App, arg: &str) {
    use super::thread_export::{export_thread, Format};
    let Some(id) = app.thread_id.clone() else {
        app.note("nothing to export yet: send a message first");
        return;
    };
    let mut words = arg.split_whitespace();
    let (format, path) = match words.next() {
        Some(w) if Format::parse(w).is_ok() => (w.to_string(), words.next().map(str::to_string)),
        Some(w) => ("markdown".to_string(), Some(w.to_string())),
        None => ("markdown".to_string(), None),
    };
    let format = match Format::parse(&format) {
        Ok(f) => f,
        Err(e) => {
            app.note(&e);
            return;
        }
    };
    let out = path.map(std::path::PathBuf::from).unwrap_or_else(|| app.project_root.clone());
    match export_thread(&app.agent_dir, &id, format, false, false, Some(&out)) {
        Ok(Some(written)) => app.note(&format!("exported to {}", written.display())),
        Ok(None) => {}
        Err(e) => app.note(&format!("export failed: {e}")),
    }
}

/// `/schedule` -- the scheduled tasks, from the terminal's side. Creating and
/// editing a task is `flint cli schedule add|edit`; here you can see them and
/// run, enable or disable one.
fn schedule_command(app: &mut App, arg: &str) {
    use super::schedule_manage;
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
fn mode_command(app: &mut App, arg: &str) {
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

const EFFORT_LEVELS: &[&str] = &["low", "medium", "high"];

/// `/effort` -- report or change the reasoning effort level for subsequent model
/// requests. Without arguments, shows the current level. With a level argument,
/// validates and applies it.
fn effort_command(app: &mut App, arg: &str) {
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

/// Apply one user-initiated todo mutation to the canonical `TodoList`. Prefers
/// the shared registry (the model's source of truth) so agent and user share one
/// state; falls back to the local projection when no live session is attached
/// (e.g. tests). Syncs the TUI projection and persists on success.
async fn apply_todo_mutation(
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
const TODO_KEEP_CLOSED_TURNS: u32 = 2;

/// Clear the canonical todo list and the TUI projection together.
///
/// Goes through `apply_todo_mutation` so the registry -- the model's source of
/// truth -- is cleared too. Dropping only the projection would leave the model
/// appending to a list the user believes is gone, and the next `TodoUpdate`
/// would resurrect it on screen.
async fn clear_todos(app: &mut App) {
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
async fn age_closed_todos(app: &mut App) {
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
fn build_todo_items(todos: &crate::core::agent::todo::TodoList) -> Vec<PickerItem> {
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
fn open_todo_picker(app: &mut App) {
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
async fn todo_command(app: &mut App, arg: &str) {
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
fn cancel_command(app: &mut App, arg: &str) {
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
async fn plugin_command(app: &mut App, arg: &str) {
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
fn show_goal_status(app: &mut App) {
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
fn set_goal(app: &mut App, condition: &str) {
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
fn fmt_duration(secs: u64) -> String {
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
fn thread_display_name(base: &std::path::Path, id: &str, title: Option<&str>) -> String {
    if let Some(t) = title.map(str::trim).filter(|s| !s.is_empty()) {
        return t.to_string();
    }
    if let Ok(messages) = super::cli_list_messages_in(base, id) {
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
fn open_thread_picker(app: &mut App) {
    match super::list_threads_in(&app.agent_dir) {
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
async fn open_model_picker(app: &mut App) {
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
fn show_model_picker(app: &mut App, final_answer: bool) -> bool {
    let pairs = super::providers::list_provider_models(Some(&app.project_root));
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
type ModelFetchDone = (Result<bool, String>, std::collections::HashSet<String>);

async fn fetch_models_job(
    project_root: PathBuf,
    mut probed: std::collections::HashSet<String>,
) -> ModelFetchDone {
    let result = super::providers::fetch_missing_models(Some(&project_root), &mut probed).await;
    (result, probed)
}

async fn await_model_fetch(
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
async fn finish_model_fetch(app: &mut App, (result, probed): ModelFetchDone) {
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
async fn run_pending_model_fetch(app: &mut App) {
    if std::mem::take(&mut app.model_fetch_request) {
        app.model_fetch_running = true;
        let done = fetch_models_job(app.project_root.clone(), app.probed_models.clone()).await;
        finish_model_fetch(app, done).await;
    }
}

/// Action ids for the `McpServer` detail screen. String values rather than an
/// enum because `PickerItem::value` is the picker's one payload; keeping them
/// as constants is what stops the key handler and the row builder from drifting.
const MCP_ACTION_TOOLS: &str = "tools";
const MCP_ACTION_AUTH: &str = "auth";
const MCP_ACTION_CLEAR_AUTH: &str = "clear-auth";
const MCP_ACTION_RECONNECT: &str = "reconnect";
const MCP_ACTION_TOGGLE: &str = "toggle";
const MCP_ACTION_EDIT: &str = "edit";
const MCP_ACTION_REMOVE: &str = "remove";

/// Open the `/mcp` screen: one row per configured server, with its live state.
///
/// An empty config opens the screen anyway, on a watermark row (the same shape
/// `open_provider_settings` uses). Returning a note instead left a fresh install
/// with no way *in* to the thing `/mcp` manages -- `a` to add is only reachable
/// once the picker exists, so the one state that most needs the add wizard was
/// the one state that could not reach it.
async fn open_mcp_picker(app: &mut App, mcp_servers: &crate::core::state::SharedMcpServers) {
    let servers = super::mcp::list_servers();
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
                    match super::mcp::auth_status(&s.name, &s.config) {
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
fn open_agents_picker(app: &mut App) {
    app.agent_detail = None;
    app.picker = Some(Picker {
        kind: PickerKind::Agents,
        items: agent_picker_items(&app.subagents),
        selected: 0,
        armed_delete: None,
    });
}

/// Open the live list of shell commands detached by the `bash` tool.
fn open_background_shells_picker(app: &mut App) {
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
fn background_shell_picker_items(
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
fn agent_picker_items(subagents: &[SubagentPanel]) -> Vec<PickerItem> {
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
fn panel_activity_summary(panel: &SubagentPanel) -> String {
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
fn collapse_runs(calls: &[String]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    for c in calls {
        match out.last_mut() {
            Some(run) if &run.0 == c => run.1 += 1,
            _ => out.push((c.clone(), 1)),
        }
    }
    out
}

fn open_login_picker(app: &mut App) {
    open_login_picker_at(app, None);
}

/// Open the detail screen for one server: the info block plus the actions that
/// apply to it. Everything shown is local, so this opens in one frame; the tool
/// list is requested as a job and fills in when it lands.
async fn open_mcp_detail(
    app: &mut App,
    name: &str,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    let Some(server) = super::mcp::describe(name, mcp_servers).await else {
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
fn mcp_action_items(server: &super::mcp::ServerDetail) -> Vec<PickerItem> {
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

fn open_login_picker_at(app: &mut App, selected_provider: Option<&str>) {
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
                if super::providers::provider_is_signed_in(Some(&app.project_root), provider.id) {
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
fn login_command(app: &mut App, arg: &str) {
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
fn open_login(app: &mut App) {
    app.login = Some(LoginPrompt::connecting());
    app.login_device_request = true;
}

/// The session exists: show the code to check and the page to approve on, and
/// open the browser. The URL goes to the transcript as well as the dock, so a
/// remote or headless session can still be finished by hand -- or from a phone.
fn show_login_approval(app: &mut App, session: &super::device_auth::Session) {
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
fn open_browser_reporting(app: &mut App, url: &str, open: bool) {
    if !open {
        app.system_detail_text("not opening a browser - use the URL above on any device");
        return;
    }
    match super::browser::open(url) {
        Ok(()) => app.system_detail_text("opening that page in your browser"),
        Err(e) => app.system_detail_text(&format!("could not open a browser ({e})")),
    }
}

/// Answer the question the `/login` dock is holding. The dock moves on either
/// way, so the sign-in is never blocked on a browser.
fn resolve_login_browser(app: &mut App, open: bool) {
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
fn resolve_mcp_browser(app: &mut App, open: bool) {
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

fn logout_command(app: &mut App, provider: &str) {
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
fn sign_out_provider(app: &mut App, provider: &str) {
    match crate::core::cli::auth::CredentialStore::delete(provider) {
        Ok(()) => app.note(&format!("signed out of {provider} (provider config kept)")),
        Err(error) => app.note(&format!("could not sign out: {error}")),
    }
}

fn open_login_prompt(app: &mut App, provider: &str) {
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

fn finish_login(
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

fn finish_tokamak_login(app: &mut App, result: Result<super::tokamak::Login, String>) -> bool {
    match result {
        Ok(login) => {
            let super::tokamak::Login {
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
            if let Some(warning) = super::tokamak::expiry_warning() {
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

fn login_success_message(provider: &str) -> String {
    format!("signed in to {provider}. Use /model to select a model.")
}
fn login_error_message(provider: &str, error: crate::core::cli::auth::LoginError) -> String {
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

fn adopt_login_model(app: &mut App, login: &crate::core::cli::auth::LoginResult) {
    let runnable = super::providers::list_provider_models(Some(&app.project_root));
    if runnable.iter().any(|(_, model)| *model == app.model) {
        return;
    }
    if let Some(model) = login.models.first() {
        app.adopt_model(model.clone());
        let _ = super::cli_set_project_model(&app.agent_dir, &app.model);
    }
}

/// Re-read `~/.jan/config.toml` (plus desktop and project layers) into the
/// session's in-memory `args.provider_configs` map. Must be called after any
/// mid-session credential write (`/login`, `flint config set`) because
/// `prepare_agent_session` snapshots the provider map once at startup and
/// never re-reads it. Without this, the first turn after sign-in fails
/// upstream resolution (`"No upstream session found for model ..."`) and
/// requires a restart.
async fn reload_provider_configs(app: &mut App) {
    let Some(args) = app.args.clone() else {
        return;
    };
    let project_root = app.project_root.clone();
    match super::providers::load_provider_configs(
        Some(&project_root),
        &super::providers::ProviderOverrides::default().with_env(),
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
async fn reload_command(app: &mut App, mcp_servers: &crate::core::state::SharedMcpServers) {
    reload_provider_configs(app).await;
    app.refresh_slash_catalog();

    let enabled: Vec<String> = super::mcp::list_servers()
        .into_iter()
        .filter(|entry| entry.active)
        .map(|entry| entry.name)
        .collect();
    let connected: Vec<String> = mcp_servers.lock().await.keys().cloned().collect();
    let mut dropped = 0usize;
    for name in connected.iter().filter(|n| !enabled.contains(n)) {
        super::mcp::disconnect(name, mcp_servers).await;
        dropped += 1;
    }
    for name in &enabled {
        let servers = mcp_servers.clone();
        let name = name.clone();
        tokio::spawn(async move {
            super::mcp::disconnect(&name, &servers).await;
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
fn terminal_setup_command(app: &mut App) {
    use super::terminal_setup::{apply, Outcome};
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
fn open_config_screen(app: &mut App) {
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
async fn run_mcp_job(job: McpJob, servers: crate::core::state::SharedMcpServers) -> McpJobDone {
    match job {
        McpJob::Tools(server) => {
            let result = super::mcp::list_tools(&server, &servers).await;
            McpJobDone::Tools { server, result }
        }
        McpJob::BeginAuth(server) => {
            let result = super::mcp::begin_auth(&server).await.map(Box::new);
            McpJobDone::AuthStarted { server, result }
        }
        McpJob::Authorize { server, pending } => {
            let result = super::mcp::finish_auth(*pending).await.map(|_| ());
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
async fn finish_mcp_job(
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
                super::mcp::disconnect(&server, mcp_servers).await;
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
fn finish_context_report(app: &mut App, report: ContextReport) {
    if app.context_view.is_some() {
        app.context_view = Some(ContextView::Ready(Box::new(report)));
    }
}

/// Open the add/edit wizard prefilled from a configured server.
fn edit_mcp_server(app: &mut App, name: &str) {
    match super::mcp::get_server(name) {
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
async fn remove_mcp_server(
    app: &mut App,
    name: &str,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    if let Err(e) = super::mcp::remove_server(name) {
        return app.note(&format!("failed to remove '{name}': {e}"));
    }
    super::mcp::disconnect(name, mcp_servers).await;
    let _ = super::mcp::clear_auth(name);
    app.mcp_detail = None;
    app.note(&format!("removed MCP server '{name}'"));
}

/// Run one detail-screen action. Anything that talks to a peer or waits on a
/// browser leaves as an `McpJob` instead of running here -- `handle_key` is on
/// the render loop.
async fn run_mcp_action(
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
            match super::mcp::clear_auth(&name) {
                Ok(true) => app.note(&format!("cleared stored credentials for '{name}'")),
                Ok(false) => app.note(&format!("'{name}' had no stored credentials")),
                Err(e) => app.note(&format!("could not clear credentials for '{name}': {e}")),
            }
            // The connection still holds the old bearer token, so it is dropped
            // too: leaving it up would report "authenticated" work against
            // credentials the user just asked to forget.
            super::mcp::disconnect(&name, mcp_servers).await;
            open_mcp_detail(app, &name, mcp_servers).await;
        }
        MCP_ACTION_RECONNECT => {
            super::mcp::disconnect(&name, mcp_servers).await;
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
fn show_mcp_tools(app: &mut App) {
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
async fn connect_mcp_server(
    name: &str,
    servers: &crate::core::state::SharedMcpServers,
) -> Result<(), String> {
    let cfg = super::mcp::list_servers()
        .into_iter()
        .find(|s| s.name == name)
        .map(|s| s.config)
        .ok_or_else(|| format!("'{name}' is no longer in mcp_config.json"))?;
    super::mcp::connect(name, &cfg, servers)
        .await
        .map_err(|e| e.to_string())
}

/// `connect_mcp_server`, detached: for the paths with no screen waiting on the
/// result. Off the render loop, so a cold stdio spawn never freezes a frame.
fn reconnect_mcp_server(mcp_servers: &crate::core::state::SharedMcpServers, name: String) {
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
async fn set_mcp_active(
    app: &mut App,
    mcp_servers: &crate::core::state::SharedMcpServers,
    name: &str,
    enable: bool,
) -> Option<bool> {
    if let Err(e) = super::mcp::set_active(name, enable) {
        app.note(&format!("failed to update mcp_config.json: {e}"));
        return None;
    }
    if enable {
        app.note(&format!("enabling MCP server '{name}'..."));
    } else {
        super::mcp::disconnect(name, mcp_servers).await;
        app.note(&format!("disabled MCP server '{name}'"));
    }
    Some(enable)
}

/// Resolve a thread by id (exact or unique prefix), load its messages into the
/// conversation history, and render them into the transcript.
/// Reload workspace-snapshot bookkeeping for a resumed thread from its persisted
/// metadata. Snapshots live in the git object store (kept alive by the thread's
/// ref), so there is nothing on disk to reattach; a later rewind restores them.
fn restore_snapshots(app: &mut App, metadata: Option<&serde_json::Value>) {
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
fn restore_goal(app: &mut App, metadata: Option<&serde_json::Value>) {
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
fn restore_run_mode(app: &mut App, metadata: Option<&serde_json::Value>) {
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
fn restore_todos(app: &mut App, metadata: Option<&serde_json::Value>) {
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
fn note_workspace_mismatch(app: &mut App, thread: &serde_json::Value) {
    let Some(recorded) = super::worktree::from_metadata(thread.get("metadata")) else {
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
fn worktree_command(app: &mut App) {
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
const WORKTREE_CHANGE_ROWS: usize = 20;

/// Branch the session before its `target`-th user message into a new thread and
/// switch to it, leaving the source whole on disk. The cut turn lands in the
/// input, as a rewind's does, so the branch opens ready to re-ask it.
async fn fork_at(app: &mut App, target: usize) {
    // The fork is cut from what is on disk, so this turn's history and journal
    // have to be there first; the journal writer is asynchronous.
    app.persist();
    app.join_journal();
    let Some(source) = app.thread_id.clone() else {
        return app.note("nothing to fork: this session has not been saved yet");
    };
    let fill = super::user_turn_index(&app.history, target)
        .and_then(|i| app.history.get(i))
        .and_then(|m| m.get("content"))
        .map(|c| user_content_parts(c).0)
        .unwrap_or_default();

    let forked = super::fork_thread(&app.agent_dir, &source, Some(target))
        .and_then(|id| super::cli_get_thread_in(&app.agent_dir, &id));
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
fn tree_prefix(depth: usize, last: bool) -> String {
    if depth == 0 {
        return String::new();
    }
    let arm = if last { "└─ " } else { "├─ " };
    format!("{}{arm}", "   ".repeat(depth - 1))
}

/// Open `/tree`: this project's saved threads arranged by the forks taken from
/// them. Enter resumes the selected node; a store with no forks is the flat list
/// `/resume` shows.
fn open_tree_picker(app: &mut App) {
    let threads = match super::list_threads_in(&app.agent_dir) {
        Ok(threads) => threads,
        Err(e) => return app.note(&format!("failed to list threads: {e}")),
    };
    let base = app.agent_dir.clone();
    let current = app.thread_id.clone();
    let items: Vec<PickerItem> = super::thread_forest(threads)
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
fn open_rewind_picker(app: &mut App) {
    open_turn_picker(app, PickerKind::RewindMessage, "nothing to rewind to");
}

/// Open the `/fork` picker: the same list of user messages, branching before the
/// chosen one instead of truncating this thread at it.
fn open_fork_picker(app: &mut App) {
    open_turn_picker(app, PickerKind::ForkMessage, "nothing to fork");
}

/// List the conversation's user messages for a picker that acts on a past turn.
fn open_turn_picker(app: &mut App, kind: PickerKind, empty: &str) {
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
fn open_rewind_scope(app: &mut App, user_index: usize) {
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
fn rewind_to(app: &mut App, target: usize, restore_workspace: bool) {
    let Some(cut) = super::user_turn_index(&app.history, target) else {
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
fn rebuild_recall(app: &mut App) {
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
fn replay_display_log(app: &mut App, entries: Vec<DisplayEntry>) {
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
fn rebuild_transcript(app: &mut App) {
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
            match super::invocation_label(&text) {
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

async fn resume_thread(app: &mut App, id_arg: &str) {
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
async fn apply_resume(app: &mut App, request: &ResumeRequest) {
    match super::resolve_resume(&app.agent_dir, request) {
        Ok(thread) => load_thread(app, &thread, "resumed").await,
        Err(e) => app.note(&e),
    }
}

/// Replace the live session with a saved thread's state: history, transcript,
/// snapshots, goal, and model. Only user/assistant text is replayed (tool calls
/// are not persisted as messages). `verb` names how the thread was opened, so a
/// fork does not report itself as a resume.
async fn load_thread(app: &mut App, thread: &serde_json::Value, verb: &str) {
    // The running turn would save its conversation over the thread opened
    // here when it finishes.
    if app.status != Status::Idle {
        return app.note("a turn is running; press Esc to stop it before switching threads");
    }
    let full_id = thread
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let (messages, skipped) = match super::cli_read_messages_lenient(&app.agent_dir, full_id) {
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
        .and_then(|m| m.get(super::FORKED_FROM_KEY))
        .cloned();
    // A loaded thread brings its own worktree pointer, or none: this session
    // cannot switch checkouts under a frozen run, so writing the live one into a
    // thread that did not ask for it would hand two conversations one branch.
    app.workspace_record = super::worktree::from_metadata(thread.get("metadata"));
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
    app.history = super::rebuild_wire_history(&messages);
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
fn user_content_parts(content: &serde_json::Value) -> (String, Vec<String>) {
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
fn message_text(msg: &serde_json::Value) -> String {
    super::thread_message_text(msg)
}

/// Whitespace-collapsed, char-truncated one-liner for checkpoint/rewind labels.
fn truncate_preview(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 60 {
        let head: String = collapsed.chars().take(57).collect();
        format!("{head}...")
    } else {
        collapsed
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
