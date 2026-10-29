//! The turn a headless run is in the middle of, kept on disk as it happens
//! (AH-026).
//!
//! A thread used to be written when a run finished. A run killed mid-turn -- the
//! process ended, the machine went down -- left nothing of that turn: not the
//! tool calls it had already made and been answered, not the reply it was
//! streaming. `--resume` then continued from the turn before, and the work was
//! lost or, worse, done twice.
//!
//! While a run is going, its thread directory holds the checkpoint: the
//! conversation as the loop last published it (every completed tool call and
//! result), the text the model has streamed since, and which process is writing
//! it (pid plus creation time, so a reused pid is never mistaken for the run).
//! A run that ends cleanly removes it. So a checkpoint found later means one of
//! two things, and they are told apart rather than guessed at:
//!
//! * the writer is still alive -- the run is still going, and resuming it from
//!   a second process is refused;
//! * the writer is gone -- the run was interrupted, and the next `--resume`
//!   offers the interrupted turn: continue it (the completed calls and the
//!   partial reply are kept, the partial reply marked as cut off) or discard the
//!   partial reply and continue from the last completed step.
//!
//! On disk (CLIA-013) the conversation is append-only: `inflight.jsonl` holds a
//! header line naming the writer, then one line per message. Publishing a
//! conversation that extends the one on disk appends only the new messages, so
//! a long session no longer rewrites (and re-encodes) its whole history on
//! every step. A conversation that does not extend it -- compaction rewrote the
//! history -- replaces the file atomically. The partial reply changes on every
//! token, so it lives in a small file of its own, `inflight.partial.json`,
//! replaced atomically. A torn last line (the process died mid-append) is the
//! one damage the reader forgives: every line before it was complete.
//!
//! A checkpoint written by an older build, a single `inflight.json`, is still
//! read, so a run interrupted before an upgrade can be resumed after it.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

/// The append-only conversation log: a header line, then one line per message.
const LOG_FILE: &str = "inflight.jsonl";
/// The partial reply, replaced as it grows.
const PARTIAL_FILE: &str = "inflight.partial.json";
/// The single-file checkpoint older builds wrote; read, never written.
const LEGACY_FILE: &str = "inflight.json";
const VERSION: u16 = 2;
/// How often streamed text is written while nothing else changes. A published
/// conversation is always written at once; this bounds only the partial reply.
const TEXT_EVERY: Duration = Duration::from_millis(400);
/// Kept on disk at most; a runaway stream must not grow the file without bound.
const MAX_PARTIAL_CHARS: usize = 64_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub v: u16,
    pub pid: u32,
    /// The writer's creation time, so a reused pid is not the writer.
    pub created: u64,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub model: String,
    /// The wire conversation as the loop last published it.
    pub conversation: Vec<Value>,
    /// What the model has streamed since that conversation was published.
    #[serde(default)]
    pub partial: String,
}

/// The first line of `inflight.jsonl`: who is writing, since when, for which
/// model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    v: u16,
    pid: u32,
    created: u64,
    started_at_ms: u64,
    model: String,
}

/// One message line of `inflight.jsonl`.
#[derive(Serialize, Deserialize)]
struct Entry {
    m: Value,
}

/// `inflight.partial.json`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Partial {
    updated_at_ms: u64,
    partial: String,
}

/// What a thread's checkpoint says about its last run.
#[derive(Debug, Clone, PartialEq)]
pub enum RunState {
    /// No run was in flight: the thread is as it was saved.
    Settled,
    /// A run is writing it now, from process `pid`.
    Live { pid: u32 },
    /// The run that was writing it is gone.
    Interrupted(Checkpoint),
}

/// What to do with an interrupted turn on resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum InterruptedChoice {
    /// Keep the completed tool calls and the partial reply (marked cut off).
    Continue,
    /// Keep the completed tool calls, drop the partial reply.
    DiscardPartial,
}

