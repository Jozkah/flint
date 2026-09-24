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
pub static MESSAGE_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

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
    let locks = MESSAGE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().await;
    locks.retain(|id, lock| id == thread_id || Arc::strong_count(lock) > 1);
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
    let mut contents = Vec::new();
    for msg in messages {
        let data = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        writeln!(contents, "{data}").map_err(|e| e.to_string())?;
    }
    write_file_atomically(path, &contents)
}

/// Replace `path` with `contents` so that a reader, or the next launch after a
/// crash, sees either the old file or the new one and never a torn mixture:
/// write a staging file beside it, flush it to disk, rename it over.
///
/// Used for every thread file. `thread.json` had the same truncate-then-write
/// shape as `messages.jsonl`, and a torn one is skipped by `list_threads` --
/// the conversation simply vanishes from the sidebar.
pub fn write_file_atomically(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut staging_name = path
        .file_name()
        .ok_or_else(|| format!("not a file path: {}", path.display()))?
        .to_os_string();
    staging_name.push(".tmp");
    let staging = path.with_file_name(staging_name);
    let result = (|| {
        let mut file = File::create(&staging).map_err(|e| e.to_string())?;
        file.write_all(contents).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&staging, path).map_err(|e| e.to_string())
    })();
    if result.is_err() && staging.is_file() {
        let _ = fs::remove_file(&staging);
    }
    result
}

/// Append one message as a line of a thread's messages.jsonl file.
///
/// An append interrupted mid-line leaves a tail with no newline. Appending
/// straight after it would glue the new message onto that fragment and lose
/// both, so the tail is settled first: a fragment that does not parse is what a
/// crash leaves and is cut off (its content was never complete), and a tail
/// that parses but only lacked its newline gets one.
pub fn append_message_line(path: &Path, message: &serde_json::Value) -> Result<(), String> {
    settle_unterminated_tail(path)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let data = serde_json::to_string(message).map_err(|e| e.to_string())?;
    writeln!(file, "{data}").map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())
}

fn settle_unterminated_tail(path: &Path) -> Result<(), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if bytes.is_empty() || bytes.ends_with(NEWLINE_BYTES) {
        return Ok(());
    }
    let tail_start = bytes
        .iter()
        .rposition(|b| *b == NEWLINE)
        .map_or(0, |i| i + 1);
    let tail = &bytes[tail_start..];
    let complete = serde_json::from_slice::<serde_json::Value>(tail).is_ok();
    let file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    if complete {
        drop(file);
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(NEWLINE_BYTES).map_err(|e| e.to_string())?;
    } else {
        log::warn!(
            "messages: dropping an incomplete final line ({} bytes) in {}",
            tail.len(),
            path.display()
        );
        file.set_len(tail_start as u64).map_err(|e| e.to_string())?;
    }
    Ok(())
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

    let file = File::open(&path).map_err(|e| {
        eprintln!("Error opening file {}: {}", path.display(), e);
        e.to_string()
    })?;
    let reader = BufReader::new(file);
    let lines = reader.lines().collect::<Result<Vec<_>, _>>().map_err(|e| {
        eprintln!("Error reading line from file {}: {}", path.display(), e);
        e.to_string()
    })?;
    // Whether the last line was terminated. An interrupted append leaves an
    // unterminated fragment, and that one shape is tolerated below.
    let terminated = fs::read(&path)
        .map(|b| b.is_empty() || b.ends_with(NEWLINE_BYTES))
        .unwrap_or(true);

    let mut messages = Vec::new();
    let last = lines.len().saturating_sub(1);
    for (index, line) in lines.iter().enumerate() {
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(message) => messages.push(message),
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

    Ok(messages)
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
