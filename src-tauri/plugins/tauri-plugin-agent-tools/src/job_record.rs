//! What a background job was, after the app that started it is gone. AH-101/AH-102.
//!
//! Background jobs live in a map in memory: the moment the app exits, a job
//! that was running becomes a job nobody has any record of. The panel that
//! listed it is empty, the output it produced cannot be found, and a process
//! that outlived the app -- which happens whenever the app is killed rather
//! than closed -- is running with nothing naming it.
//!
//! This is the durable half. One line per job under `<data>/jobs/`, holding
//! what a listing needs and nothing a listing does not: the owner, the
//! provenance (run, invocation, agent), a redacted summary of the command,
//! where its output went, and how it ended. No environment, no arguments that
//! were not already redacted, no secrets.
//!
//! ## Which process
//!
//! A pid on its own is not an identity: the operating system reuses them, and
//! a record that trusts one can end up listing -- or killing -- whatever
//! happens to hold that number now. Every record therefore keeps the process's
//! creation time as well, and a job is only "still the one we started" when
//! both match. Anything else is treated as ended, never adopted: the cost of
//! being wrong in the other direction is terminating a stranger's process.
//!
//! ## What a restart may conclude
//!
//! Reconciling reads each record that says `running` and asks the operating
//! system one question: is that exact process still there? A job whose process
//! is gone is `interrupted` -- something ended it while nobody was watching --
//! and never `completed`, because no exit status was ever seen. A job whose
//! pid now belongs to something else is `interrupted` too, with a note saying
//! why, and the pid is dropped so nothing can act on it later.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The record's own version. A reader that meets a newer one says so.
pub const JOB_RECORD_VERSION: u16 = 1;
/// Records kept per owner; the oldest go first.
pub const MAX_RECORDS_PER_OWNER: usize = 200;
/// Longest command summary kept.
const MAX_SUMMARY_CHARS: usize = 300;

/// How a job stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobState {
    /// Started, and the process was there the last time anyone looked.
    Running,
    /// Ended on its own terms, with an exit status somebody saw.
    Completed,
    /// Ended badly, with an exit status somebody saw.
    Failed,
    /// Somebody asked for it to stop, and it did.
    Cancelled,
    /// It was running and is not any more, and nobody saw it end.
    Interrupted,
    /// Its pid now belongs to another process, so what became of it is
    /// unknowable. Never acted on.
    Orphaned,
}

impl JobState {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Orphaned => "orphaned",
        }
    }

    /// Whether this is an ending. A reconciled record never goes back.
    pub fn is_ended(self) -> bool {
        !matches!(self, Self::Running)
    }
}

/// Which process a job is, beyond its number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    /// The process's creation time as the OS reports it. Zero when the host
    /// could not say, which is treated as "cannot be re-identified".
    #[serde(default)]
    pub created: u64,
}

impl ProcessIdentity {
    /// Whether this names a process that can be checked later.
    pub fn is_checkable(&self) -> bool {
        self.pid != 0 && self.created != 0
    }
}

/// One background job, as it survives the app.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub v: u16,
    pub id: String,
    /// The conversation that started it. A job is listed to its owner and to
    /// nobody else.
    pub owner: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub invocation: String,
    #[serde(default)]
    pub agent: String,
    /// What was run, redacted and bounded. Metadata for a listing, not a
    /// transcript.
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub identity: ProcessIdentity,
    pub started_at_ms: u64,
    #[serde(default)]
    pub ended_at_ms: Option<u64>,
    pub state: JobState,
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// Where the output was written, when it was kept.
    #[serde(default)]
    pub output_path: String,
    /// Why the state says what it says, when that is not obvious.
    #[serde(default)]
    pub note: String,
    /// The hash of this job's secret (AH-101). The secret itself lives only in
    /// the supervisor's claim file: a record that carried it would put it in
    /// every listing and every export.
    #[serde(default)]
    pub token_hash: String,
}

impl JobRecord {
    /// A new record for a job that has just started.
    pub fn started(
        id: impl Into<String>,
        owner: impl Into<String>,
        summary: &str,
        identity: ProcessIdentity,
    ) -> Self {
        Self {
            v: JOB_RECORD_VERSION,
            id: id.into(),
            owner: owner.into(),
            project: String::new(),
            run: String::new(),
            invocation: String::new(),
            agent: String::new(),
            summary: bounded(&crate::audit::redact(summary)),
            identity,
            started_at_ms: now_ms(),
            ended_at_ms: None,
            state: JobState::Running,
            exit_code: None,
            output_path: String::new(),
            note: String::new(),
            token_hash: String::new(),
        }
    }

