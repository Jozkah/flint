//! Evidence for a crash, in the log the app already keeps.
//!
//! A desktop app that dies leaves nothing: a Rust panic goes to a standard error
//! nobody sees, and a hard exit leaves no line at all, so a report of "it
//! crashed" arrives with a log that simply stops. That is exactly how a stack
//! overflow on the main thread looked in the release build: no panic, no Windows
//! crash record, the log just ended. Four things change that.
//!
//! * A panic hook writes the panic, its place, its thread and a backtrace to the
//!   log before the default hook runs.
//! * On Windows, an exception handler records what a panic hook cannot see: a
//!   stack overflow, an access violation, a fast-fail. It writes a short report
//!   (what, where as module and offset, the build, how big the thread's stack
//!   was, the last commands the app ran) to `crashes/pending.txt` with nothing
//!   but fixed buffers and the file opened at start, because it runs on a thread
//!   that may have no stack left.
//! * A marker file in the data folder says "running". It is written at start and
//!   removed by the clean shutdown path. Finding it at the next start means the
//!   previous run did not shut down cleanly, which the log then says, together
//!   with the crash report if there is one.
//! * At start the main thread's stack size is logged, and a warning says so when
//!   it is smaller than the app needs.
//!
//! None of it changes how the app behaves.


use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const MARKER: &str = "running.flag";
const CRASH_DIR: &str = "crashes";
const PENDING: &str = "pending.txt";
const KEEP_REPORTS: usize = 8;

/// The smallest main-thread stack the app is known to work with.
pub const MIN_MAIN_STACK_BYTES: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The trail: the last commands the app ran, readable without a lock.

const CRUMBS: usize = 32;
const CRUMB_WORDS: usize = 5;
const CRUMB_BYTES: usize = CRUMB_WORDS * 8;

struct Crumb {
    seq: AtomicU64,
    ms: AtomicU64,
    thread: AtomicU32,
    words: [AtomicU64; CRUMB_WORDS],
}

impl Crumb {
    const fn new() -> Self {
        Self {
            seq: AtomicU64::new(0),
            ms: AtomicU64::new(0),
            thread: AtomicU32::new(0),
            words: [const { AtomicU64::new(0) }; CRUMB_WORDS],
        }
    }
}

static RING: [Crumb; CRUMBS] = [const { Crumb::new() }; CRUMBS];
static NEXT: AtomicU64 = AtomicU64::new(0);
static STARTED_AT: OnceLock<Instant> = OnceLock::new();

fn uptime_ms() -> u64 {
    STARTED_AT.get().map_or(0, |t| t.elapsed().as_millis() as u64)
}

#[cfg(windows)]
fn thread_id() -> u32 {
    // SAFETY: no arguments, no preconditions.
    unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() }
}

#[cfg(not(windows))]
fn thread_id() -> u32 {
    0
}

/// Note that something is about to run, for the crash report. Cheap and
/// lock-free: a name is cut to 40 bytes, and only the last 32 are kept.
pub fn breadcrumb(name: &str) {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let slot = &RING[(n as usize) % CRUMBS];
    slot.seq.store(0, Ordering::Relaxed);
    let mut bytes = [0u8; CRUMB_BYTES];
    let mut len = name.len().min(CRUMB_BYTES);
    while !name.is_char_boundary(len) {
        len -= 1;
    }
    bytes[..len].copy_from_slice(&name.as_bytes()[..len]);
    for (i, word) in slot.words.iter().enumerate() {
        let mut w = [0u8; 8];
        w.copy_from_slice(&bytes[i * 8..i * 8 + 8]);
        word.store(u64::from_le_bytes(w), Ordering::Relaxed);
    }
    slot.ms.store(uptime_ms(), Ordering::Relaxed);
    slot.thread.store(thread_id(), Ordering::Relaxed);
    slot.seq.store(n + 1, Ordering::Release);
}

/// What `render` needs from one trail entry.
struct Entry {
    ms: u64,
    thread: u32,
    name: [u8; CRUMB_BYTES],
}

