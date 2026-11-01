//! The file tools: read, ls, write, edit, find and grep, with the stale-edit
//! guard and the no-follow helpers they share.

use super::*;

pub(super) async fn read_or_list(
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> (String, Option<Vec<ImageContentPart>>) {
    if let Some(path) = arg_str(args, "path") {
        let target = resolve_path(ctx.project_root, ctx.scratch_root, path);
        if target.is_dir() {
            let listing = ls(
                args,
                ctx.project_root,
                ctx.scratch_root,
                ctx.sandbox,
                ctx.read_roots,
                ctx.write_roots,
            )
            .await;
            if listing.starts_with("ERROR:") {
                return (listing, None);
            }
            return (format!("{path} is a directory. Contents:\n{listing}"), None);
        }
    }
    let mut out = read(args, ctx.project_root, ctx.scratch_root, ctx.read_roots).await;
    if is_missing_path_error(&out.0) {
        out.0 = with_project_hint(out.0, ctx, args);
    }
    // A text file that opens with "ERROR" is still a successful read, but it is
    // indistinguishable here; the model re-reads in that rare case.
    if !out.0.starts_with("ERROR") {
        if let Some((path, _)) = record_seen(args, ctx).await {
            crate::shared_folder::tools::note_read(ctx, &path);
        }
    }
    out
}

/// Whether a file tool's error says the path does not exist.
pub(super) fn is_missing_path_error(out: &str) -> bool {
    if !out.starts_with("ERROR") {
        return false;
    }
    let lower = out.to_ascii_lowercase();
    lower.contains("not found")
        || lower.contains("os error 2)")
        || lower.contains("os error 3)")
        || lower.contains("cannot find the")
        || lower.contains("no such file")
}

/// The first place under `base` (itself, then its subfolders to a small depth)
/// where the relative `raw` names something that exists.
///
/// A repository often sits one level below the folder a session is rooted in
/// (`pokemon_scans/pokemon-card-app`), or a worktree the model made sits under
/// the worktree it was given, so `lib/db.ts` misses while `pokemon-card-app/lib/db.ts`
/// is right there. Bounded, and it skips the folders no project file lives in.
pub(super) fn find_relative_match(base: &Path, raw: &str) -> Option<PathBuf> {
    const MAX_DEPTH: usize = 3;
    const MAX_DIRS: usize = 400;
    let mut level = vec![base.to_path_buf()];
    let mut visited = 0usize;
    for depth in 0..=MAX_DEPTH {
        let mut next = Vec::new();
        for dir in &level {
            let candidate = dir.join(raw);
            if candidate.exists() {
                return Some(candidate);
            }
            if depth == MAX_DEPTH {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | ".next" | "dist") {
                    continue;
                }
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    visited += 1;
                    if visited > MAX_DIRS {
                        return None;
                    }
                    next.push(entry.path());
                }
            }
        }
        level = next;
    }
    None
}

/// Where a model that used a project-relative path should have looked.
///
/// Relative paths resolve against the sandbox workspace, which on the desktop
/// is scratch space inside Flint's data folder (or, in a managed worktree, the
/// worktree root). A model reading `lib/db.ts` in an attached project missed,
/// was told only that relative paths resolve in that workspace, concluded the
/// workspace was a symlink, and asked `request_access` for it (refused: it
/// overlaps the data folder). The hint names the real file when one matches,
/// and otherwise the attached folder.
pub(super) fn project_path_hint(ctx: &ToolContext<'_>, args: &serde_json::Value) -> Option<String> {
    let raw = arg_str(args, "path")?;
    if Path::new(raw).is_absolute() {
        return rebased_path_hint(ctx, raw);
    }
    let root = ctx.project_root;
    let scratch = ctx.scratch_root;
    let folders: Vec<&PathBuf> = ctx
        .write_roots
        .iter()
        .chain(ctx.read_roots.iter())
        .filter(|f| f.as_path() != root && Some(f.as_path()) != scratch)
        .collect();
    let found = folders
        .iter()
        .filter_map(|f| find_relative_match(f, raw))
        .chain(find_relative_match(root, raw))
        .next();
    if let Some(found) = found {
        return Some(format!(
            "A file with that relative path exists at {}. Use this absolute path.",
            crate::tools::sandbox::plain_display(&found)
        ));
    }
    let first = folders.first()?;
    Some(format!(
        "Your workspace is scratch space, not the project. The attached project folder is {}; \
         use absolute paths for files in it (a relative path never resolves there).",
        crate::tools::sandbox::plain_display(first)
    ))
}

