//! Process-group-aware shell spawning and whole-tree termination for the `bash`
//! tool. Every command runs as its own process-group leader so a timeout,
//! cancel, or app shutdown can reap the entire descendant tree, not just the
//! top-level shell. Without this, any command that spawns children (a build, a
//! `foo &`, a pipeline) leaks orphans when the run is torn down.
//!
//! It is also where a shell is *chosen*, and where what is known about that
//! choice is kept honest. A shell has a location (which is a fact about a path,
//! never a deduction from a failure), a command language (which decides whether
//! a given command can be run at all), and a probe result (which is the only
//! thing that establishes it can start under the sandbox in force).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use tokio::process::{Child, Command};

/// The command language a shell actually speaks.
///
/// Carried rather than inferred from the description, because the point of
/// having it is to stop a POSIX command string being handed to something that
/// will mis-execute it. `cmd` given `rm -rf build && echo done` does not fail
/// cleanly: it runs whatever `rm` is on `PATH`, ignores the flags it does not
/// know, and reads `&&` as its own operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFlavor {
    /// POSIX `sh`/`bash` semantics.
    Posix,
    /// Windows PowerShell or PowerShell 7.
    PowerShell,
    /// `cmd.exe`.
    Cmd,
}

impl ShellFlavor {
    pub fn as_str(self) -> &'static str {
        match self {
            ShellFlavor::Posix => "posix",
            ShellFlavor::PowerShell => "powershell",
            ShellFlavor::Cmd => "cmd",
        }
    }
}

/// How to invoke the host shell. `program` + `args` are fixed; the command
/// string is appended as the final argv element, or piped to stdin when
/// `via_stdin` is set (legacy WSL `bash.exe`, which cannot take `-c`).
/// `description` names the shell for the model (e.g. git-bash vs `cmd`), so it
/// can adapt command syntax instead of assuming POSIX.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub via_stdin: bool,
    /// A short human-readable name of the resolved shell, for the model.
    pub description: &'static str,
    /// The command language this shell will apply to the command string.
    pub flavor: ShellFlavor,
}

/// Resolved shell for this process, computed once. Prefers a real `bash`
/// (matching the tool's name and documented guidance) and falls back to a
/// POSIX `sh`/`cmd` only when no bash is found.
///
/// This is the *unconfined* preference. A sandboxed run must go through
/// [`super::jail::select_shell`] instead, because a shell that starts fine on
/// its own can still be unable to start inside a container -- and the only way
/// to know is to try it.
pub fn shell() -> &'static ShellConfig {
    static SHELL: OnceLock<ShellConfig> = OnceLock::new();
    SHELL.get_or_init(|| {
        candidates()
            .into_iter()
            .next()
            .unwrap_or_else(|| c("/bin/sh", &["-c"], "sh", ShellFlavor::Posix))
    })
}

fn c(program: &str, args: &[&str], description: &'static str, flavor: ShellFlavor) -> ShellConfig {
    ShellConfig {
        program: PathBuf::from(program),
        args: args.iter().map(|s| s.to_string()).collect(),
        via_stdin: false,
        description,
        flavor,
    }
}

fn at(
    program: PathBuf,
    args: &[&str],
    description: &'static str,
    flavor: ShellFlavor,
) -> ShellConfig {
    ShellConfig {
        program,
        args: args.iter().map(|s| s.to_string()).collect(),
        via_stdin: false,
        description,
        flavor,
    }
}