impl Entry {
    fn name(&self) -> &str {
        let end = self.name.iter().position(|b| *b == 0).unwrap_or(CRUMB_BYTES);
        std::str::from_utf8(&self.name[..end]).unwrap_or("?")
    }
}

/// The trail, newest first, into a fixed array. No allocation: it runs in the
/// crash handler.
fn read_trail(out: &mut [Option<Entry>; CRUMBS]) -> usize {
    let next = NEXT.load(Ordering::Acquire);
    let mut count = 0;
    for back in 0..CRUMBS as u64 {
        if next <= back {
            break;
        }
        let n = next - 1 - back;
        let slot = &RING[(n as usize) % CRUMBS];
        if slot.seq.load(Ordering::Acquire) != n + 1 {
            continue; // being rewritten, or already overwritten
        }
        let mut name = [0u8; CRUMB_BYTES];
        for (i, word) in slot.words.iter().enumerate() {
            name[i * 8..i * 8 + 8].copy_from_slice(&word.load(Ordering::Relaxed).to_le_bytes());
        }
        out[count] = Some(Entry {
            ms: slot.ms.load(Ordering::Relaxed),
            thread: slot.thread.load(Ordering::Relaxed),
            name,
        });
        count += 1;
    }
    count
}

/// The trail as text, newest first (for tests and the log).
pub fn recent_breadcrumbs() -> Vec<String> {
    let mut entries: [Option<Entry>; CRUMBS] = [const { None }; CRUMBS];
    let count = read_trail(&mut entries);
    entries[..count]
        .iter()
        .flatten()
        .map(|e| format!("+{}ms thread {} {}", e.ms, e.thread, e.name()))
        .collect()
}

// ---------------------------------------------------------------------------
// The report.

/// What is known at the moment of a fatal exception.
pub struct CrashInfo<'a> {
    pub what: &'a str,
    pub code: u32,
    pub thread: u32,
    pub main_thread: bool,
    pub address: u64,
    pub module: &'a str,
    pub offset: u64,
    pub uptime_ms: u64,
    /// Stack limits of the faulting thread and its stack pointer.
    pub stack_low: u64,
    pub stack_high: u64,
    pub stack_pointer: u64,
    pub frames: &'a [FrameInfo<'a>],
}

pub struct FrameInfo<'a> {
    pub module: &'a str,
    pub offset: u64,
}

fn render(out: &mut dyn std::fmt::Write, info: &CrashInfo<'_>) {
    let stack = info.stack_high.saturating_sub(info.stack_low);
    let _ = writeln!(out, "Flint crash report");
    let _ = writeln!(out, "version: {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(out, "build: {}", option_env!("FLINT_GIT_SHA").unwrap_or("unknown"));
    let _ = writeln!(out, "exception: {} (0x{:08X})", info.what, info.code);
    let _ = writeln!(
        out,
        "thread: {}{}",
        info.thread,
        if info.main_thread { " (the main thread)" } else { "" }
    );
    let _ = writeln!(out, "at: {}+0x{:X} (address 0x{:X})", info.module, info.offset, info.address);
    let _ = writeln!(out, "uptime: {} ms", info.uptime_ms);
    let _ = writeln!(
        out,
        "stack: {:.2} MB reserved, pointer {} bytes above the lowest address",
        stack as f64 / (1024.0 * 1024.0),
        info.stack_pointer.saturating_sub(info.stack_low)
    );
    let _ = writeln!(out, "frames, innermost first (module+offset):");
    for frame in info.frames {
        let _ = writeln!(out, "  {}+0x{:X}", frame.module, frame.offset);
    }
    let _ = writeln!(out, "last commands, newest first:");
    let mut entries: [Option<Entry>; CRUMBS] = [const { None }; CRUMBS];
    let count = read_trail(&mut entries);
    for entry in entries[..count].iter().flatten() {
        let _ = writeln!(out, "  +{}ms thread {} {}", entry.ms, entry.thread, entry.name());
    }
    if count == 0 {
        let _ = writeln!(out, "  (none recorded)");
    }
}

/// A fixed buffer that implements `fmt::Write`, so the report is built without
/// allocating. What does not fit is dropped.
struct Fixed<'a> {
    buf: &'a mut [u8],
    len: usize,
}

