//! Is the program that performs the confined spawn the one Flint shipped?
//!
//! On Windows every sandboxed command is run by a helper (this binary, or
//! `JAN_SANDBOX_HELPER_EXE`) that builds the AppContainer. If that file is
//! swapped for something that spawns the command without confinement, every
//! later `bash` call would quietly run unsandboxed. So before each sandboxed
//! exec [`verify`] checks the helper against the digest the app expects, and
//! the caller refuses -- it never falls back to an unsandboxed run.
//!
//! What "expected" means, strongest first:
//! 1. `JAN_SANDBOX_HELPER_SHA256` -- a digest pinned by whoever launched the
//!    process (an installer, a policy script);
//! 2. a `<helper>.sha256` file next to the helper, as an installer would ship;
//! 3. the digest the file had the first time this process looked at it, so a
//!    helper replaced or patched after the app started is caught even where
//!    nothing was shipped to compare with. This baseline is enforced on top of
//!    1 and 2, not instead of them: whoever can swap the helper can usually
//!    write a matching `.sha256` next to it too.
//!
//! The check is cheap: the full digest is recomputed only when the file's
//! length, modification time or a hash of its first and last 64 KiB changed
//! since the last successful check. The probe is there because length and
//! mtime alone are attacker-controlled: a same-size swap with its mtime reset
//! would otherwise pass on the cache.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

/// Env override (through `compat_env`, so `FLINT_`/`JAN_` spellings both work).
pub const PINNED_ENV: &str = "SANDBOX_HELPER_SHA256";

#[derive(Clone, PartialEq, Eq)]
struct Seen {
    len: u64,
    modified: Option<SystemTime>,
    probe: String,
    digest: String,
}

const PROBE_BYTES: u64 = 64 * 1024;

/// SHA-256 of the first and last [`PROBE_BYTES`] of `path` (the whole file
/// when it is smaller than both together).
fn probe_digest(path: &Path, len: u64) -> std::io::Result<String> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = Vec::new();
    (&mut file).take(PROBE_BYTES).read_to_end(&mut buf)?;
    hasher.update(&buf);
    if len > PROBE_BYTES {
        let tail_from = len.saturating_sub(PROBE_BYTES).max(PROBE_BYTES);
        file.seek(SeekFrom::Start(tail_from))?;
        buf.clear();
        file.take(PROBE_BYTES).read_to_end(&mut buf)?;
        hasher.update(&buf);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn state() -> &'static Mutex<HashMap<PathBuf, Seen>> {
    static STATE: OnceLock<Mutex<HashMap<PathBuf, Seen>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The most recent refusal, for a caller that only learns "no wrapper".
fn last_refusal_slot() -> &'static Mutex<Option<String>> {
    static SLOT: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Why the last [`verify`] refused, if it did and nothing has passed since.
pub fn last_refusal() -> Option<String> {
    last_refusal_slot().lock().ok().and_then(|s| s.clone())
}

fn hex_digest(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// A 64-hex-digit token at the start of `text` (the `sha256sum` file shape).
fn parse_digest(text: &str) -> Option<String> {
    let token = text.split_whitespace().next()?.to_ascii_lowercase();
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())).then_some(token)
}

fn sidecar(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".sha256");
    PathBuf::from(name)
}

/// The digest shipped or pinned for `path`, and where it came from.
fn pinned(path: &Path) -> Result<Option<(String, String)>, String> {
    if let Ok(raw) = crate::compat_env::var(PINNED_ENV) {
        return match parse_digest(&raw) {
            Some(d) => Ok(Some((d, format!("the {PINNED_ENV} setting")))),
            None => Err(format!(
                "the {PINNED_ENV} setting is not a SHA-256 digest (64 hex digits), so the sandbox helper cannot be checked"
            )),
        };
    }
    let side = sidecar(path);
    match std::fs::read_to_string(&side) {
        Ok(text) => match parse_digest(&text) {
            Some(d) => Ok(Some((d, side.display().to_string()))),
            None => Err(format!(
                "{} does not hold a SHA-256 digest, so the sandbox helper cannot be checked",
                side.display()
            )),
        },
        Err(_) => Ok(None),
    }
}

fn check(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| {
        format!(
            "the sandbox helper {} is missing or unreadable ({e})",
            path.display()
        )
    })?;
    if !meta.is_file() {
        return Err(format!("the sandbox helper {} is not a file", path.display()));
    }
    let stamp = (meta.len(), meta.modified().ok());
    let probe = probe_digest(path, stamp.0).map_err(|e| {
        format!("the sandbox helper {} could not be read to be checked ({e})", path.display())
    })?;
    let key = path.to_path_buf();
    let known = state().lock().ok().and_then(|s| s.get(&key).cloned());
    let pin = pinned(path)?;
    // Unchanged on disk since the last pass (length, mtime and the content
    // probe): the earlier verdict stands.
    if let Some(seen) = &known {
        if (seen.len, seen.modified) == stamp && seen.probe == probe {
            return match &pin {
                Some((want, src)) if *want != seen.digest => Err(mismatch(path, want, &seen.digest, src)),
                _ => Ok(()),
            };
        }
    }
    let digest = hex_digest(path).map_err(|e| {
        format!("the sandbox helper {} could not be read to be checked ({e})", path.display())
    })?;
    if let Some((want, src)) = &pin {
        if *want != digest {
            return Err(mismatch(path, want, &digest, src));
        }
    }
    // The first-seen baseline holds whatever else is pinned: a helper swapped
    // together with a matching `.sha256` is still not the one seen at start.
    if let Some(first) = &known {
        if first.digest != digest {
            return Err(mismatch(path, &first.digest, &digest, "the copy Flint saw when it started"));
        }
    }
    if let Ok(mut s) = state().lock() {
        // The first sighting is the baseline; later stat changes with the same
        // content refresh the stamp but never the digest.
        let baseline = known.map(|k| k.digest).unwrap_or_else(|| digest.clone());
        s.insert(key, Seen { len: stamp.0, modified: stamp.1, probe, digest: baseline });
    }
    Ok(())
}

