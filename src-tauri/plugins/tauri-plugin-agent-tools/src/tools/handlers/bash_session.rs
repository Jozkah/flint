//! Persistent shell sessions for `bash`: `{command, session: "name"}` runs the
//! command in a long-lived shell that keeps its working directory, exported
//! variables and shell functions between calls.
//!
//! A session is an interactive background job (see `jobs.rs`) running `sh`, so
//! it is spawned, confined, owned, listed and stopped exactly as any other job.
//! Each call writes the command followed by a line that prints a one-off
//! marker and `$?`, then reads the job's output until that marker appears.

use super::*;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

/// Sessions one conversation may hold open at once.
const MAX_SESSIONS_PER_OWNER: usize = 4;
const SESSION_SHELL: &str = "sh";

struct Session {
    job_id: String,
    /// Absolute output offset already handed to the model.
    offset: u64,
}

type Key = (Option<String>, String);

fn sessions() -> &'static Mutex<HashMap<Key, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<Key, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn held() -> std::sync::MutexGuard<'static, HashMap<Key, Session>> {
    sessions().lock().unwrap_or_else(|e| e.into_inner())
}

fn key(ctx: &ToolContext<'_>, name: &str) -> Key {
    (ctx.job_owner.map(str::to_string), name.to_string())
}

fn nonce() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{:x}{:x}", nanos, N.fetch_add(1, Ordering::SeqCst))
}

