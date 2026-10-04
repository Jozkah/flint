//! Evidence for a crash, in the log the app already keeps.
//!
//! A desktop app that dies leaves nothing: a Rust panic goes to a standard error
//! nobody sees, and a hard exit leaves no line at all, so a report of "it
//! crashed" arrives with a log that simply stops. Two small things change that.
//!
//! * A panic hook writes the panic, its place, its thread and a backtrace to the
//!   log before the default hook runs.
//! * A marker file in the data folder says "running". It is written at start
//!   and removed by the clean shutdown path. Finding it at the next start means
//!   the previous run did not shut down cleanly (it crashed, was killed, or the
//!   power went), which the log then says in one warning, with when it started.
//!
//! Neither changes how the app behaves.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MARKER: &str = "running.flag";

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

fn marker_path(data_folder: &Path) -> PathBuf {
    data_folder.join(MARKER)
}

/// Record that a run has started. Returns what the marker said if an earlier
/// run left it behind, which is a run that did not shut down cleanly.
pub fn mark_started(data_folder: &Path) -> Option<String> {
    let path = marker_path(data_folder);
    let earlier = std::fs::read_to_string(&path).ok();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::write(
        &path,
        format!("process {} started at unix time {now}, version {}", std::process::id(), env!("CARGO_PKG_VERSION")),
    );
    earlier.map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

/// Record a clean shutdown.
pub fn mark_clean_exit(data_folder: &Path) {
    let _ = std::fs::remove_file(marker_path(data_folder));
}

/// The warning for a run that did not shut down cleanly.
pub fn unclean_message(earlier: &str) -> String {
    format!(
        "the previous run did not shut down cleanly ({earlier}): it crashed, was ended, or the computer lost power. \
         If it crashed, Windows keeps a record under Event Viewer, Windows Logs, Application, source 'Application Error', \
         and a dump in %LOCALAPPDATA%\\CrashDumps."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flint-crash-trace-{name}-{}", std::process::id()));
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
        // No clean exit: the next start finds the marker.
        let earlier = mark_started(&dir).expect("the earlier run's marker");
        assert!(earlier.contains("started at unix time"), "{earlier}");
        assert!(unclean_message(&earlier).contains("did not shut down cleanly"));
        mark_clean_exit(&dir);
        assert_eq!(mark_started(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_is_not_an_error() {
        let dir = std::env::temp_dir().join("flint-crash-trace-does-not-exist-9d2");
        assert_eq!(mark_started(&dir), None);
        mark_clean_exit(&dir);
    }
}