fn mismatch(path: &Path, want: &str, got: &str, src: &str) -> String {
    format!(
        "the sandbox helper {} does not match what Flint expects (expected sha256 {}, found {}; expected value from {src})",
        path.display(),
        &want[..want.len().min(16)],
        &got[..got.len().min(16)],
    )
}

/// `Ok` when `helper` is the file the app expects. On `Err` the message says
/// what failed and that the command was not run; it is also kept for
/// [`last_refusal`]. Callers must treat `Err` as "do not run the command".
pub fn verify(helper: &Path) -> Result<(), String> {
    // Tests share the refusal slot below; serialize every verify call so one
    // test's verdict cannot land in another's `last_refusal()` read.
    #[cfg(test)]
    let _serial = test_lock().lock().unwrap_or_else(|p| p.into_inner());
    verify_unserialized(helper)
}

#[cfg(test)]
fn test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn verify_unserialized(helper: &Path) -> Result<(), String> {
    let result = check(helper).map_err(|why| {
        format!("{why}. The command was not run: Flint will not run it outside the sandbox. Reinstall Flint to restore the helper.")
    });
    if let Ok(mut slot) = last_refusal_slot().lock() {
        *slot = result.as_ref().err().cloned();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flint_sbx_integrity_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    #[test]
    fn a_missing_helper_is_refused_and_says_not_run() {
        let _serial = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("missing");
        let err = verify_unserialized(&dir.join("helper.exe")).unwrap_err();
        assert!(err.contains("missing or unreadable"), "{err}");
        assert!(err.contains("not run") && err.contains("outside the sandbox"), "{err}");
        assert_eq!(last_refusal().as_deref(), Some(err.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_helper_that_differs_from_the_shipped_digest_is_refused() {
        let _serial = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("sidecar");
        let exe = dir.join("helper.exe");
        std::fs::write(&exe, b"genuine").unwrap();
        std::fs::write(sidecar(&exe), format!("{}  helper.exe\n", sha(b"genuine"))).unwrap();
        assert!(verify_unserialized(&exe).is_ok());
        std::fs::write(&exe, b"tampered!").unwrap();
        let err = verify_unserialized(&exe).unwrap_err();
        assert!(err.contains("does not match") && err.contains(".sha256"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_helper_replaced_after_first_use_is_refused_without_a_shipped_digest() {
        let _serial = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("baseline");
        let exe = dir.join("helper.exe");
        std::fs::write(&exe, b"first").unwrap();
        assert!(verify_unserialized(&exe).is_ok());
        assert!(verify_unserialized(&exe).is_ok(), "cached pass");
        std::fs::write(&exe, b"swapped-in").unwrap();
        let err = verify_unserialized(&exe).unwrap_err();
        assert!(err.contains("when it started"), "{err}");
        // Restoring the original content passes again.
        std::fs::write(&exe, b"first").unwrap();
        assert!(verify_unserialized(&exe).is_ok());
        assert_eq!(last_refusal(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_helper_swapped_together_with_its_sidecar_is_refused() {
        let _serial = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("sidecar_swap");
        let exe = dir.join("helper.exe");
        std::fs::write(&exe, b"genuine").unwrap();
        std::fs::write(sidecar(&exe), sha(b"genuine")).unwrap();
        assert!(verify_unserialized(&exe).is_ok());
        std::fs::write(&exe, b"evil-helper").unwrap();
        std::fs::write(sidecar(&exe), sha(b"evil-helper")).unwrap();
        let err = verify_unserialized(&exe).unwrap_err();
        assert!(err.contains("when it started"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_same_length_swap_with_its_mtime_reset_is_refused() {
        let _serial = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("mtime_reset");
        let exe = dir.join("helper.exe");
        for (tag, len) in [("small", 100usize), ("large", 300 * 1024)] {
            let genuine = vec![b'g'; len];
            std::fs::write(&exe, &genuine).unwrap();
            let when = std::fs::metadata(&exe).unwrap().modified().unwrap();
            assert!(verify_unserialized(&exe).is_ok(), "{tag}");
            let mut evil = genuine.clone();
            // A change at the start and at the end, same length.
            evil[0] = b'E';
            *evil.last_mut().unwrap() = b'E';
            std::fs::write(&exe, &evil).unwrap();
            std::fs::OpenOptions::new().write(true).open(&exe).unwrap().set_modified(when).unwrap();
            assert_eq!(std::fs::metadata(&exe).unwrap().modified().unwrap(), when);
            assert!(verify_unserialized(&exe).is_err(), "{tag}: the cache let a same-stamp swap through");
            // Fresh state for the next size.
            state().lock().unwrap().remove(&exe);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_shipped_digest_refuses_rather_than_skips_the_check() {
        let _serial = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("badside");
        let exe = dir.join("helper.exe");
        std::fs::write(&exe, b"x").unwrap();
        std::fs::write(sidecar(&exe), "not a digest").unwrap();
        let err = verify_unserialized(&exe).unwrap_err();
        assert!(err.contains("does not hold a SHA-256 digest"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn digest_parsing_accepts_sha256sum_lines_only() {
        let _serial = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let d = sha(b"a");
        assert_eq!(parse_digest(&format!("{} *file", d.to_uppercase())), Some(d.clone()));
        assert_eq!(parse_digest(&d[..63]), None);
        assert_eq!(parse_digest(""), None);
    }
}
