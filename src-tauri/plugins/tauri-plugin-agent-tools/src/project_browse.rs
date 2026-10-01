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
use ignore::Match;
use serde::Serialize;

/// One directory level per request: the tree loads lazily, so a huge repository
/// never has to be walked whole. The cap is a fuse against pathological
/// directories (a `node_modules` that slipped past the filters).
pub const MAX_LIST_ENTRIES: usize = 1000;

/// Files above this are not sent to the renderer at all; the viewer shows a
/// friendly oversized notice instead. 1 MiB of source is already far beyond
/// comfortable reading.
pub const MAX_READ_BYTES: u64 = 1024 * 1024;
/// How much of the head of an oversized file is returned for display.
pub const PREVIEW_BYTES: usize = 16 * 1024;

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
    /// The first [`PREVIEW_BYTES`] of an `oversized` text file, so the viewer
    /// has something to show. `None` otherwise (and when the head is binary).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
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
    if lower.starts_with("id_rsa")
        || lower.starts_with("id_ed25519")
        || lower.starts_with("id_ecdsa")
    {
        return true;
    }
    for ext in [
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".keystore",
        ".jks",
        ".asc",
        ".gpg",
        ".kdbx",
    ] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    false
}

/// A path as a person reads it in an error: canonicalized paths on Windows
/// carry the `\\?\` verbatim prefix, which is noise in the UI.
fn shown(path: &Path) -> String {
    crate::tools::proc::without_verbatim_prefix(&path.to_string_lossy())
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("project root {} is unreadable: {e}", shown(path)))?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a folder", shown(&canonical)));
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
        .map_err(|e| format!("{} is unreadable: {e}", shown(&joined)))?;
    if !canonical.starts_with(root_canon) {
        return Err(format!("path escapes the project root: {rel}"));
    }
    Ok(canonical)
}

/// Gitignore matchers for `dir`: one per `.gitignore` on the chain from the
/// project root down to `dir`, ordered deepest first.
///
/// Each file gets its own matcher rooted at *its own* directory, because that
/// is what a leading-slash pattern is relative to: `/build` in `src/.gitignore`
/// means `src/build`, never `<root>/build`. Merging every file into one matcher
/// rooted at the project root — the obvious shortcut — keeps unanchored
/// patterns (`*.log`) working while silently mis-resolving anchored ones, so
/// nested rules end up half-honoured in a way that is easy to miss.
///
/// Deepest first is git's precedence: the nearest `.gitignore` decides, so a
/// `!keep.md` beside a file overrides an `*.md` at the root. [`is_ignored`]
/// stops at the first matcher with an opinion.
///
/// `.gitignore` files strictly *below* `dir` are deliberately not read. They
/// cannot affect this listing: git never lets a directory's own `.gitignore`
/// ignore that directory, only its contents — and those contents are a
/// separate lazy request, which reads the file then.
///
/// Missing files are fine, and one whose patterns fail to compile is dropped
/// rather than failing the listing.
fn gitignore_chain(root_canon: &Path, dir: &Path) -> Vec<Gitignore> {
    let mut owners = vec![root_canon.to_path_buf()];
    if let Ok(rel) = dir.strip_prefix(root_canon) {
        let mut current = root_canon.to_path_buf();
        for component in rel.components() {
            current = current.join(component);
            owners.push(current.clone());
        }
    }
    let mut chain = Vec::new();
    for owner in owners.into_iter().rev() {
        let file = owner.join(".gitignore");
        if !file.is_file() {
            continue;
        }
        let mut builder = GitignoreBuilder::new(&owner);
        let _ = builder.add(&file);
        if let Ok(matcher) = builder.build() {
            if !matcher.is_empty() {
                chain.push(matcher);
            }
        }
    }
    chain
}

/// Is `path` ignored by `chain`? The nearest `.gitignore` with an opinion wins.
///
/// Each matcher also answers for the path's parents *within its own root*, so a
/// rule that ignores a directory keeps ignoring everything under it.
fn is_ignored(chain: &[Gitignore], path: &Path, is_dir: bool) -> bool {
    for matcher in chain {
        match matcher.matched_path_or_any_parents(path, is_dir) {
            Match::Ignore(_) => return true,
            Match::Whitelist(_) => return false,
            Match::None => {}
        }
    }
    false
}

/// Marker prefix on an error the OS refused for permissions.
///
/// The panel shows a "no permission to read this" state rather than the raw
/// OS text, which differs per platform and reads as a crash. Same shape as
/// the `SENSITIVE:` marker, so the renderer has one convention to follow.
pub const DENIED_PREFIX: &str = "DENIED: ";

/// Tag a filesystem error so the caller can tell "you may not" from "it broke".
fn denial_aware(rel: &str, error: std::io::Error, verb: &str) -> String {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return format!("{DENIED_PREFIX}{rel}");
    }
    format!("cannot {verb} {rel}: {error}")
}

