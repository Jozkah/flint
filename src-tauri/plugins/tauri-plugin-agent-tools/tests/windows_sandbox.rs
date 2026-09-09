//! Real Windows sandbox scenarios, driven through the production helper.
//!
//! These are not unit tests of a pure function. Each one starts a genuinely
//! confined process with the same code path a `bash` tool call takes, and
//! asserts on what actually happened -- including the two things that were
//! wrong before: `CreateProcessW` failing with `ERROR_ENVVAR_NOT_FOUND` (203)
//! because the environment block lacked `LOCALAPPDATA`, and the resulting
//! message blaming a Git installation that was sitting in `C:\Program Files`.
//!
//! Everything is written under a per-run temporary directory. Nothing touches
//! the user's profile, and nothing kills a process this test did not start.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tauri_plugin_agent_tools::tools::appcontainer;

/// The confined-spawn helper cargo built for this test run.
const HELPER: &str = env!("CARGO_BIN_EXE_jan-sandbox-helper");

/// A workspace and scratch for one scenario, under the system temp directory.
struct Sandbox {
    root: PathBuf,
    workspace: PathBuf,
    scratch: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "jan-sandbox-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let workspace = root.join("workspace");
        let scratch = root.join("scratch");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::create_dir_all(&scratch).expect("scratch");
        Self {
            root,
            workspace,
            scratch,
        }
    }

    /// Run `command` in the sandbox with `program`, and return what happened.
    fn run(&self, program: &Path, args: &[&str], allow_network: bool) -> Output {
        let argv = appcontainer::helper_args(
            &self.workspace,
            Some(&self.scratch),
            allow_network,
            program,
            &args.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
        );
        Command::new(HELPER)
            .args(&argv)
            .output()
            .expect("the helper should start")
    }

    fn cmd(&self, command: &str) -> Output {
        self.run(&cmd_exe(), &["/C", command], false)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        // Best effort: the container's own ACE can leave a directory the test
        // user still owns, and a leftover temp directory must not fail a run.
        let _ = std::fs::remove_dir_all(&self.root);
        appcontainer::release(&self.workspace);
    }
}

fn cmd_exe() -> PathBuf {
    std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"))
}

