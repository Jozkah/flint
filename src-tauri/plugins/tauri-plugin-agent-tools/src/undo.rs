//! Undo and redo of the file changes a turn produced. AH-202.
//!
//! Every file a `write` or `edit` changes is recorded against the turn (run)
//! that changed it: the exact bytes before and after, content-addressed. Undo
//! puts the "before" back; redo puts the "after" back. Three rules:
//!
//! * **Only what Jan wrote.** The journal holds nothing but changes the tools
//!   made. An edit the user made is never in it, so it is never reverted.
//! * **Clean or not at all.** Undo applies only if every file is still exactly
//!   what the turn left; redo only if every file is still exactly what undo
//!   left. Otherwise nothing is written and every conflicting path is named --
//!   whether the user edited it since or a later turn did.
//! * **Scope is checked at use, not only at record.** A path is only restored
//!   when it is still inside a root the session may write right now. A grant
//!   withdrawn since the turn ran withdraws the undo with it.
//!
//! The journal lives on disk per session, so the position survives restart.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// `None`: the turn created the file.
    pub before: Option<String>,
    /// `None`: the turn deleted the file.
    pub after: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnState {
    Applied,
    Undone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChanges {
    pub run: String,
    pub at: String,
    pub state: TurnState,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub v: u32,
    pub session: String,
    pub turns: Vec<TurnChanges>,
}

/// One path that stopped a clean undo or redo, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoConflict {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UndoError {
    NotFound,
    AlreadyUndone,
    NotUndone,
    OutOfScope(Vec<String>),
    Conflicts(Vec<UndoConflict>),
    Io(String),
}

impl UndoError {
    /// For the person. Always says whether anything was written.
    pub fn message(&self) -> String {
        match self {
            UndoError::NotFound => "that turn changed no files Jan can undo".into(),
            UndoError::AlreadyUndone => "that turn's changes are already undone".into(),
            UndoError::NotUndone => "that turn's changes have not been undone, so there is nothing to redo".into(),
            UndoError::OutOfScope(paths) => format!(
                "this session can no longer write {}; nothing was changed",
                paths.join(", ")
            ),
            UndoError::Conflicts(c) => format!(
                "{} changed since, so nothing was changed: {}",
                if c.len() == 1 { "a file" } else { "some files" },
                c.iter().map(|c| c.path.as_str()).collect::<Vec<_>>().join(", ")
            ),
            UndoError::Io(e) => format!("could not change the files ({e}); nothing was left half-done"),
        }
    }
}

fn root_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("undo")
}

fn journal_path(data_folder: &Path, session: &str) -> PathBuf {
    let safe: String = session
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(100)
        .collect();
    // The hash keeps two sessions whose ids sanitize alike apart.
    root_dir(data_folder).join(format!("{safe}-{}.json", &hex(session.as_bytes())[..12]))
}

fn hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn blob_path(data_folder: &Path, id: &str) -> PathBuf {
    root_dir(data_folder).join("blobs").join(id)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension(format!("undo-tmp-{}", std::process::id()));
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

fn store_blob(data_folder: &Path, bytes: &[u8]) -> Result<String, String> {
    let id = hex(bytes);
    let path = blob_path(data_folder, &id);
    if !path.exists() {
        write_atomic(&path, bytes)?;
    }
    Ok(id)
}

fn read_blob(data_folder: &Path, id: &str) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(blob_path(data_folder, id)).map_err(|e| e.to_string())?;
    if hex(&bytes) != id {
        return Err(format!("stored content {id} does not match its hash"));
    }
    Ok(bytes)
}

pub fn load(data_folder: &Path, session: &str) -> Journal {
    std::fs::read_to_string(journal_path(data_folder, session))
        .ok()
        .and_then(|t| serde_json::from_str::<Journal>(&t).ok())
        .filter(|j| j.session == session)
        .unwrap_or(Journal {
            v: SCHEMA_VERSION,
            session: session.to_string(),
            turns: Vec::new(),
        })
}

fn save(data_folder: &Path, journal: &Journal) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?;
    write_atomic(&journal_path(data_folder, &journal.session), &body)
}