/// List one directory level of an attached project, lazily and filtered.
pub fn list_dir(root: &str, rel: &str) -> Result<ProjectListing, String> {
    let root_canon = canonical_root(root)?;
    let dir = resolve_rel(&root_canon, rel)?;
    if !dir.is_dir() {
        return Err(format!("{rel} is not a directory"));
    }
    let ignores = gitignore_chain(&root_canon, &dir);

    let mut entries: Vec<ProjectEntry> = Vec::new();
    let mut truncated = false;
    let read = std::fs::read_dir(&dir).map_err(|e| denial_aware(rel, e, "list"))?;
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
        // Filtered on what the entry actually *is*, not what it is called. A
        // symlink named `docs` pointing at `.git` stays inside the root, so
        // containment admits it; testing the link's own name would then list
        // the whole of `.git` — the very content this filter exists to hide.
        // Both the link name and the target name are checked, so neither
        // spelling gets through.
        let resolved_name = resolved
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if is_dir
            && (IGNORED_DIRS.contains(&name.as_str())
                || IGNORED_DIRS.contains(&resolved_name.as_str()))
        {
            continue;
        }
        if is_ignored(&ignores, &path, is_dir) || is_ignored(&ignores, &resolved, is_dir) {
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
        .map_err(|e| denial_aware(rel, e, "stat"))?
        .len();
    if size > MAX_READ_BYTES {
        return Ok(ProjectFile {
            rel_path: rel.replace('\\', "/"),
            size,
            content: String::new(),
            oversized: true,
            preview: read_head(&file),
            binary: false,
        });
    }
    let bytes = std::fs::read(&file).map_err(|e| denial_aware(rel, e, "read"))?;
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return Ok(ProjectFile {
            rel_path: rel.replace('\\', "/"),
            size,
            content: String::new(),
            oversized: false,
            binary: true,
            preview: None,
        });
    }
    Ok(ProjectFile {
        rel_path: rel.replace('\\', "/"),
        size,
        content: String::from_utf8_lossy(&bytes).into_owned(),
        oversized: false,
        binary: false,
        preview: None,
    })
}