/// A name the model can type and that reads back unchanged in a message.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `bash` with a `session`: run `command` in it, or close it.
pub(super) async fn bash_session(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let name = arg_str(args, "session").unwrap_or("").trim();
    if !valid_name(name) {
        return "ERROR: \"session\" must be 1-32 letters, digits, '-' or '_'.".to_string();
    }
    if arg_str(args, "action") == Some("close") {
        return close_session(ctx, name);
    }
    let Some(command) = arg_str(args, "command").filter(|c| !c.trim().is_empty()) else {
        return "ERROR: a session needs a \"command\" to run (or {\"action\": \"close\"}).".to_string();
    };
    if arg_bool(args, "background") || arg_bool(args, "interactive") {
        return "ERROR: \"session\" runs in the foreground; it cannot be combined with \
                \"background\" or \"interactive\"."
            .to_string();
    }
    let (_, timeout_secs) = bash_timeout(args);
    let (job_id, note) = match live_session(ctx, name) {
        Some(id) => (id, String::new()),
        None => match start_session(args, ctx, name).await {
            Ok(started) => started,
            Err(text) => return text,
        },
    };
    let marker = format!("__FLINT_{}__", nonce());
    // The command runs as written; the marker line is separate so a command
    // that ends in a comment or a heredoc cannot swallow it.
    let script = format!("{command}\nprintf '\\n%s%s\\n' '{marker}' \"$?\"\n");
    let owner = ctx.job_owner;
    let from = held().get(&key(ctx, name)).map(|s| s.offset).unwrap_or(0);
    if let Err(text) = write_bash_job(&job_id, owner, &script, false).await {
        forget(ctx, name);
        return format!("{text}\nThe session's shell is gone; the next call starts a fresh one.");
    }
    let started = std::time::Instant::now();
    let limit = std::time::Duration::from_secs(timeout_secs.max(1));
    loop {
        let Some((raw, total)) = bash_job_raw_since(&job_id, owner, from) else {
            forget(ctx, name);
            return "ERROR: the session's shell is gone; the next call starts a fresh one.".to_string();
        };
        if let Some((output, code)) = split_at_marker(&raw, &marker) {
            if let Some(s) = held().get_mut(&key(ctx, name)) {
                s.offset = total;
            }
            return format_result(&note, &output, Some(code));
        }
        let exited = inspect_bash_job(&job_id, owner).is_none_or(|s| s.finished);
        if exited {
            forget(ctx, name);
            let out = format_result(&note, &raw, None);
            return format!(
                "{out}\nThe session's shell exited (the command ended it); the next call starts a \
                 fresh one."
            );
        }
        if started.elapsed() >= limit {
            // As for a foreground command (AH-020): a timeout stops the work.
            // The shell cannot be told apart from the command inside it, so
            // the whole session is stopped.
            let _ = kill_bash_job(&job_id, owner);
            forget(ctx, name);
            let partial = format_result(&note, &raw, None);
            return format!(
                "{partial}\nERROR: the command did not finish within {timeout_secs}s, so the \
                 session \"{name}\" was stopped (its directory and variables are lost). The next \
                 call starts a fresh shell."
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

fn format_result(note: &str, output: &str, code: Option<i32>) -> String {
    let body = tail_cap(&sanitize_control(output), BASH_MAX_LINES, BASH_MAX_BYTES);
    let body = crate::audit::redact(&body);
    let mut out = String::from(note);
    out.push_str(&body);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if let Some(code) = code {
        out.push_str(&format!("[exit {code}]"));
    }
    out
}

/// The text before the marker line and the exit status after it. Only a
/// marker followed by digits and a newline counts, so a command that prints
/// the marker's prefix does not end the call early.
pub(super) fn split_at_marker(raw: &str, marker: &str) -> Option<(String, i32)> {
    let mut search = 0;
    while let Some(rel) = raw[search..].find(marker) {
        let at = search + rel;
        let after = &raw[at + marker.len()..];
        if let Some(end) = after.find('\n') {
            if let Ok(code) = after[..end].trim().parse::<i32>() {
                let mut before = raw[..at].to_string();
                if before.ends_with('\n') {
                    before.pop();
                }
                return Some((before, code));
            }
        }
        search = at + marker.len();
    }
    None
}

fn live_session(ctx: &ToolContext<'_>, name: &str) -> Option<String> {
    let id = held().get(&key(ctx, name)).map(|s| s.job_id.clone())?;
    match inspect_bash_job(&id, ctx.job_owner) {
        Some(status) if !status.finished => Some(id),
        _ => {
            forget(ctx, name);
            None
        }
    }
}

fn forget(ctx: &ToolContext<'_>, name: &str) {
    held().remove(&key(ctx, name));
}

fn close_session(ctx: &ToolContext<'_>, name: &str) -> String {
    match held().remove(&key(ctx, name)) {
        None => format!("No session named \"{name}\"."),
        Some(s) => {
            let _ = kill_bash_job(&s.job_id, ctx.job_owner);
            format!("Closed session \"{name}\".")
        }
    }
}

async fn start_session(
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
    name: &str,
) -> Result<(String, String), String> {
    let open = held()
        .keys()
        .filter(|(owner, _)| owner.as_deref() == ctx.job_owner)
        .count();
    if open >= MAX_SESSIONS_PER_OWNER {
        return Err(format!(
            "ERROR: this conversation already has {MAX_SESSIONS_PER_OWNER} shell sessions open. \
             Close one with {{\"session\": \"NAME\", \"action\": \"close\"}} first."
        ));
    }
    let mut start = serde_json::json!({
        "command": SESSION_SHELL,
        "background": true,
        "interactive": true,
    });
    if let (Some(from), Some(to)) = (args.as_object(), start.as_object_mut()) {
        if let Some(v) = from.get("description") {
            to.insert("description".into(), v.clone());
        }
    }
    let started = Box::pin(bash(&start, ctx)).await;
    let Some(job_id) = started
        .split("job_id=")
        .nth(1)
        .and_then(|s| s.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_')).next())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    else {
        return Err(started);
    };
    // stderr joins stdout so the model sees them in the order they happened.
    if let Err(e) = write_bash_job(&job_id, ctx.job_owner, "exec 2>&1\n", false).await {
        let _ = kill_bash_job(&job_id, ctx.job_owner);
        return Err(e);
    }
    let offset = bash_job_raw_since(&job_id, ctx.job_owner, 0).map(|(_, t)| t).unwrap_or(0);
    held().insert(key(ctx, name), Session { job_id: job_id.clone(), offset });
    Ok((job_id, format!("(started shell session \"{name}\")\n")))
}