/// The Git for Windows bash the bug report named, when this machine has one.
fn program_files_git_bash() -> Option<PathBuf> {
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(base) = std::env::var_os(var) {
            let candidate = PathBuf::from(base).join("Git").join("bin").join("bash.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Scenario 5: the sandbox shell starts, prints a harmless value and exits.
///
/// This is the whole of what was broken. Before the environment block was built
/// explicitly, this failed with `ERROR_ENVVAR_NOT_FOUND` (203) and no process
/// was created at all.
#[test]
fn a_sandboxed_shell_runs_a_harmless_command_and_exits() {
    let sandbox = Sandbox::new("harmless");
    let out = sandbox.cmd("cd & echo probe-ok");
    let seen = text(&out);
    assert!(
        seen.contains("probe-ok"),
        "the sandboxed shell did not run: {seen}"
    );
    assert_eq!(out.status.code(), Some(0), "{seen}");
}

/// The regression itself, named: no launch reports error 203 any more.
#[test]
fn the_environment_block_no_longer_fails_process_creation() {
    let sandbox = Sandbox::new("env203");
    let seen = text(&sandbox.cmd("echo ok"));
    assert!(
        !seen.contains("os error 203") && !seen.contains("environment option"),
        "the 203 failure is back: {seen}"
    );
}

/// Scenario 3/5: the working directory is the workspace, not wherever the
/// helper happened to be started from.
#[test]
fn the_sandbox_starts_in_the_workspace() {
    let sandbox = Sandbox::new("cwd");
    let seen = text(&sandbox.cmd("cd"));
    let workspace = sandbox.workspace.to_string_lossy().to_lowercase();
    assert!(
        seen.to_lowercase().contains(&workspace),
        "expected the workspace {workspace} in: {seen}"
    );
}

/// Scenario 6: workspace writes succeed.
#[test]
fn writes_inside_the_workspace_succeed() {
    let sandbox = Sandbox::new("write-in");
    let out = sandbox.cmd("echo written > inside.txt");
    assert_eq!(out.status.code(), Some(0), "{}", text(&out));
    let written = sandbox.workspace.join("inside.txt");
    assert!(
        written.is_file(),
        "the sandbox could not write its workspace"
    );
    assert!(std::fs::read_to_string(&written)
        .expect("read back")
        .contains("written"));
}

/// Scenario 7: writes outside the workspace and scratch are refused.
#[test]
fn writes_outside_the_workspace_are_refused() {
    let sandbox = Sandbox::new("write-out");
    // The parent of the workspace is granted nothing, so this must fail even
    // though the test user owns it.
    let outside = sandbox.root.join("escaped.txt");
    let out = sandbox.cmd(r"echo escaped > ..\escaped.txt");
    assert!(
        !outside.exists(),
        "the sandbox wrote outside its workspace: {}",
        outside.display()
    );
    assert_ne!(out.status.code(), Some(0), "{}", text(&out));
}

/// Scenario 8: the real home stays unreadable.
#[test]
fn the_real_user_profile_is_unreadable_from_the_sandbox() {
    let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) else {
        return;
    };
    // A file the test user can certainly read, placed in their own profile only
    // for the length of this test.
    let marker = profile.join(format!("jan-sandbox-probe-{}.txt", std::process::id()));
    if std::fs::write(&marker, "host-only").is_err() {
        // A machine where the profile is not writable proves the same thing a
        // different way; there is nothing to assert against.
        return;
    }
    let sandbox = Sandbox::new("home");
    let out = sandbox.cmd(&format!("type \"{}\"", marker.display()));
    let seen = text(&out);
    let _ = std::fs::remove_file(&marker);
    assert!(
        !seen.contains("host-only"),
        "the sandbox read the user's real profile: {seen}"
    );
}

/// The synthetic home is what the sandbox is told about, and it is not the
/// user's.
///
/// Compared as whole values rather than by substring: the scratch itself lives
/// under `%LOCALAPPDATA%\Temp`, so "the profile path appears somewhere in the
/// output" is true of a correct answer too.
#[test]
fn the_sandbox_gets_its_own_home() {
    let sandbox = Sandbox::new("synthetic-home");
    let out = sandbox.cmd("echo %USERPROFILE% & echo %HOME% & echo %APPDATA%");
    let seen = text(&out);
    let expected = sandbox
        .scratch
        .join("home")
        .to_string_lossy()
        .to_lowercase();
    let real = std::env::var("USERPROFILE")
        .unwrap_or_default()
        .to_lowercase();
    let values: Vec<String> = seen
        .lines()
        .map(|line| line.trim().to_lowercase())
        .filter(|line| !line.is_empty())
        .collect();
    assert_eq!(values.len(), 3, "expected three values: {seen}");
    for value in &values {
        assert_eq!(value, &expected, "not the sandbox home: {seen}");
        assert_ne!(value, &real, "the real profile was handed over: {seen}");
    }
}

/// Scenario 9: network stays off when the policy says so.
///
/// An AppContainer without the `internetClient` capability cannot open an
/// outbound socket at all, so the failure is at connect time rather than a
/// refused response.
#[test]
fn the_network_is_denied_when_the_policy_denies_it() {
    let sandbox = Sandbox::new("net-off");
    // `-n 1` keeps it to a single attempt; a denied container fails immediately.
    let out = sandbox.run(
        &cmd_exe(),
        &["/C", "ping -n 1 -w 1000 127.0.0.1 && echo reached"],
        false,
    );
    let seen = text(&out);
    assert!(
        !seen.contains("reached"),
        "the sandbox reached the network with it denied: {seen}"
    );
}

/// Scenarios 4 and 11, which are the bug report itself.
///
/// Git Bash under `C:\Program Files` is reachable, readable and executable by
/// the container -- Windows grants `ALL APPLICATION PACKAGES` read+execute
/// there. It still cannot run, because the MSYS2 runtime it is built on cannot
/// initialise inside an AppContainer. What this test pins down is that the
/// failure is now reported as what it is: after process creation, at runtime
/// startup, naming the runtime -- and never as a Git installed under the user's
/// profile.
#[test]
fn program_files_git_bash_is_never_blamed_on_a_user_profile_install() {
    let Some(bash) = program_files_git_bash() else {
        return;
    };
    let sandbox = Sandbox::new("git-bash");
    let out = sandbox.run(&bash, &["-c", "pwd && echo probe-ok"], false);
    let seen = text(&out);

    assert!(
        !seen.contains("under your user profile"),
        "the false user-profile diagnosis is back: {seen}"
    );
    assert!(
        !seen.contains("install Git for Windows system-wide"),
        "the sandbox told the user to reinstall a Git that is already \
         system-wide: {seen}"
    );
    assert!(
        !seen.contains("os error 203"),
        "the environment failure is back: {seen}"
    );

    if seen.contains("probe-ok") {
        // A future Windows (or a non-MSYS bash) that can run it: nothing to
        // diagnose, and the scenario is satisfied by it simply working.
        assert_eq!(out.status.code(), Some(0), "{seen}");
        return;
    }
    assert!(
        seen.contains("stage=runtime-startup"),
        "a failure after process creation should say so: {seen}"
    );
    assert!(
        seen.contains("after_process_creation=true"),
        "the report should distinguish a refused spawn from a failed \
         startup: {seen}"
    );
    assert!(
        seen.contains("MSYS2"),
        "the report should name the runtime that could not start: {seen}"
    );
}

/// Scenario 12: the helper only ever waits on the one process it created. A
/// scenario that runs a long command and then drops the handle must not take
/// anything else with it, so this asserts the obvious floor -- an unrelated
/// process started by this test outlives a completed sandbox run.
#[test]
fn a_sandbox_run_does_not_touch_unrelated_processes() {
    let mut bystander = Command::new(cmd_exe())
        .args(["/C", "ping -n 4 -w 1000 127.0.0.1 > NUL"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("bystander");
    {
        let sandbox = Sandbox::new("bystander");
        let out = sandbox.cmd("echo ok");
        assert_eq!(out.status.code(), Some(0), "{}", text(&out));
    }
    assert!(
        matches!(bystander.try_wait(), Ok(None)),
        "a sandbox run killed a process it did not start"
    );
    let _ = bystander.kill();
    let _ = bystander.wait();
}

/// Diagnostics carry names and stages, never values. A secret exported into the
/// Jan process must not appear anywhere in a sandbox report.
#[test]
fn diagnostics_never_carry_environment_values() {
    let sandbox = Sandbox::new("redaction");
    let argv = appcontainer::helper_args(
        &sandbox.workspace,
        Some(&sandbox.scratch),
        false,
        Path::new(r"C:\this\does\not\exist\shell.exe"),
        &["-c".to_string(), "echo hi".to_string()],
    );
    let out = Command::new(HELPER)
        .args(&argv)
        .env("JAN_SANDBOX_DEBUG", "1")
        .env("MY_TEST_API_KEY", "sk-should-never-appear")
        .output()
        .expect("helper runs");
    let seen = text(&out);
    assert!(
        !seen.contains("sk-should-never-appear"),
        "a secret reached the diagnostics: {seen}"
    );
    assert!(
        seen.contains("the shell does not exist"),
        "a missing shell should be reported as a missing shell: {seen}"
    );
}
