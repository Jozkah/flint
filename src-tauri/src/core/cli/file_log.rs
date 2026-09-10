//! Persistent log file beside the stderr logger.
//!
//! Adapted from janhq/jan#8713 (thinhlpg). `env_logger` is a single-sink,
//! single-level logger, so it cannot write the same records to stderr at one
//! verbosity and to a file at another. [`DualLogger`] keeps `env_logger`'s
//! stderr behaviour (style, module paths, `RUST_LOG` filtering) and also
//! appends every `info`-and-above record to a rotating plain-ASCII file at
//! `<data folder>/logs/jan.log`, so a frozen or misbehaving agent run leaves a
//! trail on disk without the user having to pass `-v`.
//!
//! The file is local and stays local: nothing reads it except the user and
//! `jan bug-report`, which only ever writes an archive the user asked for.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use log::{LevelFilter, Log, Metadata, Record};

/// What the file always captures, on top of the `warn` stderr default.
const FILE_LEVEL: LevelFilter = LevelFilter::Info;
/// Rotate once the active segment crosses this size.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
/// Backup segments kept beside the active file (`jan.log.1` .. `jan.log.N`).
/// `doctor` reads the same bound when it tails across rotated segments.
pub(crate) const KEEP_SEGMENTS: u32 = 3;
pub(crate) const LOG_FILE: &str = "jan.log";

/// Whether the stderr sink may write. The TUI owns the terminal once it enters
/// the alternate screen, so a stray `warn` from a dependency would paint over
/// the frame; it mutes stderr for the duration. Muting the `log` facade
/// instead (`set_max_level(Off)`) would silence the file too -- and the
/// interactive session is exactly the one a bug report needs a trail for.
static STDERR_ENABLED: AtomicBool = AtomicBool::new(true);

/// Mute or unmute the stderr sink without touching the file sink. Returns the
/// previous value so a caller can restore it.
pub fn set_stderr_enabled(on: bool) -> bool {
    STDERR_ENABLED.swap(on, Ordering::Relaxed)
}

/// Where the log lives for a data folder.
pub fn log_path(data_folder: &Path) -> PathBuf {
    data_folder.join("logs").join(LOG_FILE)
}

/// The segment path for a 1-based backup number; `0` means the active file.
pub(crate) fn segment_path(base: &Path, k: u32) -> PathBuf {
    if k == 0 {
        base.to_path_buf()
    } else {
        base.with_file_name(format!("{LOG_FILE}.{k}"))
    }
}

/// Append-only handle to the active log file with size-based rotation.
struct FileLog {
    path: PathBuf,
    file: Mutex<File>,
    len: AtomicU64,
}

impl FileLog {
    /// Open the active file for appending. `None` (stderr only) when it cannot
    /// be opened: a trail is worth having, never worth failing the run over.
    fn new(path: PathBuf) -> Option<Self> {
        fs::create_dir_all(path.parent()?).ok()?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        Some(FileLog {
            path,
            file: Mutex::new(file),
            len: AtomicU64::new(len),
        })
    }

    fn write(&self, record: &Record) {
        let line = format_line(record);
        let mut f = match self.file.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if f.write_all(line.as_bytes()).is_err() {
            return;
        }
        let new_len = self.len.fetch_add(line.len() as u64, Ordering::Relaxed) + line.len() as u64;
        if new_len >= MAX_LOG_BYTES {
            // Release the handle first so the rename works on Windows too.
            drop(f);
            self.rotate();
            if let Ok(nf) = OpenOptions::new().create(true).append(true).open(&self.path) {
                if let Ok(mut g) = self.file.lock() {
                    *g = nf;
                }
            }
        }
    }

    /// Shift `jan.log{,.1,.2}` down one slot and start a fresh active file.
    ///
    /// `len` counts only what this process wrote plus the size it saw at open,
    /// so several `jan` processes sharing a data folder each reach the
    /// threshold on their own. If the active file is already small another
    /// process just rotated it, and shifting again would discard a live
    /// segment; resync the counter instead.
    fn rotate(&self) {
        if let Ok(actual) = fs::metadata(&self.path).map(|m| m.len()) {
            if actual < MAX_LOG_BYTES {
                self.len.store(actual, Ordering::Relaxed);
                return;
            }
        }
        for k in (2..=KEEP_SEGMENTS).rev() {
            let _ = fs::rename(segment_path(&self.path, k - 1), segment_path(&self.path, k));
        }
        let _ = fs::rename(&self.path, segment_path(&self.path, 1));
        self.len.store(0, Ordering::Relaxed);
    }

    fn flush(&self) {
        if let Ok(mut f) = self.file.lock() {
            let _ = f.flush();
        }
    }
}

