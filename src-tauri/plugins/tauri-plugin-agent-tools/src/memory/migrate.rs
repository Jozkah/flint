//! Bringing the legacy `<name>.md` project notes into the canonical store.
//!
//! The old project memory (AH-080) keeps a note as a file and uses its name as
//! the identity. Nothing can be said about such a note -- who saved it, when,
//! from where, what replaced it -- and renaming the file silently creates a
//! different memory. The canonical record fixes that, but the notes already on
//! disk are real memories a user wrote, so they are carried across rather than
//! abandoned.
//!
//! Three properties matter more than speed here.
//!
//! **Idempotent.** Running twice imports nothing the second time. The check is
//! the content hash, not the filename, so a note that was renamed between runs
//! is still recognised as already imported.
//!
//! **Non-destructive.** The legacy file is never touched. Migration is a copy,
//! so a failure half way through costs nothing, and a user who downgrades still
//! has every note where it has always been.
//!
//! **Quiet.** The report counts records and names files; it never contains note
//! contents, because a memory can hold anything the user typed and a migration
//! log is exactly the place nobody expects to find it.

use std::path::Path;

use super::record::{content_hash, Creator, MemoryId, MemoryRecord, Origin, Provenance, Scope};
use super::{catalog, store};

/// What a migration did. Counts and names only -- never contents.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    /// Notes turned into canonical records by this run.
    pub imported: Vec<String>,
    /// Notes already present in the canonical store, by content.
    pub already_present: Vec<String>,
    /// Notes that could not be read or were empty.
    pub skipped: Vec<String>,
}

impl Report {
    pub fn changed_anything(&self) -> bool {
        !self.imported.is_empty()
    }

    /// A one-line summary safe to log.
    pub fn summary(&self) -> String {
        format!(
            "memory migration: {} imported, {} already present, {} skipped",
            self.imported.len(),
            self.already_present.len(),
            self.skipped.len()
        )
    }
}

/// A deterministic id for a migrated note.
///
/// Derived from the project and the note's content, so re-importing the same
/// note produces the same id rather than a duplicate with a new one -- which is
/// what makes a second run a no-op even if the marker file is lost.
fn migrated_id(project_id: &str, content: &str) -> MemoryId {
    MemoryId::new(format!("mig-{}-{}", project_id, content_hash(content)))
}

