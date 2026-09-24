#[cfg(windows)]
use std::path::Prefix;
use std::path::{Component, Path, PathBuf};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(windows)]
use std::ffi::OsStr;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

/// Normalizes file paths by handling path components, prefixes, and resolving relative paths
/// Based on: https://github.com/rust-lang/cargo/blob/rust-1.67.0/crates/cargo-util/src/paths.rs#L82-L107
pub fn normalize_path(path: &Path) -> PathBuf {
    let mut components = path.components().peekable();
    let mut ret = if let Some(c @ Component::Prefix(_prefix_component)) = components.peek().cloned()
    {
        #[cfg(windows)]
        // Remove only the Verbatim prefix, but keep the drive letter (e.g., C:\)
        match _prefix_component.kind() {
            Prefix::VerbatimDisk(disk) => {
                components.next(); // skip this prefix
                                   // Re-add the disk prefix (e.g., C:)
                let mut pb = PathBuf::new();
                pb.push(format!("{}:", disk as char));
                pb
            }
            Prefix::Verbatim(_) | Prefix::VerbatimUNC(_, _) => {
                components.next(); // skip this prefix
                PathBuf::new()
            }
            _ => {
                components.next();
                PathBuf::from(c.as_os_str())
            }
        }
        #[cfg(not(windows))]
        {
            components.next(); // skip this prefix
            PathBuf::from(c.as_os_str())
        }
    } else {
        PathBuf::new()
    };

    for component in components {
        match component {
            Component::Prefix(..) => unreachable!(),
            Component::RootDir => {
                ret.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                ret.pop();
            }
            Component::Normal(c) => {
                ret.push(c);
            }
        }
    }
    ret
}

/// Removes file:/ and file:\ prefixes from file paths
pub fn normalize_file_path(path: &str) -> String {
    path.replace("file:/", "").replace("file:\\", "")
}

/// Removes prefix from path string with proper formatting
pub fn remove_prefix(path: &str, prefix: &str) -> String {
    if !prefix.is_empty() && path.starts_with(prefix) {
        let result = path[prefix.len()..].to_string();
        if result.is_empty() {
            "/".to_string()
        } else if result.starts_with('/') {
            result
        } else {
            format!("/{}", result)
        }
    } else {
        path.to_string()
    }
}

/// Get Windows short path to avoid issues with spaces and special characters
#[cfg(windows)]
pub fn get_short_path<P: AsRef<std::path::Path>>(path: P) -> Option<String> {
    let wide: Vec<u16> = OsStr::new(path.as_ref())
        .encode_wide()
        .chain(Some(0))
        .collect();

    // When the buffer is too small, GetShortPathNameW writes nothing and
    // returns the size it needs (terminator included), which can exceed 260
    // for a long path. Grow to that size and ask again rather than slicing
    // past the end of the buffer (#176).
    let mut buffer = vec![0u16; 260];
    for _ in 0..3 {
        let len = unsafe {
            GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32)
        } as usize;
        match short_path_outcome(len, buffer.len()) {
            ShortPath::Failed => return None,
            ShortPath::Written(len) => return Some(String::from_utf16_lossy(&buffer[..len])),
            ShortPath::NeedsBuffer(size) => buffer = vec![0u16; size],
        }
    }
    None
}

/// What a `GetShortPathNameW` return value means for a buffer of `capacity`.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum ShortPath {
    Failed,
    Written(usize),
    NeedsBuffer(usize),
}

#[cfg(any(windows, test))]
fn short_path_outcome(returned: usize, capacity: usize) -> ShortPath {
    if returned == 0 {
        ShortPath::Failed
    } else if returned < capacity {
        ShortPath::Written(returned)
    } else {
        ShortPath::NeedsBuffer(returned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_too_small_buffer_asks_for_a_bigger_one_instead_of_slicing() {
        assert_eq!(short_path_outcome(0, 260), ShortPath::Failed);
        assert_eq!(short_path_outcome(12, 260), ShortPath::Written(12));
        assert_eq!(short_path_outcome(260, 260), ShortPath::NeedsBuffer(260));
        assert_eq!(short_path_outcome(400, 260), ShortPath::NeedsBuffer(400));
    }

    #[cfg(windows)]
    #[test]
    fn a_path_longer_than_max_path_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let mut long = dir.path().to_path_buf();
        for _ in 0..30 {
            long.push("a_fairly_long_directory_name");
        }
        let long = std::path::PathBuf::from(format!("\\\\?\\{}", long.display()));
        std::fs::create_dir_all(&long).unwrap();
        // Either a short path or None; never a panic.
        let _ = get_short_path(&long);
    }

    #[cfg(windows)]
    #[test]
    fn test_get_short_path() {
        // Test with a real path that should exist on Windows
        use std::env;
        if let Ok(temp_dir) = env::var("TEMP") {
            let result = get_short_path(&temp_dir);
            // Should return some short path or None (both are valid)
            // We can't assert the exact value as it depends on the system
            println!("Short path result: {:?}", result);
        }
    }
}
