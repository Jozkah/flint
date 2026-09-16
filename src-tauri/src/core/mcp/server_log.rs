//! Each MCP server's own log, kept apart from the application's (AH-140).
//!
//! A server's stderr used to go to the application logger, interleaved with
//! everything else Flint does. Answering "why did that server stop" meant
//! searching one file for a prefix. Each server now has its own bounded log
//! under `<data folder>/mcp-logs/`, written by both the desktop and the CLI,
//! and readable from either.
//!
//! * **The server's name is never a path.** A server name is configuration a
//!   repository can supply; the file is named by a hash of it.
//! * **Bounded.** A chatty server rotates at [`MAX_BYTES`] into one previous
//!   generation, so a log can never grow past twice that.
//! * **Scrubbed.** A line goes through the harness scrubber before it is
//!   written: servers print tokens in their startup banners more often than
//!   anybody would like.

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The size a log rotates at.
pub const MAX_BYTES: u64 = 512 * 1024;
/// The longest line kept, in characters. The scrubber bounds what it returns
/// to the same length and marks a cut with ` [...]`, so a longer line is cut
/// there rather than twice with two different markers.
pub const MAX_LINE: usize = 600;

pub fn log_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("mcp-logs")
}

/// Where one server's log lives. The name is hashed, never joined.
pub fn path_for(data_folder: &Path, server: &str) -> PathBuf {
    let digest = Sha256::digest(server.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    log_dir(data_folder).join(format!("{}.log", &hex[..24]))
}

fn previous(path: &Path) -> PathBuf {
    path.with_extension("log.1")
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Append one line a server printed. Failures are swallowed: a server's
/// stderr is never allowed to take the server down with it.
pub fn append(data_folder: &Path, server: &str, line: &str) {
    let line = line.trim_end();
    if line.trim().is_empty() {
        return;
    }
    // Scrubbed whole, before any cut: cutting first could split a credential
    // so that the half left behind no longer looks like one.
    let scrubbed = tauri_plugin_agent_tools::harness_error::scrub(line);
    let path = path_for(data_folder, server);
    if std::fs::create_dir_all(log_dir(data_folder)).is_err() {
        return;
    }
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) >= MAX_BYTES {
        let _ = std::fs::rename(&path, previous(&path));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{} {}", now(), scrubbed.replace('\n', " "));
    }
}

/// The last `lines` lines a server printed, oldest first, across the rotation.
pub fn tail(data_folder: &Path, server: &str, lines: usize) -> Vec<String> {
    let path = path_for(data_folder, server);
    let mut all: Vec<String> = Vec::new();
    for file in [previous(&path), path] {
        if let Ok(text) = std::fs::read_to_string(&file) {
            all.extend(text.lines().map(str::to_string));
        }
    }
    let start = all.len().saturating_sub(lines.max(1));
    all.split_off(start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan_mcp_log_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn each_server_has_its_own_log_and_the_name_is_never_a_path() {
        let data = temp("own");
        append(&data, "alpha", "alpha started");
        append(&data, "beta", "beta started");
        append(&data, "../../escape", "nowhere to go");
        assert_eq!(tail(&data, "alpha", 10).len(), 1);
        assert!(tail(&data, "alpha", 10)[0].ends_with("alpha started"));
        assert!(tail(&data, "beta", 10)[0].ends_with("beta started"));
        let escaped = path_for(&data, "../../escape");
        assert_eq!(escaped.parent().unwrap(), log_dir(&data));
        assert!(tail(&data, "gamma", 10).is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_secret_a_server_prints_is_not_written() {
        let data = temp("secret");
        append(
            &data,
            "s",
            "token=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK ready",
        );
        let line = &tail(&data, "s", 1)[0];
        assert!(!line.contains("AAAABBBB"), "{line}");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_chatty_server_is_bounded_and_the_tail_spans_the_rotation() {
        let data = temp("rotate");
        let big = "x".repeat(MAX_LINE);
        // Each written line is about MAX_LINE bytes plus a timestamp.
        let n = (MAX_BYTES as usize / MAX_LINE) * 3;
        for i in 0..n {
            append(&data, "loud", &format!("{i} {big}"));
        }
        let path = path_for(&data, "loud");
        let current = std::fs::metadata(&path).unwrap().len();
        let prev = std::fs::metadata(previous(&path)).unwrap().len();
        assert!(current <= MAX_BYTES + 1024, "{current}");
        assert!(prev <= MAX_BYTES + 1024, "{prev}");
        let last = tail(&data, "loud", 2);
        assert!(last[1].contains(&format!(" {} ", n - 1)), "newest last");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn an_overlong_line_is_cut_and_marked() {
        let data = temp("long");
        append(&data, "s", &"é".repeat(MAX_LINE * 3));
        let line = &tail(&data, "s", 1)[0];
        assert!(line.ends_with(" [...]"), "{line}");
        assert!(line.chars().count() <= MAX_LINE + 40, "{}", line.chars().count());
        let _ = std::fs::remove_dir_all(&data);
    }

    /// The application logger (`tauri_plugin_log`) rotates only files named
    /// `app.log*` under `<data>/logs`. A server log lives under `<data>/mcp-logs`
    /// with a hashed name, so app.log rotation can never rotate or delete it --
    /// the log-retention fix keeps app.log's own segments, and independently
    /// managed server logs are out of its rotation domain entirely.
    #[test]
    fn a_server_log_is_out_of_the_app_logger_rotation_domain() {
        let data = temp("domain");
        let path = path_for(&data, "some-server");
        assert_eq!(
            path.parent().unwrap(),
            log_dir(&data),
            "server logs live under mcp-logs"
        );
        assert!(
            log_dir(&data).ends_with("mcp-logs"),
            "and never under the app logger's logs/ folder"
        );
        let file = path.file_name().unwrap().to_string_lossy();
        assert!(file.ends_with(".log") && file != "app.log");
        let _ = std::fs::remove_dir_all(&data);
    }
}
