use super::*;

/// In-flight permission prompts keyed by `request_id`, shared between the loop
/// (which inserts a one-shot sender before awaiting) and the respond command
/// (which removes and resolves it).
pub(crate) type PermissionRegistry =
    Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<PermissionDecision>>>>;

pub(super) static PERMISSION_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub(super) fn next_permission_id() -> String {
    format!(
        "perm-{}",
        PERMISSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// What an approval is about: the sha256 (hex) of the tool name and its
/// arguments as canonical JSON. Taken when the prompt is raised, after every
/// rewrite that happens before it (path repair, git attribution), and again
/// just before the approved call runs.
pub(crate) fn approval_digest(tool: &str, args: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    let text = canonical_json(&serde_json::json!({ "tool": tool, "args": args }));
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The digest each open prompt was raised with, keyed by `request_id`. Kept
/// next to the pending sender for as long as the prompt is open, and taken
/// (removed) when its answer arrives, so a digest never outlives its prompt.
pub(super) static APPROVAL_DIGESTS: std::sync::Mutex<Option<HashMap<String, String>>> = std::sync::Mutex::new(None);

pub(super) fn record_approval_digest(request_id: &str, digest: &str) {
    APPROVAL_DIGESTS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(request_id.to_string(), digest.to_string());
}

pub(super) fn take_approval_digest(request_id: &str) -> Option<String> {
    APPROVAL_DIGESTS
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|table| table.remove(request_id))
}

/// `Some(refusal)` when the arguments about to run are not the ones the
/// approval was given for. A missing digest refuses too: an approval that
/// cannot say what it approved approves nothing.
pub(super) fn approved_args_refusal(approved: Option<&str>, tool: &str, args: &serde_json::Value) -> Option<String> {
    match approved {
        Some(digest) if digest == approval_digest(tool, args) => None,
        _ => Some(format!(
            "ERROR: tool {tool} was not run: its arguments changed after you approved them"
        )),
    }
}

#[cfg(test)]
mod approval_digest_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_digest_is_stable_and_ignores_key_order() {
        let a = json!({"path": "a.txt", "content": "x", "opts": {"b": 1, "a": [1, {"z": 0, "y": 1}]}});
        let b = json!({"opts": {"a": [1, {"y": 1, "z": 0}], "b": 1}, "content": "x", "path": "a.txt"});
        assert_eq!(approval_digest("write", &a), approval_digest("write", &a));
        assert_eq!(approval_digest("write", &a), approval_digest("write", &b));
        assert_eq!(approval_digest("write", &a).len(), 64);
        assert!(approval_digest("write", &a).chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_digest_covers_the_tool_and_every_argument() {
        let args = json!({"path": "a.txt", "content": "x"});
        assert_ne!(approval_digest("write", &args), approval_digest("edit", &args));
        assert_ne!(
            approval_digest("write", &args),
            approval_digest("write", &json!({"path": "a.txt", "content": "y"}))
        );
        // Array order is meaning, not formatting.
        assert_ne!(
            approval_digest("bash", &json!({"a": [1, 2]})),
            approval_digest("bash", &json!({"a": [2, 1]}))
        );
    }

    #[test]
    fn changed_arguments_are_refused_and_the_same_ones_run() {
        let shown = json!({"command": "ls"});
        let digest = approval_digest("bash", &shown);
        assert_eq!(approved_args_refusal(Some(&digest), "bash", &shown), None);
        assert_eq!(
            approved_args_refusal(Some(&digest), "bash", &json!({"command": "rm -rf ."})),
            Some("ERROR: tool bash was not run: its arguments changed after you approved them".to_string())
        );
        assert!(approved_args_refusal(None, "bash", &shown).is_some(), "no digest approves nothing");
    }

    #[test]
    fn a_digest_is_taken_once_and_never_reaches_another_prompt() {
        let first = next_permission_id();
        let second = next_permission_id();
        record_approval_digest(&first, "d1");
        assert_eq!(take_approval_digest(&first).as_deref(), Some("d1"));
        assert_eq!(take_approval_digest(&first), None, "spent by its own answer");
        record_approval_digest(&second, "d2");
        assert_eq!(take_approval_digest(&first), None);
        assert_eq!(take_approval_digest(&second).as_deref(), Some("d2"));
    }
}

/// Why the user refused a prompt, keyed by `request_id`. The respond path
/// records it just before it sends `Deny`; the loop takes it when it builds the
/// tool result, so the model learns what to do differently instead of seeing a
/// bare refusal. A request id is unique for the life of the process, so one
/// table serves every run.
pub(super) static DENY_REASONS: std::sync::Mutex<Option<HashMap<String, String>>> = std::sync::Mutex::new(None);

/// Longest reason handed to the model; the rest is dropped.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(super) const DENY_REASON_MAX_CHARS: usize = 500;

/// Remember `reason` for the denied prompt `request_id`. Blank text is ignored,
/// control characters are replaced by spaces and the length is capped.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn record_deny_reason(request_id: &str, reason: &str) {
    let cleaned: String = reason
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let cleaned: String = cleaned.trim().chars().take(DENY_REASON_MAX_CHARS).collect();
    if cleaned.is_empty() {
        return;
    }
    let mut table = DENY_REASONS.lock().unwrap();
    table
        .get_or_insert_with(HashMap::new)
        .insert(request_id.to_string(), cleaned);
}

/// What the secret-write prompt says: where, which rule, the masked match.
pub(crate) fn secret_prompt_text(
    findings: &[tauri_plugin_agent_tools::secrets::SecretFinding],
) -> String {
    let what = findings
        .iter()
        .map(tauri_plugin_agent_tools::tools::handlers::describe_secret_finding)
        .collect::<Vec<_>>()
        .join("; ");
    format!("This write looks like it contains a secret: {what}. \"Write anyway\" writes it this one time.")
}

/// The model's result when a flagged write could not be put to anyone.
pub(crate) fn secret_unattended_msg(
    name: &str,
    findings: &[tauri_plugin_agent_tools::secrets::SecretFinding],
) -> String {
    let what = findings
        .iter()
        .map(tauri_plugin_agent_tools::tools::handlers::describe_secret_finding)
        .collect::<Vec<_>>()
        .join("; ");
    format!(
        "ERROR: tool '{name}' was not run: it adds what looks like a secret ({what}). Only a person can \
         allow that, and nobody is here to ask, so nothing was written. If the value is real, use a \
         placeholder and read it from the environment. If it is not (a fixture, an example), say which \
         line it is and why in your answer. To allow a write like this in a run nobody watches, start it \
         with permission mode bypass (`--mode bypass`). Do not reword the code to get past this check."
    )
}

/// The model's result when the person said no to a flagged write: it says they
/// were asked, so it is not mistaken for a harness refusal.
pub(crate) fn secret_denied_message(
    name: &str,
    request_id: &str,
    findings: &[tauri_plugin_agent_tools::secrets::SecretFinding],
) -> String {
    let what = findings
        .iter()
        .map(tauri_plugin_agent_tools::tools::handlers::describe_secret_finding)
        .collect::<Vec<_>>()
        .join("; ");
    let base = denied_by_user_message(name, request_id);
    format!(
        "{base}. The user was asked whether to write a line that looks like a secret ({what}) and \
         denied it. Nothing was written. Do not retry the same content: use a placeholder and read \
         the real value from the environment, or ask the user what they want instead."
    )
}

/// Remove and return the reason recorded for `request_id`, if any. Every
/// prompt calls this when it settles, so the table never outlives a prompt.
pub(super) fn take_deny_reason(request_id: &str) -> Option<String> {
    DENY_REASONS
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|table| table.remove(request_id))
}

/// ` Their reason: ...` for appending to a refusal, empty when none was given.
/// Consumes the recorded reason.
pub(super) fn deny_suffix(request_id: &str) -> String {
    take_deny_reason(request_id)
        .map(|reason| format!(" Their reason: {reason}"))
        .unwrap_or_default()
}

/// The tool result for a prompt the user refused, with their reason when they
/// gave one. Consumes the recorded reason.
pub(super) fn denied_by_user_message(name: &str, request_id: &str) -> String {
    match take_deny_reason(request_id) {
        Some(reason) => format!("ERROR: tool '{name}' denied by user. Their reason: {reason}"),
        None => format!("ERROR: tool '{name}' denied by user"),
    }
}

#[cfg(test)]
mod deny_reason_tests {
    use super::*;

    #[test]
    fn a_recorded_reason_reaches_the_tool_result_once() {
        record_deny_reason("perm-test-1", "use the staging bucket instead");
        assert_eq!(
            denied_by_user_message("bash", "perm-test-1"),
            "ERROR: tool 'bash' denied by user. Their reason: use the staging bucket instead"
        );
        assert_eq!(
            denied_by_user_message("bash", "perm-test-1"),
            "ERROR: tool 'bash' denied by user"
        );
    }

    #[test]
    fn blank_reasons_are_ignored_and_long_ones_capped() {
        record_deny_reason("perm-test-2", "  \n\t ");
        assert_eq!(denied_by_user_message("write", "perm-test-2"), "ERROR: tool 'write' denied by user");
        record_deny_reason("perm-test-3", &format!("a\nb{}", "x".repeat(900)));
        let msg = denied_by_user_message("write", "perm-test-3");
        let reason = msg.split("Their reason: ").nth(1).unwrap();
        assert_eq!(reason.chars().count(), DENY_REASON_MAX_CHARS);
        assert!(reason.starts_with("a b"), "control characters become spaces: {reason}");
    }
}
