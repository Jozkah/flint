//! Read-only project browsing for the Cowork code workspace.
//!
//! Separate from the model-facing `read`/`ls` tools on purpose: those format
//! output for a model (truncation footers, line caps), while the code panel
//! needs structured entries and verbatim file content. Both surfaces share the
//! same trust boundary — the attached read-only project root — and this module
//! enforces containment itself rather than trusting the caller's paths.
//!
//! Tauri-free so the containment logic is testable without the GUI stack; the
//! IPC shims live in `commands.rs`.

use std::path::{Component, Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Serialize;

/// One directory level per request: the tree loads lazily, so a huge repository
/// never has to be walked whole. The cap is a fuse against pathological
/// directories (a `node_modules` that slipped past the filters).
pub const MAX_LIST_ENTRIES: usize = 1000;

/// Files above this are not sent to the renderer at all; the viewer shows a
/// friendly oversized notice instead. 1 MiB of source is already far beyond
/// comfortable reading.
pub const MAX_READ_BYTES: u64 = 1024 * 1024;

/// Directories that are never listed: VCS internals, dependency stores and
/// generated output. `.git` is also a security matter — its objects can contain
/// anything ever committed, including secrets since removed from the tree.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    "coverage",
    ".turbo",
    ".gradle",
    ".dart_tool",
    "Pods",
    "DerivedData",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub name: String,
    /// Path relative to the project root, always `/`-separated.
    pub rel_path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListing {
    pub entries: Vec<ProjectEntry>,
    /// True when the directory held more than [`MAX_LIST_ENTRIES`] entries.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub rel_path: String,
    pub size: u64,
    /// UTF-8 text, lossily decoded. Empty when `oversized` or `binary`.
    pub content: String,
    /// The file exceeds [`MAX_READ_BYTES`] and was not read.
    pub oversized: bool,
    /// The file looks binary (NUL byte in its head) and was not decoded.
    pub binary: bool,
}

/// Does this file name look like credentials or another secret-bearing file the
/// UI should not open without an explicit override?
///
/// Name-based, deliberately conservative: `.env` and variants, private keys,
/// keystores, and the classic credential files.
pub fn is_sensitive_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    if lower == ".npmrc" || lower == ".netrc" || lower == ".pgpass" {
        return true;
    }
    if lower == "credentials" || lower == "credentials.json" || lower == "service-account.json" {
        return true;
    }
    if lower.starts_with("id_rsa") || lower.starts_with("id_ed25519") || lower.starts_with("id_ecdsa")
    {
        return true;
    }
    for ext in [
        ".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".asc", ".gpg", ".kdbx",
    ] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    false
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("project root {} is unreadable: {e}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a folder", canonical.display()));
    }
    Ok(canonical)
}

/// Resolve `rel` inside `root_canon`, refusing every escape route.
///
/// - absolute paths and drive-letter paths are refused outright;
/// - `..` and other non-plain components are refused lexically, before any
///   filesystem call, so traversal never even reaches `canonicalize`;
/// - the resolved path is canonicalized (following symlinks) and must still be
///   inside the canonical root, so a symlinked escape fails containment.
fn resolve_rel(root_canon: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(format!("absolute paths are not allowed: {rel}"));
    }
    for component in rel_path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => return Err(format!("path escapes the project root: {rel}")),
        }
    }
    let joined = root_canon.join(rel_path);
    let canonical = joined
        .canonicalize()
        .map_err(|e| format!("{} is unreadable: {e}", joined.display()))?;
    if !canonical.starts_with(root_canon) {
        return Err(format!("path escapes the project root: {rel}"));
    }
    Ok(canonical)
}

