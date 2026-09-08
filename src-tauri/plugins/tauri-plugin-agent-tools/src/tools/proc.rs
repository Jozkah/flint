//! Process-group-aware shell spawning and whole-tree termination for the `bash`
//! tool. Every command runs as its own process-group leader so a timeout,
//! cancel, or app shutdown can reap the entire descendant tree, not just the
//! top-level shell. Without this, any command that spawns children (a build, a
//! `foo &`, a pipeline) leaks orphans when the run is torn down.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use tokio::process::{Child, Command};

/// How to invoke the host shell. `program` + `args` are fixed; the command
/// string is appended as the final argv element, or piped to stdin when
/// `via_stdin` is set (legacy WSL `bash.exe`, which cannot take `-c`).
/// `description` names the shell for the model (e.g. git-bash vs `cmd`), so it
/// can adapt command syntax instead of assuming POSIX bash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub via_stdin: bool,
    /// A short human-readable name of the resolved shell, for the model.
    pub description: &'static str,
}

/// Resolved shell for this process, computed once. Prefers a real `bash`
/// (matching the tool's name and documented guidance) and falls back to a
/// POSIX `sh`/`cmd` only when no bash is found.
pub fn shell() -> &'static ShellConfig {
    static SHELL: OnceLock<ShellConfig> = OnceLock::new();
    SHELL.get_or_init(resolve_shell)
}

fn c(program: &str, args: &[&str], description: &'static str) -> ShellConfig {
    ShellConfig {
        program: PathBuf::from(program),
        args: args.iter().map(|s| s.to_string()).collect(),
        via_stdin: false,
        description,
    }
}

fn resolve_shell() -> ShellConfig {
    if let Some(path) = std::env::var_os("JAN_AGENT_SHELL") {
        let p = PathBuf::from(&path);
        if p.exists() {
            return ShellConfig {
                program: p,
                args: vec!["-c".to_string()],
                via_stdin: false,
                description: "custom",
            };
        }
    }
    #[cfg(unix)]
    {
        // Prefer the bash on `PATH` over the fixed `/bin/bash`: on NixOS the
        // shell lives only at a Nix-store path resolved via `which`, so a
        // hardcoded `/bin/bash` does not exist there and the fixed path would be
        // wrong.
        // `/bin/bash` stays as the fallback for systems where `which` is absent
        // or `PATH` is degenerate but `/bin/bash` is real (e.g. cron); `/bin/sh`
        // is the guaranteed-POSIX last resort.
        if let Some(p) = which("bash") {
            return ShellConfig {
                program: p,
                args: vec!["-c".to_string()],
                via_stdin: false,
                description: "bash",
            };
        }
        if Path::new("/bin/bash").exists() {
            return c("/bin/bash", &["-c"], "bash");
        }
        c("/bin/sh", &["-c"], "sh")
    }
    #[cfg(windows)]
    {
        // Prefer a real bash before ever falling back to cmd, so POSIX command
        // syntax keeps working. Check the standard git-bash/msys install
        // locations under the well-known program dirs first, then `bash` on
        // PATH.
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(base) = std::env::var_os(var) {
                let git_bash = PathBuf::from(base).join("Git").join("bin").join("bash.exe");
                if git_bash.exists() {
                    return ShellConfig {
                        program: git_bash,
                        args: vec!["-c".to_string()],
                        via_stdin: false,
                        description: "git-bash",
                    };
                }
            }
        }
        if let Some(p) = which("bash") {
            // The WSL launcher is the shim at System32\bash.exe; it rejects
            // `-c`, so the command must be piped to `bash -s` on stdin. Only
            // that exact location is treated as WSL, so a real bash that merely
            // lives under a directory named `system32` is not misrouted to
            // stdin one-shot mode.
            let is_wsl = p
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("bash.exe"))
                .unwrap_or(false)
                && p.parent()
                    .and_then(|d| d.file_name())
                    .and_then(|n| n.to_str())
                    .map(|n| n.eq_ignore_ascii_case("System32"))
                    .unwrap_or(false);
            if is_wsl {
                return ShellConfig {
                    program: p,
                    args: vec!["-s".to_string()],
                    via_stdin: true,
                    description: "wsl bash",
                };
            }
            return ShellConfig {
                program: p,
                args: vec!["-c".to_string()],
                via_stdin: false,
                description: "bash",
            };
        }
        // No bash anywhere: cmd is the only shell. The model is told this (the
        // runtime env block reports COMSPEC, and the bash handler's output note
        // names cmd) so it can write cmd syntax rather than silently passing
        // POSIX commands that cmd would reject.
        c("cmd.exe", &["/C"], "cmd")
    }
}

