//! Work that outlives the app that started it. AH-101/AH-102.
//!
//! Phase 4 made the *record* of a background job durable; the work itself was
//! still a child of the desktop process and died with it. This is the other
//! half: a job is started as a detached supervisor process, so closing the app
//! leaves it running, and a later app process can find it, read what it has
//! produced, and stop it.
//!
//! ## The shape
//!
//! ```text
//! app  ──spawn(detached)──▶  jan cli job supervise ──spawn──▶  the command
//!                                   │
//!                                   ├─ claim file  (who is running this)
//!                                   ├─ output file (bounded, appended as it runs)
//!                                   └─ job record  (state, exit status, timing)
//! ```
//!
//! The supervisor is what makes an ending *knowable*: a bare detached command
//! that exits while the app is closed leaves nobody to write down that it
//! finished, and the next app process could only ever say "its process is
//! gone" (AH-101's `interrupted`). The supervisor writes the ending.
//!
//! ## Which process, and whose
//!
//! A pid is not an identity -- the operating system reuses them -- so a job is
//! only "ours" when three things agree: the pid, the process's creation time,
//! and a per-job secret. The secret lives in the claim file the supervisor
//! writes; the record keeps only its hash, so nothing that is listed, exported
//! or logged carries it. Adopting a process without all three is precisely the
//! mistake that ends with the harness terminating a stranger's work.
//!
//! ## What is never done
//!
//! * No process is adopted by pid alone.
//! * No job is ever reported `completed` unless a supervisor wrote that ending.
//! * The token is never returned by a listing, never rendered, never exported.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::harness_error::{ErrorKind, HarnessError, Stage};
use crate::job_record::{JobRecord, JobState, ProcessIdentity};

/// How much of a job's output is kept. The tail is what a person reads; a
/// runaway job must not fill the disk with it.
pub const MAX_OUTPUT_BYTES: u64 = 2 * 1024 * 1024;

/// Where a job's claim and output live.
pub fn worker_dir(data_folder: &Path) -> PathBuf {
    crate::job_record::jobs_dir(data_folder).join("worker")
}

fn claim_path(data_folder: &Path, id: &str) -> PathBuf {
    worker_dir(data_folder).join(format!("{id}.claim.json"))
}

/// The file a job's output is appended to, as the supervisor writes it.
pub fn output_path(data_folder: &Path, id: &str) -> PathBuf {
    worker_dir(data_folder).join(format!("{id}.out"))
}

/// What the supervisor writes to say it is the one running this job.
///
/// Read by a later app process to decide whether the job it sees in the record
/// is the process that is actually there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub v: u16,
    pub id: String,
    pub owner: String,
    /// The supervisor's own pid and creation time.
    pub identity: ProcessIdentity,
    /// The job's secret, in plain in this file only. The record keeps its hash.
    pub token: String,
    pub started_at_ms: u64,
}

pub const CLAIM_VERSION: u16 = 1;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A job's secret: enough entropy that it cannot be guessed by something that
/// merely knows the job id.
fn mint_token() -> String {
    let mut seed = format!(
        "{}-{}-{:?}",
        std::process::id(),
        now_ms(),
        std::time::Instant::now()
    );
    // A second reading, so two jobs started in the same millisecond by the
    // same process still differ.
    seed.push_str(&format!("{:?}", std::thread::current().id()));
    hash(&seed)
}

pub fn hash(text: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// What a later process concludes about a job it did not start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attachment {
    /// The supervisor is still there and is the one we started.
    Running,
    /// It ended; the record says how.
    Ended,
    /// Its process is gone and nobody wrote an ending.
    Interrupted,
    /// Something holds that pid, but it is not ours.
    Foreign,
}