impl std::fmt::Write for Fixed<'_> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let room = self.buf.len() - self.len;
        let take = s.len().min(room);
        self.buf[self.len..self.len + take].copy_from_slice(&s.as_bytes()[..take]);
        self.len += take;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Panics.

/// Log every panic, with where it happened and a backtrace, then run whatever
/// hook was there before.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "an unknown place".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic with no text".to_string());
        let thread = std::thread::current();
        log::error!(
            "panic in thread '{}' at {location}: {message}\n{}",
            thread.name().unwrap_or("unnamed"),
            std::backtrace::Backtrace::force_capture()
        );
        previous(info);
    }));
}

// ---------------------------------------------------------------------------
// Files.

fn marker_path(data_folder: &Path) -> PathBuf {
    data_folder.join(MARKER)
}

fn crash_dir(data_folder: &Path) -> PathBuf {
    data_folder.join(CRASH_DIR)
}

/// Record that a run has started. Returns what the marker said if an earlier
/// run left it behind, which is a run that did not shut down cleanly.
pub fn mark_started(data_folder: &Path) -> Option<String> {
    let _ = STARTED_AT.set(Instant::now());
    let path = marker_path(data_folder);
    let earlier = std::fs::read_to_string(&path).ok();
    // The first run on a fresh install starts before anything has created the
    // data folder; without it the marker was never written and a crash during
    // that run was never reported.
    let _ = std::fs::create_dir_all(data_folder);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::write(
        &path,
        format!("process {} started at unix time {now}, version {}", std::process::id(), env!("CARGO_PKG_VERSION")),
    );
    earlier.map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

/// Record a clean shutdown: the running marker goes, and so does this run's
/// (empty) crash file.
pub fn mark_clean_exit(data_folder: &Path) {
    let _ = std::fs::remove_file(marker_path(data_folder));
    let _ = std::fs::remove_file(crash_dir(data_folder).join(PENDING));
}

/// The crash report an earlier run left, if any. It is moved to a file named
/// for the time it was found, and only the newest few are kept.
pub fn take_crash_report(data_folder: &Path) -> Option<String> {
    let dir = crash_dir(data_folder);
    let pending = dir.join(PENDING);
    let text = std::fs::read_to_string(&pending).ok()?;
    let text = text.trim().to_string();
    let _ = std::fs::remove_file(&pending);
    if text.is_empty() {
        return None;
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::write(dir.join(format!("crash-{now}.txt")), &text);
    if let Ok(read) = std::fs::read_dir(&dir) {
        let mut reports: Vec<PathBuf> = read
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("crash-")))
            .collect();
        reports.sort();
        while reports.len() > KEEP_REPORTS {
            let _ = std::fs::remove_file(reports.remove(0));
        }
    }
    Some(text)
}

/// The warning for a run that did not shut down cleanly.
pub fn unclean_message(earlier: &str, report: Option<&str>) -> String {
    let lead = format!(
        "the previous run did not shut down cleanly ({earlier}): it crashed, was ended, or the computer lost power."
    );
    match report {
        Some(report) => format!("{lead} It left this crash report:\n{report}"),
        None => format!(
            "{lead} No crash report was written, so it was not a fatal exception Flint could see (it may have been ended from outside). \
             Windows keeps its own record under Event Viewer, Windows Logs, Application, source 'Application Error'."
        ),
    }
}

/// The warning for a main thread whose stack is smaller than the app needs.
pub fn small_stack_message(bytes: usize) -> String {
    format!(
        "the main thread's stack is {:.2} MB, less than the {} MB Flint needs: a tool call can overflow it and end the app without a message. \
         This build was linked without a larger stack reservation.",
        bytes as f64 / (1024.0 * 1024.0),
        MIN_MAIN_STACK_BYTES / (1024 * 1024)
    )
}

// ---------------------------------------------------------------------------
// Windows: the exception handler.

