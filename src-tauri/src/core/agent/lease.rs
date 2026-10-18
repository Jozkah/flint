//! A run's lease: one process drives a run at a time, and a dead one can be
//! replaced.
//!
//! `inflight.json` already says which process is writing a thread, but it is a
//! check-then-write: two processes that look at the same moment both see no
//! writer and both start. It also cannot tell a writer that is frozen from one
//! that is working, and it says nothing to a process that has been replaced
//! while it was paused.
//!
//! The lease is `lease.json` in the run's directory:
//!
//! * **Taken atomically.** It is created with `create_new`, so of two
//!   processes that race for a free run exactly one succeeds.
//! * **Kept by heartbeat.** The holder rewrites it every `ttl / 3`. A lease
//!   whose heartbeat is older than `ttl` has expired, whatever the holder's
//!   process looks like from outside.
//! * **Gone with its holder.** A lease whose process no longer exists (or is a
//!   different process that reused the pid) is taken over at once, without
//!   waiting out the ttl: a crashed run does not block its own resume.
//! * **Taken over safely.** The stale file is first renamed aside, which only
//!   one taker can do, and then the new lease is created. A taker that loses
//!   either step reports the run as held.
//! * **Lost loudly.** Every heartbeat re-reads the file and checks the token
//!   that this holder wrote. A holder that finds another token (it was frozen
//!   past the ttl and replaced) marks itself lost, stops the run's scope and
//!   the run ends as `lease_lost` instead of two processes writing one thread.
//! * **Not lost by a hiccup.** Only a different token counts as a takeover. A
//!   heartbeat that cannot be written (an antivirus lock, a full disk) is
//!   logged and retried on the next tick; the holder gives up, with its own
//!   error, only once the last good heartbeat is older than the ttl, which is
//!   when another process may legitimately take the run.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

const FILE: &str = "lease.json";
const VERSION: u16 = 1;

/// How long a lease survives without a heartbeat.
pub const DEFAULT_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub v: u16,
    pub run_id: String,
    /// Written by the holder and checked on every heartbeat; whoever finds a
    /// different token in the file is no longer the holder.
    pub token: String,
    pub pid: u32,
    /// The holder's process creation time, so a reused pid is not the holder.
    pub created: u64,
    pub acquired_ms: u64,
    pub heartbeat_ms: u64,
    pub ttl_ms: u64,
}

impl Record {
    fn expired(&self, now_ms: u64) -> bool {
        now_ms.saturating_sub(self.heartbeat_ms) > self.ttl_ms
    }
}

/// Where a lease file is for a run directory.
pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether the process that wrote `record` is still there. A holder that
/// cannot be checked counts as alive: only the heartbeat can expire it then.
fn holder_alive(record: &Record) -> bool {
    use tauri_plugin_agent_tools::job_record::{still_running, ProcessIdentity, Verdict};
    !matches!(
        still_running(&ProcessIdentity { pid: record.pid, created: record.created }),
        Verdict::Gone | Verdict::Reused
    )
}

fn io(e: std::io::Error, what: &str) -> HarnessError {
    HarnessError::new(ErrorKind::Io, format!("the run lease {what}: {e}")).at(Stage::Persistence)
}

fn held(record: &Record) -> HarnessError {
    HarnessError::new(
        ErrorKind::InvalidInput,
        format!(
            "this session is still being run by process {} (run {}); wait for it or stop it first",
            record.pid, record.run_id
        ),
    )
    .at(Stage::Startup)
}

/// The lease on a run, held by this process.
pub struct Lease {
    file: PathBuf,
    token: String,
    run_id: String,
    ttl: Duration,
    lost: Arc<AtomicBool>,
    /// When the file was last renewed (or taken), for judging a failing write.
    last_ok_ms: AtomicU64,
    writer: Writer,
}

type Writer = Box<dyn Fn(&Path, &Record) -> std::io::Result<()> + Send + Sync>;