/// Gitignore matcher for `dir`, built from every `.gitignore` on the chain from
/// the root down to `dir`. Missing files are fine; a broken pattern just drops
/// that file's rules rather than failing the listing.
fn gitignore_for(root_canon: &Path, dir: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root_canon);
    let mut chain = vec![root_canon.to_path_buf()];
    if let Ok(rel) = dir.strip_prefix(root_canon) {
        let mut current = root_canon.to_path_buf();
        for component in rel.components() {
            current = current.join(component);
            chain.push(current.clone());
        }
    }
    for ancestor in chain {
        let file = ancestor.join(".gitignore");
        if file.is_file() {
            let _ = builder.add(file);
        }
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// List one directory level of an attached project, lazily and filtered.
pub fn list_dir(root: &str, rel: &str) -> Result<ProjectListing, String> {
    let root_canon = canonical_root(root)?;
    let dir = resolve_rel(&root_canon, rel)?;
    if !dir.is_dir() {
        return Err(format!("{rel} is not a directory"));
    }
    let matcher = gitignore_for(&root_canon, &dir);

    let mut entries: Vec<ProjectEntry> = Vec::new();
    let mut truncated = false;
    let read = std::fs::read_dir(&dir).map_err(|e| format!("cannot list {rel}: {e}"))?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = dir.join(&name);
        // Symlinks are resolved and must land back inside the root; one that
        // points outside is silently dropped — its *name* would otherwise leak
        // what it links to, and following it would leak content.
        let Ok(resolved) = path.canonicalize() else {
            continue;
        };
        if !resolved.starts_with(&root_canon) {
            continue;
        }
        let is_dir = resolved.is_dir();
        if is_dir && IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        if matcher
            .matched_path_or_any_parents(&path, is_dir)
            .is_ignore()
        {
            continue;
        }
        let rel_path = match path.strip_prefix(&root_canon) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(ProjectEntry {
            name,
            rel_path,
            is_dir,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(ProjectListing { entries, truncated })
}

/// Read one project file for display.
///
/// `allow_sensitive` is the explicit user override for [`is_sensitive_name`]
/// files; without it they are refused so a click can never silently open
/// credentials.
pub fn read_file(root: &str, rel: &str, allow_sensitive: bool) -> Result<ProjectFile, String> {
    let root_canon = canonical_root(root)?;
    let file = resolve_rel(&root_canon, rel)?;
    if !file.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !allow_sensitive && is_sensitive_name(&name) {
        return Err(format!("SENSITIVE: {rel} looks like a credentials file"));
    }
    let size = std::fs::metadata(&file)
        .map_err(|e| format!("cannot stat {rel}: {e}"))?
        .len();
    if size > MAX_READ_BYTES {
        return Ok(ProjectFile {
            rel_path: rel.replace('\\', "/"),
            size,
            content: String::new(),
            oversized: true,
            binary: false,
        });
    }
    let bytes = std::fs::read(&file).map_err(|e| format!("cannot read {rel}: {e}"))?;
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return Ok(ProjectFile {
            rel_path: rel.replace('\\', "/"),
            size,
            content: String::new(),
            oversized: false,
            binary: true,
        });
    }
    Ok(ProjectFile {
        rel_path: rel.replace('\\', "/"),
        size,
        content: String::from_utf8_lossy(&bytes).into_owned(),
        oversized: false,
        binary: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory no other test can be handed.
    ///
    /// Keyed by an atomic counter rather than the clock: tests run in parallel
    /// threads of one process, and two calls landing in the same nanosecond
    /// would share a directory, so one test would see the other's files and
    /// fail an exact-listing assertion. That is a flake that only appears
    /// under load, which is exactly where it is hardest to diagnose.
    fn temp_project() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("jan-pb-test-{}", std::process::id()))
            .join(format!("case-{n}"));
        // Start from a clean slate: an earlier run that reused this pid would
        // otherwise leave entries behind that the listing assertions count.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_dirs_before_files_sorted_by_name() {
        let root = temp_project();
        std::fs::create_dir(root.join("zeta")).unwrap();
        std::fs::create_dir(root.join("alpha")).unwrap();
        std::fs::write(root.join("beta.txt"), "x").unwrap();
        std::fs::write(root.join("Apple.txt"), "x").unwrap();
        let listing = list_dir(root.to_str().unwrap(), "").unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "zeta", "Apple.txt", "beta.txt"]);
    }

    #[test]
    fn refuses_traversal_and_absolute() {
        let root = temp_project();
        assert!(list_dir(root.to_str().unwrap(), "../..").is_err());
        assert!(read_file(root.to_str().unwrap(), "../secret", false).is_err());
        assert!(read_file(root.to_str().unwrap(), "/etc/passwd", false).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn drops_symlink_escapes() {
        let root = temp_project();
        let outside = temp_project();
        std::fs::write(outside.join("secret.txt"), "top secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linkdir")).unwrap();
        // Listing silently drops both …
        let listing = list_dir(root.to_str().unwrap(), "").unwrap();
        assert!(listing.entries.is_empty());
        // … and a direct read through the link fails containment.
        assert!(read_file(root.to_str().unwrap(), "link.txt", false).is_err());
    }

    #[test]
    fn hides_ignored_dirs_and_respects_gitignore() {
        let root = temp_project();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(root.join("debug.log"), "x").unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {}").unwrap();
        let listing = list_dir(root.to_str().unwrap(), "").unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&".git"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&"debug.log"));
        assert!(names.contains(&"src"));
        assert!(names.contains(&"main.rs"));
    }

    #[test]
    fn refuses_sensitive_files_without_override() {
        let root = temp_project();
        std::fs::write(root.join(".env"), "KEY=1").unwrap();
        let err = read_file(root.to_str().unwrap(), ".env", false).unwrap_err();
        assert!(err.starts_with("SENSITIVE:"));
        let ok = read_file(root.to_str().unwrap(), ".env", true).unwrap();
        assert_eq!(ok.content, "KEY=1");
    }

    #[test]
    fn flags_oversized_and_binary() {
        let root = temp_project();
        std::fs::write(root.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        let bin = read_file(root.to_str().unwrap(), "bin.dat", false).unwrap();
        assert!(bin.binary);
        assert!(bin.content.is_empty());

        let big = vec![b'a'; (MAX_READ_BYTES + 1) as usize];
        std::fs::write(root.join("big.txt"), &big).unwrap();
        let over = read_file(root.to_str().unwrap(), "big.txt", false).unwrap();
        assert!(over.oversized);
        assert!(over.content.is_empty());
        assert_eq!(over.size, MAX_READ_BYTES + 1);
    }

    #[test]
    fn sensitive_names() {
        for name in [".env", ".env.local", "id_rsa", "server.pem", "app.key", ".npmrc"] {
            assert!(is_sensitive_name(name), "{name} should be sensitive");
        }
        for name in ["main.rs", "env.ts", "keyboard.tsx", "monkey.md"] {
            assert!(!is_sensitive_name(name), "{name} should not be sensitive");
        }
    }
}