/// Import every legacy note in `store_root` that is not already canonical.
///
/// `project_id` scopes the resulting records; without one the notes cannot be
/// attributed to a project and are left alone, because a project memory that
/// belongs to no project would either apply nowhere or, worse, everywhere.
pub fn migrate_project_notes(
    store_root: &Path,
    project_id: Option<&str>,
    now: i64,
) -> Result<Report, String> {
    let mut report = Report::default();
    let Some(project_id) = project_id else {
        return Ok(report);
    };

    let notes = catalog(store_root);
    if notes.is_empty() {
        return Ok(report);
    }

    let mut existing = store::load(store_root, Scope::Project).records;
    let known: std::collections::HashSet<String> =
        existing.iter().map(|r| r.content_hash.clone()).collect();

    for (name, _summary) in notes {
        // Read the body directly: `catalog` returns the summary line, and a
        // memory is its whole content, not its first line.
        let path = super::memory_dir(store_root).join(format!("{name}.md"));
        let Ok(body) = std::fs::read_to_string(&path) else {
            report.skipped.push(name);
            continue;
        };
        if body.trim().is_empty() {
            report.skipped.push(name);
            continue;
        }

        let hash = content_hash(&body);
        if known.contains(&hash) {
            report.already_present.push(name);
            continue;
        }

        let mut record = MemoryRecord::new(
            migrated_id(project_id, &body),
            &body,
            Scope::Project,
            // Not `User`: nobody reviewed this content today, and treating it
            // as user-stated would let a note outrank things the user actually
            // said in the meantime. `System` is what it is -- Jan moved it.
            Creator::System,
            Origin::Explicit,
            now,
        );
        record.project_id = Some(project_id.to_string());
        record.category = Some("migrated-note".to_string());
        record.provenance = Provenance {
            // The note itself is the source. Recorded as a note name rather
            // than an absolute path, which would be machine-specific and would
            // leak a directory layout into an export.
            message_id: Some(format!("legacy-note:{name}")),
            ..Provenance::default()
        };
        existing.push(record);
        report.imported.push(name);
    }

    if report.changed_anything() {
        // The canonical write is committed before anything else is claimed.
        // The legacy files are left exactly where they are either way.
        store::save(store_root, Scope::Project, &existing)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("jan_migrate_{}_{}", std::process::id(), n))
    }

    fn write_note(root: &Path, name: &str, body: &str) {
        let dir = super::super::memory_dir(root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{name}.md")), body).unwrap();
    }

    #[test]
    fn legacy_notes_become_canonical_records() {
        let root = unique_root();
        write_note(&root, "conventions", "# Conventions\nWe build with make.");

        let report = migrate_project_notes(&root, Some("p1"), 1_000).unwrap();
        assert_eq!(report.imported, vec!["conventions"]);

        let records = store::load(&root, Scope::Project).records;
        assert_eq!(records.len(), 1);
        assert!(records[0].content.contains("We build with make."));
        assert_eq!(records[0].project_id.as_deref(), Some("p1"));
        assert_eq!(records[0].creator, Creator::System);
        assert_eq!(
            records[0].provenance.message_id.as_deref(),
            Some("legacy-note:conventions")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The property that makes it safe to run on every launch.
    #[test]
    fn running_twice_imports_nothing_the_second_time() {
        let root = unique_root();
        write_note(&root, "a", "first note");
        write_note(&root, "b", "second note");

        let first = migrate_project_notes(&root, Some("p1"), 1_000).unwrap();
        assert_eq!(first.imported.len(), 2);

        let second = migrate_project_notes(&root, Some("p1"), 2_000).unwrap();
        assert!(second.imported.is_empty(), "re-imported on the second run");
        assert_eq!(second.already_present.len(), 2);
        assert_eq!(store::load(&root, Scope::Project).records.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Identity is the content, so a note renamed between runs is recognised
    /// rather than imported again under its new name.
    #[test]
    fn a_renamed_note_is_not_imported_twice() {
        let root = unique_root();
        write_note(&root, "old-name", "the same body");
        migrate_project_notes(&root, Some("p1"), 1_000).unwrap();

        let dir = super::super::memory_dir(&root);
        std::fs::rename(dir.join("old-name.md"), dir.join("new-name.md")).unwrap();

        let second = migrate_project_notes(&root, Some("p1"), 2_000).unwrap();
        assert!(second.imported.is_empty());
        assert_eq!(store::load(&root, Scope::Project).records.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_legacy_notes_are_never_deleted() {
        let root = unique_root();
        write_note(&root, "keepme", "body");
        migrate_project_notes(&root, Some("p1"), 1_000).unwrap();
        assert!(
            super::super::memory_dir(&root).join("keepme.md").exists(),
            "migration destroyed the legacy note"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_and_unreadable_notes_are_skipped_not_imported() {
        let root = unique_root();
        write_note(&root, "blank", "   \n\n");
        write_note(&root, "real", "actual content");

        let report = migrate_project_notes(&root, Some("p1"), 1_000).unwrap();
        assert_eq!(report.imported, vec!["real"]);
        assert_eq!(report.skipped, vec!["blank"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A project memory belonging to no project would apply nowhere or, worse,
    /// everywhere. Without an identity, nothing is imported.
    #[test]
    fn notes_are_left_alone_when_the_project_cannot_be_identified() {
        let root = unique_root();
        write_note(&root, "a", "body");
        let report = migrate_project_notes(&root, None, 1_000).unwrap();
        assert!(report.imported.is_empty());
        assert!(store::load(&root, Scope::Project).records.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A record already imported by an earlier run must survive a later one,
    /// including records that were not migrated at all.
    #[test]
    fn migration_preserves_records_it_did_not_create() {
        let root = unique_root();
        let mut hand_written = MemoryRecord::new(
            MemoryId::new("hand"),
            "written by the user",
            Scope::Project,
            Creator::User,
            Origin::Explicit,
            500,
        );
        hand_written.project_id = Some("p1".into());
        store::upsert(&root, &hand_written).unwrap();

        write_note(&root, "legacy", "from a note");
        migrate_project_notes(&root, Some("p1"), 1_000).unwrap();

        let records = store::load(&root, Scope::Project).records;
        assert_eq!(records.len(), 2);
        assert!(records.iter().any(|r| r.id == MemoryId::new("hand")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A migration that has to be re-run after a crash lands the same ids, so
    /// nothing is duplicated by the retry.
    #[test]
    fn ids_are_stable_across_runs() {
        let a = migrated_id("p1", "same body");
        let b = migrated_id("p1", "same body");
        assert_eq!(a, b);
        assert_ne!(a, migrated_id("p2", "same body"));
        assert_ne!(a, migrated_id("p1", "different body"));
    }

    /// The report is safe to log: counts and note names, never contents.
    #[test]
    fn the_report_never_carries_note_contents() {
        let root = unique_root();
        write_note(&root, "secrets", "hunter2 is the password");
        let report = migrate_project_notes(&root, Some("p1"), 1_000).unwrap();
        let summary = report.summary();
        assert!(!summary.contains("hunter2"));
        assert!(!format!("{report:?}").contains("hunter2"));
        assert!(summary.contains("1 imported"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_project_with_no_notes_is_a_no_op() {
        let root = unique_root();
        let report = migrate_project_notes(&root, Some("p1"), 1_000).unwrap();
        assert_eq!(report, Report::default());
        let _ = std::fs::remove_dir_all(&root);
    }
}
