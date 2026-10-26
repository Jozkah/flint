//! Open and replace a fully resolved path without following any link along it.
//!
//! The `write` and `edit` handlers resolve where a path lands
//! ([`super::sandbox::canonicalize_lenient`]), check that location, and only
//! then touch it. Reopening the path by name afterwards would resolve it a
//! second time, and a link swapped into a parent directory in between (the
//! sandboxed shell can write the project) would carry the write somewhere the
//! check never saw. These helpers take the already-resolved path, which
//! contains no links, and walk it one directory at a time refusing any link
//! they meet, so the file they touch is the one that was checked or nothing at
//! all. Ported from janhq/jan#9424 onto Flint's crash-safe replace.
//!
//! Unix walks with `openat(O_NOFOLLOW)` relative to the previous directory's
//! descriptor, then creates the temp file and renames it over the leaf
//! relative to the parent's descriptor, so no step resolves a name twice.
//! Windows has no `openat` in std, so each ancestor is held open without
//! `FILE_SHARE_DELETE`, which keeps it from being renamed or replaced while the
//! replace below it runs, and each node is probed with
//! `FILE_FLAG_OPEN_REPARSE_POINT` and refused if it is a link or junction.
//!
//! Known gap (Windows, as upstream): a sandboxed process can still turn an
//! empty directory into a junction after the walk checked it. Holding the
//! directory blocks rename and delete, not `FSCTL_SET_REPARSE_POINT`.

use std::io::{self, Read};
use std::path::Path;

/// Marker for "a link was found where the resolved path had none": the path was
/// changed between the containment check and the open.
#[derive(Debug)]
pub struct LinkRefused;

impl std::fmt::Display for LinkRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a path component became a symbolic link")
    }
}

impl std::error::Error for LinkRefused {}

/// True iff `e` is the [`LinkRefused`] refusal rather than an ordinary I/O error.
pub fn is_link_refused(e: &io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<LinkRefused>())
}

fn refused() -> io::Error {
    io::Error::other(LinkRefused)
}

fn invalid(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("not an absolute resolved path: {}", path.display()),
    )
}

/// Read the file at the resolved `path`.
pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = imp::open_for_read(path)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(buf)
}

/// Replace the file at the resolved `path` with `bytes` the way
/// [`crate::atomic_file::write_atomic`] does (sibling temp file, flush, keep
/// the replaced file's mode, rename over it), creating missing parents on the
/// way, without following a link at any component or at the leaf.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    imp::write_atomic(path, bytes)
}

#[cfg(unix)]
mod imp {
    use super::{invalid, refused};
    use nix::errno::Errno;
    use nix::fcntl::{openat, renameat, AtFlags, OFlag, AT_FDCWD};
    use nix::sys::stat::{fchmod, fstatat, mkdirat, Mode, SFlag};
    use nix::unistd::{unlinkat, UnlinkatFlags};
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io::{self, Write};
    use std::os::fd::{AsFd, OwnedFd};
    use std::path::{Component, Path};

