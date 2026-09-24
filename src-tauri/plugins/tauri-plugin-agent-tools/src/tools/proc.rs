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
    let path = PathBuf::from(crate::compat_env::var_os("AGENT_SHELL")?);
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
/// PowerShell or `cmd` are listed. `|` is absent because all three pipe.
///
/// `&&` and `||` are handled separately by [`requires_and_or_chaining`], not
/// listed here: `cmd`, PowerShell 7+ (`pwsh`) and POSIX shells all accept them,
/// but *Windows PowerShell 5.1* (`powershell.exe`, the Desktop edition that is
/// the sandbox fallback on Windows) does not -- it fails to parse with "token
/// '&&' is not a valid statement separator in this version". Refusing them only
/// on that one shell, rather than everywhere, keeps them working where they are
/// valid.
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

/// Constructs from [`POSIX_ONLY`] that PowerShell also parses, with a meaning
/// close enough that refusing them only blocks valid commands: `$(...)` is a
/// PowerShell subexpression, `${name}` a braced variable, `2>&1` merges the
/// error stream exactly as in POSIX, and a backtick pair is two escapes.
const POWERSHELL_VALID: &[&str] = &["$(", "${", "2>&1"];

/// [`requires_posix_shell`] as seen by the shell that will actually run the
/// command. PowerShell accepts `$(...)`, `${...}`, `2>&1` (and `*>&1`,
/// `2>$null`, which were never listed) and uses the backtick as its escape
/// character, so none of those is evidence of a bash-only command there.
pub fn requires_posix_shell_for(command: &str, flavor: ShellFlavor) -> Option<&'static str> {
    if flavor != ShellFlavor::PowerShell {
        return requires_posix_shell(command);
    }
    POSIX_ONLY
        .iter()
        .filter(|(needle, _)| !POWERSHELL_VALID.contains(needle))
        .find(|(needle, _)| command.contains(needle))
        .map(|(_, what)| *what)
}

/// The reason a POSIX shell was rejected, cut to one sentence when it is the
/// long Git Bash / MSYS2 loader explanation: the refusal is about the command,
/// and the paragraph on AppContainer internals only buried the actionable part.
fn short_posix_reason(why: &str) -> String {
    if why.contains("STATUS_DLL_INIT_FAILED") || why.contains("MSYS") {
        "Git Bash (MSYS2) cannot start inside the Windows sandbox (STATUS_DLL_INIT_FAILED)."
            .to_string()
    } else {
        why.to_string()
    }
}

/// The refusal handed back when a command needs a POSIX shell and none can run.
///
/// Structured and actionable on purpose: it names the construct, the shell that
/// is available instead, and why the POSIX one is not being used. It never
/// silently re-runs the command through another interpreter.
pub fn posix_unavailable_error(construct: &str, available: &ShellConfig, why: &str) -> String {
    let why = short_posix_reason(why);
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

/// Whether this shell accepts the `&&` / `||` command-chaining operators.
///
/// True for POSIX shells and `cmd.exe`, and for PowerShell **7+** (`pwsh`),
/// which gained the operators in 6.0. False only for *Windows PowerShell 5.1*
/// (`powershell.exe`, the Desktop edition), whose parser rejects them outright.
/// The two PowerShells share [`ShellFlavor::PowerShell`], so they are told apart
/// here by the executable's file stem: `pwsh` is always 6/7+, `powershell` is
/// Windows PowerShell. A custom shell pointed at `pwsh` via `JAN_AGENT_SHELL`
/// is likewise treated as chaining-capable.
pub fn supports_and_or_chaining(cfg: &ShellConfig) -> bool {
    match cfg.flavor {
        ShellFlavor::Posix | ShellFlavor::Cmd => true,
        ShellFlavor::PowerShell => cfg
            .program
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|stem| stem.to_ascii_lowercase().starts_with("pwsh"))
            .unwrap_or(false),
    }
}

