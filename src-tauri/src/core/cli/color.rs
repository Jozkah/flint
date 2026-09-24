//! Whether the headless CLI may color its stderr lines.
//!
//! Colour is off when `NO_COLOR` is set, when `CLICOLOR=0`, or when stderr is
//! not a terminal (piped, redirected, CI logs). `CLICOLOR_FORCE` or
//! `FORCE_COLOR` (any value other than empty or `0`) turns it back on. On
//! Windows the console must also accept virtual-terminal sequences; a legacy
//! console that refuses them gets plain text.

use std::fmt::Display;
use std::io::IsTerminal;
use std::sync::OnceLock;

/// The decision for this process, made once on first use.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        let forced = forced(|k| std::env::var(k).ok());
        let wanted = decide(|k| std::env::var(k).ok(), std::io::stderr().is_terminal());
        // Try VT even when forced, but a forced run keeps color if it fails.
        wanted && (enable_virtual_terminal() || forced)
    })
}

/// `text` wrapped in the SGR `code` (e.g. "2" dim, "33" yellow, "31" red)
/// when color is enabled, otherwise `text` unchanged.
pub fn paint(code: &str, text: impl Display) -> String {
    paint_with(enabled(), code, text)
}

fn paint_with(color: bool, code: &str, text: impl Display) -> String {
    if color {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

fn set(value: Option<String>) -> bool {
    value.is_some_and(|v| !v.is_empty() && v != "0")
}

fn forced(env: impl Fn(&str) -> Option<String>) -> bool {
    set(env("CLICOLOR_FORCE")) || set(env("FORCE_COLOR"))
}

/// The environment and terminal part of the decision, separate from the
/// Windows console call so it can be tested.
fn decide(env: impl Fn(&str) -> Option<String>, stderr_is_terminal: bool) -> bool {
    if env("NO_COLOR").is_some_and(|v| !v.is_empty()) {
        return false;
    }
    if forced(&env) {
        return true;
    }
    if env("CLICOLOR").as_deref() == Some("0") {
        return false;
    }
    stderr_is_terminal
}

#[cfg(windows)]
fn enable_virtual_terminal() -> bool {
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
        STD_ERROR_HANDLE,
    };
    // SAFETY: plain Win32 calls on the process's own stderr handle; `mode` is
    // a valid out pointer for the duration of the call.
    unsafe {
        let handle = GetStdHandle(STD_ERROR_HANDLE);
        let mut mode = 0;
        if GetConsoleMode(handle, &mut mode) == 0 {
            return false;
        }
        if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
            return true;
        }
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0
    }
}

#[cfg(not(windows))]
fn enable_virtual_terminal() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn a_terminal_gets_color_by_default() {
        assert!(decide(env(&[]), true));
    }

    #[test]
    fn a_pipe_or_redirect_gets_no_color() {
        assert!(!decide(env(&[]), false));
    }

    #[test]
    fn no_color_and_clicolor_zero_turn_it_off_even_on_a_terminal() {
        assert!(!decide(env(&[("NO_COLOR", "1")]), true));
        assert!(!decide(env(&[("CLICOLOR", "0")]), true));
        // An empty NO_COLOR does not count, per no-color.org.
        assert!(decide(env(&[("NO_COLOR", "")]), true));
    }

    #[test]
    fn force_turns_it_on_for_a_pipe_but_not_over_no_color() {
        assert!(decide(env(&[("FORCE_COLOR", "1")]), false));
        assert!(decide(env(&[("CLICOLOR_FORCE", "1")]), false));
        assert!(!decide(env(&[("FORCE_COLOR", "0")]), false));
        assert!(!decide(
            env(&[("NO_COLOR", "1"), ("FORCE_COLOR", "1")]),
            true
        ));
    }

    #[test]
    fn plain_output_has_no_escape_bytes() {
        let line = paint_with(false, "33", format_args!("[permission] {}", "x"));
        assert_eq!(line, "[permission] x");
        assert!(!line.contains('\x1b'));
        assert_eq!(paint_with(true, "2", "t"), "\x1b[2mt\x1b[0m");
    }
}