/// What a lease file says right now, for a reader that does not hold it.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// No lease, or one that has expired or whose holder is gone.
    Free,
    /// Held by a live process whose heartbeat is current.
    Held(Record),
}

/// The state of `dir`'s lease, without taking it.
pub fn status(dir: &Path) -> Status {
    status_at(dir, now_ms(), &holder_alive)
}

fn status_at(dir: &Path, now: u64, alive: &dyn Fn(&Record) -> bool) -> Status {
    match read(&path(dir)) {
        Some(record) if !record.expired(now) && alive(&record) => Status::Held(record),
        _ => Status::Free,
    }
}

fn read(file: &Path) -> Option<Record> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

impl Lease {
    /// Take the lease on `run_id` in `dir`, or fail because a live process
    /// holds it.
    pub fn acquire(dir: &Path, run_id: &str) -> Result<Lease, HarnessError> {
        Self::acquire_with(dir, run_id, DEFAULT_TTL, now_ms(), &holder_alive)
    }

    /// [`Self::acquire`] with the clock, the ttl and the liveness probe given,
    /// so expiry and takeover are testable without waiting or killing anything.
    pub fn acquire_with(
        dir: &Path,
        run_id: &str,
        ttl: Duration,
        now: u64,
        alive: &dyn Fn(&Record) -> bool,
    ) -> Result<Lease, HarnessError> {
        std::fs::create_dir_all(dir).map_err(|e| io(e, "directory could not be made"))?;
        let file = path(dir);
        let token = uuid::Uuid::new_v4().to_string();
        let (pid, created) = {
            let pid = std::process::id();
            (pid, tauri_plugin_agent_tools::job_record::creation_time_of(pid).unwrap_or(0))
        };
        let record = Record {
            v: VERSION,
            run_id: run_id.to_string(),
            token: token.clone(),
            pid,
            created,
            acquired_ms: now,
            heartbeat_ms: now,
            ttl_ms: ttl.as_millis() as u64,
        };
        let lease = Lease {
            file: file.clone(),
            token,
            run_id: run_id.to_string(),
            ttl,
            lost: Arc::new(AtomicBool::new(false)),
            last_ok_ms: AtomicU64::new(now),
            writer: Box::new(write_atomic),
        };

        // At most one retry: a fresh file is created, or a stale one is moved
        // aside and a fresh file is created in its place.
        for _ in 0..2 {
            match create_new(&file, &record) {
                Ok(()) => return Ok(lease),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(io(e, "could not be created")),
            }
            let mut judged: Option<String> = None;
            match read(&file) {
                Some(current) if !current.expired(now) && alive(&current) => return Err(held(&current)),
                Some(current) => judged = Some(current.token),
                // Unreadable: another taker may be between create and write,
                // so a file that is recent is treated as held, an old one as
                // debris.
                None => {
                    let young = std::fs::metadata(&file)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age < ttl);
                    if young {
                        return Err(HarnessError::new(
                            ErrorKind::InvalidInput,
                            "this session's run lease is being written by another process; try again in a moment",
                        )
                        .at(Stage::Startup));
                    }
                }
            }
            // Only one process can rename the stale file away; the others
            // find it gone and lose the race cleanly on the next create.
            let aside = file.with_extension(format!("json.stale-{}", &lease.token[..8]));
            match std::fs::rename(&file, &aside) {
                Ok(()) => {
                    // Between judging the file stale and moving it, another
                    // taker may have replaced it: what was moved is then a
                    // live lease. Put it back rather than destroy it.
                    let moved = read(&aside).map(|r| r.token);
                    if judged.is_some() && moved.is_some() && moved != judged {
                        if std::fs::rename(&aside, &file).is_err() {
                            let _ = std::fs::remove_file(&aside);
                        }
                        return Err(HarnessError::new(
                            ErrorKind::InvalidInput,
                            "this session's run lease was taken by another process while this one was starting",
                        )
                        .at(Stage::Startup));
                    }
                    let _ = std::fs::remove_file(&aside);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io(e, "stale lease could not be replaced")),
            }
        }
        Err(HarnessError::new(
            ErrorKind::InvalidInput,
            "this session's run lease was taken by another process while this one was starting",
        )
        .at(Stage::Startup))
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Whether a heartbeat has found the lease taken by someone else.
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }

    /// Renew the lease. Errors with `LeaseLost` when the file no longer carries
    /// this holder's token (replaced, or deleted), and records the loss. A file
    /// that cannot be read or written right now is an `Io` error instead: the
    /// lease is not known to be lost.
    pub fn heartbeat(&self) -> Result<(), HarnessError> {
        self.heartbeat_at(now_ms())
    }

    pub(crate) fn heartbeat_at(&self, now: u64) -> Result<(), HarnessError> {
        let bytes = match std::fs::read(&self.file) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(self.hiccup(e, "could not be read", now)),
        };
        let Some(mut record) = bytes
            .and_then(|b| serde_json::from_slice::<Record>(&b).ok())
            .filter(|r| r.token == self.token)
        else {
            return Err(self.lose());
        };
        // Past the ttl since the last good renewal the lease is fair game: a
        // taker may be replacing the file right now, and a read-then-write
        // here could overwrite the taker's lease. Never write; the holder
        // gives up as unrefreshed (see `keep_alive`).
        if self.refresh_overdue(now) {
            return Err(self.hiccup(
                std::io::Error::other("the last renewal is older than the ttl"),
                "could not be renewed",
                now,
            ));
        }
        record.heartbeat_ms = now;
        match (self.writer)(&self.file, &record) {
            Ok(()) => {
                self.last_ok_ms.store(now, Ordering::SeqCst);
                Ok(())
            }
            Err(e) => Err(self.hiccup(e, "could not be renewed", now)),
        }
    }

    fn lose(&self) -> HarnessError {
        self.lost.store(true, Ordering::SeqCst);
        HarnessError::new(
            ErrorKind::LeaseLost,
            format!(
                "another process took over run {}: this process lost its lease and stopped driving it",
                self.run_id
            ),
        )
        .at(Stage::Persistence)
    }

    /// A failed read or write of the lease file. Past the ttl since the last
    /// good heartbeat it says so plainly; before that it is a passing error.
    fn hiccup(&self, e: std::io::Error, what: &str, now: u64) -> HarnessError {
        if self.refresh_overdue(now) {
            HarnessError::new(
                ErrorKind::Io,
                format!(
                    "could not refresh the lease on run {} (io error): {e}; another process may now take it",
                    self.run_id
                ),
            )
            .at(Stage::Persistence)
        } else {
            io(e, what)
        }
    }

    /// Whether the last good heartbeat is older than the ttl.
    fn refresh_overdue(&self, now: u64) -> bool {
        now.saturating_sub(self.last_ok_ms.load(Ordering::SeqCst)) > self.ttl.as_millis() as u64
    }

    /// Give the lease up. Only removes the file when it is still this
    /// holder's, so a late release never frees a lease someone else now owns.
    pub fn release(&self) {
        if read(&self.file).is_some_and(|r| r.token == self.token) {
            let _ = std::fs::remove_file(&self.file);
        }
    }

    /// Renew the lease from a thread of its own until the returned guard is
    /// dropped. On loss, the run in `session` is stopped and the loss is
    /// remembered for [`take_lost`].
    pub fn keep_alive(self: &Arc<Self>, session: &str) -> HeartbeatGuard {
        let stop = Arc::new(AtomicBool::new(false));
        let lease = self.clone();
        let stop_flag = stop.clone();
        let session = session.to_string();
        let every = (self.ttl / 3).max(Duration::from_millis(10));
        let handle = std::thread::spawn(move || {
            let step = Duration::from_millis(10).min(every);
            let mut waited = Duration::ZERO;
            while !stop_flag.load(Ordering::SeqCst) {
                std::thread::sleep(step);
                waited += step;
                if waited < every {
                    continue;
                }
                waited = Duration::ZERO;
                match lease.heartbeat() {
                    Ok(()) => {}
                    Err(e) if e.kind() == ErrorKind::LeaseLost => {
                        mark_lost(&session);
                        break;
                    }
                    Err(e) => {
                        // Not a takeover: keep going until the ttl runs out.
                        log::warn!("agent: lease heartbeat failed for {session}: {}", e.message());
                        if lease.refresh_overdue(now_ms()) {
                            mark_unrefreshed(&session);
                            break;
                        }
                    }
                }
            }
        });
        HeartbeatGuard { stop, handle: Some(handle), lease: self.clone() }
    }
}

