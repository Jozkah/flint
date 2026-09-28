//! Host toolchains as seen from the confined shell.
//!
//! On Windows the shell runs in an AppContainer with a `PATH` built rather
//! than inherited (`appcontainer::sandbox_path`). A lowbox token can only run
//! a program whose folder grants `ALL APPLICATION PACKAGES` read and execute,
//! so a toolchain that is installed and on the user's `PATH` can still be
//! unusable inside the sandbox. Two things follow:
//!
//! - toolchain folders on the host `PATH` that the container *can* run are
//!   carried into the sandbox `PATH`, after the system folders; and
//! - when a command is not found, the failure says where the program is
//!   installed and why the sandbox cannot run it, so the model reports that
//!   instead of searching the disk and running some other application's copy.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The program a "not found" failure names, if the output says which.
pub fn missing_program(output: &str) -> Option<String> {
    // PowerShell: "node : The term 'node' is not recognized as the name of a cmdlet"
    if let Some(i) = output.find("The term '") {
        let rest = &output[i + "The term '".len()..];
        if let Some(end) = rest.find('\'') {
            return clean(&rest[..end]);
        }
    }
    // cmd: "'node' is not recognized as an internal or external command"
    if let Some(end) = output.find("' is not recognized as an internal or external command") {
        let head = &output[..end];
        if let Some(start) = head.rfind('\'') {
            return clean(&head[start + 1..]);
        }
    }
    // POSIX: "bash: node: command not found" / "sh: 1: node: not found"
    for line in output.lines() {
        if let Some(head) = line.strip_suffix(": command not found") {
            return clean(head.rsplit(": ").next().unwrap_or(head));
        }
    }
    None
}

fn clean(name: &str) -> Option<String> {
    let name = name.trim();
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.contains(['/', '\\', ':', ' '])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'));
    ok.then(|| name.to_string())
}

