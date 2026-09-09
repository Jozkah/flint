//! Persistence for [`MemoryRecord`]s: one JSONL file per scope.
//!
//! JSONL rather than a single JSON document, because the failure mode matters
//! more than the elegance. A truncated JSON array is unreadable in its
//! entirety; a truncated JSONL file is every complete line that came before it.
//! A crash mid-write therefore costs the record being written, not the store.
//!
//! Writes replace the whole file through a temp-and-rename, so a reader never
//! observes a half-written store, and a crash leaves either the old file or the
//! new one. On Windows the rename is retried: an antivirus scanner or the
//! search indexer holding the destination open makes `rename` fail with a
//! sharing violation for a few milliseconds, and treating that as data loss
//! would be wrong.
//!
//! Unreadable lines are skipped and counted rather than failing the load. A
//! store with one corrupt record should give up that record, not every memory
//! the user has.

use std::path::{Path, PathBuf};

use super::record::{MemoryId, MemoryRecord, Scope, SCHEMA_VERSION};

/// What a load found, including what it could not read.
#[derive(Debug, Default)]
pub struct Loaded {
    pub records: Vec<MemoryRecord>,
    /// Lines that could not be parsed. Reported so the UI can say so rather
    /// than pretending the store was always this size.
    pub skipped_unreadable: usize,
    /// Records written by a newer Jan. Kept out of use rather than guessed at,
    /// and never rewritten, so downgrading does not destroy them.
    pub skipped_newer_schema: usize,
}

fn file_name(scope: Scope) -> &'static str {
    match scope {
        Scope::User => "user.jsonl",
        Scope::Project => "project.jsonl",
        Scope::Session => "session.jsonl",
    }
}

/// `<store_root>/memory/records/<scope>.jsonl`.
///
/// Under the existing `memory/` directory, in a subdirectory of its own, so the
/// flat `<name>.md` notes AH-080 already writes are left exactly where they are
/// and neither store can be mistaken for the other.
pub fn records_path(store_root: &Path, scope: Scope) -> PathBuf {
    super::memory_dir(store_root)
        .join("records")
        .join(file_name(scope))
}

/// Read every usable record for one scope.
///
/// Never fails for content reasons: a missing file is an empty store, and a
/// line that will not parse is skipped and counted.
pub fn load(store_root: &Path, scope: Scope) -> Loaded {
    let path = records_path(store_root, scope);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Loaded::default();
    };

    let mut out = Loaded::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<MemoryRecord>(line) {
            Ok(record) if record.schema_version > SCHEMA_VERSION => {
                out.skipped_newer_schema += 1;
            }
            Ok(record) => out.records.push(record),
            Err(_) => out.skipped_unreadable += 1,
        }
    }
    out
}

/// Replace the stored records for one scope.
///
/// Whole-file replacement rather than append: an edit, a supersede and a delete
/// all change existing records, and an append-only log would need compaction to
/// answer the simplest question the UI asks ("what is in this scope?").
pub fn save(store_root: &Path, scope: Scope, records: &[MemoryRecord]) -> Result<(), String> {
    let path = records_path(store_root, scope);
    let dir = path
        .parent()
        .ok_or_else(|| "ERROR: memory records path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("ERROR: {e}"))?;

    let mut body = String::new();
    for record in records {
        let line = serde_json::to_string(record).map_err(|e| format!("ERROR: {e}"))?;
        body.push_str(&line);
        body.push('\n');
    }

    // Unique per process so two Jan windows writing at once cannot land on the
    // same temp file and corrupt each other's write.
    let temp = path.with_extension(format!("jsonl.tmp-{}", std::process::id()));
    std::fs::write(&temp, body.as_bytes()).map_err(|e| format!("ERROR: {e}"))?;
    let renamed = rename_with_retry(&temp, &path);
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    renamed
}

/// `rename`, retried briefly.
///
/// On Windows a rename over an existing file fails while anything holds the
/// destination open, and on a developer's machine that is routinely an
/// antivirus scanner or the search indexer reacting to the write that just
/// happened. The window is milliseconds; failing the save outright would lose a
/// memory for a reason that has nothing to do with the memory.
fn rename_with_retry(from: &Path, to: &Path) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..10 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(10 * (attempt + 1)));
            }
        }
    }
    Err(format!("ERROR: could not replace {}: {last}", to.display()))
}

