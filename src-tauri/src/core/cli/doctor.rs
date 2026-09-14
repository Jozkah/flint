//! A previewed, local-only diagnostic bundle (`jan bug-report`, `/bug`).
//!
//! Adapted from janhq/jan#8713 (thinhlpg), with one change of shape: nothing is
//! written until the user has seen what would be. [`prepare`] collects and
//! redacts everything in memory -- version, environment, one thread, the tail
//! of the persistent log -- and returns a [`Preview`] listing each member, its
//! size and what was stripped. [`Preview::save`] writes that exact content as a
//! `.tar.gz` and is the final action. There is no upload, no issue creation,
//! no network request of any kind: the archive is a local file the user may
//! choose to attach somewhere themselves.

use std::fs;
use std::path::{Path, PathBuf};

use flate2::write::GzEncoder;
use flate2::Compression;

use crate::core::cli::secrets::Redactor;
use crate::core::threads::constants::{MESSAGES_FILE, THREADS_FILE};
use crate::core::threads::utils::{get_thread_dir, get_thread_metadata_path};

/// How much of the log the bundle carries.
const LOG_TAIL_LINES: usize = 2000;

fn read_opt(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// Last `max_lines` lines of the log, spanning rotated segments oldest-first,
/// so a trail that crossed a rotation still reads in order.
fn tail(path: &Path, max_lines: usize) -> Option<String> {
    let mut content = String::new();
    for k in (1..=crate::core::cli::file_log::KEEP_SEGMENTS).rev() {
        if let Some(seg) = read_opt(&crate::core::cli::file_log::segment_path(path, k)) {
            content.push_str(&seg);
        }
    }
    content.push_str(&read_opt(path)?);
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    Some(lines[start..].join("\n"))
}

/// The thread to bundle: an explicit one when given (it must exist, and must
/// name one directory -- no separators, no `..`), else the most recently
/// updated thread under `<base>/threads/`.
fn resolve_thread_id(base: &Path, explicit: Option<&str>) -> Result<String, String> {
    if let Some(id) = explicit {
        let id = id.trim();
        if id.is_empty() {
            return Err("empty thread id".to_string());
        }
        if id.contains('/') || id.contains('\\') || id.contains("..") {
            return Err(format!("invalid thread id '{id}'"));
        }
        if !get_thread_dir(base, id).is_dir() {
            return Err(format!(
                "thread '{id}' not found under {} - run `flint cli threads list` to see ids",
                base.join("threads").display()
            ));
        }
        return Ok(id.to_string());
    }
    let mut threads = crate::core::cli::list_threads_in(base)?;
    if threads.is_empty() {
        return Err("no threads found - run a session first, or pass --thread <id>".to_string());
    }
    crate::core::cli::sort_threads_recent(&mut threads);
    threads
        .first()
        .and_then(|t| t.get("id").and_then(|v| v.as_str()))
        .map(str::to_string)
        .ok_or_else(|| "latest thread has no id".to_string())
}

/// What would be written, before anything is.
#[derive(Debug, Clone)]
pub struct Preview {
    /// Where [`Preview::save`] will write. Does not exist yet.
    pub destination: PathBuf,
    /// Member name and its redacted content, in archive order.
    pub members: Vec<(String, String)>,
    /// A human line per redaction rule that fired, with its count.
    pub stripped: Vec<String>,
}

impl Preview {
    pub fn redacted_any(&self) -> bool {
        !self.stripped.is_empty()
    }

    /// The redacted content of one member, for review before saving.
    pub fn member(&self, name: &str) -> Option<&str> {
        self.members
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, c)| c.as_str())
    }

    /// What the user reads before deciding: every member with its size, what
    /// was stripped, where the file would go, and that nothing leaves the
    /// machine.
    pub fn summary(&self) -> Vec<String> {
        let mut out = vec![format!(
            "Diagnostic bundle preview (nothing written yet): {}",
            self.destination.display()
        )];
        for (name, content) in &self.members {
            out.push(format!(
                "  {name}  {} bytes, {} lines",
                content.len(),
                content.lines().count()
            ));
        }
        if self.redacted_any() {
            out.push(format!("Known secrets stripped: {}", self.stripped.join(", ")));
            out.push("The scan is best-effort: review the members before sharing.".to_string());
        } else {
            out.push(
                "No known secret patterns matched (best-effort scan; review before sharing)."
                    .to_string(),
            );
        }
        out.push(
            "Saving writes one local file. Nothing is uploaded or sent anywhere.".to_string(),
        );
        out
    }

    /// Write exactly the previewed content. Refuses to overwrite: a bundle is
    /// a record of one moment, and a second save gets its own name.
    pub fn save(&self) -> Result<PathBuf, String> {
        use std::io::Write;

        let parent = self
            .destination
            .parent()
            .ok_or_else(|| format!("no parent for {}", self.destination.display()))?;
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.destination)
            .map_err(|e| format!("cannot create {}: {e}", self.destination.display()))?;
        let mut tar = tar::Builder::new(GzEncoder::new(file, Compression::default()));
        for (name, content) in &self.members {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, name, content.as_bytes())
                .map_err(|e| format!("archive write error: {e}"))?;
        }
        let enc = tar
            .into_inner()
            .map_err(|e| format!("archive finalize error: {e}"))?;
        let mut file = enc.finish().map_err(|e| format!("gzip finish error: {e}"))?;
        file.flush().map_err(|e| format!("flush error: {e}"))?;
        Ok(self.destination.clone())
    }
}