    /// Who asked for it, so a job is joinable to the run that started it.
    pub fn from_run(mut self, run: &str, invocation: &str, agent: &str) -> Self {
        self.run = run.to_string();
        self.invocation = invocation.to_string();
        self.agent = agent.to_string();
        self
    }
}

fn bounded(text: &str) -> String {
    let text = text.replace(['\n', '\r'], " ");
    if text.chars().count() <= MAX_SUMMARY_CHARS {
        return text;
    }
    let kept: String = text.chars().take(MAX_SUMMARY_CHARS).collect();
    format!("{kept}...")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn jobs_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("jobs")
}

fn path_for(data_folder: &Path, owner: &str) -> PathBuf {
    // Keyed by a hash, so an owner id is never a path component.
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, owner.as_bytes());
    let hash = format!("{:x}", sha2::Digest::finalize(hasher));
    jobs_dir(data_folder).join(format!("{}.jsonl", &hash[..24]))
}

/// Write a record, replacing any earlier one with the same id.
///
/// Best effort by design: losing the note must not fail the job it describes.
pub fn save(data_folder: &Path, record: &JobRecord) -> Result<(), String> {
    // AH-008: the owner names the file this is written to and the id is a key
    // in it, so both are parsed before either is used.
    crate::identity::SessionId::parse(record.owner.as_str()).map_err(|e| e.message().to_string())?;
    crate::identity::JobId::parse(record.id.as_str()).map_err(|e| e.message().to_string())?;
    let path = path_for(data_folder, &record.owner);
    std::fs::create_dir_all(jobs_dir(data_folder)).map_err(|e| e.to_string())?;
    let mut kept: Vec<JobRecord> = read_owner(data_folder, &record.owner)
        .into_iter()
        .filter(|r| r.id != record.id)
        .collect();
    kept.push(record.clone());
    kept.sort_by_key(|r| r.started_at_ms);
    if kept.len() > MAX_RECORDS_PER_OWNER {
        let excess = kept.len() - MAX_RECORDS_PER_OWNER;
        kept.drain(..excess);
    }
    let mut body = String::new();
    for one in &kept {
        body.push_str(&serde_json::to_string(one).map_err(|e| e.to_string())?);
        body.push('\n');
    }
    // Atomic: a half-written listing must not replace a whole one.
    let temp = path.with_extension("jsonl.tmp");
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

/// One owner's records, oldest first. A line that cannot be read is skipped:
/// one damaged record must not hide the rest.
pub fn read_owner(data_folder: &Path, owner: &str) -> Vec<JobRecord> {
    let Ok(body) = std::fs::read_to_string(path_for(data_folder, owner)) else {
        return Vec::new();
    };
    body.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<JobRecord>(line).ok())
        .filter(|r| r.v <= JOB_RECORD_VERSION && r.owner == owner)
        .collect()
}

/// Every owner's records. Used by reconciliation, never by a listing.
fn read_all(data_folder: &Path) -> Vec<(PathBuf, Vec<JobRecord>)> {
    let Ok(entries) = std::fs::read_dir(jobs_dir(data_folder)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "jsonl") {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(&path) else {
            continue;
        };
        let records: Vec<JobRecord> = body
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<JobRecord>(line).ok())
            .collect();
        if !records.is_empty() {
            out.push((path, records));
        }
    }
    out
}

