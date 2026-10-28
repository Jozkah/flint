//! Ties a child's life to the app's, so a crash of the app cannot orphan it.
//!
//! The engines (`flint-llama-worker`, `sd-server`) hold the GPU. A normal exit
//! stops them in order, but a crash or a force-kill of the app skips that, and
//! an orphan keeps VRAM until the user finds it in the task manager.
//!
//! * Windows: [`confine`] puts the child in a Job Object with
//!   kill-on-close; when the owner of the [`Job`] dies (for any reason) the OS
//!   kills the child and its descendants. Nested jobs are fine on Windows 8+;
//!   when the app is itself in a job that forbids it, the attempt is logged-
//!   away and the child just runs unconfined, as before.
//! * Linux: [`die_with_parent`] sets `PR_SET_PDEATHSIG` so the kernel sends
//!   SIGKILL to the child when the spawning thread's process exits.

#[cfg(windows)]
mod win {
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Owns the Job Object; dropping it (or the owner process dying) kills
    /// everything assigned to it.
    pub struct Job(HANDLE);

    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Assigns the process behind `child` to a new kill-on-close job. `None`
    /// when the OS refuses (the child then runs unconfined).
    pub fn confine(child: RawHandle) -> Option<Job> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }
        let job = Job(job);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return None;
        }
        if unsafe { AssignProcessToJobObject(job.0, child as HANDLE) } == 0 {
            return None;
        }
        Some(job)
    }
}

#[cfg(windows)]
pub use win::{confine, Job};

/// Makes the kernel kill the child when the process that spawned it exits.
/// Linux only; a no-op elsewhere (macOS has no equivalent, Windows uses
/// [`confine`]).
///
/// The signal follows the *thread* that called `fork`, so on a multi-threaded
/// runtime it is only as reliable as that thread's lifetime. It is a backstop
/// for a crashed app, not the primary stop path.
pub fn die_with_parent(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the closure only calls `prctl`, which is async-signal-safe,
        // between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0);
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cmd;
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_the_job_kills_the_child() {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.args(["/C", "ping -n 60 127.0.0.1 >nul"]);
        let mut child = cmd.spawn().unwrap();
        let job = child.raw_handle().and_then(confine);
        if job.is_none() {
            // Already inside a job that forbids nesting: nothing to prove.
            let _ = child.start_kill();
            return;
        }
        drop(job);
        // The command would run for a minute; it ending inside 5 s is the kill.
        tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .expect("the child outlived its job")
            .unwrap();
    }
}