/// Where `name` is on the host `PATH`, trying the host's executable extensions.
pub fn locate_on_host(name: &str, host_path: &OsString, pathext: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        pathext
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(host_path) {
        if !dir.is_absolute() {
            continue;
        }
        for ext in exts.iter().map(String::as_str).chain(std::iter::once("")) {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// True for a folder that holds only a stand-in for a program, never its
/// install: a yarn script shim folder (`xfs-*`), a package manager's
/// `node_modules\.bin`, or one under `avoid` (the temp folder, the app's own
/// folder with its bundled sidecars).
pub fn is_transient_dir(dir: &Path, avoid: &[PathBuf]) -> bool {
    let shim_component = dir.components().any(|c| {
        let part = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        part.starts_with("xfs-") || part == ".bin"
    });
    shim_component || avoid.iter().any(|a| under_profile(dir, Some(a)))
}

/// The folders a toolchain grant is never offered for on this machine: the
/// temp folder and the folder of the running app.
pub fn transient_dirs() -> Vec<PathBuf> {
    let mut out = vec![std::env::temp_dir()];
    if let Some(own) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        out.push(own);
    }
    out
}

/// Where the real executable of `name` is on the host `PATH`: an `.exe` or
/// `.com` (not a `.cmd`/`.bat`/`.ps1` shim, which only starts a runtime found
/// elsewhere), in a folder that is not [`is_transient_dir`].
pub fn locate_real_on_host(name: &str, host_path: &OsString, avoid: &[PathBuf]) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".com"] } else { &[""] };
    for dir in std::env::split_paths(host_path) {
        if !dir.is_absolute() || is_transient_dir(&dir, avoid) {
            continue;
        }
        for ext in exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The command that grants `folder` to the sandbox from an elevated terminal,
/// for a folder the user cannot change the permissions of.
pub fn admin_grant_command(folder: &Path) -> String {
    format!(
        "icacls \"{}\" /grant *S-1-15-2-1:(OI)(CI)(RX)",
        folder.display()
    )
}

/// Whether the current user may change the permissions of `dir` (open it for
/// `WRITE_DAC`). `None` where this cannot be told.
#[cfg(windows)]
pub fn can_change_acl(dir: &Path) -> Option<bool> {
    win::can_write_dac(dir)
}

#[cfg(not(windows))]
pub fn can_change_acl(_dir: &Path) -> Option<bool> {
    None
}

/// True when `path` is inside the user's profile, which the sandbox cannot
/// read. Compared case-insensitively on Windows.
pub fn under_profile(path: &Path, profile: Option<&Path>) -> bool {
    let Some(profile) = profile else { return false };
    let norm = |p: &Path| {
        let s = p.to_string_lossy().replace('/', "\\");
        let s = s.trim_end_matches('\\').to_string();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    let (p, root) = (norm(path), norm(profile));
    !root.is_empty() && (p == root || p.starts_with(&format!("{root}\\")))
}

/// True for a folder of an MSYS2-based installation: Git for Windows (its
/// `cmd`, `bin`, `mingw64\bin` and `usr\bin`) or MSYS2 itself. Its programs
/// cannot work inside the AppContainer (the runtime needs the global object
/// namespace, and Git cannot open the null device), so carrying them onto the
/// sandbox `PATH` only turns "not recognized" into a confusing failure.
/// Recognised by the MSYS runtime DLL in the folder or an installation root
/// above it.
pub fn is_msys_install(dir: &Path) -> bool {
    if dir.join("msys-2.0.dll").is_file() {
        return true;
    }
    dir.ancestors()
        .take(4)
        .any(|root| root.join("usr").join("bin").join("msys-2.0.dll").is_file())
}

/// Whether a folder's own ACL lets AppContainer processes read and execute
/// what is in it. `None` where this cannot be told (not Windows, unreadable).
#[cfg(windows)]
pub fn container_can_execute(dir: &Path) -> Option<bool> {
    win::any_package_can_execute(dir)
}

#[cfg(not(windows))]
pub fn container_can_execute(_dir: &Path) -> Option<bool> {
    None
}

/// Host `PATH` folders the sandbox can use: absolute, existing, outside the
/// user's profile (unless the user granted that folder to the sandbox), and
/// granting `ALL APPLICATION PACKAGES` read and execute. Returned in host
/// order, without duplicates of `already`; granted folders not on the host
/// `PATH` follow at the end.
pub fn usable_host_dirs(
    host_path: &OsString,
    profile: Option<&Path>,
    already: &[PathBuf],
    granted: &[PathBuf],
    can_execute: impl Fn(&Path) -> Option<bool>,
) -> Vec<PathBuf> {
    let same = |a: &Path, b: &Path| {
        a.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .eq_ignore_ascii_case(b.to_string_lossy().trim_end_matches(['\\', '/']))
    };
    let is_granted = |dir: &Path| granted.iter().any(|g| same(g, dir));
    let mut out: Vec<PathBuf> = Vec::new();
    let host_dirs: Vec<PathBuf> = std::env::split_paths(host_path).collect();
    let extra: Vec<PathBuf> = granted
        .iter()
        .filter(|g| !host_dirs.iter().any(|d| same(d, g)))
        .cloned()
        .collect();
    for dir in host_dirs.into_iter().chain(extra) {
        if !dir.is_absolute()
            || !dir.is_dir()
            || (under_profile(&dir, profile) && !is_granted(&dir))
            || is_msys_install(&dir)
        {
            continue;
        }
        if already.iter().chain(out.iter()).any(|d| same(d, &dir)) {
            continue;
        }
        if can_execute(&dir) == Some(true) {
            out.push(dir);
        }
    }
    out
}

/// A note appended to a "not found" failure when the program exists on the
/// host but the sandbox cannot run it. Only called for a program found on the
/// host `PATH`; one not installed at all is already said by the shell.
pub fn unavailable_hint(
    name: &str,
    found: &Path,
    profile: Option<&Path>,
    can_execute: impl Fn(&Path) -> Option<bool>,
) -> String {
    let dir = found.parent().unwrap_or(found);
    if is_msys_install(dir) {
        return format!(
            "\n[sandbox: `{name}` at {} is part of Git for Windows / MSYS2, which cannot run inside \
             this sandbox. For Git and GitHub work (status, commit, push, pull requests) use the \
             `git` tool, which runs the real git and gh outside the sandbox with the user's \
             approval; never an MCP shell. For anything else, tell the user to run the command \
             themselves. Do not retry it here or look for another copy.]",
            found.display()
        );
    }
    let reason = if under_profile(dir, profile) {
        "it is installed inside the user profile, which the sandbox cannot read unless the \
         user allows it"
            .to_string()
    } else if can_execute(dir) == Some(false) {
        "its folder does not grant ALL APPLICATION PACKAGES read and execute, so the sandbox \
         is not allowed to run it"
            .to_string()
    } else {
        "its folder is not on the sandbox PATH".to_string()
    };
    let remedy = if can_execute(dir) == Some(false) && can_change_acl(dir) == Some(false) {
        format!(
            "Settings cannot grant this folder. Ask the user to run `{}` in an elevated terminal, then restart Flint, or run the command themselves.",
            admin_grant_command(dir)
        )
    } else {
        format!(
            "Ask the user to allow `{name}` in Settings > Agent Tools > Sandbox toolchains, or run the command themselves."
        )
    };
    format!(
        "\n[sandbox: `{name}` is installed at {} but this sandbox cannot run it: {reason}. \
         Do not search the disk for another copy, run a runtime bundled with another application, \
         probe settings, or retry until the user acts. {remedy}]",
        found.display()
    )
}

/// The note appended to a "not found" failure when the program is not on the
/// host `PATH` either. Without it the model searched the disk and the user
/// profile, tried to download an installer, and retried the same command.
pub fn not_installed_hint(name: &str) -> String {
    format!(
        "\n[sandbox: `{name}` is not available in this sandbox. Do not search the disk or \
         user profile for it, do not download or install it, and do not retry; tell the user \
         the command to run themselves and treat the check as not run.]"
    )
}

/// The assignment in `command` whose unquoted value PowerShell ran as a
/// program called `name`: `$env:GOTOOLCHAIN=local` makes PowerShell look up a
/// command `local`, and saying "`local` is not available in this sandbox"
/// then sent the model to tell the user a program was missing when the
/// command only needed quotes.
pub fn unquoted_assignment(command: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = command[from..].find('=') {
        let eq = from + i;
        from = eq + 1;
        // The bare word right after `=`, up to a separator. A quoted value
        // starts with a quote and so never equals a program name.
        let value: String = command[eq + 1..]
            .trim_start()
            .chars()
            .take_while(|c| !c.is_whitespace() && !matches!(c, ';' | '|' | ')' | '&'))
            .collect();
        if !value.eq_ignore_ascii_case(name) {
            continue;
        }
        // The target left of `=` must be a variable: `$name` or `$env:NAME`.
        let head = command[..eq].trim_end();
        let start = head.rfind(|c: char| c.is_whitespace() || c == ';').map_or(0, |s| s + 1);
        let target = &head[start..];
        let is_var = target.starts_with('$')
            && target.len() > 1
            && target[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':'));
        if is_var {
            return Some(format!(
                "\n[shell: `{name}` was run as a command because the value in `{target}={value}` \
                 is not quoted. PowerShell needs quotes around a text value: \
                 `{target}=\"{value}\"`. Fix the quoting and run it again; nothing is missing \
                 from the sandbox.]"
            ));
        }
    }
    None
}

/// A note for a command that reported success after a step inside it failed.
///
/// PowerShell's exit status is the last statement's, so `go vet ./...;
/// "EXIT=$LASTEXITCODE"` printed `EXIT=2` and still came back `[exit 0]`, and
/// the result was recorded as a passing check. Only called for output the
/// shell reported as successful.
pub fn masked_failure_note(output: &str) -> Option<String> {
    masked_failure(output).map(|(_, note)| note)
}

/// The real exit code of a command that reported success after a step inside
/// it failed, with the note explaining it. The code is the failing step's
/// `EXIT=<n>` when the output printed one, else 1 (an error record carries no
/// code). Only called for output the shell reported as successful.
pub fn masked_failure(output: &str) -> Option<(i32, String)> {
    let reported = output
        .match_indices("EXIT=")
        .filter_map(|(i, _)| {
            let digits: String = output[i + 5..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            digits.parse::<i64>().ok()
        })
        .find(|code| *code != 0);
    let native_error = output.contains("NativeCommandError")
        || output.contains("UnauthorizedAccessException")
        || output.contains("ItemNotFoundException");
    let (code, what) = match (reported, native_error) {
        (Some(code), _) => (
            i32::try_from(code).unwrap_or(1),
            format!("a command inside it exited with {code}"),
        ),
        (None, true) => (1, "a command inside it wrote an error record".to_string()),
        (None, false) => return None,
    };
    Some((
        code,
        format!(
            "\n[shell: reported exit 0, but {what}. PowerShell reports only the last \
             statement's status, so a trailing `\"EXIT=$LASTEXITCODE\"` or `; echo` hides the \
             failure. The result carries exit {code}. Treat this command as failed, and check \
             `$LASTEXITCODE` with `if` or run the step on its own.]"
        ),
    ))
}

/// Replace the final `[exit 0]` marker line of a `bash` result with
/// `[exit <code>]`, so the exit code every reader takes from the marker is
/// the failing command's rather than the shell's masked 0.
pub fn set_exit_marker(output: &mut String, code: i32) {
    let mut end = output.len();
    while let Some(i) = output[..end].rfind("[exit 0]") {
        let line_start = i == 0 || output[..i].ends_with('\n');
        let rest = &output[i + "[exit 0]".len()..];
        let line_end = rest.is_empty() || rest.starts_with('\n') || rest.starts_with("\r\n");
        if line_start && line_end {
            output.replace_range(i..i + "[exit 0]".len(), &format!("[exit {code}]"));
            return;
        }
        end = i;
    }
}

/// A one-line hint for Go's `-C` flag-order error. `go` accepts `-C <dir>`
/// only as the very first flag (`go -C <dir> test ./...`), and a model keeps
/// writing it after the subcommand.
pub fn go_flag_order_hint(output: &str) -> Option<&'static str> {
    let lower = output.to_lowercase();
    let hit = lower.contains("-c flag must be first flag")
        || (lower.contains("go: ") && lower.contains("flag provided but not defined: -c"));
    hit.then_some(
        "\n[shell: go needs `-C <dir>` as the first flag, before the subcommand: \
         `go -C <dir> test ./...`, not `go test -C <dir> ./...`. Or run go from that \
         directory (the tool's `cwd`).]",
    )
}

/// The note appended when a download fails on name resolution inside a
/// sandbox that has no network: retrying cannot succeed.
pub const NO_NETWORK_HINT: &str =
    "\n[sandbox: the shell has no network access; do not retry downloads.]";

/// True when the output is a name-resolution failure, the form a download
/// takes in a sandbox without network.
pub fn is_name_resolution_failure(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("the remote name could not be resolved")
        || lower.contains("no such host is known")
}

/// `py` when the command was run through the Windows Python launcher and it
/// exited with one of its own "no Python found" codes (103: no suitable
/// runtime, 109: the requested version is not installed). The launcher prints
/// no "not recognized" line, so [`missing_program`] cannot see it, but for the
/// model it is the same situation: there is no Python here.
pub fn python_launcher_missing(command: &str, output: &str) -> Option<String> {
    let first = command.split_whitespace().next()?;
    let stem = first
        .trim_matches(['"', '\''])
        .trim_end_matches(".exe")
        .to_ascii_lowercase();
    if stem != "py" {
        return None;
    }
    let launcher_code = output.lines().any(|l| {
        let l = l.trim();
        l == "[exit 103]" || l == "[exit 109]"
    });
    launcher_code.then(|| "py".to_string())
}

/// Toolchain programs the environment probe reports on. A fixed list: the
/// question is "which of the usual runtimes can the shell start", and each
/// name costs prompt space.
pub const PROBED_PROGRAMS: &[&str] = &[
    "python", "python3", "py", "node", "npm", "npx", "yarn", "pnpm", "bun", "deno", "cargo",
    "rustc", "go", "dotnet", "java", "git", "uv", "pip", "make", "cmake", "gcc", "clang",
];

/// Which probed programs the confined shell can start, and which are installed
/// on the host but cannot be started there. A program on neither list is not
/// installed; it is left out to keep the prompt short.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainReport {
    pub runnable: Vec<String>,
    pub unavailable: Vec<String>,
    /// The unavailable programs a grant would fix, with the one folder it
    /// would change. Leaves out an MSYS2 program (it cannot run in the sandbox
    /// whatever its folder allows), the `py` launcher (it lives in the Windows
    /// folder, which already admits app packages; it needs a runnable Python),
    /// and any folder a grant must never touch.
    #[serde(default)]
    pub grantable: Vec<GrantCandidate>,
}

