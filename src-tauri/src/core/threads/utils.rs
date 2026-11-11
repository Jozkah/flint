use std::fs;
use std::path::{Path, PathBuf};

use super::constants::{MESSAGES_FILE, THREADS_DIR, THREADS_FILE};

pub fn get_data_dir(data_folder: &Path) -> PathBuf {
    data_folder.join(THREADS_DIR)
}

/// Refuse a thread id that is not one plain path component.
///
/// Every thread and message command joins the caller's id onto the threads
/// directory, and `delete_thread` then removes what it names recursively. An
/// id is only ever a name `create_thread` (or the CLI) chose, so anything that
/// could step out of that directory -- `..`, a separator, a drive or an
/// absolute path -- is refused before the filesystem is touched
/// (Jozkah/jan#35). Names Windows rewrites (`...`, a trailing dot or space,
/// device names) are refused too: `threads\...` is `threads\` itself there.
pub fn validate_thread_id(thread_id: &str) -> Result<(), String> {
    use std::path::Component;
    let plain = crate::core::path_ids::validate_path_id("thread id", thread_id).is_ok()
        && !thread_id.contains(['/', '\\', ':', '\0'])
        && matches!(
            Path::new(thread_id).components().collect::<Vec<_>>().as_slice(),
            [Component::Normal(name)] if *name == std::ffi::OsStr::new(thread_id)
        );
    if plain {
        Ok(())
    } else {
        Err(format!("invalid thread id {thread_id:?}"))
    }
}

/// The title a new thread gets when none is given.
pub const DEFAULT_THREAD_TITLE: &str = "New Thread";

/// A title safe to store and list, by the rule the web app's `cleanTitle`
/// uses: bidi overrides and isolates, tag characters, the zero-width space and
/// BOM are removed and control characters become a space; the marks, joiners
/// and variation selectors real text needs are kept. `None` when nothing
/// visible is left (only spaces, marks, joiners or selectors).
pub fn clean_title(title: &str) -> Option<String> {
    let stripped = |c: char| {
        matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200B}' | '\u{FEFF}' | '\u{E0000}'..='\u{E007F}')
    };
    let mut out = String::with_capacity(title.len());
    let mut in_control = false;
    for c in title.chars() {
        if stripped(c) {
            continue;
        }
        if c.is_control() {
            if !in_control {
                out.push(' ');
            }
            in_control = true;
            continue;
        }
        in_control = false;
        out.push(c);
    }
    let blank = out
        .chars()
        .all(|c| c.is_whitespace() || matches!(c, '\u{200C}'..='\u{200F}' | '\u{061C}' | '\u{FE0E}' | '\u{FE0F}'));
    (!blank).then_some(out)
}

/// [`clean_title`] applied to a thread object's `title`, with the default
/// title when nothing visible is left. A thread without a string title is
/// left as it is.
pub fn clean_thread_title(thread: &mut serde_json::Value) {
    if let Some(title) = thread.get("title").and_then(serde_json::Value::as_str) {
        let clean = clean_title(title).unwrap_or_else(|| DEFAULT_THREAD_TITLE.to_string());
        thread["title"] = serde_json::Value::String(clean);
    }
}

#[cfg(test)]
mod clean_title_tests {
    use super::*;

    #[test]
    fn invisible_only_titles_fall_back_and_real_text_is_kept() {
        for t in ["\u{200B}\u{200B}", "\u{202E}\u{2066}", "\u{FEFF}", "\u{E0041}\u{E0042}", "\u{0007}\u{001B}", "\u{200D}\u{200C}", "\u{200E}\u{200F}", " \u{FE0F} "] {
            assert_eq!(clean_title(t), None, "{t:?}");
            let mut v = serde_json::json!({ "title": t });
            clean_thread_title(&mut v);
            assert_eq!(v["title"], DEFAULT_THREAD_TITLE);
        }
        assert_eq!(clean_title("a\u{202E}bc\u{200B}d").as_deref(), Some("abcd"));
        assert_eq!(clean_title("a\nb").as_deref(), Some("a b"));
        // Joiners, marks and selectors stay where real text has them.
        for t in ["\u{0645}\u{200C}\u{06CC}", "\u{1F468}\u{200D}\u{1F4BB}", "\u{2764}\u{FE0F}", "\u{05E9}\u{200F}x"] {
            assert_eq!(clean_title(t).as_deref(), Some(t));
        }
        let mut v = serde_json::json!({ "title": 5 });
        clean_thread_title(&mut v);
        assert_eq!(v["title"], 5);
    }
}

pub fn get_thread_dir(data_folder: &Path, thread_id: &str) -> PathBuf {
    get_data_dir(data_folder).join(thread_id)
}

pub fn get_thread_metadata_path(data_folder: &Path, thread_id: &str) -> PathBuf {
    get_thread_dir(data_folder, thread_id).join(THREADS_FILE)
}

pub fn get_messages_path(data_folder: &Path, thread_id: &str) -> PathBuf {
    get_thread_dir(data_folder, thread_id).join(MESSAGES_FILE)
}

pub fn ensure_data_dirs(data_folder: &Path) -> Result<(), String> {
    let data_dir = get_data_dir(data_folder);
    if !data_dir.exists() {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn ensure_thread_dir_exists(data_folder: &Path, thread_id: &str) -> Result<(), String> {
    ensure_data_dirs(data_folder)?;
    let thread_dir = get_thread_dir(data_folder, thread_id);
    if !thread_dir.exists() {
        fs::create_dir_all(&thread_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The agent scratch dir of `thread_id`, or `None` when the id is not a single
/// plain path component: a crafted id such as `x/../../dir` must never steer a
/// recursive delete outside the temp folder.
pub fn thread_scratch_dir(thread_id: &str) -> Option<std::path::PathBuf> {
    let mut parts = std::path::Path::new(thread_id).components();
    match (parts.next(), parts.next()) {
        (Some(std::path::Component::Normal(_)), None)
            if !thread_id.contains(['/', '\\']) =>
        {
            Some(tauri_plugin_agent_tools::workspace::scratch_dir(thread_id))
        }
        _ => None,
    }
}