    /// A directory descriptor that needs only search permission on the
    /// directory, so a `711` parent (common for `/home/<user>`) still walks.
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "freebsd"))]
    const DIR: OFlag = OFlag::O_PATH;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const DIR: OFlag = OFlag::O_SEARCH;
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "freebsd",
        target_os = "macos",
        target_os = "ios"
    )))]
    const DIR: OFlag = OFlag::O_RDONLY;

    #[allow(clippy::unnecessary_cast)]
    fn mode(bits: u32) -> Mode {
        Mode::from_bits_truncate(bits as nix::sys::stat::mode_t)
    }

    fn is_link(dir: &OwnedFd, name: &OsStr) -> bool {
        matches!(
            fstatat(dir, name, AtFlags::AT_SYMLINK_NOFOLLOW),
            Ok(st) if SFlag::from_bits_truncate(st.st_mode) & SFlag::S_IFMT == SFlag::S_IFLNK
        )
    }

    /// Map a failed no-follow open of `name` under `dir`: a link there is the
    /// swap this module exists to catch. Platforms disagree on the errno
    /// (`ELOOP`, or `ENOTDIR` when `O_DIRECTORY` sees the link), so ask the
    /// directory what the entry is instead of trusting the code.
    fn classify(dir: &OwnedFd, name: &OsStr, err: Errno) -> io::Error {
        if is_link(dir, name) {
            refused()
        } else {
            err.into()
        }
    }

    /// The parent directory of `path`, walked from `/` without following a
    /// link, and the leaf's name. With `create`, missing parents are made.
    fn walk_parent(path: &Path, create: bool) -> io::Result<(OwnedFd, &OsStr)> {
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Err(invalid(path));
        };
        let mut comps = parent.components();
        if comps.next() != Some(Component::RootDir) {
            return Err(invalid(path));
        }
        let dir_flags = DIR | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut dir = openat(AT_FDCWD, "/", dir_flags, Mode::empty())?;
        for c in comps {
            let Component::Normal(part) = c else {
                return Err(invalid(path));
            };
            if create {
                match mkdirat(&dir, part, Mode::from_bits_truncate(0o777)) {
                    Ok(()) | Err(Errno::EEXIST) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            dir = match openat(&dir, part, dir_flags, Mode::empty()) {
                Ok(next) => next,
                Err(e) => return Err(classify(&dir, part, e)),
            };
        }
        Ok((dir, name))
    }

    pub(super) fn open_for_read(path: &Path) -> io::Result<File> {
        let (dir, name) = walk_parent(path, false)?;
        let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        match openat(&dir, name, flags, Mode::empty()) {
            Ok(fd) => Ok(File::from(fd)),
            Err(e) => Err(classify(&dir, name, e)),
        }
    }

    pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
        let (dir, name) = walk_parent(path, true)?;
        // The mode the replaced file had; a link at the leaf is refused rather
        // than replaced, so a swap there is reported like one in a parent.
        let existing = match fstatat(&dir, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(st) if SFlag::from_bits_truncate(st.st_mode) & SFlag::S_IFMT == SFlag::S_IFLNK => {
                return Err(refused())
            }
            // `mode_t` is u32 on Linux, u16 on macOS.
            #[allow(clippy::unnecessary_cast)]
            Ok(st) => Some(st.st_mode as u32 & 0o7777),
            Err(Errno::ENOENT) => None,
            Err(e) => return Err(e.into()),
        };
        let temp_path = crate::atomic_file::temp_sibling(path);
        let Some(temp) = temp_path.file_name() else {
            return Err(invalid(path));
        };
        let flags = OFlag::O_WRONLY
            | OFlag::O_CREAT
            | OFlag::O_EXCL
            | OFlag::O_NOFOLLOW
            | OFlag::O_CLOEXEC;
        // Created already restricted, so a private file is never briefly
        // readable by others under a looser mode.
        let create_mode = mode(existing.unwrap_or(0o666) & 0o777);
        let fd = openat(&dir, temp, flags, create_mode)?;
        let result = (|| -> io::Result<()> {
            let mut file = File::from(fd);
            file.write_all(bytes)?;
            file.sync_all()?;
            // The create mode is filtered by the umask; set the exact bits the
            // replaced file had, setuid/setgid/sticky included.
            if let Some(mode) = existing {
                fchmod(file.as_fd(), self::mode(mode))?;
            }
            drop(file);
            // Relative to the walked parent: the rename replaces the entry
            // named `name` there, never what a link of that name points at.
            renameat(&dir, temp, &dir, name)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = unlinkat(&dir, temp, UnlinkatFlags::NoRemoveDir);
        }
        result
    }
}

#[cfg(windows)]
mod imp {
    use super::{invalid, refused};
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::{Component, Path, PathBuf};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    /// No `FILE_SHARE_DELETE`: while this handle lives, nobody can rename,
    /// delete or replace the node, which is what pins the walked chain.
    const SHARE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;

    /// Refuse a link or junction. `File::metadata` reads the reparse tag, so
    /// `is_symlink` is true only for name-surrogate tags: a OneDrive
    /// placeholder is also a reparse point and must stay writable.
    fn reject_link(file: &File) -> io::Result<std::fs::Metadata> {
        let meta = file.metadata()?;
        if meta.file_type().is_symlink() {
            return Err(refused());
        }
        Ok(meta)
    }