fn log_path(thread_dir: &Path) -> PathBuf {
    thread_dir.join(LOG_FILE)
}

fn partial_path(thread_dir: &Path) -> PathBuf {
    thread_dir.join(PARTIAL_FILE)
}

/// Where an older build kept its single-file checkpoint.
pub fn legacy_path(thread_dir: &Path) -> PathBuf {
    thread_dir.join(LEGACY_FILE)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn this_process() -> (u32, u64) {
    let pid = std::process::id();
    (pid, tauri_plugin_agent_tools::job_record::creation_time_of(pid).unwrap_or(0))
}

fn is_alive(pid: u32, created: u64) -> bool {
    // The same process -- pid and creation time -- and one that has not ended.
    // A checkpoint that cannot prove it (no pid, no creation time) is not
    // alive.
    use tauri_plugin_agent_tools::job_record::{still_running, ProcessIdentity, Verdict};
    still_running(&ProcessIdentity { pid, created }) == Verdict::Alive
}

fn encode_line<T: Serialize>(value: &T, out: &mut Vec<u8>) -> Result<(), HarnessError> {
    serde_json::to_writer(&mut *out, value).map_err(|e| {
        HarnessError::new(ErrorKind::Internal, format!("the checkpoint could not be encoded: {e}")).at(Stage::Persistence)
    })?;
    out.push(b'\n');
    Ok(())
}

/// Replace `file` with `body` so a crash leaves the old file or the new one,
/// never half of either: written beside it, synced, then renamed over it.
fn replace_atomically(file: &Path, body: &[u8]) -> Result<(), HarnessError> {
    let mut tmp_name = file.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(body)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, file)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e, "the checkpoint")
    })
}

/// Writes a run's checkpoint as it goes.
pub struct Writer {
    dir: PathBuf,
    checkpoint: Checkpoint,
    /// How many messages of `checkpoint.conversation` the log on disk holds.
    persisted: usize,
    /// The log on disk no longer matches a prefix of the conversation (or a
    /// write to it failed part-way): the next flush replaces it whole.
    rewrite: bool,
    /// The partial reply changed since it was last written.
    partial_dirty: bool,
    last_text_write: Instant,
    /// `checkpoint.partial.chars().count()`, kept as text arrives so the
    /// per-token cap check is O(1) instead of a rescan of the whole buffer
    /// (Jozkah/jan#152).
    partial_chars: usize,
    /// The run's lease (heartbeat kept on a thread of its own), so a second
    /// process cannot drive this thread and a crashed run's lease expires.
    /// Released when the writer is dropped.
    _lease: Option<crate::core::agent::lease::HeartbeatGuard>,
}

impl Writer {
    /// Start checkpointing a run into `thread_dir`. Refused when another live
    /// process is already running this thread.
    pub fn begin(thread_dir: &Path, model: &str, conversation: Vec<Value>) -> Result<Writer, HarnessError> {
        if let RunState::Live { pid } = state(thread_dir) {
            return Err(HarnessError::new(
                ErrorKind::InvalidInput,
                format!("this session is still being run by process {pid}; wait for it or stop it first"),
            )
            .at(Stage::Startup));
        }
        std::fs::create_dir_all(thread_dir).map_err(|e| io(e, "the session directory"))?;
        // The check above is a read; the lease is the atomic claim that makes
        // two simultaneous starters produce one winner.
        let session = thread_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let lease = std::sync::Arc::new(crate::core::agent::lease::Lease::acquire(thread_dir, &session)?);
        let heartbeat = lease.keep_alive(&session);
        let (pid, created) = this_process();
        let now = now_ms();
        let mut writer = Writer {
            dir: thread_dir.to_path_buf(),
            checkpoint: Checkpoint {
                v: VERSION,
                pid,
                created,
                started_at_ms: now,
                updated_at_ms: now,
                model: model.to_string(),
                conversation,
                partial: String::new(),
            },
            persisted: 0,
            rewrite: true,
            partial_dirty: true,
            last_text_write: Instant::now(),
            partial_chars: 0,
            _lease: Some(heartbeat),
        };
        writer.flush()?;
        // This run's checkpoint now stands in for whatever an older build
        // left: the conversation it began from already contains it.
        let _ = std::fs::remove_file(legacy_path(thread_dir));
        Ok(writer)
    }

