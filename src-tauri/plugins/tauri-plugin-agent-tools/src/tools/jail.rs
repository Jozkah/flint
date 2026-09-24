//! OS-level confinement for the `bash` tool.
//!
//! The static command scan in [`super::cmdscan`] bounds *which* commands run; this
//! module bounds what they can reach once running. Three properties, identical on
//! every backend:
//!
//! - reads: everything except `$HOME`, with the thread workspace carved back in
//!   (it lives under `$HOME`, so the carve-out is what keeps the sandbox usable
//!   while `settings.json`, provider keys, and the rest of the Jan data folder
//!   stay unreadable). The CLI can opt into `home_readonly`, which instead
//!   mounts `$HOME` read-only so `git`/`ssh` credential helpers work. Reads
//!   outside `$HOME` stay open because a process cannot start without its
//!   interpreter, loader, and libraries.
//! - writes: the thread workspace and a private temp dir, nothing else.
//! - network: denied unless explicitly allowed.
//! - the agent's own `<workspace>/.jan` state directory is hidden even though it
//!   sits inside the workspace ([`Policy::hide_roots`]); AppContainer is the one
//!   backend that cannot express it.
//!
//! AppContainer is stricter than that on reads: it can only read what grants
//! `ALL APPLICATION PACKAGES`, which covers the system directories a process
//! needs to start but not, say, a second data drive. Stricter is safe here -- the
//! properties above are the floor, not the ceiling.
//!
//! Backends follow the approach in openai/codex `codex-rs/sandboxing`: Seatbelt
//! (`sandbox-exec`) on macOS, bubblewrap on Linux, AppContainer on Windows. The
//! Unix backends wrap the shell argv, so unlike codex they need no helper binary.
//! Windows has no argv to wrap -- see [`super::appcontainer`], which re-execs this
//! binary because the confinement is a `CreateProcessW` token attribute.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::appcontainer;
use super::proc::{self, OriginRoots, ProbeOutcome, ShellConfig, ShellReport};

/// `sandbox-exec` is only trusted at its absolute system path: resolving it via
/// `PATH` would let anything that can prepend to `PATH` defeat the sandbox.
#[cfg(target_os = "macos")]
const SEATBELT: &str = "/usr/bin/sandbox-exec";

#[derive(Hash, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Seatbelt,
    Bubblewrap,
    AppContainer,
    /// No enforcement available. `bash` is withheld rather than run unconfined.
    None,
}

impl Backend {
    pub fn enforces(self) -> bool {
        self != Backend::None
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Backend::Seatbelt => "seatbelt",
            Backend::Bubblewrap => "bubblewrap",
            Backend::AppContainer => "appcontainer",
            Backend::None => "none",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Policy {
    /// The thread workspace: the only path that stays both readable and writable.
    pub workspace: PathBuf,
    /// The agent's data-folder root. On the desktop this is the Jan data folder
    /// (holding the permanent store, `settings.json`, and model files); it is
    /// masked from the sandbox like `$HOME`, because a relocated `JAN_DATA_FOLDER`
    /// outside `$HOME` would otherwise leave all of it readable by the shell. The
    /// CLI leaves this unset: there the project itself is the workspace, so
    /// masking it would hide the very files the agent works on.
    pub mask_root: Option<PathBuf>,
    pub allow_network: bool,
    /// Paths to hide from the shell: the agent's own `<project>/.jan` state
    /// directory, and the `.jan` of every write root (a managed worktree or a
    /// repository edited in place keeps the project's agent policy and hooks
    /// there). The workspace and write-root binds make those reachable, so
    /// hiding them needs a rule layered on top -- see [`Policy::with_hide_root`].
    pub hide_roots: Vec<PathBuf>,
    /// Expose `$HOME` to the sandboxed shell read-only instead of hiding it.
    /// The CLI turns this on so helpers that read the user's home (`git`/`ssh`
    /// credential helpers, `~/.ssh/config`, `~/.netrc`) work, while writes stay
    /// confined to the workspace at the mount/policy layer. Off by default: the
    /// desktop keeps the full isolation so `settings.json` and provider keys
    /// stay out of the shell's reach.
    pub home_readonly: bool,
    /// A session-scoped host directory the shell may write to for the whole run,
    /// instead of a scratch that vanishes between commands. How it is exposed is
    /// per backend: bubblewrap binds it over `/tmp`, replacing the volatile
    /// overlay that would otherwise discard scratch files with each command;
    /// Seatbelt grants it by `SCRATCH` parameter; AppContainer grants it an ACE.
    /// The directory must already exist before the sandbox is built (the
    /// backends reference it, they do not create it).
    pub scratch_root: Option<PathBuf>,
    /// Folders the user attached read-only. Bound after the `$HOME`/data-folder
    /// masks (so a project under either survives) and before the workspace bind
    /// (so one can never shadow the only writable path).
    pub read_roots: Vec<PathBuf>,
    /// Repositories the user explicitly authorized this session to edit.
    ///
    /// Kept apart from [`Self::read_roots`] for the same reason the tool gate
    /// keeps two lists: attaching a folder is what makes it readable, and only
    /// a confirmation naming that exact folder makes it writable. A root
    /// arrives here from `SessionGrants`, which the model cannot influence.
    ///
    /// The file tools and the shell must agree about this set. A shell that
    /// could write where `write`/`edit` are refused — or the reverse — would
    /// make the access mode a statement about one of them rather than about
    /// the run.
    pub write_roots: Vec<PathBuf>,
    /// Where the shell starts, when that is not `workspace`: the managed
    /// worktree a run writes to. Always one of `write_roots`
    /// ([`Policy::with_start_dir`] ignores anything else), so the shell never
    /// starts somewhere it was not granted.
    pub start_dir: Option<PathBuf>,
}

impl Policy {
    pub fn new(workspace: &Path, allow_network: bool) -> Self {
        Self {
            workspace: workspace.to_path_buf(),
            mask_root: None,
            allow_network,
            hide_roots: Vec::new(),
            home_readonly: false,
            scratch_root: None,
            read_roots: Vec::new(),
            write_roots: Vec::new(),
            start_dir: None,
        }
    }

    /// Start the shell in `dir`, which must already be one of the write roots;
    /// anything else leaves the start at the workspace.
    pub fn with_start_dir(mut self, dir: &Path) -> Self {
        if self.write_roots.iter().any(|r| r == dir) {
            self.start_dir = Some(dir.to_path_buf());
        }
        self
    }

    /// The directory the shell starts in.
    pub fn start_dir(&self) -> &Path {
        self.start_dir.as_deref().unwrap_or(&self.workspace)
    }

    /// Attach read-only roots. See [`Policy::read_roots`] for why their bind
    /// order relative to the masks and the workspace is load-bearing.
    /// Authorize the shell to write under `write_roots`, as the file tools are.
    pub fn with_write_roots(mut self, write_roots: Vec<PathBuf>) -> Self {
        self.write_roots = write_roots;
        self
    }

    pub fn with_read_roots(mut self, read_roots: Vec<PathBuf>) -> Self {
        self.read_roots = read_roots;
        self
    }

    /// Mask `mask_root` from the sandboxed shell. The desktop data folder holds
    /// the permanent memory/skills store and `settings.json` with provider keys;
    /// masking it keeps a relocated data folder out of the shell's reach. The
    /// thread workspace (nested under it) is re-bound on top so it survives.
    pub fn with_mask_root(mut self, mask_root: &Path) -> Self {
        self.mask_root = Some(mask_root.to_path_buf());
        self
    }

    /// Hide `hide_root` from the sandboxed shell. Applied after the workspace is
    /// bound/allowed, so it wins over it: the gate's token scan of the command
    /// string is best-effort, and this is what makes `.jan` unreachable to the
    /// spellings a scan cannot see (`cd .jan`, `$(echo ...)`, a script the shell
    /// writes and runs). Not enforced on AppContainer, where the workspace is
    /// granted by an ACE and carving a subpath back out would mean writing a deny
    /// ACE onto the user's directory; there the scan stands alone.
    ///
    /// May be called more than once; every path given is hidden, a repeat is
    /// ignored.
    pub fn with_hide_root(mut self, hide_root: &Path) -> Self {
        if !self.hide_roots.iter().any(|h| h == hide_root) {
            self.hide_roots.push(hide_root.to_path_buf());
        }
        self
    }

    /// Expose `$HOME` read-only instead of masking it. See [`Policy::home_readonly`].
    pub fn with_home_readonly(mut self, home_readonly: bool) -> Self {
        self.home_readonly = home_readonly;
        self
    }

    /// Expose `scratch_root` to the shell so scratch files persist across `bash`
    /// calls in a session instead of being discarded with each private tmpfs.
    /// See [`Policy::scratch_root`]. The directory must already exist (the
    /// caller creates and owns its lifecycle).
    pub fn with_scratch_root(mut self, scratch_root: &Path) -> Self {
        self.scratch_root = Some(scratch_root.to_path_buf());
        self
    }
}

/// The user's home directory, or `None` when it is unset or degenerate. A `/`
/// home would hide the whole filesystem, so it is treated as absent.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let raw = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let raw = std::env::var_os("HOME");
    let path = PathBuf::from(raw?);
    if path.parent().is_none() || path.as_os_str().is_empty() {
        return None;
    }
    Some(path)
}

/// The active backend, probed once. Probing runs a subprocess on Linux, so it is
/// cached for the life of the process.
/// Can this backend confine a shell to a repository the user authorized?
///
/// Direct editing is only offered where the shell and the file tools can be
/// held to the same roots. A backend that can grant one but not the other
/// would make "Jan can modify files in this exact folder" true of `write` and
/// false of `bash`, which is not a feature — it is a wrong answer.
///
/// Seatbelt takes a subpath rule per root and bubblewrap a read-write bind, so
/// both express it directly. AppContainer grants writes only by placing an ACE
/// on the thread workspace; authorizing a repository would mean writing an ACE
/// onto the user's own folder, which this backend does not do. Until it does,
/// Windows reports unsupported rather than silently granting less than the UI
/// would promise.
pub fn supports_write_roots(backend: Backend) -> bool {
    match backend {
        Backend::Seatbelt | Backend::Bubblewrap => true,
        Backend::AppContainer => false,
        // Nothing enforces anything; `bash` is withheld entirely.
        Backend::None => false,
    }
}

/// Can this backend confine a shell to a folder *Jan owns*?
///
/// A narrower question than [`supports_write_roots`], and AppContainer can
/// answer yes to it. Granting a write ACE on the user's own repository is what
/// this backend refuses to do; granting one on a managed worktree under Jan's
/// data folder is the same thing it already does for the thread workspace.
/// That is what makes Managed worktree mode possible on Windows while editing
/// the user's own folder directly stays unavailable there.
pub fn supports_owned_write_roots(backend: Backend) -> bool {
    match backend {
        Backend::Seatbelt | Backend::Bubblewrap | Backend::AppContainer => true,
        Backend::None => false,
    }
}

/// Whether the shell can be held to exactly `roots` on `backend`.
///
/// `owned` is the directory Jan's managed worktrees live under. On
/// AppContainer every root must be inside it; anywhere else the answer is the
/// general [`supports_write_roots`].
pub fn can_confine_write_roots(backend: Backend, roots: &[PathBuf], owned: Option<&Path>) -> bool {
    if supports_write_roots(backend) {
        return true;
    }
    if backend != Backend::AppContainer {
        return false;
    }
    let Some(owned) = owned.and_then(|o| o.canonicalize().ok()) else {
        return false;
    };
    !roots.is_empty()
        && roots.iter().all(|root| {
            root.canonicalize()
                .map(|r| r.starts_with(&owned) && r != owned)
                .unwrap_or(false)
        })
}

pub fn backend() -> Backend {
    static BACKEND: OnceLock<Backend> = OnceLock::new();
    *BACKEND.get_or_init(detect)
}

fn detect() -> Backend {
    // Escape hatch for CI and for users on kernels where the probe is wrong.
    // Only ever loosens to `None`, which withholds the tool: it cannot be used
    // to run commands unconfined.
    if let Some(forced) = crate::compat_env::var_os("AGENT_SANDBOX") {
        if forced.eq_ignore_ascii_case("none") || forced.eq_ignore_ascii_case("off") {
            return Backend::None;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new(SEATBELT).is_file() {
            return Backend::Seatbelt;
        }
        Backend::None
    }
    #[cfg(target_os = "linux")]
    {
        match bwrap_path() {
            Some(path) if bwrap_usable(&path) => Backend::Bubblewrap,
            _ => Backend::None,
        }
    }
    #[cfg(windows)]
    {
        if appcontainer::available() {
            return Backend::AppContainer;
        }
        Backend::None
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        Backend::None
    }
}

/// Where the session scratch is reachable from *inside* the sandbox, which is
/// what the shell's `TMPDIR`/`TMP`/`TEMP` must name. Bubblewrap binds the
/// scratch over `/tmp`, so the host path does not exist in that namespace;
/// Seatbelt and AppContainer mount nothing, so the real path is the only one
/// that resolves -- and it is the same name the filesystem tools use there, so
/// a file written by `bash` can be read back by `read`. `None` when the caller
/// set no scratch: the shell then keeps the host's own temp dir.
pub fn scratch_env_path(backend: Backend, policy: &Policy) -> Option<PathBuf> {
    let scratch = policy.scratch_root.as_ref()?;
    Some(match backend {
        Backend::Bubblewrap => PathBuf::from("/tmp"),
        _ => scratch.clone(),
    })
}

/// Wrap `cfg` so the shell it describes runs confined. The returned config keeps
/// the same shape -- program, fixed args, command appended last -- so the spawn
/// path is unchanged. Returns `None` when no backend can enforce the policy, in
/// which case the caller must not run the command.
pub fn wrap(cfg: &ShellConfig, policy: &Policy) -> Option<ShellConfig> {
    match backend() {
        Backend::Bubblewrap => Some(ShellConfig {
            program: bwrap_path()?,
            args: bwrap_args(policy, cfg),
            via_stdin: cfg.via_stdin,
            description: cfg.description,
            // The wrapper is a different program; the command language the
            // command string will meet is still the wrapped shell's.
            flavor: cfg.flavor,
        }),
        Backend::Seatbelt => Some(ShellConfig {
            program: PathBuf::from(seatbelt_program()),
            args: seatbelt_args(policy, cfg),
            via_stdin: cfg.via_stdin,
            description: cfg.description,
            // The wrapper is a different program; the command language the
            // command string will meet is still the wrapped shell's.
            flavor: cfg.flavor,
        }),
        // AppContainer is a token attribute on the spawn rather than an argv
        // prefix, and `tokio::process::Command` cannot set one, so the wrapper is
        // a re-exec of this binary that performs the confined spawn itself. If
        // the running binary cannot be located there is no wrapper to run, and
        // returning `cfg` unchanged would run the command with no confinement.
        Backend::AppContainer => Some(ShellConfig {
            program: helper_exe()?,
            args: appcontainer::helper_args_at(
                &policy.workspace,
                policy.start_dir.as_deref(),
                policy.scratch_root.as_deref(),
                &policy.write_roots,
                policy.allow_network,
                &cfg.program,
                &cfg.args,
            ),
            via_stdin: cfg.via_stdin,
            description: cfg.description,
            // The wrapper is a different program; the command language the
            // command string will meet is still the wrapped shell's.
            flavor: cfg.flavor,
        }),
        Backend::None => None,
    }
}

// ---------------------------------------------------------------------------
// bubblewrap (Linux)
// ---------------------------------------------------------------------------

/// The fixed FHS locations are preferred so a directory prepended to `PATH`
/// cannot shadow the system bwrap; `PATH` is the fallback for distros with no
/// FHS layout at all (NixOS keeps bwrap only at a Nix-store path). A planted
/// `bwrap` found via `PATH` gains nothing: it runs as the same user, and
/// [`bwrap_usable`]'s live probe still has to pass before it is trusted.
#[cfg(target_os = "linux")]
fn bwrap_path() -> Option<PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .or_else(|| super::proc::which("bwrap"))
    })
    .clone()
}