/// A session that works in a worktree rebases a relative path onto it before
/// the tool runs, so `lib/db.ts` arrives as `<worktree>/lib/db.ts`, echoed back
/// in the error as a long `\\\\?\\` path the model never typed. When the app sits
/// one folder below the worktree root, the file is at
/// `<worktree>/pokemon-card-app/lib/db.ts`; say so.
pub(super) fn rebased_path_hint(ctx: &ToolContext<'_>, raw: &str) -> Option<String> {
    use crate::tools::sandbox::plain;
    let wanted = plain(Path::new(raw));
    let bases = ctx
        .write_roots
        .iter()
        .chain(ctx.read_roots.iter())
        .map(PathBuf::as_path)
        .chain(std::iter::once(ctx.project_root));
    for base in bases {
        let base = plain(base);
        let Ok(rest) = wanted.strip_prefix(&base) else { continue };
        if rest.as_os_str().is_empty() || base.join(rest).exists() {
            continue;
        }
        if let Some(found) = find_relative_match(&base, &rest.to_string_lossy()) {
            return Some(format!(
                "That file is not at the top of {}, but exists at {}. Use this absolute path.",
                base.display(),
                plain(&found).display()
            ));
        }
    }
    None
}

/// `out` with the project-path hint appended when a relative path missed.
pub(super) fn with_project_hint(out: String, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
    if !is_missing_path_error(&out) {
        return out;
    }
    match project_path_hint(ctx, args) {
        Some(hint) => format!("{out} {hint}"),
        None => out,
    }
}

pub(super) async fn read(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    read_roots: &[PathBuf],
) -> (String, Option<Vec<ImageContentPart>>) {
    let Some(path) = arg_str(args, "path") else {
        return ("ERROR: missing required argument 'path'".to_string(), None);
    };
    let offset = arg_u64(args, "offset").map(|v| v as usize);
    let limit = arg_u64(args, "limit").map(|v| v as usize);
    let allow_large = arg_bool(args, "allow_large");
    let target = resolve_path(root, scratch, path);
    // Fail closed: a component swapped to a symlink after the gate validated
    // the path must not redirect the open out of the workspace.
    if symlink_escapes_any_root(root, scratch, read_roots, &target) {
        return (
            format!(
                "ERROR: refused to read through a symlink out of the workspace: {path}{}",
                resolved_target(&target)
            ),
            None,
        );
    }
    // Windows reports a directory opened as a file as "Access is denied.
    // (os error 5)", which reads as a permission problem.
    if target.is_dir() {
        return (format!("ERROR: {path} is a directory; use ls."), None);
    }

    // Looked at before it is read (Jozkah/jan#250): a multi-GB file would be
    // allocated whole just to be cut to 64 KB, and a FIFO would block the read
    // forever.
    // A missing file is said plainly, with where relative paths resolve --
    // the raw "os error 2" sent the model hunting through other directories.
    if !target.exists() {
        return (
            format!(
                "ERROR: File not found: {path}. Relative paths resolve against your \
                 workspace ({}).",
                root.display()
            ),
            None,
        );
    }
    if let Err(e) = readable_file_with(&target, allow_large).await {
        return (format!("ERROR: {path}: {e}"), None);
    }
    let bytes = match tokio::fs::read(&target).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (
                format!(
                    "ERROR: File not found: {path}. Relative paths resolve against your \
                     workspace ({}).",
                    root.display()
                ),
                None,
            )
        }
        Err(e) => return (format!("ERROR: {e}"), None),
    };
    let total_bytes = bytes.len();

    // An image file is returned as an OpenAI `image_url` content part rather
    // than text: the model cannot see a raster through a base64 string. Only a
    // plain read (no offset/limit) does this, since slicing an image makes no
    // sense and offset/limit still refers to text lines.
    if offset.is_none() && limit.is_none() && bytes.len() <= MAX_IMAGE_BYTES {
        if let Some(mime) = crate::tools::image::detect_bytes(&target, &bytes) {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let name = target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();
            let note = format!("Read image {name} ({mime}, {} bytes)", bytes.len());
            let image = ImageContentPart {
                data_url: format!("data:{mime};base64,{b64}"),
                name,
            };
            return (note, Some(vec![image]));
        }
    }
    if offset.is_none() && limit.is_none() && bytes.len() > MAX_IMAGE_BYTES {
        if let Some(mime) = crate::tools::image::detect_bytes(&target, &bytes) {
            return (
                format!(
                    "ERROR: {path} is a {mime} image of {total_bytes} bytes, over the {} KB limit for \
                     images sent to the model. Ask the user for a smaller copy.",
                    MAX_IMAGE_BYTES / 1024
                ),
                None,
            );
        }
    }

    let content = match String::from_utf8(bytes) {
        Ok(c) => c,
        Err(_) => {
            return (
                format!("ERROR: Binary file ({total_bytes} bytes); read only returns text."),
                None,
            )
        }
    };

    let selected = if offset.is_some() || limit.is_some() {
        let lines: Vec<&str> = content.split('\n').collect();
        let start = offset.map(|o| o.saturating_sub(1)).unwrap_or(0);
        if start >= lines.len() {
            return (
                format!(
                    "ERROR: offset {} is beyond end of file ({} lines total)",
                    offset.unwrap_or(1),
                    lines.len()
                ),
                None,
            );
        }
        let end = match limit {
            Some(l) => (start + l).min(lines.len()),
            None => lines.len(),
        };
        lines[start..end].join("\n")
    } else {
        content
    };

    let out = cap_output(
        &selected,
        MAX_LINES,
        MAX_BYTES,
        "\n[truncated: use offset/limit to read more]",
    );
    // File text that happens to start with "ERROR" reads like a handler
    // failure to `classify_tool`; say that this one succeeded (Jozkah/jan#62).
    if out.trim_start().starts_with("ERROR") {
        let _ = READ_SUCCESS.try_with(|slot| *slot.borrow_mut() = Some(out.clone()));
    }
    (out, None)
}