    /// The loop published its conversation: everything up to the last completed
    /// step is now durable, and the partial reply starts again.
    pub fn conversation(&mut self, messages: &[Value]) {
        let extends = messages.len() >= self.persisted
            && !self.rewrite
            && messages[..self.persisted] == self.checkpoint.conversation[..self.persisted];
        if extends {
            self.checkpoint.conversation.truncate(self.persisted);
            self.checkpoint.conversation.extend_from_slice(&messages[self.persisted..]);
        } else {
            self.checkpoint.conversation = messages.to_vec();
            self.rewrite = true;
        }
        if !self.checkpoint.partial.is_empty() {
            self.partial_dirty = true;
        }
        self.checkpoint.partial.clear();
        self.partial_chars = 0;
        let _ = self.flush();
    }

    /// The model streamed more of its reply. Written at most every
    /// `TEXT_EVERY`, so a fast stream does not become a disk loop.
    pub fn text(&mut self, delta: &str) {
        if self.partial_chars < MAX_PARTIAL_CHARS {
            self.checkpoint.partial.push_str(delta);
            self.partial_chars += delta.chars().count();
            self.partial_dirty = true;
        }
        if self.last_text_write.elapsed() >= TEXT_EVERY {
            let _ = self.flush();
        }
    }

    /// Write what has changed: the messages the log does not hold yet, then the
    /// partial reply. A crash mid-write leaves every complete line before it.
    pub fn flush(&mut self) -> Result<(), HarnessError> {
        let pending = self.checkpoint.conversation.len() > self.persisted;
        if !self.rewrite && !pending && !self.partial_dirty {
            return Ok(());
        }
        self.checkpoint.updated_at_ms = now_ms();
        if self.rewrite {
            let mut body = Vec::new();
            encode_line(&self.header(), &mut body)?;
            for m in &self.checkpoint.conversation {
                encode_line(&Entry { m: m.clone() }, &mut body)?;
            }
            replace_atomically(&log_path(&self.dir), &body)?;
            self.rewrite = false;
            self.persisted = self.checkpoint.conversation.len();
        } else if pending {
            let mut body = Vec::new();
            for m in &self.checkpoint.conversation[self.persisted..] {
                encode_line(&Entry { m: m.clone() }, &mut body)?;
            }
            let append = || -> std::io::Result<()> {
                let mut f = std::fs::OpenOptions::new().append(true).open(log_path(&self.dir))?;
                f.write_all(&body)?;
                f.sync_data()
            };
            if let Err(e) = append() {
                // A part-written tail cannot be appended after: the next flush
                // writes the whole log again.
                self.rewrite = true;
                return Err(io(e, "the checkpoint"));
            }
            self.persisted = self.checkpoint.conversation.len();
        }
        if self.partial_dirty {
            if self.checkpoint.partial.is_empty() {
                match std::fs::remove_file(partial_path(&self.dir)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(io(e, "the checkpoint")),
                }
            } else {
                let body = serde_json::to_vec(&Partial {
                    updated_at_ms: self.checkpoint.updated_at_ms,
                    partial: self.checkpoint.partial.clone(),
                })
                .map_err(|e| {
                    HarnessError::new(ErrorKind::Internal, format!("the checkpoint could not be encoded: {e}"))
                        .at(Stage::Persistence)
                })?;
                replace_atomically(&partial_path(&self.dir), &body)?;
            }
            self.partial_dirty = false;
        }
        self.last_text_write = Instant::now();
        Ok(())
    }

