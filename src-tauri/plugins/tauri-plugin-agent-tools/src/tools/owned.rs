//! A child process that cannot outlive whoever owns it (AH-058).
//!
//! A long-lived helper -- a language server, say -- is started once and used
//! for a whole run. Ending it on the happy path is easy; the cases that matter
//! are the others: the run is cancelled, the owner panics, or the process that
//! started it is killed outright. `kill_on_drop` and `kill_tree` only cover the
//! first two, and neither reaches a grandchild the helper started itself.
//!
//! So an owned child is placed in a process tree that is stopped as a unit:
//!
//! * **Windows.** A job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The
//!   operating system closes the handle when this process exits, however it
//!   exits, and every process in the job -- including ones the child started --
//!   is terminated with it.
//! * **Unix.** Its own process group, which `kill_tree` signals as a whole.
//!   A process killed with SIGKILL runs no destructors, so there the guarantee
//!   is for cancellation and ordinary exits, not for `kill -9` of Jan itself.
//!
//! Nothing here installs or downloads anything: [`find_on_path`] only looks.

use std::path::PathBuf;
use std::process::Command;

/// Where `name` is on PATH, if anywhere. Only looks: a program that is not
/// there is reported missing, never fetched.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    super::proc::which(name)
}

/// Prepare `cmd` so the process tree it starts can be stopped as a unit, and so
/// it opens no console window of its own on Windows.
pub fn configure(cmd: &mut Command) {
    use jan_process::CommandConsole;
    cmd.background_in_new_group();
}

/// Whether a process with this id is running right now.
pub fn process_exists(pid: u32) -> bool {
    matches!(super::proc::has_exited_pid(pid), Some(false))
}

/// A child whose whole process tree ends when this value is dropped, or when
/// this process exits (Windows), whichever comes first.
pub struct OwnedChild {
    pid: u32,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
    stopped: bool,
}

// The job handle is only used to close it; Windows handles may be used from any
// thread.
unsafe impl Send for OwnedChild {}
unsafe impl Sync for OwnedChild {}

impl OwnedChild {
    /// Take ownership of the process `pid`, which must have been started with
    /// [`configure`] and must not have started children of its own yet.
    #[cfg(windows)]
    pub fn own(pid: u32) -> Result<OwnedChild, String> {
        use std::ffi::c_void;
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(format!("no job object could be created (error {})", unsafe { GetLastError() }));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let limited = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if limited == 0 {
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(job) };
            return Err(format!("the job could not be made to end with its owner (error {error})"));
        }
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(job) };
            return Err(format!("the process could not be opened (error {error})"));
        }
        let assigned = unsafe { AssignProcessToJobObject(job, process) };
        let error = unsafe { GetLastError() };
        unsafe { CloseHandle(process) };
        if assigned == 0 {
            unsafe { CloseHandle(job) };
            return Err(format!("the process could not be placed in a job (error {error})"));
        }
        Ok(OwnedChild { pid, job, stopped: false })
    }

    /// Take ownership of the process `pid`, which must have been started with
    /// [`configure`] so it leads its own process group.
    #[cfg(not(windows))]
    pub fn own(pid: u32) -> Result<OwnedChild, String> {
        Ok(OwnedChild { pid, stopped: false })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Stop the whole tree now. Idempotent.
    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        let _ = super::proc::kill_tree(self.pid);
        #[cfg(windows)]
        unsafe {
            // Closing the last handle to a kill-on-close job terminates anything
            // the tree walk above missed.
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

impl OwnedChild {
    /// Let the tree go on without its owner: what it left running is not
    /// stopped. Used once the child itself finished normally.
    pub fn release(mut self) {
        self.stopped = true;
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::{
                JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            };
            // Clear kill-on-close first, so closing the handle ends nothing.
            let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            SetInformationJobObject(
                self.job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

/// `cmd.output()` under `timeout`, where a timeout stops the whole process
/// tree, not just the direct child (report-04 F11): a `.cmd` wrapper, `wsl.exe`
/// or `docker` leaves the real work in a grandchild that `kill_on_drop` never
/// reaches. Stdin is null and stdout/stderr are captured, as `output()` does.
pub async fn output_with_timeout(
    cmd: &mut tokio::process::Command,
    timeout: std::time::Duration,
) -> Result<std::io::Result<std::process::Output>, tokio::time::error::Elapsed> {
    output_with_timeout_kept(cmd, timeout, false).await
}

/// As [`output_with_timeout`], but each stream keeps its first and its last
/// `CAPTURE_CAP / 2` bytes, so a long build log still ends with its result.
pub async fn output_with_timeout_head_tail(
    cmd: &mut tokio::process::Command,
    timeout: std::time::Duration,
) -> Result<std::io::Result<std::process::Output>, tokio::time::error::Elapsed> {
    output_with_timeout_kept(cmd, timeout, true).await
}

async fn output_with_timeout_kept(
    cmd: &mut tokio::process::Command,
    timeout: std::time::Duration,
    keep_tail: bool,
) -> Result<std::io::Result<std::process::Output>, tokio::time::error::Elapsed> {
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Ok(Err(e)),
    };
    let owner = child.id().and_then(|pid| OwnedChild::own(pid).ok());
    match tokio::time::timeout(timeout, bounded_output_with(child, CAPTURE_CAP, keep_tail)).await {
        Ok(out) => {
            if let Some(owner) = owner {
                owner.release();
            }
            Ok(out)
        }
        // Dropping `owner` stops the tree; the child itself is killed on drop.
        Err(elapsed) => {
            drop(owner);
            Err(elapsed)
        }
    }
}

/// `cmd.output()` for sync callers, with a deadline (W10): stdin is null, both
/// streams are drained on threads so a chatty child cannot block on a full
/// pipe, and a child still running at `timeout` is killed. `TimedOut` then.
pub fn output_blocking(
    cmd: &mut std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.take(CAPTURE_CAP as u64).read_to_end(&mut v);
            let _ = std::io::copy(p, &mut std::io::sink());
        }
        v
    });
    let err_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.take(CAPTURE_CAP as u64).read_to_end(&mut v);
            let _ = std::io::copy(p, &mut std::io::sink());
        }
        v
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break Some(s);
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    match status {
        Some(status) => Ok(std::process::Output { status, stdout, stderr }),
        None => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out")),
    }
}

