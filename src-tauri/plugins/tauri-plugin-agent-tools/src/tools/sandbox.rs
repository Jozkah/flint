use std::path::{Path, PathBuf};

/// True iff `raw` resolves to a path outside `project_root` and outside the
/// session scratch. Relative paths are resolved against `project_root`.
/// Canonicalizes (resolving `..` and symlinks) so string tricks and symlink
/// escapes are caught. For a not-yet-existing leaf (new-file writes), the
/// deepest existing ancestor is canonicalized and the remaining tail re-joined.
pub fn escapes_project(
    project_root: &Path,
    scratch: Option<&Path>,
    raw: &str,
) -> Result<bool, String> {
    // Absolute `/tmp` paths map into the session scratch (see [`resolve_path`]),
    // which is the agent's own area -- but only once the mapped path is checked
    // against it. Clamping `..` happens lexically, so a symlink planted in the
    // scratch (the shell can make one: `/tmp` is the scratch bind) would
    // otherwise resolve straight back out to the host. Canonicalize what the
    // clamp produced and require it to still be inside.
    if cfg!(target_os = "linux") {
        if let Some(scratch) = scratch {
            if tmp_relative(raw).is_some() {
                let scratch_root = scratch
                    .canonicalize()
                    .map_err(|e| format!("scratch root {:?}: {e}", scratch))?;
                let resolved =
                    canonicalize_lenient(&resolve_path(project_root, Some(scratch), raw))?;
                return Ok(!resolved.starts_with(&scratch_root));
            }
        }
    }
    let root = project_root
        .canonicalize()
        .map_err(|e| format!("project root {:?}: {e}", project_root))?;
    let abs = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };
    let resolved = canonicalize_lenient(&abs)?;
    if resolved.starts_with(&root) {
        return Ok(false);
    }
    // The scratch is the agent's own per-session area and is writable under
    // every backend, so a path landing in it is not a host escape even though it
    // sits outside the project. On Linux it is normally reached through the
    // `/tmp` branch above; macOS and Windows have no bind mount, so the shell
    // and the filesystem tools both address it by this real path. A scratch that
    // cannot be canonicalized grants nothing: the path stays an escape.
    if let Some(scratch) = scratch {
        if let Ok(scratch) = scratch.canonicalize() {
            return Ok(!resolved.starts_with(&scratch));
        }
    }
    Ok(true)
}