#[cfg(windows)]
mod handler {
    use super::*;
    use std::ffi::c_void;
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use windows_sys::Win32::Foundation::{
        EXCEPTION_ACCESS_VIOLATION, EXCEPTION_ILLEGAL_INSTRUCTION, EXCEPTION_INT_DIVIDE_BY_ZERO,
        EXCEPTION_STACK_OVERFLOW, HMODULE,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        AddVectoredExceptionHandler, RtlCaptureStackBackTrace, SetUnhandledExceptionFilter, EXCEPTION_POINTERS,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleExW};
    use windows_sys::Win32::System::Threading::GetCurrentThreadStackLimits;

    const FRAMES: usize = 32;
    const FAST_FAIL: u32 = 0xC000_0409;
    const HEAP_CORRUPTION: u32 = 0xC000_0374;

    static CRASH_FILE: OnceLock<std::fs::File> = OnceLock::new();
    static MAIN_THREAD: AtomicU32 = AtomicU32::new(0);
    static BUSY: AtomicBool = AtomicBool::new(false);
    static PREVIOUS_FILTER: AtomicUsize = AtomicUsize::new(0);

    /// The report is built here, not on the (possibly exhausted) stack.
    struct Shared(std::cell::UnsafeCell<[u8; 12 * 1024]>);
    // SAFETY: only the thread that wins `BUSY` touches it.
    unsafe impl Sync for Shared {}
    static BUFFER: Shared = Shared(std::cell::UnsafeCell::new([0; 12 * 1024]));

    /// Module file name's last component, ASCII only, into `out`.
    fn module_of(address: usize, out: &mut [u8; 48]) -> (usize, u64) {
        let mut module: HMODULE = std::ptr::null_mut();
        // FROM_ADDRESS (0x4) | UNCHANGED_REFCOUNT (0x2)
        // SAFETY: `address` is only used as a key; `module` is a valid out pointer.
        let found = unsafe { GetModuleHandleExW(0x6, address as *const u16, &mut module) };
        if found == 0 || module.is_null() {
            let text = b"unknown";
            out[..text.len()].copy_from_slice(text);
            return (text.len(), address as u64);
        }
        let mut wide = [0u16; 260];
        // SAFETY: `wide` is a valid buffer of the stated length.
        let n = unsafe { GetModuleFileNameW(module, wide.as_mut_ptr(), wide.len() as u32) } as usize;
        let name = &wide[..n.min(wide.len())];
        let start = name.iter().rposition(|c| *c == b'\\' as u16 || *c == b'/' as u16).map_or(0, |i| i + 1);
        let mut len = 0;
        for c in &name[start..] {
            if len == out.len() {
                break;
            }
            out[len] = if *c < 0x80 { *c as u8 } else { b'?' };
            len += 1;
        }
        (len, (address - module as usize) as u64)
    }

