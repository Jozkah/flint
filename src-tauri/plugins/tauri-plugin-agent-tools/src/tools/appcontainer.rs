//! Windows AppContainer confinement for the `bash` tool.
//!
//! AppContainer is a good fit for the policy [`super::jail`] describes, because
//! the three properties are close to its defaults rather than rules layered on
//! top:
//!
//! - reads: a lowbox token can only open objects whose DACL grants its package
//!   SID or one of its capabilities. Windows grants `ALL APPLICATION PACKAGES`
//!   read+execute on `C:\Windows` and `C:\Program Files` but not on user
//!   profiles, so "everything readable except the user's files" needs no rule.
//! - writes: nothing is writable until an ACE names the container, so granting
//!   one on the thread workspace is the whole write policy. The container also
//!   gets a private `AC\Temp` that Windows creates and ACLs for it.
//! - network: denied unless the spawn supplies the `internetClient` and
//!   `privateNetworkClientServer` capabilities. The second is what reaches LAN
//!   addresses -- including the home router most machines use as their DNS
//!   resolver, without which every hostname fails to resolve. AppContainer
//!   blocks loopback as well, which the Unix backends do not.
//!
//! Unlike bubblewrap and Seatbelt there is no argv to wrap: the confinement is a
//! token attribute passed to `CreateProcessW`, and `tokio::process::Command`
//! exposes no hook for `STARTUPINFOEX`. So this backend re-execs the running
//! binary as a helper ([`SANDBOX_EXEC_FLAG`]) that performs the confined spawn
//! and proxies the exit code, the same trick
//! `tauri_plugin_llamacpp::deps_analyzer` uses. The helper inherits its own std
//! handles down to the shell, so the parent's pipes still work unchanged --
//! inherited handles keep the access they were opened with, so the lowbox token
//! does not need rights on the pipes themselves.
//!
//! Codex confines Windows with restricted tokens plus a separate elevated
//! logon-user backend (`codex-rs/windows-sandbox-rs`, ~500KB across 40 files,
//! including WFP firewall rules and dedicated sandbox user accounts). That buys
//! deny-read ACEs and per-process network attribution we do not need: our policy
//! has a single writable root and a binary network switch, which AppContainer
//! expresses directly.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Marks a re-exec of this binary as the confined-spawn helper. Must be the
/// first argument, so a normal launch never looks at anything after it.
pub const SANDBOX_EXEC_FLAG: &str = "--internal-sandbox-exec";

const NET_ON: &str = "--net";
const NET_OFF: &str = "--no-net";
/// Prefix of a helper argument naming one authorized write root.
const WRITE_ROOT: &str = "--write-root=";
/// Prefix of a helper argument naming one folder the container may read (and
/// execute from) but not write: an attached folder under Review only.
const READ_ROOT: &str = "--read-root=";
/// Prefix of the helper argument naming the directory the shell starts in, when
/// that is not the workspace. It must be one of the write roots (see
/// [`parse_request`]): the container can only start somewhere it was granted.
const START_DIR: &str = "--start-dir=";
/// Prefix of a helper argument naming one toolchain folder the user let the
/// sandbox use. The helper is a fresh process that has not read the app's
/// grant record, so the grants travel with the request (see
/// [`crate::tools::toolchain_grants`]).
const PATH_DIR: &str = "--path-dir=";
/// Marks a spawn that holds its folder grants for as long as it runs (a
/// confined MCP server), rather than as the session shell. Its grants are
/// recorded under its own process id, so they stay while it lives and never
/// replace the shell's (see [`union_roots`]).
pub(crate) const OWN_HOLDER: &str = "--own-grant-holder";
/// The holder every shell command of a session records its grants under.
pub(crate) const SHELL_HOLDER: &str = "shell";

/// Exit code when the helper itself fails, distinct from anything a shell
/// reports so a setup failure is not mistaken for a command failure.
#[cfg(windows)]
const HELPER_FAILURE: i32 = 126;

/// FNV-1a. Only needs to be stable and well-spread; `DefaultHasher` is neither
/// guaranteed across releases nor reproducible by the helper on the other side
/// of the re-exec.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// AppContainer moniker for one thread workspace. Derived rather than random so
/// the helper reaches the same container the previous command used, and
/// per-workspace so the SID that a workspace ACE grants cannot be held by a
/// command running for a different thread.
///
/// Monikers are limited to 64 characters of alphanumerics, `.`, `-` and `_`.
/// Windows paths are case-insensitive, so the case is folded before hashing to
/// keep two spellings of one workspace on one container.
pub fn moniker(workspace: &Path) -> String {
    let key = workspace.to_string_lossy().to_lowercase();
    format!("Jan.Agent.{:016x}", fnv1a(key.as_bytes()))
}

/// argv for the helper re-exec. Shaped like the other backends -- fixed
/// arguments, then the shell, with the command string appended by the caller --
/// so the spawn path does not change per platform. The scratch travels with the
/// workspace because both need an ACE, and only the helper holds the container
/// SID to grant one with; an absent scratch is the empty string, since a
/// positional slot cannot simply be omitted.
pub fn helper_args(
    workspace: &Path,
    scratch: Option<&Path>,
    write_roots: &[PathBuf],
    allow_network: bool,
    program: &Path,
    args: &[String],
) -> Vec<String> {
    helper_args_at(workspace, None, scratch, write_roots, &[], allow_network, program, args)
}

/// [`helper_args`], with the shell started in `start` rather than the
/// workspace. Used for a run whose write destination is a managed worktree, so
/// relative commands (`npm test`, `.\x.ps1`) run against the project.
pub fn helper_args_at(
    workspace: &Path,
    start: Option<&Path>,
    scratch: Option<&Path>,
    write_roots: &[PathBuf],
    read_roots: &[PathBuf],
    allow_network: bool,
    program: &Path,
    args: &[String],
) -> Vec<String> {
    let mut out = vec![
        SANDBOX_EXEC_FLAG.to_string(),
        if allow_network { NET_ON } else { NET_OFF }.to_string(),
        workspace.to_string_lossy().to_string(),
        scratch
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
    ];
    // Each authorized root is its own marked argument, so a path can never be
    // mistaken for the separator or for the shell that follows it.
    for root in write_roots {
        out.push(format!("{WRITE_ROOT}{}", root.to_string_lossy()));
    }
    // A folder both readable and writable is granted once, writable.
    for root in read_roots.iter().filter(|r| !write_roots.contains(r)) {
        out.push(format!("{READ_ROOT}{}", root.to_string_lossy()));
    }
    if let Some(start) = start.filter(|s| *s != workspace) {
        out.push(format!("{START_DIR}{}", start.to_string_lossy()));
    }
    for dir in crate::tools::toolchain_grants::granted_folders() {
        out.push(format!("{PATH_DIR}{}", dir.to_string_lossy()));
    }
    out.push("--".to_string());
    out.push(program.to_string_lossy().to_string());
    out.extend(args.iter().cloned());
    out
}

/// Quote one argument for `CreateProcessW`, which takes a single string and
/// leaves splitting to the callee. Follows the `CommandLineToArgvW` rules that
/// the C runtime and every mainstream shell parse with: backslashes are literal
/// except when they precede the closing quote, where they must be doubled.
#[cfg_attr(not(windows), allow(dead_code))]
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // These backslashes now precede a quote, so they need escaping
                // too, or they would escape the quote instead of standing alone.
                out.push_str(&"\\".repeat(backslashes + 1));
                backslashes = 0;
                out.push('"');
            }
            other => {
                backslashes = 0;
                out.push(other);
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes));
    out.push('"');
    out
}

/// Join a program and its arguments into a `CreateProcessW` command line.
#[cfg_attr(not(windows), allow(dead_code))]
fn command_line(program: &Path, args: &[String]) -> String {
    let mut line = quote_arg(&program.to_string_lossy());
    for a in args {
        line.push(' ');
        line.push_str(&quote_arg(a));
    }
    line
}

/// What the helper was asked to do, parsed from its own argv.
#[cfg_attr(not(windows), allow(dead_code))]
struct Request {
    workspace: PathBuf,
    scratch: Option<PathBuf>,
    /// Folders the run was authorized to write besides its workspace: a
    /// managed worktree, or the user's own folders under "Edit this folder".
    /// The helper grants each an ACE, refusing any [`grant_refusal`] names.
    write_roots: Vec<PathBuf>,
    /// Attached folders the run may only read: granted read+execute, never
    /// write, so a command can list and build from them while every write
    /// still lands in the workspace.
    read_roots: Vec<PathBuf>,
    /// True for a long-lived spawn (a confined MCP server) that holds its
    /// grants under its own process id; false for a shell command.
    own_holder: bool,
    /// Where the shell starts: the workspace, or one of `write_roots`.
    start_dir: PathBuf,
    allow_network: bool,
    /// Toolchain folders the user granted, for the sandbox `PATH`.
    path_dirs: Vec<PathBuf>,
    program: PathBuf,
    args: Vec<String>,
}

/// Parse the helper's argv, or `None` when this process was not invoked as the
/// helper. Kept separate from the Win32 work so it is testable on any host.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_request<I: IntoIterator<Item = String>>(argv: I) -> Option<Request> {
    let mut it = argv.into_iter();
    if it.next()? != SANDBOX_EXEC_FLAG {
        return None;
    }
    let allow_network = match it.next()?.as_str() {
        NET_ON => true,
        NET_OFF => false,
        _ => return None,
    };
    let workspace = PathBuf::from(it.next()?);
    let scratch = match it.next()? {
        s if s.is_empty() => None,
        s => Some(PathBuf::from(s)),
    };
    let mut write_roots = Vec::new();
    let mut read_roots = Vec::new();
    let mut own_holder = false;
    let mut path_dirs = Vec::new();
    let mut start_dir = None;
    loop {
        let next = it.next()?;
        if next == "--" {
            break;
        }
        if let Some(dir) = next.strip_prefix(PATH_DIR) {
            path_dirs.push(PathBuf::from(dir));
            continue;
        }
        if next == OWN_HOLDER {
            own_holder = true;
            continue;
        }
        if let Some(root) = next.strip_prefix(READ_ROOT) {
            read_roots.push(PathBuf::from(root));
            continue;
        }
        if let Some(start) = next.strip_prefix(START_DIR) {
            if start_dir.is_some() {
                return None;
            }
            start_dir = Some(PathBuf::from(start));
            continue;
        }
        write_roots.push(PathBuf::from(next.strip_prefix(WRITE_ROOT)?));
    }
    // A start directory the container was not granted would fail at spawn with
    // an opaque error, or start somewhere no ACE vouches for: refuse it here.
    let start_dir = match start_dir {
        None => workspace.clone(),
        Some(start) if write_roots.contains(&start) => start,
        Some(_) => return None,
    };
    let program = PathBuf::from(it.next()?);
    Some(Request {
        workspace,
        scratch,
        write_roots,
        read_roots,
        own_holder,
        start_dir,
        allow_network,
        path_dirs,
        program,
        args: it.collect(),
    })
}

/// True when this host can build an AppContainer at all. On Windows this only
/// probes that the API exists (Windows 8 and later, and not a reimplementation
/// such as Wine); deriving a SID is a pure hash and touches nothing.
#[cfg(windows)]
pub fn available() -> bool {
    win::derive_sid("Jan.Agent.Probe").is_ok()
}

#[cfg(not(windows))]
pub fn available() -> bool {
    false
}

/// Discard the container a thread workspace was using. Called when the workspace
/// is deleted, so a finished conversation does not leave a registered profile and
/// an empty `AppData\Local\Packages` directory behind -- monikers are derived per
/// workspace, so nothing else would ever reuse it.
///
/// Best effort, and safe to call for a workspace that never ran a command. A
/// profile that outlives its workspace is litter rather than exposure: its SID is
/// only granted on a directory that no longer exists.
#[cfg(windows)]
pub fn release(workspace: &Path) {
    revoke_roots(workspace);
    win::delete_profile(&moniker(workspace));
}

#[cfg(not(windows))]
pub fn release(_workspace: &Path) {}

/// Remove every ACE this workspace's container was given on an attached
/// folder or worktree, now, rather than at its next command. Called when a
/// session's grant is revoked or replaced: the next command re-grants exactly
/// what is still authorized. Only ACEs naming this container are touched.
#[cfg(windows)]
pub fn revoke_roots(workspace: &Path) {
    let name = moniker(workspace);
    if let Err(e) = win::revoke_recorded_roots(&name) {
        eprintln!("could not withdraw the folder grants of {name}: {e}");
    }
}

#[cfg(not(windows))]
pub fn revoke_roots(_workspace: &Path) {}

/// A long-lived holder (a confined MCP server whose helper had `pid`) has
/// stopped: forget its grants and re-apply what the session's other holders
/// still need. Nothing another live holder needs is withdrawn.
#[cfg(windows)]
pub fn release_holder(workspace: &Path, pid: u32) {
    let name = moniker(workspace);
    if let Err(e) = win::release_holder(&name, &format!("mcp-{pid}")) {
        eprintln!("could not withdraw the folder grants of {name}/{pid}: {e}");
    }
}