    fn header(&self) -> Header {
        Header {
            v: VERSION,
            pid: self.checkpoint.pid,
            created: self.checkpoint.created,
            started_at_ms: self.checkpoint.started_at_ms,
            model: self.checkpoint.model.clone(),
        }
    }

    /// The run ended and its thread was saved: nothing is in flight any more.
    pub fn finish(self) {
        clear(&self.dir);
    }
}

fn io(e: std::io::Error, what: &str) -> HarnessError {
    HarnessError::new(ErrorKind::Io, format!("{what} could not be written: {e}")).at(Stage::Persistence)
}

/// Parse `inflight.jsonl`. `None` when it is damaged anywhere but a torn last
/// line, which is what a crash mid-append leaves and is dropped.
fn parse_log(text: &str) -> Option<Checkpoint> {
    let mut lines = text.split('\n').filter(|l| !l.trim().is_empty()).peekable();
    let header: Header = serde_json::from_str(lines.next()?).ok()?;
    let mut conversation = Vec::new();
    while let Some(line) = lines.next() {
        match serde_json::from_str::<Entry>(line) {
            Ok(entry) => conversation.push(entry.m),
            // Only the very last line may be torn, and only when the file does
            // not end in the newline every complete line is written with.
            Err(_) if lines.peek().is_none() && !text.ends_with('\n') => break,
            Err(_) => return None,
        }
    }
    Some(Checkpoint {
        v: header.v,
        pid: header.pid,
        created: header.created,
        started_at_ms: header.started_at_ms,
        updated_at_ms: header.started_at_ms,
        model: header.model,
        conversation,
        partial: String::new(),
    })
}

/// What an unreadable checkpoint recovers: nothing beyond the saved thread.
fn unreadable() -> Checkpoint {
    Checkpoint {
        v: VERSION,
        pid: 0,
        created: 0,
        started_at_ms: 0,
        updated_at_ms: 0,
        model: String::new(),
        conversation: Vec::new(),
        partial: String::new(),
    }
}

/// The checkpoint on disk, current format first, then an older build's single
/// file. `None` when there is none; `Some(Err(()))` when one exists but cannot
/// be read.
fn load(thread_dir: &Path) -> Option<Result<Checkpoint, ()>> {
    if let Ok(text) = std::fs::read_to_string(log_path(thread_dir)) {
        let Some(mut checkpoint) = parse_log(&text) else {
            return Some(Err(()));
        };
        if let Ok(body) = std::fs::read(partial_path(thread_dir)) {
            // A partial reply that cannot be read loses only the reply, never
            // the completed steps.
            if let Ok(partial) = serde_json::from_slice::<Partial>(&body) {
                checkpoint.updated_at_ms = partial.updated_at_ms;
                checkpoint.partial = partial.partial;
            }
        }
        return Some(Ok(checkpoint));
    }
    let text = std::fs::read_to_string(legacy_path(thread_dir)).ok()?;
    Some(serde_json::from_str::<Checkpoint>(&text).map_err(|_| ()))
}

/// The checkpoint on disk, if a readable one exists.
pub fn read(thread_dir: &Path) -> Option<Checkpoint> {
    load(thread_dir).and_then(Result::ok)
}

/// What the thread's checkpoint says. An unreadable checkpoint is reported as
/// an interrupted run with nothing recoverable in it, never as settled.
pub fn state(thread_dir: &Path) -> RunState {
    // A live lease is the authority: its holder is driving the thread whether
    // or not it has written a checkpoint yet.
    if let crate::core::agent::lease::Status::Held(lease) = crate::core::agent::lease::status(thread_dir) {
        return RunState::Live { pid: lease.pid };
    }
    let checkpoint = match load(thread_dir) {
        None => return RunState::Settled,
        Some(Err(())) => return RunState::Interrupted(unreadable()),
        Some(Ok(checkpoint)) => checkpoint,
    };
    if is_alive(checkpoint.pid, checkpoint.created) {
        RunState::Live { pid: checkpoint.pid }
    } else {
        RunState::Interrupted(checkpoint)
    }
}