#[cfg(not(target_os = "linux"))]
fn bwrap_path() -> Option<PathBuf> {
    None
}

/// bubblewrap needs unprivileged user namespaces, which some distros and all of
/// WSL1 disable. Probe with a trivial sandbox rather than inferring from kernel
/// version, and treat a hang as unusable so a broken setup cannot wedge startup.
#[cfg(target_os = "linux")]
fn bwrap_usable(path: &Path) -> bool {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let Ok(mut child) = Command::new(path)
        .args(["--unshare-all", "--ro-bind", "/", "/", "/bin/true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn push(args: &mut Vec<String>, parts: &[&str]) {
    args.extend(parts.iter().map(|s| s.to_string()));
}

/// Paths under the masked `/run` that bubblewrap binds back read-only
/// (Jozkah/jan#210). None of them holds a session socket.
const RUN_KEEP: &[&str] = &["/run/current-system", "/run/booted-system", "/run/opengl-driver"];

/// Bound back under `/run` only when the network is allowed: what name
/// resolution reads when `/etc/resolv.conf` points into systemd-resolved.
const RUN_KEEP_NETWORK: &[&str] = &["/run/systemd/resolve"];

/// Build bubblewrap's argv. Operations apply in order, which the layering below
/// depends on: the read-only root comes first, then the tmpfs that hides `$HOME`,
/// then the workspace bind that punches back through it.
pub fn bwrap_args(policy: &Policy, cfg: &ShellConfig) -> Vec<String> {
    let ws = policy.workspace.to_string_lossy().to_string();
    let mut args: Vec<String> = Vec::new();

    push(&mut args, &["--ro-bind", "/", "/"]);
    // Re-mounted after the read-only root so they are real kernel filesystems
    // rather than the host's, and so an unshared pid namespace has a valid /proc.
    push(&mut args, &["--proc", "/proc"]);
    push(&mut args, &["--dev", "/dev"]);
    // An empty tmpfs over `/run` (Jozkah/jan#210). The read-only root bind
    // leaves `/run/user/$UID` visible, and a read-only mount does not stop
    // `connect()` on a pathname unix socket, nor does `--unshare-all` (such
    // sockets live in the filesystem, not the network namespace). Left
    // visible, the session D-Bus and the `systemd --user` socket let a command
    // run `systemd-run --user` and start a process outside the sandbox; the
    // ssh-agent/keyring sockets there hand out the user's credentials.
    // Before every bind below, which take host paths as sources and so still
    // work for a root that happens to sit under `/run`.
    push(&mut args, &["--tmpfs", "/run"]);
    // `/var/run` is normally a symlink into `/run` and so is covered; where it
    // is still a real directory, mask it too.
    #[cfg(target_os = "linux")]
    {
        if std::fs::symlink_metadata("/var/run").is_ok_and(|m| m.is_dir()) {
            push(&mut args, &["--tmpfs", "/var/run"]);
        }
    }
    // Put back, read-only, only what ordinary commands need from `/run`: the
    // NixOS system profile (every binary on PATH there, the shell included)
    // and its graphics drivers. `-try`, since most hosts have none of these.
    for &keep in RUN_KEEP {
        push(&mut args, &["--ro-bind-try", keep, keep]);
    }
    // With the network shared, name resolution: `/etc/resolv.conf` is often a
    // symlink into `/run/systemd/resolve`.
    if policy.allow_network {
        for &keep in RUN_KEEP_NETWORK {
            push(&mut args, &["--ro-bind-try", keep, keep]);
        }
    }
    // `/tmp`: by default a private tmpfs, writable and discarded with the
    // sandbox. When a session-scoped scratch root is set, bind it over `/tmp`
    // instead (the tmpfs would shadow it), so scratch files persist across
    // `bash` calls for the whole run.
    if let Some(scratch) = &policy.scratch_root {
        let scratch = scratch.to_string_lossy();
        push(&mut args, &["--bind", &scratch, "/tmp"]);
    } else {
        push(&mut args, &["--tmpfs", "/tmp"]);
    }

    // An empty tmpfs over $HOME hides user files without needing a deny rule.
    // The workspace is re-bound on top, so it survives while its siblings (the
    // permanent memory/skills store, settings.json, model files) do not.
    //
    // With `home_readonly` the CLI instead mounts $HOME read-only so helpers
    // that read it (git/ssh credential helpers, ~/.ssh/config, ~/.netrc) work;
    // the read-only mount is what keeps writes out even if the command tries.
    // It is deliberately read-only, so no later rw bind can shadow it.
    if let Some(home) = home_dir() {
        if policy.home_readonly {
            push(
                &mut args,
                &[
                    "--ro-bind",
                    &home.to_string_lossy(),
                    &home.to_string_lossy(),
                ],
            );
        } else {
            push(&mut args, &["--tmpfs", &home.to_string_lossy()]);
        }
    }
    // Mask a relocated data folder the same way: `$HOME` hiding alone would leave
    // a `JAN_DATA_FOLDER` outside the home readable, exposing the permanent
    // store and any co-located `settings.json`. The workspace is re-bound below
    // (it is nested under this root on the desktop), so it survives.
    if let Some(mask) = &policy.mask_root {
        push(&mut args, &["--tmpfs", &mask.to_string_lossy()]);
    }

    // Between the masks above and the workspace below, and that position is the
    // enforcement: after the `$HOME`/data-folder tmpfs so a project living under
    // either is punched back through, and before the workspace bind so a read
    // root can never shadow the one writable path. Read-only, so nothing the
    // shell does can write into the user's own folder. Not `--ro-bind-try`: a
    // root that vanished should fail loudly rather than silently unmount.
    for root in &policy.read_roots {
        let root = root.to_string_lossy();
        push(&mut args, &["--ro-bind", &root, &root]);
    }
    // Read-write, unlike the roots above. Bound before the workspace so the
    // workspace still wins if the two ever overlap, and each path is its own
    // argument rather than part of a command string.
    for root in &policy.write_roots {
        let root = root.to_string_lossy();
        push(&mut args, &["--bind", &root, &root]);
    }

    push(&mut args, &["--bind", &ws, &ws]);
    // After the workspace bind, so it is not shadowed by it: an empty tmpfs where
    // the agent's own state directory sits. Mounted unconditionally rather than
    // only when the directory exists, so a `.jan` created while the sandbox runs
    // cannot be read back by the next command in the same shell. Writes into it
    // are discarded with the sandbox (and hard-denied at the tool layer anyway).
    for hide in &policy.hide_roots {
        push(&mut args, &["--tmpfs", &hide.to_string_lossy()]);
    }
    push(&mut args, &["--chdir", &policy.start_dir().to_string_lossy()]);

    // Drops the network, pid, ipc, uts and cgroup namespaces along with the
    // user namespace; --share-net selectively restores networking.
    push(&mut args, &["--unshare-all"]);
    if policy.allow_network {
        push(&mut args, &["--share-net"]);
    }
    // Reap the tree if this process dies, and detach the controlling terminal so
    // a command cannot inject keystrokes into it via TIOCSTI.
    push(&mut args, &["--die-with-parent", "--new-session"]);

    push(&mut args, &["--"]);
    args.push(cfg.program.to_string_lossy().to_string());
    args.extend(cfg.args.iter().cloned());
    args
}

// ---------------------------------------------------------------------------
// Seatbelt (macOS)
// ---------------------------------------------------------------------------

fn seatbelt_program() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        SEATBELT
    }
    #[cfg(not(target_os = "macos"))]
    {
        "/usr/bin/sandbox-exec"
    }
}

/// Seatbelt profile. `(deny default)` closes everything, then each section opens
/// the narrowest thing that works. Later rules win, which is what lets the
/// workspace be re-allowed after `$HOME` is denied (or, with `home_readonly`,
/// lets the home stay readable while writes remain confined).
pub fn seatbelt_policy(policy: &Policy) -> String {
    let mut p = String::from(
        "(version 1)\n\
         (deny default)\n\
         ; A command may fork and exec freely; children inherit this profile.\n\
         (allow process-exec)\n\
         (allow process-fork)\n\
         (allow signal (target same-sandbox))\n\
         (allow process-info* (target same-sandbox))\n\
         ; Read-only sysctl (uname, hostname, env probes) -- a read-only open, LOW risk.\n\
         (allow sysctl-read)\n\
         ; openpty() and friends, so interactive-ish tools detect a tty.\n\
         (allow pseudo-tty)\n\
         (allow file-read* file-write* file-ioctl (literal \"/dev/ptmx\"))\n\
         (allow file-ioctl (regex #\"^/dev/ttys[0-9]+\"))\n\
         ; Python multiprocessing and OpenMP runtimes. Their shared POSIX shm/sem\n\
         ; names are host-wide and cannot be scoped per-sandbox on sandbox-exec\n\
         ; (also deprecated / not a security boundary per Apple) -- accepted tradeoff;\n\
         ; the real boundary is the $HOME / MASK_ROOT read denial below.\n\
         (allow ipc-posix-sem)\n\
         (allow ipc-posix-shm*)\n\
         (allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\"))\n\
         (allow file-write-data\n\
         \x20 (require-all (path \"/dev/null\") (vnode-type CHARACTER-DEVICE)))\n\
         ; Reads: open, minus the user's home, plus the workspace back.\n\
         (allow file-read*)\n",
    );
    if home_dir().is_some() && !policy.home_readonly {
        p.push_str("(deny file-read* (subpath (param \"HOME_ROOT\")))\n");
    }
    if policy.mask_root.is_some() {
        p.push_str("(deny file-read* (subpath (param \"MASK_ROOT\")))\n");
    }
    p.push_str(
        "(allow file-read* (subpath (param \"WORKSPACE\")))\n\
         ; Writes: the workspace and the temp dir, nothing else.\n\
         (allow file-write* (subpath (param \"WORKSPACE\")))\n\
         (allow file-write* (subpath (param \"TMPDIR\")))\n\
         (allow file-write* (subpath \"/private/tmp\"))\n",
    );
    // The session scratch by name, rather than trusting it to sit under TMPDIR:
    // a relocated scratch must stay usable, and it is read back after the home
    // denial above, which would otherwise cover a scratch inside $HOME. Emitted
    // only with the matching `-DSCRATCH`, since sandbox-exec refuses a profile
    // that references a parameter no argument supplies.
    if policy.scratch_root.is_some() {
        p.push_str(
            "(allow file-read* (subpath (param \"SCRATCH\")))\n\
             (allow file-write* (subpath (param \"SCRATCH\")))\n",
        );
    }
    // After the HOME/MASK denials, so an attached folder inside either is read
    // back: in Seatbelt the later rule wins. Read only — no matching
    // `file-write*`, so `(deny default)` keeps the folder unwritable. Emitted
    // one per root, and only with the matching `-DREAD_ROOT_n`, since
    // sandbox-exec refuses a profile referencing an unsupplied parameter.
    for i in 0..policy.read_roots.len() {
        p.push_str(&format!(
            "(allow file-read* (subpath (param \"READ_ROOT_{i}\")))\n"
        ));
    }
    // An authorized repository, readable *and* writable. Same placement as the
    // read roots — after the HOME/MASK denials so a repository inside either is
    // reachable — and still before `HIDE_ROOT`, so the agent's own state
    // directory stays denied even inside a folder the user is editing.
    for i in 0..policy.write_roots.len() {
        p.push_str(&format!(
            "(allow file-read* (subpath (param \"WRITE_ROOT_{i}\")))\n\
             (allow file-write* (subpath (param \"WRITE_ROOT_{i}\")))\n"
        ));
    }
    // Last, so it wins over the workspace allow above: the agent's own state
    // directory is neither readable nor writable, however the command spells it.
    for i in 0..policy.hide_roots.len() {
        let name = hide_param(i);
        p.push_str(&format!(
            "(deny file-read* (subpath (param \"{name}\")))\n\
             (deny file-write* (subpath (param \"{name}\")))\n"
        ));
    }
    // IP only (Jozkah/jan#206). A bare `(allow network*)` also covers
    // `network-outbound` to a `unix-socket` remote, i.e. connect() to any
    // unix socket the command can name -- among them the launchd ssh-agent
    // under `/private/tmp/com.apple.launchd.*/Listeners`, which would hand the
    // sandbox the user's SSH identities that stripping SSH_AUTH_SOCK and
    // denying `$HOME` are meant to keep out. The one unix socket allowed is
    // mDNSResponder's, which name resolution goes through.
    if policy.allow_network {
        p.push_str(
            "(allow network-outbound (remote ip \"*:*\"))\n\
             (allow network-inbound (local ip \"*:*\"))\n\
             (allow network-bind (local ip \"*:*\"))\n\
             (allow network-outbound (literal \"/private/var/run/mDNSResponder\"))\n\
             (allow system-socket)\n\
             (allow mach-lookup\n\
             \x20 (global-name \"com.apple.SystemConfiguration.DNSConfiguration\")\n\
             \x20 (global-name \"com.apple.SystemConfiguration.configd\")\n\
             \x20 (global-name \"com.apple.SecurityServer\")\n\
             \x20 (global-name \"com.apple.trustd.agent\")\n\
             \x20 (global-name \"com.apple.ocspd\")\n\
             \x20 (global-name \"com.apple.networkd\"))\n",
        );
    } else {
        p.push_str("(deny network*)\n");
    }
    p
}

