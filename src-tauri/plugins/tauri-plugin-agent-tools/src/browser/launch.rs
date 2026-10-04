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

/// A started browser: process, profile, and nothing yet connected.
pub struct Spawned {
    pub child: Child,
    pub profile: ProfileDir,
}

/// Start the browser with `policy`'s confinement and a fresh profile named
/// `profile_prefix`. The process leads its own group so the whole tree can be
/// stopped, and has no console window.
pub fn spawn(browser_path: &str, profile_prefix: &str, policy: &OriginPolicy) -> Result<Spawned, String> {
    use jan_process::CommandConsole;
    let profile = ProfileDir::create(profile_prefix)?;
    let mut cmd = tokio::process::Command::new(browser_path);
    cmd.args(browser_args(profile.path(), running_as_root(), policy.allowed()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .background_in_new_group();
    let child = cmd.spawn().map_err(|e| format!("could not start {browser_path}: {e}"))?;
    Ok(Spawned { child, profile })
}

/// Wait for the browser to name its DevTools endpoint and connect to it.
pub async fn connect(child: &mut Child) -> Result<(Cdp, UnboundedReceiver<Event>), String> {
    let ws = devtools_url(child).await?;
    cdp::connect(&ws).await
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
