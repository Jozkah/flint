//! Per-toolchain opt-in: let the Windows sandbox run one toolchain the user
//! installed under their profile.
//!
//! A lowbox token can only run a program whose folder grants `ALL APPLICATION
//! PACKAGES` (S-1-15-2-1) read and execute. Toolchains installed per user --
//! Python under `AppData\Local\Programs`, Node through nvm -- do not, so the
//! sandbox cannot start them (see [`super::host_tools`]). The fix is one
//! access entry on that toolchain's install folder, and only there: never the
//! profile, never `AppData`, never a folder that does not hold the program.
//!
//! A grant is made only when the user asks for it, is recorded so it can be
//! listed and revoked, and revoking removes exactly the entry the grant added.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::host_tools;

/// One toolchain folder the user let the sandbox use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainGrant {
    /// The probed program the grant was made for (`python`, `node`, ...).
    pub program: String,
    /// The install folder the access entry was added to.
    pub folder: PathBuf,
    /// Seconds since the Unix epoch.
    pub granted_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct GrantFile {
    #[serde(default)]
    grants: Vec<ToolchainGrant>,
}

static STORE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Where grants are recorded. Set once by the host (the app's settings folder);
/// until it is, there are no grants and none can be made.
pub fn set_store(path: PathBuf) {
    *STORE.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
}

fn store() -> Option<PathBuf> {
    STORE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The file that holds the grants, under the app's settings folder.
pub fn store_path(settings_dir: &Path) -> PathBuf {
    settings_dir.join("sandbox-toolchain-grants.json")
}

fn load_from(path: &Path) -> Vec<ToolchainGrant> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<GrantFile>(&raw).ok())
        .map(|f| f.grants)
        .unwrap_or_default()
}