tokio::task_local! {
    /// The text a successful `read` returned, when it starts with "ERROR" and
    /// so could be mistaken for a failure. Set only inside
    /// [`with_read_success`].
    static READ_SUCCESS: std::cell::RefCell<Option<String>>;
}

/// Run `work` (a tool call) and also return the output of any `read` in it
/// that succeeded with text starting with "ERROR". Content that starts with
/// that text is file content, not a handler error, and the caller must not
/// classify it as a failure (Jozkah/jan#62).
pub async fn with_read_success<F: std::future::Future>(work: F) -> (F::Output, Option<String>) {
    READ_SUCCESS
        .scope(std::cell::RefCell::new(None), async {
            let out = work.await;
            let success = READ_SUCCESS.with(|slot| slot.borrow_mut().take());
            (out, success)
        })
        .await
}

/// What each session last saw of each file: a SHA-256 of its bytes, recorded
/// when `read` succeeds and when `write`/`edit` lands. `write` over an existing
/// file and `edit` consult it, so a change made behind the model's back (the
/// user, a formatter, another process) is not silently overwritten by a stale
/// copy of the file the model is still holding.
///
/// Keyed by session (falling back to the run) and then by the resolved path.
/// A call with neither id is not tracked and not checked: nothing could tell
/// one caller's reads from another's. Bounded per session; hitting the bound
/// forgets that session's records, which only asks the model to read again.
pub(super) const MAX_TRACKED_FILES: usize = 4096;

pub(super) type ReadHashes = Mutex<HashMap<String, HashMap<PathBuf, [u8; 32]>>>;

pub(super) fn read_hashes() -> &'static ReadHashes {
    static HASHES: OnceLock<ReadHashes> = OnceLock::new();
    HASHES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The SHA-256 of the file at `path`, read in chunks so a large file is
/// never held in memory whole (P2B-018).
pub(super) async fn file_hash(path: &Path) -> Option<[u8; 32]> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut file = std::fs::File::open(&path).ok()?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).ok()?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Some(hasher.finalize().into())
    })
    .await
    .ok()
    .flatten()
}

pub(super) fn stale_key(ctx: &ToolContext<'_>) -> Option<String> {
    ctx.session_id.or(ctx.run_id).map(str::to_string)
}

/// The path a call's `path` argument lands on, as the handlers open it.
pub(super) fn tracked_path(args: &serde_json::Value, ctx: &ToolContext<'_>) -> Option<PathBuf> {
    let path = arg_str(args, "path")?;
    resolved_for_open(&resolve_path(ctx.project_root, ctx.scratch_root, path)).ok()
}

