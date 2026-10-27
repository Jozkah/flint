//! The one runner every `git` the agent starts goes through.
//!
//! Before this each helper built its own `Command`: some skipped the hardened
//! config (`vcs::HARDENED`), some skipped `GIT_TERMINAL_PROMPT=0`, none had a
//! deadline, so a git waiting on a lock, a network remote or a credential
//! prompt hung the caller forever. [`GitCmd`] always applies the hardened
//! config args, `GIT_TERMINAL_PROMPT=0`, the AppImage host environment and a
//! hidden console window, kills the process tree at the deadline, and bounds
//! how much stdout and stderr it keeps.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

/// How long a git may run before it is killed.
pub(crate) const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
/// Bytes of stdout kept; the rest is read and discarded.
pub(crate) const DEFAULT_STDOUT_CAP: usize = 64 * 1024 * 1024;
/// Bytes of stderr kept.
const STDERR_CAP: usize = 1024 * 1024;

/// What a finished git printed.
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub(crate) struct GitOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Stdout or stderr went past its cap and the rest was dropped.
    pub truncated: bool,
}

impl GitOutput {
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// Why git did not produce an output.
#[derive(Debug, Clone)]
pub(crate) struct GitError {
    pub message: String,
    /// The deadline passed and the process tree was killed.
    pub timed_out: bool,
}

impl GitError {
    /// `prefix` + the launch failure, or the timeout message unprefixed.
    pub fn with_prefix(&self, prefix: &str) -> String {
        if self.timed_out {
            self.message.clone()
        } else {
            format!("{prefix}{}", self.message)
        }
    }
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Builder for one git invocation.
pub(crate) struct GitCmd {
    program: PathBuf,
    dir: Option<PathBuf>,
    /// Extra `-c k=v` style arguments placed after the hardened config.
    pre: Vec<OsString>,
    args: Vec<OsString>,
    envs: Vec<(OsString, OsString)>,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
}

impl GitCmd {
    pub fn new() -> Self {
        Self {
            program: PathBuf::from("git"),
            dir: None,
            pre: Vec::new(),
            args: Vec::new(),
            envs: Vec::new(),
            stdin: None,
            timeout: DEFAULT_TIMEOUT,
            cap: DEFAULT_STDOUT_CAP,
        }
    }

    /// `git -C <dir>`.
    pub fn dir(mut self, dir: &Path) -> Self {
        self.dir = Some(dir.to_path_buf());
        self
    }
    /// A specific git binary instead of the one on `PATH`.
    pub fn program(mut self, program: &Path) -> Self {
        self.program = program.to_path_buf();
        self
    }
    /// Arguments that go between the hardened config and the subcommand.
    pub fn pre<S: AsRef<std::ffi::OsStr>>(mut self, pre: impl IntoIterator<Item = S>) -> Self {
        self.pre.extend(pre.into_iter().map(|s| s.as_ref().to_os_string()));
        self
    }
    pub fn args<S: AsRef<std::ffi::OsStr>>(mut self, args: impl IntoIterator<Item = S>) -> Self {
        self.args.extend(args.into_iter().map(|s| s.as_ref().to_os_string()));
        self
    }
    pub fn env(mut self, k: impl AsRef<std::ffi::OsStr>, v: impl AsRef<std::ffi::OsStr>) -> Self {
        self.envs.push((k.as_ref().to_os_string(), v.as_ref().to_os_string()));
        self
    }
    /// The fixed identity git needs for anything that might write a commit.
    pub fn flint_identity(self) -> Self {
        self.env("GIT_AUTHOR_NAME", "Flint")
            .env("GIT_AUTHOR_EMAIL", "agent@jan.ai")
            .env("GIT_COMMITTER_NAME", "Flint")
            .env("GIT_COMMITTER_EMAIL", "agent@jan.ai")
    }
    pub fn stdin(mut self, input: &[u8]) -> Self {
        self.stdin = Some(input.to_vec());
        self
    }
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
    #[allow(dead_code)]
    pub fn cap(mut self, cap: usize) -> Self {
        self.cap = cap;
        self
    }

    /// The configured `Command`, with the hardening and host environment
    /// applied. Public to the crate so the wiring can be tested.
    pub fn command(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        // Scrub first so an explicit `.env` below still wins.
        jan_process::HostProcessEnv::host_env(&mut cmd);
        if let Some(dir) = &self.dir {
            cmd.arg("-C").arg(dir);
        }
        cmd.args(crate::core::agent::vcs::HARDENED);
        cmd.args(&self.pre);
        cmd.args(&self.args);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        for (k, v) in &self.envs {
            cmd.env(k, v);
        }
        cmd
    }

