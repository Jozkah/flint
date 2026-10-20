//! Supervises the `flint-llama-worker` process.
//!
//! This is the crash boundary. The worker links llama.cpp statically, but in
//! its own process, because `GGML_ASSERT` calls `abort()` unconditionally and
//! no amount of `catch_unwind` contains that -- a VRAM OOM or a Vulkan device
//! loss must cost the model, not the app.
//!
//! Deliberately free of the `engine` feature: supervision is just process
//! management, so a build that did not compile llama.cpp can still drive a
//! worker shipped alongside it as a sidecar.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tauri_plugin_hardware::vendor::nvidia::CudaVersion;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// The worker prints this and nothing else on stdout, then serves. Reading a
/// structured line beats the router path's stderr scraping: there is no
/// version-dependent log phrasing to match, and no race against a log file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    pub port: u16,
    pub pid: u32,
    pub models: Vec<String>,
    /// The CUDA toolkit the engine was built with, which decides how new an
    /// NVIDIA driver it needs.
    pub cuda_toolkit: Option<CudaVersion>,
}

/// Line reader that survives non-UTF-8 output. `Lines` ends the stream at
/// the first invalid byte, which would silently stop fault detection (and,
/// on stdout, the drain that keeps the worker from blocking on a full pipe).
struct LossyLines<R> {
    inner: tokio::io::Split<BufReader<R>>,
}

impl<R: tokio::io::AsyncRead + Unpin> LossyLines<R> {
    fn new(reader: R) -> Self {
        Self {
            inner: BufReader::new(reader).split(b'\n'),
        }
    }

    async fn next_line(&mut self) -> std::io::Result<Option<String>> {
        Ok(self.inner.next_segment().await?.map(|mut bytes| {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            String::from_utf8_lossy(&bytes).into_owned()
        }))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum WorkerError {
    Spawn(String),
    /// The worker exited or said nothing intelligible before serving.
    Handshake(String),
    /// The worker died before serving: the exit description and the last
    /// stderr lines, which is where a loader or CPU-feature failure says why.
    Exited(String),
    Timeout(Duration),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(m) => write!(f, "could not start flint-llama-worker: {m}"),
            Self::Handshake(m) => write!(f, "flint-llama-worker did not come up: {m}"),
            Self::Exited(m) => write!(f, "flint-llama-worker exited before serving: {m}"),
            Self::Timeout(d) => {
                write!(f, "flint-llama-worker did not report a port within {d:?}")
            }
        }
    }
}

/// A runtime failure worth telling the user about, classified from one worker
/// log line. `GGML_ASSERT` calls `abort()`, so for these the line on stderr is
/// often the only evidence left of what happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeFault {
    /// Ran out of device or host memory mid-request.
    Oom,
    /// A backend crash: a CUDA/Vulkan/Metal error, a failed assert, device
    /// loss, or a heap-corruption abort.
    Backend,
}

impl RuntimeFault {
    /// The event name the frontend listens on. Still `router` because that is
    /// what `LlamacppOomListener` subscribes to; renaming it would be a
    /// two-sided change for no gain.
    pub const fn event_name(self) -> &'static str {
        match self {
            Self::Oom => "llamacpp-router-oom",
            Self::Backend => "llamacpp-router-backend-error",
        }
    }
}

/// Classifies a log line. The caller lowercases once and passes that in.
pub fn classify_fault(line_lower: &str) -> Option<RuntimeFault> {
    if is_oom_line(line_lower) {
        return Some(RuntimeFault::Oom);
    }
    if is_backend_error_line(line_lower) {
        return Some(RuntimeFault::Backend);
    }
    None
}

fn is_oom_line(line_lower: &str) -> bool {
    // The Metal code is what macOS reports when the mapped model outgrows
    // `recommendedMaxWorkingSetSize`; "insufficient memory" is both its
    // localized text and ggml_aligned_malloc's ENOMEM message.
    if line_lower.contains("erroroutofdevicememory")
        || line_lower.contains("erroroutofhostmemory")
        || line_lower.contains("kiogpucommandbuffercallbackerroroutofmemory")
        || line_lower.contains("insufficient memory")
    {
        return true;
    }
    line_lower.contains("failed to allocate") && line_lower.contains("buffer of size")
}

fn is_backend_error_line(line_lower: &str) -> bool {
    if line_lower.contains("cuda error:") || line_lower.contains("ggml_assert(") {
        return true;
    }
    if (line_lower.contains("ggml_vulkan") || line_lower.contains("ggml_metal"))
        && line_lower.contains("error")
    {
        return true;
    }
    // GPU device loss (vk::DeviceLostError / ErrorDeviceLost, CUDA device-lost)
    // and any uncaught C++ exception abort mid-request -- surface them so a
    // crash during prompt processing still reaches the UI.
    if line_lower.contains("devicelost")
        || line_lower.contains("device lost")
        || line_lower.contains("terminate called after throwing")
    {
        return true;
    }
    // glibc heap-corruption / stack-protector aborts (SIGABRT). A native memory
    // bug in the backend (e.g. the mtmd video decode path) prints one of these
    // just before the process dies -- unclassified, the crash is silent and the
    // load appears to hang forever.
    [
        "corrupted size vs. prev_size",
        "corrupted double-linked list",
        "double free or corruption",
        "malloc(): ",
        "free(): ",
        "munmap_chunk(): invalid pointer",
        "stack smashing detected",
        "buffer overflow detected",
    ]
    .iter()
    .any(|m| line_lower.contains(m))
}

/// Turns worker stderr lines into faults, one call per line.
///
/// Metal reports a failed command buffer as two lines: a status line that
/// only says "failed with status N", then the cause (`error: Insufficient
/// Memory (...)`). Classified one at a time, the status line would be
/// reported as a backend fault and the debounce would swallow the OOM line
/// after it, so the status line is held until the next line decides it.
#[derive(Debug, Default)]
struct FaultReader {
    pending_metal_status: Option<String>,
}

