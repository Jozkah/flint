use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

// For async file write serialization
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::Mutex;

use super::utils::{get_messages_path, get_thread_metadata_path};

const NEWLINE: u8 = 10;
const NEWLINE_BYTES: &[u8] = &[NEWLINE];

// Global per-thread locks for message file writes
// The map itself sits behind a std mutex: it is never held across an await,
// so lookups need no async scheduling.
pub static MESSAGE_LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    OnceLock::new();

/// Idle locks are only swept once the map grows past this, so a lookup is
/// O(1) in the common case instead of scanning every entry.
const LOCK_SWEEP_AT: usize = 256;

/// Key `list_thread_summaries` sets on an assistant it cut to `{id, name, model}`.
pub const SUMMARY_MARKER: &str = "summary";

/// A thread write that carries a summary assistant back (the sidebar's copy,
/// not yet hydrated) must not overwrite the stored instructions and
/// parameters: each marked assistant is replaced by the stored one with the
/// same id, keeping only the incoming `model` and `name`. With no stored match
/// the marker is just dropped. Never writes the marker.
pub fn restore_summary_assistants(thread: &mut serde_json::Value, stored: Option<&serde_json::Value>) {
    let stored_list = stored
        .and_then(|s| s.get("assistants"))
        .and_then(|a| a.as_array());
    let Some(list) = thread.get_mut("assistants").and_then(|a| a.as_array_mut()) else {
        return;
    };
    for a in list.iter_mut() {
        let Some(obj) = a.as_object_mut() else { continue };
        if obj.remove(SUMMARY_MARKER).is_none() {
            continue;
        }
        let id = obj.get("id").cloned();
        let full = stored_list.and_then(|l| {
            l.iter().find(|s| id.is_some() && s.get("id") == id.as_ref())
        });
        if let Some(serde_json::Value::Object(full)) = full {
            let mut merged = full.clone();
            merged.remove(SUMMARY_MARKER);
            for key in ["model", "name"] {
                if let Some(v) = obj.get(key) {
                    merged.insert(key.to_string(), v.clone());
                }
            }
            *obj = merged;
        }
    }
}

/// Check if the platform should use SQLite (mobile platforms)
pub fn should_use_sqlite() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

/// Get a lock for a specific thread to ensure thread-safe message file operations
///
/// Entries nobody holds any more are evicted on the way (Jozkah/jan#179): the
/// map owns one `Arc` per entry, so a strong count of 1 means no operation is
/// using or waiting on that lock and a fresh one can stand in for it later.
/// Without this the map kept an entry for every thread ever touched, deleted
/// threads included, for the life of the process.
pub async fn get_lock_for_thread(thread_id: &str) -> Arc<Mutex<()>> {
    let locks = MESSAGE_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut locks = locks.lock().unwrap_or_else(|p| p.into_inner());
    if locks.len() >= LOCK_SWEEP_AT {
        locks.retain(|id, lock| id == thread_id || Arc::strong_count(lock) > 1);
    }
    let lock = locks
        .entry(thread_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    drop(locks); // Release the map lock before returning the file lock
    lock
}

/// Replace a thread's messages.jsonl with `messages`, atomically.
///
/// The new content is written to a staging file beside the real one, flushed to
/// disk, and renamed over it. A rename within one directory is atomic on every
/// platform Flint ships on, so a reader sees either the old file or the new one,
/// never a torn mixture. This used to `File::create` the real path -- truncate
/// first, write second -- and an interruption in between left a thread that
/// could not be read at all (janhq/jan#8019).
pub fn write_messages_to_file(
    messages: &[serde_json::Value],
    path: &std::path::Path,
) -> Result<(), String> {
    invalidate_append_cache(path);
    let mut contents = Vec::new();
    for msg in messages {
        let data = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        writeln!(contents, "{data}").map_err(|e| e.to_string())?;
    }
    write_file_atomically(path, &contents)
}

/// Kept under its old name for the thread stores; see `atomic_io`.
pub use crate::core::atomic_io::write_atomic_durable as write_file_atomically;

/// Append one message as a line of a thread's messages.jsonl file.
///
/// An append interrupted mid-line leaves a tail with no newline. Appending
/// straight after it would glue the new message onto that fragment and lose
/// both, so the tail is settled first: a fragment that does not parse is what a
/// crash leaves and is cut off (its content was never complete), and a tail
/// that parses but only lacked its newline gets one.
#[cfg(test)]
pub fn append_message_line(path: &Path, message: &serde_json::Value) -> Result<(), String> {
    append_message_line_if_new(path, message, None).map(|_| ())
}

/// Append `message` unless a message with the same `id` is already in the
/// file, reading the file once for both the duplicate check and the torn-tail
/// check. `append_message_line` after `read_messages_from_file` read it three
/// times per message, which made a long thread quadratic to write (#196).
/// Returns `false` when the id was already there and nothing was written.
pub fn append_message_line_if_new(
    path: &Path,
    message: &serde_json::Value,
    id: Option<&str>,
) -> Result<bool, String> {
    let len = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.to_string()),
    };
    // Taking the entry out means every error path below leaves the cache
    // without it, so a failed append is never trusted later.
    let cached = append_cache().remove(path);
    let (ids, revisions) = match (id, cached) {
        // Same length as when this process last wrote: nobody else touched it.
        (_, Some(state)) if state.len == len => (Some(state.ids), state.revisions),
        (Some(_), _) => (Some(scan_message_ids(path)?), 0),
        (None, _) => (None, 0),
    };
    if let (Some(id), Some(set)) = (id, ids.as_ref()) {
        if set.contains(id) {
            if let Some(ids) = ids {
                cache_put_state(path, TailState { len, ids, revisions });
            }
            return Ok(false);
        }
    }
    let settled_len = settle_tail_from_disk(path, len)?;
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    // On disk before the caller reports it saved (DAT-034), like revisions.
    file.sync_data().map_err(|e| e.to_string())?;
    if let (Some(id), Some(mut set)) = (id, ids) {
        set.insert(id.to_owned());
        cache_put_state(path, TailState { len: settled_len + line.len() as u64, ids: set, revisions });
    }
    Ok(true)
}