/// Collect and redact the bundle for one thread, writing nothing.
///
/// `threads_base` is where `threads/` lives (the data folder, or a project's
/// `.jan/agent`); `data_folder` holds the log; `out_dir` is where the archive
/// would go (default `<data folder>/diagnostics`).
pub fn prepare(
    threads_base: &Path,
    data_folder: &Path,
    thread_id: Option<&str>,
    out_dir: Option<&Path>,
) -> Result<Preview, String> {
    let id = resolve_thread_id(threads_base, thread_id)?;
    let thread_meta =
        read_opt(&get_thread_metadata_path(threads_base, &id)).unwrap_or_else(|| "{}".into());
    let thread_dir = get_thread_dir(threads_base, &id);
    let messages = read_opt(&thread_dir.join(MESSAGES_FILE)).unwrap_or_default();
    let journal = read_opt(&thread_dir.join("display.jsonl")).unwrap_or_default();
    let log_tail = tail(
        &crate::core::cli::file_log::log_path(data_folder),
        LOG_TAIL_LINES,
    )
    .unwrap_or_default();

    // Model and provider names from the thread metadata; never keys.
    let meta: serde_json::Value = serde_json::from_str(&thread_meta).unwrap_or_default();
    let field = |k: &str| {
        meta.get("model")
            .and_then(|m| m.get(k))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string()
    };

    let redactor = Redactor::new();
    let mut hits = vec![0usize; redactor.rules.len()];
    let mut other = 0usize;
    // The regex rules first, then the agent tools' own line-shape scanner,
    // which also recognises `PASSWORD = ...` and connection strings that carry
    // no recognisable token. Two passes, one verdict: anything either finds is
    // gone.
    let mut redact = |text: &str| {
        let first = redactor.redact(text, &mut hits);
        let second = tauri_plugin_agent_tools::secrets::redact_secrets(&first);
        let trailing_newline = first.ends_with('\n') && !second.ends_with('\n');
        other += first
            .lines()
            .zip(second.lines())
            .filter(|(a, b)| a != b)
            .count();
        if trailing_newline {
            format!("{second}\n")
        } else {
            second
        }
    };

    let members = vec![
        (
            "version.txt".to_string(),
            format!("{}\n", crate::core::cli::version::build_version()),
        ),
        (
            "environment.txt".to_string(),
            format!(
                "os={}\narch={}\nmodel={}\nprovider={}\nthread_id={}\n",
                std::env::consts::OS,
                std::env::consts::ARCH,
                field("id"),
                field("provider"),
                id
            ),
        ),
        (format!("thread/{THREADS_FILE}"), redact(&thread_meta)),
        (format!("thread/{MESSAGES_FILE}"), redact(&messages)),
        ("thread/display.jsonl".to_string(), redact(&journal)),
        ("logs/jan.log".to_string(), redact(&log_tail)),
    ];

    let mut stripped: Vec<String> = redactor
        .rules
        .iter()
        .zip(&hits)
        .filter(|(_, &n)| n > 0)
        .map(|(r, &n)| format!("{} ({n}x)", r.label))
        .collect();
    if other > 0 {
        stripped.push(format!("other credential-shaped lines ({other}x)"));
    }

    let dir = out_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| data_folder.join("diagnostics"));
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut destination = dir.join(format!("jan-bug-report-{ts}.tar.gz"));
    let mut n = 1;
    while destination.exists() {
        destination = dir.join(format!("jan-bug-report-{ts}-{n}.tar.gz"));
        n += 1;
    }

    Ok(Preview {
        destination,
        members,
        stripped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            static N: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "jan-doctor-{tag}-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn every_file(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p);
                }
            }
        }
        out.sort();
        out
    }

    fn seed_thread(base: &Path, id: &str, messages: &str) {
        let dir = get_thread_dir(base, id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            get_thread_metadata_path(base, id),
            serde_json::json!({
                "id": id,
                "title": "t",
                "updated": 1,
                "model": { "id": "pxa-27b", "provider": "custom" }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(dir.join(MESSAGES_FILE), messages).unwrap();
    }

    fn unpack(path: &Path) -> Vec<(String, String)> {
        use std::io::Read;
        let gz = flate2::read::GzDecoder::new(fs::File::open(path).unwrap());
        let mut tar = tar::Archive::new(gz);
        tar.entries()
            .unwrap()
            .map(|e| {
                let mut e = e.unwrap();
                let name = e.path().unwrap().display().to_string();
                let mut content = String::new();
                e.read_to_string(&mut content).unwrap();
                (name, content)
            })
            .collect()
    }

    /// Preparing writes nothing at all: the user decides after seeing it.
    #[test]
    fn preparing_writes_nothing() {
        let root = Scratch::new("nowrite");
        seed_thread(&root.0, "t1", "{\"role\":\"user\",\"content\":\"hi\"}\n");
        let before = every_file(&root.0);
        let preview = prepare(&root.0, &root.0, Some("t1"), None).expect("prepares");
        assert_eq!(every_file(&root.0), before, "prepare wrote to disk");
        assert!(!preview.destination.exists());
        assert!(preview
            .summary()
            .iter()
            .any(|l| l.contains("Nothing is uploaded")));
    }

    /// Saving writes exactly what was previewed, and nothing that was
    /// redacted survives in any member.
    #[test]
    fn saving_writes_exactly_the_previewed_redacted_members() {
        let root = Scratch::new("save");
        let key = concat!("sk-", "abcdefghijklmnopqrstu");
        let seeded = [
            format!("{{\"role\":\"user\",\"content\":\"{key}\"}}\n"),
            "{\"role\":\"user\",\"content\":\"Authorization: Bearer abcXYZ0123456789def\"}\n"
                .to_string(),
            "{\"role\":\"user\",\"content\":\"DB_PASSWORD = hunter2hunter2\"}\n".to_string(),
        ]
        .concat();
        seed_thread(&root.0, "t1", &seeded);
        fs::create_dir_all(root.0.join("logs")).unwrap();
        fs::write(
            crate::core::cli::file_log::log_path(&root.0),
            format!("2026 INFO [x] upstream said {key}\n"),
        )
        .unwrap();

        let out = root.0.join("out");
        let preview = prepare(&root.0, &root.0, Some("t1"), Some(&out)).expect("prepares");
        assert!(preview.redacted_any(), "{:?}", preview.stripped);
        for (name, content) in &preview.members {
            assert!(!content.contains(key), "{name} carries the key");
            assert!(!content.contains("abcXYZ0123456789def"), "{name} carries the bearer");
            assert!(!content.contains("hunter2hunter2"), "{name} carries the password");
        }

        let path = preview.save().expect("saves");
        assert!(path.starts_with(&out), "saved outside the chosen directory");
        let members = unpack(&path);
        assert_eq!(members, preview.members, "the archive is the preview");
        assert_eq!(every_file(&out), vec![path.clone()], "one file, nothing else");

        // A second save of the same preview never overwrites the first.
        assert!(preview.save().is_err(), "overwrote an existing bundle");
    }

    #[test]
    fn a_member_can_be_read_before_saving() {
        let root = Scratch::new("member");
        seed_thread(&root.0, "t1", "{\"role\":\"user\",\"content\":\"hello\"}\n");
        let preview = prepare(&root.0, &root.0, Some("t1"), None).expect("prepares");
        assert!(preview
            .member("thread/messages.jsonl")
            .is_some_and(|m| m.contains("hello")));
        assert!(preview.member("no/such/member").is_none());
    }

    /// A misspelled thread fails loudly instead of bundling an empty session.
    #[test]
    fn an_explicit_thread_must_exist() {
        let root = Scratch::new("exists");
        seed_thread(&root.0, "real-one", "");
        assert_eq!(resolve_thread_id(&root.0, Some("real-one")).unwrap(), "real-one");
        let err = resolve_thread_id(&root.0, Some("typo-here")).expect_err("must not succeed");
        assert!(err.contains("not found"), "{err}");
        assert!(resolve_thread_id(&root.0, Some("   ")).is_err());
    }

    /// A thread id names one directory; a separator or `..` would reach
    /// outside the threads tree.
    #[test]
    fn an_explicit_thread_rejects_path_traversal() {
        let root = Scratch::new("traversal");
        fs::create_dir_all(root.0.join("threads")).unwrap();
        for bad in ["../../../etc", "..", "a/b", "a\\b", "../threads"] {
            let err = resolve_thread_id(&root.0, Some(bad)).expect_err(bad);
            assert!(err.contains("invalid thread id"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn with_no_thread_the_latest_is_bundled() {
        let root = Scratch::new("latest");
        seed_thread(&root.0, "only", "");
        let preview = prepare(&root.0, &root.0, None, None).expect("prepares");
        assert!(preview
            .member("environment.txt")
            .is_some_and(|e| e.contains("thread_id=only") && e.contains("model=pxa-27b")));
    }

    #[test]
    fn the_log_tail_spans_rotated_segments_oldest_first() {
        let root = Scratch::new("tail");
        let active = crate::core::cli::file_log::log_path(&root.0);
        fs::create_dir_all(active.parent().unwrap()).unwrap();
        fs::write(crate::core::cli::file_log::segment_path(&active, 2), "oldest\n").unwrap();
        fs::write(crate::core::cli::file_log::segment_path(&active, 1), "middle\n").unwrap();
        fs::write(&active, "newest\n").unwrap();
        assert_eq!(tail(&active, 100).unwrap(), "oldest\nmiddle\nnewest");
        assert_eq!(tail(&active, 1).unwrap(), "newest");
    }

    #[test]
    fn plain_text_is_left_alone() {
        let root = Scratch::new("plain");
        let text = "{\"role\":\"user\",\"content\":\"the quick brown fox, model=gpt-4\"}\n";
        seed_thread(&root.0, "t1", text);
        let preview = prepare(&root.0, &root.0, Some("t1"), None).expect("prepares");
        assert_eq!(preview.member("thread/messages.jsonl"), Some(text));
        assert!(!preview.redacted_any(), "{:?}", preview.stripped);
    }
}
