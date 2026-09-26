//! Confining a local MCP server to the authority of the session that imported
//! it.
//!
//! An MCP server imported from repository configuration is a program the
//! repository chose. Jan's ordinary MCP launcher starts one as a plain child
//! process: the parent's whole environment, no filesystem restriction, no
//! working-directory pin. That is a reasonable trade for a server the user
//! configured themselves — they picked it — and not for one that arrived in a
//! pull request.
//!
//! So a local imported server runs under the same sandbox the agent's own
//! shell runs under. This module does not implement a second, weaker policy
//! for MCP; it builds a [`jail::Policy`] from the session's frozen authority
//! and hands it to the same [`jail::wrap`] the `bash` tool uses. Where that
//! wrapper cannot enforce anything, there is no confined command to build and
//! the caller must refuse to start the server.
//!
//! The authority is the run's, frozen: review-only means the repository is
//! readable and nothing outside the workspace is writable; edit-folder adds
//! exactly one write root, and only when a live grant says so. A preference
//! changed later cannot widen a process that is already running, because the
//! command was built once from the authority it started with.

use std::path::{Path, PathBuf};

use super::jail::{self, Backend, Policy};
use super::proc::{self, ShellConfig};

/// What a session may let a local MCP server do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpAuthority {
    /// The repository is readable. Nothing outside the workspace is writable.
    ReviewOnly {
        workspace: PathBuf,
        repository: Option<PathBuf>,
        /// Extra folders attached to the session, readable only. The same set
        /// the built-in tools' sandbox is given.
        read_roots: Vec<PathBuf>,
    },
    /// One repository root is writable, because a live grant says so.
    EditFolder {
        workspace: PathBuf,
        repository: PathBuf,
        /// Extra folders attached to the session, readable only.
        read_roots: Vec<PathBuf>,
    },
}

/// Why a local MCP server cannot be started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfineError {
    /// No sandbox backend on this platform, so nothing would confine it.
    NoBackend,
    /// The backend cannot restrict writes to a chosen root, so `edit-folder`
    /// cannot be honoured. Windows today: writes are granted by an ACE on the
    /// thread workspace, never on the user's own folder.
    NoWriteRoots(&'static str),
    /// The working directory the configuration asked for is outside every root
    /// this session may use.
    WorkingDirEscapes(PathBuf),
    /// The wrapper itself could not be built (no bwrap, no current exe).
    WrapperUnavailable,
}

impl ConfineError {
    /// A reason the user can act on, safe to show. Carries no secret and no
    /// path the caller did not already supply.
    pub fn reason(&self) -> String {
        match self {
            Self::NoBackend => {
                "no sandbox backend on this platform, so a local server would run unconfined"
                    .to_string()
            }
            Self::NoWriteRoots(backend) => {
                format!("the {backend} backend cannot confine writes to one folder")
            }
            Self::WorkingDirEscapes(path) => format!(
                "the working directory resolves outside this session's roots: {}",
                path.display()
            ),
            Self::WrapperUnavailable => "the sandbox wrapper could not be built".to_string(),
        }
    }
}

impl McpAuthority {
    fn workspace(&self) -> &Path {
        match self {
            Self::ReviewOnly { workspace, .. } | Self::EditFolder { workspace, .. } => workspace,
        }
    }

    /// The extra attached folders, readable only.
    fn extra_read_roots(&self) -> &[PathBuf] {
        match self {
            Self::ReviewOnly { read_roots, .. } | Self::EditFolder { read_roots, .. } => read_roots,
        }
    }

    /// Every root this session may see, readable or writable. The set a
    /// working directory has to fall inside.
    fn roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![self.workspace().to_path_buf()];
        match self {
            Self::ReviewOnly { repository, .. } => {
                if let Some(repo) = repository {
                    roots.push(repo.clone());
                }
            }
            Self::EditFolder { repository, .. } => roots.push(repository.clone()),
        }
        roots.extend(self.extra_read_roots().iter().cloned());
        roots
    }
}

/// Is `path` inside `root`, comparing whole path components?
///
/// Component-wise on purpose. A string prefix test puts
/// `/home/dev/obs-forwarder-backup` inside `/home/dev/obs-forwarder`, which is
/// the exact sibling-repository confusion this whole surface exists to stop.
fn contained(root: &Path, path: &Path) -> bool {
    let root = super::sandbox::lexical_normalize(root);
    let path = super::sandbox::lexical_normalize(path);
    path.starts_with(&root)
}