/// Revision lines a messages file may carry before an update compacts it.
pub const MAX_REVISIONS: usize = 16;

/// Append `message` (whose `id` may already be in the file) as a revision
/// line instead of rewriting the whole file: readers fold a later line with
/// the same id onto the earlier one (see [`fold_revisions`]). Returns how many
/// revision lines the file now carries as far as this process knows, `None`
/// when that is unknown (the file changed under another writer), so the
/// caller can compact once there are too many.
pub fn append_message_revision(
    path: &Path,
    message: &serde_json::Value,
    id: &str,
) -> Result<Option<usize>, String> {
    let len = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.to_string()),
    };
    let cached = append_cache().remove(path).filter(|state| state.len == len);
    let settled_len = settle_tail_from_disk(path, len)?;
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    // An update is often the final form of a streamed reply: on disk before
    // the UI calls it saved.
    file.sync_data().map_err(|e| e.to_string())?;
    let new_len = settled_len + line.len() as u64;
    Ok(cached.map(|mut state| {
        if !state.ids.insert(id.to_owned()) {
            state.revisions += 1;
        }
        let revisions = state.revisions;
        cache_put_state(path, TailState { len: new_len, ..state });
        revisions
    }))
}

/// Fold revision lines: a message whose `id` was already seen replaces the
/// earlier one in place (the conversation order is where a message first
/// appeared). Returns the folded list and how many lines were revisions.
pub fn fold_revisions(messages: Vec<serde_json::Value>) -> (Vec<serde_json::Value>, usize) {
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<serde_json::Value> = Vec::with_capacity(messages.len());
    let mut revisions = 0;
    for message in messages {
        let id = message.get("id").and_then(|v| v.as_str()).map(str::to_owned);
        match id {
            Some(id) => match at.get(&id) {
                Some(&i) => {
                    out[i] = message;
                    revisions += 1;
                }
                None => {
                    at.insert(id, out.len());
                    out.push(message);
                }
            },
            None => out.push(message),
        }
    }
    (out, revisions)
}

/// How much of the file's end is read to settle a torn tail.
const TAIL_WINDOW: u64 = 64 * 1024;
/// Messages files whose ids are remembered between appends.
const APPEND_CACHE_FILES: usize = 64;

/// What the last append to a messages file left behind: its length, and the ids
/// it holds, so the next append neither re-reads nor re-scans the file. A
/// length that no longer matches (the CLI or web server wrote) discards it.
struct TailState {
    len: u64,
    ids: std::collections::HashSet<String>,
    /// Revision lines written since the file was last compacted, as far as
    /// this process saw.
    revisions: usize,
}