/// Add or replace one record, preserving everything else in its scope.
pub fn upsert(store_root: &Path, record: &MemoryRecord) -> Result<(), String> {
    let mut records = load(store_root, record.scope).records;
    match records.iter_mut().find(|r| r.id == record.id) {
        Some(existing) => *existing = record.clone(),
        None => records.push(record.clone()),
    }
    save(store_root, record.scope, &records)
}

/// Remove one record outright. Idempotent.
///
/// Callers wanting an undoable delete set [`super::record::Status::Deleted`]
/// through `upsert` instead; this is the permanent one.
pub fn remove(store_root: &Path, scope: Scope, id: &MemoryId) -> Result<(), String> {
    let mut records = load(store_root, scope).records;
    let before = records.len();
    records.retain(|r| &r.id != id);
    if records.len() == before {
        return Ok(());
    }
    save(store_root, scope, &records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::record::{Creator, MemoryId, Origin, Status};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("jan_memstore_test_{}_{}", std::process::id(), n))
    }

    fn rec(id: &str, content: &str, scope: Scope) -> MemoryRecord {
        MemoryRecord::new(
            MemoryId::new(id),
            content,
            scope,
            Creator::User,
            Origin::Explicit,
            1_000,
        )
    }

    #[test]
    fn a_missing_store_is_empty_not_an_error() {
        let root = unique_root();
        let loaded = load(&root, Scope::User);
        assert!(loaded.records.is_empty());
        assert_eq!(loaded.skipped_unreadable, 0);
    }

    #[test]
    fn records_survive_a_save_and_load() {
        let root = unique_root();
        let a = rec("a", "Use yarn", Scope::User);
        let b = rec("b", "Run tests first", Scope::User);
        save(&root, Scope::User, &[a.clone(), b.clone()]).unwrap();

        let loaded = load(&root, Scope::User);
        assert_eq!(loaded.records, vec![a, b]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Restart recovery: a second load with no state in memory sees the same
    /// records, which is the whole point of persisting them.
    #[test]
    fn a_fresh_load_sees_what_a_previous_run_wrote() {
        let root = unique_root();
        save(&root, Scope::Project, &[rec("a", "x", Scope::Project)]).unwrap();
        drop(load(&root, Scope::Project));
        let second = load(&root, Scope::Project);
        assert_eq!(second.records.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scopes_are_separate_files_and_never_mix() {
        let root = unique_root();
        save(&root, Scope::User, &[rec("u", "user", Scope::User)]).unwrap();
        save(
            &root,
            Scope::Project,
            &[rec("p", "project", Scope::Project)],
        )
        .unwrap();
        save(
            &root,
            Scope::Session,
            &[rec("s", "session", Scope::Session)],
        )
        .unwrap();

        assert_eq!(load(&root, Scope::User).records.len(), 1);
        assert_eq!(load(&root, Scope::User).records[0].id, MemoryId::new("u"));
        assert_eq!(
            load(&root, Scope::Project).records[0].id,
            MemoryId::new("p")
        );
        assert_eq!(
            load(&root, Scope::Session).records[0].id,
            MemoryId::new("s")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The reason for JSONL: one bad line costs one record.
    #[test]
    fn a_corrupt_line_costs_only_itself() {
        let root = unique_root();
        save(
            &root,
            Scope::User,
            &[
                rec("a", "first", Scope::User),
                rec("b", "second", Scope::User),
            ],
        )
        .unwrap();

        let path = records_path(&root, Scope::User);
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{ this is not json\n");
        std::fs::write(&path, text).unwrap();

        let loaded = load(&root, Scope::User);
        assert_eq!(loaded.records.len(), 2, "good records were lost");
        assert_eq!(loaded.skipped_unreadable, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A crash mid-write truncates the last line; everything before it stands.
    #[test]
    fn a_truncated_file_keeps_the_records_that_completed() {
        let root = unique_root();
        save(
            &root,
            Scope::User,
            &[
                rec("a", "first", Scope::User),
                rec("b", "second", Scope::User),
            ],
        )
        .unwrap();

        let path = records_path(&root, Scope::User);
        let text = std::fs::read_to_string(&path).unwrap();
        let cut = text.len() - 20;
        std::fs::write(&path, &text[..cut]).unwrap();

        let loaded = load(&root, Scope::User);
        assert_eq!(loaded.records.len(), 1);
        assert_eq!(loaded.records[0].id, MemoryId::new("a"));
        assert_eq!(loaded.skipped_unreadable, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A record from a newer Jan is left alone rather than half-understood.
    #[test]
    fn records_from_a_newer_schema_are_skipped_not_guessed_at() {
        let root = unique_root();
        let mut future = rec("f", "from the future", Scope::User);
        future.schema_version = SCHEMA_VERSION + 1;
        save(&root, Scope::User, &[rec("a", "now", Scope::User), future]).unwrap();

        let loaded = load(&root, Scope::User);
        assert_eq!(loaded.records.len(), 1);
        assert_eq!(loaded.skipped_newer_schema, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn upsert_adds_then_replaces_without_disturbing_others() {
        let root = unique_root();
        let a = rec("a", "first", Scope::User);
        let b = rec("b", "second", Scope::User);
        upsert(&root, &a).unwrap();
        upsert(&root, &b).unwrap();
        assert_eq!(load(&root, Scope::User).records.len(), 2);

        let mut edited = a.clone();
        edited.content = "edited".into();
        upsert(&root, &edited).unwrap();

        let loaded = load(&root, Scope::User);
        assert_eq!(loaded.records.len(), 2, "upsert duplicated a record");
        let found = loaded.records.iter().find(|r| r.id == a.id).unwrap();
        assert_eq!(found.content, "edited");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_is_idempotent_and_leaves_the_rest() {
        let root = unique_root();
        upsert(&root, &rec("a", "first", Scope::User)).unwrap();
        upsert(&root, &rec("b", "second", Scope::User)).unwrap();

        remove(&root, Scope::User, &MemoryId::new("a")).unwrap();
        assert_eq!(load(&root, Scope::User).records.len(), 1);
        remove(&root, Scope::User, &MemoryId::new("a")).unwrap();
        assert_eq!(load(&root, Scope::User).records.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A soft delete keeps the record for undo but takes it out of use.
    #[test]
    fn a_soft_deleted_record_stays_stored_but_is_not_usable() {
        let root = unique_root();
        let mut m = rec("a", "x", Scope::User);
        m.status = Status::Deleted;
        upsert(&root, &m).unwrap();

        let loaded = load(&root, Scope::User);
        assert_eq!(
            loaded.records.len(),
            1,
            "undo needs the record to still exist"
        );
        assert!(!loaded.records[0].is_usable(1_000));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// No half-written store is ever observable: the file is complete or old.
    #[test]
    fn a_save_leaves_no_temp_file_behind() {
        let root = unique_root();
        save(&root, Scope::User, &[rec("a", "x", Scope::User)]).unwrap();
        let dir = records_path(&root, Scope::User)
            .parent()
            .unwrap()
            .to_path_buf();
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp file left behind");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Unicode and localised text survive the round trip byte for byte.
    #[test]
    fn unicode_content_round_trips() {
        let root = unique_root();
        let text = "Prefira português — use “aspas” e emoji 🧠, não ASCII";
        upsert(&root, &rec("a", text, Scope::User)).unwrap();
        let loaded = load(&root, Scope::User);
        assert_eq!(loaded.records[0].content, text);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Two writers alternating must not lose the store; last write wins and the
    /// file stays readable throughout.
    #[test]
    fn concurrent_writers_leave_a_readable_store() {
        let root = unique_root();
        std::thread::scope(|s| {
            for n in 0..4 {
                let root = root.clone();
                s.spawn(move || {
                    for i in 0..5 {
                        let id = format!("w{n}-{i}");
                        let _ = upsert(&root, &rec(&id, "x", Scope::User));
                    }
                });
            }
        });
        let loaded = load(&root, Scope::User);
        assert_eq!(loaded.skipped_unreadable, 0, "a writer corrupted the store");
        assert!(!loaded.records.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
