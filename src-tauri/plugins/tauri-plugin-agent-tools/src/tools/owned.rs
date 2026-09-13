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
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
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

impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
