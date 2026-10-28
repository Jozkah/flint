//! The model event stream: running a turn, folding `StreamEvent`s into the
//! app (`App::apply` and its handlers), the background jobs the loop awaits,
//! reasoning-tag scanning and the thread saver. Moved verbatim out of `tui.rs`.

use super::*;

/// True if `buf` contains any answer prose outside `<think>` reasoning. Used to
/// decide when a tool group closes: reasoning streamed between tool calls must
/// not end the run (a reasoning model thinks before every call), only real
/// answer text does.
pub(super) fn has_answer_text(buf: &str) -> bool {
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
pub(super) struct ThinkScan {
    /// Everything before this byte has been consumed.
    pub(super) pos: usize,
    /// Inside an unclosed think block as of `pos`.
    pub(super) open: bool,
    /// Answer prose seen outside think blocks before `pos`.
    pub(super) prose: bool,
    /// The bytes just before `pos`, to notice a buffer that was swapped out.
    pub(super) window: Vec<u8>,
}

impl ThinkScan {
    pub(super) const WINDOW: usize = 32;

    /// `(thinking_open(buf), has_answer_text(buf))`, scanning only new text.
    pub(super) fn state(&mut self, buf: &str) -> (bool, bool) {
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

    pub(super) fn advance(&mut self, buf: &str) {
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
pub(super) fn markdown_prefix_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*").unwrap())
}

/// A leading label like `Q:`, `Question 2:`, `Ask:`.
pub(super) fn prompt_label_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*").unwrap())
}

/// A line starting with a question word (what/how/can/should/...).
pub(super) fn question_word_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b",
        )
        .unwrap()
    })
}

/// A line directly addressing the user ("you", "your", "we", "our").
pub(super) fn user_directed_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)\b(?:you|your|we|our)\b").unwrap())
}

/// An explicit request for the user to respond ("let me know", "please
/// confirm"), independent of a trailing question mark.
pub(super) fn response_cue_re() -> &'static regex::Regex {
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
pub(super) fn assistant_is_awaiting_user_answer(text: &str) -> bool {
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

pub(super) fn think_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"</?[a-zA-Z:]*think>").unwrap())
}