#[cfg(not(windows))]
pub fn release_holder(_workspace: &Path, _pid: u32) {}

/// Withdraw every folder grant any container still holds. Called once at
/// startup: grants live in process memory, so after a restart no session
/// holds one, and an ACE left by the previous run (a crash, a quit mid-run)
/// is authority nobody can see. Commands re-grant what applies when they run.
#[cfg(windows)]
pub fn sweep_recorded_roots() {
    let Ok(entries) = std::fs::read_dir(win::roots_record_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        // Each container's applied record is a file; its holders sit in a
        // directory beside it, removed with the record.
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Err(e) = win::revoke_recorded_roots(&name) {
            eprintln!("could not withdraw the folder grants of {name}: {e}");
        }
    }
}

#[cfg(not(windows))]
pub fn sweep_recorded_roots() {}

/// Holds sandboxed spawns back while the startup sweep runs, so no command
/// starts with a grant the sweep is about to withdraw (or re-grants a folder
/// the sweep then strips mid-command). Idle and finished both let a spawn
/// through at once; only a sweep in progress makes it wait.
pub struct SweepGate {
    /// 0 idle, 1 running, 2 finished.
    state: std::sync::Mutex<u8>,
    changed: std::sync::Condvar,
}

impl SweepGate {
    pub const fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(0),
            changed: std::sync::Condvar::new(),
        }
    }

    pub fn begin(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = 1;
        }
    }

    pub fn finish(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = 2;
        }
        self.changed.notify_all();
    }

    /// Wait until no sweep is running, at most `timeout`. True when none is.
    pub fn wait(&self, timeout: std::time::Duration) -> bool {
        let Ok(state) = self.state.lock() else {
            return true;
        };
        match self.changed.wait_timeout_while(state, timeout, |s| *s == 1) {
            Ok((state, _)) => *state != 1,
            Err(_) => true,
        }
    }
}

impl Default for SweepGate {
    fn default() -> Self {
        Self::new()
    }
}

static STARTUP_SWEEP: SweepGate = SweepGate::new();

/// Run [`sweep_recorded_roots`] off the calling thread, with every sandboxed
/// spawn held at [`await_startup_sweep`] until it is done. The gate closes
/// before this returns, so a spawn issued right after cannot slip ahead.
pub fn start_startup_sweep() {
    STARTUP_SWEEP.begin();
    std::thread::spawn(|| {
        // Opened again even if the sweep panics, so spawns are not held for
        // the whole timeout.
        struct Open;
        impl Drop for Open {
            fn drop(&mut self) {
                STARTUP_SWEEP.finish();
            }
        }
        let _open = Open;
        sweep_recorded_roots();
    });
}

/// Wait for a startup sweep in progress. Bounded: a sweep stuck on one ACL
/// must not stop every command for good, so after the timeout the spawn goes
/// ahead (the helper re-grants exactly what it is authorized for anyway).
pub fn await_startup_sweep() {
    if !STARTUP_SWEEP.wait(std::time::Duration::from_secs(10)) {
        eprintln!("the startup folder-grant sweep is still running; starting the command anyway");
    }
}

/// Why the container must never be granted `path`, or `None` when it may be.
///
/// A grant is inheritable, so granting a folder grants everything under it:
/// a drive root, the user's profile (or a folder holding it), Windows,
/// Program Files or Flint's own data folder would hand the sandbox the whole
/// machine, the user's keys or Flint's settings. Checked by the helper for
/// every folder it grants, whatever asked for it; the data folder itself is
/// also refused when a grant is authorized ([`crate::grants`]).
pub fn grant_refusal(path: &Path) -> Option<String> {
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let protected: Vec<PathBuf> = [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
    ]
    .iter()
    .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
    .collect();
    // Flint's data folder is checked where the grant is issued, which knows
    // it: its managed worktrees live inside it and must stay grantable.
    grant_refusal_in(path, profile.as_deref(), &protected)
}

/// [`grant_refusal`] against explicit locations, so it is testable anywhere.
pub fn grant_refusal_in(
    path: &Path,
    profile: Option<&Path>,
    protected: &[PathBuf],
) -> Option<String> {
    // Compared case-insensitively with one separator, as Windows resolves them.
    let key = |p: &Path| -> Vec<String> {
        p.to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .to_lowercase()
            .split('\\')
            .filter(|c| !c.is_empty() && *c != ".")
            .map(str::to_string)
            .collect()
    };
    let target = key(path);
    if target.len() <= 1 || target.iter().any(|c| c == "..") {
        return Some(format!(
            "{} is a drive root or not a plain folder path",
            path.display()
        ));
    }
    if let Some(home) = profile.map(key).filter(|h| !h.is_empty()) {
        if home.starts_with(&target) {
            return Some(format!("{} is or holds the user profile", path.display()));
        }
    }
    for dir in protected.iter().map(|d| key(d)).filter(|d| !d.is_empty()) {
        if target.starts_with(&dir) || dir.starts_with(&target) {
            return Some(format!(
                "{} is, holds or is inside a protected system or Flint folder",
                path.display()
            ));
        }
    }
    None
}

/// Does this SDDL string carry an allow ACE for every AppContainer?
///
/// That is `ALL APPLICATION PACKAGES` (`AC`, `S-1-15-2-1`). A lowbox token
/// passes an access check only when the DACL grants its package SID, one of its
/// capabilities, or that group; `Everyone` (`WD`) alone is not enough, which is
/// exactly the case this answers. Pure so it is testable on every platform.
pub fn sddl_admits_app_packages(sddl: &str) -> bool {
    let dacl = match sddl.find("D:") {
        Some(at) => &sddl[at + 2..],
        None => return false,
    };
    // The DACL ends where the SACL (`S:`) begins.
    let dacl = dacl.split("S:").next().unwrap_or(dacl);
    dacl.split('(').skip(1).any(|ace| {
        let fields: Vec<&str> = ace.trim_end_matches(')').split(';').collect();
        fields.len() >= 6
            && fields[0] == "A"
            && matches!(fields[5].trim_end_matches(')'), "AC" | "S-1-15-2-1")
    })
}

/// Whether a process in the sandbox can open the NUL device on this machine.
///
/// `Some(false)` means `\Device\Null`'s DACL grants `Everyone` but not `ALL
/// APPLICATION PACKAGES`, so every open of `NUL` / `\.\NUL` from inside an
/// AppContainer is refused with "Access is denied" -- Go's buildID probe and
/// telemetry child, git's `/dev/null`, `> NUL` in cmd. The container itself is
/// a plain (not less-privileged) AppContainer, so no capability can fix this:
/// the only remedy is an ACE on the device object, a machine-wide security
/// change that needs an administrator and that Jan deliberately does not make
/// on its own. What Jan can do is say so instead of blaming a folder grant.
/// `None` when the descriptor could not be read (the answer is unknown).
#[cfg(windows)]
pub fn null_device_admits_sandbox() -> Option<bool> {
    static CACHE: std::sync::OnceLock<Option<bool>> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| win::null_device_sddl().map(|sddl| sddl_admits_app_packages(&sddl)))
}

#[cfg(not(windows))]
pub fn null_device_admits_sandbox() -> Option<bool> {
    None
}

/// Where a sandboxed launch got to before it failed.
///
/// The point of naming the stage is that the fixes are completely different.
/// A failure at [`Stage::ProcessCreation`] means no process exists and the
/// request itself was rejected -- a bad environment block, an unreadable
/// executable, the wrong architecture. A failure at [`Stage::RuntimeStartup`]
/// means the process was created and its own loader gave up, which no amount of
/// changing the spawn will fix. Reporting one as the other is how a missing
/// environment variable came to be described to users as a Git installation in
/// the wrong place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Choosing which shell to run.
    ShellDiscovery,
    /// Resolving the shell to a real, canonical path.
    Canonicalize,
    /// Creating the container profile and applying the workspace ACLs.
    SandboxPolicy,
    /// Building the environment block the child will receive.
    Environment,
    /// The `CreateProcessW` call. Nothing exists yet when this fails.
    ProcessCreation,
    /// The process exists; its loader or language runtime failed to start.
    RuntimeStartup,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::ShellDiscovery => "shell-discovery",
            Stage::Canonicalize => "canonicalize",
            Stage::SandboxPolicy => "sandbox-policy",
            Stage::Environment => "environment",
            Stage::ProcessCreation => "process-creation",
            Stage::RuntimeStartup => "runtime-startup",
        }
    }

    /// True once a process has actually been created. The single most useful
    /// bit in a report: before it, the request was refused; after it, the
    /// program ran and something inside it failed.
    pub fn after_process_creation(self) -> bool {
        matches!(self, Stage::RuntimeStartup)
    }
}

/// A launch failure, with enough structure that the message can be assembled
/// from facts rather than from a guess about what usually goes wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchFailure {
    pub stage: Stage,
    /// The Windows API that reported it, verbatim.
    pub api: &'static str,
    /// The OS error or exit status, when there is one.
    pub code: Option<i32>,
    /// What was being attempted, in the caller's words.
    pub detail: String,
    /// The actual unmet requirement, when the code identifies one.
    pub requirement: Option<String>,
}

impl LaunchFailure {
    pub fn new(stage: Stage, api: &'static str, detail: impl Into<String>) -> Self {
        Self {
            stage,
            api,
            code: None,
            detail: detail.into(),
            requirement: None,
        }
    }

    pub fn with_code(mut self, code: i32) -> Self {
        self.code = Some(code);
        self
    }

    pub fn with_requirement(mut self, requirement: impl Into<String>) -> Self {
        self.requirement = Some(requirement.into());
        self
    }
}

impl std::fmt::Display for LaunchFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.detail)?;
        if let Some(requirement) = &self.requirement {
            write!(f, " {requirement}")?;
        }
        Ok(())
    }
}

/// `ERROR_ENVVAR_NOT_FOUND`. `CreateProcessW` returns it for an AppContainer
/// spawn whose environment block is missing a name Windows needs to resolve the
/// container's own storage -- `LOCALAPPDATA` above all. It has nothing to do
/// with where the program is installed.
pub const ERROR_ENVVAR_NOT_FOUND: i32 = 203;

/// `STATUS_DLL_INIT_FAILED` as a process exit code: the image was loaded and a
/// DLL's initialisation refused. The process existed, so the spawn was fine.
pub const STATUS_DLL_INIT_FAILED: i32 = -1073741502; // 0xC0000142

/// The real unmet requirement behind a `CreateProcessW` failure code.
///
/// Every arm names something checkable. None of them guesses at an install
/// layout: the code says which precondition was not met, and the message says
/// that and nothing more.
pub fn create_process_requirement(code: i32, missing_env: &[&str]) -> String {
    match code {
        2 | 3 => "The executable does not exist at that path.".to_string(),
        5 => "The sandbox has no read/execute access to the executable or to a \
              directory on the way to it."
            .to_string(),
        193 => "The executable is not a Windows program this machine can run \
                (wrong architecture, or not an executable image)."
            .to_string(),
        ERROR_ENVVAR_NOT_FOUND => {
            if missing_env.is_empty() {
                "The environment block handed to the sandbox is missing a variable \
                 Windows needs in order to create a sandboxed process. This is a \
                 fault in Jan's environment builder, not in the shell installation."
                    .to_string()
            } else {
                format!(
                    "The environment block handed to the sandbox is missing {}, \
                     which Windows needs to resolve the sandbox's own storage. This \
                     is a fault in Jan's environment builder, not in the shell \
                     installation.",
                    missing_env.join(", ")
                )
            }
        }
        1260 => "A software restriction policy on this machine blocked the \
                 executable."
            .to_string(),
        _ => "The sandbox could not start the program; the Windows error above is \
              the whole of what it reported."
            .to_string(),
    }
}

/// Explain an exit status that is really a startup failure, or `None` when the
/// program simply ran and exited with that code.
pub fn runtime_startup_requirement(exit_code: i32, program: &Path) -> Option<String> {
    if exit_code != STATUS_DLL_INIT_FAILED {
        return None;
    }
    let mut message = String::from(
        "The program started and then its runtime failed to initialise \
         (STATUS_DLL_INIT_FAILED).",
    );
    if uses_msys_runtime(program) {
        message.push_str(
            " Git Bash and the other MSYS2 programs shipped with Git for Windows \
             cannot initialise inside a Windows AppContainer: the MSYS runtime needs \
             the global object namespace, which the sandbox does not grant. That is a \
             property of the shell, not of where it is installed -- a system-wide \
             install fails identically. Use PowerShell or cmd for sandboxed commands, \
             or turn the sandbox off for this project.",
        );
    }
    Some(message)
}