/// The first [`PREVIEW_BYTES`] of `file` as lossy UTF-8, cut at a line break
/// when there is one. `None` if unreadable or the head looks binary. The path
/// is already contained by the caller.
fn read_head(file: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::with_capacity(PREVIEW_BYTES);
    std::fs::File::open(file)
        .ok()?
        .take(PREVIEW_BYTES as u64)
        .read_to_end(&mut buf)
        .ok()?;
    if buf[..buf.len().min(8192)].contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_error_has_no_verbatim_prefix() {
        let root = temp_project();
        let canon = canonical_root(root.to_str().unwrap()).unwrap();
        let err = resolve_rel(&canon, "CLAUDE.md").unwrap_err();
        assert!(!err.contains(r"\\?\"), "{err}");
        assert!(err.contains("CLAUDE.md"), "{err}");
    }

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

    /// Names of the entries `list_dir` returns for `rel`, in listing order.
    fn names_in(root: &Path, rel: &str) -> Vec<String> {
        list_dir(root.to_str().unwrap(), rel)
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.name)
            .collect()
    }

    #[test]
    fn honours_anchored_patterns_in_a_nested_gitignore() {
        // A leading slash is relative to the .gitignore's own directory, so
        // `/local.rs` in src/.gitignore hides src/local.rs and says nothing
        // about the identically named file at the root. Building one matcher
        // rooted at the project root instead resolved it against the root and
        // hid neither.
        let root = temp_project();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/.gitignore"), "/local.rs\n*.tmp\n").unwrap();
        std::fs::write(root.join("src/local.rs"), "x").unwrap();
        std::fs::write(root.join("src/keep.rs"), "x").unwrap();
        std::fs::write(root.join("src/scratch.tmp"), "x").unwrap();
        std::fs::write(root.join("local.rs"), "x").unwrap();

        let src = names_in(&root, "src");
        assert!(!src.contains(&"local.rs".to_string()), "{src:?}");
        // The unanchored pattern worked even before, and must keep working.
        assert!(!src.contains(&"scratch.tmp".to_string()), "{src:?}");
        assert!(src.contains(&"keep.rs".to_string()), "{src:?}");

        // …and the rule stays inside src/: the root's own local.rs is listed.
        let top = names_in(&root, "");
        assert!(top.contains(&"local.rs".to_string()), "{top:?}");
    }

    #[test]
    fn a_nested_rule_overrides_a_broader_one_at_the_root() {
        // Git resolves the nearest .gitignore last, so a whitelist beside the
        // file wins over a sweeping rule above it.
        let root = temp_project();
        std::fs::create_dir(root.join("docs")).unwrap();
        std::fs::write(root.join(".gitignore"), "*.md\n").unwrap();
        std::fs::write(root.join("docs/.gitignore"), "!README.md\n").unwrap();
        std::fs::write(root.join("docs/README.md"), "x").unwrap();
        std::fs::write(root.join("docs/notes.md"), "x").unwrap();

        let docs = names_in(&root, "docs");
        assert!(docs.contains(&"README.md".to_string()), "{docs:?}");
        assert!(!docs.contains(&"notes.md".to_string()), "{docs:?}");
    }

    #[test]
    fn a_rule_ignoring_a_directory_also_hides_what_is_under_it() {
        let root = temp_project();
        std::fs::create_dir_all(root.join("generated/inner")).unwrap();
        std::fs::write(root.join(".gitignore"), "generated/\n").unwrap();
        std::fs::write(root.join("generated/inner/thing.rs"), "x").unwrap();

        assert!(!names_in(&root, "").contains(&"generated".to_string()));
        // Reached directly, the root rule still applies to the contents.
        assert!(names_in(&root, "generated/inner").is_empty());
    }

    #[test]
    fn a_gitignore_below_the_listed_directory_is_not_consulted() {
        // Pins the documented boundary of `gitignore_chain`. This is git's own
        // behaviour, not a shortcut: a directory's .gitignore governs its
        // contents, never the directory itself, so `pkg` is listed however
        // sweeping `pkg/.gitignore` is — and that file is read when `pkg` is
        // itself listed, which is the request that it applies to.
        let root = temp_project();
        std::fs::create_dir(root.join("pkg")).unwrap();
        std::fs::write(root.join("pkg/.gitignore"), "*\n").unwrap();
        std::fs::write(root.join("pkg/hidden.rs"), "x").unwrap();

        assert!(names_in(&root, "").contains(&"pkg".to_string()));
        assert!(!names_in(&root, "pkg").contains(&"hidden.rs".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_permission_denial_distinctly() {
        // The panel needs "you may not read this" apart from "it broke": the
        // raw OS text differs per platform and reads to a user like a crash.
        use std::os::unix::fs::PermissionsExt;
        let root = temp_project();
        let locked = root.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("inside.txt"), "x").unwrap();
        let secret = root.join("secret.txt");
        std::fs::write(&secret, "x").unwrap();

        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();

        let dir_err = list_dir(root.to_str().unwrap(), "locked").unwrap_err();
        let file_err = read_file(root.to_str().unwrap(), "secret.txt", false).unwrap_err();

        // Restore before asserting, so a failure cannot leave the tree unremovable.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(dir_err.starts_with(DENIED_PREFIX), "{dir_err}");
        assert!(file_err.starts_with(DENIED_PREFIX), "{file_err}");
        // The refused path is named, and no OS text leaks through.
        assert!(dir_err.contains("locked"), "{dir_err}");
    }

    #[test]
    fn an_ordinary_failure_is_not_reported_as_a_denial() {
        let root = temp_project();
        let err = list_dir(root.to_str().unwrap(), "nope").unwrap_err();
        assert!(!err.starts_with(DENIED_PREFIX), "{err}");
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
        assert_eq!(over.preview.as_deref().map(str::len), Some(PREVIEW_BYTES));
        assert!(bin.preview.is_none());
    }

    #[test]
    fn sensitive_names() {
        for name in [
            ".env",
            ".env.local",
            "id_rsa",
            "server.pem",
            "app.key",
            ".npmrc",
        ] {
            assert!(is_sensitive_name(name), "{name} should be sensitive");
        }
        for name in ["main.rs", "env.ts", "keyboard.tsx", "monkey.md"] {
            assert!(!is_sensitive_name(name), "{name} should not be sensitive");
        }
    }
}

#[cfg(all(test, unix))]
mod symlink_laundering_tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jan-pb-symlink-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A symlink cannot launder a filtered directory into the tree. Git stores
    /// symlinks in trees, so `docs -> .git` is a thing a real repository can
    /// contain; resolving it lands back inside the root, so containment admits
    /// it, and only the name test stands between it and the whole `.git` tree.
    #[test]
    fn a_symlink_to_an_ignored_directory_is_not_listed() {
        let root = temp_root("git");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("config"), "secret").unwrap();
        std::os::unix::fs::symlink(root.join(".git"), root.join("docs")).unwrap();

        let listing = list_dir(root.to_str().unwrap(), "").unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(
            !names.contains(&"docs"),
            "a link to .git must not be listed: {names:?}"
        );
        assert!(!names.contains(&".git"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same for a directory the project's own .gitignore excludes.
    #[test]
    fn a_symlink_to_a_gitignored_directory_is_not_listed() {
        let root = temp_root("ignored");
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::os::unix::fs::symlink(root.join("build"), root.join("public")).unwrap();

        let listing = list_dir(root.to_str().unwrap(), "").unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(
            !names.contains(&"public"),
            "a link to an ignored dir must not be listed: {names:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An ordinary in-root symlink still works: the filter is about what the
    /// target *is*, not about symlinks being suspicious.
    #[test]
    fn an_ordinary_symlink_inside_the_root_is_still_listed() {
        let root = temp_root("ok");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::os::unix::fs::symlink(root.join("src"), root.join("lib")).unwrap();

        let listing = list_dir(root.to_str().unwrap(), "").unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"lib"), "expected lib in {names:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