type TailMap = HashMap<std::path::PathBuf, TailState>;

fn append_cache() -> std::sync::MutexGuard<'static, TailMap> {
    static CACHE: OnceLock<std::sync::Mutex<TailMap>> = OnceLock::new();
    CACHE
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn cache_put(path: &Path, len: u64, ids: std::collections::HashSet<String>) {
    cache_put_state(path, TailState { len, ids, revisions: 0 });
}

fn cache_put_state(path: &Path, state: TailState) {
    let mut cache = append_cache();
    if cache.len() >= APPEND_CACHE_FILES {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), state);
}

/// Remember a just-compacted file as holding `messages` and no revisions.
pub fn remember_compacted(path: &Path, messages: &[serde_json::Value]) {
    let Ok(len) = fs::metadata(path).map(|m| m.len()) else { return };
    let ids = messages
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    cache_put(path, len, ids);
}

/// Forget what is remembered about a messages file. Call after anything that
/// rewrites or removes it.
pub fn invalidate_append_cache(path: &Path) {
    append_cache().remove(path);
}

/// Every message id in the file, read line by line. A line that does not parse
/// is ignored, as the old whole-file duplicate check did.
fn scan_message_ids(path: &Path) -> Result<std::collections::HashSet<String>, String> {
    let mut ids = std::collections::HashSet::new();
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
        Err(e) => return Err(e.to_string()),
    };
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if reader.read_until(NEWLINE, &mut buf).map_err(|e| e.to_string())? == 0 {
            break;
        }
        if let Ok(m) = serde_json::from_slice::<serde_json::Value>(&buf) {
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                ids.insert(id.to_owned());
            }
        }
    }
    Ok(ids)
}

/// Settle a torn tail reading only the end of the file; returns the file's
/// length afterwards. A final line longer than the window falls back to
/// reading the whole file.
fn settle_tail_from_disk(path: &Path, len: u64) -> Result<u64, String> {
    use std::io::{Read, Seek, SeekFrom};
    if len == 0 {
        return Ok(0);
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let window_start = len.saturating_sub(TAIL_WINDOW);
    file.seek(SeekFrom::Start(window_start))
        .map_err(|e| e.to_string())?;
    let mut window = Vec::new();
    file.take(len - window_start)
        .read_to_end(&mut window)
        .map_err(|e| e.to_string())?;
    if window.ends_with(NEWLINE_BYTES) {
        return Ok(len);
    }
    match window.iter().rposition(|b| *b == NEWLINE) {
        Some(i) => settle_tail_at(path, &window[i + 1..], window_start + i as u64 + 1, len),
        None if window_start == 0 => settle_tail_at(path, &window, 0, len),
        None => {
            let bytes = read_if_present(path)?;
            let tail_start = bytes
                .iter()
                .rposition(|b| *b == NEWLINE)
                .map_or(0, |i| i + 1);
            settle_tail_at(
                path,
                &bytes[tail_start..],
                tail_start as u64,
                bytes.len() as u64,
            )
        }
    }
}

fn read_if_present(path: &Path) -> Result<Vec<u8>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Settle an unterminated final line `tail` that starts at byte `tail_start`
/// of a `len`-byte file; returns the new length.
fn settle_tail_at(path: &Path, tail: &[u8], tail_start: u64, len: u64) -> Result<u64, String> {
    if serde_json::from_slice::<serde_json::Value>(tail).is_ok() {
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(NEWLINE_BYTES).map_err(|e| e.to_string())?;
        Ok(len + 1)
    } else {
        log::warn!(
            "messages: dropping an incomplete final line ({} bytes) in {}",
            tail.len(),
            path.display()
        );
        let file = fs::OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.set_len(tail_start).map_err(|e| e.to_string())?;
        Ok(tail_start)
    }
}

/// Read messages from a thread's messages.jsonl file
pub fn read_messages_from_file(
    data_folder: &Path,
    thread_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let path = get_messages_path(data_folder, thread_id);
    if !path.exists() {
        return Ok(vec![]);
    }

    let bytes = fs::read(&path).map_err(|e| {
        eprintln!("Error opening file {}: {}", path.display(), e);
        e.to_string()
    })?;
    // Whether the last line was terminated, from the one buffer already
    // read. An interrupted append leaves an unterminated fragment, and that
    // one shape is tolerated below.
    let terminated = bytes.is_empty() || bytes.ends_with(NEWLINE_BYTES);
    let text = String::from_utf8(bytes).map_err(|e| {
        eprintln!("Error reading line from file {}: {}", path.display(), e);
        e.to_string()
    })?;
    let lines: Vec<&str> = text.lines().collect();

    let mut messages = Vec::new();
    let last = lines.len().saturating_sub(1);
    for (index, line) in lines.iter().enumerate() {
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(message) => messages.push(message),
            Err(_) if line.trim().is_empty() => {}
            // A torn final line is what a crash mid-write leaves. Its content
            // was never complete, and refusing the whole thread over it made a
            // conversation unreadable for one lost fragment (janhq/jan#8019).
            Err(e) if index == last && !terminated => {
                log::warn!(
                    "messages: ignoring an incomplete final line in {}: {}",
                    path.display(),
                    e
                );
            }
            // Anything else is damage the reader did not cause and must not
            // hide.
            Err(e) => {
                eprintln!(
                    "Error parsing JSON from line in file {}: {}",
                    path.display(),
                    e
                );
                return Err(e.to_string());
            }
        }
    }

    Ok(fold_revisions(messages).0)
}