/// Remember the bytes now on disk at the call's path as what this session has
/// seen. A file that cannot be read is forgotten instead.
pub(super) async fn record_seen(
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Option<(PathBuf, [u8; 32])> {
    let (Some(key), Some(path)) = (stale_key(ctx), tracked_path(args, ctx)) else {
        return None;
    };
    let hash = file_hash(&path).await;
    let mut all = read_hashes().lock().unwrap_or_else(|e| e.into_inner());
    let seen = all.entry(key).or_default();
    match hash {
        Some(h) => {
            if seen.len() >= MAX_TRACKED_FILES && !seen.contains_key(&path) {
                seen.clear();
            }
            seen.insert(path.clone(), h);
            Some((path, h))
        }
        None => {
            seen.remove(&path);
            None
        }
    }
}

/// An error when `write` (over an existing file) or `edit` would act on a file
/// this session has not read, or that changed since it did. `None` when the
/// call may go ahead: a file that does not exist yet, an untracked caller, or a
/// file still byte-identical to what was last read or written.
pub(super) async fn stale_edit_refusal(
    verb: &str,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Option<String> {
    let key = stale_key(ctx)?;
    let path = tracked_path(args, ctx)?;
    let now = file_hash(&path).await?;
    let shown = arg_str(args, "path").unwrap_or_default();
    let seen = read_hashes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .and_then(|files| files.get(&path).copied());
    match seen {
        Some(h) if h == now => None,
        Some(_) => Some(format!(
            "ERROR: {shown}: file has been modified since it was read. Read it again, then {verb} it."
        )),
        None => Some(format!(
            "ERROR: {shown}: this file exists but has not been read in this session. Read it first, then {verb} it."
        )),
    }
}

/// " (it resolves to X)" for a symlink refusal, so the model can see where the
/// link leads instead of guessing. Empty when the target cannot be resolved.
pub(super) fn resolved_target(target: &Path) -> String {
    match std::fs::canonicalize(target) {
        Ok(real) => {
            let shown = real.to_string_lossy();
            let shown = shown.strip_prefix(r"\\?\").unwrap_or(&shown).to_string();
            format!(" (it resolves to {shown})")
        }
        Err(_) => String::new(),
    }
}

pub(super) async fn ls(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
) -> String {
    let path = arg_str(args, "path").unwrap_or(".");
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(LS_DEFAULT_LIMIT);
    let target = resolve_path(root, scratch, path);
    // Names are content too: a symlinked directory would list a host directory.
    if symlink_escapes_any_root(root, scratch, read_roots, &target) {
        return format!(
            "ERROR: refused to list through a symlink out of the workspace: {path}{}",
            resolved_target(&target)
        );
    }
    // Windows says "The directory name is invalid. (os error 267)" for a file.
    if target.is_file() {
        let is_git = target.file_name().is_some_and(|n| n.eq_ignore_ascii_case(".git"));
        return if is_git {
            format!(
                "ERROR: {path} is a file, not a directory (a git worktree's .git is a pointer \
                 file; read it)."
            )
        } else {
            format!("ERROR: {path} is a file, not a directory; use read.")
        };
    }
    let mut entries = match tokio::fs::read_dir(&target).await {
        Ok(rd) => rd,
        Err(e) => return format!("ERROR: {e}"),
    };
    let mut names: Vec<String> = Vec::new();
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => {
                // Hidden state is omitted, not reported-then-denied: an entry the
                // agent can never open is only an invitation to try. Skipped when
                // not hiding, so an unconfined CLI run sees its own `.jan`.
                if hide_jan
                    && is_hidden_jan_path_in(root, write_roots, &entry.path().to_string_lossy())
                {
                    continue;
                }
                let mut name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                    name.push('/');
                }
                names.push(name);
            }
            Ok(None) => break,
            Err(e) => return format!("ERROR: {e}"),
        }
    }
    // Said, not left blank: an empty result read as a call that returned
    // nothing, and the model listed the same folder again with a shell.
    if names.is_empty() {
        return format!("(empty directory: {})", target.display());
    }
    names.sort_by_key(|n| n.to_lowercase());
    let entry_limited = names.len() > limit;
    names.truncate(limit);
    let mut joined = names.join("\n");
    if entry_limited {
        joined.push_str(&format!("\n[truncated: {limit} entry limit]"));
    }
    cap_output(&joined, usize::MAX, MAX_BYTES, "\n[truncated: 64KB limit]")
}

pub(super) async fn write(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    confine: bool,
    write_roots: &[PathBuf],
) -> String {
    let Some(path) = arg_str(args, "path") else {
        return "ERROR: missing required argument 'path'".to_string();
    };
    let Some(content) = arg_str(args, "content") else {
        return "ERROR: missing required argument 'content'".to_string();
    };
    if let Some((name, why)) = refuse_windows_name(path) {
        return format!("ERROR: refused to write '{name}' in {path}: the name {why}");
    }
    // Defense in depth: when the caller confines writes, re-canonicalize on the
    // canonical root (not the raw argument) so `..` and absolute paths are
    // caught even if the gate's decision was made against a stale view.
    let target = resolve_path(root, scratch, path);
    if confine && escapes_write_roots(root, scratch, write_roots, path).unwrap_or(true) {
        return format!("ERROR: refused to write outside the agent workspace: {path}");
    }
    // Report the resolved location, not the raw argument: an absolute or `../`
    // path lands outside the project and the model must see where it went.
    let shown = display_path(root, scratch, &target);
    // Re-validate before `create_dir_all`, not just before the write: a
    // concurrent sandboxed process can swap a path component between the gate
    // decision and this call, and creating the parents first would already have
    // made directories through the swapped link. Fail closed.
    if symlink_escapes_root(root, scratch, &target) {
        return format!(
            "ERROR: refused to write through a symlink out of the workspace: {path}{}",
            resolved_target(&target)
        );
    }
    let open_at = match resolved_for_open(&target) {
        Ok(p) => p,
        Err(e) => return format!("ERROR: refused to write {path}: {e}"),
    };
    // Only a regular file is overwritten, and the old content is read for the
    // "no change" answer only when it is the same size as the new: a large
    // target is never loaded whole just to be replaced (AGTB-025).
    let prior_len = match tokio::fs::symlink_metadata(&open_at).await {
        Ok(meta) if meta.is_file() => Some(meta.len()),
        Ok(meta) if meta.is_dir() => return format!("ERROR: {shown}: is a directory, not a file"),
        Ok(_) => return format!("ERROR: {shown}: not a regular file"),
        Err(_) => None,
    };
    // Existence decides created/overwrote; a non-UTF8 file still exists, so it
    // must not be a UTF-8 decode that answers that question. Read through the
    // same no-follow walk as the write, so a swapped link is refused here too.
    let prior = if prior_len.is_some_and(|n| n != content.len() as u64) {
        Some(None)
    } else {
        match read_no_follow(&open_at).await {
            Ok(prior) => Some(Some(prior)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) if nofollow::is_link_refused(&e) => return swapped_link("write", path),
            Err(_) => Some(None),
        }
    };
    let existed = prior.is_some();
    let unchanged = prior.flatten().is_some_and(|prior| prior == content.as_bytes());
    let bytes = content.len();
    match write_no_follow(&open_at, content).await {
        Err(e) if nofollow::is_link_refused(&e) => swapped_link("write", path),
        Ok(()) if unchanged => format!("No change: {shown} already had these {bytes} bytes"),
        Ok(()) if existed => format!("Overwrote {shown} ({bytes} bytes)"),
        Ok(()) => {
            let mut out = format!("Created {shown} ({bytes} bytes)");
            if let Some(real) = shadowed_real_file(path, &target, write_roots) {
                out.push_str(&format!(
                    "\n[note: this is a new copy in the session workspace, not {}. That file \
                     exists and you may edit it: change it there with `edit` instead of \
                     rewriting files here. The user can bring a sandbox file across with \
                     Review changes > Apply to folder.]",
                    real.display()
                ));
            }
            out
        }
        Err(e) => format!("ERROR: {shown}: {e}"),
    }
}