impl FaultReader {
    fn feed(&mut self, line: &str) -> Vec<(RuntimeFault, String)> {
        let lower = line.to_lowercase();
        let mut out = Vec::new();
        let is_status = lower.contains("command buffer") && lower.contains("failed with status");
        if let Some(status) = self.pending_metal_status.take() {
            // ggml-metal prints the detail as `error: <description>`, behind
            // whatever prefix the log sink adds, so match loosely.
            if !is_status && lower.contains("error:") {
                let fault = classify_fault(&lower).unwrap_or(RuntimeFault::Backend);
                out.push((fault, format!("{status} {line}")));
                return out;
            }
            out.push((RuntimeFault::Backend, status));
        }
        if is_status {
            self.pending_metal_status = Some(line.to_string());
            return out;
        }
        if let Some(fault) = classify_fault(&lower) {
            out.push((fault, line.to_string()));
        }
        out
    }

    /// A held status line whose detail never came (stderr closed or went
    /// quiet), reported as the backend fault it is on its own.
    fn flush(&mut self) -> Option<(RuntimeFault, String)> {
        self.pending_metal_status
            .take()
            .map(|status| (RuntimeFault::Backend, status))
    }
}

/// How long a held Metal status line waits for its detail line. The two are
/// printed back to back, so this only bounds the no-detail case.
const METAL_DETAIL_WAIT: Duration = Duration::from_millis(500);

/// How many trailing stderr lines are kept, and how long each may be. A crash
/// leaves its explanation in the last few lines; the rest is load chatter.
const STDERR_TAIL_LINES: usize = 12;
const STDERR_TAIL_LINE_CHARS: usize = 300;

/// The most recent worker stderr lines, shared between the task draining the
/// pipe and whoever later has to say why the worker died.
#[derive(Debug, Clone, Default)]
struct StderrTail(std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>);

impl StderrTail {
    fn push(&self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let line: String = line.chars().take(STDERR_TAIL_LINE_CHARS).collect();
        let Ok(mut lines) = self.0.lock() else { return };
        if lines.len() == STDERR_TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    fn lines(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|l| l.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// How a dead worker ended, in words a person can search for: the exit
/// description, and the last stderr lines. Plain text on purpose, so the one
/// classifier in `error.rs` reads it like any other engine output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitReport {
    pub status: String,
    pub last_lines: Vec<String>,
}

impl ExitReport {
    /// Status followed by the tail, which is what gets classified and shown.
    pub fn text(&self) -> String {
        if self.last_lines.is_empty() {
            self.status.clone()
        } else {
            format!("{}. Last output: {}", self.status, self.last_lines.join(" / "))
        }
    }
}

/// Describes an exit. A Unix signal is named, and a Windows NTSTATUS is shown
/// in hex with its name where it is one a user is likely to meet, because
/// "exit code -1073741795" tells nobody anything.
pub fn describe_exit(code: Option<i32>, signal: Option<i32>) -> String {
    if let Some(sig) = signal {
        let name = match sig {
            4 => " (SIGILL: illegal instruction)",
            6 => " (SIGABRT: abort)",
            7 => " (SIGBUS: bus error)",
            8 => " (SIGFPE: arithmetic exception)",
            9 => " (SIGKILL)",
            11 => " (SIGSEGV: segmentation fault)",
            _ => "",
        };
        return format!("killed by signal {sig}{name}");
    }
    let Some(code) = code else {
        return "exited without a status".to_string();
    };
    let status = code as u32;
    if status < 0x8000_0000 {
        return format!("exit code {code}");
    }
    let name = match status {
        0xC000_001D => " (illegal instruction)",
        0xC000_0005 => " (access violation)",
        0xC000_0409 => " (stack buffer overrun)",
        0xC000_0135 => " (a required DLL was not found)",
        0xC000_007B => " (invalid image format)",
        _ => "",
    };
    format!("exit code 0x{status:08X}{name}")
}

fn describe_status(status: &std::process::ExitStatus) -> String {
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(status);
    #[cfg(not(unix))]
    let signal = None;
    describe_exit(status.code(), signal)
}

/// Called once per classified line, with the line itself. Boxed rather than
/// generic so `WorkerHandle` does not have to carry a type parameter.
pub type FaultCallback = std::sync::Arc<dyn Fn(RuntimeFault, String) + Send + Sync + 'static>;

/// Minimum gap between reports. One fault produces a burst of lines (a CUDA
/// error, then the assert, then the abort message), and the user needs the
/// first one, not all of them.
const FAULT_DEBOUNCE: Duration = Duration::from_secs(3);

/// Where a load put the model, read from the engine's own log. The engine does
/// not report this over HTTP, so the stderr drain is the only place it shows.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct OffloadReport {
    /// The model the line was tagged with, when the router tagged it.
    pub model: Option<String>,
    pub gpu_layers: u32,
    pub total_layers: u32,
    /// Weights placed in device memory, MiB.
    pub gpu_mib: f64,
    /// Weights left in host memory, MiB.
    pub cpu_mib: f64,
}

/// Called with the report each time a log line changes it.
pub type OffloadCallback = std::sync::Arc<dyn Fn(OffloadReport) + Send + Sync + 'static>;

/// Folds log lines into an [`OffloadReport`].
///
/// llama.cpp prints `offloaded N/M layers to GPU` and, after it, one
/// `<device> model buffer size = X MiB` per buffer. A new `offloaded` line is a
/// new load, so it starts a fresh report and the buffer lines that follow add
/// to it.
#[derive(Default)]
pub struct OffloadTracker {
    current: Option<OffloadReport>,
}

impl OffloadTracker {
    pub fn feed(&mut self, line: &str) -> Option<OffloadReport> {
        let (model, body) = split_model_tag(line);
        if let Some((gpu, total)) = parse_offloaded(body) {
            let report = OffloadReport {
                model,
                gpu_layers: gpu,
                total_layers: total,
                gpu_mib: 0.0,
                cpu_mib: 0.0,
            };
            self.current = Some(report.clone());
            return Some(report);
        }
        let (device, mib) = parse_buffer_size(body)?;
        let report = self.current.as_mut()?;
        if is_host_buffer(device) {
            report.cpu_mib += mib;
        } else {
            report.gpu_mib += mib;
        }
        Some(report.clone())
    }
}

/// `[name] rest` -> (`Some(name)`, `rest`). Anything else is untagged.
fn split_model_tag(line: &str) -> (Option<String>, &str) {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let name = &rest[..end];
            // A model id, not a timestamp or a thread number.
            if !name.is_empty() && end <= 128 && name.chars().any(|c| c.is_alphabetic()) {
                return (Some(name.to_string()), rest[end + 1..].trim_start());
            }
        }
    }
    (None, trimmed)
}