/// One line per record, plain ASCII, timestamped, never coloured.
///
/// The message is scrubbed on the way in. The text reaching the file is not
/// all ours: an upstream error can echo the request's `Authorization` header,
/// and a user can paste a key into a prompt. Scrubbing here rather than at
/// each `log::` call means a breadcrumb added later cannot reintroduce the
/// leak, and it leaves the stderr sink -- the operator's own terminal --
/// untouched.
fn format_line(record: &Record) -> String {
    let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
    let message = record.args().to_string();
    format!(
        "{ts} {:<5} [{}] {}\n",
        record.level().as_str(),
        record.target(),
        crate::core::cli::secrets::SHARED.scrub(&message)
    )
}

/// Routes every record to stderr through `env_logger` (unchanged behaviour)
/// and, in parallel, to the rotating file.
struct DualLogger {
    stderr: env_logger::Logger,
    file: Option<FileLog>,
}

impl Log for DualLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        (STDERR_ENABLED.load(Ordering::Relaxed) && self.stderr.enabled(metadata))
            || (self.file.is_some() && metadata.level() <= FILE_LEVEL)
    }

    fn log(&self, record: &Record) {
        // The file captures info and above regardless of RUST_LOG, and is not
        // gated on STDERR_ENABLED: a muted terminal still leaves a trail.
        if let Some(f) = &self.file {
            if record.level() <= FILE_LEVEL {
                f.write(record);
            }
        }
        if STDERR_ENABLED.load(Ordering::Relaxed) {
            self.stderr.log(record);
        }
    }

    fn flush(&self) {
        self.stderr.flush();
        if let Some(f) = &self.file {
            f.flush();
        }
    }
}

/// The facade gate: whatever the deepest sink wants, and no more, so a
/// dependency's debug record is still rejected by the cheap static check.
fn ceiling(stderr: LevelFilter) -> LevelFilter {
    stderr.max(FILE_LEVEL)
}