/// Whether the job named by `record` is still the process we started.
///
/// All three must agree: the claim's token must hash to what the record kept,
/// and the pid and creation time must be the ones the claim named. Two out of
/// three is a stranger.
pub fn attach(data_folder: &Path, record: &JobRecord) -> Attachment {
    if record.state.is_ended() {
        return Attachment::Ended;
    }
    // Not every job is a supervised one. A `bash` call backgrounded inside the
    // app is a child of the app, with no claim file and no secret, and judging
    // it by a missing claim would declare a running job interrupted -- which
    // is exactly what happened when reconciliation moved into the listing.
    // Such a record is judged the way it was before supervisors existed: by
    // the identity it recorded, and failing that by who wrote it.
    if record.token_hash.trim().is_empty() {
        return match crate::job_record::still_running(&record.identity) {
            crate::job_record::Verdict::Alive => Attachment::Running,
            crate::job_record::Verdict::Reused => Attachment::Foreign,
            crate::job_record::Verdict::Gone => Attachment::Interrupted,
            // No checkable identity. If this process wrote the record, this
            // process would know if the job had ended, so it has not; a record
            // from before this process started is one nobody can vouch for.
            crate::job_record::Verdict::Unknowable => {
                if record.started_at_ms >= process_started_ms() {
                    Attachment::Running
                } else {
                    Attachment::Interrupted
                }
            }
        };
    }
    let Ok(text) = std::fs::read_to_string(claim_path(data_folder, &record.id)) else {
        return Attachment::Interrupted;
    };
    let Ok(claim) = serde_json::from_str::<Claim>(&text) else {
        return Attachment::Interrupted;
    };
    if claim.v > CLAIM_VERSION || claim.id != record.id || claim.owner != record.owner {
        return Attachment::Foreign;
    }
    if hash(&claim.token) != record.token_hash {
        // Somebody wrote a claim for this job that we did not mint.
        return Attachment::Foreign;
    }
    match crate::job_record::still_running(&claim.identity) {
        crate::job_record::Verdict::Alive => Attachment::Running,
        crate::job_record::Verdict::Reused => Attachment::Foreign,
        crate::job_record::Verdict::Gone => Attachment::Interrupted,
        crate::job_record::Verdict::Unknowable => Attachment::Interrupted,
    }
}

/// When this process began, in milliseconds, fixed on first use.
///
/// Used to tell a record this process wrote from one it inherited: the second
/// is the only one a look can honestly call interrupted.
fn process_started_ms() -> u64 {
    static STARTED: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *STARTED.get_or_init(crate::job_record::now_ms)
}

/// Start a job that will outlive this process.
///
/// Returns the record as written. The supervisor is spawned detached: it is
/// not in this process's tree, so nothing that closes this process closes it.
pub fn start(
    data_folder: &Path,
    supervisor: &Path,
    owner: &str,
    command: &str,
    provenance: (&str, &str, &str),
) -> Result<JobRecord, HarnessError> {
    let owner = crate::identity::SessionId::parse(owner)?;
    if command.trim().is_empty() {
        return Err(HarnessError::new(ErrorKind::InvalidInput, "a job needs a command")
            .at(Stage::Job));
    }
    std::fs::create_dir_all(worker_dir(data_folder)).map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("the worker directory is not usable: {e}"))
            .at(Stage::Job)
    })?;
    let id = format!("job-{}-{}", now_ms(), &mint_token()[..8]);
    let token = mint_token();
    let mut record = JobRecord::started(&id, owner.as_str(), command, ProcessIdentity::default())
        .from_run(provenance.0, provenance.1, provenance.2);
    record.token_hash = hash(&token);
    record.output_path = output_path(data_folder, &id).to_string_lossy().to_string();
    crate::job_record::save(data_folder, &record)
        .map_err(|e| HarnessError::new(ErrorKind::Io, e).at(Stage::Job))?;

    // The supervisor is another process entirely: it takes the job's id and
    // its token on the command line and does everything else itself.
    let mut cmd = std::process::Command::new(supervisor);
    cmd.arg("cli")
        .arg("job")
        .arg("supervise")
        .arg("--data")
        .arg(data_folder)
        .arg("--id")
        .arg(&id)
        .arg("--owner")
        .arg(owner.as_str())
        .arg("--token")
        .arg(&token)
        .arg("--command")
        .arg(command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = spawn_detached(&mut cmd).map_err(|e| {
        HarnessError::new(
            ErrorKind::Io,
            format!("the job supervisor could not be started: {e}"),
        )
        .at(Stage::Job)
    })?;
    // The record keeps the supervisor's identity too, so a listing can say
    // something even before the supervisor has written its claim.
    record.identity = ProcessIdentity {
        pid: child.id(),
        created: crate::job_record::creation_time_of(child.id()).unwrap_or(0),
    };
    crate::job_record::save(data_folder, &record)
        .map_err(|e| HarnessError::new(ErrorKind::Io, e).at(Stage::Job))?;
    Ok(record)
}