    fn name_of(code: u32) -> &'static str {
        match code as i32 {
            EXCEPTION_STACK_OVERFLOW => "STACK_OVERFLOW",
            EXCEPTION_ACCESS_VIOLATION => "ACCESS_VIOLATION",
            EXCEPTION_ILLEGAL_INSTRUCTION => "ILLEGAL_INSTRUCTION",
            EXCEPTION_INT_DIVIDE_BY_ZERO => "INT_DIVIDE_BY_ZERO",
            _ if code == FAST_FAIL => "FAIL_FAST (abort)",
            _ if code == HEAP_CORRUPTION => "HEAP_CORRUPTION",
            _ => "UNHANDLED_EXCEPTION",
        }
    }

    /// Write the report for `info`. Called from the exception handlers; takes
    /// nothing that can allocate or block.
    unsafe fn record(info: *const EXCEPTION_POINTERS) {
        if info.is_null() || BUSY.swap(true, Ordering::SeqCst) {
            return;
        }
        let record = &*(*info).ExceptionRecord;
        let context = (*info).ContextRecord;
        let code = record.ExceptionCode as u32;
        let address = record.ExceptionAddress as usize;
        let (mut low, mut high) = (0usize, 0usize);
        GetCurrentThreadStackLimits(&mut low, &mut high);
        #[cfg(target_arch = "x86_64")]
        let sp = if context.is_null() { 0 } else { (*context).Rsp as usize };
        #[cfg(not(target_arch = "x86_64"))]
        let sp = 0usize;

        let mut module_name = [0u8; 48];
        let (module_len, offset) = module_of(address, &mut module_name);

        let mut raw: [*mut c_void; FRAMES] = [std::ptr::null_mut(); FRAMES];
        let captured = RtlCaptureStackBackTrace(0, FRAMES as u32, raw.as_mut_ptr(), std::ptr::null_mut()) as usize;
        let mut names = [[0u8; 48]; FRAMES];
        let mut frame_data: [(usize, u64); FRAMES] = [(0, 0); FRAMES];
        for i in 0..captured.min(FRAMES) {
            frame_data[i] = module_of(raw[i] as usize, &mut names[i]);
        }
        // `FrameInfo` borrows the names; build the slice on the stack as well.
        let mut frames: [FrameInfo<'_>; FRAMES] = [const { FrameInfo { module: "", offset: 0 } }; FRAMES];
        for i in 0..captured.min(FRAMES) {
            frames[i] = FrameInfo {
                module: std::str::from_utf8(&names[i][..frame_data[i].0]).unwrap_or("?"),
                offset: frame_data[i].1,
            };
        }

        let crash = CrashInfo {
            what: name_of(code),
            code,
            thread: thread_id(),
            main_thread: thread_id() == MAIN_THREAD.load(Ordering::Relaxed),
            address: address as u64,
            module: std::str::from_utf8(&module_name[..module_len]).unwrap_or("?"),
            offset,
            uptime_ms: uptime_ms(),
            stack_low: low as u64,
            stack_high: high as u64,
            stack_pointer: sp as u64,
            frames: &frames[..captured.min(FRAMES)],
        };
        let buffer = &mut *BUFFER.0.get();
        let mut out = Fixed { buf: buffer, len: 0 };
        render(&mut out, &crash);
        let len = out.len;
        if let Some(file) = CRASH_FILE.get() {
            let mut file = file;
            let _ = file.write_all(&buffer[..len]);
            let _ = file.sync_all();
        }
    }

    unsafe extern "system" fn first_chance(info: *mut EXCEPTION_POINTERS) -> i32 {
        // Only a stack overflow is recorded here: other first-chance exceptions
        // are routinely handled by the code that raised them.
        if !info.is_null() && (*(*info).ExceptionRecord).ExceptionCode == EXCEPTION_STACK_OVERFLOW {
            record(info);
        }
        0 // EXCEPTION_CONTINUE_SEARCH: the runtime still prints its own message
    }

    unsafe extern "system" fn last_chance(info: *const EXCEPTION_POINTERS) -> i32 {
        record(info);
        let previous = PREVIOUS_FILTER.load(Ordering::SeqCst);
        if previous != 0 {
            let filter: unsafe extern "system" fn(*const EXCEPTION_POINTERS) -> i32 = std::mem::transmute(previous);
            return filter(info);
        }
        0
    }

    /// The main thread's stack, as the OS reports it.
    pub fn main_stack_bytes() -> usize {
        let (mut low, mut high) = (0usize, 0usize);
        // SAFETY: valid out pointers.
        unsafe { GetCurrentThreadStackLimits(&mut low, &mut high) };
        high.saturating_sub(low)
    }

    pub fn install(data_folder: &Path) {
        let dir = crash_dir(data_folder);
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(file) = std::fs::File::create(dir.join(PENDING)) {
            let _ = CRASH_FILE.set(file);
        }
        MAIN_THREAD.store(thread_id(), Ordering::Relaxed);
        // SAFETY: both handlers are `extern "system"` functions with the
        // signatures Windows expects and live for the whole process.
        unsafe {
            AddVectoredExceptionHandler(1, Some(first_chance));
            let previous = SetUnhandledExceptionFilter(Some(last_chance));
            PREVIOUS_FILTER.store(previous.map_or(0, |f| f as usize), Ordering::SeqCst);
        }
    }
}