/// Install the dual logger as the process-wide `log` backend. `verbose`
/// mirrors `-v/--verbose`: it raises the stderr threshold to `info`; the file
/// always captures `info`.
pub fn init(data_folder: PathBuf, verbose: bool) {
    let default = if verbose { "info" } else { "warn" };
    let stderr =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(default)).build();
    let file = FileLog::new(log_path(&data_folder));
    let gate = ceiling(stderr.filter());
    let _ = log::set_boxed_logger(Box::new(DualLogger { stderr, file }));
    log::set_max_level(gate);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// `STDERR_ENABLED` is process-global, so the test that toggles it must
    /// not overlap the ones that read `enabled()`.
    static STDERR_GATE: Mutex<()> = Mutex::new(());

    /// A directory only this test owns, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            static N: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "jan-file-log-{tag}-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(dir.join("logs")).unwrap();
            Scratch(dir)
        }

        fn log(&self) -> PathBuf {
            log_path(&self.0)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record_to(log: &FileLog, level: log::Level, message: std::fmt::Arguments) {
        log.write(
            &Record::builder()
                .args(message)
                .level(level)
                .target(module_path!())
                .build(),
        );
    }

    #[test]
    fn file_log_writes_info_records_with_timestamp() {
        let dir = Scratch::new("info");
        {
            let log = FileLog::new(dir.log()).expect("opens log");
            record_to(&log, log::Level::Info, format_args!("hello {} {}", 1, 2));
            log.flush();
        }
        let content = fs::read_to_string(dir.log()).unwrap();
        assert!(content.contains("hello 1 2"), "content: {content}");
        assert!(content.contains("INFO"), "level label: {content}");
        assert!(content.starts_with("20"), "timestamp leads: {content}");
    }

    /// A provider echoed the request's `Authorization` header inside its error
    /// body; the agent logged that error, and the raw key landed in the file.
    #[test]
    fn file_log_scrubs_a_credential_out_of_a_record() {
        let dir = Scratch::new("secret");
        let secret = "sk-live-11112222333344445555";
        {
            let log = FileLog::new(dir.log()).expect("opens log");
            record_to(
                &log,
                log::Level::Info,
                format_args!(
                    "agent: run finished outcome=error -- Body: \
                     {{\"message\":\"authorization: Bearer {secret}\"}}"
                ),
            );
            log.flush();
        }
        let content = fs::read_to_string(dir.log()).unwrap();
        assert!(!content.contains(secret), "credential reached the file: {content}");
        assert!(content.contains("<redacted>"), "redaction is marked: {content}");
        assert!(content.contains("outcome=error"), "the breadcrumb survives: {content}");
    }

    /// When one process rotates, the others still believe the active file is
    /// full; rotating an already-fresh file again would shift real history
    /// off the end.
    #[test]
    fn rotate_resyncs_instead_of_shifting_an_already_rotated_file() {
        let dir = Scratch::new("rotate");
        let path = dir.log();
        fs::write(segment_path(&path, 1), "rotated-by-a-peer\n").unwrap();
        fs::write(&path, "fresh\n").unwrap();

        let log = FileLog::new(path.clone()).expect("opens log");
        log.len.store(MAX_LOG_BYTES, Ordering::Relaxed);
        log.rotate();

        assert_eq!(
            fs::read_to_string(segment_path(&path, 1)).unwrap(),
            "rotated-by-a-peer\n"
        );
        assert!(!segment_path(&path, 2).exists(), "no redundant shift happened");
        assert_eq!(log.len.load(Ordering::Relaxed), "fresh\n".len() as u64);
    }

    /// A full active file is shifted to `.1` and a fresh one started.
    #[test]
    fn a_full_log_rotates_into_the_first_segment() {
        let dir = Scratch::new("full");
        let path = dir.log();
        fs::write(&path, "x".repeat(MAX_LOG_BYTES as usize)).unwrap();
        {
            let log = FileLog::new(path.clone()).expect("opens log");
            record_to(&log, log::Level::Info, format_args!("tips it over"));
            log.flush();
        }
        let first = fs::read_to_string(segment_path(&path, 1)).unwrap();
        assert!(first.ends_with("tips it over\n"), "the full file became .1");
        assert_eq!(fs::metadata(&path).unwrap().len(), 0, "a fresh active file");
    }

    fn metadata(level: log::Level) -> log::Metadata<'static> {
        log::Metadata::builder().level(level).target(module_path!()).build()
    }

    #[test]
    fn dual_logger_delegates_stderr_verbosity_but_caps_file_at_info() {
        let _gate = STDERR_GATE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = Scratch::new("dual");
        {
            let dual = DualLogger {
                stderr: env_logger::Builder::new()
                    .filter_level(LevelFilter::Trace)
                    .build(),
                file: Some(FileLog::new(dir.log()).expect("opens log")),
            };
            assert!(dual.enabled(&metadata(log::Level::Debug)));
            assert!(dual.enabled(&metadata(log::Level::Trace)));
            for (level, text) in [
                (log::Level::Info, "info line"),
                (log::Level::Debug, "debug line"),
                (log::Level::Trace, "trace line"),
            ] {
                // Printed to this test's own stderr, which the harness captures.
                dual.log(
                    &Record::builder()
                        .args(format_args!("{text}"))
                        .level(level)
                        .target(module_path!())
                        .build(),
                );
            }
            dual.flush();
        }
        let content = fs::read_to_string(dir.log()).unwrap();
        assert!(content.contains("info line"));
        assert!(!content.contains("debug line"), "debug leaked to file: {content}");
        assert!(!content.contains("trace line"), "trace leaked to file: {content}");
    }

    #[test]
    fn dual_logger_file_does_not_broaden_a_warn_stderr() {
        let _gate = STDERR_GATE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = Scratch::new("warn");
        let dual = DualLogger {
            stderr: env_logger::Builder::new().filter_level(LevelFilter::Warn).build(),
            file: Some(FileLog::new(dir.log()).expect("opens log")),
        };
        assert!(dual.enabled(&metadata(log::Level::Info)));
        assert!(!dual.enabled(&metadata(log::Level::Debug)));
    }

    /// The TUI mutes stderr for the whole interactive session; the file must
    /// keep recording.
    #[test]
    fn muting_stderr_keeps_the_file_sink_writing() {
        let _gate = STDERR_GATE.lock().unwrap_or_else(|e| e.into_inner());
        let dir = Scratch::new("mute");
        {
            let dual = DualLogger {
                stderr: env_logger::Builder::new().filter_level(LevelFilter::Warn).build(),
                file: Some(FileLog::new(dir.log()).expect("opens log")),
            };
            let prev = set_stderr_enabled(false);
            assert!(dual.enabled(&metadata(log::Level::Info)));
            dual.log(
                &Record::builder()
                    .args(format_args!("muted but recorded"))
                    .level(log::Level::Info)
                    .target(module_path!())
                    .build(),
            );
            dual.flush();
            set_stderr_enabled(prev);
        }
        let content = fs::read_to_string(dir.log()).unwrap();
        assert!(content.contains("muted but recorded"), "{content}");
    }

    #[test]
    fn the_gate_sits_at_the_deepest_sink_not_wider() {
        assert_eq!(ceiling(LevelFilter::Warn), FILE_LEVEL);
        assert_eq!(ceiling(LevelFilter::Debug), LevelFilter::Debug);
        assert_eq!(ceiling(LevelFilter::Off), FILE_LEVEL);
    }
}