fn parse_offloaded(line: &str) -> Option<(u32, u32)> {
    let after = &line[line.find("offloaded ")? + "offloaded ".len()..];
    let (counts, tail) = after.split_once(' ')?;
    if !tail.starts_with("layers to GPU") {
        return None;
    }
    let (gpu, total) = counts.split_once('/')?;
    Some((gpu.parse().ok()?, total.parse().ok()?))
}

fn parse_buffer_size(line: &str) -> Option<(&str, f64)> {
    let at = line.find(" model buffer size")?;
    let device = line[..at].split_whitespace().last()?;
    let after = &line[at..];
    let value = after[after.find('=')? + 1..].trim_start();
    let (number, unit) = value.split_once(' ')?;
    if !unit.trim_start().starts_with("MiB") {
        return None;
    }
    Some((device, number.parse().ok()?))
}

/// `CPU`, `CPU_Mapped`, `CUDA_Host`, `Vulkan_Host` are host memory; `CUDA0`,
/// `Vulkan0`, `Metal` are the device.
fn is_host_buffer(device: &str) -> bool {
    let d = device.to_ascii_lowercase();
    d.starts_with("cpu") || d.ends_with("_host")
}

/// Env var the worker reads its bearer token from. Never an argv flag: argv is
/// world-readable via `ps` / `/proc/<pid>/cmdline`, and the supervisor logs it.
pub const API_KEY_ENV: &str = "JAN_LLAMA_API_KEY";

/// How long to wait for the worker to unwind after it accepts `/shutdown`.
/// Generous because unwinding runs `jan_llama_engine_stop` per resident model,
/// which terminates each `server_queue` loop and frees the model.
const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// How long to wait for the handshake. Generous because a cold page-cache read
/// of the preset plus binding a port can be slow on a loaded machine, but far
/// short of a model load -- the worker answers before loading anything.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Pure so the flag set is testable without spawning anything. Port 0 asks the
/// OS to choose, which the handshake then reports back -- unlike the router
/// path's `49152 + random` guess, this cannot collide.
pub fn worker_args(
    preset_path: &Path,
    port: u16,
    models_max: u32,
    slot_cache_mib: u64,
) -> Vec<String> {
    vec![
        "--preset".to_string(),
        preset_path.to_string_lossy().to_string(),
        "--port".to_string(),
        port.to_string(),
        "--models-max".to_string(),
        models_max.to_string(),
        "--slot-cache-mib".to_string(),
        slot_cache_mib.to_string(),
    ]
}

pub fn parse_handshake(line: &str) -> Result<Handshake, WorkerError> {
    let v: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|e| WorkerError::Handshake(format!("unparseable line {line:?}: {e}")))?;
    let port = v
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .filter(|p| *p > 0 && *p <= u16::MAX as u64)
        .ok_or_else(|| WorkerError::Handshake(format!("no usable port in {line:?}")))?
        as u16;
    let pid = v
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default() as u32;
    let models = v
        .get("models")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| m.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    // Absent for a worker without CUDA, or one built where nvcc could not be
    // read. Unreadable is treated the same: the handshake is not the place to
    // fail over a diagnostic.
    let cuda_toolkit = v
        .get("cuda_toolkit")
        .and_then(serde_json::Value::as_str)
        .and_then(CudaVersion::parse);
    Ok(Handshake {
        port,
        pid,
        models,
        cuda_toolkit,
    })
}

impl std::fmt::Debug for WorkerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // No api_key: this ends up in logs and error messages.
        f.debug_struct("WorkerHandle")
            .field("pid", &self.pid)
            .field("port", &self.port)
            .field("models", &self.models)
            .finish()
    }
}

#[cfg(windows)]
mod reap {
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn confine(child: RawHandle) -> Option<Job> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            log::warn!("could not create a job object for the Flint worker");
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
            log::warn!("could not set kill-on-close on the Flint worker job object");
            return None;
        }
        if unsafe { AssignProcessToJobObject(job.0, child as HANDLE) } == 0 {
            log::warn!("could not put the Flint worker in its job object");
            return None;
        }
        Some(job)
    }
}

pub struct WorkerHandle {
    pub port: u16,
    pub pid: u32,
    pub api_key: String,
    pub models: Vec<String>,
    /// The CUDA toolkit the engine was built with, when it reported one.
    pub cuda_toolkit: Option<CudaVersion>,
    child: Child,
    stderr_tail: StderrTail,
    #[cfg(windows)]
    _job: Option<reap::Job>,
}