/// Start a process that does not share this one's fate -- or its handles.
///
/// The second half is the one that is easy to miss. A detached child still
/// inherits whatever inheritable handles this process holds, and on Windows
/// that includes the pipe a caller is capturing this process's output through.
/// The child then holds that pipe open for as long as it runs, so a caller
/// doing the most ordinary thing -- `id=$(jan cli job start ...)` -- waits for
/// the whole job instead of for the id. Which is exactly what "it runs in the
/// background" is supposed to mean.
///
/// So this process's own standard handles are marked non-inheritable across
/// the spawn, and restored afterwards.
#[cfg(windows)]
fn spawn_detached(cmd: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no console to inherit and
    // no group that a Ctrl-C or a parent's teardown reaches.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);

    let handles = unsafe {
        [
            GetStdHandle(STD_INPUT_HANDLE),
            GetStdHandle(STD_OUTPUT_HANDLE),
            GetStdHandle(STD_ERROR_HANDLE),
        ]
    };
    for handle in handles {
        if !handle.is_null() {
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        }
    }
    let spawned = cmd.spawn();
    for handle in handles {
        if !handle.is_null() {
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
        }
    }
    spawned
}

#[cfg(not(windows))]
fn spawn_detached(cmd: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    // A session of its own, so a terminal hang-up or the parent's exit does
    // not reach it. The stdio is already NUL, so there is nothing of this
    // process's to hold open.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()
}

