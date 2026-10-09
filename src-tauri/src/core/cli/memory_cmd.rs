//! `flint cli memory ...`: the Memory settings page from the terminal. List,
//! read, pin, forget and export what Flint remembers, by scope (project, user,
//! chat).
//!
//! Every call goes through the same service the desktop page uses, so the
//! same containment rules apply: a scope the place has no standing in is
//! refused, a chat memory is visible only to its own chat, and forgetting also
//! takes the text out of saved requests.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_agent_tools::memory::create;
use tauri_plugin_agent_tools::memory::identity;
use tauri_plugin_agent_tools::memory::record::{MemoryId, MemoryRecord, Scope};
use tauri_plugin_agent_tools::memory::service::{self, Access};
use tauri_plugin_agent_tools::workspace;

fn parse_scope(raw: &str) -> Result<Scope, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "chat" | "session" => Ok(Scope::Session),
        "project" => Ok(Scope::Project),
        "user" | "global" => Ok(Scope::User),
        other => Err(format!("unknown memory scope '{other}' (project, user, chat)")),
    }
}

/// Where the caller stands: the data folder's permanent store, the project's
/// own store when the folder is usable, and the chat when one is named.
fn access(project: &str, session: Option<&str>) -> (Access, PathBuf) {
    let data = crate::core::app::commands::resolve_jan_data_folder();
    let permanent = workspace::permanent_store(&data);
    let root = Path::new(project).canonicalize().ok().filter(|r| r.is_dir() && r.parent().is_some());
    // A project folder overlapping the data folder would write memory into it.
    let (project_id, project_store, refused) = match root {
        Some(r) if !(r.starts_with(&data) || data.starts_with(&r)) => (
            Some(identity::project_id_read_only(&r)),
            Some(workspace::project_store(&r)),
            None,
        ),
        Some(_) => (None, None, Some("the project folder overlaps the Flint data folder".to_string())),
        None => (None, None, Some("the project folder cannot be used for memory".to_string())),
    };
    (
        Access {
            session_id: session.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
            project_id,
            project_store,
            permanent_store: Some(permanent),
            project_refused: refused,
        },
        data,
    )
}

fn store_for(a: &Access, scope: Scope) -> Result<PathBuf, String> {
    match scope {
        Scope::Project => a.project_store.clone(),
        _ => a.permanent_store.clone(),
    }
    .ok_or_else(|| "no store for that scope here".to_string())
}