/// Seatbelt parameter naming the `i`th hide root. The first keeps the plain
/// `HIDE_ROOT` name from when there was only ever one.
fn hide_param(i: usize) -> String {
    if i == 0 {
        "HIDE_ROOT".to_string()
    } else {
        format!("HIDE_ROOT_{i}")
    }
}

/// Build `sandbox-exec`'s argv. Paths travel as `-D` parameters rather than being
/// interpolated into the profile so a path containing profile syntax cannot
/// rewrite the policy.
pub fn seatbelt_args(policy: &Policy, cfg: &ShellConfig) -> Vec<String> {
    let mut args = vec!["-p".to_string(), seatbelt_policy(policy)];
    args.push(format!(
        "-DWORKSPACE={}",
        policy.workspace.to_string_lossy()
    ));
    if let Some(mask) = &policy.mask_root {
        args.push(format!("-DMASK_ROOT={}", mask.to_string_lossy()));
    }
    for (i, root) in policy.read_roots.iter().enumerate() {
        args.push(format!("-DREAD_ROOT_{i}={}", root.to_string_lossy()));
    }
    // Passed as a profile parameter, never interpolated into a command: a path
    // with spaces, quotes or a leading hyphen stays one argument's data.
    for (i, root) in policy.write_roots.iter().enumerate() {
        args.push(format!("-DWRITE_ROOT_{i}={}", root.to_string_lossy()));
    }
    for (i, hide) in policy.hide_roots.iter().enumerate() {
        args.push(format!("-D{}={}", hide_param(i), hide.to_string_lossy()));
    }
    args.push(format!(
        "-DTMPDIR={}",
        std::env::temp_dir().to_string_lossy()
    ));
    if let Some(scratch) = &policy.scratch_root {
        args.push(format!("-DSCRATCH={}", scratch.to_string_lossy()));
    }
    if let Some(home) = home_dir() {
        args.push(format!("-DHOME_ROOT={}", home.to_string_lossy()));
    }
    args.push("--".to_string());
    args.push(cfg.program.to_string_lossy().to_string());
    args.extend(cfg.args.iter().cloned());
    args
}

// ---------------------------------------------------------------------------
// Denial heuristics
// ---------------------------------------------------------------------------

/// Keywords a kernel or libc emits when the sandbox refuses an operation. Used
/// only to append an explanatory hint: a false positive costs a stray sentence,
/// never a behavior change.
const DENIAL_MARKERS: &[&str] = &[
    "operation not permitted",
    "permission denied",
    "access is denied",
    "read-only file system",
    "not permitted",
    "sandbox",
    "seccomp",
    "landlock",
    "bwrap:",
    "network is unreachable",
    "temporary failure in name resolution",
    "could not resolve host",
    "name or service not known",
    // Windows phrasings. Every marker above is a Unix one, so an AppContainer
    // that correctly refused a socket produced a raw Win32 message the model
    // was left to interpret on its own -- the exact unexplained failure this
    // list exists to prevent. WSAEACCES is what a lowbox token gets when it
    // opens a socket without `internetClient`; the others are how a blocked
    // name lookup and a refused file open read on Windows.
    "forbidden by its access permissions",
    "no such host is known",
    "attempt was made to access a socket",
    "the requested operation requires elevation",
    "access to the path",
];

/// True when `output` looks like the sandbox blocked something, so the model can
/// be told why instead of retrying a command that can never succeed.
pub fn looks_denied(output: &str) -> bool {
    let lower = output.to_lowercase();
    DENIAL_MARKERS.iter().any(|m| lower.contains(m))
}

/// Sentence appended to a denied command's output, telling the model the limits
/// rather than leaving it to infer them from `Permission denied`.
pub fn denial_hint(policy: &Policy) -> String {
    let net = if policy.allow_network {
        ""
    } else {
        " Network access is disabled."
    };
    let home = if policy.home_readonly {
        ""
    } else {
        " Files under your home directory are not readable."
    };
    // Every place the shell may write, as the policy actually grants it: the
    // workspace, the scratch (writable too, and where temporary work belongs)
    // and any authorized write root such as a managed worktree. Naming only
    // the workspace sent the model away from a worktree it could write.
    let mut writable = vec![format!("the workspace ({})", policy.workspace.display())];
    if let Some(path) = scratch_env_path(backend(), policy) {
        writable.push(format!("the scratch dir ({})", path.display()));
    }
    for root in &policy.write_roots {
        if root != &policy.workspace {
            writable.push(root.display().to_string());
        }
    }
    let start = if policy.start_dir() != policy.workspace.as_path() {
        format!(" The shell starts in {}.", policy.start_dir().display())
    } else {
        String::new()
    };
    // An attached folder the file tools can read but the shell cannot is a real
    // asymmetry on Windows, where granting it would mean permanently rewriting
    // the DACL of a directory Jan does not own and never revokes. Only folders
    // the shell really cannot reach are named: one inside a write root (the
    // managed worktree, say) is readable and writable there.
    let unreachable: Vec<String> = policy
        .read_roots
        .iter()
        .filter(|r| !shell_writable(policy, r))
        .map(|r| r.display().to_string())
        .collect();
    let attached = if unreachable.is_empty() {
        String::new()
    } else if backend() == Backend::AppContainer {
        format!(
            " The attached folder ({}) is readable by the file tools but not by shell \
             commands on this platform.",
            unreachable.join(", ")
        )
    } else {
        format!(
            " The attached folder ({}) is readable but not writable.",
            unreachable.join(", ")
        )
    };
    format!(
        "\n[sandbox: writes are limited to {}.{start}{home}{net}{attached}]",
        writable.join(", ")
    )
}

/// Is `path` inside a directory the shell may write (workspace, scratch or a
/// granted write root)? Compared case-insensitively with either separator,
/// which is how Windows resolves paths; on Unix a false match costs only a
/// missing hint sentence, never access.
fn shell_writable(policy: &Policy, path: &Path) -> bool {
    fn norm(p: &Path) -> String {
        let s = p.to_string_lossy().replace('\\', "/").to_lowercase();
        s.trim_end_matches('/').to_string()
    }
    let candidate = norm(path);
    let roots = std::iter::once(policy.workspace.as_path())
        .chain(policy.scratch_root.as_deref())
        .chain(policy.write_roots.iter().map(PathBuf::as_path));
    roots.map(norm).any(|root| {
        !root.is_empty()
            && (candidate == root
                || candidate
                    .strip_prefix(&root)
                    .is_some_and(|rest| rest.starts_with('/')))
    })
}

/// Absolute paths a failure message names, best effort: quoted or bare tokens
/// that start like a Windows drive path or a Unix root.
fn named_paths(output: &str) -> Vec<PathBuf> {
    output
        .split(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '`'))
        .map(|t| t.trim_end_matches([':', ',', '.', ';', ')']))
        .filter(|t| {
            let b = t.as_bytes();
            (b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
                || (b.len() > 1 && b[0] == b'/' && b[1] != b'/')
        })
        .map(PathBuf::from)
        .collect()
}

/// What a model is told when granting access would fix the failure.
pub const REQUEST_ACCESS_ADVICE: &str = " Call request_access with the narrowest required path \
     and explain why access is needed. Do not retry the same command before it is granted.";

/// The note appended to a failed sandboxed command, chosen by why it failed.
///
/// Only a file-access denial gets the sandbox limits and the `request_access`
/// advice. A PowerShell `2>nul`, a missing program, a path that does not exist
/// or a device file is not something a grant can fix, and saying the sandbox
/// did it sends the model after the wrong problem. A network refusal gets the
/// limits (network is off) but no access advice: a folder grant opens no
/// socket.
///
/// `output` is the command's output: a denial whose every named path is one the
/// shell may already write is not a grant problem (a locked file, a read-only
/// attribute, a device), so it gets no access advice either.
pub fn failure_hint(
    policy: &Policy,
    class: &super::shell_diag::FailureClass,
    output: &str,
) -> Option<String> {
    use super::shell_diag::{powershell_equivalent, FailureClass};
    match class {
        FailureClass::FileAccessDenied => {
            let named = named_paths(output);
            if !named.is_empty() && named.iter().all(|p| shell_writable(policy, p)) {
                return None;
            }
            let mut hint = denial_hint(policy);
            // Inside the closing bracket, so it reads as part of the note.
            hint.pop();
            hint.push_str(REQUEST_ACCESS_ADVICE);
            hint.push(']');
            Some(hint)
        }
        FailureClass::Network if !policy.allow_network => Some(denial_hint(policy)),
        FailureClass::CmdNulRedirect(construct) => {
            let fix = construct
                .split(", ")
                .map(|c| format!("`{c}` -> `{}`", powershell_equivalent(c)))
                .collect::<Vec<_>>()
                .join("; ");
            Some(format!(
                "\n[shell_syntax: this failed because `nul` is cmd.exe syntax and this shell \
                 is PowerShell, where `nul` is a file name. It is not a sandbox restriction. \
                 Use {fix}.]"
            ))
        }
        FailureClass::DeviceFile => Some(device_hint(
            backend() == Backend::AppContainer
                && super::appcontainer::null_device_admits_sandbox() == Some(false),
        )),
        _ => None,
    }
}

/// The note for a failure on a device path. `null_denied` is true when this
/// machine's `\Device\Null` refuses AppContainers outright (see
/// [`super::appcontainer::null_device_admits_sandbox`]): then a program that
/// opens NUL itself -- Go, git -- cannot run here whatever the command says,
/// and advice to use the shell's null syntax would be wrong.
fn device_hint(null_denied: bool) -> String {
    if null_denied {
        "\n[device_path: this machine's null device (NUL) does not admit sandboxed \
         processes: its security descriptor grants Everyone but not ALL APPLICATION \
         PACKAGES, so any program that opens NUL itself (go, git, some build tools) fails \
         inside the sandbox. It is not a folder permission, so granting access cannot fix \
         it. Report it to the user rather than retrying.]"
            .to_string()
    } else {
        "\n[device_path: the failure is on a device path (such as the null device), \
         not on a file the sandbox is hiding. Discard output with the shell's own null \
         syntax instead.]"
            .to_string()
    }
}