/// The shell named by `JAN_AGENT_SHELL`, when it names something real.
///
/// Assumed POSIX, because that is what the setting has always meant and what
/// the tool's command strings are written in. A user pointing it at
/// `powershell.exe` gets PowerShell, and the flavor says so.
fn configured_shell() -> Option<ShellConfig> {
    let path = PathBuf::from(std::env::var_os("JAN_AGENT_SHELL")?);
    if !path.exists() {
        return None;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Some(
        if name.starts_with("powershell") || name.starts_with("pwsh") {
            at(
                path,
                &["-NoProfile", "-NonInteractive", "-Command"],
                "custom powershell",
                ShellFlavor::PowerShell,
            )
        } else if name.starts_with("cmd") {
            at(path, &["/C"], "custom cmd", ShellFlavor::Cmd)
        } else {
            at(path, &["-c"], "custom", ShellFlavor::Posix)
        },
    )
}

/// Every shell this host could run a command with, best first.
///
/// A list rather than a single answer, because "best" depends on something
/// this function cannot know: whether the shell can start under the sandbox the
/// run will use. The caller probes down the list.
pub fn candidates() -> Vec<ShellConfig> {
    let mut out = Vec::new();
    if let Some(configured) = configured_shell() {
        out.push(configured);
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
            out.push(at(p, &["-c"], "bash", ShellFlavor::Posix));
        }
        if Path::new("/bin/bash").exists() {
            out.push(c("/bin/bash", &["-c"], "bash", ShellFlavor::Posix));
        }
        out.push(c("/bin/sh", &["-c"], "sh", ShellFlavor::Posix));
    }
    #[cfg(windows)]
    {
        // Prefer a real bash before ever falling back to PowerShell or cmd, so
        // POSIX command syntax keeps working. Check the standard git-bash/msys
        // install locations under the well-known program dirs first, then `bash`
        // on PATH.
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(base) = std::env::var_os(var) {
                let git_bash = PathBuf::from(base).join("Git").join("bin").join("bash.exe");
                if git_bash.exists() && !out.iter().any(|s| s.program == git_bash) {
                    out.push(at(git_bash, &["-c"], "git-bash", ShellFlavor::Posix));
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
            if !out.iter().any(|s| s.program == p) {
                out.push(if is_wsl {
                    ShellConfig {
                        program: p,
                        args: vec!["-s".to_string()],
                        via_stdin: true,
                        description: "wsl bash",
                        flavor: ShellFlavor::Posix,
                    }
                } else {
                    at(p, &["-c"], "bash", ShellFlavor::Posix)
                });
            }
        }
        // PowerShell and cmd are not bash and are never silently substituted for
        // it -- a command that needs POSIX semantics is refused rather than
        // reinterpreted (see [`requires_posix_shell`]). They are here so a
        // shell-neutral command still runs on a host where bash cannot, which
        // on Windows includes every sandboxed run: the MSYS2 runtime Git Bash
        // is built on cannot initialise inside an AppContainer.
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if let Some(p) = which(candidate) {
                if !out.iter().any(|s| s.program == p) {
                    out.push(at(
                        p,
                        &["-NoProfile", "-NonInteractive", "-Command"],
                        "powershell",
                        ShellFlavor::PowerShell,
                    ));
                }
            }
        }
        let cmd = std::env::var_os("ComSpec")
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .unwrap_or_else(|| PathBuf::from("cmd.exe"));
        out.push(at(cmd, &["/C"], "cmd", ShellFlavor::Cmd));
    }
    out
}

/// Where a shell was found, said accurately.
///
/// This type exists because a generic process-start failure was once reported
/// as "a shell installed under your user profile is unreadable to the sandbox"
/// for a `bash.exe` sitting in `C:\Program Files\Git\bin`. A location is a fact
/// about a path. It is never inferred from a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellOrigin {
    /// Named by `JAN_AGENT_SHELL`.
    Configured,
    /// Under `%ProgramFiles%`, `%ProgramFiles(x86)%` or `%ProgramW6432%`.
    SystemInstall,
    /// Under the user's own profile, which an AppContainer cannot read.
    UserInstall,
    /// Under `%SystemRoot%` -- `cmd.exe`, `powershell.exe`, the WSL launcher.
    WindowsSystem,
    /// Shipped next to the Jan binary.
    Bundled,
    /// A real path matching none of the above.
    Elsewhere,
}

impl ShellOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            ShellOrigin::Configured => "configured",
            ShellOrigin::SystemInstall => "system-install",
            ShellOrigin::UserInstall => "user-install",
            ShellOrigin::WindowsSystem => "windows-system",
            ShellOrigin::Bundled => "bundled",
            ShellOrigin::Elsewhere => "elsewhere",
        }
    }
}