fn save_to(path: &Path, grants: &[ToolchainGrant]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(&GrantFile {
        grants: grants.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    crate::atomic_file::write_atomic(path, body.as_bytes())
        .map_err(|e| format!("could not record the grant in {}: {e}", path.display()))
}

/// Every recorded grant.
pub fn list() -> Vec<ToolchainGrant> {
    store().map(|p| load_from(&p)).unwrap_or_default()
}

/// The granted folders that still exist, for the sandbox `PATH`.
pub fn granted_folders() -> Vec<PathBuf> {
    list()
        .into_iter()
        .map(|g| g.folder)
        .filter(|f| f.is_dir())
        .collect()
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.trim_end_matches('\\').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn same(a: &Path, b: &Path) -> bool {
    norm(a) == norm(b)
}

/// Whether `folder` may receive a grant for `exe`. Refuses the profile root,
/// the `AppData` roots and `AppData\Local\Programs` (each holds far more than
/// one toolchain), a drive root, an MSYS2 installation (it cannot run in the
/// sandbox anyway), and any folder that does not contain the program.
pub fn validate_folder(folder: &Path, exe: &Path, profile: Option<&Path>) -> Result<(), String> {
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }
    if folder.parent().is_none() || folder.components().count() < 3 {
        return Err(format!(
            "{} is too broad to open to the sandbox",
            folder.display()
        ));
    }
    if let Some(profile) = profile {
        let appdata = profile.join("AppData");
        let refused = [
            profile.to_path_buf(),
            appdata.clone(),
            appdata.join("Local"),
            appdata.join("Roaming"),
            appdata.join("LocalLow"),
            appdata.join("Local").join("Programs"),
        ];
        if refused.iter().any(|r| same(r, folder)) {
            return Err(format!(
                "{} is the profile or an AppData root, which is never opened to the sandbox",
                folder.display()
            ));
        }
        if host_tools::under_profile(profile, Some(folder)) {
            return Err(format!(
                "{} contains the whole profile, which is never opened to the sandbox",
                folder.display()
            ));
        }
    }
    if !exe.is_file() || !host_tools::under_profile(exe, Some(folder)) || same(exe, folder) {
        return Err(format!(
            "{} does not contain {}",
            folder.display(),
            exe.display()
        ));
    }
    if host_tools::is_msys_install(folder) {
        return Err(format!(
            "{} is part of Git for Windows / MSYS2, which cannot run in the sandbox",
            folder.display()
        ));
    }
    Ok(())
}

/// The ACL operations a grant needs, injectable so the bookkeeping is testable
/// on any platform.
pub trait Acl {
    /// Add the inheritable read+execute entry for `ALL APPLICATION PACKAGES`.
    fn add(&self, folder: &Path) -> Result<(), String>;
    /// Remove exactly the entry [`Acl::add`] made. `Ok(false)` when it is gone.
    fn remove(&self, folder: &Path) -> Result<bool, String>;
}

/// The real Windows ACL.
pub struct SystemAcl;

impl Acl for SystemAcl {
    #[cfg(windows)]
    fn add(&self, folder: &Path) -> Result<(), String> {
        win::add(folder)
    }
    #[cfg(windows)]
    fn remove(&self, folder: &Path) -> Result<bool, String> {
        win::remove(folder)
    }
    #[cfg(not(windows))]
    fn add(&self, _folder: &Path) -> Result<(), String> {
        Err("toolchain grants exist only for the Windows sandbox".into())
    }
    #[cfg(not(windows))]
    fn remove(&self, _folder: &Path) -> Result<bool, String> {
        Err("toolchain grants exist only for the Windows sandbox".into())
    }
}

/// Grant `folder` for `program` (whose executable is `exe`), recording it in
/// `store`. Refuses a folder already granted.
pub fn grant_at(
    store: &Path,
    program: &str,
    exe: &Path,
    profile: Option<&Path>,
    acl: &dyn Acl,
) -> Result<ToolchainGrant, String> {
    let folder = host_tools::grant_root(exe)
        .ok_or_else(|| format!("{} has no folder", exe.display()))?;
    validate_folder(&folder, exe, profile)?;
    let mut grants = load_from(store);
    if grants.iter().any(|g| same(&g.folder, &folder)) {
        return Err(format!("{} is already granted", folder.display()));
    }
    acl.add(&folder)?;
    let grant = ToolchainGrant {
        program: program.to_string(),
        folder,
        granted_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default(),
    };
    grants.push(grant.clone());
    if let Err(e) = save_to(store, &grants) {
        // Unrecorded, the entry could never be revoked from the app: undo it.
        let _ = acl.remove(&grant.folder);
        return Err(e);
    }
    Ok(grant)
}

/// Revoke the grant on `folder` recorded in `store`: remove its access entry,
/// then the record.
pub fn revoke_at(store: &Path, folder: &Path, acl: &dyn Acl) -> Result<(), String> {
    let mut grants = load_from(store);
    let Some(at) = grants.iter().position(|g| same(&g.folder, folder)) else {
        return Err(format!("{} has no toolchain grant", folder.display()));
    };
    // A folder deleted since is fine: there is no entry left to remove.
    if grants[at].folder.exists() {
        acl.remove(&grants[at].folder)?;
    }
    grants.remove(at);
    save_to(store, &grants)
}

/// Let the sandbox run `program`: only for a program the probe reports as
/// installed but unrunnable, on the folder its executable is in.
pub fn grant(program: &str) -> Result<ToolchainGrant, String> {
    let store = store().ok_or("toolchain grants are not available here")?;
    let report = host_tools::probe_toolchains()
        .ok_or("toolchain grants exist only for the Windows sandbox")?;
    let Some(candidate) = report.grantable.iter().find(|c| c.program == program) else {
        return Err(format!(
            "`{program}` is not a toolchain a grant would make runnable in the sandbox"
        ));
    };
    if let Some(command) = &candidate.admin_command {
        return Err(format!(
            "changing {} needs administrator rights: run `{command}` in an elevated terminal",
            candidate.folder.display()
        ));
    }
    let host = std::env::var_os("PATH").unwrap_or_default();
    let exe = host_tools::grant_executable(program, &host, &host_tools::transient_dirs())
        .ok_or_else(|| format!("`{program}` is not on the PATH"))?;
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let made = grant_at(&store, program, &exe, profile.as_deref(), &SystemAcl)?;
    host_tools::reset_toolchain_probe();
    Ok(made)
}

/// Undo a grant made by [`grant`].
pub fn revoke(folder: &Path) -> Result<(), String> {
    let store = store().ok_or("toolchain grants are not available here")?;
    revoke_at(&store, folder, &SystemAcl)?;
    host_tools::reset_toolchain_probe();
    Ok(())
}

#[cfg(windows)]
mod win {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::core::PWSTR;
    use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, DeleteAce, EqualSid, GetAce, WinBuiltinAnyPackageSid,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
        OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR, PSID, SECURITY_MAX_SID_SIZE,
    };

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const INHERITED_ACE: u8 = 0x10;
    /// `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE`: what `icacls ... (RX)` sets.
    pub const RX: u32 = 0x0012_00A9;
    const OI_CI: u8 = (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8;

    fn wide(p: &Path) -> Vec<u16> {
        OsStr::new(p).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn any_package_sid() -> Result<Vec<u8>, String> {
        let mut sid = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut len = sid.len() as u32;
        let made = unsafe {
            CreateWellKnownSid(
                WinBuiltinAnyPackageSid,
                std::ptr::null_mut(),
                sid.as_mut_ptr() as PSID,
                &mut len,
            )
        };
        if made == 0 {
            return Err(format!(
                "could not build the ALL APPLICATION PACKAGES SID: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(sid)
    }

    /// The folder's DACL and the descriptor that owns it (free with LocalFree).
    fn read_dacl(path: &Path) -> Result<(*mut ACL, PSECURITY_DESCRIPTOR), String> {
        let name = wide(path);
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
            return Err(format!(
                "could not read the ACL of {}: {}",
                path.display(),
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }
        Ok((dacl, sd))
    }

    fn write_dacl(path: &Path, dacl: *mut ACL) -> Result<(), String> {
        let mut name = wide(path);
        let status = unsafe {
            SetNamedSecurityInfoW(
                name.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "could not change the ACL of {}: {}",
                path.display(),
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }
        Ok(())
    }

    /// Indexes of the explicit ALL APPLICATION PACKAGES entries, with whether
    /// each is exactly the one [`add`] makes.
    fn explicit_package_aces(dacl: *mut ACL, sid: &mut [u8]) -> Vec<(u32, bool)> {
        let mut out = Vec::new();
        if dacl.is_null() {
            return out;
        }
        let count = unsafe { (*dacl).AceCount } as u32;
        for i in 0..count {
            let mut ace: *mut c_void = std::ptr::null_mut();
            if unsafe { GetAce(dacl, i, &mut ace) } == 0 || ace.is_null() {
                continue;
            }
            let header = unsafe { &*(ace as *const ACE_HEADER) };
            if header.AceFlags & INHERITED_ACE != 0 {
                continue;
            }
            let body = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
            let ace_sid = &body.SidStart as *const u32 as PSID;
            if unsafe { EqualSid(ace_sid, sid.as_mut_ptr() as PSID) } == 0 {
                continue;
            }
            let ours = header.AceType == ACCESS_ALLOWED_ACE_TYPE
                && header.AceFlags == OI_CI
                && body.Mask == RX;
            out.push((i, ours));
        }
        out
    }

    pub fn add(folder: &Path) -> Result<(), String> {
        let mut sid = any_package_sid()?;
        let (dacl, sd) = read_dacl(folder)?;
        let result = (|| {
            // An explicit entry for the SID already there would be merged with
            // ours, and a revoke could then not take back exactly what was
            // added. Such a folder is left to the user.
            if !explicit_package_aces(dacl, &mut sid).is_empty() {
                return Err(format!(
                    "{} already has its own ALL APPLICATION PACKAGES entry; change it by hand",
                    folder.display()
                ));
            }
            let access = EXPLICIT_ACCESS_W {
                grfAccessPermissions: RX,
                grfAccessMode: GRANT_ACCESS,
                grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                    ptstrName: sid.as_mut_ptr() as PWSTR,
                },
            };
            let mut merged: *mut ACL = std::ptr::null_mut();
            let status = unsafe { SetEntriesInAclW(1, &access, dacl, &mut merged) };
            if status != ERROR_SUCCESS {
                return Err(format!(
                    "could not build the ACL: {}",
                    std::io::Error::from_raw_os_error(status as i32)
                ));
            }
            let written = write_dacl(folder, merged);
            unsafe { LocalFree(merged as *mut c_void) };
            written
        })();
        unsafe { LocalFree(sd) };
        result
    }

    pub fn remove(folder: &Path) -> Result<bool, String> {
        let mut sid = any_package_sid()?;
        let (dacl, sd) = read_dacl(folder)?;
        let result = (|| {
            let Some((index, _)) = explicit_package_aces(dacl, &mut sid)
                .into_iter()
                .find(|(_, ours)| *ours)
            else {
                return Ok(false);
            };
            if unsafe { DeleteAce(dacl, index) } == 0 {
                return Err(format!(
                    "could not remove the entry: {}",
                    std::io::Error::last_os_error()
                ));
            }
            write_dacl(folder, dacl).map(|_| true)
        })();
        unsafe { LocalFree(sd) };
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A fresh directory under the system temp folder, removed when dropped.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!(
                "toolchain-grants-{}-{n}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&p);
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

    #[derive(Default)]
    struct FakeAcl {
        added: RefCell<Vec<PathBuf>>,
        removed: RefCell<Vec<PathBuf>>,
    }

    impl Acl for FakeAcl {
        fn add(&self, folder: &Path) -> Result<(), String> {
            self.added.borrow_mut().push(folder.to_path_buf());
            Ok(())
        }
        fn remove(&self, folder: &Path) -> Result<bool, String> {
            self.removed.borrow_mut().push(folder.to_path_buf());
            Ok(true)
        }
    }

    /// A fake profile with a per-user Python install inside it.
    fn profile_with_python() -> (TempDir, PathBuf, PathBuf) {
        let dir = TempDir::new();
        let profile = dir.path().join("Users").join("me");
        let install = profile
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("Python")
            .join("Python311");
        std::fs::create_dir_all(&install).unwrap();
        let exe = install.join("python.exe");
        std::fs::write(&exe, b"").unwrap();
        (dir, profile, exe)
    }

    #[test]
    fn only_the_install_folder_is_accepted() {
        let (_dir, profile, exe) = profile_with_python();
        let install = exe.parent().unwrap();
        assert!(validate_folder(install, &exe, Some(&profile)).is_ok());

        for broad in [
            profile.clone(),
            profile.join("AppData"),
            profile.join("AppData").join("Local"),
            profile.join("AppData").join("Local").join("Programs"),
        ] {
            let err = validate_folder(&broad, &exe, Some(&profile)).unwrap_err();
            assert!(err.contains("never opened"), "{}: {err}", broad.display());
        }
        // A folder that does not hold the program.
        let other = profile.join("elsewhere");
        std::fs::create_dir_all(&other).unwrap();
        let err = validate_folder(&other, &exe, Some(&profile)).unwrap_err();
        assert!(err.contains("does not contain"), "{err}");
        // A folder above the profile would take the whole profile with it.
        let above = profile.parent().unwrap();
        assert!(validate_folder(above, &exe, Some(&profile)).is_err());
    }

    #[test]
    fn grant_records_and_revoke_removes_exactly_that_grant() {
        let (dir, profile, exe) = profile_with_python();
        let store = store_path(&dir.path().join("settings"));
        let acl = FakeAcl::default();

        let made = grant_at(&store, "python", &exe, Some(&profile), &acl).unwrap();
        assert_eq!(made.folder, exe.parent().unwrap());
        assert_eq!(*acl.added.borrow(), vec![made.folder.clone()]);
        assert_eq!(load_from(&store), vec![made.clone()]);

        // Granting twice is refused and changes nothing.
        assert!(grant_at(&store, "python", &exe, Some(&profile), &acl).is_err());
        assert_eq!(acl.added.borrow().len(), 1);

        revoke_at(&store, &made.folder, &acl).unwrap();
        assert_eq!(*acl.removed.borrow(), vec![made.folder.clone()]);
        assert!(load_from(&store).is_empty());
        assert!(revoke_at(&store, &made.folder, &acl).is_err());
    }

    /// The set of granted paths for a rustup toolchain: the toolchain root
    /// (so `lib\rustlib`, which `rustc` reads, is covered), once, and nothing
    /// above it.
    #[test]
    fn a_rustup_toolchain_is_granted_at_its_root() {
        let dir = TempDir::new();
        let profile = dir.path().join("Users").join("me");
        let root = profile.join(".rustup").join("toolchains").join("stable-x");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(root.join("lib").join("rustlib")).unwrap();
        let exe = bin.join("cargo.exe");
        std::fs::write(&exe, b"").unwrap();
        let store = store_path(&dir.path().join("settings"));
        let acl = FakeAcl::default();
        let made = grant_at(&store, "cargo", &exe, Some(&profile), &acl).unwrap();
        assert_eq!(made.folder, root);
        assert_eq!(*acl.added.borrow(), vec![root]);
    }

    #[test]
    fn a_refused_folder_touches_no_acl() {
        let (dir, profile, _exe) = profile_with_python();
        let store = store_path(&dir.path().join("settings"));
        let acl = FakeAcl::default();
        // An executable sitting directly in the profile root.
        let loose = profile.join("tool.exe");
        std::fs::write(&loose, b"").unwrap();
        assert!(grant_at(&store, "tool", &loose, Some(&profile), &acl).is_err());
        assert!(acl.added.borrow().is_empty());
        assert!(load_from(&store).is_empty());
    }

    /// The real ACL, on a temp folder only: the entry lets app packages run
    /// what is inside, and revoking takes back exactly that entry.
    #[cfg(windows)]
    #[test]
    fn the_windows_entry_is_added_and_removed() {
        let dir = TempDir::new();
        let folder = dir.path().join("toolchain");
        std::fs::create_dir_all(&folder).unwrap();
        let before = host_tools::container_can_execute(&folder);
        if before == Some(true) {
            // Inherited from the temp folder already; nothing to show here.
            return;
        }
        SystemAcl.add(&folder).unwrap();
        assert_eq!(host_tools::container_can_execute(&folder), Some(true));
        // A second add is refused rather than merged.
        assert!(SystemAcl.add(&folder).is_err());
        assert!(SystemAcl.remove(&folder).unwrap());
        assert_eq!(host_tools::container_can_execute(&folder), before);
        assert!(!SystemAcl.remove(&folder).unwrap());
    }
}