/// Locate an executable on PATH via the platform's own resolver. Also used by
/// [`super::jail`] to find `bwrap` on distros with no FHS paths (NixOS keeps it
/// only at a Nix-store path).
pub(crate) fn which(name: &str) -> Option<PathBuf> {
    #[cfg(unix)]
    let finder = "which";
    #[cfg(windows)]
    let finder = "where";
    let out = std::process::Command::new(finder).arg(name).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(PathBuf::from(first))
}

/// Spawn `command` in `cwd` using the resolved shell, as a new process group,
/// with stdout/stderr piped and `kill_on_drop` armed. The returned child's pid
/// is registered so [`kill_all`] can reap it on shutdown; the caller must
/// [`unregister`] it once the command finishes. The child inherits only the
/// minimal environment in `SANDBOX_ENV_ALLOW`, never the full host environment.
///
/// The full host environment leaks secrets to any `bash` call -- `JAN_API_KEY`,
/// `OPENAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `SSH_AUTH_SOCK`, the relocated
/// `JAN_DATA_FOLDER` -- so the shell is launched with only what a command needs
/// to run at all. Applied here, the one choke point all backends (bubblewrap,
/// seatbelt, and the Windows AppContainer helper) funnel through.
const SANDBOX_ENV_ALLOW: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "TERM",
    // Windows processes (cmd, and the cygwin/git-bash and MSYS runtimes) need
    // the system location keys to find system DLLs, `cmd.exe` itself, and run
    // `.bat`/`.cmd` helpers. Harmless no-ops on unix, where none are set.
    "SystemRoot",
    "windir",
    "ComSpec",
    "PATHEXT",
    "ProgramFiles",
    "ProgramData",
];

/// Every spelling of "where temporary files go": POSIX tools read `TMPDIR`,
/// Windows ones `TEMP`/`TMP`, and a mixed toolchain (git-bash, MSYS) reads both.
/// All are pointed at the scratch together so no tool falls back to the host.
const TEMP_ENV_KEYS: &[&str] = &["TMPDIR", "TMP", "TEMP"];

/// Bound the resource exhaustion a sandboxed command could otherwise trigger on
/// the host. `bwrap` 0.6.1 (and older) has no `--rlimit`, so instead we clamp the
/// child's soft limits here, before exec, from the one choke point every backend
/// funnels through. A fork-bomb is capped by `NPROC`, descriptor exhaustion by
/// `NOFILE`, and disk fill through the unbounded workspace bind by `FSIZE`. The
/// bwrap wrapper execs `bwrap` itself, which sets up the namespace and then
/// execs the real shell, so the limits carry over to every descendant. Linux
/// only; the Windows AppContainer child is limited by its token.
#[cfg(unix)]
fn confine_limits(cmd: &mut Command) {
    // `tokio::process::Command::pre_exec` (unix) is the std `pre_exec`; the call
    // below is what mounts the limits.
    // # Safety: `pre_exec` runs in the forked child before exec. Only async-signal-
    // safe calls are allowed; `setrlimit` is one. Errors fall back to the parent's
    // values and are ignored (best effort), so a kernel that refuses a limit
    // cannot wedge a launch.
    unsafe {
        cmd.pre_exec(|| {
            for (resource, limit) in [
                (nix::libc::RLIMIT_NPROC, 4096_u64),
                (nix::libc::RLIMIT_NOFILE, 1024_u64),
                (nix::libc::RLIMIT_FSIZE, 1024_u64 * 1024_u64 * 1024_u64),
            ] {
                let r = nix::libc::rlimit {
                    rlim_cur: limit,
                    rlim_max: limit,
                };
                // Best effort: a setrlimit failure is intentionally ignored so a
                // kernel that refuses a limit cannot wedge the launch.
                let _ = nix::libc::setrlimit(resource, &r);
            }
            Ok(())
        });
    }
}

