//! The sandbox policy a `bash` call runs under, and where its shell starts.
//! Built from the call's context alone, so it is testable without a spawn.

use super::*;

/// Every root the sandbox is given, made absolute.
///
/// The confined helper runs with its working directory set to the workspace,
/// so a relative path means somewhere else by the time the helper reads it,
/// and Jan's data folder defaults to the relative `./data`. The shell then
/// failed in the helper's setup ("workspace does not exist") on every
/// command, even with a sandbox that works.
#[derive(Debug, Clone)]
pub(crate) struct AnchoredRoots {
    pub root: PathBuf,
    pub mask: Option<PathBuf>,
    pub scratch: Option<PathBuf>,
    pub read: Vec<PathBuf>,
    pub write: Vec<PathBuf>,
}

impl AnchoredRoots {
    pub(crate) fn from_ctx(ctx: &ToolContext<'_>) -> Self {
        Self {
            root: anchored(ctx.project_root),
            mask: ctx.mask_root.map(anchored),
            scratch: ctx.scratch_root.map(anchored),
            read: ctx.read_roots.iter().map(|p| anchored(p)).collect(),
            write: ctx.write_roots.iter().map(|p| anchored(p)).collect(),
        }
    }
}

/// The policy plus the folder the shell starts in.
#[derive(Debug, Clone)]
pub(crate) struct BashPolicy {
    pub policy: jail::Policy,
    pub start: PathBuf,
    /// The shell starts somewhere other than the workspace (a managed
    /// worktree, or the direct-shell edit folder).
    pub in_worktree: bool,
}

/// Build the policy for one `bash` call. Marks each write root's `.jan`
/// skip-worktree on the host when the shell is confined to it, exactly as
/// the handler always has, before any shell sees the hidden folder.
pub(crate) fn build_bash_policy(ctx: &ToolContext<'_>, roots: &AnchoredRoots) -> BashPolicy {
    let root = roots.root.as_path();
    let read_abs = &roots.read;
    let write_abs = &roots.write;
    // The base hooks share (see `sandbox_shell::base_policy`), plus what only
    // the bash tool has.
    let mut policy = crate::tools::sandbox_shell::base_policy(
        root,
        ctx.allow_network,
        ctx.home_readonly,
        ctx.sandbox,
        roots.mask.as_deref(),
    );
    if let Some(fs) = ctx.fs {
        policy = policy.with_fs_config(fs.clone());
    }
    if let Some(scratch) = roots.scratch.as_deref() {
        policy = policy.with_scratch_root(scratch);
    }
    if !read_abs.is_empty() {
        policy = policy.with_read_roots(read_abs.clone());
    }
    // The same roots the file tools were granted. Refused outright where the
    // backend cannot confine a shell to them, so `bash` is never the loose end
    // that makes an access mode untrue: on such a platform the run keeps its
    // sandbox-only shell and the mode is not offered in the first place.
    // On AppContainer that means Jan-owned worktrees only: see
    // [`jail::can_confine_write_roots`].
    let owned = roots.mask.as_deref().map(crate::workspace::worktrees_dir);
    let mut start = root.to_path_buf();
    if !write_abs.is_empty()
        && jail::can_confine_write_roots(jail::backend(), write_abs, owned.as_deref())
    {
        policy = policy.with_write_roots(write_abs.clone());
        if ctx.sandbox {
            policy = hide_write_root_jans(policy, write_abs);
            // From the host, before the shell sees the hidden `.jan`: a
            // tracked file there must not look deleted to the sandboxed git.
            for wr in write_abs {
                if let Err(e) = crate::tools::git_native::skip_worktree_jan(wr) {
                    eprintln!("could not mark {}/.jan skip-worktree: {e}", wr.display());
                }
            }
        }
        // #322: a run whose destination is a managed worktree starts its shell
        // there, so `npm test` or `.\check.ps1` mean the project. See
        // [`managed_worktree_start`] for when; the file tools follow through
        // [`rebase_relative_paths`].
        if let Some(wt) = managed_worktree_start(write_abs, owned.as_deref()) {
            policy = policy.with_start_dir(&wt);
            start = policy.start_dir().to_path_buf();
        }
    }
    if ctx.sandbox && policy.write_roots.is_empty() && !write_abs.is_empty() {
        // Granted to the file tools, out of the shell's reach: named in
        // failure notes only.
        policy = policy.with_unreachable_grants(write_abs.clone());
    }
    if ctx.sandbox && jail::backend() == jail::Backend::AppContainer {
        // The helper skips a read-only folder it will never grant (a drive
        // root, the profile, a system folder): named in failure notes, so the
        // model is not told to build from a folder its shell cannot open.
        let refused: Vec<PathBuf> = read_abs
            .iter()
            .filter(|r| {
                !policy.write_roots.contains(r)
                    && crate::tools::appcontainer::grant_refusal(r).is_some()
            })
            .cloned()
            .collect();
        if !refused.is_empty() {
            policy = policy.with_unreachable_read_grants(refused);
        }
    }
    // An unconfined shell for an edit folder the sandbox cannot reach starts in
    // that folder, so relative paths and `Set-Location` mean the project.
    if !ctx.sandbox {
        if let Some(dir) = ctx.direct_shell_start.as_deref().map(anchored) {
            if dir.is_dir() {
                policy = policy.with_start_dir(&dir);
                start = dir;
            }
        }
    }
    let in_worktree = start.as_path() != root;
    BashPolicy {
        policy,
        start,
        in_worktree,
    }
}