    fn pin_dir(path: &Path) -> io::Result<File> {
        let dir = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(SHARE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        if !reject_link(&dir)?.is_dir() {
            // `ErrorKind::NotADirectory` is newer than this crate's MSRV.
            return Err(io::Error::other(format!("not a directory: {}", path.display())));
        }
        Ok(dir)
    }

    /// Hold every ancestor of `path` open, refusing a link at any of them. With
    /// `create`, missing ones are made first.
    fn pin_parents(path: &Path, create: bool) -> io::Result<Vec<File>> {
        let (Some(parent), Some(_)) = (path.parent(), path.file_name()) else {
            return Err(invalid(path));
        };
        if !parent.has_root() {
            return Err(invalid(path));
        }
        let mut walked = PathBuf::new();
        let mut held: Vec<File> = Vec::new();
        for c in parent.components() {
            match c {
                Component::Prefix(_) => {
                    walked.push(c.as_os_str());
                    continue;
                }
                Component::RootDir => walked.push(c.as_os_str()),
                Component::Normal(part) => {
                    walked.push(part);
                    if create {
                        match std::fs::create_dir(&walked) {
                            Ok(()) => {}
                            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                            Err(e) => return Err(e),
                        }
                    }
                }
                _ => return Err(invalid(path)),
            }
            held.push(pin_dir(&walked)?);
        }
        Ok(held)
    }

    /// The leaf itself, never what a link there points at, or `None` if it
    /// does not exist.
    fn probe_leaf(path: &Path) -> io::Result<Option<File>> {
        match OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(SHARE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
        {
            Ok(f) => Ok(Some(f)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub(super) fn open_for_read(path: &Path) -> io::Result<File> {
        let held = pin_parents(path, false)?;
        let Some(probe) = probe_leaf(path)? else {
            return Err(io::ErrorKind::NotFound.into());
        };
        reject_link(&probe)?;
        // Read through a second, plain open: opening with OPEN_REPARSE_POINT
        // for real would hand back a cloud-only OneDrive placeholder
        // undownloaded. The probe holds the leaf without FILE_SHARE_DELETE, so
        // it is still the same file when the plain open follows.
        let file = OpenOptions::new().read(true).share_mode(SHARE).open(path)?;
        drop(probe);
        drop(held);
        Ok(file)
    }

    pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
        let held = pin_parents(path, true)?;
        if let Some(probe) = probe_leaf(path)? {
            reject_link(&probe)?;
            // Released before the rename: holding the leaf without
            // FILE_SHARE_DELETE would make the replace itself fail. A link
            // swapped in after this is replaced by the rename, not followed.
        }
        // The parents are pinned, so the temp file and the rename land in the
        // checked directory.
        let result = crate::atomic_file::write_atomic(path, bytes).map_err(io::Error::other);
        drop(held);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A directory link. Windows uses a junction: it needs no privilege, so the
    /// test runs on every Windows machine, and it is the link a sandboxed
    /// process could actually plant.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "mklink /J failed");
        }
    }

    /// A file link, or `false` where the platform will not make one: Windows
    /// file symlinks need Developer Mode or elevation. CI runners have it, so
    /// there a refusal is a failure, not a skip.
    fn link_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(target, link);
        match made {
            Ok(()) => true,
            Err(e) if std::env::var_os("CI").is_none() => {
                eprintln!("skipping: cannot create a file symlink here: {e}");
                false
            }
            Err(e) => panic!("file symlink on CI: {e}"),
        }
    }

    fn dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir()
            .join(format!("flint_nofollow_test_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&d).unwrap();
        // Unix: macOS's temp dir sits behind the `/var -> /private/var` link,
        // which the walk would rightly refuse. Windows: keep the plain
        // spelling, since `mklink` does not take a `\\?\` path.
        #[cfg(unix)]
        let d = d.canonicalize().unwrap();
        d
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect()
    }

    #[test]
    fn writes_and_reads_creating_parents() {
        let root = dir();
        let target = root.join("a").join("b").join("c.txt");
        write_atomic(&target, b"hello").unwrap();
        assert_eq!(read(&target).unwrap(), b"hello");
        write_atomic(&target, b"hi").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"hi", "replaces");
        assert!(leftovers(&root.join("a").join("b")).is_empty(), "no temp file left");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_replaced_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = dir();
        let target = root.join("run.sh");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
        write_atomic(&target, b"new").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o750);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A link swapped in for a directory after the path was resolved: the walk
    /// must stop there instead of writing on the far side.
    #[test]
    fn a_link_in_a_directory_component_is_refused() {
        let root = dir();
        let outside = dir();
        link_dir(&outside, &root.join("sub"));
        let through = root.join("sub").join("x.txt");
        let err = write_atomic(&through, b"x").unwrap_err();
        assert!(is_link_refused(&err), "write: {err}");
        std::fs::write(outside.join("x.txt"), b"secret").unwrap();
        let err = read(&through).unwrap_err();
        assert!(is_link_refused(&err), "read: {err}");
        assert_eq!(std::fs::read(outside.join("x.txt")).unwrap(), b"secret");
        assert!(leftovers(&outside).is_empty(), "no temp file beyond the link");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A link swapped in for a parent that `write_atomic` would otherwise
    /// create: the missing directories under it are not made on the far side.
    #[test]
    fn a_link_above_missing_parents_is_refused() {
        let root = dir();
        let outside = dir();
        link_dir(&outside, &root.join("sub"));
        let err = write_atomic(&root.join("sub").join("new").join("x.txt"), b"x").unwrap_err();
        assert!(is_link_refused(&err), "{err}");
        assert!(!outside.join("new").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The leaf itself swapped for a link, dangling or not: neither is followed.
    #[test]
    fn a_link_at_the_leaf_is_refused() {
        let root = dir();
        let outside = dir();
        std::fs::write(outside.join("existing"), b"keep").unwrap();
        if !link_file(&outside.join("existing"), &root.join("a"))
            || !link_file(&outside.join("new"), &root.join("b"))
        {
            return;
        }
        assert!(is_link_refused(&write_atomic(&root.join("a"), b"x").unwrap_err()));
        assert!(is_link_refused(&write_atomic(&root.join("b"), b"x").unwrap_err()));
        assert!(is_link_refused(&read(&root.join("a")).unwrap_err()));
        assert_eq!(std::fs::read(outside.join("existing")).unwrap(), b"keep");
        assert!(!outside.join("new").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_relative_path_is_rejected() {
        let err = write_atomic(Path::new("rel/x.txt"), b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }
}