/// One program a toolchain grant would make runnable.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantCandidate {
    pub program: String,
    /// The install folder whose permissions the grant would change.
    pub folder: PathBuf,
    /// Set when the user cannot change that folder's permissions (under
    /// Program Files, say): the app cannot grant it, and this is the command
    /// to run in an elevated terminal instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin_command: Option<String>,
}

/// Which of `report.unavailable` a grant would fix: the program resolves on
/// the host `PATH` into a folder that app packages may not run from today and
/// that [`crate::tools::toolchain_grants::validate_folder`] accepts.
///
/// The program is resolved to its real executable ([`locate_real_on_host`]),
/// so a shim or a temp copy never names the folder. A folder the user cannot
/// change the permissions of (`can_change` is `Some(false)`) carries the
/// elevated command instead.
pub fn grant_candidates(
    unavailable: &[String],
    host_path: &OsString,
    avoid: &[PathBuf],
    profile: Option<&Path>,
    can_execute: impl Fn(&Path) -> Option<bool>,
    can_change: impl Fn(&Path) -> Option<bool>,
) -> Vec<GrantCandidate> {
    let mut out: Vec<GrantCandidate> = Vec::new();
    for name in unavailable {
        let Some(exe) = locate_real_on_host(name, host_path, avoid) else {
            continue;
        };
        let Some(folder) = exe.parent().map(Path::to_path_buf) else {
            continue;
        };
        if can_execute(&folder) != Some(false)
            || crate::tools::toolchain_grants::validate_folder(&folder, &exe, profile).is_err()
        {
            continue;
        }
        let admin_command =
            (can_change(&folder) == Some(false)).then(|| admin_grant_command(&folder));
        out.push(GrantCandidate {
            program: name.clone(),
            folder,
            admin_command,
        });
    }
    out
}