impl WorkerHandle {
    /// SIGTERM, then SIGKILL after a grace period, reusing the same helper the
    /// router path uses so there is one kill policy in the crate.
    /// Stops the worker, gracefully on every platform.
    ///
    /// Closes the worker's stdin first; the worker treats EOF there as "stop".
    /// That works identically on Linux, macOS and Windows, which is the whole
    /// reason the worker is our own binary rather than a downloaded
    /// `llama-server`: the router could only be signalled, and Windows has no
    /// deliverable SIGTERM equivalent (`GenerateConsoleCtrlEvent(CTRL_C_EVENT)`
    /// needs process group 0, which would kill Jan too), so it had to be
    /// force-killed there. A force kill skips `jan_llama_engine_stop`, leaving
    /// `server_queue` loops unterminated and the model unfreed.
    ///
    /// Signals remain the fallback for a worker too wedged to answer.
    pub async fn stop(mut self) {
        if self.request_shutdown() {
            match tokio::time::timeout(SHUTDOWN_TIMEOUT, self.child.wait()).await {
                Ok(Ok(status)) => {
                    log::info!("flint-llama-worker exited gracefully: {status}");
                    return;
                }
                Ok(Err(e)) => log::warn!("waiting on the worker failed: {e}"),
                Err(_) => log::warn!(
                    "flint-llama-worker did not exit within {}s of /shutdown; falling back",
                    SHUTDOWN_TIMEOUT.as_secs()
                ),
            }
        }

        #[cfg(unix)]
        crate::process::graceful_terminate_process(&mut self.child).await;
        #[cfg(windows)]
        crate::process::force_terminate_process(&mut self.child).await;
        #[cfg(not(any(unix, windows)))]
        {
            let _ = self.child.kill().await;
        }
    }

    /// Kills the worker immediately, skipping the graceful path.
    ///
    /// The engine's own teardown does not run, so this is only for a user who
    /// has asked to abandon work in flight.
    pub async fn kill(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }

    /// Closes the worker's stdin, which is its shutdown signal.
    ///
    /// Returns false only if there was no pipe to close, in which case the
    /// caller goes straight to the signal fallback.
    fn request_shutdown(&mut self) -> bool {
        self.take_stdin().is_some()
    }

    /// The write end of the worker's stdin. Dropping it signals shutdown;
    /// exposed so a test can exercise that path without the signal fallback.
    pub fn take_stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.child.stdin.take()
    }

    /// None while still running, otherwise the exit status.
    pub fn exited(&mut self) -> Option<std::process::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// None while still running, otherwise how it ended and what it last said.
    pub fn exit_report(&mut self) -> Option<ExitReport> {
        let status = self.exited()?;
        Some(ExitReport {
            status: describe_status(&status),
            last_lines: self.stderr_tail.lines(),
        })
    }
}

/// True inside a Flatpak sandbox.
#[cfg(target_os = "linux")]
fn is_flatpak() -> bool {
    std::env::var_os("FLATPAK_ID").is_some() || Path::new("/.flatpak-info").exists()
}

/// `LD_LIBRARY_PATH` with the worker's own directory (and its `lib` child)
/// first, keeping whatever was already set.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn flatpak_library_path(worker_dir: &Path, existing: &str) -> String {
    let mut parts = vec![
        worker_dir.display().to_string(),
        worker_dir.join("lib").display().to_string(),
    ];
    if !existing.is_empty() {
        parts.push(existing.to_string());
    }
    parts.join(":")
}

#[cfg(test)]
mod flatpak_path_tests {
    use super::*;

    #[test]
    fn worker_dir_comes_first_and_existing_is_kept() {
        let dir = Path::new("/app/lib/flint");
        let p = flatpak_library_path(dir, "/usr/lib");
        let want = format!(
            "{}:{}:/usr/lib",
            dir.display(),
            dir.join("lib").display()
        );
        assert_eq!(p, want);
        assert!(!flatpak_library_path(dir, "").ends_with(':'));
    }
}

/// Spawns the worker and waits for its handshake line.
#[allow(clippy::too_many_arguments)]
pub async fn spawn(
    exe: &Path,
    preset_path: &Path,
    port: u16,
    api_key: &str,
    models_max: u32,
    slot_cache_mib: u64,
    envs: HashMap<String, String>,
    on_fault: Option<FaultCallback>,
) -> Result<WorkerHandle, WorkerError> {
    spawn_with_offload(
        exe,
        preset_path,
        port,
        api_key,
        models_max,
        slot_cache_mib,
        envs,
        on_fault,
        None,
    )
    .await
}

