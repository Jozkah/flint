//! Persistent memory for a subagent definition (`memory: user | project`).
//!
//! One directory per agent under the permanent store, a sibling of `memory/`
//! and `threads/`:
//!
//!   `<jan_data>/agent-workspace/agent-memory/<agent>/user/MEMORY.md`
//!   `<jan_data>/agent-workspace/agent-memory/<agent>/project-<id>/MEMORY.md`
//!
//! Never inside an attached project folder: that is mounted read-only and
//! untrusted, so a cloned repository must not be able to plant memory an agent
//! then trusts. `project` scope keys the directory by the project's identity
//! (read-only derivation, nothing is written into the folder).
//!
//! Only this module's two functions touch the directory, and only `MEMORY.md`
//! in it: the agent gets no general file access to it.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_agent_tools::memory::identity;
use tauri_plugin_agent_tools::workspace;

/// Most lines of `MEMORY.md` loaded at an agent's start.
pub const MAX_LOADED_LINES: usize = 200;
/// Most bytes loaded at start; also the most a write may store.
pub const MAX_BYTES: usize = 25 * 1024;

const FILE: &str = "MEMORY.md";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoadedMemory {
    /// The first [`MAX_LOADED_LINES`] lines / [`MAX_BYTES`] bytes of `MEMORY.md`.
    pub content: String,
    /// More existed than was loaded.
    pub truncated: bool,
    /// Where it lives, for the agent to be told and the user to open.
    pub dir: String,
}

/// The agent's memory directory for `scope`, validated.
pub fn memory_dir(
    jan_data_folder: &Path,
    agent: &str,
    scope: &str,
    project_root: Option<&Path>,
) -> Result<PathBuf, String> {
    // The same single-plain-name rule memory notes use, so an agent name cannot
    // climb out of the directory.
    let file = workspace::workspace_filename(agent)
        .map_err(|_| format!("invalid agent name '{agent}'"))?;
    let name = file.trim_end_matches(".md");
    let leaf = match scope {
        "user" => "user".to_string(),
        "project" => {
            let root = project_root.ok_or("project memory needs a project folder")?;
            let id: String = identity::project_id_read_only(root)
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if id.is_empty() {
                return Err("this project has no usable identity".to_string());
            }
            format!("project-{id}")
        }
        other => {
            return Err(format!(
                "memory scope must be 'user' or 'project', not '{other}'"
            ))
        }
    };
    Ok(workspace::permanent_store(jan_data_folder)
        .join("agent-memory")
        .join(name)
        .join(leaf))
}

/// Cut `text` to the line and byte caps, on a line boundary.
pub fn cap_loaded(text: &str) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = false;
    for (i, line) in text.split_inclusive('\n').enumerate() {
        if i >= MAX_LOADED_LINES || out.len() + line.len() > MAX_BYTES {
            truncated = true;
            break;
        }
        out.push_str(line);
    }
    (out, truncated)
}

/// What an agent starts with. A missing file is empty memory, not an error.
pub fn load(dir: &Path) -> LoadedMemory {
    let text = std::fs::read_to_string(dir.join(FILE)).unwrap_or_default();
    let (content, truncated) = cap_loaded(&text);
    LoadedMemory {
        content,
        truncated,
        dir: dir.to_string_lossy().to_string(),
    }
}

/// Replace `MEMORY.md`. Refuses over [`MAX_BYTES`] rather than cutting, so the
/// agent keeps the file within what the next start will load.
pub fn write(dir: &Path, content: &str) -> Result<usize, String> {
    if content.len() > MAX_BYTES {
        return Err(format!(
            "memory is {} bytes; keep MEMORY.md under {MAX_BYTES} bytes ({MAX_LOADED_LINES} lines are loaded at start), summarise and retry",
            content.len()
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    workspace::write_atomic(&dir.join(FILE), content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(content.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flint-agentmem-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn user_dir_is_under_the_permanent_store_never_a_project() {
        let data = root("user");
        let dir = memory_dir(&data, "reviewer", "user", None).unwrap();
        assert_eq!(
            dir,
            workspace::permanent_store(&data)
                .join("agent-memory")
                .join("reviewer")
                .join("user")
        );
        assert!(memory_dir(&data, "reviewer", "project", None).is_err());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn project_dir_is_keyed_by_identity_and_stays_in_the_data_folder() {
        let data = root("proj-data");
        let project = root("proj-folder");
        let dir = memory_dir(&data, "reviewer", "project", Some(&project)).unwrap();
        assert!(dir.starts_with(workspace::permanent_store(&data).join("agent-memory")));
        assert!(!dir.starts_with(&project));
        // Resolving the directory wrote nothing into the project folder.
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn hostile_names_and_scopes_are_refused() {
        let data = root("names");
        for bad in ["../x", "a/b", "a\\b", "C:x", "..", ""] {
            assert!(memory_dir(&data, bad, "user", None).is_err(), "{bad}");
        }
        assert!(memory_dir(&data, "a", "global", None).is_err());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn load_caps_lines_and_bytes_and_a_missing_file_is_empty() {
        let data = root("load");
        let dir = memory_dir(&data, "a", "user", None).unwrap();
        assert_eq!(load(&dir).content, "");
        let many: String = (0..300).map(|i| format!("line {i}\n")).collect();
        write(&dir, &many).unwrap();
        let got = load(&dir);
        assert!(got.truncated);
        assert_eq!(got.content.lines().count(), MAX_LOADED_LINES);
        let (cut, t) = cap_loaded(&format!("{}\nmore\n", "x".repeat(MAX_BYTES - 10)));
        assert!(!t && cut.len() <= MAX_BYTES);
        let (cut, t) = cap_loaded(&format!("{}\nmore\n", "x".repeat(MAX_BYTES)));
        assert!(t && cut.is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn write_replaces_and_refuses_over_the_cap() {
        let data = root("write");
        let dir = memory_dir(&data, "a", "user", None).unwrap();
        write(&dir, "first").unwrap();
        write(&dir, "second").unwrap();
        assert_eq!(load(&dir).content, "second");
        let err = write(&dir, &"y".repeat(MAX_BYTES + 1)).unwrap_err();
        assert!(err.contains("under"), "{err}");
        assert_eq!(load(&dir).content, "second");
        let _ = std::fs::remove_dir_all(&data);
    }
}
