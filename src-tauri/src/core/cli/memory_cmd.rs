//! `flint cli memory ...`: the Memory settings page from the terminal. List,
//! read, pin, forget and export what Flint remembers, by scope (project, user,
//! chat).
//!
//! The agent's `memory_write` notes (`.jan/agent/memory/*.md`, or the user
//! store's `memory/` folder) are a separate store: whole notes the agent reads
//! and rewrites itself, not the scoped records listed here. `memory notes`,
//! `note-show` and `note-forget` manage them.
//!
//! Every call goes through the same service the desktop page uses, so the
//! same containment rules apply: a scope the place has no standing in is
//! refused, a chat memory is visible only to its own chat, and forgetting also
//! takes the text out of saved requests.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_agent_tools::memory::audit as audit_mod;
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
        Some(r) if !super::pathnorm::overlaps(&r, &data) => (
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

/// `memory audit [--json] [--stale-days N]`: a read-only report over the user
/// and chat stores and, when the project folder is usable, the project store.
/// Advice, not a gate: it prints and returns Ok whatever it finds.
pub fn audit(project: &str, json: bool, stale_days: u32) -> Result<(), String> {
    let (a, _) = access(project, None);
    let mut records: Vec<MemoryRecord> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for scope in [Scope::User, Scope::Session, Scope::Project] {
        match store_for(&a, scope) {
            Ok(root) => {
                let loaded = tauri_plugin_agent_tools::memory::store::load(&root, scope);
                if let Some(issue) = loaded.issue(scope) {
                    notes.push(issue);
                }
                records.extend(loaded.records);
            }
            Err(_) => notes.push(format!(
                "{scope:?} scope skipped: {}",
                a.project_refused.clone().unwrap_or_else(|| "no store here".to_string())
            )),
        }
    }
    let report = audit_mod::audit(&records, now(), stale_days);
    if json {
        print(&serde_json::json!({ "report": report, "notes": notes }))?;
    } else {
        print!("{}", audit_mod::render(&report));
        for n in &notes {
            println!("note: {n}");
        }
    }
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

/// The note store `memory_write` writes to: the project's own store, or the
/// user's (data folder) store with `user`.
fn notes_store(project: &str, user: bool) -> Result<PathBuf, String> {
    let (a, _) = access(project, None);
    if user {
        return a.permanent_store.ok_or_else(|| "no user store here".to_string());
    }
    a.project_store
        .ok_or_else(|| a.project_refused.unwrap_or_else(|| "no project is open".to_string()))
}

/// Note names in a store, sorted. Only names read from the folder are ever
/// opened, so a name given on the command line cannot reach outside it.
fn note_names(store: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(tauri_plugin_agent_tools::memory::memory_dir(store))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
        .collect();
    names.sort();
    names
}

fn note_path(store: &Path, name: &str) -> Result<PathBuf, String> {
    let name = name.trim().trim_end_matches(".md");
    if !note_names(store).iter().any(|n| n == name) {
        return Err(format!("no memory note named '{name}' (see `memory notes`)"));
    }
    Ok(tauri_plugin_agent_tools::memory::memory_dir(store).join(format!("{name}.md")))
}

/// `memory notes [--user]`: the notes the agent saved with `memory_write`.
pub fn notes(project: &str, user: bool) -> Result<(), String> {
    let store = notes_store(project, user)?;
    let names = note_names(&store);
    print(&serde_json::json!({
        "store": if user { "user" } else { "project" },
        "folder": tauri_plugin_agent_tools::memory::memory_dir(&store),
        "total": names.len(),
        "notes": names,
    }))
}

/// `memory note-show <name> [--user]`
pub fn note_show(project: &str, name: &str, user: bool) -> Result<(), String> {
    let path = note_path(&notes_store(project, user)?, name)?;
    print!("{}", std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?);
    Ok(())
}

/// `memory note-forget <name> [--user]`: delete the note, so no later run
/// recalls it.
pub fn note_forget(project: &str, name: &str, user: bool) -> Result<(), String> {
    let path = note_path(&notes_store(project, user)?, name)?;
    std::fs::remove_file(&path).map_err(|e| format!("delete {}: {e}", path.display()))?;
    println!("Forgot memory note '{}'.", name.trim().trim_end_matches(".md"));
    Ok(())
}

/// `memory proposals`: memories the agent proposed (`memory_propose`) that
/// wait for an answer, as the desktop's proposal cards show them.
pub fn proposals(project: &str, session: Option<&str>) -> Result<(), String> {
    use tauri_plugin_agent_tools::memory::{inferred, store};
    let (a, _) = access(project, session);
    let mut out = Vec::new();
    for (scope, root) in [
        (Scope::Session, a.permanent_store.clone()),
        (Scope::User, a.permanent_store.clone()),
        (Scope::Project, a.project_store.clone()),
    ] {
        let Some(root) = root else { continue };
        for record in store::load(&root, scope).records {
            let Some(reason) = inferred::pending_reason(&record) else { continue };
            if !record.applies_to(a.session_id.as_deref(), a.project_id.as_deref()) {
                continue;
            }
            out.push(serde_json::json!({
                "id": record.id.to_string(),
                "scope": format!("{scope:?}").to_lowercase().replace("session", "chat"),
                "content": record.content,
                "reason": reason.as_str(),
                "explanation": reason.explain(),
                "createdAt": record.created_at,
            }));
        }
    }
    print(&out)
}

/// `memory accept|reject <scope> <id>`: answer a proposal the way its card
/// does -- accepting re-checks the content first, rejecting removes it.
pub fn resolve_proposal(project: &str, session: Option<&str>, scope: &str, id: &str, approve: bool) -> Result<(), String> {
    let scope = parse_scope(scope)?;
    let (a, _) = access(project, session);
    match service::resolve_proposal(&a, scope, &MemoryId::new(id.to_string()), approve, now())? {
        Some(memory) => print(&memory),
        None => {
            println!("Rejected proposal {id}.");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Notes `memory_write` saved are listed, shown and forgotten; a name
    /// that is not a note in the folder is refused rather than opened.
    #[test]
    fn agent_memory_notes_are_listed_shown_and_forgotten() {
        crate::core::app::commands::with_temp_data_folder(|_| {
            let project = tempfile::tempdir().unwrap();
            let p = project.path().to_string_lossy().to_string();
            let store = notes_store(&p, false).unwrap();
            let dir = tauri_plugin_agent_tools::memory::memory_dir(&store);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("prefs.md"), "likes tabs").unwrap();
            assert_eq!(note_names(&store), vec!["prefs".to_string()]);
            notes(&p, false).unwrap();
            note_show(&p, "prefs", false).unwrap();
            assert!(note_show(&p, "../../secret", false).is_err());
            note_forget(&p, "prefs.md", false).unwrap();
            assert!(note_names(&store).is_empty());
            assert!(note_forget(&p, "prefs", false).is_err());
        });
    }

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

    #[test]
    fn audit_reads_the_stores_and_never_fails() {
        crate::core::app::commands::with_temp_data_folder(|_| {
            let project = tempfile::tempdir().unwrap();
            let p = project.path().to_string_lossy().to_string();
            audit(&p, false, 90).unwrap();
            audit(&p, true, 30).unwrap();
            // A folder that cannot be a project is a note, not an error.
            audit("Z:/definitely/not/here", true, 90).unwrap();
        });
    }
}
