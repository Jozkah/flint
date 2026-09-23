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
/// user's profile, and granting `ALL APPLICATION PACKAGES` read and execute.
/// Returned in host order, without duplicates of `already`.
pub fn usable_host_dirs(
    host_path: &OsString,
    profile: Option<&Path>,
    already: &[PathBuf],
    can_execute: impl Fn(&Path) -> Option<bool>,
) -> Vec<PathBuf> {
    let same = |a: &Path, b: &Path| {
        a.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .eq_ignore_ascii_case(b.to_string_lossy().trim_end_matches(['\\', '/']))
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in std::env::split_paths(host_path) {
        if !dir.is_absolute()
            || !dir.is_dir()
            || under_profile(&dir, profile)
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
            "
[sandbox: `{name}` at {} is part of Git for Windows / MSYS2, which cannot run inside              this sandbox. For repository information use the `git_inspect` tool. For anything              else, tell the user to run the command themselves. Do not retry it here or look for              another copy.]",
            found.display()
        );
    }
    let reason = if under_profile(dir, profile) {
        "it is installed inside the user profile, which the sandbox cannot read".to_string()
    } else if can_execute(dir) == Some(false) {
        "its folder does not grant ALL APPLICATION PACKAGES read and execute, so the sandbox \
         is not allowed to run it"
            .to_string()
    } else {
        "its folder is not on the sandbox PATH".to_string()
    };
    format!(
        "\n[sandbox: `{name}` is installed at {} but this sandbox cannot run it: {reason}. \
         Do not search the disk for another copy, and do not run a runtime bundled with a \
         different application. Tell the user that `{name}` is not available in the sandbox, \
         and that they can run the command themselves or make `{name}` available to it.]",
        found.display()
    )
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
        let got = usable_host_dirs(&host, Some(&prof), &[], |d| Some(d.ends_with("ok")));
        assert_eq!(got, vec![ok.clone()]);
        // Already on the sandbox PATH: not added twice.
        assert!(
            usable_host_dirs(&host, Some(&prof), &[ok.clone()], |_| Some(true))
                .iter()
                .all(|d| d != &ok)
        );
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
            usable_host_dirs(&host, None, &[], |_| Some(true)),
            vec![other]
        );
        let hint = unavailable_hint("git", &cmd.join("git.exe"), None, |_| Some(true));
        assert!(hint.contains("git_inspect"), "{hint}");
        assert!(hint.contains("Do not retry"), "{hint}");
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