/// The real file a relative write into the workspace duplicates: `path` under
/// a granted folder, or under it with the folder's own name dropped
/// (`KewScraper/go.mod` for the granted `…/KewScraper`). A session copied a
/// project by hand this way after a shell copy failed, rewriting whole files
/// from memory while it could have edited the originals.
pub(super) fn shadowed_real_file(path: &str, written: &Path, write_roots: &[PathBuf]) -> Option<PathBuf> {
    let rel = Path::new(path);
    if rel.is_absolute() {
        return None;
    }
    let mut parts = rel.components();
    let first = parts.next()?.as_os_str().to_os_string();
    let rest: PathBuf = parts.collect();
    write_roots.iter().find_map(|root| {
        let direct = root.join(rel);
        let named = (root.file_name() == Some(first.as_os_str()) && !rest.as_os_str().is_empty())
            .then(|| root.join(&rest));
        [Some(direct), named]
            .into_iter()
            .flatten()
            .find(|candidate| candidate.is_file() && candidate.as_path() != written)
    })
}

pub(super) async fn edit(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    confine: bool,
    write_roots: &[PathBuf],
) -> String {
    let Some(path) = arg_str(args, "path") else {
        return "ERROR: missing required argument 'path'".to_string();
    };
    let Some(edits) = args.get("edits").and_then(|v| v.as_array()) else {
        return "ERROR: missing required argument 'edits'".to_string();
    };
    if edits.is_empty() {
        return "ERROR: edits must contain at least one replacement".to_string();
    }
    if let Some((name, why)) = refuse_windows_name(path) {
        return format!("ERROR: refused to edit '{name}' in {path}: the name {why}");
    }
    let target = resolve_path(root, scratch, path);
    if confine && escapes_write_roots(root, scratch, write_roots, path).unwrap_or(true) {
        return format!("ERROR: refused to edit outside the agent workspace: {path}");
    }
    let shown = display_path(root, scratch, &target);
    // Re-validate before the final read+write pair so a swapped symlink cannot
    // redirect either the read or the later write.
    if symlink_escapes_root(root, scratch, &target) {
        return format!(
            "ERROR: refused to edit through a symlink out of the workspace: {path}{}",
            resolved_target(&target)
        );
    }
    let open_at = match resolved_for_open(&target) {
        Ok(p) => p,
        Err(e) => return format!("ERROR: refused to edit {path}: {e}"),
    };
    // Size and type first: a FIFO blocks and a huge file is not loaded whole
    // (AGTB-025). A missing file falls through to the read's own error.
    if tokio::fs::symlink_metadata(&open_at).await.is_ok() {
        if let Err(e) = readable_file_with(&open_at, true).await {
            return format!("ERROR: {shown}: {e}");
        }
    }
    let content = match read_no_follow(&open_at).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(c) => c,
            Err(_) => return format!("ERROR: {shown}: stream did not contain valid UTF-8"),
        },
        Err(e) if nofollow::is_link_refused(&e) => return swapped_link("edit", path),
        Err(e) => return format!("ERROR: {shown}: {e}"),
    };
    let content = match apply_edits(&content, edits, &shown) {
        Ok(content) => content,
        Err(message) => return message,
    };

    match write_no_follow(&open_at, &content).await {
        Ok(()) => format!("Applied {} edit(s) to {shown}", edits.len()),
        Err(e) if nofollow::is_link_refused(&e) => swapped_link("edit", path),
        Err(e) => format!("ERROR: {shown}: {e}"),
    }
}

/// The file a write to `target` really lands in, every symlink on the way
/// followed -- the same resolution the containment checks just judged. The
/// handlers open this rather than `target`, so the open does not resolve the
/// path a second time on its own (Jozkah/jan#192).
pub(super) fn resolved_for_open(target: &Path) -> Result<PathBuf, String> {
    canonicalize_lenient(target)
}

