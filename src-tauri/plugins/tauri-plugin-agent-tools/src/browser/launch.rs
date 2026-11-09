//! Starting and stopping the confined browser.
//!
//! Shared by the scripted verify run and the interactive session: both get a
//! browser with a throwaway profile, a dead proxy and the origin policy, one
//! tab that is confined before it loads anything, and the same teardown (the
//! whole process tree is killed and the profile deleted).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc::UnboundedReceiver;

use super::cdp::{self, Cdp, Event};
use super::confine::{browser_args, loopback_ip, running_as_root, Origin, OriginPolicy};

/// A throwaway browser profile on disk. Deleted by [`ProfileDir::remove`], or
/// when dropped, so an abandoned browser never leaves its profile behind.
#[derive(Debug)]
pub struct ProfileDir {
    path: PathBuf,
    removed: bool,
}

impl ProfileDir {
    pub fn create(prefix: &str) -> Result<Self, String> {
        let dir = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .map_err(|e| format!("could not create a temporary profile: {e}"))?;
        // Ownership moves to us: the guard below deletes it, with retries.
        Ok(ProfileDir { path: dir.keep(), removed: false })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Delete the profile, retrying while the browser still holds files.
    pub fn remove_blocking(&mut self) -> bool {
        self.removed = remove_dir_with_retries(&self.path);
        self.removed
    }

    pub async fn remove(mut self) -> bool {
        let path = self.path.clone();
        let ok = tokio::task::spawn_blocking(move || remove_dir_with_retries(&path))
            .await
            .unwrap_or(false);
        self.removed = ok;
        ok
    }
}

impl Drop for ProfileDir {
    fn drop(&mut self) {
        if !self.removed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

/// On Windows the browser can hold files a moment after it exits.
pub fn remove_dir_with_retries(path: &Path) -> bool {
    for _ in 0..10 {
        if std::fs::remove_dir_all(path).is_ok() || !path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    !path.exists()
}

/// Whether something accepts connections at an allowed origin.
pub async fn port_open(origin: &Origin) -> bool {
    let host = origin.socket_host();
    let addr = match loopback_ip(&host) {
        Some(ip) => std::net::SocketAddr::new(ip, origin.port),
        None => return false,
    };
    matches!(
        tokio::time::timeout(Duration::from_millis(800), tokio::net::TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// Read the browser's stderr until it names its DevTools endpoint.
#[cfg(not(unix))]
async fn devtools_url(child: &mut Child) -> Result<String, String> {
    let stderr = child.stderr.take().ok_or("no stderr from the browser")?;
    let mut lines = BufReader::new(stderr).lines();
    let found = tokio::time::timeout(Duration::from_secs(20), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(i) = line.find("ws://") {
                return Some(line[i..].trim().to_string());
            }
        }
        None
    })
    .await;
    // Keep draining so a chatty browser never blocks on a full pipe.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    match found {
        Ok(Some(url)) => Ok(url),
        Ok(None) => Err("the browser exited before it started".to_string()),
        Err(_) => Err("the browser did not start within 20 s".to_string()),
    }
}

/// How [`connect`] reaches the browser [`spawn`] started (see
/// [`DEVTOOLS_TRANSPORT_ARG`](super::confine::DEVTOOLS_TRANSPORT_ARG)).
pub enum DevTools {
    /// The browser prints a `ws://` loopback endpoint on stderr.
    #[cfg(not(unix))]
    Port,
    /// This process's ends of the pipes the browser holds as fd 3 (it reads
    /// commands) and fd 4 (it writes answers and events).
    #[cfg(unix)]
    Pipe {
        to_browser: tokio::net::unix::pipe::Sender,
        from_browser: tokio::net::unix::pipe::Receiver,
    },
}

/// A started browser: process, profile, and nothing yet connected.
pub struct Spawned {
    pub child: Child,
    pub profile: ProfileDir,
    pub devtools: DevTools,
}

/// Start the browser with `policy`'s confinement and a fresh profile named
/// `profile_prefix`. The process leads its own group so the whole tree can be
/// stopped, and has no console window.
pub fn spawn(browser_path: &str, profile_prefix: &str, policy: &OriginPolicy) -> Result<Spawned, String> {
    use jan_process::CommandConsole;
    let profile = ProfileDir::create(profile_prefix)?;
    let mut cmd = tokio::process::Command::new(browser_path);
    // A system Chrome loads its own libraries, not the AppImage's.
    jan_process::HostProcessEnv::host_env(&mut cmd);
    cmd.args(browser_args(profile.path(), running_as_root(), policy.allowed()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .background_in_new_group();
    #[cfg(unix)]
    let (devtools, child_ends) = devtools_pipe::attach(&mut cmd)?;
    #[cfg(not(unix))]
    let devtools = DevTools::Port;
    let child = cmd.spawn().map_err(|e| format!("could not start {browser_path}: {e}"))?;
    // The browser has its own copies now; ours would keep the pipe open after
    // it exits, so the reader would never see the end.
    #[cfg(unix)]
    drop(child_ends);
    Ok(Spawned { child, profile, devtools })
}

/// Connect to the browser's DevTools: over its pipe on Unix, or, on Windows,
/// once it names its endpoint on stderr.
pub async fn connect(child: &mut Child, devtools: DevTools) -> Result<(Cdp, UnboundedReceiver<Event>), String> {
    match devtools {
        #[cfg(not(unix))]
        DevTools::Port => {
            let ws = devtools_url(child).await?;
            cdp::connect(&ws).await
        }
        #[cfg(unix)]
        DevTools::Pipe { to_browser, from_browser } => {
            // Nothing is read from stderr on this path, but a chatty browser
            // must never block on a full pipe.
            if let Some(stderr) = child.stderr.take() {
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(_)) = lines.next_line().await {}
                });
            }
            Ok(cdp::connect_pipe(to_browser, from_browser))
        }
    }
}

/// Handing the browser its DevTools pipe as fds 3 and 4 (Unix).
#[cfg(unix)]
mod devtools_pipe {
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

    use super::DevTools;

    /// The browser's ends, kept open in this process until it has spawned.
    pub struct ChildEnds {
        _reads: OwnedFd,
        _writes: OwnedFd,
    }

    /// A pipe whose ends are not inherited by anything spawned meanwhile.
    /// (`pipe2` is Linux-only; between `pipe` and `fcntl` another thread's
    /// spawn could inherit an end, which would only delay end-of-file.)
    fn cloexec_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
        let mut fds: [libc::c_int; 2] = [0; 2];
        // SAFETY: `fds` is a live two-element array, as pipe(2) requires.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: pipe(2) succeeded, so both are fresh descriptors this
        // process owns and nothing else will close.
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        for fd in [&read, &write] {
            // SAFETY: `fd` is an open descriptor owned above.
            if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok((read, write))
    }

    /// Put `reads` at fd 3 and `writes` at fd 4 in the child. Runs between
    /// fork and exec, so only async-signal-safe calls: both are first copied
    /// above 10 so neither can be overwritten by the other's `dup2`, and
    /// `dup2` clears close-on-exec on the copies at 3 and 4.
    fn place(reads: RawFd, writes: RawFd) -> io::Result<()> {
        // SAFETY: plain descriptor calls on descriptors open in this (child)
        // process; no memory is touched.
        unsafe {
            let r = libc::fcntl(reads, libc::F_DUPFD, 10);
            if r < 0 {
                return Err(io::Error::last_os_error());
            }
            let w = libc::fcntl(writes, libc::F_DUPFD, 10);
            if w < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::dup2(r, 3) < 0 || libc::dup2(w, 4) < 0 {
                return Err(io::Error::last_os_error());
            }
            libc::close(r);
            libc::close(w);
        }
        Ok(())
    }

    /// Create the two pipes, arrange for `cmd`'s child to hold its ends at
    /// fds 3 and 4, and return this process's ends. Must run inside the tokio
    /// runtime (the ends are registered with it).
    pub fn attach(cmd: &mut tokio::process::Command) -> Result<(DevTools, ChildEnds), String> {
        let fail = |e: io::Error| format!("could not create the browser's DevTools pipe: {e}");
        let (browser_reads, we_write) = cloexec_pipe().map_err(fail)?;
        let (we_read, browser_writes) = cloexec_pipe().map_err(fail)?;
        let to_browser = tokio::net::unix::pipe::Sender::from_owned_fd(we_write).map_err(fail)?;
        let from_browser = tokio::net::unix::pipe::Receiver::from_owned_fd(we_read).map_err(fail)?;
        let (reads, writes) = (browser_reads.as_raw_fd(), browser_writes.as_raw_fd());
        // SAFETY: `place` only calls async-signal-safe functions on the two
        // raw descriptors, which stay open until after spawn (`ChildEnds`).
        unsafe {
            cmd.pre_exec(move || place(reads, writes));
        }
        Ok((
            DevTools::Pipe { to_browser, from_browser },
            ChildEnds { _reads: browser_reads, _writes: browser_writes },
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        /// A stand-in browser that copies fd 3 to fd 4: what is written to our
        /// end comes back on the other, so both fds landed where Chrome reads.
        #[tokio::test]
        async fn the_child_reads_fd_3_and_writes_fd_4() {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.args(["-c", "cat <&3 >&4"]).kill_on_drop(true);
            let (devtools, ends) = attach(&mut cmd).unwrap();
            let mut child = cmd.spawn().unwrap();
            drop(ends);
            let DevTools::Pipe { mut to_browser, mut from_browser } = devtools;
            to_browser.write_all(b"{\"id\":1}\0").await.unwrap();
            drop(to_browser);
            let mut back = Vec::new();
            tokio::time::timeout(std::time::Duration::from_secs(10), from_browser.read_to_end(&mut back))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(back, b"{\"id\":1}\0");
            let _ = child.wait().await;
        }
    }
}

/// A tab of our own, confined before it loads anything. Returns the page's
/// target id (also its main frame id) and the flat-mode session for it. The
/// launch tab is closed: this session did not confine it.
pub async fn open_confined_tab(cdp: &Cdp) -> Result<(String, String), String> {
    let setup = async {
        let target = cdp.call("Target.createTarget", json!({ "url": "about:blank" }), None).await?;
        let target_id = target["targetId"].as_str().ok_or("no target")?.to_string();
        let attached = cdp
            .call("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None)
            .await?;
        let session = attached["sessionId"].as_str().ok_or("no session")?.to_string();
        if let Ok(list) = cdp.call("Target.getTargets", json!({}), None).await {
            for t in list["targetInfos"].as_array().cloned().unwrap_or_default() {
                if t["type"] == "page" && t["targetId"].as_str() != Some(target_id.as_str()) {
                    cdp.fire("Target.closeTarget", json!({ "targetId": t["targetId"] }), None);
                }
            }
        }
        Ok::<_, String>((target_id, session))
    };
    match tokio::time::timeout(Duration::from_secs(15), setup).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("could not open a tab: {e}")),
        Err(_) => Err("the browser did not open a tab in time".into()),
    }
}

/// Turn on interception and reporting for the tab. Interception is on before
/// anything can load, and children (frames, workers) are paused on start so
/// the event loop can confine them first.
pub async fn enable_tab(cdp: &Cdp, session: &str) -> Result<(), String> {
    for (method, params) in [
        ("Fetch.enable", json!({ "patterns": [{ "urlPattern": "*" }] })),
        ("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })),
        ("Page.enable", json!({})),
        ("Runtime.enable", json!({})),
        ("Log.enable", json!({})),
        ("Network.enable", json!({})),
    ] {
        cdp.call(method, params, Some(session))
            .await
            .map_err(|e| format!("could not set up the tab ({method}): {e}"))?;
    }
    Ok(())
}

/// Kill the browser and every process it started, then reap the child.
pub async fn kill(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = crate::tools::proc::kill_tree(pid);
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

/// The result of a DevTools call that carries a JS exception, as text.
pub fn exception_text(details: &Value) -> String {
    details["exception"]["description"]
        .as_str()
        .or(details["text"].as_str())
        .unwrap_or("script error")
        .to_string()
}
