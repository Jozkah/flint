//! CPU and memory attributed to the run whose commands used them (AH-174).
//!
//! The system monitor shows the host: how busy the machine is, not which run
//! made it so. Here every command a run's `bash` call starts is measured as a
//! whole process tree and the figures are kept against that run and call.
//!
//! On Windows the command's root process is put in a job object as soon as it
//! is spawned. A job accounts for every process created inside it, including
//! children that have already exited, so the figures are the tree's: total
//! user and kernel CPU time, the job's peak committed memory, and how many
//! processes it held. A process the command starts in the moment between spawn
//! and assignment -- before the shell has read its first line -- would escape
//! the job; the shells used here start nothing that early.
//!
//! Other platforms have no per-tree accounting that survives a child's exit
//! without owning its reaping, so a command there is recorded as not measured,
//! with the reason, rather than as zero.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// What one command used, or why it was not measured.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub measured: bool,
    /// User plus kernel CPU time of every process in the tree, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_ms: Option<u64>,
    /// The most memory the tree had committed at once, in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_memory_bytes: Option<u64>,
    /// How many processes the tree held over its life.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processes: Option<u32>,
    /// Why nothing was measured, when nothing was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Resources {
    pub fn unmeasured(reason: impl Into<String>) -> Self {
        Self { measured: false, reason: Some(reason.into()), ..Default::default() }
    }
}

/// What a whole run's commands used.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResources {
    /// Commands the run started.
    pub commands: u32,
    /// Of those, how many were measured.
    pub measured_commands: u32,
    /// CPU time across the measured commands, in milliseconds.
    pub cpu_ms: u64,
    /// The highest peak of any one measured command, in bytes. Commands can
    /// overlap, so this is a floor on the run's peak, not a sum.
    pub peak_memory_bytes: u64,
    /// Processes across the measured commands.
    pub processes: u32,
    /// Why some were not measured, when some were not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unmeasured_reason: Option<String>,
}

impl RunResources {
    fn add(&mut self, r: &Resources) {
        self.commands += 1;
        if r.measured {
            self.measured_commands += 1;
            self.cpu_ms += r.cpu_ms.unwrap_or(0);
            self.peak_memory_bytes = self.peak_memory_bytes.max(r.peak_memory_bytes.unwrap_or(0));
            self.processes += r.processes.unwrap_or(0);
        } else if self.unmeasured_reason.is_none() {
            self.unmeasured_reason = r.reason.clone();
        }
    }
}

#[derive(Default)]
struct Ledger {
    calls: HashMap<(String, String), Resources>,
    runs: HashMap<String, RunResources>,
}

fn ledger() -> &'static Mutex<Ledger> {
    static LEDGER: std::sync::OnceLock<Mutex<Ledger>> = std::sync::OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(Ledger::default()))
}

/// Keep what a command used against its run and the call that started it. A
/// command with no run is not attributed to anything and is not kept.
pub fn record(run: Option<&str>, call: Option<&str>, resources: Resources) {
    let Some(run) = run.filter(|r| !r.is_empty()) else { return };
    let mut ledger = ledger().lock().unwrap_or_else(|p| p.into_inner());
    ledger.runs.entry(run.to_string()).or_default().add(&resources);
    if let Some(call) = call.filter(|c| !c.is_empty()) {
        ledger.calls.insert((run.to_string(), call.to_string()), resources);
    }
}

/// What the call used, taken so it is reported once.
pub fn take_call(run: &str, call: &str) -> Option<Resources> {
    ledger()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .calls
        .remove(&(run.to_string(), call.to_string()))
}

/// The run's totals, and everything kept for it forgotten. `None` for a run
/// that started no command.
pub fn finish_run(run: &str) -> Option<RunResources> {
    let mut ledger = ledger().lock().unwrap_or_else(|p| p.into_inner());
    ledger.calls.retain(|(r, _), _| r != run);
    ledger.runs.remove(run)
}

/// Measures one command's process tree from spawn to exit.
pub struct Meter {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

// The job handle is only read and closed; Windows handles may be used from any
// thread.
unsafe impl Send for Meter {}
unsafe impl Sync for Meter {}

#[cfg(windows)]
impl Meter {
    /// Start measuring the process `pid` and everything it starts.
    pub fn attach(pid: u32) -> Result<Meter, String> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(format!("the command's process could not be opened (error {})", unsafe { GetLastError() }));
        }
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(process) };
            return Err(format!("no job object for the measurement (error {error})"));
        }
        let assigned = unsafe { AssignProcessToJobObject(job, process) };
        let error = unsafe { GetLastError() };
        unsafe { CloseHandle(process) };
        if assigned == 0 {
            unsafe { CloseHandle(job) };
            return Err(format!("the command could not be placed in a job for measurement (error {error})"));
        }
        Ok(Meter { job })
    }

    /// What the tree has used so far.
    pub fn read(&self) -> Resources {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };
        let mut basic: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let got_basic = unsafe {
            QueryInformationJobObject(
                self.job,
                JobObjectBasicAccountingInformation,
                &mut basic as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } != 0;
        let got_limits = unsafe {
            QueryInformationJobObject(
                self.job,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } != 0;
        if !got_basic {
            return Resources::unmeasured("the job's accounting could not be read");
        }
        // 100-nanosecond ticks.
        let cpu = (basic.TotalUserTime.max(0) as u64 + basic.TotalKernelTime.max(0) as u64) / 10_000;
        Resources {
            measured: true,
            cpu_ms: Some(cpu),
            peak_memory_bytes: got_limits.then_some(limits.PeakJobMemoryUsed as u64),
            processes: Some(basic.TotalProcesses),
            reason: None,
        }
    }
}

