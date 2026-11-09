//! Windows: a crashed child exits instead of waiting in a dialog.
//!
//! A crashing llama-server or engine worker otherwise sits in a Windows Error
//! Reporting ("has stopped working") or critical-error dialog. Nobody sees that
//! dialog for a windowless background process, and while it is up the dead
//! process keeps its port, so every retry against it hangs.
//!
//! The error mode is per process and a child inherits it unless created with
//! `CREATE_DEFAULT_ERROR_MODE`, which Flint never passes. So setting it once at
//! start, before anything is spawned, covers every engine process. A process's
//! own crash handler (an unhandled-exception filter) still runs first.

/// The error-mode bits [`suppress_crash_dialogs`] adds.
#[cfg(windows)]
pub const QUIET_ERROR_MODE: u32 = {
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX,
    };
    SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
};

/// Add [`QUIET_ERROR_MODE`] to this process's error mode, keeping bits already
/// set. Call from `main`, before any child is spawned.
#[cfg(windows)]
pub fn suppress_crash_dialogs() {
    use windows_sys::Win32::System::Diagnostics::Debug::{GetErrorMode, SetErrorMode};
    // SAFETY: both calls only read or replace this process's error-mode flags.
    unsafe {
        SetErrorMode(GetErrorMode() | QUIET_ERROR_MODE);
    }
}

/// Nothing to do: no other platform puts a crash dialog in front of a child.
#[cfg(not(windows))]
pub fn suppress_crash_dialogs() {}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Diagnostics::Debug::{
        GetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX,
    };

    #[test]
    fn crash_dialogs_are_suppressed_and_existing_bits_kept() {
        // SAFETY: reads this process's error-mode flags.
        let before = unsafe { GetErrorMode() };
        suppress_crash_dialogs();
        // SAFETY: as above.
        let after = unsafe { GetErrorMode() };
        assert_eq!(after & before, before, "bits already set are kept");
        assert_eq!(after & QUIET_ERROR_MODE, QUIET_ERROR_MODE);
        assert_ne!(after & SEM_NOGPFAULTERRORBOX, 0);
        assert_ne!(after & SEM_FAILCRITICALERRORS, 0);
    }

    /// The point of setting it in the parent: a child started the way Flint
    /// starts its engine processes runs with the same mode. The child is this
    /// test binary, asked to print its own mode.
    #[test]
    fn a_spawned_child_inherits_the_mode() {
        if let Ok(expected) = std::env::var("FLINT_ERROR_MODE_PROBE") {
            // SAFETY: reads this process's error-mode flags.
            let mode = unsafe { GetErrorMode() };
            let expected: u32 = expected.parse().unwrap();
            assert_eq!(mode & expected, expected, "child mode {mode:#x}");
            return;
        }
        suppress_crash_dialogs();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "error_mode::tests::a_spawned_child_inherits_the_mode", "--nocapture"])
            .env("FLINT_ERROR_MODE_PROBE", QUIET_ERROR_MODE.to_string())
            .status()
            .unwrap();
        assert!(status.success(), "the child did not inherit the error mode");
    }
}