/// Every conversation that has a job record here.
///
/// Read from inside the records rather than from the file names, which are
/// hashes: an owner is never a path component.
pub fn owners(data_folder: &Path) -> Vec<String> {
    let mut out: Vec<String> = read_all(data_folder)
        .into_iter()
        .filter_map(|(_, records)| records.first().map(|r| r.owner.clone()))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Whether the process a record names is still that process.
///
/// Both halves must match. A pid that is gone is gone; a pid that is there
/// with a different creation time is somebody else's, and the only safe answer
/// is that our job is not running.
pub fn still_running(identity: &ProcessIdentity) -> Verdict {
    if !identity.is_checkable() {
        return Verdict::Unknowable;
    }
    match creation_time_of(identity.pid) {
        None => Verdict::Gone,
        // The same process -- but one that has ended while something still
        // holds a handle to it is gone, not alive.
        Some(created) if created == identity.created => {
            if crate::tools::proc::has_exited_pid(identity.pid) == Some(true) {
                Verdict::Gone
            } else {
                Verdict::Alive
            }
        }
        Some(_) => Verdict::Reused,
    }
}

#[cfg(test)]
mod liveness_tests {
    use super::*;

    /// Found by the AH-026 forced-kill exercise: a run killed with `taskkill`
    /// still read as alive, because the test driver held the process's handle
    /// and Windows keeps an ended process's creation time while one is held.
    #[test]
    fn a_process_that_has_ended_is_gone_even_while_its_handle_is_held() {
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd").args(["/c", "exit 0"]).spawn().unwrap();
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap();
        let pid = child.id();
        let identity = ProcessIdentity { pid, created: creation_time_of(pid).expect("a live process has a creation time") };
        // Ended, but `child` still holds it: on Windows its handle is open,
        // on Unix it is an unreaped zombie until `wait`.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let verdict_before_reap = still_running(&identity);
        child.wait().unwrap();
        assert_ne!(verdict_before_reap, Verdict::Alive, "an ended process read as alive");
        assert_ne!(still_running(&identity), Verdict::Alive);
        // A running process is still alive.
        #[cfg(windows)]
        let mut long = std::process::Command::new("cmd").args(["/c", "ping -n 30 127.0.0.1 >NUL"]).spawn().unwrap();
        #[cfg(not(windows))]
        let mut long = std::process::Command::new("sh").args(["-c", "sleep 30"]).spawn().unwrap();
        let live = ProcessIdentity { pid: long.id(), created: creation_time_of(long.id()).unwrap() };
        assert_eq!(still_running(&live), Verdict::Alive);
        let _ = long.kill();
        let _ = long.wait();
    }
}

/// What the operating system says about a recorded pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The same process is still there.
    Alive,
    /// Nothing holds that pid.
    Gone,
    /// Something holds it, but it is not what we started.
    Reused,
    /// The record cannot be checked (no pid, or the host never said when the
    /// process started).
    Unknowable,
}

/// When a process was created, as the host reports it.
#[cfg(windows)]
pub fn creation_time_of(pid: u32) -> Option<u64> {
    crate::tools::proc::creation_time_of_pid(pid)
}

#[cfg(not(windows))]
pub fn creation_time_of(pid: u32) -> Option<u64> {
    // /proc/<pid>/stat field 22 is the process's start time in clock ticks
    // since boot: stable for the life of the process and different for a
    // reused pid, which is all the identity needs.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name can contain spaces and parentheses, so fields are read
    // after the last ')'.
    let rest = stat.rsplit_once(')')?.1;
    rest.split_whitespace().nth(19)?.parse().ok()
}