/// Replace `path` with `content` through a sibling temp file and a rename
/// (Jozkah/jan#39), so a crash or kill mid-write leaves the user's file with
/// its old content or the full new content, never truncated, and the file's
/// permission bits survive the replacement. `path` is already resolved and
/// holds no links; the replace walks it without following one, so a link
/// swapped into a parent or the leaf after the checks is refused rather than
/// followed (Jozkah/jan#192, janhq/jan#9424).
pub(super) async fn write_no_follow(path: &Path, content: &str) -> std::io::Result<()> {
    let path = path.to_path_buf();
    let bytes = content.as_bytes().to_vec();
    tokio::task::spawn_blocking(move || nofollow::write_atomic(&path, &bytes))
        .await
        .map_err(std::io::Error::other)?
}

/// Read the resolved `path` without following a link along it.
pub(super) async fn read_no_follow(path: &Path) -> std::io::Result<Vec<u8>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || nofollow::read(&path))
        .await
        .map_err(std::io::Error::other)?
}

/// The answer when a link appeared in the path after it was checked.
pub(super) fn swapped_link(verb: &str, path: &str) -> String {
    format!(
        "ERROR: refused to {verb} {path}: a part of the path became a symbolic link after it          was checked"
    )
}

/// `path` made absolute against this process's working directory, with `.`
/// and `..` resolved lexically. Nothing has to exist yet.
pub(super) fn anchored(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(cwd) => lexical_normalize(&cwd.join(path)),
        Err(_) => path.to_path_buf(),
    }
}


pub(super) async fn find(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
) -> String {
    // RQA-004: `query`/`regex`/`search` are common names models use for it.
    let pattern = ["pattern", "query", "regex", "search"].iter().find_map(|k| arg_str(args, k)).map(String::from);
    let path = arg_str(args, "path").unwrap_or(".").to_string();
    // Clamped like the sibling tools' limits (Jozkah/jan#251): a model-chosen
    // million would otherwise walk the whole tree into one result.
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(FIND_DEFAULT_LIMIT)
        .clamp(1, FIND_DEFAULT_LIMIT * 10);
    let base = resolve_path(root, scratch, &path);
    if symlink_escapes_any_root(root, scratch, read_roots, &base) {
        return format!("ERROR: refused to search through a symlink out of the workspace: {path}");
    }
    let root_owned = root.to_path_buf();
    let write_owned = write_roots.to_vec();

    let Some(pattern) = pattern else {
        return "ERROR: missing required argument 'pattern'".to_string();
    };
    let res = tokio::task::spawn_blocking(move || {
        let pat = match glob::Pattern::new(&pattern) {
            Ok(p) => p,
            Err(e) => return format!("ERROR: invalid pattern: {e}"),
        };
        let opts = glob::MatchOptions {
            case_sensitive: true,
            require_literal_separator: false,
            require_literal_leading_dot: false,
        };
        let mut matches: Vec<String> = Vec::new();
        for entry in WalkBuilder::new(&base)
            .hidden(false)
            .require_git(false)
            .build()
            .flatten()
        {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
                continue;
            }
            if hide_jan
                && is_hidden_jan_path_in(&root_owned, &write_owned, &entry.path().to_string_lossy())
            {
                continue;
            }
            let rel = rel_to(&base, entry.path());
            if pat.matches_with(&rel, opts) {
                matches.push(rel);
                if matches.len() >= limit {
                    break;
                }
            }
        }
        if matches.is_empty() {
            "No matches.".to_string()
        } else {
            // The same byte cap `ls` and `grep` apply: long paths times the
            // match limit can still be megabytes of tool result.
            cap_output(&matches.join("\n"), usize::MAX, MAX_BYTES, "\n[truncated: 64KB limit]")
        }
    })
    .await;
    res.unwrap_or_else(|e| format!("ERROR: {e}"))
}


/// Most lines of context one match may pull in on each side.
pub(super) const GREP_MAX_CONTEXT: usize = 20;

/// Longest a grep walk may run before it stops and says so.
pub(super) const GREP_WALL_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

pub(super) fn clamp_grep_context(requested: Option<u64>) -> usize {
    requested.map_or(0, |v| v.min(GREP_MAX_CONTEXT as u64) as usize)
}