/// Classify `names` without starting the sandbox: a program is runnable when
/// it resolves on `sandbox_path` to a file in a folder the container may
/// execute from (`can_execute`) that is not part of an MSYS2 installation;
/// installed-but-unrunnable when it is not runnable yet resolves on
/// `host_path`.
pub fn classify_programs(
    names: &[&str],
    sandbox_path: &OsString,
    host_path: &OsString,
    pathext: &str,
    can_execute: impl Fn(&Path) -> Option<bool>,
) -> ToolchainReport {
    let mut report = ToolchainReport::default();
    for name in names {
        let runnable = locate_on_host(name, sandbox_path, pathext).is_some_and(|found| {
            let dir = found.parent().unwrap_or(&found);
            !is_msys_install(dir) && can_execute(dir) == Some(true)
        });
        if runnable {
            report.runnable.push(name.to_string());
        } else if locate_on_host(name, host_path, pathext).is_some() {
            report.unavailable.push(name.to_string());
        }
    }
    // `py` is only a launcher: it lives in the Windows folder, so it always
    // starts, but it runs a Python it finds elsewhere -- usually under the
    // user profile, which the sandbox cannot execute. On its own it exits 103
    // or 109. It counts as runnable only when a Python itself is.
    let python_runs = report
        .runnable
        .iter()
        .any(|n| n == "python" || n == "python3");
    if !python_runs {
        if let Some(at) = report.runnable.iter().position(|n| n == "py") {
            report.runnable.remove(at);
            report.unavailable.push("py".to_string());
        }
    }
    report
}

/// The system folders at the head of the AppContainer shell's `PATH`, as
/// `appcontainer::sandbox_path` builds them. The shell's own runtime folders
/// that follow are either these or an MSYS2 installation, which runs nothing
/// here, so they do not change the answer.
fn system_dirs() -> Vec<PathBuf> {
    let Some(root) = std::env::var_os("SystemRoot").map(PathBuf::from) else {
        return Vec::new();
    };
    let system32 = root.join("system32");
    vec![
        system32.clone(),
        root,
        system32.join("Wbem"),
        system32.join("WindowsPowerShell").join("v1.0"),
    ]
}

/// The probe for this machine. `None` where the answer is not known: any
/// backend but AppContainer (bubblewrap and Seatbelt expose the host's
/// programs, so there is nothing surprising to warn about, and a guess would
/// only mislead). Computed once per app session; [`reset_toolchain_probe`]
/// drops the cached answer.
pub fn probe_toolchains() -> Option<ToolchainReport> {
    let mut cache = TOOLCHAINS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(done) = cache.as_ref() {
        return done.clone();
    }
    let answer = compute_toolchains();
    *cache = Some(answer.clone());
    answer
}