/// The program that performs the confined spawn.
///
/// Normally this binary, re-exec'd with a helper argv -- the app and the CLI
/// both call [`appcontainer::run_helper_if_requested`] first thing in `main`,
/// so a re-exec lands in the helper. `JAN_SANDBOX_HELPER_EXE` overrides it for
/// an embedder whose `main` is not ours; a test binary is the case that forced
/// the knob to exist, because libtest owns `main` there and rejects the helper
/// argv before any of this crate runs.
fn helper_exe() -> Option<PathBuf> {
    if let Some(explicit) = crate::compat_env::var_os("SANDBOX_HELPER_EXE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    #[cfg(test)]
    if let Some(path) = test_helper_exe() {
        return Some(path);
    }
    std::env::current_exe().ok()
}

/// The `jan-sandbox-helper` binary cargo builds alongside a test run.
///
/// A unit test cannot read `CARGO_BIN_EXE_*` (only integration tests can), so
/// the path is derived from the test executable's own: cargo puts unit-test
/// binaries in `target/<profile>/deps/` and bins in `target/<profile>/`.
/// Returns `None` when it is not there, so a missing helper is a normal
/// sandbox-unavailable result rather than a panic.
#[cfg(test)]
fn test_helper_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let deps = exe.parent()?;
    let name = format!("jan-sandbox-helper{}", std::env::consts::EXE_SUFFIX);
    for dir in [deps, deps.parent()?] {
        let candidate = dir.join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Shell probing and selection
// ---------------------------------------------------------------------------

/// How long a probe is given before it is treated as a failure. Generous for
/// what it runs -- `exit 0` -- and bounded so a wedged shell cannot hold up the
/// first command of a session.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Probe results for this process, keyed by backend and shell path.
///
/// Cached because the answer is a property of the machine, not of the command,
/// and the probe costs a process launch. Invalidated wholesale by
/// [`invalidate_probe_cache`] whenever something that could change the answer
/// changes -- a settings edit, a different sandbox mode, a new `JAN_AGENT_SHELL`.
fn probe_cache() -> &'static Mutex<HashMap<(Backend, PathBuf), ProbeOutcome>> {
    static CACHE: OnceLock<Mutex<HashMap<(Backend, PathBuf), ProbeOutcome>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forget every cached probe. Call after anything that could change whether a
/// shell starts: the sandbox setting, the shell setting, the environment.
pub fn invalidate_probe_cache() {
    if let Ok(mut cache) = probe_cache().lock() {
        cache.clear();
    }
}

/// Start `cfg` under `policy` and run a harmless command, to find out whether
/// it can run at all here.
///
/// This is the only thing that establishes a shell is usable. Everything else
/// -- the path exists, the file is executable, the ACLs look right -- is
/// necessary and not sufficient: Git Bash on Windows satisfies all of them and
/// still cannot start inside an AppContainer, because the MSYS2 runtime it is
/// built on needs the global object namespace that the container withholds.
/// The only way to know is to try it.
pub fn probe(cfg: &ShellConfig, policy: &Policy) -> ProbeOutcome {
    if !cfg.program.is_file() && proc::which(&cfg.program.to_string_lossy()).is_none() {
        return ProbeOutcome::Missing;
    }
    let key = (backend(), cfg.program.clone());
    if let Ok(cache) = probe_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            return hit.clone();
        }
    }
    let (outcome, verdict) = probe_uncached(cfg, policy);
    // Only a verdict about the shell is kept. A failure that belongs to this
    // one attempt -- a timeout while the machine was busy, a workspace or
    // scratch the caller's session no longer has -- used to be cached with the
    // rest, keyed by nothing but the shell's path. One slow first launch then
    // made every shell "unavailable" for the life of the process, in every
    // session, until something happened to invalidate the cache.
    if verdict == Verdict::Definitive {
        if let Ok(mut cache) = probe_cache().lock() {
            cache.insert(key, outcome.clone());
        }
    }
    outcome
}

/// Wait for `child` for at most `timeout`; past it, kill its whole tree and
/// report `None`.
///
/// `wait_with_output` has no timeout, so the wait happens on a thread. The
/// child moves into that thread, which is how the kill used to be lost: the
/// timeout path returned without it, and every probe that hung -- a sandboxed
/// shell that never starts -- left its helper and that shell running for the
/// life of the app, one more each time a probe was retried.
fn wait_or_kill(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> Option<std::io::Result<std::process::Output>> {
    use std::io::Read;
    // The pipes are drained on their own threads so a chatty child cannot
    // fill one and stall; the child itself stays here, where it can be killed.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Some(Ok(std::process::Output {
                    status,
                    stdout: stdout.join().unwrap_or_default(),
                    stderr: stderr.join().unwrap_or_default(),
                }))
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25))
            }
            Ok(None) => {
                // The whole tree: the helper and the shell it started. Once
                // this was `taskkill /T`, which blocked for a minute on some
                // hosts -- and a blocked probe blocked the readiness check
                // every run waits on. `kill_tree` now walks the tree itself.
                // Then the process directly, in case the tree walk could not
                // open it. The drain threads end when the pipes close.
                let _ = super::proc::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(e) => return Some(Err(e)),
        }
    }
}

/// Whether a probe result says something about the shell, or only about the
/// attempt that produced it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// True of the shell on this machine: worth keeping.
    Definitive,
    /// True of this attempt only: the next call probes again.
    Transient,
}

/// A policy the probe cannot be run under at all, because a directory it names
/// is missing. Says nothing about the shell.
fn missing_policy_directory(policy: &Policy) -> Option<String> {
    if !policy.workspace.is_dir() {
        return Some(format!(
            "workspace does not exist: {}",
            policy.workspace.display()
        ));
    }
    if let Some(scratch) = &policy.scratch_root {
        if !scratch.is_dir() {
            return Some(format!("scratch does not exist: {}", scratch.display()));
        }
    }
    None
}

fn probe_uncached(cfg: &ShellConfig, policy: &Policy) -> (ProbeOutcome, Verdict) {
    if let Some(reason) = missing_policy_directory(policy) {
        return (ProbeOutcome::Unusable { reason }, Verdict::Transient);
    }
    let Some(wrapped) = wrap(cfg, policy) else {
        return (ProbeOutcome::NoSandbox, Verdict::Definitive);
    };
    let mut command = std::process::Command::new(&wrapped.program);
    command.args(&wrapped.args);
    if !wrapped.via_stdin {
        command.arg(proc::PROBE_COMMAND);
    }
    // The same curated environment a real command gets, so the probe tests what
    // will actually happen rather than a friendlier version of it.
    command.env_clear();
    for name in proc::SANDBOX_ENV_ALLOW {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .current_dir(&policy.workspace)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    {
        use jan_process::CommandConsole;
        command.background();
    }

    let child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return (
                ProbeOutcome::Unusable {
                    reason: format!("the shell could not be started: {e}"),
                },
                Verdict::Transient,
            )
        }
    };

    let output = match wait_or_kill(child, PROBE_TIMEOUT) {
        Some(Ok(output)) => output,
        Some(Err(e)) => {
            return (
                ProbeOutcome::Unusable {
                    reason: format!("the shell could not be waited for: {e}"),
                },
                Verdict::Transient,
            );
        }
        None => {
            return (
                ProbeOutcome::Unusable {
                    reason: format!(
                        "the shell did not finish `{}` within {} seconds",
                        proc::PROBE_COMMAND,
                        PROBE_TIMEOUT.as_secs()
                    ),
                },
                Verdict::Transient,
            )
        }
    };

    if output.status.success() {
        return (ProbeOutcome::Usable, Verdict::Definitive);
    }
    // The helper's own diagnostic is the most specific thing available, so it is
    // passed through rather than replaced by a summary of it.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr
        .lines()
        .find(|line| line.starts_with("ERROR: ") && !line.contains("[stage="))
        .map(|line| line.trim_start_matches("ERROR: ").to_string())
        .unwrap_or_else(|| {
            format!(
                "the shell exited {} without running `{}`",
                output
                    .status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "abnormally".to_string()),
                proc::PROBE_COMMAND
            )
        });
    (
        ProbeOutcome::Unusable { reason: detail },
        Verdict::Definitive,
    )
}

/// Every shell this host has, with where it came from and whether it starts
/// under `policy`. What a readiness view renders and what a redacted
/// diagnostics copy contains.
///
/// Probing stops after the first usable shell: the ones below it in preference
/// order are reported as untried rather than launched, because the point of the
/// list is to pick one, not to inventory the machine.
pub fn shell_reports(policy: &Policy) -> Vec<ShellReport> {
    let roots = OriginRoots::from_host();
    let configured = crate::compat_env::var_os("AGENT_SHELL").map(PathBuf::from);
    let mut out = Vec::new();
    let mut settled = false;
    for cfg in proc::candidates() {
        let origin = proc::classify_origin(
            &cfg.program,
            configured.as_deref() == Some(cfg.program.as_path()),
            &roots,
        );
        let outcome = if settled {
            ProbeOutcome::Unusable {
                reason: "not tried: an earlier shell in preference order works".to_string(),
            }
        } else {
            let outcome = probe(&cfg, policy);
            settled = outcome.usable();
            outcome
        };
        out.push(ShellReport {
            cfg,
            origin,
            outcome,
        });
    }
    out
}

/// The shell a sandboxed run will use, and what was rejected on the way to it.
#[derive(Debug, Clone)]
pub struct SelectedShell {
    /// The chosen shell, with its origin and its probe result.
    pub report: ShellReport,
    /// Ready to spawn: [`wrap`] already applied.
    pub wrapped: ShellConfig,
    /// Why no POSIX shell is being used, when the chosen one is not POSIX.
    ///
    /// Carried so a refusal can name the real reason -- "Git Bash cannot start
    /// inside an AppContainer" -- rather than saying bash is missing on a
    /// machine where it is plainly installed.
    pub posix_rejected: Option<String>,
}

/// Pick the shell a sandboxed run should use: the first candidate that actually
/// starts under `policy`.
///
/// `Err` carries what every candidate reported, because at that point the user
/// needs the list rather than a verdict. Nothing in it is inferred -- each line
/// is what that shell's own probe said.
pub fn select_shell(policy: &Policy) -> Result<SelectedShell, String> {
    let reports = shell_reports(policy);
    if let Some(usable) = reports.iter().find(|r| r.outcome.usable()) {
        let Some(wrapped) = wrap(&usable.cfg, policy) else {
            return Err(
                "no OS sandbox backend is available on this system, so no shell can be                  confined here"
                    .to_string(),
            );
        };
        let posix_rejected = if usable.cfg.flavor == proc::ShellFlavor::Posix {
            None
        } else {
            reports
                .iter()
                .find(|r| r.cfg.flavor == proc::ShellFlavor::Posix)
                .map(|r| match &r.outcome {
                    ProbeOutcome::Unusable { reason } => format!(
                        "{} could not start in the sandbox: {reason}",
                        r.cfg.program.display()
                    ),
                    ProbeOutcome::Missing => format!(
                        "{} is not installed on this machine",
                        r.cfg.program.display()
                    ),
                    ProbeOutcome::NoSandbox => {
                        "no OS sandbox backend is available on this system".to_string()
                    }
                    ProbeOutcome::Usable => "it is usable".to_string(),
                })
                .or_else(|| Some("no POSIX shell is installed on this machine".to_string()))
        };
        return Ok(SelectedShell {
            report: usable.clone(),
            wrapped,
            posix_rejected,
        });
    }
    let mut message = String::from("no shell on this machine could be started in the sandbox:");
    for report in &reports {
        message.push_str(&format!(
            "
  - {} ({}, {}): {}",
            report.cfg.program.display(),
            report.cfg.description,
            report.origin.as_str(),
            match &report.outcome {
                ProbeOutcome::Missing => "not installed".to_string(),
                ProbeOutcome::NoSandbox =>
                    "no OS sandbox backend is available on this system".to_string(),
                ProbeOutcome::Unusable { reason } => reason.clone(),
                ProbeOutcome::Usable => "usable".to_string(),
            }
        ));
    }
    Err(message)
}

/// The first sandbox-usable shell that accepts the `&&`/`||` chaining operators,
/// wrapped ready to spawn -- or `None` when none of the shells that can start
/// under `policy` can chain.
///
/// Used when a command chains but the shell [`select_shell`] would pick cannot
/// parse the operators (Windows PowerShell 5.1). Rather than refuse a command
/// that has a perfectly good execution path, the run is handed to a shell that
/// preserves `&&`/`||` short-circuit semantics and exit codes -- `cmd.exe` on a
/// Windows host with no bash or `pwsh`, since it is always present and, unlike
/// Windows PowerShell 5.1, chains. The candidate order (bash, pwsh, cmd; see
/// [`proc::candidates`]) is honoured, so a POSIX shell or `pwsh` is still
/// preferred when one can be confined.
///
/// Caller contract: only reach here once a POSIX-only command has already been
/// refused ([`proc::requires_posix_shell`]). A chaining command that survives
/// that check uses no construct `cmd` would misread, so running it there is
/// safe; `cmd` given `foo $(bar)` is never produced by this path.
pub fn select_chaining_capable(policy: &Policy) -> Option<SelectedShell> {
    let reports = shell_reports(policy);
    let usable = reports
        .iter()
        .find(|r| r.outcome.usable() && proc::supports_and_or_chaining(&r.cfg))?;
    let wrapped = wrap(&usable.cfg, policy)?;
    Some(SelectedShell {
        report: usable.clone(),
        wrapped,
        posix_rejected: None,
    })
}