/// [`spawn`], also reporting where each load placed its model.
#[allow(clippy::too_many_arguments)]
pub async fn spawn_with_offload(
    exe: &Path,
    preset_path: &Path,
    port: u16,
    api_key: &str,
    models_max: u32,
    slot_cache_mib: u64,
    envs: HashMap<String, String>,
    on_fault: Option<FaultCallback>,
    on_offload: Option<OffloadCallback>,
) -> Result<WorkerHandle, WorkerError> {
    let args = worker_args(preset_path, port, models_max, slot_cache_mib);
    log::info!("starting {} {}", exe.display(), args.join(" "));
    let (envs, clear_vk_fallback) = with_engine_env_defaults(envs);

    let mut cmd = Command::new(exe);
    // Without this the worker flashes a console window on Windows, the way
    // every other spawn in this plugin already avoids.
    jan_utils::system::setup_windows_process_flags(&mut cmd);
    // ggml's backend scan puts `fs::current_path()` in its search paths and
    // calls dl_load_library on every `ggml-*` filename match *before* reading
    // its score, so a planted module in an inherited cwd runs its DllMain /
    // constructor even if it is never selected -- and `best_score` is one
    // accumulator across all search paths, so a higher-scoring plant wins
    // outright rather than losing to path order. Pinning the cwd to the
    // worker's own directory, which is where the bundled modules already live,
    // removes the attacker-writable entry from that list.
    //
    // Absolute only: `current_dir` also changes how the OS resolves a *relative*
    // program path, so doing this unconditionally would make a dev's
    // `--bin build/flint-llama-worker` be looked up inside `build/`. Every shipped
    // path is absolute (`resource_dir()`, or `sidecar_path` off
    // `current_exe`), so the hardening lands exactly where it matters.
    if exe.is_absolute() {
        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }
    }
    if clear_vk_fallback {
        cmd.env_remove(VK_SYSMEM_FALLBACK_ENV);
    }
    cmd.args(&args)
        .envs(envs)
        .env(API_KEY_ENV, api_key)
        // Piped, not null: dropping our end closes the pipe, which is the
        // shutdown signal the worker waits on. `Stdio::null()` would be an
        // immediate EOF and the worker would exit at once.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Inside a Flatpak the worker's bundled shared libraries live in the app's
    // private lib directory, which the sandbox's loader does not search.
    #[cfg(target_os = "linux")]
    if is_flatpak() {
        if let Some(dir) = exe.parent() {
            let existing = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
            cmd.env("LD_LIBRARY_PATH", flatpak_library_path(dir, &existing));
        }
    }

    let mut child = cmd.spawn().map_err(|e| WorkerError::Spawn(e.to_string()))?;
    #[cfg(windows)]
    let job = child.raw_handle().and_then(reap::confine);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| WorkerError::Spawn("no stdout pipe".into()))?;
    // Drained on its own task: a full stderr pipe would otherwise block the
    // worker mid-generation, which is a hang with no error message.
    let stderr_tail = StderrTail::default();
    let drain = child.stderr.take().map(|stderr| {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = LossyLines::new(stderr);
            let mut reader = FaultReader::default();
            let mut last_fault_at: Option<tokio::time::Instant> = None;
            let mut offload = OffloadTracker::default();
            let mut report = |fault: RuntimeFault, line: String| {
                let Some(cb) = on_fault.as_ref() else { return };
                let now = tokio::time::Instant::now();
                if last_fault_at.is_some_and(|t| now.duration_since(t) <= FAULT_DEBOUNCE) {
                    return;
                }
                last_fault_at = Some(now);
                cb(fault, line);
            };
            loop {
                let next = if reader.pending_metal_status.is_some() {
                    match tokio::time::timeout(METAL_DETAIL_WAIT, lines.next_line()).await {
                        Ok(next) => next,
                        Err(_) => {
                            if let Some((fault, line)) = reader.flush() {
                                report(fault, line);
                            }
                            continue;
                        }
                    }
                } else {
                    lines.next_line().await
                };
                let Ok(Some(line)) = next else { break };
                log::debug!("flint-llama-worker: {line}");
                tail.push(&line);
                if let Some(report_to) = on_offload.as_ref() {
                    if let Some(offloaded) = offload.feed(&line) {
                        report_to(offloaded);
                    }
                }
                for (fault, text) in reader.feed(&line) {
                    report(fault, text);
                }
            }
            if let Some((fault, line)) = reader.flush() {
                report(fault, line);
            }
        })
    });

    let mut lines = LossyLines::new(stdout);
    let first = tokio::time::timeout(HANDSHAKE_TIMEOUT, lines.next_line()).await;

    let line = match first {
        Err(_) => {
            let _ = child.start_kill();
            return Err(WorkerError::Timeout(HANDSHAKE_TIMEOUT));
        }
        Ok(Err(e)) => {
            let _ = child.start_kill();
            return Err(WorkerError::Handshake(e.to_string()));
        }
        Ok(Ok(None)) => {
            // Closed stdout without a line: it died. The exit status and what
            // it said last are the most useful things we can report; the
            // drain task is given a moment to read the pipe to its end.
            let status = child.wait().await.ok();
            if let Some(drain) = drain {
                let _ = tokio::time::timeout(Duration::from_secs(1), drain).await;
            }
            let report = ExitReport {
                status: status
                    .as_ref()
                    .map(describe_status)
                    .unwrap_or_else(|| "exited without a status".to_string()),
                last_lines: stderr_tail.lines(),
            };
            return Err(WorkerError::Exited(report.text()));
        }
        Ok(Ok(Some(line))) => line,
    };

    let hs = match parse_handshake(&line) {
        Ok(hs) => hs,
        Err(e) => {
            let _ = child.start_kill();
            return Err(e);
        }
    };

    // Keep draining stdout so the worker never blocks on a full pipe.
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("flint-llama-worker: {line}");
        }
    });

    Ok(WorkerHandle {
        port: hs.port,
        pid: hs.pid,
        api_key: api_key.to_string(),
        models: hs.models,
        cuda_toolkit: hs.cuda_toolkit,
        child,
        stderr_tail,
        #[cfg(windows)]
        _job: job,
    })
}

/// Where the worker lives next to the running executable, which is how Tauri
/// lays out a bundled sidecar.
pub fn worker_file_name() -> &'static str {
    if cfg!(windows) {
        "flint-llama-worker.exe"
    } else {
        "flint-llama-worker"
    }
}

/// Where the worker would sit beside the app executable, whether or not it is
/// actually there. Separate from `sidecar_path` so a failure can report the
/// path it looked at instead of just saying it found nothing.
pub fn sidecar_candidate() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(worker_file_name()))
}

/// The worker beside the app executable.
///
/// This is the dev layout (`target/<profile>/`). A bundled app puts it under the
/// resource directory instead, which only the Tauri side can resolve, so
/// `commands::resolve_worker_exe` checks that first and falls back here.
pub fn sidecar_path() -> Option<PathBuf> {
    let candidate = sidecar_candidate()?;
    candidate.is_file().then_some(candidate)
}

