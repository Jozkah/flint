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
//! - network: denied unless the spawn supplies the `internetClient` capability.
//!   AppContainer blocks loopback as well, which the Unix backends do not.
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

use std::path::{Path, PathBuf};

/// Marks a re-exec of this binary as the confined-spawn helper. Must be the
/// first argument, so a normal launch never looks at anything after it.
pub const SANDBOX_EXEC_FLAG: &str = "--internal-sandbox-exec";

const NET_ON: &str = "--net";
const NET_OFF: &str = "--no-net";
/// Prefix of a helper argument naming one authorized write root.
const WRITE_ROOT: &str = "--write-root=";
/// Prefix of the helper argument naming the directory the shell starts in, when
/// that is not the workspace. It must be one of the write roots (see
/// [`parse_request`]): the container can only start somewhere it was granted.
const START_DIR: &str = "--start-dir=";

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
    helper_args_at(workspace, None, scratch, write_roots, allow_network, program, args)
}

/// [`helper_args`], with the shell started in `start` rather than the
/// workspace. Used for a run whose write destination is a managed worktree, so
/// relative commands (`npm test`, `.\x.ps1`) run against the project.
pub fn helper_args_at(
    workspace: &Path,
    start: Option<&Path>,
    scratch: Option<&Path>,
    write_roots: &[PathBuf],
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
    if let Some(start) = start.filter(|s| *s != workspace) {
        out.push(format!("{START_DIR}{}", start.to_string_lossy()));
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
    /// Folders the run was authorized to write besides its workspace. The
    /// caller only passes Jan-owned worktrees here (see
    /// [`super::jail::can_confine_write_roots`]); the helper grants each an ACE.
    write_roots: Vec<PathBuf>,
    /// Where the shell starts: the workspace, or one of `write_roots`.
    start_dir: PathBuf,
    allow_network: bool,
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
    let mut start_dir = None;
    loop {
        let next = it.next()?;
        if next == "--" {
            break;
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
        start_dir,
        allow_network,
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
    win::delete_profile(&moniker(workspace));
}

#[cfg(not(windows))]
pub fn release(_workspace: &Path) {}

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
    /// Deny the container all access to this path (a write root's `.jan`),
    /// inherited by everything under it. Created first when missing.
    DenyJan(PathBuf),
    /// Grant the container a write root: full access minus deleting children
    /// by the parent's right, so the denied `.jan` cannot be renamed away and
    /// replaced (see [`win::sync_write_roots`]).
    GrantRoot(PathBuf),
}

/// What [`win::sync_write_roots`] must do to move from the `previous` write
/// roots to `roots`. Pure, so the decision is testable without touching an
/// ACL.
///
/// Every root in `roots` is granted with its `.jan` denied (Jozkah/jan#124:
/// the worktree carries the project's agent policy and hooks there). A
/// previous root no longer granted loses both its ACE and its `.jan` deny
/// (Jozkah/jan#217); one that is gone (`!is_dir`) needs nothing.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn write_root_acl_plan(
    previous: &[PathBuf],
    roots: &[PathBuf],
    is_dir: impl Fn(&Path) -> bool,
) -> Vec<AclStep> {
    let jan = |root: &Path| root.join(crate::tools::sandbox::JAN_DIR);
    let mut steps = Vec::new();
    for old in previous {
        if !roots.contains(old) && is_dir(old) {
            if is_dir(&jan(old)) {
                steps.push(AclStep::Revoke(jan(old)));
            }
            steps.push(AclStep::Revoke(old.clone()));
        }
    }
    for root in roots {
        steps.push(AclStep::DenyJan(jan(root)));
        steps.push(AclStep::GrantRoot(root.clone()));
    }
    steps
}

#[cfg(windows)]
mod win {
    use super::{write_root_acl_plan, AclStep};
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
        DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, REVOKE_ACCESS, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, FreeSid, WinCapabilityInternetClientSid, ACL, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_CAPABILITIES, SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES,
    };
    use windows_sys::Win32::Storage::FileSystem::{FILE_ALL_ACCESS, FILE_DELETE_CHILD};
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
    fn write_root_record(moniker: &str) -> PathBuf {
        std::env::temp_dir()
            .join("jan-appcontainer-write-roots")
            .join(moniker)
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
    pub(super) fn sync_write_roots(
        record: &Path,
        sid: PSID,
        roots: &[PathBuf],
    ) -> Result<(), String> {
        let previous: Vec<PathBuf> = std::fs::read_to_string(record)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.is_empty())
            .map(PathBuf::from)
            .collect();
        for step in write_root_acl_plan(&previous, roots, |p| p.is_dir()) {
            match step {
                AclStep::Revoke(path) => revoke_path(&path, sid)?,
                // Jozkah/jan#124: the worktree's `.jan` holds the project's
                // agent policy and hooks. Created when missing so the deny is
                // in place before the shell could make one of its own. These
                // are Jan-owned worktrees only (the caller refuses any other
                // root on AppContainer), never a folder of the user's.
                AclStep::DenyJan(jan) => {
                    if !jan.exists() {
                        std::fs::create_dir_all(&jan)
                            .map_err(|e| format!("{}: {e}", jan.display()))?;
                    }
                    set_access(&jan, sid, DENY_ACCESS, FILE_ALL_ACCESS)?;
                }
                // Without FILE_DELETE_CHILD the shell cannot rename the
                // denied `.jan` away by the parent's right and put its own
                // in its place. Deleting an ordinary file still works: every
                // child inherits DELETE from this same grant. SET_ACCESS, not
                // GRANT_ACCESS: a grant merges into an allow ACE already on
                // the root, and a worktree granted FILE_ALL_ACCESS by an
                // earlier build would keep FILE_DELETE_CHILD through it.
                AclStep::GrantRoot(root) => {
                    set_access(&root, sid, SET_ACCESS, FILE_ALL_ACCESS & !FILE_DELETE_CHILD)?
                }
            }
        }
        if let Some(parent) = record.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let listed: Vec<String> = roots.iter().map(|r| r.to_string_lossy().into_owned()).collect();
        std::fs::write(record, listed.join("\n")).map_err(|e| format!("{}: {e}", record.display()))
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
        buffer.resize(SECURITY_MAX_SID_SIZE as usize, 0);
        let mut len = buffer.len() as u32;
        let ok = unsafe {
            CreateWellKnownSid(
                WinCapabilityInternetClientSid,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as PSID,
                &mut len,
            )
        };
        if ok == 0 {
            return Err(format!(
                "could not build the internetClient capability: {}",
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
    fn sandbox_path(program: &Path) -> OsString {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(root) = std::env::var_os("SystemRoot") {
            let root = PathBuf::from(root);
            let system32 = root.join("system32");
            dirs.push(system32.clone());
            dirs.push(root.clone());
            dirs.push(system32.join("Wbem"));
            dirs.push(system32.join("WindowsPowerShell").join("v1.0"));
        }
        for dir in shell_runtime_dirs(program) {
            if dir.is_dir() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        // Then the host's own toolchain folders the container is allowed to
        // run (Git, Node, Python installed for all users), after the system
        // folders so none of them can shadow a system program. Folders in the
        // user profile, or whose ACL does not admit app packages, stay out: in
        // the sandbox they would only fail, and confusingly.
        if let Some(host) = std::env::var_os("PATH") {
            let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
            let extra = crate::tools::host_tools::usable_host_dirs(
                &host,
                profile.as_deref(),
                &dirs,
                crate::tools::host_tools::container_can_execute,
            );
            dirs.extend(extra);
        }
        OsString::from(
            dirs.iter()
                .map(|d| d.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(";"),
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
                path: Some(sandbox_path(&req.program)),
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
        // Authorized write roots: Jan-owned worktrees only, checked by the
        // caller before it asked. A missing one is refused rather than skipped,
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
        sync_write_roots(&write_root_record(&name), sid.0, &req.write_roots).map_err(|detail| {
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

        let mut capability_sid = Vec::new();
        let mut capabilities = Vec::new();
        if req.allow_network {
            capabilities.push(internet_capability(&mut capability_sid).map_err(|detail| {
                LaunchFailure::new(Stage::SandboxPolicy, "CreateWellKnownSid", detail)
            })?);
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
mod tests {
    use super::*;

    fn ws() -> PathBuf {
        PathBuf::from(r"C:\Users\me\.jan\agent-workspace\threads\t1")
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

    /// Jozkah/jan#124: every granted worktree gets its `.jan` denied, and a
    /// worktree no longer granted loses that deny with its grant.
    #[test]
    fn the_acl_plan_denies_each_write_roots_jan_and_undoes_it_on_revoke() {
        let (a, b, gone) = (PathBuf::from("/w/a"), PathBuf::from("/w/b"), PathBuf::from("/w/gone"));
        let dirs = [a.clone(), a.join(".jan"), b.clone()];
        let is_dir = |p: &Path| dirs.iter().any(|d| d == p);

        assert_eq!(
            write_root_acl_plan(&[], &[a.clone()], is_dir),
            vec![AclStep::DenyJan(a.join(".jan")), AclStep::GrantRoot(a.clone())]
        );
        // `a` dropped: its .jan deny and its grant are revoked, `b` granted.
        assert_eq!(
            write_root_acl_plan(&[a.clone(), gone.clone()], &[b.clone()], is_dir),
            vec![
                AclStep::Revoke(a.join(".jan")),
                AclStep::Revoke(a.clone()),
                AclStep::DenyJan(b.join(".jan")),
                AclStep::GrantRoot(b.clone()),
            ]
        );
        // A dropped root without a .jan: only the root is revoked.
        assert_eq!(
            write_root_acl_plan(&[b.clone()], &[], is_dir),
            vec![AclStep::Revoke(b.clone())]
        );
        // Still granted: re-applied, nothing revoked.
        assert_eq!(
            write_root_acl_plan(&[a.clone()], &[a.clone()], is_dir),
            vec![AclStep::DenyJan(a.join(".jan")), AclStep::GrantRoot(a.clone())]
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

        win::sync_write_roots(&record, psid, &[wt.clone()]).unwrap();
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

        win::sync_write_roots(&record, psid, &[]).unwrap();
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

        win::sync_write_roots(&record, psid, &[wt.clone()]).unwrap();
        assert!(win::acl_names(&wt, psid), "the authorized worktree was not granted");
        // Jozkah/jan#124: its `.jan` exists and carries the container's deny.
        assert!(wt.join(".jan").is_dir(), "the worktree's .jan was not created");
        // An explicit (not inherited) deny ACE for the container, all access.
        let jan_aces = win::aces_for(&wt.join(".jan"), psid);
        assert!(
            jan_aces.iter().any(|&(ty, flags, _)| ty == 1 && flags & 0x10 == 0),
            "the worktree's .jan has no explicit deny: {jan_aces:?}"
        );

        win::sync_write_roots(&record, psid, &[other.clone()]).unwrap();
        assert!(!win::acl_names(&wt, psid), "the revoked worktree kept its ACE");
        assert!(
            win::aces_for(&wt.join(".jan"), psid).is_empty(),
            "the revoked worktree's .jan kept an ACE"
        );
        assert!(win::acl_names(&other, psid));

        win::sync_write_roots(&record, psid, &[]).unwrap();
        assert!(!win::acl_names(&other, psid));

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
        let args = helper_args_at(&ws(), Some(&wt), None, &roots, false, Path::new("bash.exe"), &[]);
        let req = parse_request(args).expect("parsed");
        assert_eq!(req.start_dir, wt);
        assert_eq!(req.write_roots, roots);

        let args = helper_args(&ws(), None, &roots, false, Path::new("bash.exe"), &[]);
        assert_eq!(parse_request(args).expect("parsed").start_dir, ws());

        let elsewhere = PathBuf::from(r"C:\Users\me\repo");
        let args =
            helper_args_at(&ws(), Some(&elsewhere), None, &roots, false, Path::new("bash.exe"), &[]);
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