/// Record one file change a tool made in `run`.
///
/// Repeated changes to one file within a turn keep the first "before" and the
/// last "after", so undoing the turn undoes all of them. A change that ends
/// where it started is dropped.
pub fn record(
    data_folder: &Path,
    session: &str,
    run: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: Option<&[u8]>,
) -> Result<(), String> {
    if session.is_empty() || run.is_empty() {
        return Ok(());
    }
    let before_id = before.map(|b| store_blob(data_folder, b)).transpose()?;
    let after_id = after.map(|b| store_blob(data_folder, b)).transpose()?;
    // Absolute, so the journal names the same file whatever the working
    // directory is when it is read back -- and so the scope check compares
    // like with like. A relative data folder (the configured default is
    // `./data`) recorded relative paths that no root could ever contain.
    let key = absolute(path).to_string_lossy().to_string();
    let mut journal = load(data_folder, session);
    let idx = match journal.turns.iter().position(|t| t.run == run) {
        Some(i) => i,
        None => {
            journal.turns.push(TurnChanges {
                run: run.to_string(),
                at: crate::audit::now(),
                state: TurnState::Applied,
                files: Vec::new(),
            });
            journal.turns.len() - 1
        }
    };
    let turn = &mut journal.turns[idx];
    // Recording into a turn that was undone means the turn is running again;
    // it is live, not undone.
    turn.state = TurnState::Applied;
    match turn.files.iter_mut().find(|f| same_path(&f.path, &key)) {
        Some(existing) => existing.after = after_id,
        None => turn.files.push(FileChange {
            path: key,
            before: before_id,
            after: after_id,
        }),
    }
    turn.files.retain(|f| f.before != f.after);
    if turn.files.is_empty() {
        journal.turns.remove(idx);
    }
    save(data_folder, &journal)
}

fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Lexical normalization: `..` and `.` resolved without touching the disk, so
/// a path that no longer exists can still be judged.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path` made absolute against the working directory, `..` resolved.
fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return normalize(path);
    }
    std::env::current_dir()
        .map(|cwd| normalize(&cwd.join(path)))
        .unwrap_or_else(|_| normalize(path))
}