/// Forget the cached probe, so the next call looks again.
pub fn reset_toolchain_probe() {
    *TOOLCHAINS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

static TOOLCHAINS: std::sync::Mutex<Option<Option<ToolchainReport>>> =
    std::sync::Mutex::new(None);

fn compute_toolchains() -> Option<ToolchainReport> {
    if !cfg!(windows) || crate::tools::jail::backend() != crate::tools::jail::Backend::AppContainer
    {
        return None;
    }
    let host = std::env::var_os("PATH").unwrap_or_default();
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let mut dirs = system_dirs();
    let granted = crate::tools::toolchain_grants::granted_folders();
    let extra = usable_host_dirs(
        &host,
        profile.as_deref(),
        &dirs,
        &granted,
        container_can_execute,
    );
    dirs.extend(extra);
    let sandbox = std::env::join_paths(&dirs).ok()?;
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut report = classify_programs(
        PROBED_PROGRAMS,
        &sandbox,
        &host,
        &pathext,
        container_can_execute,
    );
    report.grantable = grant_candidates(
        &report.unavailable,
        &host,
        &transient_dirs(),
        profile.as_deref(),
        container_can_execute,
        can_change_acl,
    );
    Some(report)
}

#[cfg(windows)]
mod win {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, EqualSid, GetAce, WinBuiltinAnyPackageSid, ACCESS_ALLOWED_ACE,
        ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_MAX_SID_SIZE,
    };

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    const FILE_READ_DATA: u32 = 0x0001;
    const FILE_EXECUTE: u32 = 0x0020;
    const GENERIC_ALL: u32 = 0x1000_0000;
    const GENERIC_EXECUTE: u32 = 0x2000_0000;
    const GENERIC_READ: u32 = 0x8000_0000;

    fn grants_read(mask: u32) -> bool {
        mask & (FILE_READ_DATA | GENERIC_READ | GENERIC_ALL) != 0
    }
    fn grants_exec(mask: u32) -> bool {
        mask & (FILE_EXECUTE | GENERIC_EXECUTE | GENERIC_ALL) != 0
    }

    /// Open the folder for `WRITE_DAC` only, to learn whether its ACL could
    /// be changed; nothing is changed.
    pub fn can_write_dac(dir: &Path) -> Option<bool> {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_ACCESS_DENIED, INVALID_HANDLE_VALUE,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        const WRITE_DAC: u32 = 0x0004_0000;
        let name: Vec<u16> = OsStr::new(dir)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                WRITE_DAC,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
                Some(false)
            } else {
                None
            };
        }
        unsafe { CloseHandle(handle) };
        Some(true)
    }

    pub fn any_package_can_execute(dir: &Path) -> Option<bool> {
        let name: Vec<u16> = OsStr::new(dir)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut sid_buf = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut len = sid_buf.len() as u32;
        let made = unsafe {
            CreateWellKnownSid(
                WinBuiltinAnyPackageSid,
                std::ptr::null_mut(),
                sid_buf.as_mut_ptr() as PSID,
                &mut len,
            )
        };
        let result = if made == 0 {
            None
        } else if dacl.is_null() {
            // A null DACL grants everyone everything.
            Some(true)
        } else {
            let count = unsafe { (*dacl).AceCount } as u32;
            let (mut read, mut exec, mut denied) = (false, false, false);
            for i in 0..count {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                if unsafe { GetAce(dacl, i, &mut ace) } == 0 || ace.is_null() {
                    continue;
                }
                let header = unsafe { &*(ace as *const ACE_HEADER) };
                if header.AceFlags & INHERIT_ONLY_ACE != 0 {
                    continue;
                }
                if header.AceType != ACCESS_ALLOWED_ACE_TYPE
                    && header.AceType != ACCESS_DENIED_ACE_TYPE
                {
                    continue;
                }
                // ACCESS_DENIED_ACE has the same layout as ACCESS_ALLOWED_ACE.
                let body = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
                let sid = &body.SidStart as *const u32 as PSID;
                if unsafe { EqualSid(sid, sid_buf.as_mut_ptr() as PSID) } == 0 {
                    continue;
                }
                if header.AceType == ACCESS_DENIED_ACE_TYPE {
                    if grants_read(body.Mask) || grants_exec(body.Mask) {
                        denied = true;
                    }
                } else {
                    read |= grants_read(body.Mask);
                    exec |= grants_exec(body.Mask);
                }
            }
            Some(!denied && read && exec)
        };
        unsafe { LocalFree(sd) };
        result
    }
}

#[cfg(test)]
mod grant_candidate_tests {
    use super::*;

