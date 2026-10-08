//! Starting `flint serve` in the background and stopping it again.
//!
//! A running server records itself in `<data folder>/web-server/server.json`:
//! its process id, the address it listens on and a secret that lets
//! `flint stop` ask it to shut down cleanly. The file is private to the
//! account that runs the server. It is also how a second `flint serve` on the
//! same data folder is refused, and how a stale file left by a crash is
//! recognised: a file whose server does not answer is not "running".

use std::fs;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rand::RngCore;
use serde::{Deserialize, Serialize};

pub const SHUTDOWN_HEADER: &str = "x-flint-shutdown";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunFile {
    pub pid: u32,
    pub listen: SocketAddr,
    /// 256 random bits. Whoever can read this file may stop the server, which
    /// is the same person who could kill its process.
    pub shutdown_token: String,
}

fn dir(data_folder: &Path) -> PathBuf {
    data_folder.join("web-server")
}

pub fn run_file_path(data_folder: &Path) -> PathBuf {
    dir(data_folder).join("server.json")
}

pub fn log_file_path(data_folder: &Path) -> PathBuf {
    dir(data_folder).join("server.log")
}

pub fn credential_file_path(data_folder: &Path) -> PathBuf {
    dir(data_folder).join("first-run-credential")
}

pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Open a file for writing that only the owner can read, where the platform
/// has such a thing. Windows keeps the file in the user's profile.
pub fn create_private(path: &Path, exclusive: bool) -> io::Result<fs::File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

pub fn write_run_file(data_folder: &Path, run: &RunFile) -> io::Result<()> {
    let path = run_file_path(data_folder);
    let staging = path.with_extension(format!("{}.tmp", std::process::id()));
    {
        let mut file = create_private(&staging, false)?;
        file.write_all(&serde_json::to_vec(run).map_err(io::Error::other)?)?;
        file.sync_all()?;
    }
    fs::rename(&staging, &path).inspect_err(|_| {
        let _ = fs::remove_file(&staging);
    })
}

pub fn read_run_file(data_folder: &Path) -> Option<RunFile> {
    serde_json::from_slice(&fs::read(run_file_path(data_folder)).ok()?).ok()
}

/// Remove the run file, but only if it still names this process: a newer
/// server must not lose its record because an older one exited late.
pub fn remove_run_file(data_folder: &Path, pid: u32) {
    if read_run_file(data_folder).is_some_and(|run| run.pid == pid) {
        let _ = fs::remove_file(run_file_path(data_folder));
    }
}

/// The address to reach a server that listens on `listen` from this machine.
fn local_address(listen: SocketAddr) -> SocketAddr {
    let ip = if listen.ip().is_unspecified() {
        std::net::Ipv4Addr::LOCALHOST.into()
    } else {
        listen.ip()
    };
    SocketAddr::new(ip, listen.port())
}

/// One plain HTTP/1.1 request to `address`, answered with its status code.
///
/// Written against a socket rather than an HTTP client: this runs from the
/// `flint` command line, which is already inside an async runtime, and a
/// blocking client cannot be created and dropped there.
const LF: u8 = 10;
const CRLF: &str = "\r\n";