/// Start recording fatal exceptions. Windows only; elsewhere the platform's own
/// message is all there is. Call once, from the main thread, early. Returns what
/// to log about the main thread's stack: the logger is not attached yet at the
/// point this is called, so the caller logs it once it is.
pub fn install_crash_handler(data_folder: &Path) -> Option<(log::Level, String)> {
    #[cfg(windows)]
    {
        handler::install(data_folder);
        let bytes = handler::main_stack_bytes();
        if bytes < MIN_MAIN_STACK_BYTES {
            return Some((log::Level::Warn, small_stack_message(bytes)));
        }
        Some((log::Level::Info, format!("main thread stack: {:.2} MB", bytes as f64 / (1024.0 * 1024.0))))
    }
    #[cfg(not(windows))]
    {
        let _ = data_folder;
        None
    }
}

/// Route Tauri command invocations through the trail.
pub fn traced<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        breadcrumb(invoke.message.command());
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write as _;

    /// The trail is process-wide, so the tests that read it take turns.
    static TRAIL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flint-crash-trace-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_first_start_has_no_earlier_run() {
        let dir = folder("first");
        assert_eq!(mark_started(&dir), None);
        assert!(marker_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_run_on_a_fresh_install_still_writes_its_marker() {
        // The data folder does not exist yet on the very first launch.
        let dir = std::env::temp_dir().join(format!("flint-crash-trace-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!dir.exists());
        assert_eq!(mark_started(&dir), None);
        assert!(marker_path(&dir).exists(), "a crash in this run must be reported next start");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clean_exit_leaves_nothing_to_report() {
        let dir = folder("clean");
        assert_eq!(mark_started(&dir), None);
        mark_clean_exit(&dir);
        assert!(!marker_path(&dir).exists());
        assert_eq!(mark_started(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_marker_left_behind_is_reported_once() {
        let dir = folder("unclean");
        assert_eq!(mark_started(&dir), None);
        let earlier = mark_started(&dir).expect("the earlier run's marker");
        assert!(earlier.contains("started at unix time"), "{earlier}");
        assert!(unclean_message(&earlier, None).contains("did not shut down cleanly"));
        mark_clean_exit(&dir);
        assert_eq!(mark_started(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_is_not_an_error() {
        let dir = std::env::temp_dir().join("flint-crash-trace-does-not-exist-9d2");
        assert_eq!(mark_started(&dir), None);
        mark_clean_exit(&dir);
        assert_eq!(take_crash_report(&dir), None);
    }

    #[test]
    fn the_trail_keeps_the_newest_commands_and_cuts_long_names() {
        let _turn = TRAIL.lock().unwrap_or_else(|e| e.into_inner());
        for i in 0..40 {
            breadcrumb(&format!("trail-test-{i}"));
        }
        breadcrumb(&"x".repeat(100));
        breadcrumb("é".repeat(30).as_str());
        let trail = recent_breadcrumbs();
        assert!(trail.len() <= CRUMBS);
        // newest first: the multi-byte name, cut on a character boundary, then the long one
        assert!(trail[0].ends_with(&"é".repeat(20)), "{}", trail[0]);
        assert!(trail[1].ends_with(&"x".repeat(CRUMB_BYTES)), "{}", trail[1]);
        assert!(trail[2].ends_with("trail-test-39"), "{}", trail[2]);
        assert!(!trail.iter().any(|t| t.ends_with("trail-test-0")), "older entries are overwritten");
    }

    #[test]
    fn the_report_says_what_where_and_how_much_stack() {
        let _turn = TRAIL.lock().unwrap_or_else(|e| e.into_inner());
        breadcrumb("report-test-command");
        let frames = [FrameInfo { module: "Flint-Desktop.exe", offset: 0x1234 }, FrameInfo { module: "ntdll.dll", offset: 0x40 }];
        let info = CrashInfo {
            what: "STACK_OVERFLOW",
            code: 0xC000_00FD,
            thread: 4242,
            main_thread: true,
            address: 0x7FF6_0000_1234,
            module: "Flint-Desktop.exe",
            offset: 0x1234,
            uptime_ms: 9000,
            stack_low: 0x1000_0000,
            stack_high: 0x1010_0000,
            stack_pointer: 0x1000_0800,
            frames: &frames,
        };
        let mut text = String::new();
        render(&mut text, &info);
        for expected in [
            "exception: STACK_OVERFLOW (0xC00000FD)",
            "thread: 4242 (the main thread)",
            "at: Flint-Desktop.exe+0x1234",
            "stack: 1.00 MB reserved, pointer 2048 bytes above the lowest address",
            "  ntdll.dll+0x40",
            "report-test-command",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in:\n{text}");
        }
    }

    #[test]
    fn the_fixed_buffer_drops_what_does_not_fit_instead_of_growing() {
        let mut backing = [0u8; 8];
        let mut out = Fixed { buf: &mut backing, len: 0 };
        let _ = write!(out, "0123456789");
        assert_eq!(out.len, 8);
        assert_eq!(&backing, b"01234567");
    }

    #[test]
    fn a_crash_report_is_moved_aside_and_the_newest_few_are_kept() {
        let dir = folder("reports");
        let crashes = crash_dir(&dir);
        std::fs::create_dir_all(&crashes).unwrap();
        for i in 0..KEEP_REPORTS + 3 {
            std::fs::write(crashes.join(format!("crash-{i:04}.txt")), "old").unwrap();
        }
        std::fs::write(crashes.join(PENDING), "").unwrap();
        assert_eq!(take_crash_report(&dir), None, "an empty file is a run that ended cleanly or without a record");
        std::fs::write(crashes.join(PENDING), "Flint crash report\nexception: STACK_OVERFLOW").unwrap();
        let text = take_crash_report(&dir).expect("a report");
        assert!(text.contains("STACK_OVERFLOW"));
        assert!(!crashes.join(PENDING).exists());
        let kept = std::fs::read_dir(&crashes).unwrap().flatten().count();
        assert_eq!(kept, KEEP_REPORTS);
        assert!(unclean_message("run", Some(&text)).contains("It left this crash report"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_small_main_stack_is_called_out_with_its_size() {
        assert!(small_stack_message(1024 * 1024).contains("1.00 MB"));
        assert!(small_stack_message(1024 * 1024).contains("4 MB"));
    }

    /// The real thing: a child process overflows its stack and the report
    /// is in the file afterwards.
    #[cfg(windows)]
    #[test]
    fn a_stack_overflow_leaves_a_report_with_the_last_commands() {
        const CHILD_FOLDER: &str = "FLINT_CRASH_TRACE_CHILD_FOLDER";
        #[allow(unconditional_recursion)]
        fn recurse(depth: u64) -> u64 {
            let pad = [depth as u8; 512];
            std::hint::black_box(&pad);
            recurse(depth + 1) + pad[0] as u64
        }
        if let Ok(folder) = std::env::var(CHILD_FOLDER) {
            let folder = PathBuf::from(folder);
            let _ = mark_started(&folder);
            let _ = install_crash_handler(&folder);
            breadcrumb("child-before-overflow");
            breadcrumb("execute_tool read");
            recurse(0);
            return;
        }
        let dir = folder("overflow");
        let exe = std::env::current_exe().unwrap();
        let output = std::process::Command::new(exe)
            .args(["--exact", "core::crash_trace::tests::a_stack_overflow_leaves_a_report_with_the_last_commands", "--nocapture", "--test-threads=1"])
            .env(CHILD_FOLDER, &dir)
            .output()
            .unwrap();
        assert!(!output.status.success(), "the child should have died");
        let report = std::fs::read_to_string(crash_dir(&dir).join(PENDING)).expect("a crash file");
        assert!(report.contains("exception: STACK_OVERFLOW (0xC00000FD)"), "{report}");
        assert!(report.contains("execute_tool read"), "{report}");
        assert!(report.contains("child-before-overflow"), "{report}");
        assert!(report.contains("MB reserved"), "{report}");
        assert!(report.contains("frames, innermost first"), "{report}");
        // And the next start finds it.
        let found = take_crash_report(&dir).expect("the report is found at the next start");
        assert!(found.contains("STACK_OVERFLOW"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