/// Stops the heartbeat and releases the lease when dropped.
pub struct HeartbeatGuard {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
    lease: Arc<Lease>,
}

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        self.lease.release();
    }
}

fn create_new(file: &Path, record: &Record) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(file)?;
    let body = serde_json::to_vec(record).map_err(std::io::Error::other)?;
    f.write_all(&body)?;
    f.sync_all()
}

fn write_atomic(file: &Path, record: &Record) -> std::io::Result<()> {
    let tmp = file.with_extension(format!("json.tmp-{}", &record.token[..8]));
    let result = std::fs::write(&tmp, serde_json::to_vec(record).map_err(std::io::Error::other)?)
        .and_then(|()| std::fs::rename(&tmp, file));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Sessions whose lease was found lost, so the loop can end their run as
/// `lease_lost` rather than as the cancellation the stop looks like.
fn lost_sessions() -> &'static Mutex<std::collections::HashSet<String>> {
    static LOST: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    LOST.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Sessions that gave up because the lease could not be written for longer
/// than its ttl: nobody took it, so the run must not say anyone did.
fn unrefreshed_sessions() -> &'static Mutex<std::collections::HashSet<String>> {
    static GONE: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    GONE.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Remember that `session` could not refresh its lease in time and stop its run.
pub fn mark_unrefreshed(session: &str) {
    if let Ok(mut set) = unrefreshed_sessions().lock() {
        set.insert(session.to_string());
    }
    tauri_plugin_agent_tools::lifecycle::stop_scope(
        &tauri_plugin_agent_tools::lifecycle::Scope::new(session, "", ""),
        tauri_plugin_agent_tools::lifecycle::StopReason::Cancelled,
    );
}

/// Whether `session` stopped because its lease could not be refreshed,
/// forgetting it like [`take_lost`].
pub fn take_unrefreshed(session: &str) -> bool {
    unrefreshed_sessions().lock().map(|mut set| set.remove(session)).unwrap_or(false)
}

/// Remember that `session` lost its lease and stop its run.
pub fn mark_lost(session: &str) {
    if let Ok(mut set) = lost_sessions().lock() {
        set.insert(session.to_string());
    }
    tauri_plugin_agent_tools::lifecycle::stop_scope(
        &tauri_plugin_agent_tools::lifecycle::Scope::new(session, "", ""),
        tauri_plugin_agent_tools::lifecycle::StopReason::Cancelled,
    );
}

/// Whether `session` lost its lease, forgetting it so a later run of the same
/// session starts clean.
pub fn take_lost(session: &str) -> bool {
    lost_sessions().lock().map(|mut set| set.remove(session)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: Duration = Duration::from_secs(30);

    fn always(_: &Record) -> bool {
        true
    }
    fn never(_: &Record) -> bool {
        false
    }

    #[test]
    fn a_second_acquire_is_refused_while_the_first_is_live() {
        let dir = tempfile::tempdir().unwrap();
        let first = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        let err = Lease::acquire_with(dir.path(), "run-2", TTL, 2_000, &always).err().expect("refused");
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(err.message().contains("still being run by process"), "{}", err.message());
        // The refused taker changed nothing.
        assert!(first.heartbeat_at(3_000).is_ok());
    }

    #[test]
    fn a_lease_whose_heartbeat_stopped_expires_and_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let stale = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        // 30s and one millisecond past the last heartbeat.
        let now = 1_000 + TTL.as_millis() as u64 + 1;
        let fresh = Lease::acquire_with(dir.path(), "run-1", TTL, now, &always).expect("taken over");
        assert_ne!(fresh.token, stale.token);
        // The replaced holder learns it on its next heartbeat and does not
        // overwrite the new holder's lease.
        let err = stale.heartbeat_at(now + 1).expect_err("lost");
        assert_eq!(err.kind(), ErrorKind::LeaseLost);
        assert!(stale.is_lost());
        assert!(fresh.heartbeat_at(now + 2).is_ok());
        // ... and its late release leaves the new holder's lease alone.
        stale.release();
        assert!(matches!(status_at(dir.path(), now + 3, &always), Status::Held(r) if r.token == fresh.token));
    }

    #[test]
    fn a_holder_resuming_past_the_ttl_does_not_write_over_a_taker() {
        let dir = tempfile::tempdir().unwrap();
        let stalled = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        let late = 1_000 + TTL.as_millis() as u64 + 1;
        let before = std::fs::read(&stalled.file).unwrap();
        // Still its own token on disk, but too late to renew safely.
        let err = stalled.heartbeat_at(late).expect_err("overdue");
        assert_eq!(err.kind(), ErrorKind::Io);
        assert!(err.message().contains("could not refresh the lease"), "{}", err.message());
        assert_eq!(std::fs::read(&stalled.file).unwrap(), before, "a late heartbeat wrote");
    }

    #[test]
    fn a_crashed_holder_is_replaced_without_waiting_out_the_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let _crashed = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        // One second later, with the holder's process gone.
        let next = Lease::acquire_with(dir.path(), "run-1", TTL, 2_000, &never);
        assert!(next.is_ok(), "{:?}", next.err().map(|e| e.message().to_string()));
    }

    #[test]
    fn a_heartbeat_keeps_a_lease_from_expiring() {
        let dir = tempfile::tempdir().unwrap();
        let held = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        held.heartbeat_at(25_000).unwrap();
        // 40s after acquiring, but 15s after the last heartbeat.
        let err = Lease::acquire_with(dir.path(), "run-1", TTL, 40_000, &always).err().expect("still held");
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn release_frees_the_run_and_a_deleted_lease_reads_as_lost() {
        let dir = tempfile::tempdir().unwrap();
        let first = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        first.release();
        assert_eq!(status_at(dir.path(), 1_001, &always), Status::Free);
        let second = Lease::acquire_with(dir.path(), "run-1", TTL, 1_002, &always).unwrap();
        std::fs::remove_file(path(dir.path())).unwrap();
        assert_eq!(second.heartbeat_at(1_003).err().map(|e| e.kind()), Some(ErrorKind::LeaseLost));
    }

    #[test]
    fn a_garbled_lease_is_debris_once_it_is_old_and_held_while_it_is_young() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), b"{not json").unwrap();
        // Just written: another taker may be mid-write.
        assert!(Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).is_err());
        // With a ttl of zero the same file is already old.
        assert!(Lease::acquire_with(dir.path(), "run-1", Duration::ZERO, 1_000, &always).is_ok());
    }

    #[test]
    fn racing_acquirers_produce_exactly_one_holder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || {
                    Lease::acquire_with(&path, &format!("run-{i}"), TTL, 1_000, &always).map(|l| l.token.clone())
                })
            })
            .collect();
        let winners = handles.into_iter().filter_map(|h| h.join().unwrap().ok()).count();
        assert_eq!(winners, 1);
    }

    #[test]
    fn a_replaced_holder_stops_its_run_and_is_reported_lost() {
        let dir = tempfile::tempdir().unwrap();
        let lease = Arc::new(Lease::acquire_with(dir.path(), "run-1", Duration::from_millis(60), now_ms(), &always).unwrap());
        let session = "lease-test-session";
        let token = tauri_plugin_agent_tools::lifecycle::Token::new(tauri_plugin_agent_tools::lifecycle::Scope::new(session, "r", "c"));
        let _registered = tauri_plugin_agent_tools::lifecycle::register(token.clone());
        let guard = lease.keep_alive(session);
        // Someone replaces the file with their own lease.
        let mut other = read(&path(dir.path())).unwrap();
        other.token = "someone-else".into();
        std::fs::write(path(dir.path()), serde_json::to_vec(&other).unwrap()).unwrap();
        for _ in 0..200 {
            if take_lost_peek(session) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(token.is_stopped(), "the run was not stopped");
        assert!(lease.is_lost());
        assert!(take_lost(session));
        assert!(!take_lost(session), "forgotten once taken");
        drop(guard);
        // The replacement's file is still there: the lost holder did not delete it.
        assert!(path(dir.path()).exists());
    }

    fn with_writer(lease: &mut Lease, w: Writer) {
        lease.writer = w;
    }

    #[test]
    fn a_transient_write_error_is_not_a_lost_lease_and_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let mut lease = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        let fail = Arc::new(AtomicBool::new(true));
        let f = fail.clone();
        with_writer(
            &mut lease,
            Box::new(move |file, rec| {
                if f.load(Ordering::SeqCst) {
                    Err(std::io::Error::from_raw_os_error(32)) // file in use
                } else {
                    write_atomic(file, rec)
                }
            }),
        );
        let err = lease.heartbeat_at(2_000).expect_err("write failed");
        assert_eq!(err.kind(), ErrorKind::Io);
        assert!(!lease.is_lost(), "an I/O error is not a takeover");
        assert!(!err.message().contains("could not refresh"), "{}", err.message());
        // The next tick works and the lease is still ours.
        fail.store(false, Ordering::SeqCst);
        lease.heartbeat_at(12_000).unwrap();
        assert!(!lease.is_lost());
        assert_eq!(read(&path(dir.path())).unwrap().heartbeat_ms, 12_000);
    }

    #[test]
    fn a_write_that_keeps_failing_past_the_ttl_is_reported_as_an_io_error_not_a_takeover() {
        let dir = tempfile::tempdir().unwrap();
        let mut lease = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        with_writer(&mut lease, Box::new(|_, _| Err(std::io::Error::from_raw_os_error(112))));
        let past = 1_000 + TTL.as_millis() as u64 + 1;
        let err = lease.heartbeat_at(past).expect_err("overdue");
        assert_eq!(err.kind(), ErrorKind::Io);
        assert!(err.message().contains("could not refresh the lease"), "{}", err.message());
        assert!(!err.message().contains("took over run"), "{}", err.message());
        assert!(!lease.is_lost());
    }

    #[test]
    fn a_heartbeat_thread_survives_write_errors_and_gives_up_distinctly_after_the_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let mut lease = Lease::acquire_with(dir.path(), "run-1", Duration::from_millis(300), now_ms(), &always).unwrap();
        with_writer(&mut lease, Box::new(|_, _| Err(std::io::Error::other("locked"))));
        let lease = Arc::new(lease);
        let session = "lease-test-hiccup";
        let guard = lease.keep_alive(session);
        // A few failed ticks inside the ttl: still alive.
        std::thread::sleep(Duration::from_millis(150));
        assert!(!take_lost_peek(session) && !unrefreshed_sessions().lock().unwrap().contains(session));
        // Past the ttl it gives up, as "unrefreshed", never as "lost".
        for _ in 0..300 {
            if unrefreshed_sessions().lock().unwrap().contains(session) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(take_unrefreshed(session));
        assert!(!take_lost(session));
        assert!(!lease.is_lost());
        drop(guard);
    }

    #[test]
    fn a_failed_rename_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let _lease = Lease::acquire_with(dir.path(), "run-1", TTL, 1_000, &always).unwrap();
        let record = read(&path(dir.path())).unwrap();
        // A directory where the file belongs makes the rename fail.
        let target = dir.path().join("sub").join("lease.json");
        std::fs::create_dir_all(&target).unwrap();
        assert!(write_atomic(&target, &record).is_err());
        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    fn take_lost_peek(session: &str) -> bool {
        lost_sessions().lock().unwrap().contains(session)
    }
}