/// Most bytes kept from each output stream (W33). A child that prints more has
/// the rest read and discarded, so it never blocks on a full pipe and Flint
/// never holds more than this per stream.
pub const CAPTURE_CAP: usize = 1024 * 1024;

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(reader: Option<R>, cap: usize, keep_tail: bool) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let Some(mut reader) = reader else { return Vec::new() };
    let head_cap = if keep_tail { cap / 2 } else { cap };
    let tail_cap = cap - head_cap;
    let mut kept = Vec::new();
    let mut tail: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
    let mut dropped = 0usize;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = head_cap.saturating_sub(kept.len());
                let take = n.min(room);
                kept.extend_from_slice(&chunk[..take]);
                if tail_cap > 0 {
                    tail.extend(&chunk[take..n]);
                    while tail.len() > tail_cap {
                        let over = tail.len() - tail_cap;
                        tail.drain(..over);
                        dropped += over;
                    }
                }
            }
        }
    }
    if dropped > 0 {
        kept.extend_from_slice(format!("\n[... {dropped} bytes of output left out ...]\n").as_bytes());
    }
    kept.extend(tail);
    kept
}

/// `wait_with_output` with each stream capped at `cap` bytes.
async fn bounded_output_with(
    mut child: tokio::process::Child,
    cap: usize,
    keep_tail: bool,
) -> std::io::Result<std::process::Output> {
    let out = read_capped(child.stdout.take(), cap, keep_tail);
    let err = read_capped(child.stderr.take(), cap, keep_tail);
    let (stdout, stderr) = tokio::join!(out, err);
    let status = child.wait().await?;
    Ok(std::process::Output { status, stdout, stderr })
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A child that prints far more than the cap is read to the end, but only
    /// the first `cap` bytes per stream are kept.
    #[tokio::test]
    async fn capture_bounds_memory() {
        let mut cmd = if cfg!(windows) {
            let mut c = tokio::process::Command::new("powershell");
            c.args(["-NoProfile", "-Command", "$s='x'*1048576; 1..50 | ForEach-Object { [Console]::Out.Write($s) }"]);
            c
        } else {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-c", "head -c 52428800 /dev/zero | tr '\\0' x"]);
            c
        };
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("spawn");
        let out = bounded_output_with(child, 64 * 1024, false).await.expect("output");
        assert_eq!(out.stdout.len(), 64 * 1024);
        assert!(out.status.success());
    }

    /// Head-and-tail capture keeps the start and the end of a long stream.
    #[tokio::test]
    async fn head_tail_capture_keeps_the_end() {
        let data: Vec<u8> = (0..100_000u32).map(|i| b'a' + (i % 26) as u8).collect();
        let kept = read_capped(Some(&data[..]), 1000, true).await;
        assert!(kept.starts_with(&data[..500]));
        assert!(kept.ends_with(&data[data.len() - 500..]));
        let text = String::from_utf8_lossy(&kept);
        assert!(text.contains("[... 99000 bytes of output left out ...]"), "{text}");
        let short = read_capped(Some(&data[..800]), 1000, true).await;
        assert_eq!(short, &data[..800]);
    }

    #[test]
    fn a_program_that_is_not_there_is_reported_missing() {
        assert!(find_on_path("jan-no-such-program-anywhere-4c1f").is_none());
    }

    /// Dropping the owner ends the child and the grandchild it started, which
    /// is exactly what `kill_on_drop` alone does not do.
    #[cfg(windows)]
    #[test]
    fn dropping_the_owner_ends_the_child_and_what_it_started() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 60 127.0.0.1 >NUL"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        configure(&mut cmd);
        let mut child = cmd.spawn().expect("start cmd");
        let pid = child.id();
        let owned = OwnedChild::own(pid).expect("own it");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut grandchildren = Vec::new();
        while grandchildren.is_empty() && std::time::Instant::now() < deadline {
            grandchildren = super::super::proc::descendants_of(pid, super::super::proc::creation_time_of_pid(pid));
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!grandchildren.is_empty(), "cmd never started ping");
        assert!(process_exists(pid));
        drop(owned);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let everyone: Vec<u32> = std::iter::once(pid).chain(grandchildren.iter().copied()).collect();
        while everyone.iter().any(|p| process_exists(*p)) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = child.wait();
        let left: Vec<u32> = everyone.into_iter().filter(|p| process_exists(*p)).collect();
        assert!(left.is_empty(), "still running after the owner was dropped: {left:?}");
    }

    /// A query that never answers is stopped at its deadline (W10).
    #[test]
    fn git_inspect_times_out() {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = std::process::Command::new("sleep");
            c.arg("30");
            c
        };
        let start = std::time::Instant::now();
        let r = output_blocking(&mut cmd, std::time::Duration::from_millis(300));
        assert_eq!(r.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
    }
}