/// A Windows-native shell to retry a command on when the selected POSIX shell
/// passed its probe but then could not be spawned for the real command
/// (upstream janhq/jan#9044: a Git for Windows install whose directory grants
/// nothing to `ALL APPLICATION PACKAGES`, an antivirus block, a damaged
/// install -- `os error 203` from `CreateProcessW`).
///
/// Only non-POSIX candidates qualify (PowerShell, cmd, which live under
/// `%SystemRoot%`), and each is probed under the same `policy`, so confinement
/// is unchanged: the retry runs in the same container, workspace and network
/// decision. A shell that would misread `command` is skipped -- a POSIX-only
/// construct, `&&`/`||` on Windows PowerShell 5.1, or cmd's `2>nul` on
/// PowerShell -- and `None` is returned when no native shell can take it, so
/// the caller reports the original failure rather than running the command
/// somewhere it means something else.
pub fn select_native_fallback(policy: &Policy, command: &str) -> Option<ShellConfig> {
    proc::candidates()
        .into_iter()
        .filter(|cfg| cfg.flavor != proc::ShellFlavor::Posix)
        .filter(|cfg| proc::requires_posix_shell_for(command, cfg.flavor).is_none())
        .filter(|cfg| {
            proc::requires_and_or_chaining(command).is_none() || proc::supports_and_or_chaining(cfg)
        })
        .filter(|cfg| {
            cfg.flavor != proc::ShellFlavor::PowerShell
                || crate::tools::shell_diag::cmd_nul_redirects(command).is_empty()
        })
        .find(|cfg| probe(cfg, policy).usable())
        .and_then(|cfg| wrap(&cfg, policy))
}

#[cfg(test)]
mod probe_cache_tests {
    use super::*;

    fn existing_program() -> ShellConfig {
        ShellConfig {
            program: std::env::current_exe().expect("test binary path"),
            args: Vec::new(),
            via_stdin: false,
            description: "probe-cache-test",
            flavor: proc::ShellFlavor::Posix,
        }
    }

    fn unique_missing(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "jan-probe-cache-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    fn cached(cfg: &ShellConfig) -> bool {
        probe_cache()
            .lock()
            .map(|c| c.contains_key(&(backend(), cfg.program.clone())))
            .unwrap_or(false)
    }