#[cfg(windows)]
impl Drop for Meter {
    fn drop(&mut self) {
        // The job has no kill-on-close limit: closing the measurement never
        // touches the command it measured.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) };
    }
}

#[cfg(not(windows))]
impl Meter {
    pub fn attach(_pid: u32) -> Result<Meter, String> {
        Err("CPU and memory of a command are measured on Windows only".to_string())
    }

    pub fn read(&self) -> Resources {
        Resources::unmeasured("CPU and memory of a command are measured on Windows only")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measured(cpu: u64, peak: u64, processes: u32) -> Resources {
        Resources { measured: true, cpu_ms: Some(cpu), peak_memory_bytes: Some(peak), processes: Some(processes), reason: None }
    }

    #[test]
    fn usage_is_kept_against_its_own_run_and_call() {
        let (a, b) = ("res-test-run-a", "res-test-run-b");
        record(Some(a), Some("c1"), measured(100, 5_000, 2));
        record(Some(a), Some("c2"), measured(40, 9_000, 1));
        record(Some(b), Some("c1"), measured(7, 1_000, 1));
        record(None, Some("c9"), measured(999, 999, 9));

        assert_eq!(take_call(a, "c1"), Some(measured(100, 5_000, 2)));
        assert_eq!(take_call(a, "c1"), None, "reported once");
        assert_eq!(take_call(b, "c2"), None, "another run's call is not this run's");

        let totals = finish_run(a).expect("run a started commands");
        assert_eq!(
            totals,
            RunResources { commands: 2, measured_commands: 2, cpu_ms: 140, peak_memory_bytes: 9_000, processes: 3, unmeasured_reason: None }
        );
        assert_eq!(finish_run(a), None, "finished runs are forgotten");
        assert_eq!(take_call(a, "c2"), None, "and so are their unreported calls");
        assert_eq!(finish_run(b).unwrap().cpu_ms, 7, "run b was never mixed into run a");
    }

    #[test]
    fn an_unmeasured_command_is_counted_with_its_reason_and_never_as_zero() {
        let run = "res-test-run-unmeasured";
        record(Some(run), Some("c1"), Resources::unmeasured("no job"));
        record(Some(run), Some("c2"), measured(5, 10, 1));
        let totals = finish_run(run).unwrap();
        assert_eq!((totals.commands, totals.measured_commands), (2, 1));
        assert_eq!(totals.unmeasured_reason.as_deref(), Some("no job"));
        let wire = serde_json::to_value(Resources::unmeasured("no job")).unwrap();
        assert_eq!(wire, serde_json::json!({ "measured": false, "reason": "no job" }));
        assert!(wire.get("cpuMs").is_none(), "an unmeasured command has no CPU figure, not a zero");
    }

    #[cfg(windows)]
    #[test]
    fn a_command_tree_is_measured_including_children_that_have_exited() {
        // PowerShell burns CPU itself, then starts a child that exits before the
        // reading: both count.
        let mut child = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$x = 0; foreach ($i in 1..3000000) { $x += $i }; cmd /c exit 0; $x | Out-Null",
            ])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let meter = Meter::attach(child.id()).expect("a fresh process can be measured");
        assert!(child.wait().unwrap().success());
        let r = meter.read();
        assert!(r.measured, "{r:?}");
        assert!(r.cpu_ms.unwrap() >= 300, "the loop's CPU is attributed: {r:?}");
        assert!(r.processes.unwrap() >= 2, "the exited child is counted: {r:?}");
        assert!(r.peak_memory_bytes.unwrap() >= 10 * 1024 * 1024, "powershell's memory is attributed: {r:?}");
    }

    #[cfg(windows)]
    #[test]
    fn a_process_that_is_gone_cannot_be_measured_and_says_so() {
        let mut child = std::process::Command::new("cmd").args(["/c", "exit 0"]).spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        drop(child);
        // The pid may be reused, but not by a process we may place in a job
        // in this instant; either way the result is an error, not a zero.
        if let Err(e) = Meter::attach(pid) {
            assert!(e.contains("error"), "{e}");
        }
        assert!(Meter::attach(u32::MAX - 1).is_err());
    }
}