pub(crate) fn within(path: &Path, roots: &[PathBuf]) -> bool {
    let path = absolute(path);
    let key = path.to_string_lossy().to_lowercase();
    roots.iter().any(|root| {
        let root = root.canonicalize().unwrap_or_else(|_| absolute(root));
        let r = normalize(&root);
        if cfg!(windows) {
            let rk = r.to_string_lossy().to_lowercase();
            // Canonical Windows paths carry a verbatim prefix the recorded one
            // may not; compare with it removed.
            let strip = |s: &str| s.trim_start_matches(r"\\?\").to_string();
            let (k, rk) = (strip(&key), strip(&rk));
            k == rk || k.starts_with(&format!("{rk}\\"))
        } else {
            path.starts_with(&r)
        }
    })
}

fn current(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn put(path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    match bytes {
        Some(b) => write_atomic(path, b),
        None => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub run: String,
    pub state: TurnState,
    pub files: usize,
}

/// Move a turn's files from `from` to `to`, all or nothing.
fn swap(
    data_folder: &Path,
    session: &str,
    run: &str,
    allowed_roots: &[PathBuf],
    undo: bool,
) -> Result<UndoReport, UndoError> {
    let mut journal = load(data_folder, session);
    let Some(idx) = journal.turns.iter().position(|t| t.run == run) else {
        return Err(UndoError::NotFound);
    };
    let turn = journal.turns[idx].clone();
    match (undo, turn.state) {
        (true, TurnState::Undone) => return Err(UndoError::AlreadyUndone),
        (false, TurnState::Applied) => return Err(UndoError::NotUndone),
        _ => {}
    }
    let outside: Vec<String> = turn
        .files
        .iter()
        .filter(|f| !within(Path::new(&f.path), allowed_roots))
        .map(|f| f.path.clone())
        .collect();
    if !outside.is_empty() {
        return Err(UndoError::OutOfScope(outside));
    }

    let mut plan: Vec<(PathBuf, Option<Vec<u8>>, Option<Vec<u8>>)> = Vec::new();
    let mut conflicts = Vec::new();
    for file in &turn.files {
        let (expected, target) = if undo {
            (&file.after, &file.before)
        } else {
            (&file.before, &file.after)
        };
        let path = PathBuf::from(&file.path);
        let now = current(&path).map_err(UndoError::Io)?;
        let now_id = now.as_deref().map(hex);
        if now_id.as_deref() != expected.as_deref() {
            conflicts.push(UndoConflict {
                path: file.path.clone(),
                reason: match (&now, expected) {
                    (None, Some(_)) => "it was deleted since".into(),
                    (Some(_), None) => "it was created since".into(),
                    _ => "it was changed since".into(),
                },
            });
            continue;
        }
        let bytes = match target {
            Some(id) => Some(read_blob(data_folder, id).map_err(UndoError::Io)?),
            None => None,
        };
        plan.push((path, now, bytes));
    }
    if !conflicts.is_empty() {
        return Err(UndoError::Conflicts(conflicts));
    }

    let mut done: Vec<&(PathBuf, Option<Vec<u8>>, Option<Vec<u8>>)> = Vec::new();
    for step in &plan {
        if let Err(e) = put(&step.0, step.2.as_deref()) {
            for back in done.iter().rev() {
                let _ = put(&back.0, back.1.as_deref());
            }
            return Err(UndoError::Io(e));
        }
        done.push(step);
    }
    journal.turns[idx].state = if undo {
        TurnState::Undone
    } else {
        TurnState::Applied
    };
    save(data_folder, &journal).map_err(UndoError::Io)?;
    Ok(UndoReport {
        run: run.to_string(),
        state: journal.turns[idx].state,
        files: plan.len(),
    })
}

pub fn undo(
    data_folder: &Path,
    session: &str,
    run: &str,
    allowed_roots: &[PathBuf],
) -> Result<UndoReport, UndoError> {
    swap(data_folder, session, run, allowed_roots, true)
}

pub fn redo(
    data_folder: &Path,
    session: &str,
    run: &str,
    allowed_roots: &[PathBuf],
) -> Result<UndoReport, UndoError> {
    swap(data_folder, session, run, allowed_roots, false)
}

/// Drop a session's journal, when the session itself is deleted.
pub fn forget(data_folder: &Path, session: &str) {
    let _ = std::fs::remove_file(journal_path(data_folder, session));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "jan-undo-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data = base.join("data");
        let ws = base.join("ws");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&ws).unwrap();
        (data, ws)
    }

    /// A tool's change, as `execute_tool` records it.
    fn tool_write(data: &Path, run: &str, path: &Path, content: Option<&str>) {
        let before = current(path).unwrap();
        put(path, content.map(str::as_bytes)).unwrap();
        record(data, "s1", run, path, before.as_deref(), content.map(str::as_bytes)).unwrap();
    }

    fn text(p: &Path) -> Option<String> {
        std::fs::read_to_string(p).ok()
    }

    #[test]
    fn undo_restores_what_the_turn_changed_and_redo_puts_it_back() {
        let (data, ws) = dirs("roundtrip");
        let a = ws.join("a.txt");
        let b = ws.join("b.txt");
        std::fs::write(&a, "original\n").unwrap();
        tool_write(&data, "run-1", &a, Some("changed\n"));
        tool_write(&data, "run-1", &b, Some("created\n"));

        let report = undo(&data, "s1", "run-1", &[ws.clone()]).unwrap();
        assert_eq!(report.files, 2);
        assert_eq!(text(&a).as_deref(), Some("original\n"));
        assert!(!b.exists(), "a file the turn created is removed by undo");

        redo(&data, "s1", "run-1", &[ws.clone()]).unwrap();
        assert_eq!(text(&a).as_deref(), Some("changed\n"));
        assert_eq!(text(&b).as_deref(), Some("created\n"));
    }

    #[test]
    fn several_writes_in_one_turn_undo_to_the_state_before_the_turn() {
        let (data, ws) = dirs("repeat");
        let a = ws.join("a.txt");
        std::fs::write(&a, "v0\n").unwrap();
        tool_write(&data, "run-1", &a, Some("v1\n"));
        tool_write(&data, "run-1", &a, Some("v2\n"));
        undo(&data, "s1", "run-1", &[ws.clone()]).unwrap();
        assert_eq!(text(&a).as_deref(), Some("v0\n"));
    }

    /// The user's own edit is never reverted: it makes the undo a conflict,
    /// and nothing at all is written -- not even the files that were clean.
    #[test]
    fn a_file_changed_since_refuses_the_whole_undo_and_names_it() {
        let (data, ws) = dirs("conflict");
        let a = ws.join("a.txt");
        let b = ws.join("b.txt");
        tool_write(&data, "run-1", &a, Some("jan a\n"));
        tool_write(&data, "run-1", &b, Some("jan b\n"));
        std::fs::write(&b, "the user's own edit\n").unwrap();

        let err = undo(&data, "s1", "run-1", &[ws.clone()]).unwrap_err();
        let UndoError::Conflicts(c) = &err else { panic!("{err:?}") };
        assert_eq!(c.len(), 1);
        assert!(c[0].path.ends_with("b.txt"));
        assert_eq!(text(&a).as_deref(), Some("jan a\n"), "a clean file was not reverted either");
        assert_eq!(text(&b).as_deref(), Some("the user's own edit\n"));
        assert!(err.message().contains("nothing was changed"));
    }

    /// A later turn touching the same file makes undoing the earlier one a
    /// conflict: undoing it would silently throw away the later turn's work.
    #[test]
    fn a_later_turn_on_the_same_file_blocks_undoing_the_earlier_one() {
        let (data, ws) = dirs("later");
        let a = ws.join("a.txt");
        tool_write(&data, "run-1", &a, Some("one\n"));
        tool_write(&data, "run-2", &a, Some("two\n"));
        assert!(matches!(
            undo(&data, "s1", "run-1", &[ws.clone()]),
            Err(UndoError::Conflicts(_))
        ));
        undo(&data, "s1", "run-2", &[ws.clone()]).unwrap();
        undo(&data, "s1", "run-1", &[ws.clone()]).unwrap();
        assert!(!a.exists());
    }

    /// Scope is checked when the undo is asked for, not when the turn ran: a
    /// root the session can no longer write cannot be written by undo either.
    #[test]
    fn a_path_outside_the_roots_writable_now_is_refused() {
        let (data, ws) = dirs("scope");
        let repo = ws.parent().unwrap().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let file = repo.join("x.txt");
        tool_write(&data, "run-1", &file, Some("jan\n"));
        let err = undo(&data, "s1", "run-1", &[ws.clone()]).unwrap_err();
        assert!(matches!(err, UndoError::OutOfScope(_)), "{err:?}");
        assert_eq!(text(&file).as_deref(), Some("jan\n"));
        // A spelling that climbs out of an allowed root is not inside it.
        let climbing = ws.join("..").join("repo").join("x.txt");
        assert!(!within(&climbing, &[ws.clone()]));
    }

    /// The regression, found on Windows: with a relative data folder the
    /// journal recorded a relative path, and no root the session could write
    /// ever contained it, so every undo was refused as out of scope.
    #[test]
    fn a_change_recorded_by_a_relative_path_can_still_be_undone() {
        let (data, _ws) = dirs("relative");
        let cwd = std::env::current_dir().unwrap();
        let rel_dir = PathBuf::from(format!("target/jan-undo-rel-{}", std::process::id()));
        std::fs::create_dir_all(&rel_dir).unwrap();
        let rel_file = rel_dir.join("r.txt");
        tool_write(&data, "run-1", &rel_file, Some("x\n"));
        let journal = load(&data, "s1");
        assert!(Path::new(&journal.turns[0].files[0].path).is_absolute());
        undo(&data, "s1", "run-1", &[cwd.join(&rel_dir)]).unwrap();
        assert!(!rel_file.exists());
        let _ = std::fs::remove_dir_all(&rel_dir);
    }

    #[test]
    fn undo_twice_and_redo_without_undo_are_refused() {
        let (data, ws) = dirs("states");
        let a = ws.join("a.txt");
        tool_write(&data, "run-1", &a, Some("x\n"));
        assert_eq!(redo(&data, "s1", "run-1", &[ws.clone()]), Err(UndoError::NotUndone));
        undo(&data, "s1", "run-1", &[ws.clone()]).unwrap();
        assert_eq!(undo(&data, "s1", "run-1", &[ws.clone()]), Err(UndoError::AlreadyUndone));
        assert_eq!(undo(&data, "s1", "no-such-run", &[ws.clone()]), Err(UndoError::NotFound));
    }

    #[test]
    fn the_position_survives_a_restart_and_is_per_session() {
        let (data, ws) = dirs("persist");
        let a = ws.join("a.txt");
        tool_write(&data, "run-1", &a, Some("x\n"));
        undo(&data, "s1", "run-1", &[ws.clone()]).unwrap();
        // A fresh read is what a restarted process sees.
        let journal = load(&data, "s1");
        assert_eq!(journal.turns[0].state, TurnState::Undone);
        assert!(load(&data, "s2").turns.is_empty(), "another session sees nothing");
        assert_eq!(undo(&data, "s2", "run-1", &[ws.clone()]), Err(UndoError::NotFound));
    }

    #[test]
    fn a_change_that_ends_where_it_started_is_not_recorded() {
        let (data, ws) = dirs("noop");
        let a = ws.join("a.txt");
        std::fs::write(&a, "same\n").unwrap();
        tool_write(&data, "run-1", &a, Some("same\n"));
        assert!(load(&data, "s1").turns.is_empty());
    }

    /// Stored content that no longer matches its hash is not put back: what
    /// undo restores is exactly what was there, or nothing is written.
    #[test]
    fn a_tampered_stored_copy_refuses_the_undo_and_writes_nothing() {
        let (data, ws) = dirs("tamper");
        let a = ws.join("a.txt");
        let b = ws.join("b.txt");
        std::fs::write(&a, "a0\n").unwrap();
        std::fs::write(&b, "b0\n").unwrap();
        tool_write(&data, "run-1", &a, Some("a1\n"));
        tool_write(&data, "run-1", &b, Some("b1\n"));
        let journal = load(&data, "s1");
        let before_b = journal.turns[0].files[1].before.clone().unwrap();
        std::fs::write(blob_path(&data, &before_b), "tampered").unwrap();

        let err = undo(&data, "s1", "run-1", &[ws.clone()]).unwrap_err();
        assert!(matches!(err, UndoError::Io(_)), "{err:?}");
        assert_eq!(text(&a).as_deref(), Some("a1\n"));
        assert_eq!(text(&b).as_deref(), Some("b1\n"));
        assert_eq!(load(&data, "s1").turns[0].state, TurnState::Applied);
    }

    /// All or nothing: a write that fails part way puts back the files already
    /// restored. The second file's parent is replaced by a plain file after
    /// the turn, so re-creating it cannot succeed.
    #[test]
    fn a_failed_write_rolls_back_the_files_already_restored() {
        let (data, ws) = dirs("rollback");
        let a = ws.join("a.txt");
        let dir = ws.join("d");
        let b = dir.join("b.txt");
        std::fs::write(&a, "a0\n").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&b, "b0\n").unwrap();
        tool_write(&data, "run-1", &a, Some("a1\n"));
        tool_write(&data, "run-1", &b, None);
        // The turn deleted d/b.txt; now d itself becomes a file, so undo
        // cannot recreate d/b.txt -- after it has already restored a.txt.
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::write(&dir, "in the way").unwrap();

        let err = undo(&data, "s1", "run-1", &[ws.clone()]).unwrap_err();
        assert!(matches!(err, UndoError::Io(_)), "{err:?}");
        assert_eq!(text(&a).as_deref(), Some("a1\n"), "a.txt was put back");
        assert_eq!(load(&data, "s1").turns[0].state, TurnState::Applied);
    }
}