/// Vulkan's lazily grown scratch buffers are allocated on the first decode,
/// after auto-fit has sized the model, so fit cannot leave room for them; with
/// VRAM full the allocation fails with `ErrorOutOfDeviceMemory` because
/// ggml-vulkan has no system-memory fallback unless asked. With the fallback a
/// tight fit runs slower instead of failing. ggml-vulkan only checks that the
/// variable exists, so a user value of `0`/`false`/`off` is removed here to
/// switch it off rather than passed through.
const VK_SYSMEM_FALLBACK_ENV: &str = "GGML_VK_ALLOW_SYSMEM_FALLBACK";

fn is_off(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no")
}

/// The worker's environment plus defaults, and whether the fallback variable
/// must also be cleared from the inherited environment.
fn with_engine_env_defaults(mut envs: HashMap<String, String>) -> (HashMap<String, String>, bool) {
    let user = envs
        .get(VK_SYSMEM_FALLBACK_ENV)
        .cloned()
        .or_else(|| std::env::var(VK_SYSMEM_FALLBACK_ENV).ok());
    match user {
        Some(v) if is_off(&v) => {
            envs.remove(VK_SYSMEM_FALLBACK_ENV);
            (envs, true)
        }
        Some(_) => (envs, false),
        None => {
            envs.insert(VK_SYSMEM_FALLBACK_ENV.to_string(), "1".to_string());
            (envs, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vulkan_sysmem_fallback_is_on_unless_the_user_set_it() {
        if std::env::var_os(VK_SYSMEM_FALLBACK_ENV).is_none() {
            let (envs, clear) = with_engine_env_defaults(HashMap::new());
            assert_eq!(envs.get(VK_SYSMEM_FALLBACK_ENV).map(String::as_str), Some("1"));
            assert!(!clear);
        }
        let mut user = HashMap::new();
        user.insert(VK_SYSMEM_FALLBACK_ENV.to_string(), "0".to_string());
        let (envs, clear) = with_engine_env_defaults(user);
        assert!(!envs.contains_key(VK_SYSMEM_FALLBACK_ENV), "0 must switch it off");
        assert!(clear);
        let mut user = HashMap::new();
        user.insert(VK_SYSMEM_FALLBACK_ENV.to_string(), "1".to_string());
        let (envs, clear) = with_engine_env_defaults(user);
        assert_eq!(envs.get(VK_SYSMEM_FALLBACK_ENV).map(String::as_str), Some("1"));
        assert!(!clear);
    }

    // Restored with the marker lists intact: each entry came from a real crash
    // report, and a fault the classifier misses is a silent hang for the user.
    #[test]
    fn classifies_backend_crash_lines() {
        // Inputs arrive already lowercased from the caller.
        for line in [
            "what():  vk::device::waitforfences: errordevicelost",
            "terminate called after throwing an instance of 'vk::devicelosterror'",
            "cuda error: out of memory",
            "ggml_assert(cond) failed",
            "corrupted size vs. prev_size",
            "malloc(): corrupted top size",
            "stack smashing detected",
        ] {
            assert_eq!(
                classify_fault(line),
                Some(RuntimeFault::Backend),
                "{line:?}"
            );
        }
    }

    #[test]
    fn classifies_allocation_failures_as_oom() {
        for line in [
            "erroroutofdevicememory",
            "erroroutofhostmemory",
            "alloc_tensor_range: failed to allocate cuda0 buffer of size 2491323904",
        ] {
            assert_eq!(classify_fault(line), Some(RuntimeFault::Oom), "{line:?}");
        }
    }

    // OOM is checked first: "cuda error: out of memory" is both, and the OOM
    // dialog is the one with advice the user can act on.
    #[test]
    fn ordinary_log_lines_are_not_faults() {
        for line in [
            "srv log_server_r: request: post /v1/chat/completions",
            "load: control-looking token: 128247 was not control-type",
            "main: server is listening on http://127.0.0.1:39271",
            "",
        ] {
            assert_eq!(classify_fault(line), None, "{line:?}");
        }
    }

    // A partial phrase must not fire: "failed to allocate" alone shows up in
    // benign fit-params chatter.
    #[test]
    fn a_partial_allocation_phrase_is_not_an_oom() {
        assert_eq!(
            classify_fault("common_fit_params: failed to allocate a plan"),
            None
        );
    }

    #[test]
    fn classifies_metal_and_host_out_of_memory_as_oom() {
        for line in [
            "error: insufficient memory (00000008:kiogpucommandbuffercallbackerroroutofmemory)",
            "ggml_aligned_malloc: insufficient memory (attempted to allocate 512.00 mb)",
        ] {
            assert_eq!(classify_fault(line), Some(RuntimeFault::Oom), "{line:?}");
        }
    }

    // The status line alone looks like a generic Metal error; only the line
    // after it says it was memory (janhq/jan#9198).
    #[test]
    fn a_metal_status_line_is_reported_together_with_its_oom_detail() {
        let mut r = FaultReader::default();
        assert_eq!(
            r.feed("E ggml_metal_synchronize: error: command buffer 0 failed with status 5"),
            vec![]
        );
        let out = r.feed(
            "E error: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, RuntimeFault::Oom);
        assert!(out[0].1.contains("failed with status 5"), "{:?}", out[0].1);
        assert!(out[0].1.contains("Insufficient Memory"), "{:?}", out[0].1);
        assert_eq!(r.flush(), None);
    }

    #[test]
    fn a_metal_status_line_with_a_non_memory_detail_stays_a_backend_fault() {
        let mut r = FaultReader::default();
        r.feed("ggml_metal_synchronize: error: command buffer 0 failed with status 5");
        let out = r.feed(
            "error: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout)",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, RuntimeFault::Backend);
        assert!(out[0].1.contains("Timeout"), "{:?}", out[0].1);
    }

    // A status that prints no detail line must not swallow what follows.
    #[test]
    fn a_metal_status_line_without_detail_is_reported_alone() {
        let mut r = FaultReader::default();
        let status = "ggml_metal_synchronize: error: command buffer 1 failed with status 4";
        r.feed(status);
        assert_eq!(
            r.feed("srv log_server_r: request: post /v1/chat/completions"),
            vec![(RuntimeFault::Backend, status.to_string())]
        );

        r.feed(status);
        assert_eq!(r.flush(), Some((RuntimeFault::Backend, status.to_string())));
        assert_eq!(r.flush(), None);
    }

    #[test]
    fn the_reader_passes_other_lines_straight_through() {
        let mut r = FaultReader::default();
        assert_eq!(
            r.feed("ErrorOutOfDeviceMemory"),
            vec![(RuntimeFault::Oom, "ErrorOutOfDeviceMemory".to_string())]
        );
        assert_eq!(r.feed("main: server is listening"), vec![]);
        assert_eq!(r.flush(), None);
    }

    #[test]
    fn exits_are_described_by_signal_and_ntstatus() {
        assert_eq!(
            describe_exit(None, Some(4)),
            "killed by signal 4 (SIGILL: illegal instruction)"
        );
        assert_eq!(describe_exit(Some(1), None), "exit code 1");
        assert_eq!(
            describe_exit(Some(-1073741795), None),
            "exit code 0xC000001D (illegal instruction)"
        );
        assert_eq!(
            describe_exit(Some(-1073741819), None),
            "exit code 0xC0000005 (access violation)"
        );
        assert_eq!(
            describe_exit(Some(-1073740791), None),
            "exit code 0xC0000409 (stack buffer overrun)"
        );
        assert_eq!(describe_exit(None, None), "exited without a status");
    }

    #[test]
    fn the_stderr_tail_keeps_only_the_last_lines_and_clips_long_ones() {
        let tail = StderrTail::default();
        for i in 0..(STDERR_TAIL_LINES + 5) {
            tail.push(&format!("line {i}"));
        }
        tail.push("   ");
        tail.push(&"x".repeat(STDERR_TAIL_LINE_CHARS * 2));
        let lines = tail.lines();
        assert_eq!(lines.len(), STDERR_TAIL_LINES);
        // 17 lines then one long one: the oldest 6 are gone.
        assert_eq!(lines[0], "line 6");
        assert_eq!(lines.last().unwrap().chars().count(), STDERR_TAIL_LINE_CHARS);
    }

    #[test]
    fn an_exit_report_reads_as_one_line_of_evidence() {
        let report = ExitReport {
            status: "exit code 0xC0000005 (access violation)".into(),
            last_lines: vec![
                "ggml_cuda_init: found 1 CUDA devices".into(),
                "CUDA error".into(),
            ],
        };
        assert_eq!(
            report.text(),
            "exit code 0xC0000005 (access violation). Last output: \
             ggml_cuda_init: found 1 CUDA devices / CUDA error"
        );
        let silent = ExitReport {
            status: "exit code 1".into(),
            last_lines: vec![],
        };
        assert_eq!(silent.text(), "exit code 1");
    }

    #[test]
    fn each_fault_maps_to_the_event_the_frontend_listens_on() {
        assert_eq!(RuntimeFault::Oom.event_name(), "llamacpp-router-oom");
        assert_eq!(
            RuntimeFault::Backend.event_name(),
            "llamacpp-router-backend-error"
        );
    }

    #[test]
    fn worker_args_are_the_documented_flags() {
        let args = worker_args(Path::new("/tmp/router.preset.ini"), 0, 4, 8192);
        assert_eq!(
            args,
            vec![
                "--preset",
                "/tmp/router.preset.ini",
                "--port",
                "0",
                "--models-max",
                "4",
                "--slot-cache-mib",
                "8192"
            ]
        );
    }

    #[test]
    fn the_api_key_never_appears_in_argv() {
        // The router path documents this invariant; keep it here too.
        let args = worker_args(Path::new("/p.ini"), 1234, 1, 0);
        assert!(
            !args.iter().any(|a| a.contains("api") || a.contains("key")),
            "argv is world-readable via /proc; the token must go through {API_KEY_ENV}"
        );
    }

    #[test]
    fn models_max_zero_is_forwarded_verbatim_as_unlimited() {
        let args = worker_args(Path::new("/p.ini"), 1, 0, 0);
        assert_eq!(args[5], "0");
    }

    // 0 is the off switch, and it has to survive as 0 rather than being
    // dropped: an absent flag would fall back to the worker's own default.
    #[test]
    fn the_slot_cache_budget_is_forwarded_including_zero() {
        let off = worker_args(Path::new("/p.ini"), 1, 1, 0);
        assert_eq!(off[7], "0");
        let on = worker_args(Path::new("/p.ini"), 1, 1, 4096);
        assert_eq!(on[7], "4096");
    }

    #[test]
    fn parse_handshake_reads_the_worker_line() {
        let hs = parse_handshake(
            r#"{"port":39271,"pid":1234,"models":["a","b"],"cuda_toolkit":"13.2"}"#,
        )
        .unwrap();
        assert_eq!(
            hs,
            Handshake {
                port: 39271,
                pid: 1234,
                models: vec!["a".into(), "b".into()],
                cuda_toolkit: Some(CudaVersion { major: 13, minor: 2 }),
            }
        );
    }

    #[test]
    fn parse_handshake_tolerates_trailing_newline_and_missing_optionals() {
        let hs = parse_handshake("{\"port\":8080}\n").unwrap();
        assert_eq!(hs.port, 8080);
        assert_eq!(hs.pid, 0);
        assert!(hs.models.is_empty());
        assert_eq!(hs.cuda_toolkit, None);
    }

    // A worker built without CUDA, or by a build that could not read nvcc,
    // reports null; an unreadable value must not fail the whole handshake.
    #[test]
    fn parse_handshake_treats_an_absent_or_unreadable_toolkit_as_unknown() {
        for line in [
            r#"{"port":8080,"cuda_toolkit":null}"#,
            r#"{"port":8080,"cuda_toolkit":"thirteen"}"#,
            r#"{"port":8080,"cuda_toolkit":13}"#,
        ] {
            let hs = parse_handshake(line).unwrap();
            assert_eq!(hs.port, 8080, "{line}");
            assert_eq!(hs.cuda_toolkit, None, "{line}");
        }
    }

    #[test]
    fn parse_handshake_rejects_a_missing_or_impossible_port() {
        // Port 0 would mean "the OS did not assign one", which is never a
        // usable upstream -- accepting it would produce a session that every
        // later request silently fails against.
        for bad in [
            r#"{"pid":1}"#,
            r#"{"port":0}"#,
            r#"{"port":70000}"#,
            r#"{"port":"8080"}"#,
            "not json",
            "",
        ] {
            assert!(
                parse_handshake(bad).is_err(),
                "should have rejected {bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn lossy_lines_read_past_invalid_utf8() {
        let input: &[u8] = b"ok\r\nbad \xff byte\nCUDA error: out of memory\n";
        let mut lines = LossyLines::new(input);
        assert_eq!(lines.next_line().await.unwrap().as_deref(), Some("ok"));
        assert_eq!(
            lines.next_line().await.unwrap().as_deref(),
            Some("bad \u{fffd} byte")
        );
        assert_eq!(
            lines.next_line().await.unwrap().as_deref(),
            Some("CUDA error: out of memory")
        );
        assert_eq!(lines.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn spawning_a_missing_binary_is_a_spawn_error_not_a_hang() {
        let err = spawn(
            Path::new("/definitely/not/a/binary"),
            Path::new("/tmp/x.ini"),
            0,
            "k",
            1,
            0,
            HashMap::new(),
            None,
        )
        .await
        .expect_err("a missing exe must fail");
        assert!(matches!(err, WorkerError::Spawn(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn a_process_that_says_nothing_is_reported_not_awaited_forever() {
        // `true` exits immediately with no output, standing in for a worker
        // that dies during startup.
        let exe = ["/bin/true", "/usr/bin/true"]
            .iter()
            .map(Path::new)
            .find(|p| p.is_file());
        let Some(exe) = exe else { return };
        let err = spawn(
            exe,
            Path::new("/tmp/x.ini"),
            0,
            "k",
            1,
            0,
            HashMap::new(),
            None,
        )
        .await
        .expect_err("a silent exit must fail");
        assert!(matches!(err, WorkerError::Exited(_)), "got {err:?}");
    }

    #[test]
    fn offload_tracker_reads_layers_and_buffers() {
        let mut t = OffloadTracker::default();
        assert_eq!(t.feed("load_tensors: loading model tensors"), None);
        let r = t
            .feed("load_tensors: offloaded 33/33 layers to GPU")
            .unwrap();
        assert_eq!((r.gpu_layers, r.total_layers), (33, 33));
        t.feed("load_tensors:   CPU_Mapped model buffer size =   300.00 MiB");
        let r = t
            .feed("load_tensors:      Vulkan0 model buffer size =  4000.50 MiB")
            .unwrap();
        assert_eq!(r.gpu_mib, 4000.5);
        assert_eq!(r.cpu_mib, 300.0);
    }

    #[test]
    fn offload_tracker_starts_over_on_a_new_load() {
        let mut t = OffloadTracker::default();
        t.feed("offloaded 20/40 layers to GPU");
        t.feed("CUDA0 model buffer size = 1000.00 MiB");
        let r = t.feed("offloaded 40/40 layers to GPU").unwrap();
        assert_eq!((r.gpu_layers, r.gpu_mib), (40, 0.0));
    }

    #[test]
    fn offload_tracker_keeps_the_router_tag_and_ignores_buffers_before_a_load() {
        let mut t = OffloadTracker::default();
        assert_eq!(t.feed("CUDA0 model buffer size = 1000.00 MiB"), None);
        let r = t
            .feed("[qwen3-8b] load_tensors: offloaded 0/37 layers to GPU")
            .unwrap();
        assert_eq!(r.model.as_deref(), Some("qwen3-8b"));
        assert_eq!(r.gpu_layers, 0);
        assert_eq!(t.feed("[12345] something unrelated"), None);
    }

    /// The lines as the in-process engine prints them: a timestamp and a level
    /// letter in front, and no router tag. A reporter's 24 GB card decoded at
    /// CPU speed and the log could not say where the weights were; these are the
    /// lines the shim now lets through, so the tracker has to read them as they
    /// really arrive.
    #[test]
    fn offload_tracker_reads_the_prefixed_lines_the_engine_prints() {
        let mut t = OffloadTracker::default();
        let r = t
            .feed("0.02.410.793 I load_tensors: offloaded 0/33 layers to GPU")
            .unwrap();
        assert_eq!((r.gpu_layers, r.total_layers, r.model.clone()), (0, 33, None));
        t.feed("0.02.410.800 I load_tensors:   CPU_Mapped model buffer size =  5800.25 MiB");
        let r = t
            .feed("0.02.410.801 I load_tensors:      Vulkan0 model buffer size =     0.00 MiB")
            .unwrap();
        assert_eq!((r.gpu_mib, r.cpu_mib), (0.0, 5800.25));
        let r = t
            .feed("0.03.001.000 I load_tensors: offloaded 33/33 layers to GPU")
            .unwrap();
        assert_eq!((r.gpu_layers, r.gpu_mib, r.cpu_mib), (33, 0.0, 0.0));
        let r = t
            .feed("0.03.001.010 I load_tensors:      Vulkan0 model buffer size =  5800.25 MiB")
            .unwrap();
        assert_eq!((r.gpu_mib, r.cpu_mib), (5800.25, 0.0));
    }
}