/// Build the policy one MCP server runs under.
///
/// The same shape the agent's shell gets: the workspace stays readable and
/// writable, the repository is a read root, and it becomes a write root only
/// under `EditFolder`. Jan's own data folder is hidden either way — an MCP
/// server has no business reading the app's storage, whatever the repository
/// that named it would like.
///
/// Two denials matter as much as the grants. The user's home directory stays
/// unreadable, which is the default and is deliberately not relaxed here: a
/// server that could read `$HOME` has the user's keys. And the directory the
/// selected repository sits in is masked, so the repositories *beside* it are
/// unreadable — the read root re-allows the selected one afterwards, because
/// in these profiles the later rule wins. Without that mask a confined server
/// could still read `note-py` from `obs-forwarder`, which is exfiltration
/// even though it never wrote a byte.
pub fn policy_for(authority: &McpAuthority, jan_data: Option<&Path>) -> Policy {
    // Network stays available: a remote-fetching MCP server is an ordinary
    // thing to run, and the filesystem is what this is confining.
    let mut policy = Policy::new(authority.workspace(), true);

    let repository = match authority {
        McpAuthority::ReviewOnly { repository, .. } => repository.clone(),
        McpAuthority::EditFolder { repository, .. } => Some(repository.clone()),
    };

    // Every read root the confined server gets, in one set: the chosen
    // repository plus the folders attached to the session. `with_read_roots`
    // replaces rather than appends, so they are gathered here and applied once.
    // Writes are never widened — the workspace (and, under `EditFolder`, the one
    // repository) stay the only writable roots.
    let mut read_roots: Vec<PathBuf> = Vec::new();
    if let Some(repo) = repository.as_ref() {
        // Mask first: the neighbours go dark and the chosen repository is
        // allowed back by the read root below. An attached folder beside the
        // repository is re-allowed the same way, because the later rule wins.
        if let Some(parent) = repo.parent() {
            policy = policy.with_mask_root(parent);
        }
        read_roots.push(repo.clone());
    }
    read_roots.extend(authority.extra_read_roots().iter().cloned());
    if !read_roots.is_empty() {
        policy = policy.with_read_roots(read_roots);
    }

    if matches!(authority, McpAuthority::EditFolder { .. }) {
        if let Some(repo) = repository {
            policy = policy.with_write_roots(vec![repo]);
        }
    }

    if let Some(data) = jan_data {
        policy = policy.with_hide_root(data);
    }
    policy
}

/// The command that actually starts a confined local MCP server.
///
/// Structured executable and argv throughout — nothing is ever joined into a
/// shell string, so an argument containing a space, a quote or a `;` stays one
/// argument instead of becoming syntax.
pub fn confined_command(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    authority: &McpAuthority,
    jan_data: Option<&Path>,
) -> Result<ShellConfig, ConfineError> {
    let backend = jail::backend();
    if !backend.enforces() {
        return Err(ConfineError::NoBackend);
    }
    if matches!(authority, McpAuthority::EditFolder { .. }) && !supports_edit_folder(backend) {
        return Err(ConfineError::NoWriteRoots(backend.as_str()));
    }

    // Where it runs is part of what it may reach. A configuration naming the
    // repository next door, a parent directory, or a home directory is
    // refused here rather than confined into something that merely looks safe.
    if let Some(dir) = cwd {
        let roots = authority.roots();
        if !roots.iter().any(|root| contained(root, dir)) {
            return Err(ConfineError::WorkingDirEscapes(dir.to_path_buf()));
        }
    }

    let policy = policy_for(authority, jan_data);
    let inner = ShellConfig {
        program: program.to_path_buf(),
        args: args.to_vec(),
        via_stdin: false,
        description: "mcp",
        // An MCP server is an executable, not a shell: nothing appends a
        // command string to it, so the flavor is only ever carried through the
        // wrapper unchanged.
        flavor: proc::ShellFlavor::Posix,
    };
    jail::wrap(&inner, &policy).ok_or(ConfineError::WrapperUnavailable)
}