/// True for a program that runs on the MSYS2 runtime (`msys-2.0.dll`), which is
/// every shell and coreutil under a Git for Windows or MSYS2 installation.
/// Matched on the install layout rather than by reading the image, because the
/// caller needs the answer before anything has been loaded.
pub fn uses_msys_runtime(program: &Path) -> bool {
    let lower = program.to_string_lossy().to_lowercase().replace('/', "\\");
    if lower.contains("\\usr\\bin\\") || lower.contains("\\msys64\\") || lower.contains("\\msys2\\")
    {
        return true;
    }
    // `<git>\bin\bash.exe` is a launcher for the MSYS2 bash two directories
    // over, so it fails in exactly the same way and for the same reason.
    let under_git_bin = lower.contains("\\git\\bin\\") || lower.contains("\\git\\usr\\bin\\");
    let shellish = ["bash.exe", "sh.exe", "dash.exe", "zsh.exe"]
        .iter()
        .any(|name| lower.ends_with(&format!("\\{name}")));
    under_git_bin && shellish
}

/// Directories a shell's own installation needs on `PATH` to work at all.
///
/// A Git for Windows `bash.exe` is a launcher for the MSYS2 bash two
/// directories over, and every external command it runs (`ls`, `grep`, `git`)
/// lives in a sibling directory. Handing the sandbox only the system `PATH`
/// gives it a shell that cannot find its own coreutils.
///
/// Returns candidates in preference order; the caller keeps the ones that exist.
pub fn shell_runtime_dirs(program: &Path) -> Vec<PathBuf> {
    let Some(bin) = program.parent() else {
        return Vec::new();
    };
    let mut out = vec![bin.to_path_buf()];
    // `<root>\bin\bash.exe` and `<root>\usr\bin\bash.exe` are both real layouts,
    // so the installation root is found by walking up past a `usr`.
    let root = match bin.parent() {
        Some(parent)
            if parent
                .file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("usr")) =>
        {
            parent.parent()
        }
        other => other,
    };
    if let Some(root) = root {
        for relative in [
            "bin",
            "usr\\bin",
            "mingw64\\bin",
            "mingw32\\bin",
            "usr\\local\\bin",
            "cmd",
        ] {
            let candidate = root.join(relative);
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// `PATH` for the confined shell: the system directories, then the shell's own
/// installation, then the host's toolchain folders the container may run.
///
/// Built rather than inherited so a host `PATH` entry under the user's profile
/// -- which the sandbox cannot read -- does not turn into an unexplained
/// "command not found" inside it. Host folders come after the system ones so
/// none can shadow a system program; folders in the profile, or whose ACL does
/// not admit app packages, stay out -- except `granted`, the folders the user
/// explicitly let the sandbox use. Those arrive with the helper request: the
/// helper is a separate process and never reads the grant record itself.
pub fn build_sandbox_path(
    system_root: Option<PathBuf>,
    runtime_dirs: Vec<PathBuf>,
    host_path: Option<OsString>,
    profile: Option<PathBuf>,
    granted: &[PathBuf],
    can_execute: impl Fn(&Path) -> Option<bool>,
) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(root) = system_root {
        let system32 = root.join("system32");
        dirs.push(system32.clone());
        dirs.push(root.clone());
        dirs.push(system32.join("Wbem"));
        dirs.push(system32.join("WindowsPowerShell").join("v1.0"));
    }
    for dir in runtime_dirs {
        if dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    let host = host_path.unwrap_or_default();
    let extra = crate::tools::host_tools::usable_host_dirs(
        &host,
        profile.as_deref(),
        &dirs,
        granted,
        can_execute,
    );
    dirs.extend(extra);
    OsString::from(
        dirs.iter()
            .map(|d| d.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(";"),
    )
}

/// Run the confined spawn and exit with the child's status, when this process
/// was re-exec'd as the helper. Returns immediately on a normal launch, so it is
/// safe (and required) to call first thing in `main`.
#[cfg(windows)]
pub fn run_helper_if_requested() {
    let Some(req) = parse_request(std::env::args().skip(1)) else {
        return;
    };
    match win::run(&req) {
        Ok(code) => std::process::exit(code),
        Err(failure) => {
            // One structured line for a machine, then the sentence a person
            // reads. Neither carries an environment value, a command, or a
            // credential.
            eprintln!(
                "ERROR: sandbox setup failed [stage={} api={} code={} after_process_creation={}]",
                failure.stage.as_str(),
                failure.api,
                failure
                    .code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                failure.stage.after_process_creation(),
            );
            eprintln!("ERROR: {failure}");
            std::process::exit(HELPER_FAILURE);
        }
    }
}

#[cfg(not(windows))]
pub fn run_helper_if_requested() {}

/// One ACL change [`win::sync_write_roots`] makes for the write roots.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AclStep {
    /// Remove every ACE naming the container from this path.
    Revoke(PathBuf),
    /// Cut this path (a write root's `.jan`) off from the container: its DACL
    /// stops inheriting and keeps every ACE except the container's, so
    /// nothing under it names the container. Created first when missing.
    ///
    /// Not a deny ACE: the AppContainer half of an access check only looks
    /// for ACEs that *allow* the package SID, and a deny ACE naming it does
    /// not stop an inherited grant (a confined shell read `.jan` through
    /// one). The only way to withhold access is to have no grant at all.
    IsolateJan(PathBuf),
    /// Grant the container a write root: full access minus deleting children
    /// by the parent's right, so the denied `.jan` cannot be renamed away and
    /// replaced (see [`win::sync_write_roots`]).
    GrantRoot(PathBuf),
    /// Grant the container read and execute on an attached folder, nothing
    /// more: writes still land in the workspace.
    GrantRead(PathBuf),
}

/// What [`win::sync_write_roots`] must do to move from the `previous` write
/// roots to `roots`. Pure, so the decision is testable without touching an
/// ACL.
///
/// Every root in `roots` is granted with its `.jan` denied (Jozkah/jan#124:
/// the worktree carries the project's agent policy and hooks there). A
/// previous root no longer granted loses its ACE (its `.jan` is already
/// cut off and has nothing to revoke, but is revoked anyway to clear an
/// ACE an earlier build left)
/// (Jozkah/jan#217); one that is gone (`!is_dir`) needs nothing.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn write_root_acl_plan(
    previous: &[PathBuf],
    roots: &[PathBuf],
    is_dir: impl Fn(&Path) -> bool,
) -> Vec<AclStep> {
    root_acl_plan(previous, roots, &[], is_dir)
}

/// [`write_root_acl_plan`], plus folders granted read-only. A folder recorded
/// before and in neither list now is revoked; a read root that is also a write
/// root is granted once, writable. A read root's `.jan` is left as the user
/// has it: nothing is written into a folder under Review only.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn root_acl_plan(
    previous: &[PathBuf],
    roots: &[PathBuf],
    read_roots: &[PathBuf],
    is_dir: impl Fn(&Path) -> bool,
) -> Vec<AclStep> {
    let jan = |root: &Path| root.join(crate::tools::sandbox::JAN_DIR);
    let mut steps = Vec::new();
    for old in previous {
        if !roots.contains(old) && !read_roots.contains(old) && is_dir(old) {
            if is_dir(&jan(old)) {
                steps.push(AclStep::Revoke(jan(old)));
            }
            steps.push(AclStep::Revoke(old.clone()));
        }
    }
    for root in roots {
        steps.push(AclStep::IsolateJan(jan(root)));
        steps.push(AclStep::GrantRoot(root.clone()));
    }
    for root in read_roots {
        if !roots.contains(root) {
            steps.push(AclStep::GrantRead(root.clone()));
        }
    }
    steps
}

/// The record of what a container was granted: one line per folder, the bare
/// path for a write root (the format every earlier build wrote) and `r<TAB>`
/// before it for a read root.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn roots_record(write: &[PathBuf], read: &[PathBuf]) -> String {
    write
        .iter()
        .map(|r| r.to_string_lossy().into_owned())
        .chain(
            read.iter()
                .filter(|r| !write.contains(r))
                .map(|r| format!("r\t{}", r.to_string_lossy())),
        )
        .collect::<Vec<_>>()
        .join("\n")
}

/// The folders a container must be granted: every live holder's, unioned.
/// A folder any holder writes is written; one only read is read. So one
/// holder changing its own set never withdraws what another still uses.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn union_roots(
    holders: &[(Vec<PathBuf>, Vec<PathBuf>)],
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut write: Vec<PathBuf> = Vec::new();
    let mut read: Vec<PathBuf> = Vec::new();
    for (w, _) in holders {
        for root in w {
            if !write.contains(root) {
                write.push(root.clone());
            }
        }
    }
    for (_, r) in holders {
        for root in r {
            if !write.contains(root) && !read.contains(root) {
                read.push(root.clone());
            }
        }
    }
    (write, read)
}

/// Where a container's holders record what each needs, beside its record.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn holders_dir(record: &Path) -> PathBuf {
    let mut name = record.as_os_str().to_os_string();
    name.push(".holders");
    PathBuf::from(name)
}

/// [`roots_record`] read back: `(write roots, read roots)`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_roots_record(text: &str) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let (mut write, mut read) = (Vec::new(), Vec::new());
    for line in text.lines().filter(|l| !l.is_empty()) {
        match line.strip_prefix("r\t") {
            Some(path) => read.push(PathBuf::from(path)),
            None => write.push(PathBuf::from(line)),
        }
    }
    (write, read)
}

#[cfg(windows)]
mod win {
    use super::{grant_refusal, root_acl_plan, AclStep};
    use super::{
        command_line, create_process_requirement, moniker, runtime_startup_requirement,
        shell_runtime_dirs, LaunchFailure, Request, Stage,
    };
    use crate::tools::win_env::{self, ProcessEnv, SandboxEnv, SandboxEnvSpec};
    use std::ffi::{c_void, OsStr, OsString};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use windows_sys::core::{HRESULT, PWSTR};
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, SetHandleInformation, ERROR_SUCCESS, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE, WAIT_FAILED,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, ACCESS_MODE,
        EXPLICIT_ACCESS_W, GRANT_ACCESS, REVOKE_ACCESS, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, FreeSid, WinCapabilityInternetClientSid,
        WinCapabilityPrivateNetworkClientServerSid, WELL_KNOWN_SID_TYPE, ACL, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_CAPABILITIES, SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ALL_ACCESS, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
        InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
        CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    /// `HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`: the profile survived a previous
    /// run, which is the normal case for a thread's second command.
    const PROFILE_EXISTS: HRESULT = -2147024713; // 0x800700B7

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> String {
        std::io::Error::last_os_error().to_string()
    }