/// Whether a record is within what this caller may see; the same rule the
/// service applies.
fn may_see(a: &Access, r: &MemoryRecord) -> bool {
    match r.scope {
        Scope::User => true,
        Scope::Project => matches!((&r.project_id, &a.project_id), (Some(m), Some(t)) if m == t),
        Scope::Session => matches!((&r.session_id, &a.session_id), (Some(m), Some(t)) if m == t),
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn print<T: Serialize>(value: &T) -> Result<(), String> {
    println!("{}", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?);
    Ok(())
}

fn require_scope_standing(a: &Access, scope: Scope) -> Result<(), String> {
    match scope {
        Scope::Project if a.project_id.is_none() => {
            Err(a.project_refused.clone().unwrap_or_else(|| "no project is open".to_string()))
        }
        Scope::Session if a.session_id.is_none() => Err("name the chat with --session".to_string()),
        _ => Ok(()),
    }
}

/// `memory list <scope> [--query Q] [--limit N] [--offset N]`
pub fn list(project: &str, session: Option<&str>, scope: &str, query: Option<&str>, offset: usize, limit: usize) -> Result<(), String> {
    let scope = parse_scope(scope)?;
    let (a, _) = access(project, session);
    print(&service::list(&a, scope, query, offset, limit).map_err(|d| d.message())?)
}

/// `memory show <scope> <id>`
pub fn show(project: &str, session: Option<&str>, scope: &str, id: &str) -> Result<(), String> {
    let scope = parse_scope(scope)?;
    let (a, _) = access(project, session);
    print(&service::get(&a, scope, &MemoryId::new(id.to_string())).map_err(|d| d.message())?)
}

/// `memory forget <scope> <id>`: the text leaves the store and saved requests;
/// a tombstone stays.
pub fn forget(project: &str, session: Option<&str>, scope: &str, id: &str) -> Result<(), String> {
    let scope = parse_scope(scope)?;
    let (a, data) = access(project, session);
    let mid = MemoryId::new(id.to_string());
    // Read first, so forgetting something out of scope is refused rather than
    // silently doing nothing.
    service::get(&a, scope, &mid).map_err(|d| d.message())?;
    let forgotten = create::forget_text(&store_for(&a, scope)?, scope, &mid, now())?;
    if let Some(text) = forgotten.as_deref().filter(|t| !t.trim().is_empty()) {
        tauri_plugin_agent_tools::snapshot::redact_text_reporting(&data, &[text], "forgotten memory");
    }
    println!("{}", if forgotten.is_some() { "Forgotten." } else { "There was nothing to forget." });
    Ok(())
}

/// `memory clear <scope> --yes`: forget everything this place may see in one scope.
pub fn clear(project: &str, session: Option<&str>, scope: &str, yes: bool) -> Result<(), String> {
    let scope = parse_scope(scope)?;
    let (a, data) = access(project, session);
    require_scope_standing(&a, scope)?;
    if !yes {
        return Err("this forgets every memory in that scope here; run again with --yes".to_string());
    }
    let forgotten = create::forget_all_text(&store_for(&a, scope)?, scope, |r| may_see(&a, r), now())?;
    for text in forgotten.iter().filter(|t| !t.trim().is_empty()) {
        tauri_plugin_agent_tools::snapshot::redact_text_reporting(&data, &[text.as_str()], "forgotten memory");
    }
    println!("Forgot {} memor{}.", forgotten.len(), if forgotten.len() == 1 { "y" } else { "ies" });
    Ok(())
}

/// `memory pin|unpin <scope> <id>`
pub fn pin(project: &str, session: Option<&str>, scope: &str, id: &str, pinned: bool) -> Result<(), String> {
    let scope = parse_scope(scope)?;
    let (a, _) = access(project, session);
    print(&service::set_pinned(&a, scope, &MemoryId::new(id.to_string()), pinned, now()).map_err(|d| d.message())?)
}

/// `memory export <scope> <path>`: every memory this place may see in the
/// scope, as JSON.
pub fn export(project: &str, session: Option<&str>, scope: &str, path: &str) -> Result<(), String> {
    let scope = parse_scope(scope)?;
    let (a, _) = access(project, session);
    require_scope_standing(&a, scope)?;
    let mut items = Vec::new();
    let mut offset = 0;
    loop {
        let page = service::list(&a, scope, None, offset, 200).map_err(|d| d.message())?;
        let got = page.items.len();
        items.extend(page.items);
        offset += got;
        if got == 0 || offset >= page.total {
            break;
        }
    }
    let body = serde_json::to_string_pretty(&serde_json::json!({ "scope": format!("{scope:?}").to_lowercase(), "memories": items }))
        .map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| format!("write {path}: {e}"))?;
    println!("Wrote {} memor{} to {path}.", items.len(), if items.len() == 1 { "y" } else { "ies" });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_parse_and_scopes_without_standing_are_refused() {
        assert_eq!(parse_scope("Chat").unwrap(), Scope::Session);
        assert_eq!(parse_scope("global").unwrap(), Scope::User);
        assert!(parse_scope("galaxy").unwrap_err().contains("unknown memory scope"));

        crate::core::app::commands::with_temp_data_folder(|_| {
            let project = tempfile::tempdir().unwrap();
            let p = project.path().to_string_lossy().to_string();
            // A chat scope needs a chat.
            assert!(clear(&p, None, "chat", true).unwrap_err().contains("--session"));
            // Clearing needs --yes.
            assert!(clear(&p, None, "user", false).unwrap_err().contains("--yes"));
            // Nothing to show for an unknown id.
            assert!(show(&p, None, "user", "nope").is_err());
        });
    }

    #[test]
    fn export_writes_the_scope_to_a_file() {
        crate::core::app::commands::with_temp_data_folder(|data| {
            let project = tempfile::tempdir().unwrap();
            let p = project.path().to_string_lossy().to_string();
            let out = data.join("mem.json");
            export(&p, None, "user", &out.to_string_lossy()).unwrap();
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(out).unwrap()).unwrap();
            assert_eq!(v["scope"], "user");
            assert!(v["memories"].as_array().unwrap().is_empty());
        });
    }
}