/// The directories that decide a shell's origin. Passed in rather than read
/// from the process, so the classification is testable without a real profile.
#[derive(Debug, Clone, Default)]
pub struct OriginRoots {
    pub program_files: Vec<PathBuf>,
    pub user_profile: Vec<PathBuf>,
    pub system_root: Option<PathBuf>,
    pub bundled: Option<PathBuf>,
}

impl OriginRoots {
    /// The roots of the machine this is running on.
    pub fn from_host() -> Self {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        Self {
            program_files: ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
                .into_iter()
                .filter_map(var)
                .collect(),
            user_profile: ["USERPROFILE", "LOCALAPPDATA", "APPDATA"]
                .into_iter()
                .filter_map(var)
                .collect(),
            system_root: var("SystemRoot").or_else(|| var("windir")),
            bundled: std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
        }
    }
}

/// Case-insensitive component-wise prefix test, which is the only correct one
/// for Windows paths and harmless elsewhere. Whole components are compared so
/// `C:\Users\me2` is not read as living under `C:\Users\me`.
fn under(path: &Path, root: &Path) -> bool {
    if root.as_os_str().is_empty() {
        return false;
    }
    let mut walker = path.components();
    for component in root.components() {
        match walker.next() {
            Some(mine)
                if mine
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&component.as_os_str().to_string_lossy()) => {}
            _ => return false,
        }
    }
    true
}

/// Classify where a shell lives. Ordered so the most specific answer wins: a
/// program directory is checked before the profile, because on a machine where
/// the two overlap the sandbox-relevant fact is the program directory.
pub fn classify_origin(program: &Path, configured: bool, roots: &OriginRoots) -> ShellOrigin {
    if configured {
        return ShellOrigin::Configured;
    }
    if roots.program_files.iter().any(|r| under(program, r)) {
        return ShellOrigin::SystemInstall;
    }
    if roots
        .system_root
        .as_ref()
        .is_some_and(|r| under(program, r))
    {
        return ShellOrigin::WindowsSystem;
    }
    if roots.user_profile.iter().any(|r| under(program, r)) {
        return ShellOrigin::UserInstall;
    }
    if roots.bundled.as_ref().is_some_and(|r| under(program, r)) {
        return ShellOrigin::Bundled;
    }
    ShellOrigin::Elsewhere
}

/// What a probe found out about one shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// The shell started, ran a harmless command and exited cleanly.
    Usable,
    /// The shell exists but could not be started under the policy in force.
    /// The string is what was reported, not a guess at why.
    Unusable { reason: String },
    /// Nothing exists at that path.
    Missing,
    /// No sandbox backend could confine this shell, so it was never tried.
    NoSandbox,
}

impl ProbeOutcome {
    pub fn usable(&self) -> bool {
        matches!(self, ProbeOutcome::Usable)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ProbeOutcome::Usable => "usable",
            ProbeOutcome::Unusable { .. } => "unusable",
            ProbeOutcome::Missing => "missing",
            ProbeOutcome::NoSandbox => "no-sandbox",
        }
    }
}

/// A shell, where it came from, and whether it works here. This is what a
/// readiness view renders and what a diagnostics copy contains.
#[derive(Debug, Clone)]
pub struct ShellReport {
    pub cfg: ShellConfig,
    pub origin: ShellOrigin,
    pub outcome: ProbeOutcome,
}

/// The command a probe runs. Harmless in every shell this module knows about,
/// writes nothing, and exits immediately.
pub const PROBE_COMMAND: &str = "exit 0";

/// Constructs that only a POSIX shell will execute correctly.
///
/// Deliberately short. The cost of a false positive is a clear refusal naming
/// bash; the cost of a false negative is `cmd` quietly doing something else
/// with the user's command. Only constructs with no compatible reading in
/// PowerShell or `cmd` are listed -- `&&` is absent because all three accept
/// it, and `|` because all three pipe.
const POSIX_ONLY: &[(&str, &str)] = &[
    ("$(", "command substitution `$(...)`"),
    ("${", "parameter expansion `${...}`"),
    ("<<", "a heredoc"),
    ("2>&1", "POSIX descriptor redirection"),
    ("&>", "POSIX descriptor redirection"),
    ("export ", "`export`"),
    ("xargs", "`xargs`"),
    ("#!/", "a shebang"),
];