pub async fn spawn(
    cfg: &ShellConfig,
    command: &str,
    cwd: &Path,
    scratch: Option<&Path>,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(&cfg.program);
    cmd.args(&cfg.args);
    if !cfg.via_stdin {
        cmd.arg(command);
    }
    // Strip every inherited variable, then re-add only the allowlist so the
    // sandboxed process holds no host secrets regardless of which backend wraps
    // it. `current_dir` on the workspace keeps relative work correct.
    cmd.env_clear();
    for key in SANDBOX_ENV_ALLOW {
        if let Some(val) = std::env::var_os(key) {
            cmd.env(key, val);
        }
    }
    // Point the shell's temp env at the session scratch, overriding the host
    // values the allowlist just copied in. Without this a command that writes
    // through `mktemp`/`$TMPDIR` lands in the host temp dir -- unreachable to
    // the filesystem tools, and on the backends that confine by path, not
    // writable at all. `scratch` is what the sandbox exposes, which is not
    // always the host path (see `jail::scratch_env_path`).
    if let Some(scratch) = scratch {
        for key in TEMP_ENV_KEYS {
            cmd.env(key, scratch);
        }
    }
    cmd.current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if cfg.via_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .kill_on_drop(true);
    set_process_group(&mut cmd);
    #[cfg(unix)]
    confine_limits(&mut cmd);

    let mut child = cmd.spawn()?;

    if cfg.via_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(command.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.shutdown().await;
        }
    }

    if let Some(pid) = child.id() {
        register(pid);
    }
    Ok(child)
}

#[cfg(unix)]
fn set_process_group(cmd: &mut Command) {
    // pgid 0 => the child becomes leader of a new group whose id equals its pid,
    // so `kill_tree(pid)` can signal the whole group.
    cmd.process_group(0);
}

#[cfg(windows)]
fn set_process_group(cmd: &mut Command) {
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

/// What happened when a process tree was signalled.
///
/// Reported rather than swallowed: a caller that tells the user "stopped"
/// because it *asked* the OS to stop something has told the user nothing. The
/// distinction that matters most is [`Gone`](KillOutcome::Gone) — the process
/// had already exited, so there was nothing to kill and nothing went wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KillOutcome {
    /// The signal reached the process tree.
    Signalled,
    /// No such process: it had already exited. Not a failure.
    Gone,
    /// The OS refused. The string is safe to show: it names the failure, never
    /// a path or an environment value.
    Failed(String),
}

impl KillOutcome {
    /// Did this leave the process stopped, one way or another?
    pub fn stopped(&self) -> bool {
        matches!(self, KillOutcome::Signalled | KillOutcome::Gone)
    }
}

/// Kill the process `pid` and every descendant it spawned.
///
/// Unix: the pid is also its process-group id (see [`spawn`]), so the group is
/// signalled first and the lone process only as a fallback — a group that has
/// already gone reports `Gone` rather than being retried pointlessly.
#[cfg(unix)]
pub fn kill_tree(pid: u32) -> KillOutcome {
    use nix::errno::Errno;
    use nix::sys::signal::{kill, killpg, Signal};
    use nix::unistd::Pid;

    let target = Pid::from_raw(pid as i32);
    match killpg(target, Signal::SIGKILL) {
        Ok(()) => KillOutcome::Signalled,
        // No such process group. The leader may still exist without one (it
        // was never made a group leader, or the group has already gone while
        // the leader lingers as a zombie), so try the process itself.
        Err(Errno::ESRCH) => match kill(target, Signal::SIGKILL) {
            Ok(()) => KillOutcome::Signalled,
            Err(Errno::ESRCH) => KillOutcome::Gone,
            Err(Errno::EPERM) => {
                KillOutcome::Failed("not permitted to signal this process".into())
            }
            Err(e) => KillOutcome::Failed(e.desc().to_string()),
        },
        Err(Errno::EPERM) => {
            KillOutcome::Failed("not permitted to signal this process group".into())
        }
        Err(e) => KillOutcome::Failed(e.desc().to_string()),
    }
}

/// Kill the process `pid` and every descendant it spawned.
///
/// Windows has no process groups a signal can reach across, so this shells out
/// to `taskkill /T`, which walks the tree itself. Two things can go wrong and
/// both are reported: `taskkill` may fail to launch at all (absent from PATH in
/// a stripped image), and it may run and refuse — exit code 128 is "no such
/// process", which means the command had already finished.
#[cfg(windows)]
pub fn kill_tree(pid: u32) -> KillOutcome {
    /// `taskkill` exit code for "the process is not running".
    const ERROR_NOT_FOUND: i32 = 128;

    let output = match std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output()
    {
        Ok(output) => output,
        Err(e) => return KillOutcome::Failed(format!("could not run taskkill: {e}")),
    };
    if output.status.success() {
        return KillOutcome::Signalled;
    }
    if output.status.code() == Some(ERROR_NOT_FOUND) {
        return KillOutcome::Gone;
    }
    // taskkill explains itself on stderr; its first line is the useful part
    // and names no path of ours.
    let reason = String::from_utf8_lossy(&output.stderr);
    let first = reason.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    KillOutcome::Failed(if first.is_empty() {
        format!("taskkill exited with {}", output.status)
    } else {
        first.trim().to_string()
    })
}