/// The chaining operator a command relies on at the top level (`&&` or `||`),
/// or `None` when it uses neither there.
///
/// Only occurrences *outside* single and double quotes count: `echo "a && b"`
/// is one argument, not a chain, and must not be refused. Detection only --
/// the command string is never rewritten, so quoting, escaping and the
/// short-circuit semantics of a real chain are left exactly as written. A lone
/// `&` (background) or single `|` (pipe) is not a chain and is ignored; the
/// operator must be doubled.
pub fn requires_and_or_chaining(command: &str) -> Option<&'static str> {
    let bytes = command.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b'&' | b'|' if !in_single && !in_double && i + 1 < bytes.len() && bytes[i + 1] == b => {
                return Some(if b == b'&' { "&&" } else { "||" });
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The refusal handed back when a command chains with `&&`/`||` but the only
/// shell available is Windows PowerShell 5.1, which cannot parse them.
///
/// Actionable on purpose: it names the operator and the shell, and gives the
/// PowerShell-valid alternatives. `;` is offered but flagged as *not*
/// short-circuiting, because silently treating `a && b` as `a; b` would run `b`
/// even after `a` failed -- a change of meaning the caller must make
/// deliberately, not one this tool makes for them.
pub fn chaining_unavailable_error(operator: &str, available: &ShellConfig) -> String {
    let conditional = if operator == "&&" {
        "run the next command only on success"
    } else {
        "run the next command only on failure"
    };
    format!(
        "ERROR: `{operator}` is not valid in {} -- Windows PowerShell 5.1 rejects `&&` and \
         `||` with \"token '{operator}' is not a valid statement separator in this version\".\n\
         Rewrite for PowerShell: sequence unconditionally with `;` (note: `;` always runs the \
         next command, it does NOT stop on failure like `{operator}`), or to {conditional} use \
         `command1; if ($?) {{ command2 }}`. The read/ls/find/grep tools need no shell at all.",
        available.description,
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
    // A one-shot lookup from a process with no console (the desktop app, or the
    // job supervisor it starts) would otherwise open a console window per call.
    use jan_process::CommandConsole;
    let out = std::process::Command::new(finder).arg(name).background().output().ok()?;
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
/// funnels through. Descriptor exhaustion is capped by `NOFILE` and disk fill
/// through the unbounded workspace bind by `FSIZE`.
///
/// `NOFILE` (65536) and `FSIZE` (16 GiB) are deliberately generous (adapted from
/// janhq/jan#8978): toolchains (linkers, node, cargo) routinely want tens of
/// thousands of descriptors, and a debug `cargo test` binary or incremental
/// artifact can pass a gigabyte on its own, so caps that low break ordinary work
/// long before they stop abuse. `FSIZE` is a per-file cap enforced with
/// `SIGXFSZ`, so exceeding it kills the writer. Each target soft limit is bounded
/// by the host's hard limit (read with `getrlimit`), and the hard limit is left
/// at the host's value so a command that genuinely needs more can raise its own
/// soft limit back up.
///
/// `NPROC` is charged to the whole Unix user, not to this shell tree, so on a
/// busy workstation unrelated processes can use up the allowance and make an
/// ordinary tool command fail at `fork()`. Linux keeps a finite fork-bomb
/// ceiling at 8192; macOS already enforces its own per-user ceiling
/// (`kern.maxprocperuid`) that an unprivileged child cannot raise, so no cap is
/// set there (adapted from janhq/jan#8785).
///
/// The bwrap wrapper execs `bwrap` itself, which sets up the namespace and then
/// execs the real shell, so the limits carry over to every descendant. The
/// Windows AppContainer child is limited by its token instead.
#[cfg(unix)]
fn confine_limits(cmd: &mut Command) {
    // `tokio::process::Command::pre_exec` (unix) is the std `pre_exec`; the call
    // below is what mounts the limits.
    // # Safety: `pre_exec` runs in the forked child before exec. Only async-signal-
    // safe calls are allowed; `getrlimit`/`setrlimit` are. Errors fall back to the
    // parent's values and are ignored (best effort), so a kernel that refuses a
    // limit cannot wedge a launch.
    unsafe {
        cmd.pre_exec(|| {
            for (resource, limit) in [
                #[cfg(target_os = "linux")]
                (nix::libc::RLIMIT_NPROC, 8192_u64),
                (nix::libc::RLIMIT_NOFILE, 65536_u64),
                (nix::libc::RLIMIT_FSIZE, 16_u64 * 1024 * 1024 * 1024),
            ] {
                let mut r = nix::libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if nix::libc::getrlimit(resource, &mut r) != 0 {
                    continue;
                }
                // Never exceed the host's hard limit; setrlimit would refuse.
                // The hard limit itself is left untouched.
                let ceiling = if r.rlim_max == nix::libc::RLIM_INFINITY {
                    limit
                } else {
                    limit.min(r.rlim_max)
                };
                r.rlim_cur = ceiling;
                // Best effort: a setrlimit failure is intentionally ignored so a
                // kernel that refuses a limit cannot wedge the launch.
                let _ = nix::libc::setrlimit(resource, &r);
            }
            Ok(())
        });
    }
}

/// `powershell`/`pwsh` as the model calls them, run in this shell.
///
/// Inside the AppContainer a child PowerShell does not start where its
/// parent is: it lands on a drive root the container can see (`I:\` on the
/// development machine), because it cannot walk the ancestors of the
/// workspace to adopt it. `powershell -File .\check.ps1` then wrote its
/// relative `progress.log` to that drive root and failed with "The device is
/// not ready" while the call still exited 0. These functions take the usual
/// `-File`/`-Command`/positional forms and run the script or command in the
/// current shell, at the workspace location; `-ExecutionPolicy Bypass` is
/// applied to the process scope. A bare call with nothing to run still
/// starts the real executable.
const NESTED_SHELL: &str = r#"function global:__JanNestedShell {
  $file = $null; $cmd = $null; $rest = @(); $i = 0
  while ($i -lt $args.Count) {
    $a = [string]$args[$i]
    if ($a -match '^-(NoProfile|nop|NoLogo|NonInteractive|noni|Sta|Mta)$') { }
    elseif ($a -match '^-(ExecutionPolicy|ep|exec)$') { if ([string]$args[$i + 1] -match '^(Bypass|Unrestricted|RemoteSigned)$') { Set-ExecutionPolicy -Scope Process -ExecutionPolicy ([string]$args[$i + 1]) -Force }; $i++ }
    elseif ($a -match '^-(WindowStyle|w|OutputFormat|of|InputFormat|if)$') { $i++ }
    elseif ($a -match '^-(File|f)$') { $file = [string]$args[$i + 1]; if ($i + 2 -lt $args.Count) { $rest = $args[($i + 2)..($args.Count - 1)] }; break }
    elseif ($a -match '^-(Command|c)$') { if ($i + 1 -lt $args.Count) { $cmd = ($args[($i + 1)..($args.Count - 1)] | ForEach-Object { [string]$_ }) -join ' ' }; break }
    else { $cmd = ($args[$i..($args.Count - 1)] | ForEach-Object { [string]$_ }) -join ' '; break }
    $i++
  }
  if ($file) {
    $quoted = $rest | ForEach-Object { $s = [string]$_; if ($s -match '^-[A-Za-z]' -or $s -notmatch "[\s']") { $s } else { "'" + ($s -replace "'", "''") + "'" } }
    $global:LASTEXITCODE = 0
    Invoke-Expression ("& '" + ($file -replace "'", "''") + "' " + ($quoted -join ' '))
    if ($global:LASTEXITCODE) { Write-Error "$file exited with code $global:LASTEXITCODE" }
    return
  }
  if ($cmd) { $global:LASTEXITCODE = 0; Invoke-Expression $cmd; if ($global:LASTEXITCODE) { Write-Error "command exited with code $global:LASTEXITCODE" }; return }
  & (Get-Command powershell.exe -CommandType Application | Select-Object -First 1).Source @args
}
foreach ($n in 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe') { Set-Item -Path "function:global:$n" -Value ${function:__JanNestedShell} }"#;

/// The command as the shell should receive it, starting where it is meant to.
///
/// Windows PowerShell inside an AppContainer does not take its location from
/// the process's working directory: measured on Windows 11, it starts at a
/// drive root the container can see (`G:\` on the development machine) while
/// `cmd` in the same container starts in the workspace. A command with a
/// relative path then read or wrote somewhere other than the workspace the
/// model was told about.
///
/// `Set-Location` straight into the workspace is refused there ("Access is
/// denied"): PowerShell checks each ancestor of the path, and the container
/// may not look at its parents. So the workspace is mounted as a drive of its
/// own, whose root is the one directory the container can see, and the shell
/// moves to it. The path is quoted as a PowerShell literal (see
/// [`ps_literal`]). The process's own working directory is already the
/// workspace, so native programs the command runs are unaffected.
///
/// Three more things are set up for PowerShell, each for a failure seen in
/// real runs:
///
/// - `[Environment]::CurrentDirectory` and `$env:JAN_WORKSPACE` are set to the
///   workspace path. A nested `powershell -File x.ps1` does not inherit the
///   parent's PSDrive location; it starts from the process's .NET current
///   directory, which inside the container had become a drive root (`I:\`),
///   so the script's relative paths missed. `JAN_WORKSPACE` gives a script an
///   absolute path to the same place.
/// - The user command is compiled on its own, as the first line of a script
///   block, so PowerShell's "At line:N char:M" positions refer to the command
///   the model wrote rather than to a line that begins with this prologue.
///   It is dot-sourced, so variables and functions behave as if typed at the
///   top level.
/// - The exit status is honest. `powershell -Command` exits 0 whenever the
///   *last* statement succeeded, so a command whose earlier statement threw
///   ("Exception calling ...", a method on `$null`) reported success. The
///   command is now failed when either
///     * `$?` is false after its last statement (as before, and as
///       `-Command` itself decides), or
///     * a statement- or script-terminating error occurred anywhere in it.
///   The second is read from `$Error`: records added while the command ran
///   whose origin is not a cmdlet or native program. Non-terminating cmdlet
///   errors are deliberately *not* counted -- they include those silenced
///   with `-ErrorAction SilentlyContinue` (still recorded in `$Error`, with
///   `$?` false for that statement only), which are used exactly when a
///   missing item is an expected answer, e.g. `Get-Command x -EA
///   SilentlyContinue; ...`. Native stderr redirected with `2>&1` becomes an
///   error record from the native program and is not counted either; the
///   program's exit code speaks for it. A failing native program's own exit
///   code is kept when it is the reason.
pub(crate) fn located(flavor: ShellFlavor, command: &str, cwd: &Path) -> String {
    match flavor {
        ShellFlavor::PowerShell => {
            let ws = ps_literal(&without_verbatim_prefix(&cwd.to_string_lossy()));
            let body = ps_literal(&format!("{command}\n$global:__JanOk = $?"));
            let nested = NESTED_SHELL;
            format!(
                "$null = New-PSDrive -Name JanWorkspace -PSProvider FileSystem -Root '{ws}' -Scope Global; \
                 Set-Location JanWorkspace:\\; [Environment]::CurrentDirectory = '{ws}'; \
                 $env:JAN_WORKSPACE = '{ws}'; $global:__JanOk = $true; $global:__JanErrors = $Error.Count\n\
                 {nested}\n\
                 . ([scriptblock]::Create('{body}'))\n\
                 $global:__JanThrown = @($Error | Select-Object -First ([Math]::Max(0, $Error.Count - $global:__JanErrors)) | \
                 Where-Object {{ $_ -is [System.Management.Automation.ErrorRecord] -and \
                 $_.InvocationInfo.MyCommand -isnot [System.Management.Automation.CmdletInfo] -and \
                 $_.InvocationInfo.MyCommand -isnot [System.Management.Automation.ApplicationInfo] }}).Count\n\
                 if ($global:__JanThrown -or -not $global:__JanOk) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }}; exit 1 }}; exit 0"
            )
        }
        _ => command.to_string(),
    }
}

/// A canonicalized Windows path without its verbatim `\\?\` prefix.
///
/// Windows PowerShell 5.1 can set its location to a `\\?\C:\...` drive root
/// and run scripts there, but creating a new file under it fails ("An object
/// at the specified path progress.log does not exist"). A managed worktree
/// arrives canonicalized, so a script run from it could not write a single
/// relative file. `\\?\UNC\server\share` becomes `\\server\share`.
pub(crate) fn without_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Remove the PowerShell prologue from an error message that quotes it.
///
/// A parse error in the command is reported against the wrapper line that
/// compiles it, and PowerShell echoes that line with its "At line" position
/// and `~~~` marker. Those lines name `JanWorkspace`, `__Jan` variables and
/// `[scriptblock]::Create`, none of which the model wrote; left in, it tried
/// to "fix" them. The parse error's own message, which points into the
/// command, is kept.
pub(crate) fn strip_prologue(output: &str) -> String {
    const MARKERS: &[&str] = &["__Jan", "JanWorkspace -PSProvider", "[scriptblock]::Create("];
    let lines: Vec<&str> = output.split('\n').collect();
    let mut drop = vec![false; lines.len()];
    for (i, line) in lines.iter().enumerate() {
        if !MARKERS.iter().any(|m| line.contains(m)) {
            continue;
        }
        drop[i] = true;
        if i > 0 && lines[i - 1].trim_start().starts_with("At line:") {
            drop[i - 1] = true;
        }
        if let Some(next) = lines.get(i + 1) {
            let t = next.trim();
            if t.starts_with('+') && t[1..].trim().chars().all(|c| c == '~' || c == ' ') {
                drop[i + 1] = true;
            }
        }
    }
    if !drop.iter().any(|d| *d) {
        return output.to_string();
    }
    lines
        .iter()
        .zip(drop)
        .filter(|(_, d)| !d)
        .map(|(l, _)| *l)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Text to put between single quotes in a PowerShell command.
///
/// PowerShell ends a single-quoted string on `'` and also on the typographic
/// quotes U+2018 to U+201B, so a folder named `Bob’s project` ended the
/// literal early -- every command failed to parse, and a folder named to do
/// so could run a command nobody approved. Each of them is doubled, which is
/// how PowerShell escapes any of the five inside a literal.
pub(crate) fn ps_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    for c in text.chars() {
        out.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod located_tests {
    use super::*;

    #[test]
    fn verbatim_prefix_is_dropped() {
        assert_eq!(without_verbatim_prefix(r"\\?\C:\a\b"), r"C:\a\b");
        assert_eq!(without_verbatim_prefix(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(without_verbatim_prefix(r"C:\a"), r"C:\a");
    }

    /// The same run from a canonicalized (`\\?\`) workspace, which is how a
    /// managed worktree arrives: the relative write must still land.
    #[cfg(windows)]
    #[test]
    fn nested_powershell_writes_under_a_verbatim_workspace() {
        let dir = std::env::temp_dir().join(format!("jan-verbatim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        assert!(dir.to_string_lossy().starts_with(r"\\?\"));
        std::fs::write(dir.join("s.ps1"), "Add-Content -Path progress.log -Value ok\n").unwrap();
        let script = located(
            ShellFlavor::PowerShell,
            "powershell -NoProfile -ExecutionPolicy Bypass -File .\\s.ps1",
            &dir,
        );
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .current_dir(&dir)
            .status()
            .unwrap();
        let log = std::fs::read_to_string(dir.join("progress.log")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(log.trim(), "ok");
        assert_eq!(status.code(), Some(0));
    }

    /// A nested `powershell -File` runs at the workspace: its relative write
    /// lands there, its parameters arrive, and its exit code is the call's.
    #[cfg(windows)]
    #[test]
    fn nested_powershell_file_runs_at_the_workspace() {
        let dir = std::env::temp_dir().join(format!("jan-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("s.ps1"),
            "param([int]$Stages = 3, [string]$Name = 'x')\n\
             Add-Content -Path progress.log -Value \"ok $Stages $Name\"\n\
             exit 4\n",
        )
        .unwrap();
        let script = located(
            ShellFlavor::PowerShell,
            "powershell -NoProfile -ExecutionPolicy Bypass -File .\\s.ps1 -Stages 2 -Name 'a b'",
            &dir,
        );
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .current_dir(&dir)
            .status()
            .unwrap();
        let log = std::fs::read_to_string(dir.join("progress.log")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(log.trim(), "ok 2 a b");
        assert_eq!(status.code(), Some(4));
    }

    #[test]
    fn prologue_echoes_are_stripped_and_the_rest_kept() {
        let out = "At line:1 char:15\n+ Write-Output (1 +\n+               ~~~\nMissing expression.\n\
                   At line:2 char:1\n+ . ([scriptblock]::Create('Write-Output (1 +\n+ ~~~~~~~~~\n\
                   + $global:__JanOk = $?\n+ ~\n[exit 1]";
        let s = strip_prologue(out);
        assert!(!s.contains("__Jan") && !s.contains("scriptblock"), "{s}");
        assert!(s.contains("+ Write-Output (1 +") && s.contains("Missing expression."), "{s}");
        assert!(s.contains("At line:1 char:15") && !s.contains("At line:2"), "{s}");
        assert!(s.ends_with("[exit 1]"), "{s}");
        assert_eq!(strip_prologue("plain\n[exit 0]"), "plain\n[exit 0]");
    }

    /// Runs `command` through the real wrapper in unsandboxed Windows
    /// PowerShell, which parses it exactly as the sandboxed one does.
    #[cfg(windows)]
    fn run_wrapped(command: &str) -> (i32, String, String) {
        let ws = std::env::temp_dir().join(format!(
            "jan-wrapped-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&ws).unwrap();
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(located(ShellFlavor::PowerShell, command, &ws))
            .current_dir(&ws)
            .output()
            .expect("powershell runs");
        let _ = std::fs::remove_dir_all(&ws);
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    }

    #[cfg(windows)]
    #[test]
    fn a_statement_that_threw_fails_the_command_even_if_later_ones_succeed() {
        let (code, out, err) = run_wrapped("[IO.File]::ReadAllText('Z:\\nope\\x'); Write-Output after");
        assert_ne!(code, 0, "{out} / {err}");
        // Statement-terminating: the rest still ran, as it would natively.
        assert!(out.contains("after"), "{out}");
        // The position refers to the command, not to the prologue.
        assert!(err.contains("At line:1 char:1"), "{err}");
        assert!(!err.contains("JanWorkspace"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn exit_status_follows_the_last_statement_and_native_codes() {
        assert_eq!(run_wrapped("Write-Output fine").0, 0);
        assert_eq!(run_wrapped("cmd /c exit 3").0, 3);
        assert_eq!(run_wrapped("exit 7").0, 7);
        assert_ne!(run_wrapped("Write-Output a; throw 'boom'; Write-Output b").0, 0);
        // A silenced lookup followed by more work is an answer, not a failure.
        assert_eq!(
            run_wrapped("Get-Command no-such-thing-jan -ErrorAction SilentlyContinue; Write-Output ok").0,
            0
        );
        // Quotes in the command survive the literal it is compiled from.
        let (code, out, _) = run_wrapped("Write-Output \"it's\"; Write-Output 'a''b'");
        assert_eq!(code, 0);
        assert!(out.contains("it's") && out.contains("a'b"), "{out}");
    }

    #[cfg(windows)]
    #[test]
    fn nested_processes_see_the_workspace_as_current_directory() {
        let (code, out, err) = run_wrapped(
            "[Environment]::CurrentDirectory; $env:JAN_WORKSPACE",
        );
        assert_eq!(code, 0, "{err}");
        let lines: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 2, "{out}");
        assert!(lines[0].contains("jan-wrapped-"), "{out}");
        assert_eq!(lines[0], lines[1], "{out}");
    }

    #[test]
    fn every_quote_powershell_honours_is_doubled() {
        assert_eq!(ps_literal("a'b"), "a''b");
        for q in ['\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'] {
            assert_eq!(ps_literal(&format!("x{q}y")), format!("x{q}{q}y"));
        }
        assert_eq!(ps_literal("plain \"text\""), "plain \"text\"");
    }

    /// A workspace whose name closes a PowerShell literal runs nothing, and
    /// the command still starts inside it. Unsandboxed PowerShell parses the
    /// prefix exactly as the sandboxed one does.
    #[cfg(windows)]
    #[test]
    fn a_folder_named_to_close_the_literal_runs_nothing() {
        let root = std::env::temp_dir().join(format!(
            "jan-located-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let ws = root.join("Bob\u{2019}; Write-Output INJECTED; \u{2019}x");
        std::fs::create_dir_all(&ws).unwrap();
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(located(
                ShellFlavor::PowerShell,
                "Write-Output ('at:' + (Get-Item .).FullName)",
                &ws,
            ))
            .current_dir(&ws)
            .output()
            .expect("powershell runs");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            !text.lines().any(|l| l.trim() == "INJECTED"),
            "the folder name ran a command: {text}"
        );
        assert!(
            text.contains("at:") && text.contains("Write-Output INJECTED"),
            "the command did not start in the workspace: {text} / {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

pub async fn spawn(
    cfg: &ShellConfig,
    command: &str,
    cwd: &Path,
    scratch: Option<&Path>,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(&cfg.program);
    // `cmd.exe` does not parse its command line with C-runtime quote rules, so
    // std's cooked `.arg` (which escapes inner quotes as `\"`) mangles any
    // command that contains quotes -- a chained `cd "path with spaces" && ...`
    // arrives with broken quoting and the command fails. cmd is handed a raw
    // line instead: `/S /C "<command>"`, where `/S` makes cmd strip exactly the
    // outer quote pair and run the remainder verbatim, so inner quoting, `&&`
    // short-circuiting and exit codes are all preserved. Every other shell uses
    // C-runtime rules, where cooked `.arg` is correct.
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut handled_raw = false;
    #[cfg(windows)]
    if cfg.flavor == ShellFlavor::Cmd && !cfg.via_stdin {
        let line = located(cfg.flavor, command, cwd);
        cmd.raw_arg("/S").raw_arg("/C").raw_arg(format!("\"{line}\""));
        handled_raw = true;
    }
    if !handled_raw {
        cmd.args(&cfg.args);
        if !cfg.via_stdin {
            cmd.arg(located(cfg.flavor, command, cwd));
        }
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
    // Own process group, and a console with no window: the shell's stdio is
    // piped, and without the flag every spawn (bash/cmd/powershell, including
    // the AppContainer helper re-exec) flashes a visible console window.
    use jan_process::CommandConsole;
    cmd.background_in_new_group();
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
/// Windows has no process groups a signal can reach across, so the tree is
/// walked here, from a kernel process snapshot, and each member terminated by
/// handle. This used to shell out to `taskkill /T`, which asks WMI for the
/// tree: on a machine where the WMI service had stopped answering, every kill
/// -- including of a pid that did not exist -- came back "the timeout period
/// expired", so the Stop button could not stop anything. The snapshot needs no
/// service at all.
///
/// The outcome is the root's: [`Gone`](KillOutcome::Gone) when it had already
/// exited, a failure when the OS refused it. Descendants are best effort --
/// one that exits or refuses on its own does not undo the kill that mattered.
#[cfg(windows)]
pub fn kill_tree(pid: u32) -> KillOutcome {
    use windows_sys::Win32::Foundation::{GetLastError, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};

    let root = match win_tree::Owned::open(pid) {
        Ok(root) => root,
        Err(error) => return classify_open_error(error),
    };
    // Every descendant is opened before anything is terminated: a handle pins
    // the process it names, so a pid recycled mid-kill can never be hit.
    let tree = win_tree::descendants(&root);

    let outcome = if unsafe { TerminateProcess(root.handle, 1) } != 0 {
        KillOutcome::Signalled
    } else {
        let error = unsafe { GetLastError() };
        // Terminating a process that has already exited fails too, with
        // "access denied"; tell that apart from a real refusal.
        if unsafe { WaitForSingleObject(root.handle, 0) } == WAIT_OBJECT_0 {
            KillOutcome::Gone
        } else {
            classify_open_error(error)
        }
    };
    for member in &tree {
        unsafe { TerminateProcess(member.handle, 1) };
    }
    // Anything a member started while the first pass ran.
    for member in &tree {
        for late in win_tree::descendants(member) {
            unsafe { TerminateProcess(late.handle, 1) };
        }
    }
    outcome
}

/// When the process holding `pid` was created, or `None` if nothing does.
///
/// Opened for query only: asking which process something *is* must not require
/// the right to end it, and a durable job record checks pids that may by then
/// belong to strangers -- that check is exactly what stops one of them being
/// mistaken for ours (AH-101).
#[cfg(windows)]
pub(crate) fn creation_time_of_pid(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    (ticks != 0).then_some(ticks)
}

/// Whether the process holding `pid` has already ended, or `None` if nothing
/// can be asked about that pid.
///
/// Needed beside the creation time: Windows keeps an ended process's record
/// -- creation time included -- for as long as anything holds a handle to it,
/// so a matching creation time alone reads a process that is gone as alive.
#[cfg(windows)]
pub(crate) fn has_exited_pid(pid: u32) -> Option<bool> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let waited = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    match waited {
        WAIT_OBJECT_0 => Some(true),
        WAIT_TIMEOUT => Some(false),
        _ => None,
    }
}

/// Whether the process holding `pid` has already ended, or `None` if unknown.
/// A zombie -- ended, not yet reaped -- has ended.
#[cfg(not(windows))]
pub(crate) fn has_exited_pid(pid: u32) -> Option<bool> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let state = stat.rsplit_once(')')?.1.split_whitespace().next()?;
    Some(matches!(state, "Z" | "X" | "x"))
}

/// When `handle`'s process was created, as a FILETIME count. `None` if unknown.
#[cfg(all(windows, test))]
pub(crate) fn creation_time(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    (ok != 0).then(|| ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

/// Every live descendant of `root`, found from one process snapshot.
///
/// A process is a child of an ancestor only if its recorded parent id is the
/// ancestor's *and* it was created no earlier than the ancestor was -- the
/// check that keeps a recycled parent id from adopting a stranger. With no
/// creation time for the root, nothing is claimed as a descendant.
#[cfg(all(windows, test))]
pub(crate) fn descendants_of(root: u32, root_created: Option<u64>) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let Some(root_created) = root_created else {
        return Vec::new();
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };

    let created_at = |pid: u32| -> Option<u64> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let at = creation_time(handle);
        unsafe { CloseHandle(handle) };
        at
    };

    let mut found = Vec::new();
    let mut frontier = vec![(root, root_created)];
    while let Some((parent, parent_created)) = frontier.pop() {
        for &(pid, ppid) in &pairs {
            if ppid != parent || pid == parent || pid == root || found.contains(&pid) {
                continue;
            }
            match created_at(pid) {
                Some(at) if at >= parent_created => {
                    found.push(pid);
                    frontier.push((pid, at));
                }
                _ => {}
            }
        }
    }
    found
}

/// What a Win32 error from opening or terminating the root means.
///
/// Split out from [`kill_tree`] so every outcome can be tested without aiming
/// a kill at a process that refuses one: the only such processes are System
/// and Idle, which no test should be targeting on a developer's machine.
#[cfg(windows)]
fn classify_open_error(error: u32) -> KillOutcome {
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER};

    match error {
        // No process has that id: the command had already finished, which is
        // the outcome the caller wanted.
        ERROR_INVALID_PARAMETER => KillOutcome::Gone,
        ERROR_ACCESS_DENIED => KillOutcome::Failed("access is denied".to_string()),
        other => KillOutcome::Failed(format!("the process could not be stopped (error {other})")),
    }
}

/// The process tree under a root, read from a Toolhelp snapshot.
#[cfg(windows)]
mod win_tree {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };

    /// An open process handle, closed on drop.
    pub struct Owned {
        pub pid: u32,
        pub handle: HANDLE,
        /// Creation time, as 100ns ticks.
        pub created: u64,
    }

    impl Owned {
        /// Open `pid` for termination, or return the Win32 error.
        pub fn open(pid: u32) -> Result<Owned, u32> {
            let handle = unsafe {
                OpenProcess(
                    PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                return Err(unsafe { GetLastError() });
            }
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let created = if unsafe {
                GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
            } != 0
            {
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)
            } else {
                0
            };
            Ok(Owned {
                pid,
                handle,
                created,
            })
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    /// Every running `(pid, parent pid)` pair. Empty when no snapshot could be
    /// taken, which leaves the root to be killed on its own.
    fn snapshot() -> Vec<(u32, u32)> {
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut pairs = Vec::new();
        let mut more = unsafe { Process32FirstW(snap, &mut entry) } != 0;
        while more {
            pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
            more = unsafe { Process32NextW(snap, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snap) };
        pairs
    }

    /// Every descendant of `root`, opened.
    ///
    /// A parent pid is only a number, and Windows recycles them: a process
    /// whose parent died long ago can name a pid that now belongs to `root`.
    /// A real child is created after its parent, so one created earlier is
    /// someone else's orphan and is left alone.
    pub fn descendants(root: &Owned) -> Vec<Owned> {
        let pairs = snapshot();
        let mut found: Vec<Owned> = Vec::new();
        let mut frontier: Vec<(u32, u64)> = vec![(root.pid, root.created)];
        while let Some((parent, parent_created)) = frontier.pop() {
            for &(pid, ppid) in &pairs {
                if ppid != parent || pid == parent || pid == root.pid {
                    continue;
                }
                if found.iter().any(|f| f.pid == pid) {
                    continue;
                }
                let Ok(child) = Owned::open(pid) else {
                    continue;
                };
                if child.created < parent_created {
                    continue;
                }
                frontier.push((child.pid, child.created));
                found.push(child);
            }
        }
        found
    }
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

/// Windows-only behaviour of `kill_tree`, which walks the process tree itself
/// rather than signalling a process group. Compiled and run only on Windows —
/// a unix test asserting these would prove nothing about them.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir()
    }

    /// A command that waits, in whatever language the resolved shell speaks.
    ///
    /// `timeout /t 300` is a `cmd` builtin, and the shell here is whichever one
    /// `shell()` resolved -- on a machine with Git for Windows that is bash,
    /// which runs `timeout` as its own coreutil, rejects the arguments and
    /// exits immediately. The process was then already gone by the time the
    /// kill was attempted, so the test proved nothing about killing.
    fn wait_command() -> &'static str {
        match shell().flavor {
            ShellFlavor::Posix => "sleep 300",
            ShellFlavor::PowerShell => "Start-Sleep -Seconds 300",
            ShellFlavor::Cmd => "timeout /t 300 /nobreak",
        }
    }

    /// Is `pid` a running process? Asked of the OS directly, not of `taskkill`.
    fn alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
        unsafe { CloseHandle(handle) };
        ok && code == 259
    }

    fn ping(seconds: u32) -> std::process::Child {
        std::process::Command::new("ping")
            .args(["-n", &seconds.to_string(), "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("ping starts")
    }

    /// The tree is stopped and the kill reports it, promptly.
    ///
    /// Spawned directly rather than through [`spawn`], which registers the pid
    /// in the process-wide table `kill_all` reaps from. Sharing that table with
    /// every other test in the binary meant this one's process could be gone
    /// before the kill it is testing, and the failure looked like `kill_tree`
    /// misreporting rather than like a test racing its neighbours.
    ///
    /// Bounded in time because the `taskkill` this replaced took about a
    /// minute on some hosts and then reported failure.
    #[tokio::test]
    async fn kills_a_running_command_and_reports_it() {
        let cfg = shell();
        let mut command = Command::new(&cfg.program);
        command
            .args(&cfg.args)
            .arg(wait_command())
            .current_dir(tmp())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // In its own process group, as `spawn` puts every real command. Left
        // in the test runner's group it shared the console with every other
        // process there, and a console control event aimed at that group --
        // from any concurrently running test binary on the same console --
        // ended the shell before the kill, which then correctly reported
        // `Gone`.
        set_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();

        let started = std::time::Instant::now();
        assert_eq!(kill_tree(pid), KillOutcome::Signalled);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await;
        assert!(!alive(pid), "the process is still running");
    }

    /// Whether `pid` still names a running process.
    fn running(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        match win_tree::Owned::open(pid) {
            Ok(p) => (unsafe { WaitForSingleObject(p.handle, 0) }) == WAIT_TIMEOUT,
            Err(_) => false,
        }
    }

    /// The grandchild is what `taskkill /T` existed for and what a plain
    /// terminate would leave running: `cmd` starts `ping`, and killing `cmd`
    /// has to take `ping` with it.
    #[test]
    fn kills_the_whole_tree_not_just_the_root() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 300 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let root = win_tree::Owned::open(child.id()).unwrap();
        let mut grandchild = None;
        for _ in 0..100 {
            if let Some(found) = win_tree::descendants(&root).into_iter().next() {
                grandchild = Some(found.pid);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let grandchild = grandchild.expect("cmd never started ping");
        // Held open so the pid cannot be recycled while it is being checked.
        let pinned = win_tree::Owned::open(grandchild).unwrap();

        assert_eq!(kill_tree(child.id()), KillOutcome::Signalled);
        let _ = child.wait();
        let mut gone = false;
        for _ in 0..100 {
            use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            if unsafe { WaitForSingleObject(pinned.handle, 0) } == WAIT_OBJECT_0 {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(gone, "the grandchild outlived the tree kill");
        drop(root);
    }

    /// A pid no process has is not a failure: there was nothing left to kill.
    #[test]
    fn a_pid_that_does_not_exist_reports_gone() {
        assert_eq!(kill_tree(u32::MAX - 7), KillOutcome::Gone);
    }

    /// A grandchild goes with its parent: `cmd` runs `ping` as a child, and
    /// killing `cmd` stops `ping` too.
    #[test]
    fn kills_the_whole_tree() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let mut parent = std::process::Command::new("cmd")
            .args(["/c", "ping -n 60 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd starts");
        let pid = parent.id();
        let root = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        let created = creation_time(root);
        unsafe { CloseHandle(root) };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let children = loop {
            let found = descendants_of(pid, created);
            if !found.is_empty() || std::time::Instant::now() > deadline {
                break found;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert!(!children.is_empty(), "cmd never started ping");

        assert_eq!(kill_tree(pid), KillOutcome::Signalled);
        let _ = parent.wait();
        std::thread::sleep(std::time::Duration::from_millis(200));
        for child in children {
            assert!(!alive(child), "descendant {child} survived its parent");
        }
    }

    /// Killing one tree leaves a process outside it running.
    #[test]
    fn an_unrelated_process_is_left_alone() {
        let mut target = ping(60);
        let mut bystander = ping(60);
        assert_eq!(kill_tree(target.id()), KillOutcome::Signalled);
        let _ = target.wait();
        assert!(alive(bystander.id()), "a process outside the tree was killed");
        let _ = bystander.kill();
        let _ = bystander.wait();
    }

    /// A process that exited while its parent still holds it -- the state a
    /// finished command is in until it is collected -- is gone, not refused,
    /// even though terminating it fails with "access denied".
    #[test]
    fn a_process_that_already_exited_reports_gone() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        // Exited, but `child` keeps its handle, so the pid is still this one.
        let _ = child.try_wait();
        for _ in 0..100 {
            if !running(pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(kill_tree(pid), KillOutcome::Gone);
        let _ = child.wait();
    }

    /// A refusal is a failure that says why, and names no path. Tested through
    /// the classifier rather than by refusing a real kill: the only processes
    /// that refuse are System and Idle, and no test should aim a kill at them.
    #[test]
    fn a_refusal_is_reported_as_a_failure_with_a_reason() {
        use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
        match classify_open_error(ERROR_ACCESS_DENIED) {
            KillOutcome::Failed(reason) => {
                assert_eq!(reason, "access is denied");
                assert!(!reason.contains('\\'), "{reason}");
            }
            other => panic!("access denied is a refusal, got {other:?}"),
        }
        match classify_open_error(1234) {
            KillOutcome::Failed(reason) => assert!(reason.contains("1234"), "{reason}"),
            other => panic!("an unknown error is a failure, got {other:?}"),
        }
    }

    #[test]
    fn no_such_process_is_classified_as_gone() {
        use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
        assert_eq!(
            classify_open_error(ERROR_INVALID_PARAMETER),
            KillOutcome::Gone
        );
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

        // Spawn a shell that reports its own soft limits; confine_limits raises
        // each to the target, bounded by whatever hard limit the host allows.
        // `ulimit -f` reports FSIZE in 1024-byte blocks, `-n` a raw count.
        for (name, flag, resource, target, unit) in [
            ("NOFILE", "-n", nix::libc::RLIMIT_NOFILE, 65536_u64, 1_u64),
            (
                "FSIZE",
                "-f",
                nix::libc::RLIMIT_FSIZE,
                16 * 1024 * 1024 * 1024,
                1024,
            ),
        ] {
            let cmd = format!("ulimit {flag}");
            let child = spawn(shell(), &cmd, &tmp(), None).await.unwrap();
            let pid = child.id().unwrap();
            let out = child.wait_with_output().await.unwrap();
            unregister(pid);
            let val = String::from_utf8_lossy(&out.stdout).trim().to_string();

            let mut host = nix::libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            // # Safety: reads the calling process's own limit into a local.
            unsafe {
                nix::libc::getrlimit(resource, &mut host);
            }
            let want = if host.rlim_max == nix::libc::RLIM_INFINITY {
                target
            } else {
                target.min(host.rlim_max)
            };
            assert_eq!(
                val,
                (want / unit).to_string(),
                "{name} soft limit should be raised to the target, got: {val}"
            );
        }
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
    fn powershell_syntax_is_not_mistaken_for_posix() {
        for command in [
            "git status 2>&1",
            "npm test *>&1",
            "Remove-Item x 2>$null",
            "Write-Output $(Get-Date)",
            "Write-Output ${env:PATH}",
            "Write-Output \"a`tb`n\"",
        ] {
            assert_eq!(
                requires_posix_shell_for(command, ShellFlavor::PowerShell),
                None,
                "wrongly refused for PowerShell: {command}"
            );
        }
        // Still bash-only in PowerShell.
        for command in ["cat <<EOF\nhi\nEOF", "export FOO=1", "ls | xargs rm"] {
            assert!(requires_posix_shell_for(command, ShellFlavor::PowerShell).is_some(), "{command}");
        }
        // cmd keeps the full list.
        assert!(requires_posix_shell_for("echo $(date)", ShellFlavor::Cmd).is_some());
    }

    #[test]
    fn the_msys_startup_paragraph_is_cut_to_one_sentence() {
        let cmd = c("cmd.exe", &["/C"], "cmd", ShellFlavor::Cmd);
        let long = "bash.exe could not start in the sandbox: The program started and then its \
                    runtime failed to initialise (STATUS_DLL_INIT_FAILED). Git Bash and the other \
                    MSYS2 programs shipped with Git for Windows cannot initialise.";
        let message = posix_unavailable_error("a heredoc", &cmd, long);
        assert!(message.contains("Git Bash (MSYS2) cannot start inside the Windows sandbox"), "{message}");
        assert!(!message.contains("shipped with Git for Windows"), "{message}");
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

/// `&&`/`||` reach Windows PowerShell 5.1 as a parse error, never a clean
/// failure, so a chained command is refused on that shell alone -- and left to
/// run everywhere the operators are valid (`cmd`, `pwsh` 7+, POSIX). These
/// tests pin both halves: what counts as a chain, and which shells accept one.
#[cfg(test)]
mod chaining_tests {
    use super::*;

    fn ps(program: &str) -> ShellConfig {
        at(
            PathBuf::from(program),
            &["-NoProfile", "-NonInteractive", "-Command"],
            "powershell",
            ShellFlavor::PowerShell,
        )
    }

    #[test]
    fn top_level_chains_are_recognised() {
        assert_eq!(requires_and_or_chaining("git add . && git commit"), Some("&&"));
        assert_eq!(requires_and_or_chaining("cargo build || echo failed"), Some("||"));
        // A build-then-test chain, the exact shape the screenshot showed failing.
        assert_eq!(
            requires_and_or_chaining("npm ci && npm run build && npm test"),
            Some("&&")
        );
    }

    #[test]
    fn a_path_with_spaces_still_reveals_the_chain() {
        // The quoted path is one argument; the `&&` after it is a real chain and
        // must be seen despite the spaces and quotes before it.
        assert_eq!(
            requires_and_or_chaining("ls \"C:\\Program Files\" && echo done"),
            Some("&&")
        );
    }

    #[test]
    fn operators_inside_quotes_are_not_a_chain() {
        // A literal `&&`/`||` inside an argument is data, not a chain, and must
        // not be refused -- refusing it would break a valid single command.
        assert_eq!(requires_and_or_chaining("echo \"a && b\""), None);
        assert_eq!(requires_and_or_chaining("echo 'x || y'"), None);
        assert_eq!(requires_and_or_chaining("grep \"foo && bar\" file.txt"), None);
        assert_eq!(
            requires_and_or_chaining("git commit -m \"fix: a && b\""),
            None
        );
    }

    #[test]
    fn single_ampersand_or_pipe_is_not_a_chain() {
        // Background `&` and a single pipe `|` are not the doubled chaining
        // operators and must be left alone.
        assert_eq!(requires_and_or_chaining("sleep 1 & echo hi"), None);
        assert_eq!(requires_and_or_chaining("cat file | grep x"), None);
        assert_eq!(requires_and_or_chaining("git status"), None);
    }

    #[test]
    fn windows_powershell_5_cannot_chain_but_pwsh_and_cmd_can() {
        // Windows PowerShell 5.1: no chaining.
        assert!(!supports_and_or_chaining(&ps("powershell.exe")));
        assert!(!supports_and_or_chaining(&ps(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        )));
        // PowerShell 7+ (`pwsh`): chaining since 6.0.
        assert!(supports_and_or_chaining(&ps("pwsh.exe")));
        assert!(supports_and_or_chaining(&ps(r"C:\Program Files\PowerShell\7\pwsh.exe")));
        // cmd and POSIX both chain.
        assert!(supports_and_or_chaining(&c("cmd.exe", &["/C"], "cmd", ShellFlavor::Cmd)));
        assert!(supports_and_or_chaining(&c("/bin/bash", &["-c"], "bash", ShellFlavor::Posix)));
    }

    #[test]
    fn the_refusal_names_the_operator_the_shell_and_a_valid_rewrite() {
        let msg = chaining_unavailable_error("&&", &ps("powershell.exe"));
        assert!(msg.starts_with("ERROR:"), "{msg}");
        assert!(msg.contains("&&"), "{msg}");
        assert!(msg.contains("powershell"), "{msg}");
        // Offers the PowerShell-valid alternatives.
        assert!(msg.contains(';'), "{msg}");
        assert!(msg.contains("if ($?)"), "{msg}");
        // Warns that `;` does not short-circuit, so the caller is not misled
        // into a change of meaning.
        assert!(msg.to_lowercase().contains("does not stop on failure"), "{msg}");
        // `||` gets its own conditional wording.
        let or = chaining_unavailable_error("||", &ps("powershell.exe"));
        assert!(or.contains("only on failure"), "{or}");
    }

    /// End-to-end proof of the fix's execution path: the representative command
    /// `cd "path with spaces" && <second>` runs the second command through the
    /// chaining-capable shell the selector falls back to (`cmd`), starting in
    /// the spaced directory -- and does *not* run the second command when the
    /// `cd` fails. This is what the pure refusal could not deliver: the original
    /// workflow now succeeds, with quoting, spaces, short-circuit and exit codes
    /// all preserved. `cmd` is spawned exactly as the selector wraps it.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_chained_cd_into_a_spaced_path_runs_end_to_end_on_cmd() {
        let cfg = c("cmd.exe", &["/C"], "cmd", ShellFlavor::Cmd);
        assert!(supports_and_or_chaining(&cfg), "cmd must be chaining-capable");
        let base = std::env::temp_dir().join(format!("jan chain test {}", std::process::id()));
        let spaced = base.join("dir with spaces");
        std::fs::create_dir_all(&spaced).unwrap();

        // Success: cd into the spaced path, then the second command runs, and it
        // runs *in* that directory (cmd's `cd` with no args echoes the cwd).
        let ok = format!("cd \"{}\" && echo MARKER_OK && cd", spaced.display());
        let child = spawn(&cfg, &ok, &std::env::temp_dir(), None).await.unwrap();
        let pid = child.id().unwrap();
        let out = child.wait_with_output().await.unwrap();
        unregister(pid);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("MARKER_OK"), "second command did not run: {text}");
        assert!(
            text.contains("dir with spaces"),
            "second command did not run in the spaced dir: {text}"
        );
        assert!(out.status.success(), "a successful chain must exit 0: {:?}", out.status);

        // Failure propagation: cd into a missing spaced path fails, so the second
        // command must not run, and the chain's exit code is non-zero.
        let missing = base.join("no such directory here");
        let bad = format!("cd \"{}\" && echo MARKER_SHOULD_NOT_RUN", missing.display());
        let child = spawn(&cfg, &bad, &std::env::temp_dir(), None).await.unwrap();
        let pid = child.id().unwrap();
        let out = child.wait_with_output().await.unwrap();
        unregister(pid);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            !text.contains("MARKER_SHOULD_NOT_RUN"),
            "second command ran after the first failed: {text}"
        );
        assert!(!out.status.success(), "a chain whose first command fails must not exit 0");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Failure propagation is the whole point of `&&`: the second command must
    /// not run when the first fails. Proven on `cmd`, a chaining-capable shell
    /// that is always present on Windows, so the semantics we refuse to silently
    /// drop are shown to be real.
    #[cfg(windows)]
    #[tokio::test]
    async fn cmd_short_circuits_a_failed_chain() {
        let cfg = c("cmd.exe", &["/C"], "cmd", ShellFlavor::Cmd);
        // `exit /b 1` fails, so `echo RAN` after `&&` must not execute.
        let child = spawn(&cfg, "cmd /c exit /b 1 && echo RAN", &std::env::temp_dir(), None)
            .await
            .unwrap();
        let pid = child.id().unwrap();
        let out = child.wait_with_output().await.unwrap();
        unregister(pid);
        assert!(
            !String::from_utf8_lossy(&out.stdout).contains("RAN"),
            "the second command ran after the first failed: {}",
            String::from_utf8_lossy(&out.stdout)
        );
    }
}