/// Environment variables an imported server is given.
///
/// An allowlist, never the parent's environment. Jan's process holds the
/// user's whole session — API keys, tokens, whatever the shell that launched
/// it exported — and handing that to a program a repository chose is the
/// leak this prevents. Only names the user explicitly approved pass, and only
/// when a value was actually supplied for them.
pub fn allowed_env(approved: &[String], supplied: &[(String, String)]) -> Vec<(String, String)> {
    supplied
        .iter()
        .filter(|(name, _)| approved.iter().any(|one| one == name))
        .cloned()
        .collect()
}

/// Can this platform run a local imported MCP server at all?
pub fn confinement_available() -> bool {
    jail::backend().enforces()
}

/// The backend name, for reporting which enforcement is in play.
pub fn confinement_backend() -> &'static str {
    jail::backend().as_str()
}

/// Does this backend support the `edit-folder` case?
///
/// Not on AppContainer, although its shell can now edit an authorized folder:
/// a folder ACE is withdrawn when the session's grant goes, and a long-lived
/// MCP server holds no grant that could be withdrawn under it.
pub fn supports_edit_folder(backend: Backend) -> bool {
    jail::supports_write_roots(backend) && backend != Backend::AppContainer
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture the whole surface is defended against: three sibling
    /// repositories, one of which shares a prefix with the selected one. Any
    /// containment check written with string prefixes lets `-backup` through.
    fn roots() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        (
            PathBuf::from("/home/dev/obs-forwarder"),
            PathBuf::from("/home/dev/note-py"),
            PathBuf::from("/home/dev/obs-forwarder-backup"),
            PathBuf::from("/jan/sessions/session-a"),
        )
    }

    fn review_only() -> McpAuthority {
        let (repo, _, _, workspace) = roots();
        McpAuthority::ReviewOnly {
            workspace,
            repository: Some(repo),
            read_roots: vec![],
        }
    }

    fn editing() -> McpAuthority {
        let (repo, _, _, workspace) = roots();
        McpAuthority::EditFolder {
            workspace,
            repository: repo,
            read_roots: vec![],
        }
    }

    #[test]
    fn review_only_makes_the_repository_readable_and_nothing_writable() {
        let policy = policy_for(&review_only(), None);
        let (repo, _, _, workspace) = roots();

        assert_eq!(policy.read_roots, vec![repo.clone()]);
        assert_eq!(
            policy.mask_root.as_deref(),
            repo.parent(),
            "the repositories beside the selected one must be masked"
        );
        assert!(
            policy.write_roots.is_empty(),
            "review-only must add no write root; the workspace is the only writable place"
        );
        assert_eq!(policy.workspace, workspace);
    }

    /// An attached folder is readable, but only readable: it joins the read
    /// roots and never the write roots.
    #[test]
    fn attached_read_roots_are_readable_but_never_writable() {
        let (repo, _, _, workspace) = roots();
        let attached = PathBuf::from("/home/dev/attached-notes");

        let review = policy_for(
            &McpAuthority::ReviewOnly {
                workspace: workspace.clone(),
                repository: Some(repo.clone()),
                read_roots: vec![attached.clone()],
            },
            None,
        );
        assert_eq!(review.read_roots, vec![repo.clone(), attached.clone()]);
        assert!(review.write_roots.is_empty());

        // Even under `EditFolder`, the attached folder is not made writable —
        // only the one repository is.
        let editing = policy_for(
            &McpAuthority::EditFolder {
                workspace,
                repository: repo.clone(),
                read_roots: vec![attached.clone()],
            },
            None,
        );
        assert_eq!(editing.read_roots, vec![repo.clone(), attached.clone()]);
        assert_eq!(editing.write_roots, vec![repo]);
        assert!(!editing.write_roots.contains(&attached));
    }

    #[test]
    fn edit_folder_adds_exactly_one_write_root() {
        let policy = policy_for(&editing(), None);
        let (repo, sibling, prefix_sibling, _) = roots();

        assert_eq!(policy.write_roots, vec![repo]);
        assert!(!policy.write_roots.contains(&sibling));
        assert!(!policy.write_roots.contains(&prefix_sibling));
    }

    /// An imported server has no business reading Jan's own storage, whatever
    /// the repository that named it would like.
    #[test]
    fn jan_data_is_hidden_from_an_imported_server() {
        let data = PathBuf::from("/home/dev/.jan");
        let policy = policy_for(&editing(), Some(&data));

        assert_eq!(policy.hide_roots, vec![data.clone()]);
        assert!(
            !policy.home_readonly,
            "the home read denial must stay in force; relaxing it would hand \
             an imported server the user's keys"
        );
    }

    #[test]
    fn a_working_directory_inside_the_repository_is_accepted() {
        let (repo, _, _, _) = roots();
        let inside = repo.join("packages/api");

        let built = confined_command(
            Path::new("/usr/bin/node"),
            &["server.js".to_string()],
            Some(&inside),
            &review_only(),
            None,
        );

        // On a host with no backend this refuses for that reason instead, which
        // is itself correct: the point is that containment is not what failed.
        match built {
            Ok(_) => {}
            Err(e) => assert_ne!(
                e,
                ConfineError::WorkingDirEscapes(inside),
                "a directory inside the repository must not be reported as escaping"
            ),
        }
    }

    /// The sibling-repository refusals. `-backup` is the one a string-prefix
    /// containment check gets wrong; the `..` case is traversal back out.
    #[test]
    fn a_working_directory_outside_every_root_is_refused() {
        let (_, sibling, prefix_sibling, _) = roots();

        for dir in [
            sibling,
            prefix_sibling,
            PathBuf::from("/home/dev"),
            PathBuf::from("/home/dev/obs-forwarder/../note-py"),
            PathBuf::from("/"),
        ] {
            let err = confined_command(
                Path::new("/usr/bin/node"),
                &[],
                Some(&dir),
                &review_only(),
                None,
            )
            .expect_err("a working directory outside the session's roots must be refused");

            assert!(
                matches!(
                    err,
                    ConfineError::WorkingDirEscapes(_) | ConfineError::NoBackend
                ),
                "unexpected error for {}: {err:?}",
                dir.display()
            );
        }
    }

    #[test]
    fn containment_compares_whole_components() {
        let (repo, sibling, prefix_sibling, _) = roots();

        assert!(contained(&repo, &repo.join("src/a.ts")));
        assert!(
            !contained(&repo, &prefix_sibling),
            "obs-forwarder-backup is not inside obs-forwarder"
        );
        assert!(!contained(&repo, &sibling));
        assert!(!contained(&repo, Path::new("/home/dev")));
    }

    /// Nothing is ever joined into a shell string. An argument holding a
    /// space, a quote or a command separator stays one argument instead of
    /// becoming syntax.
    #[test]
    fn arguments_stay_arguments() {
        let hostile = vec![
            "/home/dev/my repo/server.js".to_string(),
            "--root=\"/home/dev/note-py\"".to_string(),
            "; rm -rf /".to_string(),
            "naïve—arg".to_string(),
        ];

        let Ok(built) = confined_command(
            Path::new("/usr/bin/node"),
            &hostile,
            None,
            &review_only(),
            None,
        ) else {
            // No backend on this host: the argv shape is asserted by the
            // seatbelt/bwrap builders' own tests instead.
            return;
        };

        for one in &hostile {
            assert!(
                built.args.iter().any(|arg| arg == one),
                "argument {one:?} must survive as its own argv entry"
            );
        }
    }

    /// The command handed back must be the wrapper, not the server itself.
    ///
    /// The failure this catches: returning the inner command unchanged. Every
    /// other assertion here — the policy's roots, the working directory, the
    /// argv — still passes when the policy is built correctly and then never
    /// applied, so without this the whole module could be inert.
    #[test]
    fn the_built_command_is_the_sandbox_wrapper() {
        let backend = jail::backend();
        if !backend.enforces() {
            return;
        }

        let inner = Path::new("/usr/bin/node");
        let built = confined_command(
            inner,
            &["server.js".to_string()],
            None,
            &review_only(),
            None,
        )
        .expect("a host with a backend must produce a confined command");

        assert_ne!(
            built.program, inner,
            "the server must be launched through the sandbox wrapper, not directly"
        );
        assert!(
            built.args.len() > 1,
            "the wrapper contributes its own arguments before the server's"
        );
        // The inner program survives inside the wrapper's argv rather than
        // being lost: it is what the wrapper goes on to execute.
        assert!(
            built
                .args
                .iter()
                .any(|arg| arg.contains("node") || arg == "server.js"),
            "the wrapped command must still name the server it starts"
        );
    }

    /// Jan's process holds the user's whole session. Handing that to a program
    /// a repository chose is the leak this prevents.
    #[test]
    fn only_approved_environment_names_are_passed() {
        let supplied = vec![
            ("API_TOKEN".to_string(), "value-for-the-server".to_string()),
            ("AWS_SECRET_ACCESS_KEY".to_string(), "not-yours".to_string()),
            ("HOME".to_string(), "/home/dev".to_string()),
        ];

        let passed = allowed_env(&["API_TOKEN".to_string()], &supplied);

        assert_eq!(
            passed,
            vec![("API_TOKEN".to_string(), "value-for-the-server".to_string())]
        );
    }

    #[test]
    fn an_approved_name_with_no_value_passes_nothing() {
        assert!(allowed_env(&["API_TOKEN".to_string()], &[]).is_empty());
    }

    #[test]
    fn nothing_is_passed_when_nothing_was_approved() {
        let supplied = vec![("API_TOKEN".to_string(), "v".to_string())];

        assert!(allowed_env(&[], &supplied).is_empty());
    }

    /// Windows ties a folder ACE to a session grant a server does not hold, so
    /// `edit-folder` is not honoured there for MCP servers.
    #[test]
    fn edit_folder_is_unsupported_where_writes_cannot_be_confined() {
        assert!(supports_edit_folder(Backend::Seatbelt));
        assert!(supports_edit_folder(Backend::Bubblewrap));
        assert!(!supports_edit_folder(Backend::AppContainer));
        assert!(!supports_edit_folder(Backend::None));
    }

    /// Fail closed. With nothing enforcing, there is no confined command to
    /// build, and the caller must refuse to start the server.
    #[test]
    fn no_backend_produces_no_command() {
        if jail::backend().enforces() {
            return;
        }

        let err = confined_command(Path::new("/usr/bin/node"), &[], None, &review_only(), None)
            .expect_err("with no backend there is nothing to confine with");

        assert_eq!(err, ConfineError::NoBackend);
        assert!(!confinement_available());
    }

    #[test]
    fn every_refusal_explains_itself_without_leaking() {
        for err in [
            ConfineError::NoBackend,
            ConfineError::NoWriteRoots("appcontainer"),
            ConfineError::WorkingDirEscapes(PathBuf::from("/home/dev/note-py")),
            ConfineError::WrapperUnavailable,
        ] {
            let reason = err.reason();
            assert!(!reason.is_empty());
            assert!(!reason.to_lowercase().contains("secret"));
            assert!(!reason.to_lowercase().contains("grant"));
        }
    }
}