    fn last_error_code() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    /// The DACL of `\.\NUL` as SDDL, read with `READ_CONTROL` only.
    pub fn null_device_sddl() -> Option<String> {
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo,
            SDDL_REVISION_1,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        const READ_CONTROL: u32 = 0x0002_0000;
        let name = wide(OsStr::new(r"\\.\NUL"));
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        unsafe { CloseHandle(handle) };
        if status != ERROR_SUCCESS || sd.is_null() {
            return None;
        }
        let mut text: PWSTR = std::ptr::null_mut();
        let ok = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            )
        };
        unsafe { LocalFree(sd as _) };
        if ok == 0 || text.is_null() {
            return None;
        }
        let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
        let sddl = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        unsafe { LocalFree(text as _) };
        Some(sddl)
    }

    /// Owns a `PSID` allocated by the isolation APIs.
    pub struct ContainerSid(PSID);

    impl Drop for ContainerSid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { FreeSid(self.0) };
            }
        }
    }

    pub fn derive_sid(moniker: &str) -> Result<ContainerSid, String> {
        let name = wide(OsStr::new(moniker));
        let mut sid: PSID = std::ptr::null_mut();
        let hr = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
        if hr < 0 || sid.is_null() {
            return Err(format!(
                "could not derive an AppContainer SID (hr 0x{hr:08x})"
            ));
        }
        Ok(ContainerSid(sid))
    }

    /// Register the container profile if this is its first use, then return its
    /// SID. Capabilities are supplied per spawn instead of at creation, so the
    /// SID does not depend on whether network was allowed.
    fn ensure_profile(moniker: &str) -> Result<ContainerSid, String> {
        let name = wide(OsStr::new(moniker));
        let display = wide(OsStr::new("Jan agent tools"));
        let description = wide(OsStr::new("Sandbox for the Jan agent's shell tool"));
        let mut sid: PSID = std::ptr::null_mut();
        let hr = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                std::ptr::null_mut(),
                0,
                &mut sid,
            )
        };
        if hr >= 0 && !sid.is_null() {
            return Ok(ContainerSid(sid));
        }
        if hr == PROFILE_EXISTS {
            return derive_sid(moniker);
        }
        Err(format!(
            "could not create the AppContainer profile (hr 0x{hr:08x})"
        ))
    }

    /// Whether `path`'s own DACL holds an ACE naming `sid`. Test support.
    #[cfg(test)]
    pub(super) fn acl_names(path: &Path, sid: PSID) -> bool {
        use windows_sys::Win32::Security::{
            AclSizeInformation, EqualSid, GetAce, GetAclInformation, ACCESS_ALLOWED_ACE,
            ACL_SIZE_INFORMATION,
        };
        let object = wide(path.as_os_str());
        let mut acl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                object.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut acl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, ERROR_SUCCESS, "GetNamedSecurityInfoW");
        let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            GetAclInformation(
                acl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        assert_ne!(ok, 0, "GetAclInformation");
        let mut found = false;
        for i in 0..info.AceCount {
            let mut ace: *mut c_void = std::ptr::null_mut();
            if unsafe { GetAce(acl, i, &mut ace) } == 0 {
                continue;
            }
            // Allowed and denied ACEs share this layout: header, mask, SID.
            let entry = ace as *const ACCESS_ALLOWED_ACE;
            let ace_sid = unsafe { std::ptr::addr_of!((*entry).SidStart) } as PSID;
            if unsafe { EqualSid(ace_sid, sid) } != 0 {
                found = true;
            }
        }
        unsafe { LocalFree(descriptor) };
        found
    }

    /// The ACEs on `path`'s own DACL naming `sid`, as `(ace type, flags,
    /// mask)`: type 0 is allow, 1 is deny; flag 0x10 marks an inherited ACE.
    /// Test support.
    #[cfg(test)]
    pub(super) fn aces_for(path: &Path, sid: PSID) -> Vec<(u8, u8, u32)> {
        use windows_sys::Win32::Security::{
            AclSizeInformation, EqualSid, GetAce, GetAclInformation, ACCESS_ALLOWED_ACE,
            ACL_SIZE_INFORMATION,
        };
        let object = wide(path.as_os_str());
        let mut acl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                object.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut acl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, ERROR_SUCCESS, "GetNamedSecurityInfoW");
        let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            GetAclInformation(
                acl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        assert_ne!(ok, 0, "GetAclInformation");
        let mut out = Vec::new();
        for i in 0..info.AceCount {
            let mut ace: *mut c_void = std::ptr::null_mut();
            if unsafe { GetAce(acl, i, &mut ace) } == 0 {
                continue;
            }
            let entry = ace as *const ACCESS_ALLOWED_ACE;
            let ace_sid = unsafe { std::ptr::addr_of!((*entry).SidStart) } as PSID;
            if unsafe { EqualSid(ace_sid, sid) } != 0 {
                let e = unsafe { &*entry };
                out.push((e.Header.AceType, e.Header.AceFlags, e.Mask));
            }
        }
        unsafe { LocalFree(descriptor) };
        out
    }

    /// The rights the DACL of `path` gives `sid`, deny ACEs applied
    /// (GetEffectiveRightsFromAclW). Test support.
    #[cfg(test)]
    pub(super) fn effective_rights(path: &Path, sid: PSID) -> u32 {
        use windows_sys::Win32::Security::Authorization::GetEffectiveRightsFromAclW;
        let object = wide(path.as_os_str());
        let mut acl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                object.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut acl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, ERROR_SUCCESS, "GetNamedSecurityInfoW");
        let trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: sid as PWSTR,
        };
        let mut mask: u32 = 0;
        let status = unsafe { GetEffectiveRightsFromAclW(acl, &trustee, &mut mask) };
        unsafe { LocalFree(descriptor) };
        assert_eq!(status, ERROR_SUCCESS, "GetEffectiveRightsFromAclW");
        mask
    }

    /// Grant `path` the pre-#124 way (FILE_ALL_ACCESS, merged). Test support.
    #[cfg(test)]
    pub(super) fn legacy_grant(path: &Path, sid: PSID) {
        set_access(path, sid, GRANT_ACCESS, FILE_ALL_ACCESS).unwrap();
    }

    #[cfg(test)]
    pub(super) const DELETE_CHILD: u32 = FILE_DELETE_CHILD;

    /// A container SID for tests, with its profile.
    #[cfg(test)]
    pub(super) fn test_profile(moniker: &str) -> Result<ContainerSid, String> {
        ensure_profile(moniker)
    }

    #[cfg(test)]
    pub(super) fn sid_ptr(sid: &ContainerSid) -> PSID {
        sid.0
    }

    pub fn delete_profile(moniker: &str) {
        let name = wide(OsStr::new(moniker));
        unsafe { DeleteAppContainerProfile(name.as_ptr()) };
    }

    /// Grant the container full access to `path` and everything created under it.
    /// This is the entire write policy: without an ACE naming the container, a
    /// lowbox token can open nothing it was not given. Called for the workspace
    /// and, when there is one, the session scratch.
    fn grant_path(path: &Path, sid: PSID) -> Result<(), String> {
        set_access(path, sid, GRANT_ACCESS, FILE_ALL_ACCESS)
    }

    /// Remove every ACE naming the container from `path` (Jozkah/jan#217). The
    /// grant is inheritable, so the change propagates to what was created under
    /// it the same way the grant did.
    ///
    /// REVOKE_ACCESS alone leaves a deny ACE in place (it removes allowed
    /// ones), so SET_ACCESS first discards every explicit ACE naming the
    /// container, deny included, and the revoke then removes what it added.
    fn revoke_path(path: &Path, sid: PSID) -> Result<(), String> {
        set_access(path, sid, SET_ACCESS, 0)?;
        set_access(path, sid, REVOKE_ACCESS, 0)
    }

    /// Where the write roots last granted to a container are recorded: in the
    /// host's temp folder, which the container cannot write, so a sandboxed
    /// command cannot erase the record to keep a grant alive.
    pub(super) fn write_root_record(moniker: &str) -> PathBuf {
        roots_record_dir().join(moniker)
    }

    pub(super) fn roots_record_dir() -> PathBuf {
        std::env::temp_dir().join("jan-appcontainer-write-roots")
    }

    /// Revoke every folder the named container has recorded, then forget the
    /// record. Only ACEs naming this container's SID are removed.
    pub(super) fn revoke_recorded_roots(moniker: &str) -> Result<(), String> {
        let record = write_root_record(moniker);
        let _lock = RecordLock::acquire(&record)?;
        // Every holder goes: the grant they all rested on is gone.
        let _ = std::fs::remove_dir_all(super::holders_dir(&record));
        let Ok(text) = std::fs::read_to_string(&record) else {
            return Ok(());
        };
        let sid = derive_sid(moniker)?;
        let (write, read) = super::parse_roots_record(&text);
        let previous: Vec<PathBuf> = write.into_iter().chain(read).collect();
        for step in root_acl_plan(&previous, &[], &[], |p| p.is_dir()) {
            if let AclStep::Revoke(path) = step {
                revoke_path(&path, sid.0)?;
            }
        }
        std::fs::remove_file(&record).map_err(|e| format!("{}: {e}", record.display()))
    }

    /// Make the container's ACEs on authorized folders match `roots` exactly.
    ///
    /// The container SID is derived from the workspace, so it is the same for
    /// every command in a session; an ACE granted for a worktree the session
    /// has since lost (Review-only, a failed health check) would otherwise keep
    /// giving `bash` full access to it (Jozkah/jan#217). Every folder recorded
    /// as granted and no longer in `roots` is revoked before anything runs, then
    /// `roots` are granted and recorded. A recorded folder that is gone needs no
    /// revoking.
    #[cfg(test)]
    pub(super) fn sync_write_roots(
        record: &Path,
        sid: PSID,
        roots: &[PathBuf],
        read_roots: &[PathBuf],
    ) -> Result<(), String> {
        sync_holder_roots(record, sid, super::SHELL_HOLDER, roots, read_roots)
    }

    /// Forget one holder and re-apply what the others need.
    pub(super) fn release_holder(moniker: &str, holder: &str) -> Result<(), String> {
        let record = write_root_record(moniker);
        let _lock = RecordLock::acquire(&record)?;
        let _ = std::fs::remove_file(super::holders_dir(&record).join(holder));
        if !record.exists() {
            return Ok(());
        }
        let sid = derive_sid(moniker)?;
        apply_union(&record, sid.0)
    }

    /// Serializes every change to one container's grants across processes
    /// (the app, each shell helper, each MCP helper), so two holders syncing
    /// at once cannot interleave their read-modify-write of the record.
    struct RecordLock(windows_sys::Win32::Foundation::HANDLE);

    impl RecordLock {
        fn acquire(record: &Path) -> Result<Self, String> {
            use windows_sys::Win32::System::Threading::CreateMutexW;
            let key = record.to_string_lossy().to_lowercase();
            let name = wide(OsStr::new(&format!(
                "Local\\JanAgentRoots.{:016x}",
                super::fnv1a(key.as_bytes())
            )));
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
            if handle.is_null() {
                return Err(format!("could not open the grant lock: {}", last_error()));
            }
            // WAIT_ABANDONED (a holder died holding it) still grants ownership.
            let waited = unsafe { WaitForSingleObject(handle, 30_000) };
            if waited == WAIT_FAILED || waited == 0x102 {
                unsafe { CloseHandle(handle) };
                return Err("timed out waiting for the grant lock".to_string());
            }
            Ok(Self(handle))
        }
    }

    impl Drop for RecordLock {
        fn drop(&mut self) {
            use windows_sys::Win32::System::Threading::ReleaseMutex;
            unsafe {
                ReleaseMutex(self.0);
                CloseHandle(self.0);
            }
        }
    }

    /// Is this holder still live? The shell always is (its record is replaced
    /// by the next command); a process holder while its process runs.
    fn holder_alive(holder: &str) -> bool {
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        if holder == super::SHELL_HOLDER {
            return true;
        }
        let Some(pid) = holder.strip_prefix("mcp-").and_then(|p| p.parse::<u32>().ok()) else {
            return false;
        };
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }

    /// Record what `holder` needs, then make the container's ACEs the union
    /// of every live holder's needs. A folder is revoked only when no live
    /// holder needs it any more.
    pub(super) fn sync_holder_roots(
        record: &Path,
        sid: PSID,
        holder: &str,
        roots: &[PathBuf],
        read_roots: &[PathBuf],
    ) -> Result<(), String> {
        // A write grant on a forbidden folder is refused outright; a read one
        // is simply not made, so the run keeps its file tools and loses only
        // the shell's view of that folder.
        for root in roots {
            if let Some(why) = grant_refusal(root) {
                return Err(format!("refusing to grant the sandbox {why}"));
            }
        }
        let read_roots: Vec<PathBuf> = read_roots
            .iter()
            .filter(|r| r.is_dir() && grant_refusal(r).is_none())
            .cloned()
            .collect();
        let _lock = RecordLock::acquire(record)?;
        let holders = super::holders_dir(record);
        std::fs::create_dir_all(&holders).map_err(|e| format!("{}: {e}", holders.display()))?;
        let mine = holders.join(holder);
        std::fs::write(&mine, super::roots_record(roots, &read_roots))
            .map_err(|e| format!("{}: {e}", mine.display()))?;
        apply_union(record, sid)
    }

    /// Apply the union of every live holder's recorded needs, pruning holders
    /// that have stopped. The caller holds the record's lock.
    fn apply_union(record: &Path, sid: PSID) -> Result<(), String> {
        let mut needs = Vec::new();
        if let Ok(entries) = std::fs::read_dir(super::holders_dir(record)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !holder_alive(&name) {
                    let _ = std::fs::remove_file(entry.path());
                    continue;
                }
                let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                needs.push(super::parse_roots_record(&text));
            }
        }
        let (roots, read_roots) = super::union_roots(&needs);
        let (roots, read_roots) = (&roots[..], read_roots);
        let (old_write, old_read) =
            super::parse_roots_record(&std::fs::read_to_string(record).unwrap_or_default());
        let previous: Vec<PathBuf> = old_write.into_iter().chain(old_read).collect();
        for step in root_acl_plan(&previous, roots, &read_roots, |p| p.is_dir()) {
            match step {
                AclStep::Revoke(path) => revoke_path(&path, sid)?,
                // Jozkah/jan#124: the worktree's `.jan` holds the project's
                // agent policy and hooks. Created when missing so it is cut
                // off before the shell could make one of its own. A write root
                // is a managed worktree or, under "Edit this folder", a folder
                // the user authorized; the other backends hide its `.jan` too.
                AclStep::IsolateJan(jan) => {
                    if !jan.exists() {
                        std::fs::create_dir_all(&jan)
                            .map_err(|e| format!("{}: {e}", jan.display()))?;
                    }
                    isolate_path(&jan, sid)?;
                }
                // Without FILE_DELETE_CHILD the shell cannot rename the
                // cut-off `.jan` away by the parent's right and put its own
                // in its place. Deleting an ordinary file still works: every
                // child inherits DELETE from this same grant. SET_ACCESS, not
                // GRANT_ACCESS: a grant merges into an allow ACE already on
                // the root, and a worktree granted FILE_ALL_ACCESS by an
                // earlier build would keep FILE_DELETE_CHILD through it.
                AclStep::GrantRoot(root) => {
                    set_access(&root, sid, SET_ACCESS, FILE_ALL_ACCESS & !FILE_DELETE_CHILD)?
                }
                // SET_ACCESS: a folder that was writable last command and is
                // read-only now must lose the write ACE, not keep it merged.
                AclStep::GrantRead(root) => set_access(
                    &root,
                    sid,
                    SET_ACCESS,
                    FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                )?,
            }
        }
        if let Some(parent) = record.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let listed = super::roots_record(roots, &read_roots);
        std::fs::write(record, listed).map_err(|e| format!("{}: {e}", record.display()))
    }

    /// Give `path` a protected DACL holding every ACE it has now, explicit or
    /// inherited, except those naming `sid`. Inherited ACEs are kept as
    /// explicit ones so the user's own access is unchanged; the protection
    /// stops the container's grant on the parent from flowing back in, and
    /// the new DACL propagates to everything under `path`. Idempotent.
    fn isolate_path(path: &Path, sid: PSID) -> Result<(), String> {
        use windows_sys::Win32::Security::{
            AclSizeInformation, AddAce, EqualSid, GetAce, GetAclInformation, InitializeAcl,
            ACCESS_ALLOWED_ACE, ACE_HEADER, ACL_REVISION, ACL_SIZE_INFORMATION, INHERITED_ACE,
            PROTECTED_DACL_SECURITY_INFORMATION,
        };
        let mut object = wide(path.as_os_str());
        let mut existing: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                object.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut existing,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "could not read the ACL ({}): {}",
                path.display(),
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }
        let result = (|| {
            if existing.is_null() {
                return Err(format!("{} has no DACL to protect", path.display()));
            }
            let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe {
                GetAclInformation(
                    existing,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            } == 0
            {
                return Err(format!("could not size the ACL: {}", last_error()));
            }
            // The kept ACEs never outgrow the ACL they came from.
            let size = info.AclBytesInUse.max(std::mem::size_of::<ACL>() as u32);
            let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
            let acl = buffer.as_mut_ptr() as *mut ACL;
            if unsafe { InitializeAcl(acl, size, ACL_REVISION) } == 0 {
                return Err(format!("could not build the ACL: {}", last_error()));
            }
            for i in 0..info.AceCount {
                let mut ace: *mut c_void = std::ptr::null_mut();
                if unsafe { GetAce(existing, i, &mut ace) } == 0 {
                    continue;
                }
                let header = ace as *mut ACE_HEADER;
                // Allowed and denied ACEs share this layout: header, mask, SID.
                let entry = ace as *const ACCESS_ALLOWED_ACE;
                let ace_sid = unsafe { std::ptr::addr_of!((*entry).SidStart) } as PSID;
                if unsafe { EqualSid(ace_sid, sid) } != 0 {
                    continue;
                }
                let (flags, len) = unsafe { ((*header).AceFlags, (*header).AceSize) };
                // Inherited ACEs become explicit: the DACL is protected now.
                unsafe { (*header).AceFlags = flags & !(INHERITED_ACE as u8) };
                let added = unsafe { AddAce(acl, ACL_REVISION, u32::MAX, ace, len as u32) };
                unsafe { (*header).AceFlags = flags };
                if added == 0 {
                    return Err(format!("could not copy an ACE: {}", last_error()));
                }
            }
            let status = unsafe {
                SetNamedSecurityInfoW(
                    object.as_mut_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    acl,
                    std::ptr::null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                return Err(format!(
                    "could not apply the ACL ({}): {}",
                    path.display(),
                    std::io::Error::from_raw_os_error(status as i32)
                ));
            }
            Ok(())
        })();
        unsafe { LocalFree(descriptor) };
        result
    }

    fn set_access(path: &Path, sid: PSID, mode: ACCESS_MODE, mask: u32) -> Result<(), String> {
        let mut object = wide(path.as_os_str());
        let mut existing: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                object.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut existing,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "could not read the workspace ACL ({}): {}",
                path.display(),
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }

        // A grant or a deny is inherited by everything under the path; a
        // revoke has nothing to inherit.
        let inheriting = mode != REVOKE_ACCESS;
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: mask,
            grfAccessMode: mode,
            grfInheritance: if inheriting {
                CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
            } else {
                0
            },
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                ptstrName: sid as PWSTR,
            },
        };
        let mut merged: *mut ACL = std::ptr::null_mut();
        // GRANT_ACCESS merges into the existing DACL rather than replacing it, so
        // the user keeps their own access to the workspace.
        let status = unsafe { SetEntriesInAclW(1, &access, existing, &mut merged) };
        if status != ERROR_SUCCESS {
            unsafe { LocalFree(descriptor) };
            return Err(format!(
                "could not build the workspace ACL: {}",
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }

        let status = unsafe {
            SetNamedSecurityInfoW(
                object.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                merged,
                std::ptr::null_mut(),
            )
        };
        unsafe {
            LocalFree(merged as *mut c_void);
            LocalFree(descriptor);
        }
        if status != ERROR_SUCCESS {
            return Err(format!(
                "could not apply the workspace ACL ({}): {}",
                path.display(),
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }
        Ok(())
    }

    /// The `internetClient` capability, which is what makes outbound network calls
    /// possible at all for a lowbox token.
    fn internet_capability(buffer: &mut Vec<u8>) -> Result<SID_AND_ATTRIBUTES, String> {
        capability_sid(buffer, WinCapabilityInternetClientSid, "internetClient")
    }

    /// The `privateNetworkClientServer` capability. `internetClient` excludes
    /// private (LAN) addresses, so without this a resolver on the local network
    /// is unreachable and DNS fails for every host even with network on.
    fn private_network_capability(buffer: &mut Vec<u8>) -> Result<SID_AND_ATTRIBUTES, String> {
        capability_sid(
            buffer,
            WinCapabilityPrivateNetworkClientServerSid,
            "privateNetworkClientServer",
        )
    }

    fn capability_sid(
        buffer: &mut Vec<u8>,
        kind: WELL_KNOWN_SID_TYPE,
        name: &str,
    ) -> Result<SID_AND_ATTRIBUTES, String> {
        buffer.resize(SECURITY_MAX_SID_SIZE as usize, 0);
        let mut len = buffer.len() as u32;
        let ok = unsafe {
            CreateWellKnownSid(
                kind,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as PSID,
                &mut len,
            )
        };
        if ok == 0 {
            return Err(format!(
                "could not build the {name} capability: {}",
                last_error()
            ));
        }
        Ok(SID_AND_ATTRIBUTES {
            Sid: buffer.as_mut_ptr() as PSID,
            Attributes: 0,
        })
    }

    /// Mark the std handles inheritable so the confined shell receives the
    /// parent's pipes. They arrive already usable: an inherited handle keeps the
    /// access it was opened with, so the lowbox token needs no rights on them.
    fn inheritable_std_handles() -> (HANDLE, HANDLE, HANDLE) {
        let mut handles = [INVALID_HANDLE_VALUE; 3];
        for (slot, id) in
            handles
                .iter_mut()
                .zip([STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE])
        {
            let handle = unsafe { GetStdHandle(id) };
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
                *slot = handle;
            }
        }
        (handles[0], handles[1], handles[2])
    }

    /// Put this process in a kill-on-close job, so the shell -- created inside the
    /// job by inheritance -- dies whenever the helper does. `kill_on_drop` and
    /// `kill_tree` reach the helper, not the extra process layer it adds, so
    /// without this a cancelled or timed-out command could leave a shell running.
    ///
    /// Best effort: a host that already confines us to a job it forbids nesting
    /// under should lose the reaping guarantee, not the tool.
    fn reap_children_with_this_process() {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let sized = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if sized == 0 {
            unsafe { CloseHandle(job) };
            return;
        }
        // The handle is deliberately leaked: the job must outlive this function
        // and close only when the process exits, which is what triggers the kill.
        unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) };
    }

    /// The private profile directory the sandboxed shell is told is its home.
    ///
    /// Inside the session scratch when there is one, so it dies with the session;
    /// otherwise inside the container's own `AC` folder, which Windows creates for
    /// the profile and ACLs to the container and to nobody else. Either way the
    /// real `C:\Users\<name>` is never named, and a shell that goes looking for
    /// `.bashrc` finds an empty directory belonging to the sandbox.
    fn synthetic_home(req: &Request, moniker: &str) -> Result<PathBuf, LaunchFailure> {
        let base = match &req.scratch {
            Some(scratch) => scratch.join("home"),
            None => {
                let local = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
                    LaunchFailure::new(
                        Stage::Environment,
                        "GetEnvironmentVariableW",
                        "the sandbox has nowhere to put its private profile",
                    )
                    .with_requirement(
                        "LOCALAPPDATA is not set for the Jan process, so neither the \
                         sandbox's storage nor its home directory can be located.",
                    )
                })?;
                PathBuf::from(local)
                    .join("Packages")
                    .join(moniker)
                    .join("AC")
                    .join("home")
            }
        };
        std::fs::create_dir_all(&base).map_err(|e| {
            LaunchFailure::new(
                Stage::Environment,
                "CreateDirectoryW",
                format!("could not create the sandbox home ({})", base.display()),
            )
            .with_code(e.raw_os_error().unwrap_or(0))
        })?;
        Ok(base)
    }

    /// `PATH` for the confined shell: the system directories, then the shell's own
    /// installation. Built rather than inherited so a host `PATH` entry under the
    /// user's profile -- which the sandbox cannot read -- does not turn into an
    /// unexplained "command not found" inside it.
    fn sandbox_path(program: &Path, granted: &[PathBuf]) -> OsString {
        super::build_sandbox_path(
            std::env::var_os("SystemRoot").map(PathBuf::from),
            shell_runtime_dirs(program),
            std::env::var_os("PATH"),
            std::env::var_os("USERPROFILE").map(PathBuf::from),
            granted,
            crate::tools::host_tools::container_can_execute,
        )
    }

    /// Assemble the environment the confined process receives.
    fn sandbox_env(req: &Request, home: &Path) -> Result<SandboxEnv, LaunchFailure> {
        let temp = req.scratch.clone().unwrap_or_else(|| home.to_path_buf());
        win_env::build(
            &ProcessEnv,
            &SandboxEnvSpec {
                home,
                temp: &temp,
                path: Some(sandbox_path(&req.program, &req.path_dirs)),
                extra: &[],
            },
        )
        .map_err(|e| {
            let missing = match &e {
                win_env::EnvError::MissingRequired { name } => Some(*name),
                _ => None,
            };
            let failure = LaunchFailure::new(
                Stage::Environment,
                "environment builder",
                format!("could not build the sandbox environment: {e}"),
            );
            match missing {
                Some(name) => failure.with_requirement(format!(
                    "{name} is not set for the Jan process. Windows needs it to create \
                     a sandboxed process; without it CreateProcessW fails with \
                     ERROR_ENVVAR_NOT_FOUND (203)."
                )),
                None => failure,
            }
        })
    }

    /// Set up the container, then spawn the shell inside it and wait. Returns the
    /// shell's exit code so the helper is transparent to the caller.
    pub fn run(req: &Request) -> Result<i32, LaunchFailure> {
        if !req.workspace.is_dir() {
            return Err(LaunchFailure::new(
                Stage::SandboxPolicy,
                "GetFileAttributesW",
                format!("workspace does not exist: {}", req.workspace.display()),
            ));
        }
        if let Some(scratch) = &req.scratch {
            if !scratch.is_dir() {
                return Err(LaunchFailure::new(
                    Stage::SandboxPolicy,
                    "GetFileAttributesW",
                    format!("scratch does not exist: {}", scratch.display()),
                ));
            }
        }
        if !req.program.is_file() {
            return Err(LaunchFailure::new(
                Stage::Canonicalize,
                "GetFileAttributesW",
                format!("the shell does not exist: {}", req.program.display()),
            )
            .with_requirement(
                "Nothing was found at that path, so no sandbox setting can make it \
                 start.",
            ));
        }
        reap_children_with_this_process();
        let name = moniker(&req.workspace);
        let sid = ensure_profile(&name).map_err(|detail| {
            LaunchFailure::new(Stage::SandboxPolicy, "CreateAppContainerProfile", detail)
        })?;
        // The home is created before the grants so the inheritable ACE a grant
        // installs on the scratch reaches it.
        let home = synthetic_home(req, &name)?;
        grant_path(&req.workspace, sid.0).map_err(|detail| {
            LaunchFailure::new(Stage::SandboxPolicy, "SetNamedSecurityInfoW", detail)
        })?;
        // The scratch is the shell's `TEMP`/`TMP`, so without this every temp-file
        // write in the container is denied. With no scratch the synthetic home
        // takes that role and needs the same grant.
        let granted = req.scratch.clone().unwrap_or_else(|| home.clone());
        grant_path(&granted, sid.0).map_err(|detail| {
            LaunchFailure::new(Stage::SandboxPolicy, "SetNamedSecurityInfoW", detail)
        })?;
        // Authorized write roots: a managed worktree or folders the user
        // authorized to edit, each checked against `grant_refusal`. A missing one is refused rather than skipped,
        // so a run is never told it can write somewhere it cannot. Folders
        // granted to this container before and no longer authorized lose their
        // ACE first.
        for root in &req.write_roots {
            if !root.is_dir() {
                return Err(LaunchFailure::new(
                    Stage::SandboxPolicy,
                    "GetFileAttributesW",
                    format!("authorized folder does not exist: {}", root.display()),
                ));
            }
        }
        let holder = if req.own_holder {
            format!("mcp-{}", std::process::id())
        } else {
            super::SHELL_HOLDER.to_string()
        };
        sync_holder_roots(
            &write_root_record(&name),
            sid.0,
            &holder,
            &req.write_roots,
            &req.read_roots,
        )
        .map_err(|detail| {
            LaunchFailure::new(Stage::SandboxPolicy, "SetNamedSecurityInfoW", detail)
        })?;

        let env = sandbox_env(req, &home)?;
        let mut env_block = env.encode().map_err(|e| {
            LaunchFailure::new(
                Stage::Environment,
                "environment builder",
                format!("the sandbox environment block is malformed: {e}"),
            )
        })?;
        if crate::compat_env::var_os("SANDBOX_DEBUG").is_some() {
            // Names and lengths only: see `SandboxEnv::redacted`.
            eprintln!("sandbox: stage=environment {}", env.redacted().join(" "));
        }

        // Each SID buffer must outlive the spawn: `capabilities` points into them.
        let mut internet_sid = Vec::new();
        let mut private_sid = Vec::new();
        let mut capabilities = Vec::new();
        if req.allow_network {
            let policy_failure = |detail: String| {
                LaunchFailure::new(Stage::SandboxPolicy, "CreateWellKnownSid", detail)
            };
            capabilities.push(internet_capability(&mut internet_sid).map_err(policy_failure)?);
            capabilities
                .push(private_network_capability(&mut private_sid).map_err(policy_failure)?);
        }
        let mut security = SECURITY_CAPABILITIES {
            AppContainerSid: sid.0,
            Capabilities: if capabilities.is_empty() {
                std::ptr::null_mut()
            } else {
                capabilities.as_mut_ptr()
            },
            CapabilityCount: capabilities.len() as u32,
            Reserved: 0,
        };

        // Two calls: the first only reports the size, the second initializes the
        // buffer we just allocated for it.
        let mut size: usize = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        }
        let mut attribute_buffer = vec![0u8; size];
        let attributes = attribute_buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut size) } == 0 {
            return Err(LaunchFailure::new(
                Stage::SandboxPolicy,
                "InitializeProcThreadAttributeList",
                format!(
                    "could not initialize the spawn attributes: {}",
                    last_error()
                ),
            )
            .with_code(last_error_code()));
        }
        let applied = unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &mut security as *mut _ as *const c_void,
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if applied == 0 {
            let message = last_error();
            let code = last_error_code();
            unsafe { DeleteProcThreadAttributeList(attributes) };
            return Err(LaunchFailure::new(
                Stage::SandboxPolicy,
                "UpdateProcThreadAttribute",
                format!("could not attach the AppContainer token: {message}"),
            )
            .with_code(code));
        }

        let (stdin, stdout, stderr) = inheritable_std_handles();
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin;
        startup.StartupInfo.hStdOutput = stdout;
        startup.StartupInfo.hStdError = stderr;
        startup.lpAttributeList = attributes;

        let mut line = wide(OsStr::new(&command_line(&req.program, &req.args)));
        // The workspace, or the managed worktree the run writes to. Either way
        // a directory the ACEs above were just granted on.
        let cwd = wide(req.start_dir.as_os_str());
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // The environment is passed explicitly. A null pointer here means "give
        // the child the parent's environment", and the parent's is deliberately
        // stripped of the very names an AppContainer spawn resolves the
        // container's storage through -- which is what returned
        // ERROR_ENVVAR_NOT_FOUND (203) and no process at all.
        let spawned = unsafe {
            CreateProcessW(
                std::ptr::null(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                // CREATE_NO_WINDOW keeps the confined shell from flashing a
                // console window: std handles are already redirected to pipes,
                // so the child never needs a visible console of its own.
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                env_block.as_mut_ptr() as *const c_void,
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut process,
            )
        };
        unsafe { DeleteProcThreadAttributeList(attributes) };
        if spawned == 0 {
            let code = last_error_code();
            let message = last_error();
            // Which required name, if any, the block actually lacked. Reported
            // rather than assumed, so a 203 that is not about a missing variable
            // does not get described as one that is.
            let missing: Vec<&str> = win_env::REQUIRED
                .iter()
                .copied()
                .filter(|name| !env.contains(name))
                .collect();
            return Err(LaunchFailure::new(
                Stage::ProcessCreation,
                "CreateProcessW",
                format!(
                    "could not start {} inside the sandbox: {message}",
                    req.program.display()
                ),
            )
            .with_code(code)
            .with_requirement(create_process_requirement(code, &missing)));
        }

        let code = wait_for(process.hProcess);
        unsafe {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
        let code = code?;
        // The process existed, so this is not a spawn failure -- but an exit
        // status that is really a loader failure must not reach the model as
        // "the command exited 3221225794".
        if let Some(requirement) = runtime_startup_requirement(code, &req.program) {
            return Err(LaunchFailure::new(
                Stage::RuntimeStartup,
                "CreateProcessW",
                format!(
                    "{} started inside the sandbox but could not initialise",
                    req.program.display()
                ),
            )
            .with_code(code)
            .with_requirement(requirement));
        }
        Ok(code)
    }

    fn wait_for(process: HANDLE) -> Result<i32, LaunchFailure> {
        if unsafe { WaitForSingleObject(process, INFINITE) } == WAIT_FAILED {
            return Err(LaunchFailure::new(
                Stage::RuntimeStartup,
                "WaitForSingleObject",
                format!("could not wait for the sandboxed shell: {}", last_error()),
            )
            .with_code(last_error_code()));
        }
        let mut code: u32 = 0;
        if unsafe { GetExitCodeProcess(process, &mut code) } == 0 {
            return Err(LaunchFailure::new(
                Stage::RuntimeStartup,
                "GetExitCodeProcess",
                format!("could not read the shell's exit code: {}", last_error()),
            )
            .with_code(last_error_code()));
        }
        Ok(code as i32)
    }
}