/// True iff `raw` escapes every root a *read* may legitimately reach: the
/// project, the scratch, or any attached read-only root.
///
/// Layered on [`escapes_project`] rather than replacing it, so the write path
/// keeps the exact check it has today and a read root can only ever widen what
/// reads reach, never what writes do.
///
/// A read root that cannot be canonicalized grants nothing — same rule as the
/// scratch above. A vanished root must not silently open a path up.
pub fn escapes_read_roots(
    project_root: &Path,
    scratch: Option<&Path>,
    read_roots: &[PathBuf],
    raw: &str,
) -> Result<bool, String> {
    if !escapes_project(project_root, scratch, raw)? {
        return Ok(false);
    }
    if read_roots.is_empty() {
        return Ok(true);
    }
    let abs = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        // Relative paths belong to the workspace, never to an attached folder:
        // resolving them against a read root would make `write` and `read`
        // disagree about what one path means.
        project_root.join(raw)
    };
    let resolved = canonicalize_lenient(&abs)?;
    for root in read_roots {
        if let Ok(root) = root.canonicalize() {
            if resolved.starts_with(&root) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// True iff `raw` escapes every root a *write* may legitimately reach: the
/// workspace, the scratch, or a project root the user has explicitly authorized
/// for editing.
///
/// The mirror of [`escapes_read_roots`], and deliberately a separate list. A
/// folder attached for reading must never become writable because the two were
/// collapsed into one set — read access is granted by attaching a folder, while
/// write access is granted only by a confirmation naming that exact folder.
///
/// An authorized root that cannot be canonicalized grants nothing. A vanished
/// or replaced root must not silently widen what a write can reach.
pub fn escapes_write_roots(
    project_root: &Path,
    scratch: Option<&Path>,
    write_roots: &[PathBuf],
    raw: &str,
) -> Result<bool, String> {
    if !escapes_project(project_root, scratch, raw)? {
        return Ok(false);
    }
    if write_roots.is_empty() {
        return Ok(true);
    }
    let abs = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        // Relative paths belong to the workspace, exactly as they do for reads.
        // Resolving them against an authorized root instead would silently move
        // where every unqualified write lands.
        project_root.join(raw)
    };
    let resolved = canonicalize_lenient(&abs)?;
    for root in write_roots {
        if let Ok(root) = root.canonicalize() {
            // `starts_with` on a `Path` compares components, so an authorized
            // `/src/app` never covers `/src/app-backup`.
            if resolved.starts_with(&root) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Resolve a tool-supplied path to its on-disk location, forwarding an absolute
/// `/tmp/...` path into the session scratch when one is set (and only on Linux,
/// where the bash sandbox binds the scratch over `/tmp`). This keeps every
/// filesystem tool reading and writing the same `/tmp` the shell sees. With no
/// scratch, `/tmp` stays a plain host path.
///
/// The scratch is treated like a chroot: no `..` component may climb above the
/// scratch root, matching how the sandbox's `/tmp` mount behaves (it is a mount
/// point, so `..` above it stays inside `/tmp`).
pub fn resolve_path(project_root: &Path, scratch: Option<&Path>, raw: &str) -> PathBuf {
    if cfg!(target_os = "linux") {
        if let Some(rel) = tmp_relative(raw) {
            if let Some(scratch) = scratch {
                return clamp_scratch(scratch, &rel);
            }
        }
    }
    if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        project_root.join(raw)
    }
}

/// The spelling to hand a tool-facing path back to the model: the inverse of
/// [`resolve_path`]. On Linux a file inside the scratch is named `/tmp/...`, the
/// one name that works from both the filesystem tools (which remap it back) and
/// `bash` (where the scratch is mounted at `/tmp`); its host path would resolve
/// for the former and not exist for the latter. Where nothing is mounted over
/// `/tmp` (macOS, Windows) both surfaces use the real path, so that is the name.
/// Anything outside the scratch is shown as-is.
pub fn scratch_display_path(scratch: Option<&Path>, path: &Path) -> String {
    let target = lexical_normalize(path);
    if cfg!(target_os = "linux") {
        if let Some(rel) = scratch_tail(scratch, &target) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            return if rel.is_empty() {
                "/tmp".to_string()
            } else {
                format!("/tmp/{rel}")
            };
        }
    }
    target.to_string_lossy().into_owned()
}

/// True iff `path` lexically sits inside the session scratch. Lexical on
/// purpose: it names a path the tools are about to create as well as one that
/// already exists.
pub fn in_scratch(scratch: Option<&Path>, path: &Path) -> bool {
    scratch_tail(scratch, &lexical_normalize(path)).is_some()
}

/// The scratch-relative tail of an already-normalized `path`, or `None` when it
/// is not in the scratch. `Some("")` for the scratch root itself.
fn scratch_tail(scratch: Option<&Path>, path: &Path) -> Option<PathBuf> {
    let scratch = lexical_normalize(scratch?);
    path.strip_prefix(&scratch).ok().map(Path::to_path_buf)
}

/// Resolve `.`/`..` without touching the filesystem, so a path is comparable to
/// the project root even when the target does not exist yet. Purely lexical:
/// `canonicalize` would also follow symlinks and fail on missing files.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Join `rel` under `scratch`, clamping `..` so it can never climb above the
/// scratch root (chroot semantics). A leading `..` or `/tmp/..` therefore falls
/// back to the scratch root rather than escaping to the host temp.
fn clamp_scratch(scratch: &Path, rel: &str) -> PathBuf {
    let mut out = scratch.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            std::path::Component::ParentDir => {
                // Clamp: never pop past the scratch root.
                if out != scratch {
                    out.pop();
                }
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The `/tmp`-relative tail of an absolute `/tmp/...` path; `Some("")` for the
/// bare `/tmp` dir itself; `None` when `raw` is not such a path.
fn tmp_relative(raw: &str) -> Option<String> {
    // Tested with a leading slash rather than `Path::is_absolute`, which asks
    // the *host's* question: on Windows `/tmp` is not absolute (no drive
    // letter), so the check rejected every path this function exists to
    // recognise. The paths here are POSIX ones from inside a bubblewrap
    // namespace and are absolute by that grammar, whatever host is asking.
    if !raw.starts_with('/') {
        return None;
    }
    // Match only the exact `/tmp` dir or a genuine `/tmp/...` descendant: a
    // raw string prefix would treat `/tmpx` and `/tmp-archive` as inside /tmp.
    if raw == "/tmp" {
        return Some(String::new());
    }
    Some(raw.strip_prefix("/tmp/")?.to_string())
}

/// The agent's own state directory inside a project. Hidden wholesale rather
/// than per-subdirectory: it holds `agent.toml`, the skills/memory workspaces
/// (reachable only through the dedicated skill_*/memory_* tools), and the thread
/// store with the conversation's own transcripts. None of it is project source,
/// so a listing that shows it is noise at best and a self-referential read at
/// worst -- and anything added under it later is hidden by construction.
pub const JAN_DIR: &str = ".jan";

/// True iff `raw` resolves inside `<project_root>/.jan`. Hidden paths are not
/// merely denied: `ls`/`find`/`grep` omit them from their output, so the agent
/// never sees the directory exists. The project instructions file is
/// `<project_root>/JAN.md`, an ordinary project file, and is unaffected.
pub fn is_hidden_jan_path(project_root: &Path, raw: &str) -> bool {
    let Ok(root) = project_root.canonicalize() else {
        return false;
    };
    let abs = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };
    // A path that cannot be resolved (a link cycle planted under `.jan`) is
    // judged by where it is written, so it stays hidden rather than listed.
    let resolved = canonicalize_lenient(&abs).unwrap_or_else(|_| lexical_normalize(&abs));
    resolved.starts_with(root.join(JAN_DIR))
}

/// Whether a path names a repository's `.git` or anything under it: a
/// component spelled `.git` (any case, since Windows and macOS folders are
/// case-insensitive). Lexical and deliberately broad -- `x/.git/hooks/pre-commit`,
/// `.git\\config`, a worktree's `.git` file -- because the cost of a false
/// positive is a refused write, and the cost of a miss is a program git runs.
pub fn names_git_internals(raw: &str) -> bool {
    raw.split(['/', '\\'])
        .any(|c| c.trim_end_matches(['.', ' ']).eq_ignore_ascii_case(".git"))
}

/// [`names_git_internals`] for each token of a shell command, including the
/// text with quotes and backslash escapes removed (`.g''it`, `.g\it`). A bare
/// `git` word or a `repo.git` URL is not a `.git` path.
pub fn command_names_git_internals(command: &str) -> bool {
    let hits = |text: &str| {
        text.split(|c: char| c.is_whitespace() || ";|&><()\"'`=".contains(c))
            .filter(|t| !t.is_empty())
            .any(names_git_internals)
    };
    if hits(command) {
        return true;
    }
    let dequoted: String = command
        .chars()
        .filter(|c| !matches!(c, '\'' | '"'))
        .collect();
    hits(&dequoted) || hits(&dequoted.replace('\\', ""))
}

/// [`is_hidden_jan_path`] for the project and every granted write root.
///
/// A managed worktree or a repository the user lets the agent edit in place
/// carries the project's own `.jan/agent` (tool policy, hooks, skills). Hiding
/// only the session workspace's `.jan` left that one open to the file tools
/// and the shell alike (Jozkah/jan#124). A relative `raw` is resolved against
/// the project root, the way the file tools resolve it.
pub fn is_hidden_jan_path_in(project_root: &Path, write_roots: &[PathBuf], raw: &str) -> bool {
    if is_hidden_jan_path(project_root, raw) {
        return true;
    }
    if write_roots.is_empty() {
        return false;
    }
    let abs = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        project_root
            .canonicalize()
            .unwrap_or_else(|_| project_root.to_path_buf())
            .join(raw)
    };
    let abs = abs.to_string_lossy();
    write_roots.iter().any(|r| is_hidden_jan_path(r, &abs))
}

/// [`command_touches_hidden_jan_path`] for the project and every granted write
/// root. A relative token is judged against each of them: the shell may start
/// in a managed worktree, where `.jan/agent/agent.toml` means that worktree's.
pub fn command_touches_hidden_jan_path_in(
    project_root: &Path,
    write_roots: &[PathBuf],
    command: &str,
) -> bool {
    command_touches_hidden_jan_path(project_root, command)
        || write_roots
            .iter()
            .any(|r| command_touches_hidden_jan_path(r, command))
}

/// True iff a shell command references a hidden path.
///
/// Splits on whitespace and shell metacharacters and checks each token, so
/// `cat .jan/agent/agent.toml` and its redirected variants are caught. On the
/// unsandboxed CLI nothing masks `.jan`, so this scan is the only barrier
/// (Jozkah/jan#220) and must see what the shell will: it also checks the text
/// with quotes and backslashes removed (`.j''an`, `.j\an`), treats a glob that
/// would match `.jan` in the project root as naming it (`.ja?`, `.j*`,
/// `.[j]an`), and refuses a command that builds a name by substitution (`$`,
/// backticks) out of the pieces of one (`${d}an/agent`). It errs towards
/// refusing: a false positive costs a rephrased command, a miss costs hooks.
pub fn command_touches_hidden_jan_path(project_root: &Path, command: &str) -> bool {
    let names_jan = |text: &str| {
        text.split(|c: char| c.is_whitespace() || ";|&><()\"'`".contains(c))
            .filter(|t| !t.is_empty())
            .any(|t| is_hidden_jan_path(project_root, t) || glob_names_jan(project_root, t))
    };
    if names_jan(command) {
        return true;
    }
    let dequoted: String = command
        .chars()
        .filter(|c| !matches!(c, '\'' | '"' | '\\'))
        .collect();
    if names_jan(&dequoted) {
        return true;
    }
    let substitutes = command.contains('$') || command.contains('`');
    substitutes && (dequoted.contains(".j") || dequoted.contains("an/agent"))
}

/// Whether a token is a glob whose first component, relative to the project
/// root, the shell would expand to `.jan`. A leading dot must be written, as
/// in the shell's default, so `*` alone does not count.
fn glob_names_jan(project_root: &Path, token: &str) -> bool {
    let root = project_root.to_string_lossy().replace('\\', "/");
    let token = token.replace('\\', "/");
    let relative = token
        .strip_prefix(&format!("{}/", root.trim_end_matches('/')))
        .unwrap_or(&token);
    let relative = relative.trim_start_matches("./");
    let first = relative.split('/').next().unwrap_or("");
    if !first.contains(['*', '?', '[']) {
        return false;
    }
    let options = glob::MatchOptions {
        require_literal_leading_dot: true,
        ..glob::MatchOptions::new()
    };
    glob::Pattern::new(first).is_ok_and(|p| p.matches_with(JAN_DIR, options))
}

/// True when `target` *claims* to be inside a trusted root but resolves outside
/// every one of them: the fail-closed re-check a handler runs immediately
/// before its final open, closing the window between the gate's
/// decision-time canonicalization and the handler's use of the raw path.
///
/// Containment, not symlink-avoidance: a link that stays beneath a trusted root
/// is ordinary and must keep working (a yarn workspace's
/// `node_modules/<pkg> -> ../../pkg` is one, and refusing those would make the
/// tools useless in a monorepo). Only a link whose target leaves the roots is an
/// escape.
///
/// A target that is not even lexically under a root is left alone: it is an
/// escape the gate already put to the user, and re-deciding it here would
/// override their approval. An unresolvable path fails closed.
///
/// Still a re-check, not a guarantee: a swap landing between this call and the
/// open is not covered. That needs descriptor-relative no-follow opens
/// (`openat2` with `RESOLVE_BENEATH`, reparse-point handling on Windows).
pub fn symlink_escapes_root(project_root: &Path, scratch: Option<&Path>, target: &Path) -> bool {
    symlink_escapes_any_root(project_root, scratch, &[], target)
}

/// As [`symlink_escapes_root`], but also treating `read_roots` as trusted.
///
/// Passing the read roots is not optional once one is attached: a path inside
/// an attached folder is not lexically under the project or the scratch, so the
/// early return above would classify it as "already decided" and skip the check
/// entirely — leaving a link in the user's repo pointing at `~/.ssh` followed.
pub fn symlink_escapes_any_root(
    project_root: &Path,
    scratch: Option<&Path>,
    read_roots: &[PathBuf],
    target: &Path,
) -> bool {
    let mut roots = vec![project_root];
    if let Some(s) = scratch {
        roots.push(s);
    }
    for r in read_roots {
        roots.push(r.as_path());
    }
    let normalized = lexical_normalize(target);
    if !roots
        .iter()
        .any(|r| normalized.starts_with(lexical_normalize(r)))
    {
        return false;
    }
    let Ok(resolved) = canonicalize_lenient(&normalized) else {
        return true;
    };
    !roots
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .any(|r| resolved.starts_with(r))
}

/// How many symlinks one resolution may follow before it is taken to be a
/// cycle. Linux's own limit (`MAXSYMLINKS`) is 40.
const MAX_LINK_HOPS: usize = 40;

/// Where `path` leads, for a path that may not fully exist yet: the path a
/// create-or-open of it would really reach.
///
/// The deepest existing ancestor is canonicalized, and the rest is walked one
/// component at a time. A component that exists as a symlink -- including a
/// dangling one, whose target does not exist yet and which `canonicalize`
/// therefore cannot tell from a missing file (Jozkah/jan#192) -- is replaced by
/// its target, relative targets taken from the link's own directory, and
/// resolution starts over. Only components that do not exist at all are
/// appended lexically.
///
/// Fails closed: an error for no existing ancestor, a component that cannot be
/// inspected or read, or more than [`MAX_LINK_HOPS`] links (a cycle). Callers
/// treat an error as an escape.
///
/// This decides where a path points at the moment it is called; it cannot stop
/// a link from being planted or swapped afterwards. See the write handler's
/// `O_NOFOLLOW` open for the part of that window it closes.
pub(crate) fn canonicalize_lenient(path: &Path) -> Result<PathBuf, String> {
    let mut path = path.to_path_buf();
    for _ in 0..=MAX_LINK_HOPS {
        if let Ok(p) = path.canonicalize() {
            return Ok(p);
        }
        match resolve_once(&path)? {
            Resolution::Reached(p) => return Ok(p),
            Resolution::FollowLink(next) => path = next,
        }
    }
    Err(format!("too many levels of symbolic links in {:?}", path))
}

enum Resolution {
    /// Every component was checked and none is a symlink.
    Reached(PathBuf),
    /// The path with its first symlink replaced by the link's target.
    FollowLink(PathBuf),
}

fn resolve_once(path: &Path) -> Result<Resolution, String> {
    use std::path::Component;
    let components: Vec<Component> = path.components().collect();
    for split in (1..components.len()).rev() {
        let prefix: PathBuf = components[..split].iter().collect();
        let Ok(base) = prefix.canonicalize() else {
            continue;
        };
        let rest = &components[split..];
        let mut current = base;
        for (i, component) in rest.iter().enumerate() {
            match component {
                Component::CurDir => {}
                // `current` is canonical up to here, or names something that
                // does not exist, so stepping up lexically is exact.
                Component::ParentDir => {
                    current.pop();
                }
                Component::Normal(name) => {
                    let next = current.join(name);
                    match std::fs::symlink_metadata(&next) {
                        Ok(meta) if meta.file_type().is_symlink() => {
                            let target = std::fs::read_link(&next)
                                .map_err(|e| format!("cannot read link {:?}: {e}", next))?;
                            // `join` keeps an absolute target as it is and puts
                            // a relative one under the link's directory.
                            let mut followed = current.join(target);
                            for later in &rest[i + 1..] {
                                followed.push(later.as_os_str());
                            }
                            return Ok(Resolution::FollowLink(followed));
                        }
                        Ok(_) => current = next,
                        // Nothing there -- including under a file used as a
                        // directory, which Unix reports as `NotADirectory`. The
                        // open will fail with the real error; it is not an escape.
                        Err(e)
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                            ) =>
                        {
                            current = next
                        }
                        Err(e) => return Err(format!("cannot inspect {:?}: {e}", next)),
                    }
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(format!("unexpected root inside {:?}", path));
                }
            }
        }
        return Ok(Resolution::Reached(current));
    }
    Err(format!("no existing ancestor for {:?}", path))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R21: on Windows a path with a root but no drive names the root of the
    /// project's drive, not somewhere in the project. It escapes, for writes
    /// and reads alike, and resolves to where the file would really land.
    #[test]
    #[cfg(windows)]
    fn a_root_relative_path_is_not_inside_the_project() {
        let base = std::env::temp_dir().join(format!("jan-r21-{}", std::process::id()));
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        for raw in ["/jan-r21-outside.txt", "\\jan-r21-outside.txt", "/tmp/dbg.py"] {
            assert!(escapes_project(&project, None, raw).unwrap(), "{raw} was treated as inside the project");
            assert!(escapes_write_roots(&project, None, &[], raw).unwrap(), "{raw}: write");
            assert!(escapes_read_roots(&project, None, &[], raw).unwrap(), "{raw}: read");
            let landed = resolve_path(&project, None, raw);
            assert!(!landed.starts_with(&project), "{raw} resolved into the project: {landed:?}");
        }
        // Drive-relative (`C:foo`) is not a project path either.
        assert!(escapes_project(&project, None, "C:jan-r21-drive-relative.txt").unwrap());
        // Ordinary relative paths are still inside.
        assert!(!escapes_project(&project, None, "src/ok.txt").unwrap());
        assert!(!escapes_project(&project, None, "./src/ok.txt").unwrap());
        let _ = std::fs::remove_dir_all(&base);
    }
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("jan_sandbox_test_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).expect("create test root");
        dir
    }

    /// A test dir that is *not* under the host temp dir, so a Linux run does not
    /// silently route through the `/tmp` bind branch. Lives under the crate's
    /// `target/`, which is already build output.
    fn unique_root_outside_tmp() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("sandbox-tests")
            .join(format!("{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).expect("create test scratch");
        dir
    }

    #[test]
    fn in_project_file_does_not_escape() {
        let root = unique_root();
        std::fs::write(root.join("inner.txt"), b"x").unwrap();
        assert_eq!(escapes_project(&root, None, "inner.txt"), Ok(false));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nested_in_project_does_not_escape() {
        let root = unique_root();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/inner.txt"), b"x").unwrap();
        assert_eq!(escapes_project(&root, None, "sub/inner.txt"), Ok(false));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dotdot_escapes() {
        let root = unique_root();
        assert_eq!(escapes_project(&root, None, "../outside.txt"), Ok(true));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_outside_escapes() {
        let root = unique_root();
        let outside = std::env::temp_dir().join("definitely_outside_the_root.txt");
        assert_eq!(
            escapes_project(&root, None, outside.to_str().unwrap()),
            Ok(true)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_inside_does_not_escape() {
        let root = unique_root();
        std::fs::write(root.join("inner.txt"), b"x").unwrap();
        let inside = root.join("inner.txt");
        assert_eq!(
            escapes_project(&root, None, inside.to_str().unwrap()),
            Ok(false)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn new_file_in_project_dir_does_not_escape() {
        let root = unique_root();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        assert_eq!(escapes_project(&root, None, "sub/newfile.txt"), Ok(false));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_path_covers_the_whole_jan_dir() {
        let root = unique_root();
        std::fs::create_dir_all(root.join(".jan/agent/skills")).unwrap();
        std::fs::create_dir_all(root.join(".jan/agent/memory")).unwrap();
        std::fs::create_dir_all(root.join(".jan/agent/threads/t1")).unwrap();
        std::fs::write(root.join(".jan/agent/agent.toml"), b"x").unwrap();
        // Config, the agent dir listing, unknown config files.
        assert!(is_hidden_jan_path(&root, ".jan/agent/agent.toml"));
        assert!(is_hidden_jan_path(&root, "./.jan/agent/agent.toml"));
        assert!(is_hidden_jan_path(
            &root,
            root.join(".jan/agent/agent.toml").to_str().unwrap()
        ));
        assert!(is_hidden_jan_path(&root, ".jan/agent"));
        assert!(is_hidden_jan_path(&root, ".jan/agent/secrets.env"));
        // skills/ and memory/ are reachable only via the dedicated tools, so they
        // are hidden from the general filesystem tools too.
        assert!(is_hidden_jan_path(&root, ".jan/agent/skills/deploy.md"));
        assert!(is_hidden_jan_path(&root, ".jan/agent/memory/notes.md"));
        assert!(is_hidden_jan_path(&root, ".jan/agent/AGENT.md"));
        // The whole `.jan` dir is hidden, not just `agent/`: the thread store
        // holds the running conversation's own transcripts, and future state
        // added beside it is covered without another carve-out.
        assert!(is_hidden_jan_path(&root, ".jan"));
        assert!(is_hidden_jan_path(&root, ".jan/agent/threads/t1"));
        // Ordinary project files, including the instructions file, are untouched.
        assert!(!is_hidden_jan_path(&root, "JAN.md"));
        assert!(!is_hidden_jan_path(&root, "src/main.rs"));
        // A sibling whose name merely starts with `.jan` is not inside it.
        assert!(!is_hidden_jan_path(&root, ".janitor"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_write_roots_jan_is_hidden_too() {
        let base = std::env::temp_dir().join(format!("jan-hide-wr-{}", std::process::id()));
        let project = base.join("ws");
        let wt = base.join("wt");
        std::fs::create_dir_all(project.join(".jan")).unwrap();
        std::fs::create_dir_all(wt.join(".jan/agent")).unwrap();
        std::fs::create_dir_all(wt.join("src")).unwrap();
        let roots = vec![wt.clone()];
        let wt_policy = wt.join(".jan/agent/agent.toml");
        let wt_policy = wt_policy.to_string_lossy();

        // Only the project's own .jan without the write roots.
        assert!(!is_hidden_jan_path_in(&project, &[], &wt_policy));
        assert!(is_hidden_jan_path_in(&project, &roots, &wt_policy));
        assert!(is_hidden_jan_path_in(&project, &roots, &wt.join(".jan").to_string_lossy()));
        assert!(is_hidden_jan_path_in(&project, &roots, ".jan/agent"));
        assert!(!is_hidden_jan_path_in(&project, &roots, &wt.join("src").to_string_lossy()));
        assert!(!is_hidden_jan_path_in(&project, &roots, "src/main.rs"));

        // The shell starts in the worktree, so a relative spelling counts too.
        assert!(command_touches_hidden_jan_path_in(&project, &roots, &format!("cat {wt_policy}")));
        assert!(command_touches_hidden_jan_path_in(&project, &roots, "cat .jan/agent/hooks.toml"));
        assert!(command_touches_hidden_jan_path_in(
            &project,
            &roots,
            "echo x > .jan/agent/agent.toml"
        ));
        assert!(!command_touches_hidden_jan_path_in(&project, &roots, "cargo test"));
        assert!(!command_touches_hidden_jan_path(&project, &format!("cat {wt_policy}")));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn command_scan_flags_hidden_paths() {
        let root = unique_root();
        std::fs::create_dir_all(root.join(".jan/agent")).unwrap();
        std::fs::write(root.join(".jan/agent/agent.toml"), b"x").unwrap();
        assert!(command_touches_hidden_jan_path(
            &root,
            "cat .jan/agent/agent.toml"
        ));
        assert!(command_touches_hidden_jan_path(
            &root,
            "grep foo < .jan/agent/agent.toml"
        ));
        assert!(command_touches_hidden_jan_path(
            &root,
            "cat .jan/agent/AGENT.md"
        ));
        assert!(command_touches_hidden_jan_path(&root, "ls -la .jan"));
        assert!(!command_touches_hidden_jan_path(&root, "cat JAN.md"));
        assert!(!command_touches_hidden_jan_path(&root, "ls -la src"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Jozkah/jan#220: the shell unquotes, unescapes, expands globs and
    /// substitutes variables before it opens anything, so the scan must see
    /// through the same spellings -- on the unsandboxed CLI it is the only
    /// thing between the model and `.jan/agent/hooks.toml`.
    #[test]
    fn command_scan_sees_through_shell_spellings_of_jan() {
        let root = unique_root();
        std::fs::create_dir_all(root.join(".jan/agent")).unwrap();
        for command in [
            "mkdir -p .j''an/agent && printf x > .j''an/agent/hooks.toml",
            r#"echo x > ".j"an/agent/hooks.toml"#,
            r"echo x > .j\an/agent/hooks.toml",
            "cp evil.toml .ja?/agent/agent.toml",
            "cp evil.toml .j*/agent/agent.toml",
            "cp evil.toml .[j]an/agent/agent.toml",
            "cp evil.toml ./.ja?/agent/agent.toml",
            "d=.j; echo x > ${d}an/agent/hooks.toml",
            "echo x > $(printf .j)an/agent/hooks.toml",
            "echo x > `echo .ja`n/agent/hooks.toml",
        ] {
            assert!(command_touches_hidden_jan_path(&root, command), "{command}");
        }
        // Ordinary commands with the same characters stay usable.
        for command in [
            "ls src/*.rs",
            "echo $HOME",
            "grep -r 'jan' src",
            "cat JAN.md",
            "cp a.txt 'my file.txt'",
        ] {
            assert!(!command_touches_hidden_jan_path(&root, command), "{command}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A symlink planted in the scratch (the shell can create one: `/tmp` is
    /// the scratch bind) must not turn `/tmp/...` into a way out. Clamping `..`
    /// is not enough -- the link is a single component that resolves elsewhere.
    #[test]
    #[cfg(target_os = "linux")]
    fn tmp_symlink_cannot_escape_the_scratch() {
        let root = unique_root();
        let scratch = unique_root();
        let outside = unique_root();
        std::os::unix::fs::symlink(&outside, scratch.join("esc")).unwrap();
        assert_eq!(
            escapes_project(&root, Some(&scratch), "/tmp/esc/pwned.txt"),
            Ok(true),
            "a symlink out of the scratch is an escape"
        );
        // A genuine scratch path is still not an escape.
        assert_eq!(
            escapes_project(&root, Some(&scratch), "/tmp/ok.txt"),
            Ok(false)
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A scratch reached by its real path (no `/tmp` bind in front of it) is the
    /// agent's own area on every platform, so it must not read as an escape.
    /// The scratch here sits outside the host temp dir on purpose: on Linux a
    /// `/tmp`-prefixed path would be answered by the bind branch above instead,
    /// leaving the cross-platform branch untested on the one OS we can run.
    #[test]
    fn real_scratch_path_is_not_an_escape() {
        let root = unique_root();
        let scratch = unique_root_outside_tmp();
        let inside = scratch.join("notes.txt");
        assert_eq!(
            escapes_project(&root, Some(&scratch), inside.to_str().unwrap()),
            Ok(false),
            "a write into the session scratch is not a host escape"
        );
        assert_eq!(
            escapes_project(&root, Some(&scratch), scratch.to_str().unwrap()),
            Ok(false),
            "the scratch root itself is addressable"
        );
        // The allowance is the scratch, not its parent.
        let sibling = scratch.parent().unwrap().join("not_the_scratch.txt");
        assert_eq!(
            escapes_project(&root, Some(&scratch), sibling.to_str().unwrap()),
            Ok(true)
        );
        // And nothing changes for a caller with no scratch at all.
        assert_eq!(
            escapes_project(&root, None, inside.to_str().unwrap()),
            Ok(true)
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The real-path branch resolves symlinks for the same reason the `/tmp`
    /// branch does: the shell can plant one inside the scratch.
    #[cfg(unix)]
    #[test]
    fn real_scratch_path_symlink_cannot_escape() {
        let root = unique_root();
        let scratch = unique_root_outside_tmp();
        let outside = unique_root();
        std::os::unix::fs::symlink(&outside, scratch.join("esc")).unwrap();
        let via_link = scratch.join("esc").join("pwned.txt");
        assert_eq!(
            escapes_project(&root, Some(&scratch), via_link.to_str().unwrap()),
            Ok(true),
            "a symlink out of the scratch is an escape"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&scratch);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The name handed back to the model: the `/tmp` alias only where something
    /// is actually mounted there, the real path everywhere else.
    #[test]
    fn scratch_is_displayed_under_the_name_the_shell_can_use() {
        let scratch = PathBuf::from(if cfg!(windows) {
            r"C:\Temp\jan-agent-s1"
        } else {
            "/var/scratch/jan-agent-s1"
        });
        // A path outside the scratch, written in the host's own grammar. A
        // POSIX-looking string is not a path Windows can answer questions
        // about, and comparing one against a normalised result compares
        // separators rather than behaviour.
        let other = PathBuf::from(if cfg!(windows) {
            r"C:\elsewhere\out.txt"
        } else {
            "/elsewhere/out.txt"
        });
        let file = scratch.join("out.txt");
        assert!(in_scratch(Some(&scratch), &file));
        assert!(!in_scratch(Some(&scratch), &other));
        assert!(!in_scratch(None, &file));
        if cfg!(target_os = "linux") {
            assert_eq!(scratch_display_path(Some(&scratch), &file), "/tmp/out.txt");
            assert_eq!(scratch_display_path(Some(&scratch), &scratch), "/tmp");
        } else {
            assert_eq!(
                scratch_display_path(Some(&scratch), &file),
                file.to_string_lossy()
            );
        }
        // Outside the scratch the path is untouched either way.
        assert_eq!(
            scratch_display_path(Some(&scratch), &other),
            other.to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_caught() {
        let root = unique_root();
        let outside = unique_root();
        std::fs::write(outside.join("secret.txt"), b"x").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(escapes_project(&root, None, "link/secret.txt"), Ok(true));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The re-check flags only symlinks that *leave* the trusted roots. An
    /// in-root link (the shape every yarn workspace has) resolves back inside
    /// and must stay usable; a link out of the root is an escape; a path that
    /// was never under a root at all is the gate's business, not this check's.
    #[cfg(unix)]
    #[test]
    fn symlink_escape_recheck_allows_in_root_links() {
        let root = unique_root();
        let outside = unique_root();
        std::fs::create_dir_all(root.join("pkg")).unwrap();
        std::fs::write(root.join("pkg/index.js"), b"x").unwrap();
        std::fs::write(outside.join("secret.txt"), b"s").unwrap();

        let inward = root.join("linked");
        std::os::unix::fs::symlink(root.join("pkg"), &inward).unwrap();
        let outward = root.join("escape");
        std::os::unix::fs::symlink(&outside, &outward).unwrap();

        assert!(!symlink_escapes_root(&root, None, &inward.join("index.js")));
        assert!(symlink_escapes_root(
            &root,
            None,
            &outward.join("secret.txt")
        ));
        // A not-yet-existing leaf under a real directory is not an escape.
        assert!(!symlink_escapes_root(
            &root,
            None,
            &root.join("pkg/new.txt")
        ));
        // Outside both roots: the gate already decided, so this check abstains.
        assert!(!symlink_escapes_root(
            &root,
            None,
            &outside.join("secret.txt")
        ));
        // The scratch counts as a trusted root, so a link between the two is in.
        let scratch = unique_root();
        let cross = scratch.join("into-project");
        std::os::unix::fs::symlink(root.join("pkg"), &cross).unwrap();
        assert!(!symlink_escapes_root(
            &root,
            Some(&scratch),
            &cross.join("index.js")
        ));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// `/tmpx` and `/tmp-archive` are not descendants of `/tmp` and must not be
    /// silently redirected into the scratch.
    #[test]
    fn tmp_lookalikes_are_not_remapped() {
        assert_eq!(tmp_relative("/tmp"), Some(String::new()));
        assert_eq!(tmp_relative("/tmp/"), Some(String::new()));
        assert_eq!(tmp_relative("/tmp/a.txt"), Some("a.txt".to_string()));
        assert_eq!(tmp_relative("/tmpx"), None);
        assert_eq!(tmp_relative("/tmp-archive/a.txt"), None);
    }
    // ---- read-only attached roots -------------------------------------------

    #[test]
    fn a_path_in_a_read_root_is_not_a_read_escape() {
        let ws = unique_root_outside_tmp();
        let repo = unique_root_outside_tmp();
        std::fs::write(repo.join("main.rs"), b"fn main() {}").unwrap();
        let roots = vec![repo.clone()];
        let target = repo.join("main.rs").to_string_lossy().into_owned();

        // Without the root it is an escape; with it, a legitimate read.
        assert!(escapes_project(&ws, None, &target).unwrap());
        assert!(!escapes_read_roots(&ws, None, &roots, &target).unwrap());

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&repo);
    }

    // The whole point of the mount: reads widen, writes do not. `escapes_project`
    // is what the write path keeps using, so it must still call this an escape.
    #[test]
    fn a_write_into_a_read_root_is_still_an_escape() {
        let ws = unique_root_outside_tmp();
        let repo = unique_root_outside_tmp();
        let target = repo.join("new.txt").to_string_lossy().into_owned();
        assert!(escapes_project(&ws, None, &target).unwrap());
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_path_outside_every_root_is_still_an_escape() {
        let ws = unique_root_outside_tmp();
        let repo = unique_root_outside_tmp();
        let other = unique_root_outside_tmp();
        let roots = vec![repo.clone()];
        let target = other.join("secret").to_string_lossy().into_owned();
        assert!(escapes_read_roots(&ws, None, &roots, &target).unwrap());
        for d in [&ws, &repo, &other] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    // A read root that vanished must grant nothing, matching the scratch rule.
    #[test]
    fn a_missing_read_root_grants_nothing() {
        let ws = unique_root_outside_tmp();
        let gone = unique_root_outside_tmp();
        let target = gone.join("x").to_string_lossy().into_owned();
        std::fs::remove_dir_all(&gone).unwrap();
        let roots = vec![gone];
        assert!(escapes_read_roots(&ws, None, &roots, &target).unwrap());
        let _ = std::fs::remove_dir_all(&ws);
    }

    // Relative paths belong to the workspace. Resolving them against an attached
    // folder would make `read` and `write` disagree about what one path means.
    #[test]
    fn a_relative_path_still_resolves_against_the_workspace() {
        let ws = unique_root_outside_tmp();
        let repo = unique_root_outside_tmp();
        std::fs::write(repo.join("only-in-repo.txt"), b"x").unwrap();
        let roots = vec![repo.clone()];
        assert!(escapes_read_roots(&ws, None, &roots, "only-in-repo.txt").is_ok());
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&repo);
    }

    // The hole this mount opens if the read roots are not passed: a link inside
    // the attached folder is not lexically under the workspace, so the plain
    // check returns "already decided" and never looks at where it points.
    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_a_read_root_is_caught() {
        let ws = unique_root_outside_tmp();
        let repo = unique_root_outside_tmp();
        let secret_dir = unique_root_outside_tmp();
        let secret = secret_dir.join("id_rsa");
        std::fs::write(&secret, b"key").unwrap();
        let link = repo.join("innocent.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let roots = vec![repo.clone()];

        assert!(
            symlink_escapes_any_root(&ws, None, &roots, &link),
            "a link leaving the attached folder must be refused"
        );
        assert!(
            !symlink_escapes_root(&ws, None, &link),
            "and the plain check is exactly why the roots must be passed"
        );
        for d in [&ws, &repo, &secret_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    // A link that stays inside the attached folder is ordinary and must work --
    // every monorepo has them.
    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_a_read_root_is_allowed() {
        let repo = unique_root_outside_tmp();
        let ws = unique_root_outside_tmp();
        let real = repo.join("real.txt");
        std::fs::write(&real, b"x").unwrap();
        let link = repo.join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let roots = vec![repo.clone()];
        assert!(!symlink_escapes_any_root(&ws, None, &roots, &link));
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// A parent directory holding two checkouts, which is the shape of the
    /// reported failure: the user selected `obs-forwarder` and Jan read
    /// `note-py` sitting beside it.
    ///
    /// Built with real directories because this is the validator, not a
    /// helper: it canonicalizes, so a path that does not exist proves nothing.
    fn sibling_repos() -> (PathBuf, PathBuf, PathBuf) {
        let parent = unique_root_outside_tmp();
        let selected = parent.join("obs-forwarder");
        let sibling = parent.join("note-py");
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(selected.join("README.md"), b"selected").unwrap();
        std::fs::write(sibling.join("main.py"), b"sibling").unwrap();
        (parent, selected, sibling)
    }

    // The reported failure, pinned at the boundary that decides it.
    #[test]
    fn a_sibling_repository_is_a_read_escape() {
        let ws = unique_root_outside_tmp();
        let (parent, selected, sibling) = sibling_repos();
        let roots = vec![selected.clone()];
        let read =
            |raw: &Path| escapes_read_roots(&ws, None, &roots, &raw.to_string_lossy()).unwrap();

        // The sibling, addressed absolutely -- what the model would emit after
        // being told the wrong repository's name.
        assert!(read(&sibling.join("main.py")));
        // The parent, which is how a sibling would be discovered at all.
        assert!(read(&parent));
        // Climbing out of the selected root and back down into the sibling.
        assert!(read(&selected.join("../note-py/main.py")));
        // And the repository the user actually selected still reads.
        assert!(!read(&selected.join("README.md")));

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
    }

    // `starts_with` on a `Path` compares components, not characters. This is
    // the test that fails if anyone reimplements it as a string prefix.
    #[test]
    fn a_sibling_whose_name_extends_the_selected_root_is_still_an_escape() {
        let ws = unique_root_outside_tmp();
        let (parent, selected, _) = sibling_repos();
        let lookalike = parent.join("obs-forwarder-backup");
        std::fs::create_dir_all(&lookalike).unwrap();
        std::fs::write(lookalike.join("main.py"), b"not ours").unwrap();
        let roots = vec![selected.clone()];

        assert!(escapes_read_roots(
            &ws,
            None,
            &roots,
            &lookalike.join("main.py").to_string_lossy()
        )
        .unwrap());

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
    }

    /// Windows separators and case, on Windows only.
    ///
    /// The reported paths were `D:\Code\obs-forwarder` and `D:\Code\note-py`.
    /// On a Unix host a backslash is an ordinary filename character, so writing
    /// those literals here would assert nothing about separators — the test
    /// would pass for the wrong reason. Real temp directories are used instead,
    /// addressed with backslashes, and the case behaviour asserted is whatever
    /// `canonicalize` already gives on the platform.
    #[cfg(windows)]
    #[test]
    fn windows_sibling_is_an_escape_by_either_separator_or_case() {
        let ws = unique_root_outside_tmp();
        let (parent, selected, sibling) = sibling_repos();
        let roots = vec![selected.clone()];
        let read = |raw: String| escapes_read_roots(&ws, None, &roots, &raw).unwrap();

        let backslashed = sibling.join("main.py").to_string_lossy().replace('/', "\\");
        assert!(read(backslashed));
        // Windows paths are case-insensitive, so a differently-cased spelling of
        // the selected root is the same root -- not a way around it, and not a
        // way in either.
        assert!(!read(
            selected.join("README.md").to_string_lossy().to_uppercase()
        ));
        assert!(read(
            sibling.join("main.py").to_string_lossy().to_uppercase()
        ));

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
    }

    /// Writes authorized against one checkout, with a sibling beside it.
    ///
    /// The same shape as the read tests, asked of the write boundary: this is
    /// the door "Edit this folder" opens, so it is the one worth pushing on.
    #[test]
    fn an_authorized_write_root_reaches_only_itself() {
        let ws = unique_root_outside_tmp();
        let (parent, selected, sibling) = sibling_repos();
        let lookalike = parent.join("obs-forwarder-backup");
        std::fs::create_dir_all(&lookalike).unwrap();
        let roots = vec![selected.clone()];
        let writes =
            |raw: &Path| escapes_write_roots(&ws, None, &roots, &raw.to_string_lossy()).unwrap();

        // Inside the authorized checkout, including a file that does not exist
        // yet -- which is most writes.
        assert!(!writes(&selected.join("README.md")));
        assert!(!writes(&selected.join("src/new-file.rs")));

        // Everything around it stays shut.
        assert!(writes(&sibling.join("main.py")));
        assert!(writes(&parent.join("anything.txt")));
        assert!(writes(&selected.join("../note-py/main.py")));
        // Component matching, not string prefix: `obs-forwarder` must not
        // authorize `obs-forwarder-backup`.
        assert!(writes(&lookalike.join("main.py")));

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
    }

    // The two lists are separate for exactly this reason: attaching a folder
    // to read it must never be what makes it writable.
    #[test]
    fn a_read_root_does_not_authorize_writing_to_it() {
        let ws = unique_root_outside_tmp();
        let repo = unique_root_outside_tmp();
        std::fs::write(repo.join("main.rs"), b"fn main() {}").unwrap();
        let target = repo.join("main.rs").to_string_lossy().into_owned();
        let attached = vec![repo.clone()];

        // Readable, because it was attached.
        assert!(!escapes_read_roots(&ws, None, &attached, &target).unwrap());
        // Not writable, because nothing authorized writing to it.
        assert!(escapes_write_roots(&ws, None, &[], &target).unwrap());

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn no_authorized_root_keeps_writes_in_the_workspace() {
        let ws = unique_root_outside_tmp();
        let outside = unique_root_outside_tmp();

        assert!(!escapes_write_roots(&ws, None, &[], "inside.txt").unwrap());
        assert!(
            escapes_write_roots(&ws, None, &[], &outside.join("x.txt").to_string_lossy()).unwrap()
        );

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&outside);
    }

    // A relative path is the workspace's, always. Resolving it against an
    // authorized root would silently move where every unqualified write lands.
    #[test]
    fn a_relative_write_still_belongs_to_the_workspace() {
        let ws = unique_root_outside_tmp();
        let (parent, selected, _) = sibling_repos();
        let roots = vec![selected.clone()];

        assert!(!escapes_write_roots(&ws, None, &roots, "notes.txt").unwrap());

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
    }

    // A root that vanished grants nothing: an authorization must not widen
    // because the thing it named is no longer there to check.
    #[test]
    fn a_missing_authorized_root_grants_nothing() {
        let ws = unique_root_outside_tmp();
        let gone = unique_root_outside_tmp();
        let target = gone.join("x.txt").to_string_lossy().into_owned();
        let roots = vec![gone.clone()];
        let _ = std::fs::remove_dir_all(&gone);

        assert!(escapes_write_roots(&ws, None, &roots, &target).unwrap());

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_an_authorized_root_is_caught() {
        let ws = unique_root_outside_tmp();
        let (parent, selected, sibling) = sibling_repos();
        let link = selected.join("escape");
        std::os::unix::fs::symlink(&sibling, &link).unwrap();
        let roots = vec![selected.clone()];

        assert!(
            escapes_write_roots(&ws, None, &roots, &link.join("main.py").to_string_lossy())
                .unwrap()
        );

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
    }

    // -- dangling symlinks (Jozkah/jan#192) -----------------------------------
    //
    // A symlink whose target does not exist yet makes `canonicalize` fail just
    // as a missing file does, but opening it for writing creates the target.
    // Containment must follow the link, wherever it points.

    /// A symlink at `at` naming `target`, which need not exist. `None` where
    /// the platform refuses to make one (Windows without Developer Mode), so
    /// the test has nothing to check there rather than failing.
    fn link(target: &Path, at: &Path, dir: bool) -> Option<()> {
        #[cfg(unix)]
        let made = {
            let _ = dir;
            std::os::unix::fs::symlink(target, at)
        };
        #[cfg(windows)]
        let made = if dir {
            std::os::windows::fs::symlink_dir(target, at)
        } else {
            std::os::windows::fs::symlink_file(target, at)
        };
        match made {
            Ok(()) => Some(()),
            Err(e) => {
                eprintln!("skipped: cannot create a symlink here: {e}");
                None
            }
        }
    }

    fn all_escape(root: &Path, raw: &str) {
        assert_eq!(escapes_project(root, None, raw), Ok(true), "escapes_project {raw}");
        assert_eq!(
            escapes_write_roots(root, None, &[], raw),
            Ok(true),
            "escapes_write_roots {raw}"
        );
        assert!(symlink_escapes_root(root, None, &root.join(raw)), "symlink_escapes_root {raw}");
    }

    fn none_escape(root: &Path, raw: &str) {
        assert_eq!(escapes_project(root, None, raw), Ok(false), "escapes_project {raw}");
        assert_eq!(
            escapes_write_roots(root, None, &[], raw),
            Ok(false),
            "escapes_write_roots {raw}"
        );
        assert!(!symlink_escapes_root(root, None, &root.join(raw)), "symlink_escapes_root {raw}");
    }

    #[test]
    fn a_dangling_link_out_of_the_root_is_an_escape() {
        let root = unique_root();
        let outside = unique_root();
        if link(&outside.join("created.txt"), &root.join("dangling"), false).is_none() {
            return;
        }
        all_escape(&root, "dangling");
        assert!(!outside.join("created.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_relative_dangling_link_out_of_the_root_is_an_escape() {
        let root = unique_root();
        let outside = unique_root();
        let name = outside.file_name().unwrap().to_string_lossy().into_owned();
        let target = PathBuf::from("..").join(name).join("created.txt");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        // Relative to the link's own directory: `notes/../..` is the temp dir.
        if link(&PathBuf::from("..").join(&target), &root.join("notes").join("todo.md"), false)
            .is_none()
        {
            return;
        }
        all_escape(&root, "notes/todo.md");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_dangling_directory_link_in_the_middle_is_an_escape() {
        let root = unique_root();
        let outside = unique_root();
        if link(&outside.join("missing"), &root.join("d"), true).is_none() {
            return;
        }
        all_escape(&root, "d/new.txt");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_chain_of_links_ending_outside_is_an_escape() {
        let root = unique_root();
        let outside = unique_root();
        if link(&root.join("b"), &root.join("a"), false).is_none()
            || link(&outside.join("x.txt"), &root.join("b"), false).is_none()
        {
            return;
        }
        all_escape(&root, "a");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A cycle has no destination to judge, so it cannot be shown to stay in.
    #[test]
    fn a_link_cycle_fails_closed() {
        let root = unique_root();
        if link(&root.join("c2"), &root.join("c1"), false).is_none()
            || link(&root.join("c1"), &root.join("c2"), false).is_none()
        {
            return;
        }
        assert_ne!(escapes_project(&root, None, "c1"), Ok(false));
        assert_ne!(escapes_write_roots(&root, None, &[], "c1"), Ok(false));
        assert!(symlink_escapes_root(&root, None, &root.join("c1")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Following links must not cost legitimate in-root cases: a dangling link
    /// whose target stays inside, absolute or relative, and a plain new file.
    #[test]
    fn dangling_links_that_stay_inside_are_not_escapes() {
        let root = unique_root();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        if link(&root.join("sub").join("new.txt"), &root.join("abs"), false).is_none()
            || link(Path::new("sub/other.txt"), &root.join("rel"), false).is_none()
        {
            return;
        }
        none_escape(&root, "abs");
        none_escape(&root, "rel");
        none_escape(&root, "sub/plain-new.txt");
        none_escape(&root, "sub/deeper/still-new.txt");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A file used as a directory has nothing beneath it: not an escape, so
    /// the write fails with the real error instead of a containment refusal.
    #[test]
    fn a_path_under_a_file_is_not_an_escape() {
        let root = unique_root();
        std::fs::write(root.join("main.rs"), b"x").unwrap();
        none_escape(&root, "main.rs/x");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Unresolvable names under `.jan` stay hidden.
    #[test]
    fn a_link_cycle_under_jan_stays_hidden() {
        let root = unique_root();
        std::fs::create_dir_all(root.join(JAN_DIR)).unwrap();
        let (a, b) = (root.join(JAN_DIR).join("c1"), root.join(JAN_DIR).join("c2"));
        if link(&b, &a, false).is_none() || link(&a, &b, false).is_none() {
            return;
        }
        assert!(is_hidden_jan_path(&root, &format!("{JAN_DIR}/c1")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
