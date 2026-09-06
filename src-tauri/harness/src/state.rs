//! Versioned persisted run state (AHD-010, AHD-011).
//!
//! Nothing the harness writes today carries a schema version -- not
//! `thread.json`, not `messages.jsonl`, not the display journal -- so no format
//! change is safely shippable and a downgraded install reads new files as if
//! they were old ones.
//!
//! Everything here is versioned and read strictly: a record from a newer build
//! is refused rather than misread, and a record from an older schema is refused
//! until a migration for it exists. Refusing loudly keeps a bad read from
//! silently becoming a bad write.
//!
//! State lives in the harness rather than in a surface (AHD-011): checkpoints,
//! resume and replay are currently CLI-only, which is why the desktop app and
//! the server proxy have none of them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::envelope::EventLog;
use crate::error::{ErrorKind, HarnessError};
use crate::event::now_ms;
use crate::identity::{RunId, RunIdentity};

/// The schema version this build writes.
pub const STATE_SCHEMA_VERSION: u32 = 1;

/// Where a run got to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Still executing, or the process died while it was.
    Running,
    Completed,
    Failed,
    Cancelled,
    /// Observed as `Running` by a later process: the previous one did not finish.
    Interrupted,
}

impl RunStatus {
    /// Whether the run has reached a terminal state.
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

/// The durable record of one run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunRecord {
    pub schema_version: u32,
    pub identity: RunIdentity,
    pub status: RunStatus,
    pub model: String,
    pub plan_mode: bool,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    /// Sequence number of the last event durably appended for this run.
    ///
    /// Resume compares this against the event log to find what the previous
    /// process had actually committed before it stopped.
    pub last_event_seq: u64,
    #[serde(default)]
    pub checkpoints: Vec<String>,
}

impl RunRecord {
    /// Opens a record for a run that is starting now.
    pub fn started(identity: RunIdentity, model: impl Into<String>, plan_mode: bool) -> Self {
        let now = now_ms();
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            identity,
            status: RunStatus::Running,
            model: model.into(),
            plan_mode,
            started_at_ms: now,
            updated_at_ms: now,
            finished_at_ms: None,
            last_event_seq: 0,
            checkpoints: Vec::new(),
        }
    }

    /// Closes the record in a terminal state.
    pub fn finish(&mut self, status: RunStatus) {
        self.status = status;
        let now = now_ms();
        self.updated_at_ms = now;
        self.finished_at_ms = Some(now);
    }
}

/// The on-disk layout for run state.
///
/// ```text
/// <root>/runs/<run_id>/record.json     the RunRecord
/// <root>/runs/<run_id>/events.jsonl    the canonical event log
/// ```
///
/// One directory per run, named by the run id, so a run's whole footprint can
/// be exported, archived or deleted as a unit (`AH-177`, `AH-200`).
pub struct StateStore {
    root: PathBuf,
}