/// The conversation to continue an interrupted run from, as `choice` asks.
///
/// The partial reply is never put in the assistant's voice as if the model had
/// finished it: kept, it is the assistant text that arrived, followed by a note
/// that the turn was cut off, so the model continues the work rather than
/// imitating a status marker in its own replies. The note is a user-role
/// message that says it comes from Flint: the loop replaces every `system`
/// message with its own prompt when a run starts, so a system note would
/// never reach the model.
pub fn recovered_conversation(checkpoint: &Checkpoint, choice: InterruptedChoice) -> Vec<Value> {
    let mut messages = checkpoint.conversation.clone();
    let partial = checkpoint.partial.trim();
    if choice == InterruptedChoice::Continue && !partial.is_empty() {
        messages.push(serde_json::json!({ "role": "assistant", "content": partial }));
    }
    let note = match (choice, partial.is_empty()) {
        (_, true) => "The previous run was interrupted before this point; every completed step above is kept. Continue the task.",
        (InterruptedChoice::Continue, false) => "The previous run was interrupted while the reply above was being written; it may be incomplete. Continue the task from there.",
        (InterruptedChoice::DiscardPartial, false) => "The previous run was interrupted mid-reply; that partial reply was discarded and every completed step above is kept. Continue the task.",
    };
    messages.push(serde_json::json!({ "role": "user", "content": format!("{NOTE_PREFIX}{note}") }));
    messages
}

/// How a recovery note begins, so neither the model nor a reader of the
/// transcript mistakes it for something the person typed.
pub const NOTE_PREFIX: &str = "Note from Jan (not typed by the user): ";