/// Run one job to its end, writing down what happened. The supervisor's body.
///
/// Runs in its own process. Everything it writes is what a later app process
/// reads: the claim while it runs, the output as it is produced, and the
/// record's ending when it is over.
pub fn supervise(
    data_folder: &Path,
    id: &str,
    owner: &str,
    token: &str,
    command: &str,
) -> Result<JobState, HarnessError> {
    use std::io::Write;
    let job = crate::identity::JobId::parse(id)?;
    let owner = crate::identity::SessionId::parse(owner)?;
    std::fs::create_dir_all(worker_dir(data_folder)).map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("the worker directory is not usable: {e}"))
            .at(Stage::Job)
    })?;

    let shell = crate::tools::proc::shell();
    let mut cmd = std::process::Command::new(&shell.program);
    cmd.args(&shell.args)
        .arg(command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("the job could not be started: {e}")).at(Stage::Job)
    })?;

    // The claim: what a later process checks this job against.
    let claim = Claim {
        v: CLAIM_VERSION,
        id: job.as_str().to_string(),
        owner: owner.as_str().to_string(),
        identity: ProcessIdentity {
            pid: std::process::id(),
            created: crate::job_record::creation_time_of(std::process::id()).unwrap_or(0),
        },
        token: token.to_string(),
        started_at_ms: now_ms(),
    };
    let _ = std::fs::write(
        claim_path(data_folder, job.as_str()),
        serde_json::to_string(&claim).unwrap_or_default(),
    );
    // The job is this supervisor's child, so stopping the supervisor's tree
    // stops the work -- which is what cancel does.
    if let Some(mut record) = find(data_folder, owner.as_str(), job.as_str()) {
        record.identity = claim.identity;
        record.state = JobState::Running;
        let _ = crate::job_record::save(data_folder, &record);
    }

    let out = output_path(data_folder, job.as_str());
    let mut sink = std::fs::File::create(&out).map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("the job's output file is not usable: {e}"))
            .at(Stage::Job)
    })?;
    let mut written = 0u64;
    let mut pump = |mut reader: Box<dyn std::io::Read + Send>, sink: &mut std::fs::File, written: &mut u64| {
        let mut buffer = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buffer) {
            if n == 0 {
                break;
            }
            if *written >= MAX_OUTPUT_BYTES {
                continue;
            }
            let room = (MAX_OUTPUT_BYTES - *written).min(n as u64) as usize;
            let _ = sink.write_all(&buffer[..room]);
            let _ = sink.flush();
            *written += room as u64;
        }
    };
    // Both streams, in order of arrival, into one file: what a person reads is
    // what the command printed.
    let stdout = child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>);
    let stderr = child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>);
    let sink_path = out.clone();
    let err_thread = stderr.map(|reader| {
        std::thread::spawn(move || {
            if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&sink_path) {
                let mut count = 0u64;
                let mut pump_err = |mut reader: Box<dyn std::io::Read + Send>| {
                    let mut buffer = [0u8; 8192];
                    while let Ok(n) = reader.read(&mut buffer) {
                        if n == 0 || count >= MAX_OUTPUT_BYTES {
                            break;
                        }
                        let _ = file.write_all(&buffer[..n]);
                        let _ = file.flush();
                        count += n as u64;
                    }
                };
                pump_err(reader);
            }
        })
    });
    if let Some(reader) = stdout {
        pump(reader, &mut sink, &mut written);
    }
    if let Some(handle) = err_thread {
        let _ = handle.join();
    }

    let status = child.wait().map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("the job could not be waited on: {e}")).at(Stage::Job)
    })?;
    let state = if status.success() { JobState::Completed } else { JobState::Failed };
    if let Some(mut record) = find(data_folder, owner.as_str(), job.as_str()) {
        // A job cancelled while it ran keeps that ending: the record is the
        // first ending written, not the last.
        if !record.state.is_ended() {
            record.state = state;
            record.exit_code = status.code();
            record.ended_at_ms = Some(now_ms());
            record.identity = ProcessIdentity::default();
            let _ = crate::job_record::save(data_folder, &record);
        }
    }
    let _ = std::fs::remove_file(claim_path(data_folder, job.as_str()));
    Ok(state)
}

/// One job of one owner, by id.
pub fn find(data_folder: &Path, owner: &str, id: &str) -> Option<JobRecord> {
    crate::job_record::read_owner(data_folder, owner)
        .into_iter()
        .find(|r| r.id == id)
}

/// What a job has produced so far, from the end. Bounded: a caller asking for
/// a job's output is asking what it is doing, not for an archive.
pub fn output(data_folder: &Path, owner: &str, id: &str, max_bytes: usize) -> Result<String, HarnessError> {
    let Some(_record) = find(data_folder, owner, id) else {
        return Err(HarnessError::new(ErrorKind::NotFound, format!("no job {id:?} in this conversation"))
            .at(Stage::Job));
    };
    let path = output_path(data_folder, id);
    let bytes = std::fs::read(&path).unwrap_or_default();
    let start = bytes.len().saturating_sub(max_bytes);
    Ok(String::from_utf8_lossy(&bytes[start..]).to_string())
}

/// Stop one job, and only that job.
///
/// The supervisor's tree is what gets stopped, which is the job's own work and
/// nothing else -- and only after the claim proves the process is the one this
/// record names.
pub fn cancel(data_folder: &Path, owner: &str, id: &str) -> Result<JobState, HarnessError> {
    let Some(mut record) = find(data_folder, owner, id) else {
        return Err(HarnessError::new(ErrorKind::NotFound, format!("no job {id:?} in this conversation"))
            .at(Stage::Job));
    };
    if record.state.is_ended() {
        return Ok(record.state);
    }
    let attachment = attach(data_folder, &record);
    match attachment {
        Attachment::Running => {
            let claim: Option<Claim> = std::fs::read_to_string(claim_path(data_folder, id))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok());
            if let Some(claim) = claim {
                crate::tools::proc::kill_tree(claim.identity.pid);
            }
            record.state = JobState::Cancelled;
            record.note = "stopped on request, with the work it was running".to_string();
        }
        Attachment::Ended => return Ok(record.state),
        Attachment::Interrupted => {
            record.state = JobState::Interrupted;
            record.note = "its supervisor was gone when the stop was asked for".to_string();
        }
        Attachment::Foreign => {
            // Nothing is signalled: the pid is not ours to stop.
            record.state = JobState::Orphaned;
            record.note =
                "its process id belongs to something else, so nothing was signalled".to_string();
        }
    }
    record.ended_at_ms = Some(now_ms());
    record.identity = ProcessIdentity::default();
    crate::job_record::save(data_folder, &record)
        .map_err(|e| HarnessError::new(ErrorKind::Io, e).at(Stage::Job))?;
    let _ = std::fs::remove_file(claim_path(data_folder, id));
    Ok(record.state)
}