/// Tells the blocking grep walk to stop once the awaiting call is dropped
/// (cancelled), instead of reading the rest of the tree for nobody.
pub(super) struct CancelOnDrop(pub(super) std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

pub(super) async fn grep(
    args: &serde_json::Value,
    root: &Path,
    scratch: Option<&Path>,
    hide_jan: bool,
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
) -> String {
    // RQA-004: `query`/`regex`/`search` are common names models use for it.
    let pattern = ["pattern", "query", "regex", "search"].iter().find_map(|k| arg_str(args, k)).map(String::from);
    let path = arg_str(args, "path").unwrap_or(".").to_string();
    let glob_filter = arg_str(args, "glob").map(String::from);
    let ignore_case = arg_bool(args, "ignore_case");
    let literal = arg_bool(args, "literal");
    let context = clamp_grep_context(arg_u64(args, "context"));
    let limit = arg_u64(args, "limit")
        .map(|v| v as usize)
        .unwrap_or(GREP_DEFAULT_LIMIT)
        .clamp(1, GREP_MAX_RESULTS);
    let base = resolve_path(root, scratch, &path);
    if symlink_escapes_any_root(root, scratch, read_roots, &base) {
        return format!("ERROR: refused to search through a symlink out of the workspace: {path}");
    }
    let root_owned = root.to_path_buf();
    let write_owned = write_roots.to_vec();
    let scratch_owned = scratch.map(Path::to_path_buf);
    // Owned for the blocking walk closure, which outlives this frame.
    let roots_owned = read_roots.to_vec();

    let Some(pattern) = pattern else {
        return "ERROR: missing required argument 'pattern'".to_string();
    };
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _cancel_on_drop = CancelOnDrop(cancel.clone());
    let started = std::time::Instant::now();
    let res = tokio::task::spawn_blocking(move || {
        let effective = if literal {
            regex::escape(&pattern)
        } else {
            pattern.clone()
        };
        let re = match regex::RegexBuilder::new(&effective)
            .case_insensitive(ignore_case)
            .build()
        {
            Ok(r) => r,
            Err(e) => return format!("ERROR: invalid pattern: {e}"),
        };
        let glob_pat = match &glob_filter {
            Some(g) => match glob::Pattern::new(g) {
                Ok(p) => Some(p),
                Err(e) => return format!("ERROR: invalid glob: {e}"),
            },
            None => None,
        };

        let is_file = base.is_file();
        // Grouped per file, in walk order: (relative path, [(line no, is match, text)]).
        #[allow(clippy::type_complexity)]
        let mut groups: Vec<(String, Vec<(usize, bool, String)>)> = Vec::new();
        let mut count = 0usize;
        let mut truncated = false;
        let mut skipped_secrets = 0usize;
        let mut skipped_large = 0usize;
        let mut stopped = false;

        let mut search_file = |file: &Path, rel_base: &Path| -> bool {
            if let Some(gp) = &glob_pat {
                let rel = rel_to(rel_base, file);
                if !gp.matches(&rel)
                    && !gp.matches(
                        &file
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                    )
                {
                    return true;
                }
            }
            // Not loaded whole unless it is a regular file of a readable size
            // (Jozkah/jan#250): skipped, not an error, so the rest is searched.
            let fits = std::fs::metadata(file)
                .is_ok_and(|m| m.is_file() && m.len() <= READ_MAX_BYTES);
            if !fits {
                skipped_large += 1;
                return true;
            }
            let content = match std::fs::read_to_string(file) {
                Ok(c) => c,
                Err(_) => return true,
            };
            let rel = rel_to(rel_base, file);
            let lines: Vec<&str> = content.lines().collect();
            let mut entries: Vec<(usize, bool, String)> = Vec::new();
            let mut keep_going = true;
            for (i, line) in lines.iter().enumerate() {
                if !re.is_match(line) {
                    continue;
                }
                if count >= limit {
                    // One match past the cap is enough to report "N+".
                    truncated = true;
                    keep_going = false;
                    break;
                }
                let start = i.saturating_sub(context);
                let end = (i + context + 1).min(lines.len());
                for (j, item) in lines.iter().enumerate().take(end).skip(start) {
                    let line_no = j + 1;
                    // Overlapping context windows: never repeat a line, but
                    // promote an already-emitted context line that matches.
                    if let Some(prev) = entries.iter_mut().find(|e| e.0 == line_no) {
                        prev.1 |= j == i;
                        continue;
                    }
                    entries.push((line_no, j == i, truncate_line(item)));
                }
                count += 1;
            }
            if !entries.is_empty() {
                groups.push((rel, entries));
            }
            keep_going
        };

        if is_file {
            let rel_base = base.parent().unwrap_or(&base);
            search_file(&base, rel_base);
        } else {
            for entry in WalkBuilder::new(&base)
                .hidden(false)
                .require_git(false)
                // Git's own database is never project content.
                .filter_entry(|e| e.file_name() != ".git")
                .build()
                .flatten()
            {
                if cancel.load(std::sync::atomic::Ordering::Relaxed)
                    || started.elapsed() > GREP_WALL_BUDGET
                {
                    stopped = true;
                    break;
                }
                let Some(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_dir() {
                    continue;
                }
                // The walk does not descend symlinked directories, but a symlink
                // to a *file* is not a directory and would be opened and read.
                // Checked (not skipped outright) so a link that stays inside the
                // workspace -- every yarn workspace has them -- is still searched.
                if file_type.is_symlink()
                    && symlink_escapes_any_root(
                        &root_owned,
                        scratch_owned.as_deref(),
                        &roots_owned,
                        entry.path(),
                    )
                {
                    continue;
                }
                if hide_jan
                    && is_hidden_jan_path_in(
                        &root_owned,
                        &write_owned,
                        &entry.path().to_string_lossy(),
                    )
                {
                    continue;
                }
                // AH-044 for the files a walk finds (Jozkah/jan#239): the gate
                // only saw the directory, so a credential file is skipped here,
                // judged by its own name and, through a link, by its target's.
                if walked_secret(entry.path()) {
                    skipped_secrets += 1;
                    continue;
                }
                if !search_file(entry.path(), &base) {
                    break;
                }
            }
        }

        let mut skipped_note = if skipped_secrets > 0 {
            format!(
                "\n\n[Skipped {skipped_secrets} credential file(s) (.env, keys, tokens); read one by name with a rule that allows it]"
            )
        } else {
            String::new()
        };
        if skipped_large > 0 {
            skipped_note.push_str(&format!(
                "\n\n[Skipped {skipped_large} file(s) over {} MiB or not regular files; search those with bash (rg)]",
                READ_MAX_BYTES / (1024 * 1024)
            ));
        }
        if stopped {
            skipped_note.push_str("\n\n[search stopped early (time budget or cancelled); narrow the path or glob to search the rest]");
        }
        if groups.is_empty() {
            format!("No matches.{skipped_note}")
        } else {
            let mut body = format_grep_groups(&groups);
            if truncated {
                body.push_str(&format!(
                    "\n\n[Showing first {count} of {count}+ matches; narrow the pattern, path or glob to see the rest]"
                ));
            }
            body.push_str(&skipped_note);
            cap_output(&body, usize::MAX, MAX_BYTES, "\n[truncated: 64KB limit]")
        }
    })
    .await;
    res.unwrap_or_else(|e| format!("ERROR: {e}"))
}

/// The largest file `read` or `grep` loads. Above the 20 MiB image limit, far
/// above what fits the 64 KB output; bigger files are for `bash` (`head`,
/// `rg`), which stream.
pub(super) const READ_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// What `read` accepts when the model passes `allow_large: true`: 8x the normal
/// limit. A hard ceiling, not an opt-out; past it the file is for `bash`.
pub(super) const READ_MAX_BYTES_ALLOW_LARGE: u64 = READ_MAX_BYTES * 8;

/// Whether `path` is a regular file small enough to load whole
/// (Jozkah/jan#250), at the size limit `read`'s `allow_large` argument selects.
/// A FIFO, device or other special file is refused: reading one blocks or never
/// ends. The refusal names the argument so the model knows the way out without
/// reaching for the shell.
pub(super) async fn readable_file_with(path: &Path, allow_large: bool) -> Result<(), String> {
    let meta = tokio::fs::metadata(path).await.map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    const MIB: u64 = 1024 * 1024;
    if allow_large {
        if meta.len() > READ_MAX_BYTES_ALLOW_LARGE {
            return Err(format!(
                "{} MiB is over even the allow_large ceiling ({} MiB); use bash with head, tail or rg",
                meta.len() / MIB,
                READ_MAX_BYTES_ALLOW_LARGE / MIB
            ));
        }
    } else if meta.len() > READ_MAX_BYTES {
        return Err(format!(
            "{} MiB is too large to read here (limit {} MiB); pass allow_large: true to read up to {} MiB, or use bash with head, tail or rg",
            meta.len() / MIB,
            READ_MAX_BYTES / MIB,
            READ_MAX_BYTES_ALLOW_LARGE / MIB
        ));
    }
    Ok(())
}

/// Whether a file a directory walk reached is a credential file by the AH-044
/// name rules, by its own name or, if it is a link, by its target's name.
pub(super) fn walked_secret(path: &Path) -> bool {
    let named = |p: &Path| {
        p.file_name()
            .is_some_and(|n| crate::project_browse::is_sensitive_name(&n.to_string_lossy()))
    };
    named(path) || path.canonicalize().is_ok_and(|real| named(&real))
}

/// Model-facing grep output: a header line per file (its relative path), then
/// its lines as `  N: text` for matches and `  N- text` for context, with a
/// blank line between files. Gaps inside one file are marked by `  --`.
#[allow(clippy::type_complexity)]
pub(super) fn format_grep_groups(groups: &[(String, Vec<(usize, bool, String)>)]) -> String {
    let mut out = String::new();
    for (gi, (file, entries)) in groups.iter().enumerate() {
        if gi > 0 {
            out.push_str("\n\n");
        }
        out.push_str(file);
        let mut prev: Option<usize> = None;
        for (line_no, is_match, text) in entries {
            if prev.is_some_and(|p| *line_no > p + 1) {
                out.push_str("\n  --");
            }
            let sep = if *is_match { ':' } else { '-' };
            out.push_str(&format!("\n  {line_no}{sep} {text}"));
            prev = Some(*line_no);
        }
    }
    out
}

pub(super) fn truncate_line(line: &str) -> String {
    if line.chars().count() > GREP_MAX_LINE {
        let truncated: String = line.chars().take(GREP_MAX_LINE).collect();
        format!("{truncated}...")
    } else {
        line.to_string()
    }
}