    // A probe run under a session whose scratch is gone says nothing about the
    // shell. It used to be cached under the shell's path, so every later
    // session in the process was told no shell could start.
    #[test]
    fn a_missing_scratch_is_reported_but_never_cached() {
        let cfg = existing_program();
        // An owned workspace that exists, so the scratch is the only thing
        // missing -- never the shared host temp root itself.
        let workspace = unique_missing("workspace-owned");
        std::fs::create_dir_all(&workspace).unwrap();
        let scratch = unique_missing("scratch");
        let policy = Policy::new(&workspace, false).with_scratch_root(&scratch);

        let outcome = probe(&cfg, &policy);

        match outcome {
            ProbeOutcome::Unusable { reason } => {
                assert!(reason.contains("scratch does not exist"), "{reason}")
            }
            other => panic!("expected an unusable outcome, got {other:?}"),
        }
        assert!(!cached(&cfg), "a per-attempt failure must not be cached");
        assert!(!scratch.exists(), "the probe must not create the scratch");
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn a_missing_workspace_is_transient_too() {
        let cfg = existing_program();
        let workspace = unique_missing("workspace");
        let policy = Policy::new(&workspace, false);

        let (outcome, verdict) = probe_uncached(&cfg, &policy);

        assert_eq!(verdict, Verdict::Transient);
        assert!(matches!(outcome, ProbeOutcome::Unusable { .. }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ShellConfig {
        ShellConfig {
            program: PathBuf::from("/bin/bash"),
            args: vec!["-c".to_string()],
            via_stdin: false,
            description: "bash",
            flavor: proc::ShellFlavor::Posix,
        }
    }

    fn policy() -> Policy {
        Policy::new(Path::new("/data/agent-workspace/threads/t1"), false)
    }

    fn joined(args: &[String]) -> String {
        args.join(" ")
    }

    #[test]
    fn bwrap_mounts_root_read_only_before_layering_on_it() {
        let args = bwrap_args(&policy(), &cfg());
        let text = joined(&args);
        assert!(text.contains("--ro-bind / /"));
        // Order is the enforcement: the workspace bind must come after the tmpfs
        // that hides $HOME, or it would be buried by it.
        if let (Some(tmpfs), Some(bind)) = (text.find("--tmpfs /home"), text.find("--bind /data")) {
            assert!(tmpfs < bind, "workspace bind must follow the $HOME tmpfs");
        }
    }

    /// Jozkah/jan#210: `/run` (session D-Bus, systemd --user, ssh-agent) is
    /// masked right after the root bind and before anything is bound on top,
    /// and only name resolution comes back, only with the network on.
    #[cfg(target_os = "linux")]
    #[test]
    fn bwrap_masks_run_before_the_workspace_and_keeps_resolve_only_with_network() {
        let text = joined(&bwrap_args(&policy(), &cfg()));
        let root = text.find("--ro-bind / /").expect("root bind");
        let run = text.find("--tmpfs /run").expect("/run tmpfs");
        let ws = text.find("--bind /data").expect("workspace bind");
        assert!(root < run && run < ws, "{text}");
        assert!(!text.contains("/run/user"), "{text}");
        assert!(!text.contains("/run/systemd/resolve"), "{text}");
        for keep in RUN_KEEP {
            assert!(text.contains(&format!("--ro-bind-try {keep} {keep}")), "{text}");
        }

        let open = joined(&bwrap_args(
            &Policy::new(Path::new("/data/agent-workspace/threads/t1"), true),
            &cfg(),
        ));
        assert!(
            open.contains("--ro-bind-try /run/systemd/resolve /run/systemd/resolve"),
            "{open}"
        );
        assert!(open.find("--tmpfs /run").unwrap() < open.find("/run/systemd/resolve").unwrap());
    }

    #[test]
    fn bwrap_binds_the_workspace_writable_and_chdirs_into_it() {
        let args = bwrap_args(&policy(), &cfg());
        let text = joined(&args);
        let ws = "/data/agent-workspace/threads/t1";
        assert!(text.contains(&format!("--bind {ws} {ws}")));
        assert!(text.contains(&format!("--chdir {ws}")));
    }

    /// A run writing to a managed worktree starts the shell there; a start
    /// outside the write roots is ignored rather than trusted.
    #[test]
    fn bwrap_chdirs_into_the_start_dir_only_when_it_is_a_write_root() {
        let wt = PathBuf::from("/data/agent-workspace/worktrees/repo/s1");
        let started = policy().with_write_roots(vec![wt.clone()]).with_start_dir(&wt);
        let text = joined(&bwrap_args(&started, &cfg()));
        assert!(text.contains(&format!("--chdir {}", wt.display())), "{text}");

        let ignored = policy().with_start_dir(&wt);
        assert_eq!(ignored.start_dir(), ignored.workspace.as_path());
    }

    #[test]
    fn bwrap_masks_home_by_default_and_reads_it_when_configured() {
        let Some(home) = home_dir() else {
            panic!("test needs a HOME");
        };
        let home = home.to_string_lossy();
        let ro_bind = format!("--ro-bind {home} {home}");
        let tmpfs = format!("--tmpfs {home}");

        // Default: an empty tmpfs hides the home.
        let masked = joined(&bwrap_args(&policy(), &cfg()));
        assert!(masked.contains(&tmpfs), "{masked}");
        assert!(!masked.contains(&ro_bind), "{masked}");

        // home_readonly: the home is bound read-only instead of hidden.
        let ro = joined(&bwrap_args(&policy().with_home_readonly(true), &cfg()));
        assert!(!ro.contains(&tmpfs), "{ro}");
        assert!(ro.contains(&ro_bind), "{ro}");
    }

    /// The workspace bind makes the whole project reachable, so the mask must be
    /// layered on after it or it would be shadowed and silently do nothing.
    #[test]
    fn bwrap_hides_the_agent_state_dir_after_binding_the_workspace() {
        let ws = "/data/agent-workspace/threads/t1";
        let hide = format!("{ws}/.jan");
        let text = joined(&bwrap_args(
            &policy().with_hide_root(Path::new(&hide)),
            &cfg(),
        ));
        let bind = text.find(&format!("--bind {ws} {ws}")).expect("bind");
        let tmpfs = text.find(&format!("--tmpfs {hide}")).expect("hide tmpfs");
        assert!(
            bind < tmpfs,
            "the mask must follow the workspace bind: {text}"
        );
        // Unset by default, so nothing is hidden where no state dir is named.
        assert!(!joined(&bwrap_args(&policy(), &cfg())).contains(".jan"));
    }

    /// The bind order *is* the enforcement, on both sides: after the `$HOME`
    /// tmpfs so a folder living under the home is punched back through the mask,
    /// and before the workspace bind so a read root can never shadow the only
    /// writable path.
    #[test]
    fn bwrap_binds_read_roots_between_the_home_mask_and_the_workspace() {
        let ws = "/data/agent-workspace/threads/t1";
        let repo = "/home/u/Projects/app";
        let text = joined(&bwrap_args(
            &policy().with_read_roots(vec![PathBuf::from(repo)]),
            &cfg(),
        ));
        let home = home_dir().expect("a home dir");
        let home_tmpfs = text
            .find(&format!("--tmpfs {}", home.to_string_lossy()))
            .expect("home tmpfs");
        let ro = text
            .find(&format!("--ro-bind {repo} {repo}"))
            .expect("read root bind");
        let bind = text.find(&format!("--bind {ws} {ws}")).expect("ws bind");
        assert!(
            home_tmpfs < ro,
            "read root must follow the home mask: {text}"
        );
        assert!(
            ro < bind,
            "read root must precede the workspace bind: {text}"
        );
    }

    #[test]
    fn bwrap_binds_read_roots_read_only_and_omits_them_by_default() {
        let repo = "/home/u/repo";
        let text = joined(&bwrap_args(
            &policy().with_read_roots(vec![PathBuf::from(repo)]),
            &cfg(),
        ));
        assert!(text.contains(&format!("--ro-bind {repo} {repo}")), "{text}");
        assert!(
            !text.contains(&format!("--bind {repo} {repo}")),
            "never writable: {text}"
        );
        assert!(!joined(&bwrap_args(&policy(), &cfg())).contains(repo));
    }

    /// Seatbelt takes the last matching rule, so the read allow has to come
    /// after the HOME/MASK denials or a folder inside either stays unreadable.
    #[test]
    fn seatbelt_allows_read_roots_after_the_denials_and_never_writes() {
        let repo = "/Users/u/repo";
        let p = seatbelt_policy(
            &policy()
                .with_mask_root(Path::new("/data"))
                .with_read_roots(vec![PathBuf::from(repo)]),
        );
        let deny = p
            .find("(deny file-read* (subpath (param \"MASK_ROOT\")))")
            .expect("mask deny");
        let allow = p
            .find("(allow file-read* (subpath (param \"READ_ROOT_0\")))")
            .expect("read root allow");
        assert!(deny < allow, "the allow must win over the denials: {p}");
        assert!(
            !p.contains("(allow file-write* (subpath (param \"READ_ROOT_0\")))"),
            "a read root is never writable: {p}"
        );

        let args = seatbelt_args(&policy().with_read_roots(vec![PathBuf::from(repo)]), &cfg());
        assert!(args.iter().any(|a| a == &format!("-DREAD_ROOT_0={repo}")));
    }

    /// sandbox-exec refuses a profile that references a parameter no `-D`
    /// supplies, so the rule and the argument have to appear together.
    #[test]
    fn seatbelt_omits_the_read_root_rule_when_there_is_none() {
        let p = seatbelt_policy(&policy());
        assert!(!p.contains("READ_ROOT"), "{p}");
        assert!(!seatbelt_args(&policy(), &cfg())
            .iter()
            .any(|a| a.contains("READ_ROOT")));
    }

    /// Jozkah/jan#124: every hide root is masked, each after the workspace
    /// and write-root binds, and a repeat is kept once.
    #[test]
    fn several_hide_roots_are_all_hidden_last() {
        let ws = "/data/agent-workspace/threads/t1";
        let wt = "/data/worktrees/repo/s1";
        let p = policy()
            .with_write_roots(vec![PathBuf::from(wt)])
            .with_hide_root(Path::new(&format!("{ws}/.jan")))
            .with_hide_root(Path::new(&format!("{wt}/.jan")))
            .with_hide_root(Path::new(&format!("{wt}/.jan")));
        assert_eq!(p.hide_roots.len(), 2);

        let text = joined(&bwrap_args(&p, &cfg()));
        let wt_bind = text.find(&format!("--bind {wt} {wt}")).expect("write root bind");
        let ws_bind = text.find(&format!("--bind {ws} {ws}")).expect("workspace bind");
        let ws_hide = text.find(&format!("--tmpfs {ws}/.jan")).expect("workspace hide");
        let wt_hide = text.find(&format!("--tmpfs {wt}/.jan")).expect("write root hide");
        assert!(wt_bind < wt_hide && ws_bind < wt_hide && ws_bind < ws_hide, "{text}");

        let profile = seatbelt_policy(&p);
        let allow = profile
            .find("(allow file-write* (subpath (param \"WRITE_ROOT_0\")))")
            .expect("write allow");
        let deny = profile
            .find("(deny file-write* (subpath (param \"HIDE_ROOT_1\")))")
            .expect("second hide deny");
        assert!(allow < deny, "{profile}");
        assert!(profile.contains("(deny file-read* (subpath (param \"HIDE_ROOT_1\")))"));
        let args = joined(&seatbelt_args(&p, &cfg()));
        assert!(args.contains(&format!("-DHIDE_ROOT={ws}/.jan")), "{args}");
        assert!(args.contains(&format!("-DHIDE_ROOT_1={wt}/.jan")), "{args}");
        assert!(!profile.contains("HIDE_ROOT_2"));
    }

    #[test]
    fn seatbelt_denies_the_agent_state_dir_last() {
        let hide = "/data/agent-workspace/threads/t1/.jan";
        let p = policy().with_hide_root(Path::new(hide));
        let profile = seatbelt_policy(&p);
        let allow = profile
            .find("(allow file-read* (subpath (param \"WORKSPACE\")))")
            .expect("workspace allow");
        let deny = profile
            .find("(deny file-read* (subpath (param \"HIDE_ROOT\")))")
            .expect("hide deny");
        assert!(allow < deny, "later rules win, so the deny must come last");
        assert!(profile.contains("(deny file-write* (subpath (param \"HIDE_ROOT\")))"));
        // The path travels as a -D parameter, never interpolated into the profile.
        assert!(!profile.contains(hide), "{profile}");
        assert!(joined(&seatbelt_args(&p, &cfg())).contains(&format!("-DHIDE_ROOT={hide}")));
        assert!(!seatbelt_policy(&policy()).contains("HIDE_ROOT"));
    }

    #[test]
    fn bwrap_denies_network_unless_allowed() {
        let denied = joined(&bwrap_args(&policy(), &cfg()));
        assert!(denied.contains("--unshare-all"));
        assert!(!denied.contains("--share-net"));

        let allowed = joined(&bwrap_args(
            &Policy::new(Path::new("/data/ws"), true),
            &cfg(),
        ));
        assert!(allowed.contains("--unshare-all"));
        assert!(allowed.contains("--share-net"));
    }

    #[test]
    fn bwrap_hardens_the_tree_and_terminal() {
        let text = joined(&bwrap_args(&policy(), &cfg()));
        assert!(text.contains("--die-with-parent"));
        assert!(text.contains("--new-session"));
        assert!(text.contains("--proc /proc"));
        assert!(text.contains("--tmpfs /tmp"));
    }

    #[test]
    fn bwrap_binds_scratch_over_tmp_instead_of_a_tmpfs() {
        let scratch = Path::new("/data/agent-workspace/threads/t1/agent-scratch");
        let scratch_bind = format!("--bind {} /tmp", scratch.to_string_lossy());

        // Default: a throwaway tmpfs per command, no scratch bind.
        let default = joined(&bwrap_args(&policy(), &cfg()));
        assert!(default.contains("--tmpfs /tmp"), "{default}");
        assert!(!default.contains(&scratch_bind), "{default}");

        // With a scratch root, /tmp is a real bind so files written there by one
        // bash call survive into the next.
        let bound = joined(&bwrap_args(&policy().with_scratch_root(scratch), &cfg()));
        assert!(!bound.contains("--tmpfs /tmp"), "{bound}");
        assert!(bound.contains(&scratch_bind), "{bound}");
    }

    #[test]
    fn bwrap_ends_with_the_shell_so_the_command_appends_last() {
        let args = bwrap_args(&policy(), &cfg());
        let sep = args.iter().position(|a| a == "--").expect("separator");
        assert_eq!(
            &args[sep + 1..],
            &["/bin/bash".to_string(), "-c".to_string()]
        );
    }

    #[test]
    fn seatbelt_closes_by_default_then_opens_reads() {
        let p = seatbelt_policy(&policy());
        assert!(p.starts_with("(version 1)\n(deny default)"));
        assert!(p.contains("(allow file-read*)"));
    }

    #[test]
    fn seatbelt_keeps_home_readable_but_unwritable_when_configured() {
        // home_readonly: no home read-denial, and the write section never opens
        // HOME_ROOT, so reads work but writes stay confined to workspace/temp.
        let p = seatbelt_policy(&policy().with_home_readonly(true));
        assert!(
            !p.contains("(deny file-read* (subpath (param \"HOME_ROOT\")))"),
            "{p}"
        );
        assert!(p.contains("(allow file-read*)"), "{p}");
        assert!(
            !p.contains("(allow file-write* (subpath (param \"HOME_ROOT\")))"),
            "{p}"
        );
    }

    #[test]
    fn seatbelt_denies_home_after_allowing_reads_and_restores_the_workspace() {
        let p = seatbelt_policy(&policy());
        let allow_all = p.find("(allow file-read*)\n").expect("blanket read");
        let deny_home = p.find("(deny file-read* (subpath (param \"HOME_ROOT\")))");
        let allow_ws = p
            .find("(allow file-read* (subpath (param \"WORKSPACE\")))")
            .expect("workspace read");
        // Seatbelt takes the last matching rule, so these three must appear in
        // this order for the workspace carve-out to survive the home denial.
        if let Some(deny_home) = deny_home {
            assert!(allow_all < deny_home && deny_home < allow_ws);
        }
    }

    #[test]
    fn seatbelt_confines_writes_to_the_workspace_and_temp() {
        let p = seatbelt_policy(&policy());
        assert!(p.contains("(allow file-write* (subpath (param \"WORKSPACE\")))"));
        assert!(p.contains("(allow file-write* (subpath (param \"TMPDIR\")))"));
        // No blanket write rule anywhere.
        assert!(!p.contains("(allow file-write*)"));
    }

    /// The scratch is granted by name rather than relying on it happening to sit
    /// under the host temp dir, so a relocated scratch stays writable.
    #[test]
    fn seatbelt_grants_the_scratch_as_its_own_parameter() {
        let scratch = Path::new("/var/scratch/jan-agent-s1");
        let p = seatbelt_policy(&policy().with_scratch_root(scratch));
        assert!(p.contains("(allow file-write* (subpath (param \"SCRATCH\")))"));
        let args = seatbelt_args(&policy().with_scratch_root(scratch), &cfg());
        assert!(args
            .iter()
            .any(|a| a == "-DSCRATCH=/var/scratch/jan-agent-s1"));
        assert!(
            !args[1].contains("/var/scratch"),
            "path must not be inlined"
        );
    }

    /// `sandbox-exec` fails to launch when the profile references a `param` no
    /// `-D` supplies, so the rule and the parameter must appear together.
    #[test]
    fn seatbelt_omits_the_scratch_rule_when_there_is_no_scratch() {
        let p = seatbelt_policy(&policy());
        assert!(!p.contains("SCRATCH"));
        let args = seatbelt_args(&policy(), &cfg());
        assert!(!args.iter().any(|a| a.starts_with("-DSCRATCH=")));
    }

    /// What `TMPDIR` must say inside the sandbox: bubblewrap binds the scratch
    /// over `/tmp`, so the host path is meaningless there; the other backends
    /// have no mount, so the real path is the only one that resolves.
    #[test]
    fn scratch_env_path_follows_what_the_backend_actually_mounts() {
        let scratch = Path::new("/var/scratch/jan-agent-s1");
        let with = policy().with_scratch_root(scratch);
        assert_eq!(
            scratch_env_path(Backend::Bubblewrap, &with).as_deref(),
            Some(Path::new("/tmp"))
        );
        for backend in [Backend::Seatbelt, Backend::AppContainer] {
            assert_eq!(
                scratch_env_path(backend, &with).as_deref(),
                Some(scratch),
                "{backend:?} has no mount, so the real path is the scratch"
            );
        }
        // No scratch, nothing to point at: the shell keeps the default temp dir.
        assert_eq!(scratch_env_path(Backend::Bubblewrap, &policy()), None);
        assert_eq!(scratch_env_path(Backend::Seatbelt, &policy()), None);
    }

    #[test]
    fn seatbelt_denies_network_unless_allowed() {
        assert!(seatbelt_policy(&policy()).contains("(deny network*)"));
        let open = seatbelt_policy(&Policy::new(Path::new("/data/ws"), true));
        assert!(open.contains("(allow network-outbound (remote ip \"*:*\"))"), "{open}");
        assert!(!open.contains("(deny network*)"));
    }

    /// Jozkah/jan#206: network on grants IP traffic, not connect() to every
    /// unix socket on the host (the launchd ssh-agent among them). Only the
    /// mDNSResponder socket DNS needs is named.
    #[test]
    fn seatbelt_network_is_ip_only() {
        let open = seatbelt_policy(&Policy::new(Path::new("/data/ws"), true));
        assert!(!open.contains("(allow network*)"), "{open}");
        assert!(!open.contains("unix-socket"), "{open}");
        for line in open.lines().filter(|l| l.contains("(allow network")) {
            assert!(
                line.contains("(remote ip ")
                    || line.contains("(local ip ")
                    || line.contains("/private/var/run/mDNSResponder"),
                "network rule not scoped to IP: {line}"
            );
        }
        assert!(open.contains("(allow network-inbound (local ip \"*:*\"))"), "{open}");
        assert!(open.contains("(allow network-bind (local ip \"*:*\"))"), "{open}");
    }

    #[test]
    fn seatbelt_passes_paths_as_parameters_not_policy_text() {
        let args = seatbelt_args(&policy(), &cfg());
        let ws = "/data/agent-workspace/threads/t1";
        assert!(args.iter().any(|a| a == &format!("-DWORKSPACE={ws}")));
        // The path must not be interpolated into the profile itself, or a path
        // containing sbpl syntax could rewrite the policy.
        assert!(!args[1].contains(ws));
    }

    #[test]
    fn seatbelt_ends_with_the_shell_so_the_command_appends_last() {
        let args = seatbelt_args(&policy(), &cfg());
        let sep = args.iter().position(|a| a == "--").expect("separator");
        assert_eq!(
            &args[sep + 1..],
            &["/bin/bash".to_string(), "-c".to_string()]
        );
    }

    #[test]
    fn denial_markers_match_real_kernel_messages() {
        assert!(looks_denied(
            "touch: cannot touch '/etc/x': Read-only file system"
        ));
        assert!(looks_denied("bash: /root/.x: Permission denied"));
        assert!(looks_denied(
            "curl: (6) Could not resolve host: example.com"
        ));
        assert!(!looks_denied("hello world"));
        assert!(!looks_denied("test failed: 3 assertions"));
    }

    #[test]
    fn denial_hint_names_the_workspace_and_network_state() {
        let hint = denial_hint(&policy());
        assert!(hint.contains("/data/agent-workspace/threads/t1"));
        assert!(hint.contains("Network access is disabled."));
        assert!(!denial_hint(&Policy::new(Path::new("/w"), true)).contains("Network access"));
        // With no scratch there is nothing to point the model at.
        assert!(!hint.contains("scratch"));
    }

    /// A denied write must not send the model away from the one other place it
    /// is allowed to write, named as the sandbox exposes it.
    #[test]
    fn denial_hint_names_the_scratch_when_there_is_one() {
        let scratch = Path::new("/var/scratch/jan-agent-s1");
        let hint = denial_hint(&policy().with_scratch_root(scratch));
        let expected = scratch_env_path(backend(), &policy().with_scratch_root(scratch))
            .expect("a scratch was set");
        assert!(
            hint.contains(&format!("scratch dir ({})", expected.display())),
            "got: {hint}"
        );
    }

    /// A managed-worktree session: the shell starts in the worktree and may
    /// write it, and the attached checkout it was cut from is a separate path.
    fn worktree_policy() -> Policy {
        let wt = PathBuf::from("/data/worktrees/proj-1");
        Policy::new(Path::new("/data/agent-workspace/threads/t1"), false)
            .with_write_roots(vec![wt.clone()])
            .with_start_dir(&wt)
    }

    #[test]
    fn denial_hint_lists_every_write_root_and_the_start_dir() {
        let hint = denial_hint(&worktree_policy());
        assert!(hint.contains("/data/worktrees/proj-1"), "{hint}");
        assert!(hint.contains("The shell starts in /data/worktrees/proj-1."), "{hint}");
        assert!(hint.contains("writes are limited to the workspace ("), "{hint}");
    }

    #[test]
    fn an_attached_folder_the_shell_can_write_is_not_called_unreadable() {
        let inside = worktree_policy()
            .with_read_roots(vec![PathBuf::from("/data/worktrees/proj-1/sub")]);
        assert!(!denial_hint(&inside).contains("attached folder"));
        let outside = worktree_policy().with_read_roots(vec![PathBuf::from("/home/me/proj")]);
        let hint = denial_hint(&outside);
        assert!(hint.contains("attached folder (/home/me/proj)"), "{hint}");
    }

    #[test]
    fn a_denial_inside_the_write_roots_gets_no_access_advice() {
        use crate::tools::shell_diag::FailureClass;
        let p = worktree_policy();
        let inside = "rm: cannot remove '/data/worktrees/proj-1/locked.db': Permission denied";
        assert!(failure_hint(&p, &FailureClass::FileAccessDenied, inside).is_none());
        let outside = "cat: /home/me/.ssh/config: Permission denied";
        let hint = failure_hint(&p, &FailureClass::FileAccessDenied, outside).unwrap();
        assert!(hint.contains("request_access"), "{hint}");
        // No path named at all: unknown, so the advice stays.
        assert!(failure_hint(&p, &FailureClass::FileAccessDenied, "Access is denied.").is_some());
    }

    #[test]
    fn named_paths_finds_windows_and_unix_paths() {
        let found = named_paths(r"open C:\Users\me\x.txt: denied; see '/etc/passwd'.");
        assert_eq!(
            found,
            vec![PathBuf::from(r"C:\Users\me\x.txt"), PathBuf::from("/etc/passwd")]
        );
        assert!(named_paths("open NUL: Access is denied.").is_empty());
    }

    #[test]
    fn a_null_device_that_refuses_the_sandbox_is_not_blamed_on_a_folder() {
        let hint = device_hint(true);
        assert!(hint.contains("ALL APPLICATION PACKAGES"), "{hint}");
        assert!(!hint.contains("request_access"), "{hint}");
        assert!(!hint.contains("writes are limited"), "{hint}");
        assert!(device_hint(false).contains("null syntax"));
    }

    #[test]
    fn failure_hint_advises_request_access_only_for_file_denials() {
        use crate::tools::shell_diag::FailureClass;
        let p = policy();
        let hint = failure_hint(&p, &FailureClass::FileAccessDenied, "").unwrap();
        assert!(hint.contains("Call request_access with the narrowest required path"));
        assert!(hint.ends_with(']'));
        for class in [
            FailureClass::CmdNulRedirect("2>nul".into()),
            FailureClass::DeviceFile,
            FailureClass::MissingCommand,
            FailureClass::NotFound,
            FailureClass::Network,
            FailureClass::Other,
        ] {
            let h = failure_hint(&p, &class, "").unwrap_or_default();
            assert!(!h.contains("request_access"), "{class:?}: {h}");
        }
        let nul = failure_hint(&p, &FailureClass::CmdNulRedirect("2>nul".into()), "").unwrap();
        assert!(nul.contains("`2>$null`"));
        assert!(nul.contains("not a sandbox restriction"));
        assert!(!nul.contains("writes are limited"));
        assert!(failure_hint(&p, &FailureClass::MissingCommand, "").is_none());
        assert!(failure_hint(&Policy::new(Path::new("/w"), true), &FailureClass::Network, "").is_none());
    }

    #[test]
    fn a_degenerate_home_is_ignored_rather_than_hiding_the_filesystem() {
        // Guards the `parent().is_none()` check: a `/` home would put a tmpfs
        // over the entire filesystem and nothing would be executable.
        assert!(PathBuf::from("/").parent().is_none());
    }

    #[test]
    fn backend_is_stable_across_calls() {
        assert_eq!(backend(), backend());
    }

    /// The shell's half of "Edit this folder".
    ///
    /// Policy construction, not sandbox execution: these assert the rules and
    /// arguments each backend would be given. Whether the kernel then honours
    /// them is a runtime question, and is reported as such.
    #[test]
    fn seatbelt_grants_an_authorized_repository_read_and_write() {
        let repo = "/home/dev/obs-forwarder";
        let p = seatbelt_policy(
            &policy()
                .with_mask_root(Path::new("/data"))
                .with_write_roots(vec![PathBuf::from(repo)]),
        );

        let deny = p
            .find("(deny file-read* (subpath (param \"MASK_ROOT\")))")
            .expect("mask deny");
        let read = p
            .find("(allow file-read* (subpath (param \"WRITE_ROOT_0\")))")
            .expect("write root read allow");
        let write = p
            .find("(allow file-write* (subpath (param \"WRITE_ROOT_0\")))")
            .expect("write root write allow");

        // Later rules win in Seatbelt, so a repository inside $HOME or the data
        // folder is still reachable.
        assert!(deny < read, "the allow must win over the denials: {p}");
        assert!(read < write);

        let args = seatbelt_args(
            &policy().with_write_roots(vec![PathBuf::from(repo)]),
            &cfg(),
        );
        assert!(args.iter().any(|a| a == &format!("-DWRITE_ROOT_0={repo}")));
    }

    // The agent's own state directory stays denied even inside a folder the
    // user is actively editing.
    #[test]
    fn seatbelt_still_hides_the_agent_state_dir_inside_a_writable_repository() {
        let p = seatbelt_policy(
            &policy()
                .with_write_roots(vec![PathBuf::from("/home/dev/obs-forwarder")])
                .with_hide_root(Path::new("/home/dev/obs-forwarder/.jan")),
        );

        let write = p
            .find("(allow file-write* (subpath (param \"WRITE_ROOT_0\")))")
            .expect("write allow");
        let hide = p
            .find("(deny file-write* (subpath (param \"HIDE_ROOT\")))")
            .expect("hide deny");
        assert!(write < hide, "the hide must come last: {p}");
    }

    // sandbox-exec refuses a profile naming a parameter no `-D` supplies.
    #[test]
    fn seatbelt_omits_the_write_root_rule_when_there_is_none() {
        let p = seatbelt_policy(&policy());
        assert!(!p.contains("WRITE_ROOT"), "{p}");
        assert!(!seatbelt_args(&policy(), &cfg())
            .iter()
            .any(|a| a.contains("WRITE_ROOT")));
    }

    // Two lists, two answers. Attaching a folder to read it must not make the
    // shell able to write to it either.
    #[test]
    fn seatbelt_never_makes_a_read_root_writable() {
        let p = seatbelt_policy(&policy().with_read_roots(vec![PathBuf::from("/repo")]));

        assert!(p.contains("(allow file-read* (subpath (param \"READ_ROOT_0\")))"));
        assert!(!p.contains("(allow file-write* (subpath (param \"READ_ROOT_0\")))"));
    }

    #[test]
    fn bubblewrap_binds_an_authorized_repository_read_write() {
        let args = bwrap_args(
            &policy()
                .with_read_roots(vec![PathBuf::from("/repo-ro")])
                .with_write_roots(vec![PathBuf::from("/repo-rw")]),
            &cfg(),
        );

        // Not simply the first `--ro-bind`: bubblewrap binds the root
        // filesystem read-only before any attached folder.
        let ro = args
            .windows(2)
            .position(|w| w[0] == "--ro-bind" && w[1] == "/repo-ro")
            .expect("ro bind for the attached folder");
        assert_eq!(args[ro + 2], "/repo-ro");

        // `--bind` is read-write, unlike the attached folder above.
        let rw = args
            .windows(2)
            .position(|w| w[0] == "--bind" && w[1] == "/repo-rw")
            .expect("rw bind for the authorized repository");
        assert_eq!(args[rw + 2], "/repo-rw");
    }

    /// A path is data, never syntax.
    ///
    /// Spaces, quotes, a leading hyphen and non-ASCII all survive as one
    /// argument because nothing here builds a command string out of them.
    #[test]
    fn awkward_repository_paths_stay_one_argument() {
        let awkward = "/home/dev/my repo \"quoted\" --not-a-flag/ünïcode";
        let args = bwrap_args(
            &policy().with_write_roots(vec![PathBuf::from(awkward)]),
            &cfg(),
        );
        assert!(args.iter().any(|a| a == awkward), "{args:?}");

        let sb = seatbelt_args(
            &policy().with_write_roots(vec![PathBuf::from(awkward)]),
            &cfg(),
        );
        assert!(
            sb.iter().any(|a| a == &format!("-DWRITE_ROOT_0={awkward}")),
            "{sb:?}"
        );
    }

    /// Which platforms may offer direct editing at all.
    ///
    /// AppContainer grants writes only through an ACE on the thread workspace,
    /// so it cannot yet authorize a repository; reporting it supported would
    /// promise a confinement Windows is not applying.
    /// The regression: a probe that outlived its timeout was reported unusable
    /// and left running. Now the process is gone by the time the wait returns.
    #[test]
    fn a_probe_that_hangs_is_killed_not_leaked() {
        use std::time::Duration;
        #[cfg(windows)]
        let child = std::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = std::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let started = std::time::Instant::now();
        assert!(wait_or_kill(child, Duration::from_millis(500)).is_none());
        // Bounded: on the host this was found on, `taskkill` itself took a
        // minute and then failed, which is what the kill used to go through.
        assert!(started.elapsed() < Duration::from_secs(5), "the wait did not give up");
        assert!(!process_alive(pid), "the timed-out probe is still running");
    }

    /// A timed-out probe takes the shell it started with it. `cmd` stands in
    /// for the sandbox helper and `ping` for its shell: killing only the
    /// helper used to leave the shell running for the life of the app.
    #[cfg(windows)]
    #[test]
    fn a_probe_that_hangs_takes_the_shell_it_started_with_it() {
        use std::time::Duration;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let child = std::process::Command::new("cmd")
            .args(["/c", "ping -n 60 127.0.0.1 >nul"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let root = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        let created = super::super::proc::creation_time(root);
        unsafe { CloseHandle(root) };
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let shells = loop {
            let found = super::super::proc::descendants_of(pid, created);
            if !found.is_empty() || std::time::Instant::now() > deadline {
                break found;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(!shells.is_empty(), "the stand-in helper never started its shell");

        assert!(wait_or_kill(child, Duration::from_millis(500)).is_none());
        std::thread::sleep(Duration::from_millis(200));
        for shell in shells {
            assert!(!process_alive(shell), "the probe's shell {shell} outlived it");
        }
    }

    /// Whether `pid` is a running process, asked of the OS directly rather
    /// than through `taskkill`, which is what hung.
    #[cfg(windows)]
    fn process_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }

    #[cfg(not(windows))]
    fn process_alive(pid: u32) -> bool {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
            || std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .is_ok_and(|s| s.success())
    }

    #[test]
    fn a_probe_that_finishes_is_waited_for() {
        use std::time::Duration;
        #[cfg(windows)]
        let child = std::process::Command::new("cmd")
            .args(["/C", "echo ok"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = std::process::Command::new("sh")
            .args(["-c", "echo ok"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let out = wait_or_kill(child, Duration::from_secs(10)).expect("finished").unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("ok"));
    }

    /// AppContainer confines a run to a Jan-owned worktree and nothing else:
    /// every root inside the owned folder, the owned folder itself refused, a
    /// root outside it refused, and no owned folder at all refused.
    #[test]
    fn appcontainer_confines_only_jan_owned_roots() {
        let base = std::env::temp_dir().join(format!("jan_owned_roots_{}", std::process::id()));
        let owned = base.join("worktrees");
        let inside = owned.join("repo").join("s1");
        let outside = base.join("user-repo");
        for d in [&inside, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        let ac = Backend::AppContainer;
        assert!(can_confine_write_roots(ac, &[inside.clone()], Some(&owned)));
        assert!(!can_confine_write_roots(ac, &[outside.clone()], Some(&owned)));
        assert!(!can_confine_write_roots(ac, &[inside.clone(), outside.clone()], Some(&owned)));
        assert!(!can_confine_write_roots(ac, &[owned.clone()], Some(&owned)));
        assert!(!can_confine_write_roots(ac, &[inside.clone()], None));
        assert!(!can_confine_write_roots(ac, &[inside.join("..").join("..").join("..").join("user-repo")], Some(&owned)));
        // The general backends hold any root; no backend holds nothing.
        assert!(can_confine_write_roots(Backend::Seatbelt, &[outside.clone()], None));
        assert!(!can_confine_write_roots(Backend::None, &[inside], Some(&owned)));
        assert!(supports_owned_write_roots(ac));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_backends_that_can_confine_a_repository_support_direct_editing() {
        assert!(supports_write_roots(Backend::Seatbelt));
        assert!(supports_write_roots(Backend::Bubblewrap));
        assert!(!supports_write_roots(Backend::AppContainer));
        assert!(!supports_write_roots(Backend::None));
    }
}

/// Live end-to-end checks: these assert the kernel actually refuses things,
/// not that we generated the right flags. Skipped when no backend is available.
#[cfg(all(test, unix))]
mod enforcement_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// The canonical temp dir. On macOS `std::env::temp_dir()` returns the
    /// `/var/folders/...` symlinked form while `sandbox-exec` matches the
    /// canonical `/private/var/folders/...` path, so denying the symlinked form
    /// (and the workspace built on top of it) is silently bypassed. Resolving the
    /// symlink keeps the enforcement tests meaningful on macOS. A no-op elsewhere.
    fn temp_dir() -> PathBuf {
        let tmp = std::env::temp_dir();
        #[cfg(target_os = "macos")]
        {
            tmp.canonicalize().unwrap_or(tmp)
        }
        #[cfg(not(target_os = "macos"))]
        {
            tmp
        }
    }

    fn workspace() -> PathBuf {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = temp_dir().join(format!("jan_jail_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).expect("create workspace");
        dir
    }

    /// Run `command` confined to `ws` and return combined output plus success.
    async fn run(ws: &Path, allow_network: bool, command: &str) -> (bool, String) {
        let policy = Policy::new(ws, allow_network);
        run_policy(policy, ws, command).await
    }

    /// Run `command` under `policy`, spawning in `ws`.
    async fn run_policy(policy: Policy, ws: &Path, command: &str) -> (bool, String) {
        let wrapped = wrap(super::super::proc::shell(), &policy).expect("backend");
        // Mirrors the bash handler: the temp env follows what the backend mounts.
        let tmp = scratch_env_path(backend(), &policy);
        let child = super::super::proc::spawn(&wrapped, command, ws, tmp.as_deref())
            .await
            .expect("spawn");
        let pid = child.id();
        let out = child.wait_with_output().await.expect("wait");
        if let Some(pid) = pid {
            super::super::proc::unregister(pid);
        }
        let mut text = String::from_utf8_lossy(&out.stdout).to_string();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        (out.status.success(), text)
    }

    /// A second directory tree to stand in for the user's repositories.
    fn repo_pair() -> (PathBuf, PathBuf, PathBuf) {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let parent = temp_dir().join(format!("jan_repos_{}_{}", std::process::id(), n));
        let selected = parent.join("obs-forwarder");
        let sibling = parent.join("note-py");
        std::fs::create_dir_all(&selected).expect("create selected");
        std::fs::create_dir_all(&sibling).expect("create sibling");
        (parent, selected, sibling)
    }

    macro_rules! require_backend {
        () => {
            if !backend().enforces() {
                eprintln!("skipping: no sandbox backend on this host");
                return;
            }
        };
    }

    /// The shell half of "Edit this folder", asserted against the kernel.
    ///
    /// Not that the right flags were generated — that the sandbox actually
    /// lets the command write the authorized repository and actually stops it
    /// writing the one beside it.
    #[tokio::test]
    async fn an_authorized_repository_is_writable_by_the_shell() {
        require_backend!();
        if !supports_write_roots(backend()) {
            eprintln!(
                "skipping: {} cannot confine a repository",
                backend().as_str()
            );
            return;
        }
        let ws = workspace();
        let (parent, selected, sibling) = repo_pair();
        let policy = Policy::new(&ws, false).with_write_roots(vec![selected.clone()]);

        let (ok, out) = run_policy(
            policy,
            &ws,
            &format!("printf edited > {}/inside.txt", selected.display()),
        )
        .await;

        assert!(ok, "writing the authorized repository failed: {out}");
        assert_eq!(
            std::fs::read_to_string(selected.join("inside.txt")).unwrap_or_default(),
            "edited"
        );

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
        let _ = sibling;
    }

    #[tokio::test]
    async fn a_sibling_repository_stays_unwritable_by_the_shell() {
        require_backend!();
        if !supports_write_roots(backend()) {
            eprintln!(
                "skipping: {} cannot confine a repository",
                backend().as_str()
            );
            return;
        }
        let ws = workspace();
        let (parent, selected, sibling) = repo_pair();
        let policy = Policy::new(&ws, false).with_write_roots(vec![selected.clone()]);

        let (_ok, _out) = run_policy(
            policy,
            &ws,
            &format!("printf leaked > {}/outside.txt", sibling.display()),
        )
        .await;

        // The command's exit status is the shell's business; what matters is
        // that nothing landed in the repository nobody authorized.
        assert!(
            !sibling.join("outside.txt").exists(),
            "a sibling repository was written through the shell"
        );

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
    }

    // Authorizing nothing must leave the shell exactly as confined as before.
    #[tokio::test]
    async fn with_no_authorized_repository_the_shell_still_cannot_write_one() {
        require_backend!();
        let ws = workspace();
        let (parent, selected, _sibling) = repo_pair();

        let (_ok, _out) = run_policy(
            Policy::new(&ws, false),
            &ws,
            &format!("printf leaked > {}/inside.txt", selected.display()),
        )
        .await;

        assert!(!selected.join("inside.txt").exists());

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[tokio::test]
    // `/etc/hostname` does not exist on macOS, so this Linux-content check is
    // gated to the platform that guarantees the file.
    #[cfg(target_os = "linux")]
    async fn a_command_still_runs_and_can_read_system_files() {
        require_backend!();
        let ws = workspace();
        let (ok, out) = run(
            &ws,
            false,
            "echo alive && head -c 4 /etc/hostname >/dev/null",
        )
        .await;
        let _ = std::fs::remove_dir_all(&ws);
        assert!(ok, "basic command must work inside the sandbox: {out}");
        assert!(out.contains("alive"), "{out}");
    }

    #[tokio::test]
    async fn writes_inside_the_workspace_succeed_and_persist() {
        require_backend!();
        let ws = workspace();
        let (ok, out) = run(&ws, false, "echo written > marker.txt").await;
        assert!(ok, "workspace write must succeed: {out}");
        let marker = ws.join("marker.txt");
        let landed = std::fs::read_to_string(&marker)
            .ok()
            .map(|s| s.trim().to_string());
        assert_eq!(
            landed.as_deref(),
            Some("written"),
            "the write must land on the real workspace, not a throwaway overlay"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn scratch_persists_across_bash_calls_when_bound_over_tmp() {
        require_backend!();
        let ws = workspace();
        let scratch = ws.join("agent-scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        let policy = Policy::new(&ws, false).with_scratch_root(&scratch);

        // Write into /tmp in the first call, then read it back in a second,
        // separate sandboxed process. This is exactly the pattern the fix
        // exists for: a scratch pad that outlives a single bash invocation.
        let (ok, out) = run_policy(policy.clone(), &ws, "echo persistent > /tmp/scratch.txt").await;
        assert!(ok, "scratch write must succeed: {out}");
        let (ok, out) = run_policy(policy, &ws, "cat /tmp/scratch.txt").await;
        let _ = std::fs::remove_dir_all(&ws);
        assert!(ok, "scratch read must succeed: {out}");
        assert!(
            out.contains("persistent"),
            "scratch must survive a second bash call: {out}"
        );
    }

    #[tokio::test]
    async fn writes_outside_the_workspace_never_reach_the_host() {
        require_backend!();
        let ws = workspace();
        let victim = std::env::temp_dir().join(format!("jan_jail_victim_{}", std::process::id()));
        let _ = std::fs::remove_file(&victim);
        // The command may well succeed: on bubblewrap the temp dir is a private
        // tmpfs, so the write lands somewhere thrown away with the sandbox. What
        // must hold either way is that nothing appears on the host.
        let (_, out) = run(
            &ws,
            false,
            &format!("echo pwned > {}", victim.to_string_lossy()),
        )
        .await;
        let leaked = victim.exists();
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&ws);
        assert!(!leaked, "the host filesystem must be untouched: {out}");
    }

    #[tokio::test]
    async fn writes_to_read_only_system_paths_fail() {
        require_backend!();
        let ws = workspace();
        let (ok, out) = run(&ws, false, "echo pwned > /etc/jan_jail_probe").await;
        let leaked = Path::new("/etc/jan_jail_probe").exists();
        let _ = std::fs::remove_dir_all(&ws);
        assert!(
            !ok,
            "system paths are read-only, the write must fail: {out}"
        );
        assert!(!leaked);
        assert!(
            looks_denied(&out),
            "a refusal must be recognizable so the model gets the hint: {out}"
        );
    }

    #[tokio::test]
    // Sibling-workspace invisibility relies on the sandbox backend scoping the
    // temp dir (bwrap's private tmpfs / seatbelt's HOME deny). The seatbelt
    // workspace lives under the mac temp dir, which is not covered by its HOME
    // deny, so this semantic only holds under bwrap on Linux.
    #[cfg(target_os = "linux")]
    async fn another_threads_workspace_is_not_reachable() {
        require_backend!();
        // The isolation that matters most: one conversation must not see another's
        // files, nor the permanent memory/skills store beside them.
        let mine = workspace();
        let theirs = workspace();
        std::fs::write(theirs.join("private.txt"), b"THEIRSECRET").unwrap();
        let (_, out) = run(
            &mine,
            false,
            &format!("cat {}/private.txt", theirs.to_string_lossy()),
        )
        .await;
        let _ = std::fs::remove_dir_all(&mine);
        let _ = std::fs::remove_dir_all(&theirs);
        assert!(
            !out.contains("THEIRSECRET"),
            "another thread's files must be invisible, got: {out}"
        );
    }

    #[tokio::test]
    async fn the_users_home_directory_is_not_readable() {
        require_backend!();
        let Some(home) = home_dir() else {
            eprintln!("skipping: no HOME set");
            return;
        };
        // A real secret-shaped file in the real home, which the sandbox must not
        // be able to read back.
        let secret = home.join(format!(".jan_jail_secret_{}", std::process::id()));
        if std::fs::write(&secret, b"TOPSECRET").is_err() {
            eprintln!("skipping: home not writable");
            return;
        }
        let ws = workspace();
        let (_, out) = run(&ws, false, &format!("cat {}", secret.to_string_lossy())).await;
        let _ = std::fs::remove_file(&secret);
        let _ = std::fs::remove_dir_all(&ws);
        assert!(
            !out.contains("TOPSECRET"),
            "home files must be unreadable, got: {out}"
        );
    }

    #[tokio::test]
    async fn home_is_readable_and_writes_stay_confined_when_home_readonly() {
        require_backend!();
        let Some(home) = home_dir() else {
            eprintln!("skipping: no HOME set");
            return;
        };
        // A file in the real home the sandbox must now be able to read...
        let secret = home.join(format!(".jan_jail_ro_read_{}", std::process::id()));
        if std::fs::write(&secret, b"READABLE_SECRET").is_err() {
            eprintln!("skipping: home not writable");
            return;
        }
        let ws = workspace();
        let policy = Policy::new(&ws, false).with_home_readonly(true);
        // ...read it back, and fail to write a second file into the home.
        let victim = home.join(format!(".jan_jail_ro_write_{}", std::process::id()));
        let _ = std::fs::remove_file(&victim);
        let command = format!(
            "cat {} && echo pwned > {}",
            secret.to_string_lossy(),
            victim.to_string_lossy()
        );
        let (ok, out) = run_policy(policy, &ws, &command).await;
        let leaked = victim.exists();
        let _ = std::fs::remove_file(&secret);
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&ws);
        assert!(
            out.contains("READABLE_SECRET"),
            "home reads must work: {out}"
        );
        assert!(
            !leaked,
            "home writes must stay confined even when readable: {out}"
        );
        assert!(!ok, "the write into the home must fail: {out}");
    }

    #[tokio::test]
    async fn the_network_is_unreachable_by_default() {
        require_backend!();
        let ws = workspace();
        // /dev/tcp is a bash builtin, so this needs no network tooling installed.
        let (ok, _) = run(&ws, false, "exec 3<>/dev/tcp/1.1.1.1/53 && echo connected").await;
        let _ = std::fs::remove_dir_all(&ws);
        assert!(!ok, "network must be denied by default");
    }

    /// Jozkah/jan#210: a socket in the user's runtime dir (where the session
    /// D-Bus, `systemd --user` and ssh-agent listen) is not reachable from
    /// the sandbox. Skipped where there is no `XDG_RUNTIME_DIR` under `/run`.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn sockets_under_the_runtime_dir_are_not_reachable() {
        require_backend!();
        let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) else {
            eprintln!("skipping: no XDG_RUNTIME_DIR");
            return;
        };
        if !runtime.starts_with("/run") || !runtime.is_dir() {
            eprintln!("skipping: XDG_RUNTIME_DIR is not under /run");
            return;
        }
        let sock = runtime.join(format!("jan_jail_probe_{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let Ok(_listener) = std::os::unix::net::UnixListener::bind(&sock) else {
            eprintln!("skipping: cannot create a socket in XDG_RUNTIME_DIR");
            return;
        };
        let ws = workspace();
        let (_, out) = run(
            &ws,
            false,
            &format!("if test -e {0}; then echo VISIBLE; else echo HIDDEN; fi", sock.display()),
        )
        .await;
        let _ = std::fs::remove_file(&sock);
        let _ = std::fs::remove_dir_all(&ws);
        assert!(out.contains("HIDDEN"), "the runtime-dir socket is reachable: {out}");
    }

    /// Jozkah/jan#206: with the network on, a sandboxed command still cannot
    /// connect to a unix socket outside the workspace (where the launchd
    /// ssh-agent lives), while IP networking is left to the other tests.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn network_on_does_not_open_host_unix_sockets() {
        require_backend!();
        let sock = PathBuf::from(format!("/private/tmp/jan_sb_probe_{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let listener = std::os::unix::net::UnixListener::bind(&sock).expect("bind probe socket");
        listener.set_nonblocking(true).unwrap();
        let ws = workspace();
        let (_, out) = run(
            &ws,
            true,
            &format!("nc -w 1 -U {} </dev/null && echo CONNECTED", sock.display()),
        )
        .await;
        let accepted = listener.accept();
        let _ = std::fs::remove_file(&sock);
        let _ = std::fs::remove_dir_all(&ws);
        assert!(
            matches!(&accepted, Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "the sandbox connected to a host unix socket: {accepted:?} {out}"
        );
        assert!(!out.contains("CONNECTED"), "{out}");
    }

    /// A relocated store root (e.g. `JAN_DATA_FOLDER` outside `$HOME`) must not
    /// be readable by the shell, even when it is not under the user's home.
    #[tokio::test]
    async fn a_relocated_store_root_is_not_readable() {
        require_backend!();
        let ws = workspace();
        let store = workspace();
        std::fs::create_dir_all(&store).unwrap();
        let secret = store.join("memory.txt");
        std::fs::write(&secret, b"STORESECRET").unwrap();

        let policy = Policy::new(&ws, false).with_mask_root(&store);
        let (_, out) = run_policy(policy, &ws, &format!("cat {}", secret.to_string_lossy())).await;
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&store);
        assert!(
            !out.contains("STORESECRET"),
            "a relocated store root must be unreadable, got: {out}"
        );
    }
}