impl StateStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn runs_dir(&self) -> PathBuf {
        self.root.join("runs")
    }

    /// The directory holding one run's state.
    ///
    /// The id is used as a path segment, which is only safe because `RunId`
    /// cannot be constructed from arbitrary text: it is either minted or parsed
    /// against a fixed prefix, so it can never carry a separator or `..`.
    pub fn run_dir(&self, run: &RunId) -> PathBuf {
        self.runs_dir().join(run.as_str())
    }

    pub fn record_path(&self, run: &RunId) -> PathBuf {
        self.run_dir(run).join("record.json")
    }

    pub fn events_path(&self, run: &RunId) -> PathBuf {
        self.run_dir(run).join("events.jsonl")
    }

    /// Opens the run's append-only event log.
    pub fn open_event_log(&self, run: &RunId) -> Result<EventLog, HarnessError> {
        EventLog::open(self.events_path(run))
    }

    /// Writes the record, replacing any previous one atomically.
    ///
    /// Written to a sibling temporary file and renamed, so a crash mid-write
    /// leaves the previous record intact rather than a truncated one. A record
    /// that cannot be read is a run that cannot be resumed.
    pub fn save(&self, record: &RunRecord) -> Result<(), HarnessError> {
        if record.schema_version != STATE_SCHEMA_VERSION {
            return Err(HarnessError::new(
                ErrorKind::InvalidInput,
                format!(
                    "refusing to write schema version {} from a build that writes {}",
                    record.schema_version, STATE_SCHEMA_VERSION
                ),
            ));
        }

        let path = self.record_path(&record.identity.run);
        std::fs::create_dir_all(self.run_dir(&record.identity.run))?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(record)?)?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    }

    /// Reads a run's record.
    pub fn load(&self, run: &RunId) -> Result<RunRecord, HarnessError> {
        let path = self.record_path(run);
        let bytes = std::fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                HarnessError::new(ErrorKind::NotFound, format!("no run record at {}", path.display()))
            } else {
                error.into()
            }
        })?;

        // Read the version before the body: a newer schema may have renamed the
        // very fields a strict deserialize would trip over, and "unsupported
        // version" is a far more useful failure than "missing field".
        #[derive(Deserialize)]
        struct Versioned {
            schema_version: u32,
        }
        let version = serde_json::from_slice::<Versioned>(&bytes)?.schema_version;
        if version > STATE_SCHEMA_VERSION {
            return Err(HarnessError::new(
                ErrorKind::Unsupported,
                format!(
                    "run state schema {version} was written by a newer build (this build reads {STATE_SCHEMA_VERSION})"
                ),
            ));
        }
        if version < STATE_SCHEMA_VERSION {
            return Err(HarnessError::new(
                ErrorKind::Unsupported,
                format!("no migration from run state schema {version} to {STATE_SCHEMA_VERSION}"),
            ));
        }

        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Loads a record, marking it `Interrupted` if the previous process died.
    ///
    /// A record still reading `Running` when a *later* process opens it means
    /// the run never closed. Resume (`AH-026`) needs that distinction: an
    /// interrupted run has a partial event log and possibly partial side
    /// effects, and must not be treated as one that simply failed.
    pub fn load_for_resume(&self, run: &RunId) -> Result<RunRecord, HarnessError> {
        let mut record = self.load(run)?;
        if record.status == RunStatus::Running {
            record.status = RunStatus::Interrupted;
        }
        Ok(record)
    }

    /// Every run id with state on disk, in creation order.
    pub fn list(&self) -> Result<Vec<RunId>, HarnessError> {
        let dir = match std::fs::read_dir(self.runs_dir()) {
            Ok(dir) => dir,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };

        let mut runs = Vec::new();
        for entry in dir {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            // Anything not shaped like a run id is not ours; skipping keeps an
            // unrelated directory from failing the whole listing.
            if let Ok(run) = RunId::parse(entry.file_name().to_string_lossy().to_string()) {
                runs.push(run);
            }
        }
        // Ids are time-ordered base-36, so lexicographic order is creation order.
        runs.sort();
        Ok(runs)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{EventPayload, HarnessEvent};
    use crate::fixtures::{identity, TempDir};

    fn store(dir: &TempDir) -> StateStore {
        StateStore::new(dir.path())
    }

    #[test]
    fn a_record_round_trips() {
        let dir = TempDir::new("state");
        let store = store(&dir);
        let record = RunRecord::started(identity(), "test-model", true);

        store.save(&record).unwrap();
        assert_eq!(store.load(&record.identity.run).unwrap(), record);
    }

    #[test]
    fn saving_twice_replaces_rather_than_appends() {
        let dir = TempDir::new("state-replace");
        let store = store(&dir);
        let mut record = RunRecord::started(identity(), "m", false);

        store.save(&record).unwrap();
        record.finish(RunStatus::Completed);
        store.save(&record).unwrap();

        let loaded = store.load(&record.identity.run).unwrap();
        assert_eq!(loaded.status, RunStatus::Completed);
        assert!(loaded.finished_at_ms.is_some());
        // The temporary file must not survive the rename.
        assert!(!store.record_path(&record.identity.run).with_extension("json.tmp").exists());
    }

    #[test]
    fn loading_an_absent_run_is_not_found() {
        let dir = TempDir::new("state-absent");
        let error = store(&dir).load(&RunId::new()).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NotFound);
    }

    #[test]
    fn a_newer_schema_is_refused_rather_than_misread() {
        let dir = TempDir::new("state-newer");
        let store = store(&dir);
        let record = RunRecord::started(identity(), "m", false);
        store.save(&record).unwrap();

        let path = store.record_path(&record.identity.run);
        let raw = std::fs::read_to_string(&path).unwrap();
        std::fs::write(
            &path,
            raw.replace(
                &format!("\"schema_version\": {STATE_SCHEMA_VERSION}"),
                &format!("\"schema_version\": {}", STATE_SCHEMA_VERSION + 1),
            ),
        )
        .unwrap();

        let error = store.load(&record.identity.run).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Unsupported);
        assert!(error.message().contains("newer build"), "{}", error.message());
    }

    #[test]
    fn an_older_schema_without_a_migration_is_refused() {
        let dir = TempDir::new("state-older");
        let store = store(&dir);
        let run = RunId::new();
        std::fs::create_dir_all(store.run_dir(&run)).unwrap();
        std::fs::write(store.record_path(&run), br#"{"schema_version":0}"#).unwrap();

        let error = store.load(&run).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Unsupported);
        assert!(error.message().contains("no migration"), "{}", error.message());
    }

    #[test]
    fn writing_a_foreign_schema_version_is_refused() {
        let dir = TempDir::new("state-write-version");
        let mut record = RunRecord::started(identity(), "m", false);
        record.schema_version = STATE_SCHEMA_VERSION + 1;

        let error = store(&dir).save(&record).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn an_unfinished_run_is_recovered_as_interrupted() {
        let dir = TempDir::new("state-interrupted");
        let store = store(&dir);
        let record = RunRecord::started(identity(), "m", false);
        store.save(&record).unwrap();

        // The run's own process would still read it as Running.
        assert_eq!(store.load(&record.identity.run).unwrap().status, RunStatus::Running);
        // A later process resuming it must see that it never closed.
        let resumed = store.load_for_resume(&record.identity.run).unwrap();
        assert_eq!(resumed.status, RunStatus::Interrupted);
        assert!(resumed.status.is_terminal());
    }

    #[test]
    fn a_finished_run_is_not_reclassified_on_resume() {
        let dir = TempDir::new("state-finished");
        let store = store(&dir);
        let mut record = RunRecord::started(identity(), "m", false);
        record.finish(RunStatus::Cancelled);
        store.save(&record).unwrap();

        assert_eq!(store.load_for_resume(&record.identity.run).unwrap().status, RunStatus::Cancelled);
    }

    #[test]
    fn runs_are_listed_in_creation_order() {
        let dir = TempDir::new("state-list");
        let store = store(&dir);
        let records: Vec<_> = (0..3).map(|_| RunRecord::started(identity(), "m", false)).collect();
        for record in &records {
            store.save(record).unwrap();
        }

        let listed = store.list().unwrap();
        assert_eq!(listed, records.iter().map(|r| r.identity.run.clone()).collect::<Vec<_>>());
    }

    #[test]
    fn listing_ignores_directories_that_are_not_runs() {
        let dir = TempDir::new("state-list-foreign");
        let store = store(&dir);
        std::fs::create_dir_all(store.runs_dir().join("not-a-run")).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn listing_an_empty_store_yields_nothing() {
        let dir = TempDir::new("state-list-empty");
        assert!(store(&dir).list().unwrap().is_empty());
    }

    #[test]
    fn a_run_keeps_its_record_and_events_together() {
        let dir = TempDir::new("state-events");
        let store = store(&dir);
        let record = RunRecord::started(identity(), "m", false);
        store.save(&record).unwrap();

        let mut log = store.open_event_log(&record.identity.run).unwrap();
        log.append(&HarnessEvent::at(
            0,
            1,
            record.identity.clone(),
            EventPayload::TurnStarted { turn: 0 },
        ))
        .unwrap();

        let run_dir = store.run_dir(&record.identity.run);
        assert!(run_dir.join("record.json").is_file());
        assert!(run_dir.join("events.jsonl").is_file());
    }
}
