//! Best-effort browser launch, shared by `/login` (Tokamak sign-in) and the
//! `/mcp` OAuth flow.
//!
//! Every caller prints the URL as well, because a spawned launcher reports
//! nothing about whether a page actually appeared: `Err` here is a reason to
//! *say* "open this yourself", never a reason to abandon the flow.

/// Hand `url` to the platform's opener. `Err` carries a reason worth showing
/// the user, not a failure to recover from.
pub fn open(url: &str) -> Result<(), String> {
    if cfg!(test) {
        // A test run must never take over the developer's browser.
        return Err("browser launch is disabled under test".to_string());
    }
    launch(url)
}

/// The Windows opener. Not `cmd /C start`: cmd.exe re-parses its command
/// line, and Rust only quotes an argument holding whitespace or a quote, so an
/// OAuth URL (all `&`-joined query parameters, never a space) reached cmd bare
/// and was cut at the first `&` -- the browser opened without `client_id`,
/// `redirect_uri` or `state`. `url.dll`'s handler takes the URL as one argv
/// element with no shell in between.
#[cfg(any(target_os = "windows", test))]
const WINDOWS_LAUNCHER: (&str, &[&str]) = ("rundll32", &["url.dll,FileProtocolHandler"]);

/// The program and leading arguments that open a URL on this platform; the
/// URL follows as the final, separate argument.
pub(crate) fn platform_launcher() -> (&'static str, &'static [&'static str]) {
    #[cfg(target_os = "macos")]
    let launcher: (&'static str, &'static [&'static str]) = ("open", &[]);
    #[cfg(target_os = "windows")]
    let launcher = WINDOWS_LAUNCHER;
    #[cfg(all(unix, not(target_os = "macos")))]
    let launcher: (&'static str, &'static [&'static str]) = ("xdg-open", &[]);
    launcher
}

fn launch(url: &str) -> Result<(), String> {
    let (program, args) = platform_launcher();

    #[cfg(all(unix, not(target_os = "macos")))]
    if !has_display() {
        return Err("no graphical session detected".to_string());
    }

    std::process::Command::new(program)
        .args(args)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not launch {program}: {e}"))
}

/// Whether a Linux/BSD session has a display server to open a browser on. Over
/// SSH or in a container `xdg-open` would either fail noisily or block, so the
/// caller falls back to printing the URL.
#[cfg(all(unix, not(target_os = "macos")))]
fn has_display() -> bool {
    ["WAYLAND_DISPLAY", "DISPLAY"]
        .iter()
        .any(|var| std::env::var_os(var).is_some_and(|v| !v.is_empty()))
}

#[cfg(test)]
mod launcher_tests {
    use super::*;

    /// #59: the Windows opener must not route the URL through cmd.exe, whose
    /// parser splits an unquoted command line at `&`.
    #[test]
    fn the_windows_opener_does_not_go_through_cmd() {
        let (program, args) = WINDOWS_LAUNCHER;
        assert!(!program.eq_ignore_ascii_case("cmd"));
        assert!(!args.iter().any(|a| a.eq_ignore_ascii_case("start")));
        // The URL is appended as its own argument, intact.
        let url = "https://claude.ai/oauth/authorize?response_type=code&client_id=x&state=y";
        let mut cmd = std::process::Command::new(program);
        cmd.args(args).arg(url);
        assert_eq!(cmd.get_args().last().unwrap(), url);
    }
}