/// Run `f` with `<think>` parsing off on this thread only.
#[cfg(test)]
pub(super) fn without_think_tags<T>(f: impl FnOnce() -> T) -> T {
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
pub(super) fn split_reasoning(text: &str) -> Vec<(bool, String)> {
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
pub(super) fn assistant_runs(prose: &str, segs: &[ReasoningSeg]) -> Vec<(bool, String)> {
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
pub(super) fn thinking_open(text: &str) -> bool {
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
pub(super) fn assistant_has_content(prose: &str, segs: &[ReasoningSeg]) -> bool {
    assistant_runs(prose, segs)
        .iter()
        .any(|(_, seg)| !seg.trim().is_empty())
}

/// `Kind` of the first non-empty run the live tail will render, so the leading
/// separator can mirror `gap` exactly: reasoning shares the `Tool` band, so a
/// tool call followed by streaming reasoning gets no blank, while streaming
/// prose still opens with one.
pub(super) fn live_leading_kind(prose: &str, segs: &[ReasoningSeg]) -> Option<Kind> {
    assistant_runs(prose, segs)
        .into_iter()
        .find(|(_, seg)| !seg.trim().is_empty())
        .map(|(reasoning, _)| if reasoning { Kind::Reasoning } else { Kind::Prose })
}

/// `Kind` of the last non-empty run the live tail renders, so a row appended
/// below it (an awaiting/starting throbber) can gap against what actually
/// precedes it rather than always inserting a blank.
pub(super) fn live_trailing_kind(prose: &str, segs: &[ReasoningSeg]) -> Option<Kind> {
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
pub(super) fn system_tag_re() -> &'static regex::Regex {
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
pub(super) fn strip_system_xml_tags(text: &str) -> String {
    system_tag_re().replace_all(text, "").to_string()
}

/// The args a new run starts from: the session's, with the approval mode
/// `/mode` set on `app.args` (a copy-on-write clone the session's args never
/// see), so `/mode ask` actually gates the next run.
pub(super) fn run_args(app: &App, args: &Arc<OrchestrationArgs>) -> Arc<OrchestrationArgs> {
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

pub(super) fn spawn_run(args: &Arc<OrchestrationArgs>, body: serde_json::Value) -> CurrentRun {
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
pub(super) async fn next_event(current: &mut Option<CurrentRun>) -> RunEvent {
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
pub(super) async fn await_mcp(
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
pub(super) fn spawn_snapshot(
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
pub(super) async fn await_snapshot(
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
pub(super) async fn await_mcp_job(
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
pub(super) type UsageDone = (
    crate::core::cli::tokamak::usage::Query,
    Result<crate::core::cli::tokamak::usage::Payload, crate::core::cli::tokamak::usage::UsageError>,
);

pub(super) async fn await_usage(task: &mut Option<tokio::task::JoinHandle<UsageDone>>) -> Option<UsageDone> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.ok()
}

/// Write a `/usage` answer into the transcript. Every line says it is what the
/// provider recorded; a failure is reported as one, never as a zero charge.
pub(super) fn finish_usage(app: &mut App, (query, result): UsageDone) {
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

pub(super) async fn await_context(
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
pub(super) async fn await_login(
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

pub(super) async fn await_tokamak_login(
    task: &mut Option<tokio::task::JoinHandle<Result<super::super::tokamak::Login, String>>>,
) -> Result<super::super::tokamak::Login, String> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.map_err(|e| format!("Tokamak sign-in task failed: {e}"))?
}

/// Await the session-creation half of the browser sign-in, parking forever when
/// none is running so this can sit in the loop's `select!` unconditionally.
pub(super) async fn await_login_begin(
    task: &mut Option<
        tokio::task::JoinHandle<
            Result<super::super::device_auth::PendingAuth, super::super::device_auth::BeginError>,
        >,
    >,
) -> Result<super::super::device_auth::PendingAuth, super::super::device_auth::BeginError> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    match joined {
        Ok(inner) => inner,
        Err(e) => Err(super::super::device_auth::BeginError::Failed(format!(
            "sign-in task failed: {e}"
        ))),
    }
}

/// How often the dock's branch indicator re-reads `HEAD`, so a checkout made
/// outside the TUI (another terminal, an editor) shows up without needing a
/// restart. Cheap (`rev-parse --abbrev-ref HEAD`) but still shells out, so this
/// is a poll, not every tick.
pub(super) const BRANCH_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The hint rows for an `@query`, from a blocking directory read. A query that
/// climbs out of the project (`..`) gets none: hints are for the project.
pub(super) fn search_path_hints(root: &std::path::Path, query: &str) -> Vec<PathHintItem> {
    if query.split(['/', '\\']).any(|part| part == "..") {
        return Vec::new();
    }
    path_refs::search_files_sync(root, query, 30)
        .into_iter()
        .map(|(path, name, is_dir)| PathHintItem { path, name, is_dir })
        .collect()
}

pub(super) type PathHintTask = tokio::task::JoinHandle<(u64, Vec<PathHintItem>)>;

pub(super) fn spawn_path_hint_search(generation: u64, root: PathBuf, query: String) -> PathHintTask {
    tokio::task::spawn_blocking(move || (generation, search_path_hints(&root, &query)))
}

/// Await the in-flight hint search once, clearing the slot. Same cancel-safe
/// borrow as `await_branch_poll`; pends forever when idle.
pub(super) async fn await_path_hints(task: &mut Option<PathHintTask>) -> Option<(u64, Vec<PathHintItem>)> {
    let joined = match task.as_mut() {
        Some(h) => h.await,
        None => return pending().await,
    };
    *task = None;
    joined.ok()
}

/// Re-read the current git branch off-loop (a blocking `git` call), only when
/// no poll is already in flight. A no-op when the project isn't a git repo.
pub(super) fn spawn_branch_poll(project_root: &std::path::Path) -> tokio::task::JoinHandle<Option<String>> {
    let root = project_root.to_path_buf();
    tokio::task::spawn_blocking(move || git::current_branch(&root))
}

/// Await an in-flight branch poll once, clearing the slot. Same cancel-safe
/// borrow as `await_mcp`; pends forever when idle.
pub(super) async fn await_branch_poll(
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
pub(super) async fn await_plugin_install(
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
pub(super) const INSTALLED_HINT: &str = "installed";

/// Report a plugin install. Clears the in-flight flag so the next request is
/// accepted. A collection source installed nothing yet: it opens the picker so
/// the user chooses which plugins to install. The flag is cleared here the
/// moment the listing opens the picker, so a second `/plugin install` during
/// that picker-open window is allowed and, if it is also a collection,
/// replaces the open picker (only one clone is ever in flight -- the
/// `plugin_install_task` guard holds).
pub(super) fn finish_plugin_install(
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

/// Apply one event from the active run's stream, clearing `current` on a
/// terminal one. `None` is a stream that closed without a terminal event (an
/// aborted task).
pub(super) async fn apply_stream_event(
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
pub(super) const EVENT_DRAIN_MAX: usize = 512;

/// Apply every event already sitting in the run's channel, then return how many
/// landed. A file-sized `write` streams its arguments in thousands of deltas
/// (measured: 7000 for a 314KB file), and the loop draws once per iteration, so
/// handling one event per pass means thousands of full repaints for a preview
/// that only ever shows its last few lines. Draining first collapses a burst
/// into a single frame. Stops early on a terminal event, which clears `current`
/// -- nothing queued behind it belongs to a finished run.
pub(super) async fn drain_stream_events(app: &mut App, current: &mut Option<CurrentRun>) -> usize {
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

/// One snapshot for [`ThreadSaver`].
pub(super) struct ThreadSave {
    pub(super) base: std::path::PathBuf,
    pub(super) id: String,
    pub(super) model: String,
    pub(super) history: Vec<serde_json::Value>,
    pub(super) metadata: Option<serde_json::Value>,
}

pub(super) enum ThreadSaveJob {
    Save(ThreadSave),
    Flush(std::sync::mpsc::Sender<()>),
}

/// Writes thread snapshots on a dedicated thread, in the order queued, so the
/// newest snapshot is always the last one written.
pub(super) struct ThreadSaver {
    pub(super) tx: Option<std::sync::mpsc::Sender<ThreadSaveJob>>,
    pub(super) handle: Option<std::thread::JoinHandle<()>>,
    pub(super) error: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl ThreadSaver {
    pub(super) fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<ThreadSaveJob>();
        let error = std::sync::Arc::new(std::sync::Mutex::new(None));
        let sink = error.clone();
        let handle = std::thread::spawn(move || {
            for job in rx {
                match job {
                    ThreadSaveJob::Save(s) => {
                        if let Err(e) = super::super::cli_save_thread(
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

    pub(super) fn save(&self, save: ThreadSave) {
        if let Some(tx) = self.tx.as_ref() {
            let _ = tx.send(ThreadSaveJob::Save(save));
        }
    }

    /// Block until every save queued before this call has been written.
    pub(super) fn flush(&self) {
        let Some(tx) = self.tx.as_ref() else {
            return;
        };
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        if tx.send(ThreadSaveJob::Flush(done_tx)).is_ok() {
            let _ = done_rx.recv();
        }
    }

    pub(super) fn take_error(&self) -> Option<String> {
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

impl App {
    /// Non-terminal stream events. `Done`/`Error` are handled by the loop since
    /// they mutate history and the run handle.
    pub(super) fn apply(&mut self, ev: StreamEvent) {
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
    pub(super) fn apply_subagent_event(&mut self, run_id: &str, name: &str, event: StreamEvent) {
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
    pub(super) fn publish_agent_status(&mut self) {
        use super::super::agent_status::AgentStatusState as S;
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
    pub(super) fn begin_turn(&mut self) {
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
    pub(super) fn spinner(&self) -> &'static str {
        SPINNER[self.spinner_frame % SPINNER.len()]
    }

    /// Flush the current turn and return its text as the final assistant answer.
    pub(super) fn take_answer(&mut self) -> String {
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
    pub(super) fn native_reasoning_text(&self) -> String {
        self.reasoning_segs
            .iter()
            .map(|s| s.text.clone())
            .collect::<String>()
    }

    pub(super) fn on_done(&mut self, stop_reason: String, usage: Option<Usage>) {
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
    pub(super) fn should_auto_compact(&self) -> bool {
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
    pub(super) fn check_context_pressure(&mut self) {
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
    pub(super) fn request_overflow_recovery(&mut self, message: &str) -> bool {
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

    pub(super) fn on_error(&mut self, code: String, message: String) {
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
    pub(super) fn halt_turn(&mut self) {
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
    pub(super) fn begin_goal_evaluation(&mut self) -> Option<GoalEvalTask> {
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
    pub(super) fn stop_goal_evaluation(&mut self) {
        self.goal_evaluating = false;
        self.goal_eval_cancel = false;
        self.detail.clear();
        self.note("◎ goal evaluation stopped (goal kept; /goal clear to stop)");
        self.persist();
    }

    /// Act on a finished goal evaluation: auto-submit the next turn (goal
    /// unmet) or mark the goal achieved and return control (goal met).
    pub(super) fn finish_goal_evaluation(
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
    pub(super) fn cancel_run(&mut self) {
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
    pub(super) fn append_cancelled_turn_tools(&mut self) {
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
                .unwrap_or_else(|| super::super::MISSING_TOOL_RESULT.to_string());
            self.history.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": id,
                "content": content,
            }));
        }
    }
}