/// Real processes, under the real policy an imported MCP server would get.
///
/// Everything above asserts the policy is *built* correctly. This asserts it is
/// *enforced*: a confined process is actually spawned and made to try the
/// writes an imported server might attempt. Skipped where no backend enforces,
/// since there is then nothing to observe.
#[cfg(all(test, unix))]
mod runtime_tests {
    use super::super::jail::{backend, scratch_env_path};
    use super::super::proc;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// macOS returns the `/var/folders/...` symlink from `temp_dir()` while
    /// `sandbox-exec` matches the canonical `/private/var/...` form, so a
    /// policy built on the symlinked path is silently bypassed.
    fn temp_dir() -> PathBuf {
        let tmp = std::env::temp_dir();
        #[cfg(target_os = "macos")]
        let tmp = tmp.canonicalize().unwrap_or(tmp);
        tmp
    }

    fn scratch(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = temp_dir().join(format!("jan_mcp_{}_{}_{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).expect("create dir");
        dir
    }

    /// Run one shell command under the policy an MCP server with `authority`
    /// would be given, and report whether it succeeded.
    async fn run_under(authority: &McpAuthority, command: &str) -> (bool, String) {
        let policy = policy_for(authority, None);
        let wrapped = jail::wrap(proc::shell(), &policy).expect("a backend that enforces");
        let tmp = scratch_env_path(backend(), &policy);
        let child = proc::spawn(&wrapped, command, authority.workspace(), tmp.as_deref())
            .await
            .expect("spawn");
        let pid = child.id();
        let out = child.wait_with_output().await.expect("wait");
        if let Some(pid) = pid {
            proc::unregister(pid);
        }
        let mut text = String::from_utf8_lossy(&out.stdout).to_string();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        (out.status.success(), text)
    }

    /// The three-repository fixture, on disk this time.
    fn fixture() -> (McpAuthority, PathBuf, PathBuf, PathBuf) {
        let base = scratch("fix");
        let workspace = base.join("workspace");
        let repo = base.join("obs-forwarder");
        let sibling = base.join("note-py");
        let prefix_sibling = base.join("obs-forwarder-backup");
        for dir in [&workspace, &repo, &sibling, &prefix_sibling] {
            std::fs::create_dir_all(dir).expect("create fixture dir");
        }
        (
            McpAuthority::ReviewOnly {
                workspace,
                repository: Some(repo.clone()),
                read_roots: vec![],
            },
            repo,
            sibling,
            prefix_sibling,
        )
    }

    #[tokio::test]
    async fn a_confined_server_can_work_in_its_own_workspace() {
        if !backend().enforces() {
            return;
        }
        let (authority, _, _, _) = fixture();

        let (ok, out) = run_under(&authority, "echo ok > out.txt && cat out.txt").await;

        assert!(ok, "the workspace must stay writable: {out}");
        assert!(out.contains("ok"), "{out}");
    }

    /// Review only: the repository is readable and must not be writable.
    #[tokio::test]
    async fn review_only_can_read_the_repository_but_not_write_it() {
        if !backend().enforces() {
            return;
        }
        let (authority, repo, _, _) = fixture();
        std::fs::write(repo.join("README.md"), "hello").expect("seed");

        let (read_ok, _) =
            run_under(&authority, &format!("cat {}/README.md", repo.display())).await;
        let (write_ok, _) = run_under(
            &authority,
            &format!("echo x > {}/pwned.txt", repo.display()),
        )
        .await;

        assert!(
            read_ok,
            "review-only must still be able to read the repository"
        );
        assert!(
            !write_ok,
            "review-only must not be able to write the repository"
        );
        assert!(
            !repo.join("pwned.txt").exists(),
            "a refused write must not have landed"
        );
    }

    /// Edit this folder: the one authorized root becomes writable, and only it.
    #[tokio::test]
    async fn edit_folder_can_write_only_the_authorized_root() {
        if !backend().enforces() || !supports_edit_folder(backend()) {
            return;
        }
        let (review, repo, sibling, prefix_sibling) = fixture();
        let editing = McpAuthority::EditFolder {
            workspace: review.workspace().to_path_buf(),
            repository: repo.clone(),
            read_roots: vec![],
        };

        let (repo_ok, out) =
            run_under(&editing, &format!("echo x > {}/ours.txt", repo.display())).await;
        let (sibling_ok, _) = run_under(
            &editing,
            &format!("echo x > {}/pwned.txt", sibling.display()),
        )
        .await;
        let (prefix_ok, _) = run_under(
            &editing,
            &format!("echo x > {}/pwned.txt", prefix_sibling.display()),
        )
        .await;

        assert!(repo_ok, "the authorized root must be writable: {out}");
        assert!(!sibling_ok, "the sibling repository must stay refused");
        assert!(
            !prefix_ok,
            "obs-forwarder-backup shares a prefix and must still be refused"
        );
        assert!(!sibling.join("pwned.txt").exists());
        assert!(!prefix_sibling.join("pwned.txt").exists());
    }

    /// Reading, not just writing: a server that could read the repository next
    /// door has already exfiltrated it.
    #[tokio::test]
    async fn a_sibling_repository_cannot_even_be_read() {
        if !backend().enforces() {
            return;
        }
        let (authority, _, sibling, _) = fixture();
        std::fs::write(sibling.join("secret.env"), "TOKEN=leak-me").expect("seed");

        let (ok, out) =
            run_under(&authority, &format!("cat {}/secret.env", sibling.display())).await;

        assert!(!ok, "the sibling repository must not be readable");
        assert!(!out.contains("leak-me"), "sibling contents leaked: {out}");
    }
}