/// The POSIX construct a command depends on, or `None` when it would run the
/// same anywhere. Used to refuse rather than reinterpret.
pub fn requires_posix_shell(command: &str) -> Option<&'static str> {
    // A closed backtick pair is command substitution. A lone backtick is more
    // often quoting inside a message, and in PowerShell it is the escape
    // character, so it is not on its own evidence of anything.
    if command.matches('`').count() >= 2 {
        return Some("command substitution with backticks");
    }
    POSIX_ONLY
        .iter()
        .find(|(needle, _)| command.contains(needle))
        .map(|(_, what)| *what)
}

/// The refusal handed back when a command needs a POSIX shell and none can run.
///
/// Structured and actionable on purpose: it names the construct, the shell that
/// is available instead, and why the POSIX one is not being used. It never
/// silently re-runs the command through another interpreter.
pub fn posix_unavailable_error(construct: &str, available: &ShellConfig, why: &str) -> String {
    format!(
        "ERROR: this command needs a POSIX shell -- it uses {construct} -- and none is \
         available here.\n\
         Available shell: {} ({} syntax).\n\
         Why a POSIX shell is not being used: {why}\n\
         Do one of: rewrite the command in {} syntax, or use the read/ls/find/grep \
         tools, which do not need a shell.",
        available.description,
        available.flavor.as_str(),
        available.flavor.as_str()
    )
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
pub const SANDBOX_ENV_ALLOW: &[&str] = &[
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
    // Windows only, and not for the shell: on Windows the process spawned here
    // is the AppContainer helper, which builds the confined shell's environment
    // itself (`tools::win_env`). `CreateProcessW` resolves the container's own
    // storage -- `%LOCALAPPDATA%\Packages\<moniker>\AC` -- out of the block it
    // is handed, and returns ERROR_ENVVAR_NOT_FOUND (203) with no process
    // created when the name is absent. So the helper needs it to do its job;
    // the shell it starts is given the sandbox's own synthetic profile instead.
    "LOCALAPPDATA",
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
            Err(Errno::EPERM) => KillOutcome::Failed("not permitted to signal this process".into()),
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

fn running() -> &'static Mutex<HashSet<u32>> {
    static RUNNING: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn register(pid: u32) {
    running().lock().unwrap().insert(pid);
}

pub fn unregister(pid: u32) {
    running().lock().unwrap().remove(&pid);
}

/// Reap every still-running bash command. Called on app shutdown so no shell
/// tree outlives the process that spawned it.
pub fn kill_all() {
    let pids: Vec<u32> = running().lock().unwrap().drain().collect();
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
        for key in [
            "SystemRoot",
            "windir",
            "ComSpec",
            "PATHEXT",
            "ProgramFiles",
            "ProgramData",
        ] {
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
        assert!(
            !alive(grandchild),
            "grandchild must be reaped by group kill"
        );
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
        assert!(running().lock().unwrap().contains(&fake));
        unregister(fake);
        assert!(!running().lock().unwrap().contains(&fake));
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
        assert_eq!(
            val, "1024",
            "NOFILE soft limit should be capped, got: {val}"
        );
    }
}

/// Where a shell lives is a fact about its path. These tests exist because it
/// used to be a deduction from a failure -- a `bash.exe` in `C:\Program Files`
/// was reported to users as "installed under your user profile".
#[cfg(test)]
mod origin_tests {
    use super::*;

    fn roots() -> OriginRoots {
        OriginRoots {
            program_files: vec![
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"C:\Program Files (x86)"),
            ],
            user_profile: vec![
                PathBuf::from(r"C:\Users\me"),
                PathBuf::from(r"C:\Users\me\AppData\Local"),
            ],
            system_root: Some(PathBuf::from(r"C:\Windows")),
            bundled: Some(PathBuf::from(r"C:\Program Files\Jan")),
        }
    }

    fn origin(path: &str) -> ShellOrigin {
        classify_origin(Path::new(path), false, &roots())
    }

    #[test]
    fn git_under_program_files_is_a_system_install() {
        assert_eq!(
            origin(r"C:\Program Files\Git\bin\bash.exe"),
            ShellOrigin::SystemInstall
        );
        // Windows paths are case-insensitive, and the classification has to be
        // too or the same install reads differently depending on who typed it.
        assert_eq!(
            origin(r"c:\program files\git\bin\bash.exe"),
            ShellOrigin::SystemInstall
        );
        assert_eq!(
            origin(r"C:\Program Files (x86)\Git\bin\bash.exe"),
            ShellOrigin::SystemInstall
        );
    }

    #[test]
    fn git_under_the_profile_is_a_user_install() {
        assert_eq!(
            origin(r"C:\Users\me\AppData\Local\Programs\Git\bin\bash.exe"),
            ShellOrigin::UserInstall
        );
    }

    #[test]
    fn a_sibling_directory_is_not_the_profile() {
        // `C:\Users\me2` starts with `C:\Users\me` as a string and is a
        // different user's directory.
        assert_eq!(
            origin(r"C:\Users\me2\tools\bash.exe"),
            ShellOrigin::Elsewhere
        );
    }

    #[test]
    fn the_windows_shells_are_windows_system() {
        assert_eq!(
            origin(r"C:\Windows\System32\cmd.exe"),
            ShellOrigin::WindowsSystem
        );
        assert_eq!(
            origin(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
            ShellOrigin::WindowsSystem
        );
    }

    #[test]
    fn an_explicit_setting_outranks_the_path() {
        assert_eq!(
            classify_origin(Path::new(r"C:\Users\me\my-shell.exe"), true, &roots()),
            ShellOrigin::Configured
        );
    }

    #[test]
    fn an_unknown_location_is_said_to_be_unknown() {
        assert_eq!(origin(r"D:\tools\busybox\sh.exe"), ShellOrigin::Elsewhere);
    }
}

/// A command written for bash must be refused rather than reinterpreted. `cmd`
/// handed `foo $(bar)` does not fail cleanly -- it runs something else.
#[cfg(test)]
mod posix_tests {
    use super::*;

    #[test]
    fn posix_only_constructs_are_recognised() {
        for command in [
            "echo $(date)",
            "echo ${HOME}",
            "cat <<EOF\nhi\nEOF",
            "build 2>&1 | tee log",
            "ls | xargs rm",
            "export FOO=1 && run",
            "echo `date`",
        ] {
            assert!(
                requires_posix_shell(command).is_some(),
                "not recognised: {command}"
            );
        }
    }

    #[test]
    fn shell_neutral_commands_are_left_alone() {
        for command in [
            "git status",
            "npm run build",
            "echo hello",
            "cargo test --lib",
            // A single backtick is PowerShell's escape character and is not on
            // its own evidence of command substitution.
            "echo a`b",
        ] {
            assert_eq!(
                requires_posix_shell(command),
                None,
                "wrongly refused: {command}"
            );
        }
    }

    #[test]
    fn the_refusal_names_the_construct_the_shell_and_the_reason() {
        let cmd = c("cmd.exe", &["/C"], "cmd", ShellFlavor::Cmd);
        let message = posix_unavailable_error(
            "command substitution `$(...)`",
            &cmd,
            "C:\\Program Files\\Git\\bin\\bash.exe could not start in the sandbox: \
             the MSYS2 runtime cannot initialise inside an AppContainer",
        );
        assert!(message.starts_with("ERROR:"), "{message}");
        assert!(message.contains("command substitution"), "{message}");
        assert!(message.contains("cmd"), "{message}");
        assert!(message.contains("MSYS2"), "{message}");
        // It must never suggest the shell is missing when it is installed.
        assert!(!message.contains("not installed"), "{message}");
    }

    #[test]
    fn every_candidate_declares_the_language_it_speaks() {
        for shell in candidates() {
            match shell.flavor {
                ShellFlavor::Cmd => assert!(shell.args.iter().any(|a| a == "/C"), "{shell:?}"),
                ShellFlavor::PowerShell => {
                    assert!(shell.args.iter().any(|a| a == "-Command"), "{shell:?}")
                }
                ShellFlavor::Posix => assert!(
                    shell.args.iter().any(|a| a == "-c" || a == "-s"),
                    "{shell:?}"
                ),
            }
        }
    }
}