#[cfg(test)]
mod granted_path_tests {
    use super::*;

    /// The live failure: a granted Python folder under the profile, first on
    /// the host PATH, never reached the shell's PATH because the helper
    /// process had not loaded the grants. They now travel in the request, and
    /// the PATH built from it carries the folder.
    #[test]
    fn a_granted_profile_folder_reaches_the_sandbox_path() {
        let root = std::env::temp_dir().join(format!("granted-path-{}", std::process::id()));
        let profile = root.join("Users").join("me");
        let python = profile.join("AppData").join("Local").join("Programs").join("Python311");
        std::fs::create_dir_all(&python).unwrap();
        let host = std::env::join_paths([python.clone()]).unwrap();

        let argv = [
            SANDBOX_EXEC_FLAG.to_string(),
            NET_OFF.to_string(),
            "C:\\ws".to_string(),
            String::new(),
            format!("{PATH_DIR}{}", python.display()),
            "--".to_string(),
            "powershell.exe".to_string(),
        ];
        let req = parse_request(argv).expect("a helper request");
        assert_eq!(req.path_dirs, vec![python.clone()]);

        let can_execute = |_: &Path| Some(true);
        let with = build_sandbox_path(
            None,
            Vec::new(),
            Some(host.clone()),
            Some(profile.clone()),
            &req.path_dirs,
            can_execute,
        );
        assert!(
            std::env::split_paths(&with).any(|d| d == python),
            "{with:?}"
        );
        // Without the grant, the profile folder stays out.
        let without =
            build_sandbox_path(None, Vec::new(), Some(host), Some(profile), &[], can_execute);
        assert!(!std::env::split_paths(&without).any(|d| d == python), "{without:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> PathBuf {
        PathBuf::from(r"C:\Users\me\.jan\agent-workspace\threads\t1")
    }

    #[test]
    fn app_package_aces_are_recognised_in_the_dacl_only() {
        // The descriptor \Device\Null carried on the machine the bug was found on.
        let observed = "D:(A;;0x1201bf;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;RC)S:AI(ML;;NW;;;LW)";
        assert!(!sddl_admits_app_packages(observed));
        assert!(sddl_admits_app_packages("D:(A;;GRGWGX;;;WD)(A;;GRGWGX;;;AC)"));
        assert!(sddl_admits_app_packages("D:(A;;0x1201bf;;;S-1-15-2-1)"));
        // A deny ACE, or an AC entry only in the SACL, admits nobody.
        assert!(!sddl_admits_app_packages("D:(D;;FA;;;AC)"));
        assert!(!sddl_admits_app_packages("D:(A;;FA;;;WD)S:(AU;SA;FA;;;AC)"));
        assert!(!sddl_admits_app_packages(""));
    }

    #[test]
    fn the_moniker_fits_what_windows_accepts() {
        let name = moniker(&ws());
        assert!(name.len() <= 64, "{name}");
        assert!(name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_'));
    }

    #[test]
    fn the_same_workspace_always_maps_to_the_same_container() {
        // The next command in a thread must reach the container the last one
        // used, or its workspace grant would not apply.
        assert_eq!(moniker(&ws()), moniker(&ws()));
        assert_eq!(
            moniker(&ws()),
            moniker(Path::new(r"C:\USERS\ME\.JAN\AGENT-WORKSPACE\THREADS\T1"))
        );
    }

    /// Review only: attached folders are granted read-only, their `.jan` left
    /// alone; a folder switching between read and write is re-granted, not
    /// revoked; one in neither list any more is revoked.
    #[test]
    fn the_acl_plan_grants_read_roots_read_only() {
        let (a, b) = (PathBuf::from("/w/a"), PathBuf::from("/w/b"));
        let dirs = [a.clone(), a.join(".jan"), b.clone()];
        let is_dir = |p: &Path| dirs.iter().any(|d| d == p);

        assert_eq!(
            root_acl_plan(&[], &[], std::slice::from_ref(&a), is_dir),
            vec![AclStep::GrantRead(a.clone())]
        );
        // Written last time, read-only now: re-granted read, not revoked.
        assert_eq!(
            root_acl_plan(std::slice::from_ref(&a), &[], std::slice::from_ref(&a), is_dir),
            vec![AclStep::GrantRead(a.clone())]
        );
        // In both lists: granted once, writable.
        assert_eq!(
            root_acl_plan(&[], std::slice::from_ref(&a), std::slice::from_ref(&a), is_dir),
            vec![AclStep::IsolateJan(a.join(".jan")), AclStep::GrantRoot(a.clone())]
        );
        // Everything withdrawn: every recorded folder revoked, and nothing else.
        assert_eq!(
            root_acl_plan(&[a.clone(), b.clone()], &[], &[], is_dir),
            vec![
                AclStep::Revoke(a.join(".jan")),
                AclStep::Revoke(a.clone()),
                AclStep::Revoke(b.clone()),
            ]
        );
    }

    /// A spawn waits while a sweep runs and goes through at once otherwise.
    #[test]
    fn spawns_wait_for_a_running_sweep_only() {
        use std::sync::Arc;
        use std::time::{Duration, Instant};
        let gate = Arc::new(SweepGate::new());
        // Idle: no wait.
        let t = Instant::now();
        assert!(gate.wait(Duration::from_secs(5)));
        assert!(t.elapsed() < Duration::from_secs(1));

        gate.begin();
        // Running: a short wait times out.
        assert!(!gate.wait(Duration::from_millis(50)));
        let finisher = {
            let gate = gate.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                gate.finish();
            })
        };
        let t = Instant::now();
        assert!(gate.wait(Duration::from_secs(5)), "the sweep's end must release the spawn");
        assert!(t.elapsed() >= Duration::from_millis(150), "the spawn went ahead mid-sweep");
        finisher.join().unwrap();
        // Finished: no wait.
        let t = Instant::now();
        assert!(gate.wait(Duration::from_secs(5)));
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn the_roots_record_round_trips_and_reads_the_old_format() {
        let (w, r) = (PathBuf::from("C:\\w"), PathBuf::from("C:\\r"));
        let text = roots_record(&[w.clone()], &[r.clone(), w.clone()]);
        assert_eq!(parse_roots_record(&text), (vec![w.clone()], vec![r.clone()]));
        // What an earlier build wrote: bare paths, all write roots.
        assert_eq!(parse_roots_record("C:\\w\n"), (vec![w], vec![]));
    }

    #[test]
    fn read_roots_travel_to_the_helper() {
        let (w, r) = (PathBuf::from("C:\\w"), PathBuf::from("C:\\r"));
        let args = helper_args_at(
            &ws(),
            None,
            None,
            &[w.clone()],
            &[r.clone(), w.clone()],
            false,
            Path::new("bash.exe"),
            &[],
        );
        let req = parse_request(args).expect("parses");
        assert_eq!(req.write_roots, vec![w]);
        assert_eq!(req.read_roots, vec![r]);
    }

    #[test]
    fn grants_refuse_drive_roots_the_profile_and_system_folders() {
        let profile = Path::new("C:\\Users\\me");
        let protected = [
            PathBuf::from("C:\\Windows"),
            PathBuf::from("C:\\Program Files"),
        ];
        let refused = |p: &str| grant_refusal_in(Path::new(p), Some(profile), &protected).is_some();
        for p in [
            "C:\\",
            "c:",
            "D:\\",
            "C:\\Users",
            "c:/users/ME/",
            "C:\\Windows",
            "C:\\windows\\System32",
            "C:\\Program Files\\Git",
            "C:\\Users\\me\\..\\other",
        ] {
            assert!(refused(p), "{p} must be refused");
        }
        for p in [
            "C:\\Users\\me\\code\\repo",
            "D:\\work\\repo",
            "C:\\ProgramData2\\x",
            "C:\\Program Files Extra\\x",
        ] {
            assert!(!refused(p), "{p} must be allowed");
        }
        // Long-path spellings compare like their plain form.
        assert!(refused("\\\\?\\C:\\Users\\me"));
    }

    /// Jozkah/jan#124: every granted worktree gets its `.jan` cut off, and a
    /// worktree no longer granted is revoked, `.jan` included.
    #[test]
    fn the_acl_plan_denies_each_write_roots_jan_and_undoes_it_on_revoke() {
        let (a, b, gone) = (PathBuf::from("/w/a"), PathBuf::from("/w/b"), PathBuf::from("/w/gone"));
        let dirs = [a.clone(), a.join(".jan"), b.clone()];
        let is_dir = |p: &Path| dirs.iter().any(|d| d == p);

        assert_eq!(
            write_root_acl_plan(&[], std::slice::from_ref(&a), is_dir),
            vec![AclStep::IsolateJan(a.join(".jan")), AclStep::GrantRoot(a.clone())]
        );
        // `a` dropped: its .jan and its grant are revoked, `b` granted.
        assert_eq!(
            write_root_acl_plan(&[a.clone(), gone.clone()], std::slice::from_ref(&b), is_dir),
            vec![
                AclStep::Revoke(a.join(".jan")),
                AclStep::Revoke(a.clone()),
                AclStep::IsolateJan(b.join(".jan")),
                AclStep::GrantRoot(b.clone()),
            ]
        );
        // A dropped root without a .jan: only the root is revoked.
        assert_eq!(
            write_root_acl_plan(std::slice::from_ref(&b), &[], is_dir),
            vec![AclStep::Revoke(b.clone())]
        );
        // Still granted: re-applied, nothing revoked.
        assert_eq!(
            write_root_acl_plan(std::slice::from_ref(&a), std::slice::from_ref(&a), is_dir),
            vec![AclStep::IsolateJan(a.join(".jan")), AclStep::GrantRoot(a.clone())]
        );
    }

    /// A worktree granted FILE_ALL_ACCESS by an earlier build is regranted
    /// without FILE_DELETE_CHILD, so the shell cannot rename its denied `.jan`
    /// away and plant its own (Jozkah/jan#124).
    #[cfg(windows)]
    #[test]
    fn a_legacy_full_grant_loses_delete_child_on_the_next_sync() {
        let n = std::process::id();
        let base = std::env::temp_dir().join(format!("jan_ac_legacy_{n}"));
        let wt = base.join("worktree");
        std::fs::create_dir_all(&wt).unwrap();
        let record = base.join("record");
        let name = format!("jan.test.legacy.{n}");
        let sid = match win::test_profile(&name) {
            Ok(sid) => sid,
            Err(e) => {
                eprintln!("skipped: no AppContainer profile here: {e}");
                return;
            }
        };
        let psid = win::sid_ptr(&sid);
        win::legacy_grant(&wt, psid);
        // The record already lists it, as after an upgrade: nothing is revoked.
        std::fs::write(&record, wt.to_string_lossy().as_bytes()).unwrap();

        win::sync_write_roots(&record, psid, std::slice::from_ref(&wt), &[]).unwrap();
        let allows: Vec<u32> = win::aces_for(&wt, psid)
            .into_iter()
            .filter(|&(ty, flags, _)| ty == 0 && flags & 0x10 == 0)
            .map(|(_, _, mask)| mask)
            .collect();
        assert!(!allows.is_empty(), "the worktree lost its grant");
        assert!(
            allows.iter().all(|m| m & win::DELETE_CHILD == 0),
            "FILE_DELETE_CHILD survived the regrant: {allows:x?}"
        );

        win::sync_write_roots(&record, psid, &[], &[]).unwrap();
        drop(sid);
        win::delete_profile(&name);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Jozkah/jan#124, checked on the real ACLs: after a fresh grant and after
    /// each re-sync, no ACE on `.jan` or on a file already inside it names the
    /// container (a deny ACE would not do: the AppContainer check only looks
    /// for grants), so its effective rights there are none, while the rest of
    /// the worktree keeps its grant.
    #[cfg(windows)]
    #[test]
    fn a_worktrees_jan_is_denied_to_the_container_across_syncs() {
        let n = std::process::id();
        let base = std::env::temp_dir().join(format!("jan_ac_deny_{n}"));
        let wt = base.join("worktree");
        std::fs::create_dir_all(wt.join(".jan/agent")).unwrap();
        std::fs::write(wt.join(".jan/agent/agent.toml"), b"x").unwrap();
        std::fs::write(wt.join("main.rs"), b"x").unwrap();
        let record = base.join("record");
        let name = format!("jan.test.deny.{n}");
        let sid = match win::test_profile(&name) {
            Ok(sid) => sid,
            Err(e) => {
                eprintln!("skipped: no AppContainer profile here: {e}");
                return;
            }
        };
        let psid = win::sid_ptr(&sid);
        let jan = wt.join(".jan");
        let policy = jan.join("agent/agent.toml");
        for pass in 0..3 {
            win::sync_write_roots(&record, psid, std::slice::from_ref(&wt), &[]).unwrap();
            let aces = win::aces_for(&jan, psid);
            assert!(aces.is_empty(), "pass {pass}: .jan names the container: {aces:x?}");
            let aces = win::aces_for(&policy, psid);
            assert!(aces.is_empty(), "pass {pass}: agent.toml names the container: {aces:x?}");
            assert_eq!(win::effective_rights(&jan, psid), 0, "pass {pass}: .jan");
            assert_eq!(win::effective_rights(&policy, psid), 0, "pass {pass}: agent.toml");
            // The rest of the worktree stays writable.
            assert_ne!(win::effective_rights(&wt.join("main.rs"), psid), 0, "pass {pass}: main.rs");
        }
        win::sync_write_roots(&record, psid, &[], &[]).unwrap();
        drop(sid);
        win::delete_profile(&name);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Jozkah/jan#217: once a worktree is no longer an authorized write root,
    /// the next confined run must take the container's ACE off it; otherwise
    /// `bash` keeps writing there after `write`/`edit` were refused.
    #[cfg(windows)]
    #[test]
    fn a_write_root_no_longer_authorized_loses_its_ace() {
        let n = std::process::id();
        let base = std::env::temp_dir().join(format!("jan_ac_revoke_{n}"));
        let (wt, other) = (base.join("worktree"), base.join("other"));
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let record = base.join("record");
        let name = format!("jan.test.revoke.{n}");
        let sid = match win::test_profile(&name) {
            Ok(sid) => sid,
            Err(e) => {
                eprintln!("skipped: no AppContainer profile here: {e}");
                return;
            }
        };
        let psid = win::sid_ptr(&sid);

        win::sync_write_roots(&record, psid, std::slice::from_ref(&wt), &[]).unwrap();
        assert!(win::acl_names(&wt, psid), "the authorized worktree was not granted");
        // Jozkah/jan#124: its `.jan` exists and names the container nowhere.
        assert!(wt.join(".jan").is_dir(), "the worktree's .jan was not created");
        let jan_aces = win::aces_for(&wt.join(".jan"), psid);
        assert!(jan_aces.is_empty(), "the worktree's .jan names the container: {jan_aces:?}");

        win::sync_write_roots(&record, psid, std::slice::from_ref(&other), &[]).unwrap();
        assert!(!win::acl_names(&wt, psid), "the revoked worktree kept its ACE");
        assert!(
            win::aces_for(&wt.join(".jan"), psid).is_empty(),
            "the revoked worktree's .jan kept an ACE"
        );
        assert!(win::acl_names(&other, psid));

        win::sync_write_roots(&record, psid, &[], &[]).unwrap();
        assert!(!win::acl_names(&other, psid));

        drop(sid);
        win::delete_profile(&name);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Review only then Edit this folder then revoked, on a real ACL: a read
    /// root's ACE carries no write right, becoming a write root adds it, and
    /// withdrawing the recorded grants leaves no ACE naming the container and
    /// the folder as writable to its owner as before.
    #[cfg(windows)]
    #[test]
    fn a_user_folder_is_granted_read_then_write_then_withdrawn() {
        const FILE_WRITE_DATA: u32 = 0x2;
        let n = std::process::id();
        let base = std::env::temp_dir().join(format!("jan_ac_user_folder_{n}"));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let name = format!("jan.test.userfolder.{n}");
        let sid = match win::test_profile(&name) {
            Ok(sid) => sid,
            Err(e) => {
                eprintln!("skipped: no AppContainer profile here: {e}");
                return;
            }
        };
        let psid = win::sid_ptr(&sid);
        let record = win::write_root_record(&name);

        win::sync_write_roots(&record, psid, &[], std::slice::from_ref(&repo)).unwrap();
        let aces = win::aces_for(&repo, psid);
        assert!(!aces.is_empty(), "the read root was not granted");
        assert!(
            aces.iter().all(|&(_, _, mask)| mask & FILE_WRITE_DATA == 0),
            "a read root must not be writable: {aces:x?}"
        );
        assert!(!repo.join(".jan").exists(), "nothing is written into a read root");

        win::sync_write_roots(&record, psid, std::slice::from_ref(&repo), &[]).unwrap();
        assert!(
            win::aces_for(&repo, psid).iter().any(|&(_, _, mask)| mask & FILE_WRITE_DATA != 0),
            "the write root was not granted write"
        );

        win::revoke_recorded_roots(&name).unwrap();
        assert!(win::aces_for(&repo, psid).is_empty(), "an ACE outlived the revoke");
        assert!(!record.exists(), "the record outlived the revoke");
        std::fs::write(repo.join("owner.txt"), b"still mine").expect("owner keeps access");

        drop(sid);
        win::delete_profile(&name);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// One holder's set never withdraws what another still needs; write wins.
    #[test]
    fn grants_are_the_union_of_every_holder() {
        let (a, b, c) = (PathBuf::from("/a"), PathBuf::from("/b"), PathBuf::from("/c"));
        let shell = (vec![a.clone()], vec![b.clone()]);
        let server = (vec![], vec![a.clone(), c.clone()]);
        assert_eq!(
            union_roots(&[shell.clone(), server.clone()]),
            (vec![a.clone()], vec![b.clone(), c.clone()])
        );
        // A read-only holder does not demote another's write.
        assert_eq!(union_roots(&[server, shell]).0, vec![a]);
        assert_eq!(union_roots(&[]), (vec![], vec![]));
        assert_eq!(
            holders_dir(Path::new("C:\\t\\Jan.Agent.1")),
            PathBuf::from("C:\\t\\Jan.Agent.1.holders")
        );
    }

    /// The race: the shell holds write on a folder, then an MCP server in the
    /// same container spawns with a different set. The shell keeps write.
    /// Stopping the server withdraws only what nobody else needs, and a dead
    /// holder's needs are pruned.
    #[cfg(windows)]
    #[test]
    fn a_server_spawn_never_withdraws_the_shells_write() {
        const FILE_WRITE_DATA: u32 = 0x2;
        let n = std::process::id();
        let base = std::env::temp_dir().join(format!("jan_ac_holders_{n}"));
        let (repo, other, stale) = (base.join("repo"), base.join("other"), base.join("stale"));
        for d in [&repo, &other, &stale] {
            std::fs::create_dir_all(d).unwrap();
        }
        let name = format!("jan.test.holders.{n}");
        let sid = match win::test_profile(&name) {
            Ok(sid) => sid,
            Err(e) => {
                eprintln!("skipped: no AppContainer profile here: {e}");
                return;
            }
        };
        let psid = win::sid_ptr(&sid);
        let record = win::write_root_record(&name);
        let writable = |p: &Path| {
            win::aces_for(p, psid).iter().any(|&(_, _, mask)| mask & FILE_WRITE_DATA != 0)
        };
        let server = format!("mcp-{n}"); // this test process: alive

        win::sync_holder_roots(&record, psid, SHELL_HOLDER, std::slice::from_ref(&repo), &[])
            .unwrap();
        assert!(writable(&repo));
        // The server spawns wanting only to read `other`.
        win::sync_holder_roots(&record, psid, &server, &[], std::slice::from_ref(&other))
            .unwrap();
        assert!(writable(&repo), "the server's spawn withdrew the shell's write");
        assert!(!win::aces_for(&other, psid).is_empty(), "the server's read was not granted");

        // The server stops: its read goes, the shell's write stays.
        win::release_holder(&name, &server).unwrap();
        assert!(writable(&repo), "stopping the server withdrew the shell's write");
        assert!(win::aces_for(&other, psid).is_empty(), "the stopped server's grant stayed");

        // A holder whose process is gone is pruned, not honoured.
        std::fs::write(
            holders_dir(&record).join("mcp-4294967291"),
            roots_record(std::slice::from_ref(&stale), &[]),
        )
        .unwrap();
        win::sync_holder_roots(&record, psid, SHELL_HOLDER, std::slice::from_ref(&repo), &[])
            .unwrap();
        assert!(win::aces_for(&stale, psid).is_empty(), "a dead holder's folder was granted");
        assert!(!holders_dir(&record).join("mcp-4294967291").exists());

        win::revoke_recorded_roots(&name).unwrap();
        assert!(win::aces_for(&repo, psid).is_empty());
        assert!(!holders_dir(&record).exists());
        drop(sid);
        win::delete_profile(&name);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn different_workspaces_map_to_different_containers() {
        // This is the whole of the cross-thread isolation: the workspace ACE
        // names one container SID, so a command for another thread holds a
        // token that ACE does not match.
        let mine = moniker(&ws());
        let theirs = moniker(Path::new(r"C:\Users\me\.jan\agent-workspace\threads\t2"));
        assert_ne!(mine, theirs);
    }

    #[test]
    fn helper_args_end_with_the_shell_so_the_command_appends_last() {
        let args = helper_args(
            &ws(),
            None,
            &[],
            false,
            Path::new("bash.exe"),
            &["-c".to_string()],
        );
        let sep = args.iter().position(|a| a == "--").expect("separator");
        assert_eq!(
            &args[sep + 1..],
            &["bash.exe".to_string(), "-c".to_string()]
        );
        assert_eq!(args[0], SANDBOX_EXEC_FLAG);
    }

    #[test]
    fn helper_args_carry_the_network_decision() {
        let denied = helper_args(&ws(), None, &[], false, Path::new("bash.exe"), &[]);
        assert!(denied.contains(&NET_OFF.to_string()));
        assert!(!denied.contains(&NET_ON.to_string()));
        let allowed = helper_args(&ws(), None, &[], true, Path::new("bash.exe"), &[]);
        assert!(allowed.contains(&NET_ON.to_string()));
    }

    #[test]
    fn the_helper_round_trips_its_own_argv() {
        let args = helper_args(
            &ws(),
            Some(Path::new(r"C:\Temp\jan-agent-s1")),
            &[],
            true,
            Path::new(r"C:\Program Files\Git\bin\bash.exe"),
            &["-c".to_string(), "echo hi".to_string()],
        );
        let req = parse_request(args).expect("parsed");
        assert_eq!(req.workspace, ws());
        assert_eq!(
            req.scratch.as_deref(),
            Some(Path::new(r"C:\Temp\jan-agent-s1"))
        );
        assert!(req.allow_network);
        assert_eq!(req.program, Path::new(r"C:\Program Files\Git\bin\bash.exe"));
        assert_eq!(req.args, vec!["-c".to_string(), "echo hi".to_string()]);
    }

    /// Authorized roots cross the re-exec intact and in order, and are never
    /// confused with the separator or the shell.
    #[test]
    fn the_helper_round_trips_its_write_roots() {
        let roots = vec![
            PathBuf::from(r"C:\Users\me\.jan\worktrees\repo\session-1"),
            PathBuf::from(r"C:\dir with space\--"),
        ];
        let args = helper_args(&ws(), None, &roots, false, Path::new("bash.exe"), &[]);
        let req = parse_request(args).expect("parsed");
        assert_eq!(req.write_roots, roots);
        assert_eq!(req.program, Path::new("bash.exe"));
    }

    /// Anything between the scratch and the separator that is not a marked
    /// write root makes the request malformed, and a malformed request never
    /// runs anything.
    #[test]
    fn an_unmarked_argument_before_the_separator_is_refused() {
        let argv = vec![
            SANDBOX_EXEC_FLAG.to_string(),
            NET_OFF.to_string(),
            ws().to_string_lossy().to_string(),
            String::new(),
            r"C:\Users\me".to_string(),
            "--".to_string(),
            "bash.exe".to_string(),
        ];
        assert!(parse_request(argv).is_none());
    }

    /// A start directory crosses the re-exec only when it is one of the write
    /// roots; the workspace is the default.
    #[test]
    fn the_helper_round_trips_a_start_dir_inside_the_write_roots() {
        let wt = PathBuf::from(r"C:\Users\me\.jan\worktrees\repo\session-1");
        let roots = vec![wt.clone()];
        let args = helper_args_at(&ws(), Some(&wt), None, &roots, &[], false, Path::new("bash.exe"), &[]);
        let req = parse_request(args).expect("parsed");
        assert_eq!(req.start_dir, wt);
        assert_eq!(req.write_roots, roots);

        let args = helper_args(&ws(), None, &roots, false, Path::new("bash.exe"), &[]);
        assert_eq!(parse_request(args).expect("parsed").start_dir, ws());

        let elsewhere = PathBuf::from(r"C:\Users\me\repo");
        let args =
            helper_args_at(&ws(), Some(&elsewhere), None, &roots, &[], false, Path::new("bash.exe"), &[]);
        assert!(parse_request(args).is_none(), "a start dir outside the grants must be refused");
    }

    /// The scratch has to reach the helper, because the ACE that makes it
    /// writable can only be granted on the far side of the re-exec.
    #[test]
    fn the_helper_round_trips_an_absent_scratch() {
        let args = helper_args(&ws(), None, &[], false, Path::new("bash.exe"), &[]);
        let req = parse_request(args).expect("parsed");
        assert_eq!(req.workspace, ws());
        assert_eq!(req.scratch, None);
    }

    #[test]
    fn a_normal_launch_is_not_mistaken_for_the_helper() {
        assert!(parse_request(Vec::<String>::new()).is_none());
        assert!(parse_request(vec!["--version".to_string()]).is_none());
        // Truncated or malformed requests must not run something unconfined.
        assert!(parse_request(vec![SANDBOX_EXEC_FLAG.to_string()]).is_none());
        assert!(parse_request(vec![
            SANDBOX_EXEC_FLAG.to_string(),
            "--maybe".to_string(),
            r"C:\ws".to_string(),
            "--".to_string(),
            "bash.exe".to_string(),
        ])
        .is_none());
    }

    #[test]
    fn quoting_leaves_plain_arguments_alone() {
        assert_eq!(quote_arg("-c"), "-c");
        assert_eq!(quote_arg("bash.exe"), "bash.exe");
        assert_eq!(quote_arg(""), "\"\"");
    }

    #[test]
    fn quoting_survives_spaces_quotes_and_trailing_backslashes() {
        assert_eq!(quote_arg("echo hi"), "\"echo hi\"");
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
        // A trailing backslash must be doubled, or it would escape the closing
        // quote and swallow the next argument.
        assert_eq!(quote_arg(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(
            quote_arg(r"C:\Program Files\Git"),
            r#""C:\Program Files\Git""#
        );
    }

    #[test]
    fn the_command_line_keeps_the_command_a_single_argument() {
        let line = command_line(
            Path::new(r"C:\Program Files\Git\bin\bash.exe"),
            &["-c".to_string(), "ls -la && echo \"done\"".to_string()],
        );
        assert_eq!(
            line,
            r#""C:\Program Files\Git\bin\bash.exe" -c "ls -la && echo \"done\"""#
        );
    }

    /// The whole bug report in one assertion. 203 is an environment fault; the
    /// message must say so and must not mention where the shell is installed.
    #[test]
    fn error_203_is_diagnosed_as_an_environment_fault() {
        let named = create_process_requirement(ERROR_ENVVAR_NOT_FOUND, &["LOCALAPPDATA"]);
        assert!(named.contains("LOCALAPPDATA"), "{named}");
        assert!(named.contains("environment block"), "{named}");
        assert!(!named.to_lowercase().contains("user profile"), "{named}");
        assert!(!named.to_lowercase().contains("install git"), "{named}");

        // Even with nothing identified as missing, the fault is still located
        // in Jan's environment builder rather than in the user's machine.
        let unnamed = create_process_requirement(ERROR_ENVVAR_NOT_FOUND, &[]);
        assert!(unnamed.contains("environment block"), "{unnamed}");
        assert!(
            !unnamed.to_lowercase().contains("user profile"),
            "{unnamed}"
        );
    }

    #[test]
    fn each_create_process_code_names_its_own_requirement() {
        assert!(create_process_requirement(2, &[]).contains("does not exist"));
        assert!(create_process_requirement(5, &[]).contains("read/execute"));
        assert!(create_process_requirement(193, &[]).contains("architecture"));
        assert!(create_process_requirement(1260, &[]).contains("restriction policy"));
        // An unrecognised code must not be given a made-up explanation.
        let unknown = create_process_requirement(99999, &[]);
        assert!(
            unknown.contains("the whole of what it reported"),
            "{unknown}"
        );
    }

    /// A loader failure is not a spawn failure, and the report has to keep them
    /// apart -- the fix for one has nothing to do with the fix for the other.
    #[test]
    fn a_dll_init_failure_is_reported_as_a_startup_failure() {
        let bash = Path::new(r"C:\Program Files\Git\bin\bash.exe");
        let message = runtime_startup_requirement(STATUS_DLL_INIT_FAILED, bash).expect("named");
        assert!(message.contains("STATUS_DLL_INIT_FAILED"), "{message}");
        assert!(message.contains("MSYS2"), "{message}");
        assert!(
            message.contains("a system-wide install fails identically"),
            "{message}"
        );
        assert!(
            !message.to_lowercase().contains("user profile"),
            "{message}"
        );
    }

    #[test]
    fn an_ordinary_exit_status_is_not_turned_into_a_startup_failure() {
        let bash = Path::new(r"C:\Program Files\Git\bin\bash.exe");
        assert_eq!(runtime_startup_requirement(0, bash), None);
        assert_eq!(runtime_startup_requirement(1, bash), None);
        assert_eq!(runtime_startup_requirement(127, bash), None);
    }

    #[test]
    fn a_non_msys_program_gets_the_generic_startup_explanation() {
        let native = Path::new(r"C:\Windows\System32\cmd.exe");
        let message = runtime_startup_requirement(STATUS_DLL_INIT_FAILED, native).expect("named");
        assert!(message.contains("STATUS_DLL_INIT_FAILED"), "{message}");
        assert!(!message.contains("MSYS2"), "{message}");
    }

    #[test]
    fn msys_programs_are_recognised_wherever_they_are_installed() {
        for path in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Users\me\AppData\Local\Programs\Git\bin\bash.exe",
            r"C:\msys64\usr\bin\bash.exe",
            r"C:/Program Files/Git/bin/bash.exe",
        ] {
            assert!(uses_msys_runtime(Path::new(path)), "{path}");
        }
        for path in [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Program Files\Git\mingw64\bin\git.exe",
        ] {
            assert!(!uses_msys_runtime(Path::new(path)), "{path}");
        }
    }

    /// A shell that cannot find its own coreutils is a shell that fails on the
    /// second command, so the installation's directories go on `PATH`.
    #[test]
    fn a_shells_own_runtime_directories_are_offered_for_path() {
        let dirs = shell_runtime_dirs(Path::new(r"C:\Program Files\Git\bin\bash.exe"));
        for expected in [
            r"C:\Program Files\Git\bin",
            r"C:\Program Files\Git\usr\bin",
            r"C:\Program Files\Git\mingw64\bin",
            r"C:\Program Files\Git\cmd",
        ] {
            assert!(
                dirs.contains(&PathBuf::from(expected)),
                "{expected} missing from {dirs:?}"
            );
        }
        // The `usr\bin` layout resolves to the same installation root.
        let from_usr = shell_runtime_dirs(Path::new(r"C:\Program Files\Git\usr\bin\bash.exe"));
        assert!(from_usr.contains(&PathBuf::from(r"C:\Program Files\Git\mingw64\bin")));
    }

    #[test]
    fn a_stage_says_whether_a_process_was_ever_created() {
        assert!(Stage::RuntimeStartup.after_process_creation());
        for stage in [
            Stage::ShellDiscovery,
            Stage::Canonicalize,
            Stage::SandboxPolicy,
            Stage::Environment,
            Stage::ProcessCreation,
        ] {
            assert!(!stage.after_process_creation(), "{}", stage.as_str());
        }
    }

    #[test]
    fn a_failure_prints_its_detail_and_its_requirement() {
        let failure =
            LaunchFailure::new(Stage::ProcessCreation, "CreateProcessW", "could not start")
                .with_code(203)
                .with_requirement("LOCALAPPDATA was missing.");
        assert_eq!(failure.code, Some(203));
        assert_eq!(
            failure.to_string(),
            "could not start LOCALAPPDATA was missing."
        );
    }
}