/// Settle what an earlier process left, using the claims as well as the pids.
///
/// Returns the records it changed. A job whose supervisor is still there is
/// left alone -- that is the whole point.
pub fn reconcile(data_folder: &Path, owner: &str) -> Vec<JobRecord> {
    let mut changed = Vec::new();
    for mut record in crate::job_record::read_owner(data_folder, owner) {
        if record.state.is_ended() {
            continue;
        }
        match attach(data_folder, &record) {
            Attachment::Running => {}
            Attachment::Ended => {}
            Attachment::Interrupted => {
                record.state = JobState::Interrupted;
                record.note = "its supervisor was gone when the app next looked".to_string();
                record.ended_at_ms = Some(now_ms());
                record.identity = ProcessIdentity::default();
                let _ = crate::job_record::save(data_folder, &record);
                changed.push(record);
            }
            Attachment::Foreign => {
                record.state = JobState::Orphaned;
                record.note = "its claim does not match this job, so nothing was assumed".to_string();
                record.ended_at_ms = Some(now_ms());
                record.identity = ProcessIdentity::default();
                let _ = crate::job_record::save(data_folder, &record);
                changed.push(record);
            }
        }
    }
    changed
}

/// Settle every conversation's jobs after a restart (AH-101).
///
/// A job whose supervisor is still there is left running -- that is the point
/// of the supervisor. Everything else is settled honestly.
pub fn reconcile_all(data_folder: &Path) -> Vec<JobRecord> {
    crate::job_record::owners(data_folder)
        .into_iter()
        .flat_map(|owner| reconcile(data_folder, &owner))
        .collect()
}

