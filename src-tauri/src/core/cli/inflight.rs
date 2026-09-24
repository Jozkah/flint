//! The turn a headless run is in the middle of, kept on disk as it happens
//! (AH-026).
//!
//! A thread used to be written when a run finished. A run killed mid-turn -- the
//! process ended, the machine went down -- left nothing of that turn: not the
//! tool calls it had already made and been answered, not the reply it was
//! streaming. `--resume` then continued from the turn before, and the work was
//! lost or, worse, done twice.
//!
//! While a run is going, its thread directory holds `inflight.json`: the
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

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

const FILE: &str = "inflight.json";
const VERSION: u16 = 1;
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

pub fn path(thread_dir: &Path) -> PathBuf {
    thread_dir.join(FILE)
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

/// Writes a run's checkpoint as it goes.
pub struct Writer {
    file: PathBuf,
    checkpoint: Checkpoint,
    last_text_write: Instant,
    dirty: bool,
    /// `checkpoint.partial.chars().count()`, kept as text arrives so the
    /// per-token cap check is O(1) instead of a rescan of the whole buffer
    /// (Jozkah/jan#152).
    partial_chars: usize,
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
        let (pid, created) = this_process();
        let now = now_ms();
        let mut writer = Writer {
            file: path(thread_dir),
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
            last_text_write: Instant::now(),
            dirty: true,
            partial_chars: 0,
        };
        writer.flush()?;
        Ok(writer)
    }

    /// The loop published its conversation: everything up to the last completed
    /// step is now durable, and the partial reply starts again.
    pub fn conversation(&mut self, messages: &[Value]) {
        self.checkpoint.conversation = messages.to_vec();
        self.checkpoint.partial.clear();
        self.partial_chars = 0;
        self.dirty = true;
        let _ = self.flush();
    }

    /// The model streamed more of its reply. Written at most every
    /// `TEXT_EVERY`, so a fast stream does not become a disk loop.
    pub fn text(&mut self, delta: &str) {
        if self.partial_chars < MAX_PARTIAL_CHARS {
            self.checkpoint.partial.push_str(delta);
            self.partial_chars += delta.chars().count();
            self.dirty = true;
        }
        if self.last_text_write.elapsed() >= TEXT_EVERY {
            let _ = self.flush();
        }
    }

    /// Write what has changed. Atomic: a crash mid-write leaves the previous
    /// checkpoint, never half of one.
    pub fn flush(&mut self) -> Result<(), HarnessError> {
        if !self.dirty {
            return Ok(());
        }
        self.checkpoint.updated_at_ms = now_ms();
        let body = serde_json::to_vec(&self.checkpoint).map_err(|e| {
            HarnessError::new(ErrorKind::Internal, format!("the checkpoint could not be encoded: {e}")).at(Stage::Persistence)
        })?;
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| io(e, "the checkpoint"))?;
        std::fs::rename(&tmp, &self.file).map_err(|e| io(e, "the checkpoint"))?;
        self.dirty = false;
        self.last_text_write = Instant::now();
        Ok(())
    }

    /// The run ended and its thread was saved: nothing is in flight any more.
    pub fn finish(self) {
        let _ = std::fs::remove_file(&self.file);
    }
}

fn io(e: std::io::Error, what: &str) -> HarnessError {
    HarnessError::new(ErrorKind::Io, format!("{what} could not be written: {e}")).at(Stage::Persistence)
}

/// What the thread's checkpoint says. An unreadable checkpoint is reported as
/// an interrupted run with nothing recoverable in it, never as settled.
pub fn state(thread_dir: &Path) -> RunState {
    let Ok(text) = std::fs::read_to_string(path(thread_dir)) else {
        return RunState::Settled;
    };
    let Ok(checkpoint) = serde_json::from_str::<Checkpoint>(&text) else {
        return RunState::Interrupted(Checkpoint {
            v: VERSION,
            pid: 0,
            created: 0,
            started_at_ms: 0,
            updated_at_ms: 0,
            model: String::new(),
            conversation: Vec::new(),
            partial: String::new(),
        });
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
    let _ = std::fs::remove_file(path(thread_dir));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn convo() -> Vec<Value> {
        vec![
            json!({ "role": "user", "content": "fix it" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function", "function": { "name": "read", "arguments": "{}" } }] }),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "file body" }),
        ]
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
        // Stand in for a dead writer: a pid that is not this process's
        // identity any more.
        let mut on_disk: Checkpoint = serde_json::from_str(&std::fs::read_to_string(path(dir.path())).unwrap()).unwrap();
        on_disk.created = on_disk.created.wrapping_add(1);
        std::fs::write(path(dir.path()), serde_json::to_vec(&on_disk).unwrap()).unwrap();

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
        let on_disk: Checkpoint = serde_json::from_str(&std::fs::read_to_string(path(dir.path())).unwrap()).unwrap();
        assert!(on_disk.partial.is_empty());
        assert_eq!(on_disk.conversation.len(), 3);
        w.finish();
    }

    #[test]
    fn an_unreadable_checkpoint_is_an_interruption_with_nothing_to_recover_not_a_clean_thread() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), "{ not json").unwrap();
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