/// What a restart concludes about every job that said it was running.
///
/// Returns the records it changed. A job is never resurrected and never
/// promoted to `completed`: an ending nobody saw is an interruption.
pub fn reconcile(data_folder: &Path) -> Vec<JobRecord> {
    let mut changed = Vec::new();
    for (path, records) in read_all(data_folder) {
        let mut updated = false;
        let mut out = Vec::with_capacity(records.len());
        for mut record in records {
            if record.state == JobState::Running {
                match still_running(&record.identity) {
                    Verdict::Alive => {}
                    Verdict::Gone => {
                        record.state = JobState::Interrupted;
                        record.ended_at_ms = Some(now_ms());
                        record.note =
                            "the process was gone when the app next looked".to_string();
                        record.identity = ProcessIdentity::default();
                        updated = true;
                        changed.push(record.clone());
                    }
                    Verdict::Reused => {
                        record.state = JobState::Orphaned;
                        record.ended_at_ms = Some(now_ms());
                        record.note =
                            "its process id now belongs to something else, so nothing was assumed about it"
                                .to_string();
                        // Dropped deliberately: nothing may act on it later.
                        record.identity = ProcessIdentity::default();
                        updated = true;
                        changed.push(record.clone());
                    }
                    Verdict::Unknowable => {
                        record.state = JobState::Interrupted;
                        record.ended_at_ms = Some(now_ms());
                        record.note =
                            "the app stopped while it ran, and it cannot be identified again"
                                .to_string();
                        updated = true;
                        changed.push(record.clone());
                    }
                }
            }
            out.push(record);
        }
        if updated {
            let mut body = String::new();
            for one in &out {
                if let Ok(line) = serde_json::to_string(one) {
                    body.push_str(&line);
                    body.push('\n');
                }
            }
            let temp = path.with_extension("jsonl.tmp");
            if std::fs::write(&temp, body).is_ok() {
                let _ = std::fs::rename(&temp, &path);
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-jobs-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn me() -> ProcessIdentity {
        let pid = std::process::id();
        ProcessIdentity {
            pid,
            created: creation_time_of(pid).expect("this process has a creation time"),
        }
    }

    /// A job outlives the app that started it, listed to its owner and to
    /// nobody else, with the command redacted and the provenance kept.
    #[test]
    fn a_job_is_readable_after_the_app_that_started_it() {
        let d = dir("durable");
        let record = JobRecord::started(
            "job-1",
            "session-a",
            "curl -H 'Authorization: Bearer sk-live-abcdef123456' https://example.invalid",
            me(),
        )
        .from_run("session-a#run-1", "session-a#run-1#2", "agent");
        save(&d, &record).expect("saved");
        save(
            &d,
            &JobRecord::started("job-2", "session-b", "echo other", me()),
        )
        .expect("saved");

        let mine = read_owner(&d, "session-a");
        assert_eq!(mine.len(), 1, "{mine:?}");
        assert_eq!(mine[0].id, "job-1");
        assert_eq!(mine[0].run, "session-a#run-1");
        assert!(
            !mine[0].summary.contains("sk-live-abcdef123456"),
            "the command's credential was kept: {}",
            mine[0].summary
        );
        assert!(mine[0].summary.contains("curl"), "{}", mine[0].summary);
        // Another owner's job is not listed at all.
        assert!(read_owner(&d, "session-a").iter().all(|r| r.owner == "session-a"));
        assert_eq!(read_owner(&d, "session-b").len(), 1);
        assert!(read_owner(&d, "session-c").is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A restart says what it can actually tell: this process is alive, a pid
    /// that is gone was interrupted, and a pid that now belongs to something
    /// else is not touched.
    #[test]
    fn a_restart_never_adopts_a_process_it_cannot_identify() {
        let d = dir("reconcile");
        // Alive: this very process, correctly identified.
        save(&d, &JobRecord::started("alive", "s", "sleep", me())).unwrap();
        // Gone: a pid nothing can hold.
        save(
            &d,
            &JobRecord::started(
                "gone",
                "s",
                "sleep",
                ProcessIdentity { pid: u32::MAX - 1, created: 42 },
            ),
        )
        .unwrap();
        // Reused: this process's pid, with somebody else's creation time.
        save(
            &d,
            &JobRecord::started(
                "reused",
                "s",
                "sleep",
                ProcessIdentity { pid: std::process::id(), created: 1 },
            ),
        )
        .unwrap();
        // Unknowable: no pid was ever captured.
        save(
            &d,
            &JobRecord::started("nopid", "s", "sleep", ProcessIdentity::default()),
        )
        .unwrap();

        let changed = reconcile(&d);
        let state = |id: &str| {
            read_owner(&d, "s")
                .into_iter()
                .find(|r| r.id == id)
                .map(|r| (r.state, r.identity.pid, r.note))
                .expect("the record is still there")
        };
        assert_eq!(state("alive").0, JobState::Running, "a live job was written off");
        assert_eq!(state("gone").0, JobState::Interrupted);
        assert_eq!(state("gone").1, 0, "a gone job kept a pid that could be reused");
        let (reused_state, reused_pid, reused_note) = state("reused");
        assert_eq!(reused_state, JobState::Orphaned, "a reused pid was adopted");
        assert_eq!(reused_pid, 0, "a stranger's pid was kept");
        assert!(reused_note.contains("belongs to something else"), "{reused_note}");
        assert_eq!(state("nopid").0, JobState::Interrupted);
        assert_eq!(changed.len(), 3, "{changed:?}");

        // Reconciling again changes nothing: an ending is final.
        assert!(reconcile(&d).is_empty());
        assert_eq!(state("alive").0, JobState::Running);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The listing is bounded, oldest first, and a damaged line does not hide
    /// the rest.
    #[test]
    fn the_record_is_bounded_and_survives_a_damaged_line() {
        let d = dir("bounded");
        for i in 0..(MAX_RECORDS_PER_OWNER + 20) {
            let mut record = JobRecord::started(format!("job-{i}"), "s", "echo", me());
            record.started_at_ms = 1_000 + i as u64;
            record.state = JobState::Completed;
            save(&d, &record).unwrap();
        }
        let kept = read_owner(&d, "s");
        assert_eq!(kept.len(), MAX_RECORDS_PER_OWNER);
        assert_eq!(kept[0].id, "job-20", "the oldest were not the ones dropped");

        // A line from a newer build, and a line that is not a record at all.
        let path = path_for(&d, "s");
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("not a record\n");
        body.push_str("{\"v\":99,\"id\":\"future\",\"owner\":\"s\",\"startedAtMs\":1,\"state\":\"running\"}\n");
        std::fs::write(&path, body).unwrap();
        let after = read_owner(&d, "s");
        assert_eq!(after.len(), MAX_RECORDS_PER_OWNER, "a damaged line hid the rest");
        assert!(after.iter().all(|r| r.id != "future"), "a newer record was read anyway");
        let _ = std::fs::remove_dir_all(&d);
    }
}