/// The binary that supervises a job.
///
/// The desktop app cannot supervise: it is a window, and the point is that the
/// work outlives it. The CLI binary, which ships beside it, can -- so it is
/// looked for next to whatever is running. Naming what is missing is the whole
/// value of this returning an error rather than a guess.
pub fn supervisor_binary() -> Result<PathBuf, HarnessError> {
    let exe = std::env::current_exe().map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("this process has no path: {e}")).at(Stage::Job)
    })?;
    let name = if cfg!(windows) { "jan.exe" } else { "jan" };
    // This binary itself, when it is already the CLI.
    if exe.file_name().is_some_and(|f| f == name) {
        return Ok(exe);
    }
    let beside = exe.with_file_name(name);
    if beside.exists() {
        return Ok(beside);
    }
    Err(HarnessError::new(
        ErrorKind::ToolUnavailable,
        format!(
            "background work needs the {name} command line beside the app, and it is not at {}",
            beside.display()
        ),
    )
    .at(Stage::Job))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-worker-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn record_with_claim(d: &Path, owner: &str, id: &str, token: &str, identity: ProcessIdentity) -> JobRecord {
        let mut record = JobRecord::started(id, owner, "sleep", identity);
        record.token_hash = hash(token);
        crate::job_record::save(d, &record).unwrap();
        std::fs::create_dir_all(worker_dir(d)).unwrap();
        let claim = Claim {
            v: CLAIM_VERSION,
            id: id.to_string(),
            owner: owner.to_string(),
            identity,
            token: token.to_string(),
            started_at_ms: 1,
        };
        std::fs::write(claim_path(d, id), serde_json::to_string(&claim).unwrap()).unwrap();
        record
    }

    fn me() -> ProcessIdentity {
        let pid = std::process::id();
        ProcessIdentity {
            pid,
            created: crate::job_record::creation_time_of(pid).expect("a creation time"),
        }
    }

    /// A job is ours only when the pid, the creation time and the secret all
    /// agree. Two out of three is a stranger.
    #[test]
    fn a_job_is_only_ours_when_all_three_agree() {
        let d = dir("attach");
        let mine = record_with_claim(&d, "s", "job-mine", "secret-one", me());
        assert_eq!(attach(&d, &mine), Attachment::Running);

        // The claim's token is not the one the record was minted with.
        let mut forged = record_with_claim(&d, "s", "job-forged", "secret-two", me());
        forged.token_hash = hash("a different secret");
        crate::job_record::save(&d, &forged).unwrap();
        assert_eq!(attach(&d, &forged), Attachment::Foreign, "a forged claim was adopted");

        // The pid is alive but was not the one that claimed the job.
        let reused = record_with_claim(
            &d,
            "s",
            "job-reused",
            "secret-three",
            ProcessIdentity { pid: std::process::id(), created: 1 },
        );
        assert_eq!(attach(&d, &reused), Attachment::Foreign, "a reused pid was adopted");

        // No claim at all: nobody is running it.
        let mut orphan = JobRecord::started("job-orphan", "s", "sleep", me());
        orphan.token_hash = hash("secret-four");
        crate::job_record::save(&d, &orphan).unwrap();
        assert_eq!(attach(&d, &orphan), Attachment::Interrupted);

        // An ending is final, whatever the claim says.
        let mut ended = mine.clone();
        ended.state = JobState::Completed;
        crate::job_record::save(&d, &ended).unwrap();
        assert_eq!(attach(&d, &ended), Attachment::Ended);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Reconciling settles what nobody is running, and leaves alone what
    /// somebody is.
    #[test]
    fn reconciling_leaves_a_live_job_alone() {
        let d = dir("reconcile");
        record_with_claim(&d, "s", "job-live", "t1", me());
        let mut gone = JobRecord::started("job-gone", "s", "sleep", ProcessIdentity { pid: u32::MAX - 2, created: 9 });
        gone.token_hash = hash("t2");
        crate::job_record::save(&d, &gone).unwrap();

        let changed = reconcile(&d, "s");
        assert_eq!(changed.len(), 1, "{changed:?}");
        assert_eq!(changed[0].id, "job-gone");
        assert_eq!(changed[0].state, JobState::Interrupted);
        assert_eq!(changed[0].identity.pid, 0, "a settled job kept a pid");
        assert_eq!(
            find(&d, "s", "job-live").unwrap().state,
            JobState::Running,
            "a live job was written off"
        );
        // Twice changes nothing more.
        assert!(reconcile(&d, "s").is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A job of another conversation is not found, and nothing is signalled
    /// for it.
    #[test]
    fn another_conversations_job_is_not_cancellable() {
        let d = dir("owner");
        record_with_claim(&d, "mine", "job-1", "t", me());
        let refusal = cancel(&d, "theirs", "job-1").expect_err("must refuse");
        assert_eq!(refusal.kind(), ErrorKind::NotFound);
        assert_eq!(find(&d, "mine", "job-1").unwrap().state, JobState::Running);
        // And the output of a job that is not theirs is not readable either.
        assert_eq!(
            output(&d, "theirs", "job-1", 1024).unwrap_err().kind(),
            ErrorKind::NotFound
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The secret never leaves the claim: not in the record, not in a listing.
    #[test]
    fn the_token_is_not_in_anything_that_is_listed() {
        let d = dir("secret");
        record_with_claim(&d, "s", "job-1", "the-actual-secret", me());
        let listed = crate::job_record::read_owner(&d, "s");
        let json = serde_json::to_string(&listed).unwrap();
        assert!(
            !json.contains("the-actual-secret"),
            "the token is in what a listing returns: {json}"
        );
        assert!(json.contains("tokenHash") || !json.contains("token"), "{json}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