    pub fn run(self) -> Result<GitOutput, GitError> {
        let mut what = self
            .args
            .first()
            .map(|a| a.to_string_lossy().into_owned())
            .unwrap_or_default();
        if what.is_empty() {
            what = "command".into();
        }
        let cmd = self.command();
        let mut out = run_command(cmd, self.stdin.as_deref(), self.timeout, self.cap);
        if let Err(e) = &mut out {
            if e.timed_out {
                e.message = format!("git {what} timed out after {}s", self.timeout.as_secs().max(1));
            }
        }
        out
    }
}

fn reader<R: Read + Send + 'static>(mut pipe: R, cap: usize) -> Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut over = false;
        let mut chunk = [0u8; 16 * 1024];
        // Keep reading past the cap and drop it: a child blocked on a full
        // pipe would otherwise never exit.
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let room = cap.saturating_sub(buf.len());
            if n > room {
                over = true;
            }
            buf.extend_from_slice(&chunk[..n.min(room)]);
        }
        let _ = tx.send((buf, over));
    });
    rx
}

/// Run `cmd` to completion under a deadline with bounded output. The process
/// tree is killed when the deadline passes. Hardening is the caller's job
/// ([`GitCmd::command`]); this is the part that can be tested with any command.
pub(crate) fn run_command(
    mut cmd: Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
    cap: usize,
) -> Result<GitOutput, GitError> {
    use std::io::Write;

    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    jan_utils::system::hide_console_window(&mut cmd);
    // Its own process group, so the kill reaches what git started.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let deadline = Instant::now() + timeout;
    let mut child = cmd
        .spawn()
        .map_err(|e| GitError { message: e.to_string(), timed_out: false })?;
    if let Some(input) = stdin {
        // From another thread so a child that fills its output pipe before it
        // has read all of its input cannot deadlock us.
        let mut pipe = child.stdin.take();
        let input = input.to_vec();
        std::thread::spawn(move || {
            if let Some(pipe) = pipe.as_mut() {
                let _ = pipe.write_all(&input);
            }
        });
    }
    let out_rx = child.stdout.take().map(|p| reader(p, cap));
    let err_rx = child.stderr.take().map(|p| reader(p, STDERR_CAP));

    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if Instant::now() >= deadline {
            timed_out = true;
            let _ = tauri_plugin_agent_tools::tools::proc::kill_tree_child(&mut child);
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if timed_out {
        return Err(GitError { message: "git timed out".into(), timed_out: true });
    }
    // A finished process closed its pipes unless a grandchild kept them, so
    // the wait is bounded.
    let grace = Duration::from_secs(5);
    let (stdout, o1) = out_rx.and_then(|r| r.recv_timeout(grace).ok()).unwrap_or_default();
    let (stderr, o2) = err_rx.and_then(|r| r.recv_timeout(grace).ok()).unwrap_or_default();
    Ok(GitOutput {
        success: status.is_some_and(|s| s.success()),
        code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        truncated: o1 || o2,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sleeper() -> Command {
        #[cfg(windows)]
        {
            let mut c = Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        }
        #[cfg(not(windows))]
        {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        }
    }

    #[test]
    fn hung_command_times_out_quickly() {
        let start = Instant::now();
        let err = run_command(sleeper(), None, Duration::from_millis(300), 1024).unwrap_err();
        assert!(err.timed_out);
        assert!(start.elapsed() < Duration::from_secs(5), "took {:?}", start.elapsed());
    }

    #[test]
    fn output_is_bounded_and_reports_truncation() {
        let out = GitCmd::new()
            .args(["--version"])
            .cap(3)
            .run()
            .expect("git runs");
        assert!(out.success);
        assert_eq!(out.stdout.len(), 3);
        assert!(out.truncated);
    }

    #[test]
    fn hardening_and_env_always_applied() {
        let cmd = GitCmd::new().dir(Path::new("repo")).args(["status"]).env("X", "1").command();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args[0], "-C");
        assert!(args.iter().any(|a| a == "core.hooksPath=/dev/null/jan-no-hooks"));
        assert_eq!(args.last().map(String::as_str), Some("status"));
        let envs: Vec<_> = cmd.get_envs().collect();
        let val = |k: &str| {
            envs.iter()
                .find(|(key, _)| *key == std::ffi::OsStr::new(k))
                .and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
        };
        assert_eq!(val("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(val("X").as_deref(), Some("1"));
    }

    #[test]
    fn host_env_scrub_is_applied() {
        // Under an AppImage the scrub removes/rewrites runtime variables; a
        // plain run must still get the same Command the trait produces.
        let mut expected = Command::new("git");
        jan_process::HostProcessEnv::host_env(&mut expected);
        let built = GitCmd::new().command();
        for (k, v) in expected.get_envs() {
            assert!(built.get_envs().any(|(bk, bv)| bk == k && bv == v), "{k:?} missing");
        }
    }
}