/// What a tolerant read of `messages.jsonl` found.
#[derive(Debug, Default)]
pub struct LossyRead {
    pub messages: Vec<serde_json::Value>,
    /// Non-empty lines that did not parse, in file order. A torn final line
    /// (no newline) is not counted: a crash leaves that and it is dropped.
    pub bad_lines: Vec<String>,
    /// Revision lines folded into earlier messages (see [`fold_revisions`]).
    pub revisions: usize,
}

/// Like `read_messages_from_file`, but a line that does not parse at any
/// position is skipped and reported in `bad_lines` instead of failing the
/// whole thread.
pub fn read_messages_lossy(data_folder: &Path, thread_id: &str) -> Result<LossyRead, String> {
    let path = get_messages_path(data_folder, thread_id);
    let bytes = read_if_present(&path)?;
    let terminated = bytes.is_empty() || bytes.ends_with(NEWLINE_BYTES);
    let lines: Vec<&[u8]> = bytes.split(|b| *b == NEWLINE).collect();
    // `split` yields an empty piece after a final newline.
    let count = if terminated { lines.len().saturating_sub(1) } else { lines.len() };
    let mut out = LossyRead::default();
    for (index, line) in lines.iter().take(count).enumerate() {
        let trimmed = line.strip_suffix(b"\r").unwrap_or(line);
        if trimmed.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<serde_json::Value>(trimmed) {
            Ok(message) => out.messages.push(message),
            Err(_) if index + 1 == count && !terminated => {}
            Err(_) => out.bad_lines.push(String::from_utf8_lossy(trimmed).into_owned()),
        }
    }
    let (messages, revisions) = fold_revisions(std::mem::take(&mut out.messages));
    out.messages = messages;
    out.revisions = revisions;
    if !out.bad_lines.is_empty() {
        log::warn!(
            "messages: skipped {} unreadable line(s) in {}",
            out.bad_lines.len(),
            path.display()
        );
    }
    Ok(out)
}

/// Keep lines a rewrite is about to drop in `messages.jsonl.corrupt` beside
/// it, each line once.
pub fn preserve_bad_lines(data_folder: &Path, thread_id: &str, bad: &[String]) -> Result<(), String> {
    if bad.is_empty() {
        return Ok(());
    }
    let mut path = get_messages_path(data_folder, thread_id).into_os_string();
    path.push(".corrupt");
    let path = std::path::PathBuf::from(path);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let known: std::collections::HashSet<&str> = existing.lines().collect();
    let fresh: Vec<&String> = bad.iter().filter(|l| !known.contains(l.as_str())).collect();
    if fresh.is_empty() {
        return Ok(());
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    for line in fresh {
        writeln!(file, "{line}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Update thread metadata by writing to thread.json
pub fn update_thread_metadata(
    data_folder: &Path,
    thread_id: &str,
    thread: &serde_json::Value,
) -> Result<(), String> {
    let path = get_thread_metadata_path(data_folder, thread_id);
    let data = serde_json::to_string_pretty(thread).map_err(|e| e.to_string())?;
    write_file_atomically(&path, data.as_bytes())
}