fn status_of(
    address: SocketAddr,
    method: &str,
    path: &str,
    extra_headers: &[(&str, &str)],
    timeout: Duration,
) -> io::Result<u16> {
    use std::io::{Read, Write as _};
    let mut stream = std::net::TcpStream::connect_timeout(&address, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let mut lines = vec![
        format!("{method} {path} HTTP/1.1"),
        format!("Host: {address}"),
        "Connection: close".to_string(),
        "Content-Length: 0".to_string(),
    ];
    for (name, value) in extra_headers {
        lines.push(format!("{name}: {value}"));
    }
    let request = format!("{}{CRLF}{CRLF}", lines.join(CRLF));
    stream.write_all(request.as_bytes())?;
    let mut head = [0u8; 64];
    let mut filled = 0;
    while filled < head.len() {
        let read = stream.read(&mut head[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
        if head[..filled].contains(&LF) {
            break;
        }
    }
    // "HTTP/1.1 200 OK"
    std::str::from_utf8(&head[..filled])
        .ok()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not an HTTP answer"))
}

/// Whether the server named by `run` answers. The Host header is the address it
/// listens on, which every server accepts for itself.
pub fn answers(run: &RunFile) -> bool {
    status_of(local_address(run.listen), "GET", "/healthz", &[], Duration::from_secs(2))
        .is_ok_and(|status| status == 200)
}

/// The server running on this data folder, if one answers.
pub fn running(data_folder: &Path) -> Option<RunFile> {
    read_run_file(data_folder).filter(answers)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Stopped {
    /// It was asked to stop and went away.
    Clean,
    /// It did not stop when asked, so its process was ended.
    Forced,
    /// Nothing was running; a stale record was removed if there was one.
    NotRunning,
}

fn end_process(pid: u32) {
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    #[cfg(not(windows))]
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

/// Ask the server on `data_folder` to shut down and wait for it to go. If it
/// does not answer the request or does not go within `wait`, its process is
/// ended, so `flint stop` always leaves the machine without the server.
pub fn stop(data_folder: &Path, wait: Duration) -> io::Result<Stopped> {
    let Some(run) = read_run_file(data_folder) else {
        return Ok(Stopped::NotRunning);
    };
    if !answers(&run) {
        // Nothing is listening: the file is left over from a crash. The process
        // may still exist (wedged), but a pid alone is not proof it is ours.
        let _ = fs::remove_file(run_file_path(data_folder));
        return Ok(Stopped::NotRunning);
    }
    let address = local_address(run.listen);
    let asked = status_of(
        address,
        "POST",
        "/api/v1/shutdown",
        &[(SHUTDOWN_HEADER, run.shutdown_token.as_str())],
        Duration::from_secs(5),
    )
    .is_ok_and(|status| status == 204);
    let deadline = Instant::now() + wait;
    while asked && Instant::now() < deadline {
        if !answers(&run) {
            let _ = fs::remove_file(run_file_path(data_folder));
            return Ok(Stopped::Clean);
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    end_process(run.pid);
    let _ = fs::remove_file(run_file_path(data_folder));
    Ok(Stopped::Forced)
}

/// What a background start produced.
#[derive(Debug)]
pub struct Started {
    pub pid: u32,
    pub listen: SocketAddr,
    pub log: PathBuf,
    /// Present only the first time a data folder is served.
    pub credential: Option<String>,
}

/// Start `exe` with `args` detached from this terminal, logging to the data
/// folder, and wait until it answers. `args` must not ask for a background
/// start again.
pub fn start_background(
    exe: &Path,
    args: &[String],
    data_folder: &Path,
    wait: Duration,
) -> Result<Started, String> {
    if let Some(run) = running(data_folder) {
        return Err(format!(
            "a Flint server is already running on {} (pid {}); stop it with `flint stop`",
            run.listen, run.pid
        ));
    }
    let log = log_file_path(data_folder);
    let credential_file = credential_file_path(data_folder);
    let _ = fs::remove_file(&credential_file);
    let log_out = create_private(&log, false).map_err(|e| format!("cannot open {}: {e}", log.display()))?;
    let log_err = log_out.try_clone().map_err(|e| e.to_string())?;

    let mut command = std::process::Command::new(exe);
    command
        .args(args)
        .arg("--credential-file")
        .arg(&credential_file)
        .stdin(std::process::Stdio::null())
        .stdout(log_out)
        .stderr(log_err);
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        use windows::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT};
        // Windows hands a new process every inheritable handle, so the server
        // would keep the caller's stdout pipe open for as long as it runs and
        // anything waiting for that pipe to close (a script, `| tee`) would
        // wait for the server. This process is about to exit, so its own
        // standard handles can simply stop being inheritable.
        let handles = [
            std::io::stdin().as_raw_handle(),
            std::io::stdout().as_raw_handle(),
            std::io::stderr().as_raw_handle(),
        ];
        for handle in handles {
            // SAFETY: the handles are this process's own; failure (no console,
            // an invalid handle) changes nothing and is ignored.
            unsafe {
                let _ = SetHandleInformation(HANDLE(handle), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0));
            }
        }
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        command.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("cannot start {}: {e}", exe.display()))?;
    let pid = child.id();

    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "the server exited at once ({status}). Last log lines:\n{}",
                log_tail(&log, 8)
            ));
        }
        if let Some(run) = read_run_file(data_folder).filter(|r| r.pid == pid && answers(r)) {
            let credential = fs::read_to_string(&credential_file).ok().map(|c| c.trim().to_string());
            let _ = fs::remove_file(&credential_file);
            return Ok(Started { pid, listen: run.listen, log, credential });
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "the server did not come up within {}s. Last log lines:\n{}",
        wait.as_secs(),
        log_tail(&log, 8)
    ))
}

fn log_tail(path: &Path, lines: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(pid: u32) -> RunFile {
        RunFile {
            pid,
            listen: "127.0.0.1:1".parse().unwrap(),
            shutdown_token: new_token(),
        }
    }

    #[test]
    fn the_run_file_round_trips_and_is_removed_only_by_its_owner() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_run_file(dir.path()).is_none());
        let mine = run(std::process::id());
        write_run_file(dir.path(), &mine).unwrap();
        assert_eq!(read_run_file(dir.path()), Some(mine.clone()));
        remove_run_file(dir.path(), mine.pid + 1);
        assert!(read_run_file(dir.path()).is_some(), "another pid must not remove it");
        remove_run_file(dir.path(), mine.pid);
        assert!(read_run_file(dir.path()).is_none());
    }

    #[test]
    fn tokens_are_long_and_different_each_time() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn a_record_with_nothing_listening_is_not_running_and_is_cleared_by_stop() {
        let dir = tempfile::tempdir().unwrap();
        // Port 1 is never a Flint server.
        write_run_file(dir.path(), &run(std::process::id())).unwrap();
        assert!(running(dir.path()).is_none());
        assert_eq!(stop(dir.path(), Duration::from_secs(1)).unwrap(), Stopped::NotRunning);
        assert!(read_run_file(dir.path()).is_none());
        assert_eq!(stop(dir.path(), Duration::from_secs(1)).unwrap(), Stopped::NotRunning);
    }

    #[test]
    fn a_wildcard_listener_is_reached_on_loopback() {
        let any: SocketAddr = "0.0.0.0:1340".parse().unwrap();
        assert_eq!(local_address(any), "127.0.0.1:1340".parse::<SocketAddr>().unwrap());
        let tail: SocketAddr = "100.65.0.12:1340".parse().unwrap();
        assert_eq!(local_address(tail), tail);
    }
}