/// Identifies the tool call a process was spawned for.
///
/// A call abandoned on timeout has its future dropped, which kills the direct
/// child through `kill_on_drop` -- but only that child. Its descendants are in
/// the child's process group and survive, which is why the model is told an
/// abandoned call "may still be running". Attributing each pid to the call that
/// spawned it makes the group reapable by whoever abandoned it.
pub type ScopeId = u64;

tokio::task_local! {
    /// The call whose future is currently executing, if any.
    static SCOPE: ScopeId;
}

/// A fresh scope id. Monotonic and process-wide: two concurrent tool calls must
/// never share one, or reaping either would reap both.
pub fn new_scope() -> ScopeId {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Runs `future` with `scope` ambient, so anything it spawns is attributed to it.
pub async fn in_scope<F: std::future::Future>(scope: ScopeId, future: F) -> F::Output {
    SCOPE.scope(scope, future).await
}

fn running() -> &'static Mutex<HashMap<u32, Option<ScopeId>>> {
    static RUNNING: OnceLock<Mutex<HashMap<u32, Option<ScopeId>>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Records `pid` against the ambient scope, if there is one.
///
/// A pid with no scope is still reaped by [`kill_all`] on shutdown; it is only
/// unattributable to a single call, which is the right answer for anything
/// spawned outside one.
pub fn register(pid: u32) {
    let scope = SCOPE.try_with(|s| *s).ok();
    running().lock().unwrap().insert(pid, scope);
}

pub fn unregister(pid: u32) {
    running().lock().unwrap().remove(&pid);
}

/// The scope `pid` was spawned under, or `None` if it is unscoped or gone.
pub fn scope_of(pid: u32) -> Option<ScopeId> {
    running().lock().unwrap().get(&pid).copied().flatten()
}

/// Reap every process tree spawned by one tool call.
///
/// Idempotent: a run tearing down while a timeout fires may call this twice for
/// the same scope, and the second call must be a no-op rather than a panic.
pub fn kill_scope(scope: ScopeId) {
    let pids: Vec<u32> = {
        let mut registry = running().lock().unwrap();
        let doomed: Vec<u32> = registry
            .iter()
            .filter(|(_, owner)| **owner == Some(scope))
            .map(|(pid, _)| *pid)
            .collect();
        for pid in &doomed {
            registry.remove(pid);
        }
        doomed
    };
    for pid in pids {
        // The caller has already given up on this call; there is no better
        // outcome to report than having tried.
        let _ = kill_tree(pid);
    }
}

/// Reap every still-running bash command. Called on app shutdown so no shell
/// tree outlives the process that spawned it.
pub fn kill_all() {
    let pids: Vec<u32> = running().lock().unwrap().drain().map(|(pid, _)| pid).collect();
    for pid in pids {
        // Shutdown is best effort: there is nobody left to tell.
        let _ = kill_tree(pid);
    }
}

#[cfg(test)]
mod env_allowlist_tests {
    use super::*;

    /// Windows-native processes (cmd, plus the cygwin/git-bash and MSYS
    /// runtimes) need the system-location keys to find DLLs and `cmd.exe`
    /// itself. These are the keys the ticket adds; assert they stay present so
    /// a bare Windows box can actually run a command.
    #[test]
    fn allowlist_has_windows_system_keys() {
        for key in ["SystemRoot", "windir", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramData"] {
            assert!(
                SANDBOX_ENV_ALLOW.contains(&key),
                "missing {key} in SANDBOX_ENV_ALLOW"
            );
        }
    }
}

/// Windows-only behaviour of `kill_tree`, which shells out to `taskkill`
/// rather than signalling a process group. Compiled and run only on Windows —
/// a unix test asserting these would prove nothing about them.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir()
    }

    /// `taskkill /T` walks the tree and reports success.
    #[tokio::test]
    async fn kills_a_running_command_and_reports_it() {
        // `timeout` is a stock Windows command that simply waits.
        let mut child = spawn(shell(), "timeout /t 300 /nobreak", &tmp(), None)
            .await
            .unwrap();
        let pid = child.id().unwrap();

        assert_eq!(kill_tree(pid), KillOutcome::Signalled);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await;
        unregister(pid);
    }

    /// taskkill exits 128 for "the process is not running", which is not a
    /// failure — there was nothing left to kill.
    #[test]
    fn a_pid_that_does_not_exist_reports_gone() {
        assert_eq!(kill_tree(u32::MAX - 7), KillOutcome::Gone);
    }

    /// A nonzero exit that is *not* 128 is a refusal, and must be reported as
    /// a failure carrying taskkill's own explanation. pid 0 is the System Idle
    /// Process, which cannot be terminated.
    #[test]
    fn a_refusal_is_reported_with_the_reason_taskkill_gave() {
        match kill_tree(0) {
            KillOutcome::Failed(reason) => {
                assert!(!reason.is_empty(), "a refusal must say why");
                assert!(
                    !reason.contains('\\'),
                    "the reason is shown to the user and must name no path: {reason}"
                );
            }
            other => panic!("terminating the idle process must fail, got {other:?}"),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    fn tmp() -> PathBuf {
        std::env::temp_dir()
    }

    fn alive(pid: i32) -> bool {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;
        kill(Pid::from_raw(pid), None).is_ok()
    }

    #[test]
    fn resolves_a_bash_like_shell() {
        let cfg = shell();
        assert!(cfg.program.exists(), "resolved shell must exist: {cfg:?}");
        assert!(!cfg.args.is_empty());
    }

    #[tokio::test]
    async fn runs_a_command_and_captures_stdout() {
        let child = spawn(shell(), "echo hello", &tmp(), None).await.unwrap();
        let pid = child.id().unwrap();
        let out = child.wait_with_output().await.unwrap();
        unregister(pid);
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello");
    }

    /// `mktemp`, `pytest`, `cargo` and friends write to `$TMPDIR`, so the scratch
    /// is only useful if it is what the shell's temp env names. All three
    /// spellings are set: POSIX tools read `TMPDIR`, Windows ones `TEMP`/`TMP`.
    #[tokio::test]
    async fn temp_env_points_at_the_scratch_when_one_is_given() {
        let scratch = tmp().join("jan_proc_scratch_env");
        std::fs::create_dir_all(&scratch).unwrap();
        let child = spawn(
            shell(),
            "echo \"$TMPDIR $TMP $TEMP\"",
            &tmp(),
            Some(&scratch),
        )
        .await
        .unwrap();
        let pid = child.id().unwrap();
        let out = child.wait_with_output().await.unwrap();
        unregister(pid);
        let s = scratch.to_string_lossy();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            format!("{s} {s} {s}")
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// With no scratch the shell keeps whatever the host allowlist passed
    /// through, rather than being handed an empty temp dir.
    #[tokio::test]
    async fn temp_env_is_left_alone_without_a_scratch() {
        let child = spawn(shell(), "echo ${TMPDIR:-unset}", &tmp(), None)
            .await
            .unwrap();
        let pid = child.id().unwrap();
        let out = child.wait_with_output().await.unwrap();
        unregister(pid);
        let expected = std::env::var("TMPDIR").unwrap_or_else(|_| "unset".to_string());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), expected);
    }

    #[tokio::test]
    async fn kill_tree_reaps_backgrounded_grandchild() {
        // The shell backgrounds a long sleeper, prints its pid, then waits on
        // it. Killing the group must take down that grandchild too.
        let mut child = spawn(shell(), "sleep 300 & echo $! ; wait", &tmp(), None)
            .await
            .unwrap();
        let leader = child.id().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let first = tokio::time::timeout(std::time::Duration::from_secs(5), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let grandchild: i32 = first.trim().parse().unwrap();
        assert!(alive(grandchild), "grandchild should be running");

        assert_eq!(kill_tree(leader), KillOutcome::Signalled);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
        unregister(leader);

        // Give the kernel a moment to tear the group down.
        for _ in 0..50 {
            if !alive(grandchild) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(!alive(grandchild), "grandchild must be reaped by group kill");
    }

    /// A pid nothing owns is not a failure: there is nothing left to kill.
    #[test]
    fn killing_a_pid_that_does_not_exist_reports_gone() {
        // Above the default pid_max on Linux and outside the range macOS
        // hands out, so nothing can be occupying it.
        assert_eq!(kill_tree(u32::MAX - 7), KillOutcome::Gone);
    }

    /// The OS refusing is a failure, and must be reported as one rather than
    /// reported as a kill. pid 1 exists on every unix and an unprivileged
    /// process may not signal it.
    #[test]
    fn killing_a_process_group_we_may_not_signal_reports_why() {
        match kill_tree(1) {
            KillOutcome::Failed(reason) => {
                assert!(!reason.is_empty(), "a refusal must say why");
                assert!(
                    !reason.contains('/'),
                    "the reason is shown to the user and must name no path: {reason}"
                );
            }
            // Running as root, where signalling init is permitted. Accept
            // rather than assert a refusal the OS did not make.
            other => assert!(
                // SAFETY: geteuid is always safe; it reads the calling
                // process's own effective uid and cannot fail.
                unsafe { nix::libc::geteuid() } == 0,
                "expected a refusal as an unprivileged user, got {other:?}"
            ),
        }
    }

    #[test]
    fn register_and_unregister_track_pids() {
        // A pid outside any real range: exercising the registry only, never
        // signalling a live process (kill_all is shutdown-only and would reap
        // other tests' children if called under the parallel harness).
        let fake = u32::MAX - 1;
        register(fake);
        assert!(running().lock().unwrap().contains_key(&fake));
        unregister(fake);
        assert!(!running().lock().unwrap().contains_key(&fake));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confine_limits_caps_the_child_process_count() {
        // The rlimit mounting must actually reach the spawned child: with NPROC
        // clamped we still run up to the cap, but a fork-bomb past it fails.
        let child = spawn(shell(), "exit 0", &tmp(), None).await.unwrap();
        let pid = child.id().unwrap();
        child.wait_with_output().await.unwrap();
        unregister(pid);

        // Spawn a shell that reports its own soft NOFILE limit; confine_limits
        // sets it to 1024, which should be visible inside the sandbox.
        let child = spawn(shell(), "ulimit -n", &tmp(), None).await.unwrap();
        let pid = child.id().unwrap();
        let out = child.wait_with_output().await.unwrap();
        unregister(pid);
        let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert_eq!(val, "1024", "NOFILE soft limit should be capped, got: {val}");
    }
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    /// A pid registered outside any scope still belongs to `kill_all`, which is
    /// what shutdown relies on.
    #[test]
    fn an_unscoped_pid_is_still_reaped_by_kill_all() {
        let fake = 4_000_001;
        register(fake);
        assert!(running().lock().unwrap().contains_key(&fake));
        unregister(fake);
        assert!(!running().lock().unwrap().contains_key(&fake));
    }

    #[tokio::test]
    async fn a_spawn_inside_a_scope_is_attributed_to_it() {
        let scope = new_scope();
        let fake = 4_000_002;
        in_scope(scope, async move {
            register(fake);
        })
        .await;
        assert_eq!(scope_of(fake), Some(scope), "the ambient scope must be recorded");
        unregister(fake);
    }

    #[tokio::test]
    async fn killing_one_scope_leaves_another_scopes_processes_alone() {
        let (a, b) = (new_scope(), new_scope());
        let (pid_a, pid_b) = (4_000_003, 4_000_004);
        in_scope(a, async move { register(pid_a) }).await;
        in_scope(b, async move { register(pid_b) }).await;

        // Reaping `a` must not touch `b`: concurrent tool calls each own their
        // own tree, and one abandoning is not the other failing.
        kill_scope(a);
        assert!(scope_of(pid_a).is_none(), "the reaped scope's pid is forgotten");
        assert_eq!(scope_of(pid_b), Some(b), "the untouched scope survives");
        unregister(pid_b);
    }

    #[tokio::test]
    async fn killing_a_scope_that_spawned_nothing_is_not_an_error() {
        let scope = new_scope();
        kill_scope(scope);
    }

    #[test]
    fn every_scope_id_is_distinct() {
        let ids: Vec<u64> = (0..64).map(|_| new_scope()).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "scope ids must never collide");
    }

    #[tokio::test]
    async fn a_scope_reaped_twice_stays_reaped() {
        let scope = new_scope();
        let fake = 4_000_005;
        in_scope(scope, async move { register(fake) }).await;
        kill_scope(scope);
        // Idempotent: a run teardown that races the timeout path must not panic
        // or resurrect anything.
        kill_scope(scope);
        assert!(scope_of(fake).is_none());
    }
}