    /// Only a folder a grant would fix is offered: not Git for Windows, not
    /// the `py` launcher's Windows folder, not the profile root.
    #[test]
    fn only_fixable_folders_are_offered() {
        let root = std::env::temp_dir().join(format!("grant-cand-{}", std::process::id()));
        let profile = root.join("Users").join("me");
        let python = profile.join("AppData").join("Local").join("Programs").join("Python311");
        let git = root.join("Git");
        let windows = root.join("Windows");
        for d in [&python, &git.join("cmd"), &git.join("usr").join("bin"), &windows] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(git.join("usr").join("bin").join("msys-2.0.dll"), "x").unwrap();
        let ext = if cfg!(windows) { ".exe" } else { "" };
        for (dir, name) in [
            (&python, "python"),
            (&python, "python3"),
            (&git.join("cmd"), "git"),
            (&windows, "py"),
            (&profile, "loose"),
        ] {
            std::fs::write(dir.join(format!("{name}{ext}")), "").unwrap();
        }
        let host = std::env::join_paths([
            python.clone(),
            git.join("cmd"),
            windows.clone(),
            profile.clone(),
        ])
        .unwrap();
        let names: Vec<String> = ["python", "python3", "git", "py", "loose"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // Everything but the Windows folder refuses app packages today.
        let got = grant_candidates(
            &names,
            &host,
            &[],
            Some(&profile),
            |d| Some(d == windows.as_path()),
            |_| Some(true),
        );
        let offered: Vec<&str> = got.iter().map(|c| c.program.as_str()).collect();
        assert_eq!(offered, vec!["python", "python3"]);
        assert!(got.iter().all(|c| c.folder == python));
        assert!(got.iter().all(|c| c.admin_command.is_none()));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A shim or a temp copy never names the folder: yarn's `xfs-*` shims,
    /// the app's own folder and npm's `.cmd`/`.ps1` shims are passed over for
    /// the real install further down the `PATH`.
    #[test]
    fn shims_temp_copies_and_the_apps_folder_are_skipped() {
        let root = std::env::temp_dir().join(format!("grant-shim-{}", std::process::id()));
        let xfs = root.join("t").join("xfs-db9b0b6d");
        let app = root.join("app").join("debug");
        let npm = root.join("Roaming").join("npm");
        let node_home = root.join("tools").join("node");
        let bun_home = root.join("tools").join("bun");
        for d in [&xfs, &app, &npm, &node_home, &bun_home] {
            std::fs::create_dir_all(d).unwrap();
        }
        let exe = if cfg!(windows) { ".exe" } else { "" };
        std::fs::write(xfs.join(format!("node{exe}")), "").unwrap();
        std::fs::write(xfs.join("yarn.cmd"), "").unwrap();
        std::fs::write(app.join(format!("bun{exe}")), "").unwrap();
        std::fs::write(npm.join("pnpm.cmd"), "").unwrap();
        std::fs::write(npm.join("pnpm.ps1"), "").unwrap();
        std::fs::write(node_home.join(format!("node{exe}")), "").unwrap();
        std::fs::write(bun_home.join(format!("bun{exe}")), "").unwrap();
        let host = std::env::join_paths([
            xfs.clone(),
            app.clone(),
            npm.clone(),
            node_home.clone(),
            bun_home.clone(),
        ])
        .unwrap();
        let names: Vec<String> = ["node", "yarn", "bun", "pnpm"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let got = grant_candidates(
            &names,
            &host,
            &[root.join("app")],
            None,
            |_| Some(false),
            |_| Some(true),
        );
        let offered: Vec<(&str, &Path)> = got
            .iter()
            .map(|c| (c.program.as_str(), c.folder.as_path()))
            .collect();
        if cfg!(windows) {
            // yarn and pnpm exist only as shims: nothing to grant for them.
            assert_eq!(
                offered,
                vec![("node", node_home.as_path()), ("bun", bun_home.as_path())]
            );
        } else {
            assert_eq!(offered[0], ("node", node_home.as_path()));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A folder the user created is one whose permissions they may change.
    #[cfg(windows)]
    #[test]
    fn the_users_own_folder_can_have_its_acl_changed() {
        let dir = std::env::temp_dir().join(format!("grant-dac-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(can_change_acl(&dir), Some(true));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(can_change_acl(&dir), None);
    }

    /// A folder the user cannot change is offered with the elevated command,
    /// not a grant.
    #[test]
    fn a_folder_needing_admin_carries_the_icacls_command() {
        let root = std::env::temp_dir().join(format!("grant-admin-{}", std::process::id()));
        let nodejs = root.join("Program Files").join("nodejs");
        std::fs::create_dir_all(&nodejs).unwrap();
        let exe = if cfg!(windows) { ".exe" } else { "" };
        std::fs::write(nodejs.join(format!("node{exe}")), "").unwrap();
        let host = std::env::join_paths([nodejs.clone()]).unwrap();
        let got = grant_candidates(
            &["node".to_string()],
            &host,
            &[],
            None,
            |_| Some(false),
            |_| Some(false),
        );
        assert_eq!(got.len(), 1);
        let want = format!(
            "icacls \"{}\" /grant *S-1-15-2-1:(OI)(CI)(RX)",
            nodejs.display()
        );
        assert_eq!(got[0].admin_command.as_deref(), Some(want.as_str()));
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod missing_hint_tests {
    use super::*;

    #[test]
    fn a_program_missing_everywhere_gets_a_do_not_hunt_note() {
        let h = not_installed_hint("node");
        assert!(h.contains("`node` is not available in this sandbox"), "{h}");
        assert!(h.contains("do not download or install it"), "{h}");
        assert!(h.contains("treat the check as not run"), "{h}");
    }

    #[test]
    fn go_c_flag_order_error_gets_a_one_line_hint() {
        let h = go_flag_order_hint("go: -C flag must be first flag on command line\n[exit 2]")
            .expect("hint");
        assert!(h.contains("`go -C <dir> test ./...`"), "{h}");
        assert_eq!(h.trim_start().lines().count(), 1, "{h}");
        assert!(go_flag_order_hint("flag provided but not defined: -C\ngo: usage\n[exit 2]").is_some());
        assert!(go_flag_order_hint("ok  example.com/x 0.1s\n[exit 0]").is_none());
        assert!(go_flag_order_hint("error: unknown flag -C\n[exit 1]").is_none());
    }

    #[test]
    fn a_failure_behind_a_trailing_statement_is_named() {
        let vet = "go : go: vet.exe failed: open NUL: Access is denied.\n\
                   + FullyQualifiedErrorId : NativeCommandError\nEXIT=2\n[exit 0]";
        assert!(masked_failure_note(vet).unwrap().contains("exited with 2"));
        let copy = "Copy-Item : Access is denied\n UnauthorizedAccessException\nCOPIED\n[exit 0]";
        assert!(masked_failure_note(copy).unwrap().contains("error record"));
        assert!(masked_failure_note("go version go1.26\nEXIT=0\n[exit 0]").is_none());
    }

    #[test]
    fn a_masked_failure_carries_the_failing_commands_exit_code() {
        let vet = "go: vet failed\nEXIT=2\n[exit 0]";
        let (code, note) = masked_failure(vet).unwrap();
        assert_eq!(code, 2);
        assert!(note.contains("[shell: reported exit 0, but"), "{note}");
        assert!(note.contains("carries exit 2"), "{note}");
        let (code, _) = masked_failure("x NativeCommandError\n[exit 0]").unwrap();
        assert_eq!(code, 1);

        // Only the real marker line is rewritten: not an echoed one mid-line,
        // and a truncation note after it stays.
        let mut out = "echo [exit 0] inline\n[exit 0]\n[output truncated at 1 of 2 bytes]".to_string();
        set_exit_marker(&mut out, 2);
        assert_eq!(out, "echo [exit 0] inline\n[exit 2]\n[output truncated at 1 of 2 bytes]");
        let mut out = "EXIT=3\n[exit 0]".to_string();
        set_exit_marker(&mut out, 3);
        assert!(crate::tools::handlers::bash_result_failed(&out));
        assert!(out.ends_with("[exit 3]"));
    }

    #[test]
    fn an_unquoted_assignment_is_a_quoting_note_not_a_missing_program() {
        let cmd = r#"Push-Location "C:\p"; $env:GOTOOLCHAIN=local; $env:GODEBUG="x=0"; go list ./..."#;
        let h = unquoted_assignment(cmd, "local").expect("names the assignment");
        assert!(h.contains(r#"`$env:GOTOOLCHAIN="local"`"#), "{h}");
        assert!(h.contains("nothing is missing"), "{h}");
        // A quoted value, a genuinely missing program, or a flag value is not it.
        assert!(unquoted_assignment(r#"$env:A="local"; local"#, "local").is_none());
        assert!(unquoted_assignment("node --version", "node").is_none());
        assert!(unquoted_assignment("go build -tags=local ./...", "local").is_none());
        assert!(unquoted_assignment("$x = local", "local").is_some());
    }

    #[test]
    fn the_python_launcher_codes_count_as_missing() {
        assert_eq!(python_launcher_missing("py -3 x.py", "No suitable Python runtime found\n[exit 103]"), Some("py".into()));
        assert_eq!(python_launcher_missing("py.exe --version", "[exit 109]"), Some("py".into()));
        assert_eq!(python_launcher_missing("py x.py", "Traceback\n[exit 1]"), None);
        assert_eq!(python_launcher_missing("python x.py", "[exit 103]"), None);
    }

    #[test]
    fn name_resolution_failures_are_recognised() {
        assert!(is_name_resolution_failure("Invoke-WebRequest : The remote name could not be resolved: 'x.org'"));
        assert!(is_name_resolution_failure("No such host is known. (x.org:443)"));
        assert!(!is_name_resolution_failure("404 Not Found"));
        assert!(NO_NETWORK_HINT.contains("no network access"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp folder, removed when dropped.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let p =
                std::env::temp_dir().join(format!("host-tools-{tag}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn names_the_missing_program_in_each_shell() {
        let ps =
            "npm : The term 'npm' is not recognized as the name of a cmdlet, function, script file";
        assert_eq!(missing_program(ps).as_deref(), Some("npm"));
        let cmd =
            "'node' is not recognized as an internal or external command,\r\noperable program";
        assert_eq!(missing_program(cmd).as_deref(), Some("node"));
        assert_eq!(
            missing_program("bash: cargo: command not found\n[exit 127]").as_deref(),
            Some("cargo")
        );
        assert_eq!(missing_program("test failed").as_deref(), None);
        // A name that is really a path or a phrase is not guessed at.
        assert_eq!(
            missing_program("The term 'C:\\x\\y.exe' is not recognized").as_deref(),
            None
        );
    }

    #[test]
    fn profile_membership_is_by_path_prefix() {
        let profile = Path::new(r"C:\Users\me");
        assert!(under_profile(
            Path::new(r"C:\Users\me\.cargo\bin"),
            Some(profile)
        ));
        assert!(under_profile(Path::new(r"c:\users\ME"), Some(profile)) == cfg!(windows));
        assert!(!under_profile(
            Path::new(r"C:\Users\mel\bin"),
            Some(profile)
        ));
        assert!(!under_profile(
            Path::new(r"C:\Program Files\nodejs"),
            Some(profile)
        ));
        assert!(!under_profile(Path::new(r"C:\x"), None));
    }

    #[test]
    fn usable_dirs_skip_profile_duplicates_and_unrunnable_folders() {
        let root = TempDir::new("dirs");
        let ok = root.path().join("ok");
        let blocked = root.path().join("blocked");
        let prof = root.path().join("profile");
        let prof_bin = prof.join("bin");
        for d in [&ok, &blocked, &prof_bin] {
            std::fs::create_dir_all(d).unwrap();
        }
        let host = std::env::join_paths([
            ok.clone(),
            blocked.clone(),
            prof_bin.clone(),
            ok.clone(),
            PathBuf::from("relative"),
            root.path().join("missing"),
        ])
        .unwrap();
        let got = usable_host_dirs(&host, Some(&prof), &[], &[], |d| Some(d.ends_with("ok")));
        assert_eq!(got, vec![ok.clone()]);
        // Already on the sandbox PATH: not added twice.
        assert!(
            usable_host_dirs(&host, Some(&prof), &[ok.clone()], &[], |_| Some(true))
                .iter()
                .all(|d| d != &ok)
        );
        // A profile folder the user granted is carried, once it admits app
        // packages; a granted folder off the host PATH is appended.
        let granted_off_path = prof.join("tools");
        std::fs::create_dir_all(&granted_off_path).unwrap();
        let granted = vec![prof_bin.clone(), granted_off_path.clone()];
        let got = usable_host_dirs(&host, Some(&prof), &[], &granted, |_| Some(true));
        assert!(got.contains(&prof_bin), "{got:?}");
        assert_eq!(got.last(), Some(&granted_off_path));
        // Granted but still not executable by app packages: left out.
        let got = usable_host_dirs(&host, Some(&prof), &[], &granted, |d| {
            Some(!d.starts_with(&prof))
        });
        assert!(!got.contains(&prof_bin), "{got:?}");
    }

    #[test]
    fn locates_a_program_by_extension() {
        let root = TempDir::new("locate");
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let file = if cfg!(windows) {
            bin.join("tool.cmd")
        } else {
            bin.join("tool")
        };
        std::fs::write(&file, "x").unwrap();
        let host = std::env::join_paths([bin.clone()]).unwrap();
        assert_eq!(locate_on_host("tool", &host, ".EXE;.CMD"), Some(file));
        assert_eq!(locate_on_host("nope", &host, ".EXE;.CMD"), None);
    }

    #[test]
    fn hint_names_the_path_the_reason_and_forbids_substitutes() {
        let profile = Path::new(r"C:\Users\me");
        let blocked = unavailable_hint(
            "node",
            Path::new(r"C:\Program Files\nodejs\node.exe"),
            Some(profile),
            |_| Some(false),
        );
        assert!(blocked.contains(r"C:\Program Files\nodejs\node.exe"));
        assert!(blocked.contains("ALL APPLICATION PACKAGES"));
        assert!(blocked.contains("different application"));
        let in_profile = unavailable_hint(
            "cargo",
            Path::new(r"C:\Users\me\.cargo\bin\cargo.exe"),
            Some(profile),
            |_| Some(true),
        );
        assert!(in_profile.contains("user profile"));
    }

    #[test]
    fn msys_installations_are_recognised_and_kept_off_the_sandbox_path() {
        let root = TempDir::new("msys");
        let git = root.path().join("Git");
        let usr_bin = git.join("usr").join("bin");
        let cmd = git.join("cmd");
        let mingw = git.join("mingw64").join("bin");
        let other = root.path().join("Tools").join("bin");
        for d in [&usr_bin, &cmd, &mingw, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(usr_bin.join("msys-2.0.dll"), "x").unwrap();
        assert!(is_msys_install(&usr_bin));
        assert!(is_msys_install(&cmd));
        assert!(is_msys_install(&mingw));
        assert!(!is_msys_install(&other));
        let host = std::env::join_paths([cmd.clone(), mingw.clone(), other.clone()]).unwrap();
        assert_eq!(
            usable_host_dirs(&host, None, &[], &[], |_| Some(true)),
            vec![other]
        );
        let hint = unavailable_hint("git", &cmd.join("git.exe"), None, |_| Some(true));
        assert!(hint.contains("`git` tool"), "{hint}");
        assert!(hint.contains("Do not retry"), "{hint}");
        assert!(!hint.contains("  "), "no runs of spaces: {hint}");
    }

    #[test]
    fn classifies_runnable_unrunnable_and_absent_programs() {
        let root = TempDir::new("classify");
        let open = root.path().join("open");
        let locked = root.path().join("locked");
        let git = root.path().join("Git");
        let git_cmd = git.join("cmd");
        for d in [&open, &locked, &git_cmd, &git.join("usr").join("bin")] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(git.join("usr").join("bin").join("msys-2.0.dll"), "x").unwrap();
        let ext = if cfg!(windows) { ".exe" } else { "" };
        for (dir, name) in [(&open, "node"), (&locked, "python"), (&git_cmd, "git"), (&open, "npm")] {
            std::fs::write(dir.join(format!("{name}{ext}")), "x").unwrap();
        }
        // The sandbox PATH carries `open` and (wrongly) Git's folder; the host
        // PATH has all three. `locked` denies app packages.
        let sandbox = std::env::join_paths([open.clone(), git_cmd.clone()]).unwrap();
        let host = std::env::join_paths([open.clone(), locked.clone(), git_cmd.clone()]).unwrap();
        let got = classify_programs(
            &["node", "python", "git", "cargo", "npm"],
            &sandbox,
            &host,
            ".EXE;.CMD",
            |d| Some(!d.ends_with("locked")),
        );
        assert_eq!(got.runnable, vec!["node", "npm"]);
        assert_eq!(got.unavailable, vec!["python", "git"]);
        // An ACL that cannot be read is not a yes.
        let unknown = classify_programs(&["node"], &sandbox, &host, ".EXE", |_| None);
        assert!(unknown.runnable.is_empty());
        assert_eq!(unknown.unavailable, vec!["node"]);
    }

    #[test]
    fn py_counts_only_when_a_python_runs() {
        let root = TempDir::new("pylauncher");
        let open = root.path().join("open");
        let locked = root.path().join("locked");
        for d in [&open, &locked] {
            std::fs::create_dir_all(d).unwrap();
        }
        let ext = if cfg!(windows) { ".exe" } else { "" };
        std::fs::write(open.join(format!("py{ext}")), "x").unwrap();
        std::fs::write(locked.join(format!("python{ext}")), "x").unwrap();
        let sandbox = std::env::join_paths([open.clone()]).unwrap();
        let host = std::env::join_paths([open.clone(), locked.clone()]).unwrap();
        let can = |d: &Path| Some(!d.ends_with("locked"));
        let got = classify_programs(&["python", "py"], &sandbox, &host, ".EXE", can);
        assert!(got.runnable.is_empty(), "{:?}", got.runnable);
        assert_eq!(got.unavailable, vec!["python", "py"]);

        // With a Python the sandbox can run, the launcher counts too.
        std::fs::write(open.join(format!("python{ext}")), "x").unwrap();
        let got = classify_programs(&["python", "py"], &sandbox, &host, ".EXE", can);
        assert_eq!(got.runnable, vec!["python", "py"]);
    }

    #[test]
    fn probed_list_has_no_duplicates() {
        let mut v = PROBED_PROGRAMS.to_vec();
        v.sort();
        v.dedup();
        assert_eq!(v.len(), PROBED_PROGRAMS.len());
    }

    #[cfg(windows)]
    #[test]
    fn system32_is_runnable_by_app_packages() {
        let sys = std::env::var_os("SystemRoot")
            .map(|r| PathBuf::from(r).join("System32"))
            .unwrap();
        assert_eq!(container_can_execute(&sys), Some(true));
    }
}