/// Forget a thread's checkpoint once its recovery has been taken.
pub fn clear(thread_dir: &Path) {
    for file in [log_path(thread_dir), partial_path(thread_dir), legacy_path(thread_dir)] {
        let _ = std::fs::remove_file(file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write as _;

    fn convo() -> Vec<Value> {
        vec![
            json!({ "role": "user", "content": "fix it" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function", "function": { "name": "read", "arguments": "{}" } }] }),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "file body" }),
        ]
    }

    /// Stand in for a writer that died: rewrite the header so its identity is
    /// no longer this process's.
    fn kill_writer(dir: &Path) {
        let text = std::fs::read_to_string(log_path(dir)).unwrap();
        let (first, rest) = text.split_once('\n').unwrap();
        let mut header: Header = serde_json::from_str(first).unwrap();
        header.created = header.created.wrapping_add(1);
        std::fs::write(log_path(dir), format!("{}\n{rest}", serde_json::to_string(&header).unwrap())).unwrap();
    }

    fn log_lines(dir: &Path) -> usize {
        std::fs::read_to_string(log_path(dir)).unwrap().lines().count()
    }

    /// CLIA-013: a published conversation that extends the one on disk appends
    /// only its new messages; the lines already written are left as they were.
    #[test]
    fn publishing_a_longer_conversation_appends_only_the_new_messages() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", convo()[..1].to_vec()).unwrap();
        let before = std::fs::read_to_string(log_path(dir.path())).unwrap();
        assert_eq!(log_lines(dir.path()), 2, "header + one message");
        w.conversation(&convo());
        let after = std::fs::read_to_string(log_path(dir.path())).unwrap();
        assert!(after.starts_with(&before), "the written prefix is untouched");
        assert_eq!(log_lines(dir.path()), 4);
        // Publishing the same conversation again writes nothing.
        w.conversation(&convo());
        assert_eq!(std::fs::read_to_string(log_path(dir.path())).unwrap(), after);
        assert_eq!(read(dir.path()).unwrap().conversation, convo());
        w.finish();
    }

    /// A conversation that does not extend the one on disk -- compaction
    /// rewrote the history -- replaces the log rather than appending to it.
    #[test]
    fn a_rewritten_history_replaces_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", convo()).unwrap();
        let compacted = vec![json!({ "role": "user", "content": "summary of earlier work" })];
        w.conversation(&compacted);
        assert_eq!(log_lines(dir.path()), 2);
        assert_eq!(read(dir.path()).unwrap().conversation, compacted);
        w.finish();
    }

    /// A process killed mid-append leaves a torn last line. Every complete line
    /// before it is recovered; the torn one is dropped.
    #[test]
    fn a_torn_last_line_is_dropped_and_the_rest_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", convo()).unwrap();
        w.flush().unwrap();
        drop(w);
        kill_writer(dir.path());
        let mut f = std::fs::OpenOptions::new().append(true).open(log_path(dir.path())).unwrap();
        f.write_all(br#"{"m":{"role":"assistant","cont"#).unwrap();
        drop(f);
        let RunState::Interrupted(checkpoint) = state(dir.path()) else { panic!("interrupted") };
        assert_eq!(checkpoint.conversation, convo());
    }

    /// Damage anywhere but the tail is not a torn append, so nothing in the file
    /// can be trusted: the run reads as interrupted with nothing to recover.
    #[test]
    fn damage_before_the_last_line_recovers_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let w = Writer::begin(dir.path(), "m", convo()).unwrap();
        drop(w);
        kill_writer(dir.path());
        let text = std::fs::read_to_string(log_path(dir.path())).unwrap();
        let mut lines: Vec<&str> = text.lines().collect();
        lines[1] = "{ not json";
        std::fs::write(log_path(dir.path()), lines.join("\n") + "\n").unwrap();
        let RunState::Interrupted(c) = state(dir.path()) else { panic!("interrupted") };
        assert!(c.conversation.is_empty() && c.partial.is_empty());
    }

    /// A checkpoint an older build wrote (one `inflight.json`) is still read, so
    /// a run interrupted before an upgrade resumes after it; the new writer
    /// replaces it.
    #[test]
    fn an_older_builds_checkpoint_is_still_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let old = Checkpoint {
            v: 1,
            pid: 0,
            created: 0,
            started_at_ms: 1,
            updated_at_ms: 2,
            model: "m".into(),
            conversation: convo(),
            partial: "half a rep".into(),
        };
        std::fs::write(legacy_path(dir.path()), serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(state(dir.path()), RunState::Interrupted(old.clone()));
        let w = Writer::begin(dir.path(), "m", recovered_conversation(&old, InterruptedChoice::Continue)).unwrap();
        assert!(!legacy_path(dir.path()).exists(), "the new checkpoint stands in for the old one");
        assert_eq!(read(dir.path()).unwrap().conversation.len(), 5);
        w.finish();
        assert_eq!(state(dir.path()), RunState::Settled);
    }

    /// The partial reply survives a crash next to the completed steps, and an
    /// unreadable partial file loses only the reply.
    #[test]
    fn the_partial_reply_survives_beside_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", convo()).unwrap();
        w.text("I will now ");
        w.flush().unwrap();
        drop(w);
        kill_writer(dir.path());
        let RunState::Interrupted(c) = state(dir.path()) else { panic!("interrupted") };
        assert_eq!(c.partial, "I will now ");
        std::fs::write(partial_path(dir.path()), "{ torn").unwrap();
        let RunState::Interrupted(c) = state(dir.path()) else { panic!("interrupted") };
        assert_eq!(c.conversation, convo());
        assert!(c.partial.is_empty());
        clear(dir.path());
        assert_eq!(state(dir.path()), RunState::Settled);
        assert!(!partial_path(dir.path()).exists());
    }

    #[test]
    fn a_live_run_is_live_and_a_second_writer_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", convo()).unwrap();
        w.text("half a rep");
        w.flush().unwrap();
        assert_eq!(state(dir.path()), RunState::Live { pid: std::process::id() });
        let refused = Writer::begin(dir.path(), "m", convo()).err().expect("a second writer is refused");
        assert_eq!(refused.kind(), ErrorKind::InvalidInput);
        assert!(refused.message().contains("still being run"));
        w.finish();
        assert_eq!(state(dir.path()), RunState::Settled, "a clean end leaves nothing in flight");
    }

    #[test]
    fn a_writer_that_is_gone_leaves_an_interrupted_turn_with_its_completed_steps() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", vec![json!({ "role": "user", "content": "fix it" })]).unwrap();
        w.conversation(&convo());
        w.text("I have read the file and will now ");
        w.flush().unwrap();
        drop(w); // not finished: the process "died"
        kill_writer(dir.path());

        let RunState::Interrupted(checkpoint) = state(dir.path()) else { panic!("interrupted") };
        assert_eq!(checkpoint.conversation, convo(), "the completed tool call and its result survive");
        assert_eq!(checkpoint.partial, "I have read the file and will now ");

        let kept = recovered_conversation(&checkpoint, InterruptedChoice::Continue);
        assert_eq!(&kept[..3], &convo()[..]);
        assert_eq!(kept[3], json!({ "role": "assistant", "content": "I have read the file and will now" }));
        assert_eq!(kept[4]["role"], "user", "a system note would be replaced by the run's prompt");
        let note = kept[4]["content"].as_str().unwrap();
        assert!(note.starts_with(NOTE_PREFIX) && note.contains("may be incomplete"), "{note}");

        let dropped = recovered_conversation(&checkpoint, InterruptedChoice::DiscardPartial);
        assert_eq!(dropped.len(), 4);
        assert!(dropped.iter().all(|m| m["content"] != "I have read the file and will now"));
        assert_eq!(dropped[3]["role"], "user");
        assert!(dropped[3]["content"].as_str().unwrap().contains("discarded"));
    }

    #[test]
    fn publishing_the_conversation_restarts_the_partial_reply() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", Vec::new()).unwrap();
        w.text("stale");
        w.conversation(&convo());
        w.flush().unwrap();
        let on_disk = read(dir.path()).unwrap();
        assert!(on_disk.partial.is_empty());
        assert_eq!(on_disk.conversation.len(), 3);
        w.finish();
    }

    #[test]
    fn an_unreadable_checkpoint_is_an_interruption_with_nothing_to_recover_not_a_clean_thread() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(log_path(dir.path()), "{ not json").unwrap();
        let RunState::Interrupted(c) = state(dir.path()) else { panic!("interrupted") };
        assert!(c.conversation.is_empty() && c.partial.is_empty());
        clear(dir.path());
        assert_eq!(state(dir.path()), RunState::Settled);
    }

    #[test]
    fn the_partial_reply_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", Vec::new()).unwrap();
        let chunk = "x".repeat(10_000);
        for _ in 0..10 {
            w.text(&chunk);
        }
        assert!(w.checkpoint.partial.chars().count() <= MAX_PARTIAL_CHARS + chunk.len());
        w.finish();
    }

    /// Jozkah/jan#152: the cap is checked against a running count, which must
    /// match the buffer through multi-byte text, the cap, and a restart.
    #[test]
    fn the_running_partial_count_matches_the_buffer() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Writer::begin(dir.path(), "m", Vec::new()).unwrap();
        let chunk = "été".repeat(4_000);
        for _ in 0..10 {
            w.text(&chunk);
            assert_eq!(w.partial_chars, w.checkpoint.partial.chars().count());
        }
        let full = w.checkpoint.partial.len();
        w.text("more");
        assert_eq!(w.checkpoint.partial.len(), full, "grew past the cap");
        w.conversation(&[]);
        assert_eq!(w.partial_chars, 0);
        w.text("ab");
        assert_eq!(w.partial_chars, 2);
        w.finish();
    }
}
