//! The guest-share store: one JSON file in the data folder.
//!
//! A share lets the owner give one person a link to ONE thread. The link's
//! token is shown once (in the URL the owner copies); only its SHA-256 is kept,
//! so a copy of this file cannot be turned back into a working link. The first
//! browser to join a share is bound to it with a random cookie value (again
//! only a hash is kept), so a link that leaks after that is useless.
//!
//! Every read and write goes through one process-wide lock and an atomic file
//! replace. The desktop app and `flint serve` may both use the same file; each
//! call re-reads it, so one sees the other's change on its next call.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rand::distributions::Alphanumeric;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::core::atomic_io::write_atomic_durable;

pub const DEFAULT_TTL_HOURS: u64 = 24;
pub const MAX_TTL_HOURS: u64 = 7 * 24;
/// Guest messages one share may hold unanswered.
pub const MAX_PENDING: usize = 20;
/// Longest guest message, in characters.
pub const MAX_TEXT_CHARS: usize = 4000;
pub const MAX_ATTACHMENTS: usize = 2;
/// Longest attachment, in bytes.
pub const MAX_ATTACHMENT_BYTES: usize = 1024 * 1024;
/// Time between two messages from one guest.
const MESSAGE_COOLDOWN_MS: u64 = 2_000;
/// An ended share stays in the file this long, then is dropped.
const KEEP_ENDED_MS: u64 = 24 * 60 * 60 * 1000;
const TOKEN_LEN: usize = 32;
const HOUR_MS: u64 = 60 * 60 * 1000;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    /// Already cleaned (see `view::clean_guest_text`); wrapped again at Send.
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Share {
    id: String,
    thread_id: String,
    /// SHA-256 of the URL token, hex.
    token_hash: String,
    created_ms: u64,
    expires_ms: u64,
    #[serde(default)]
    revoked: bool,
    /// SHA-256 of the cookie value of the browser that joined, hex.
    #[serde(default)]
    bound_hash: Option<String>,
    #[serde(default)]
    include_reasoning: bool,
    #[serde(default)]
    last_message_ms: u64,
    #[serde(default)]
    pending: Vec<Pending>,
}

impl Share {
    fn active(&self, now: u64) -> bool {
        !self.revoked && now < self.expires_ms
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    /// The opt-in. Off by default: a share exposes a thread outside the machine.
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    shares: Vec<Share>,
}

/// What the owner sees of a share. Never the token or any hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    pub id: String,
    pub thread_id: String,
    pub created_ms: u64,
    pub expires_ms: u64,
    /// A browser has opened the link.
    pub joined: bool,
    pub include_reasoning: bool,
    pub pending: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub share_id: String,
    pub thread_id: String,
    pub id: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub created_ms: u64,
}

/// A guest request that is refused. One value for every reason (unknown,
/// expired, stopped, wrong browser, feature off, thread gone), so an answer
/// never tells a prober which one it was.
#[derive(Debug, PartialEq, Eq)]
pub struct Denied;

#[derive(Debug, PartialEq, Eq)]
pub enum QueueError {
    /// The share ended while the message was on its way.
    Gone,
    TooMany,
    TooFast,
    Io(String),
}

/// How much a request must prove.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The page itself: a live token. No cookie is needed: a link opened from
    /// another app is a cross-site navigation, which `SameSite=Strict` strips
    /// the cookie from, and the page holds nothing private.
    Page,
    /// First open from a browser that runs the page: binds it when unbound.
    Join,
    /// Everything that reads or writes the thread: token and cookie.
    Live,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    pub share_id: String,
    pub thread_id: String,
    pub include_reasoning: bool,
    pub expires_ms: u64,
    /// The cookie name for this token.
    pub cookie_name: String,
    /// Set only by the call that bound the browser; the cookie value to send.
    pub new_binder: Option<String>,
}

pub fn hash_text(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub fn token_shape(token: &str) -> bool {
    token.len() == TOKEN_LEN && token.bytes().all(|c| c.is_ascii_alphanumeric())
}

fn binder_shape(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

/// The cookie that carries the browser binding for `token`'s share.
pub fn cookie_name_for(token_hash: &str) -> String {
    format!("flint_guest_{}", &token_hash[..8.min(token_hash.len())])
}

/// Constant-time equality of two strings.
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn new_token() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(TOKEN_LEN).map(char::from).collect()
}

fn new_hex(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut raw);
    hex::encode(raw)
}

/// Remove an attachment's stored copy. The id is checked first: it names a
/// folder under the uploads root and must not be able to point elsewhere.
fn remove_attachment(data_folder: &Path, attachment: &Attachment) {
    let id = &attachment.id;
    if id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit()) {
        let _ = std::fs::remove_dir_all(data_folder.join("web-server").join("uploads").join(id));
    }
}

pub struct Store {
    root: PathBuf,
    file: PathBuf,
}

impl Store {
    pub fn new(data_folder: &Path) -> Self {
        Self {
            root: data_folder.to_path_buf(),
            file: data_folder.join("web-server").join("guest-shares.json"),
        }
    }

    fn load(&self) -> Result<File, String> {
        match std::fs::read(&self.file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                // Kept aside, never read as empty and overwritten.
                let bad = self.file.with_extension("json.bad");
                let _ = std::fs::rename(&self.file, &bad);
                format!("the guest share file could not be read ({e}); it was kept as {}", bad.display())
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(File::default()),
            Err(e) => Err(format!("the guest share file could not be read: {e}")),
        }
    }

    fn save(&self, file: &File) -> Result<(), String> {
        let parent = self.file.parent().ok_or("no parent folder")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
        write_atomic_durable(&self.file, &bytes)
    }

    /// Load, change, drop long-ended shares, save. Nothing is written when
    /// `change` fails.
    fn update<T>(&self, now: u64, change: impl FnOnce(&mut File) -> Result<T, String>) -> Result<T, String> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.load()?;
        let out = change(&mut file)?;
        let (keep, gone): (Vec<Share>, Vec<Share>) = std::mem::take(&mut file.shares)
            .into_iter()
            .partition(|s| s.expires_ms.saturating_add(KEEP_ENDED_MS) > now);
        file.shares = keep;
        for share in &gone {
            self.discard_pending(share);
        }
        self.save(&file)?;
        Ok(out)
    }

    fn discard_pending(&self, share: &Share) {
        for pending in &share.pending {
            for attachment in &pending.attachments {
                remove_attachment(&self.root, attachment);
            }
        }
    }

    /// End a share: it stops answering and what it still holds is dropped.
    fn end(&self, share: &mut Share) {
        share.revoked = true;
        self.discard_pending(share);
        share.pending.clear();
    }

    pub fn enabled(&self) -> bool {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.load().map(|f| f.enabled).unwrap_or(false)
    }

    /// Turning it off ends every share, so turning it on again never revives a
    /// link from before.
    pub fn set_enabled(&self, on: bool, now: u64) -> Result<(), String> {
        self.update(now, |file| {
            file.enabled = on;
            if !on {
                for share in &mut file.shares {
                    self.end(share);
                }
            }
            Ok(())
        })
    }

    fn view(share: &Share) -> ShareView {
        ShareView {
            id: share.id.clone(),
            thread_id: share.thread_id.clone(),
            created_ms: share.created_ms,
            expires_ms: share.expires_ms,
            joined: share.bound_hash.is_some(),
            include_reasoning: share.include_reasoning,
            pending: share.pending.len(),
        }
    }

    /// A new share for `thread_id`; any share it already had ends first.
    /// Returns the view and the token, which is not kept anywhere.
    pub fn create(
        &self,
        thread_id: &str,
        ttl_hours: Option<u64>,
        include_reasoning: bool,
        now: u64,
    ) -> Result<(ShareView, String), String> {
        crate::core::threads::utils::validate_thread_id(thread_id)?;
        if !crate::core::threads::utils::get_thread_metadata_path(&self.root, thread_id).is_file() {
            return Err("that conversation does not exist".into());
        }
        let hours = ttl_hours.unwrap_or(DEFAULT_TTL_HOURS).clamp(1, MAX_TTL_HOURS);
        let token = new_token();
        self.update(now, |file| {
            if !file.enabled {
                return Err("guest links are turned off".into());
            }
            for share in file.shares.iter_mut().filter(|s| s.thread_id == thread_id && !s.revoked) {
                self.end(share);
            }
            let share = Share {
                id: new_hex(6),
                thread_id: thread_id.to_owned(),
                token_hash: hash_text(&token),
                created_ms: now,
                expires_ms: now + hours * HOUR_MS,
                revoked: false,
                bound_hash: None,
                include_reasoning,
                last_message_ms: 0,
                pending: Vec::new(),
            };
            let view = Self::view(&share);
            file.shares.push(share);
            Ok(view)
        })
        .map(|view| (view, token))
    }

    /// Shares that still answer, for one thread or all.
    pub fn list(&self, thread_id: Option<&str>, now: u64) -> Result<Vec<ShareView>, String> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self
            .load()?
            .shares
            .iter()
            .filter(|s| s.active(now) && thread_id.is_none_or(|t| s.thread_id == t))
            .map(Self::view)
            .collect())
    }

    pub fn stop(&self, share_id: &str, now: u64) -> Result<bool, String> {
        self.update(now, |file| {
            let mut found = false;
            for share in file.shares.iter_mut().filter(|s| s.id == share_id && !s.revoked) {
                self.end(share);
                found = true;
            }
            Ok(found)
        })
    }

    /// Ends every share of a thread: it was deleted or archived.
    pub fn end_thread(&self, thread_id: &str, now: u64) -> Result<usize, String> {
        self.update(now, |file| {
            let mut count = 0;
            for share in file.shares.iter_mut().filter(|s| s.thread_id == thread_id && !s.revoked) {
                self.end(share);
                count += 1;
            }
            Ok(count)
        })
    }

    /// New expiry `ttl_hours` from now, within the 7-day ceiling.
    pub fn set_expiry(&self, share_id: &str, ttl_hours: u64, now: u64) -> Result<ShareView, String> {
        let hours = ttl_hours.clamp(1, MAX_TTL_HOURS);
        self.update(now, |file| {
            let share = file
                .shares
                .iter_mut()
                .find(|s| s.id == share_id && s.active(now))
                .ok_or("that link is not active")?;
            share.expires_ms = now + hours * HOUR_MS;
            Ok(Self::view(share))
        })
    }

    pub fn pending(&self, thread_id: &str, now: u64) -> Result<Vec<PendingView>, String> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<PendingView> = self
            .load()?
            .shares
            .iter()
            .filter(|s| s.active(now) && s.thread_id == thread_id)
            .flat_map(|s| {
                s.pending.iter().map(|p| PendingView {
                    share_id: s.id.clone(),
                    thread_id: s.thread_id.clone(),
                    id: p.id.clone(),
                    text: p.text.clone(),
                    attachments: p.attachments.clone(),
                    created_ms: p.created_ms,
                })
            })
            .collect();
        out.sort_by_key(|p| p.created_ms);
        Ok(out)
    }

    /// Takes one pending message out of its share and returns it. The caller
    /// decides what to do with it: send (wrap and queue) or dismiss. A
    /// dismissed message's files are removed here.
    pub fn take_pending(
        &self,
        share_id: &str,
        pending_id: &str,
        keep_files: bool,
        now: u64,
    ) -> Result<Pending, String> {
        self.update(now, |file| {
            let share = file
                .shares
                .iter_mut()
                .find(|s| s.id == share_id && s.active(now))
                .ok_or("that link is not active")?;
            let at = share
                .pending
                .iter()
                .position(|p| p.id == pending_id)
                .ok_or("that guest message is gone")?;
            let taken = share.pending.remove(at);
            if !keep_files {
                for attachment in &taken.attachments {
                    remove_attachment(&self.root, attachment);
                }
            }
            Ok(taken)
        })
    }

    /// A guest's message, held until the owner answers it.
    pub fn queue_message(
        &self,
        share_id: &str,
        text: String,
        attachments: Vec<Attachment>,
        now: u64,
    ) -> Result<String, QueueError> {
        let id = new_hex(8);
        let result = self.update(now, |file| {
            let Some(share) = file.shares.iter_mut().find(|s| s.id == share_id && s.active(now)) else {
                return Ok(Err(QueueError::Gone));
            };
            if share.pending.len() >= MAX_PENDING {
                return Ok(Err(QueueError::TooMany));
            }
            if now.saturating_sub(share.last_message_ms) < MESSAGE_COOLDOWN_MS {
                return Ok(Err(QueueError::TooFast));
            }
            share.last_message_ms = now;
            share.pending.push(Pending { id: id.clone(), text, attachments, created_ms: now });
            Ok(Ok(()))
        });
        match result {
            Ok(Ok(())) => Ok(id),
            Ok(Err(e)) => Err(e),
            Err(e) => Err(QueueError::Io(e)),
        }
    }

    /// Whether a request may use a share, and as which browser.
    pub fn authorize(&self, token: &str, cookie: Option<&str>, mode: Mode, now: u64) -> Result<Access, Denied> {
        if !token_shape(token) {
            return Err(Denied);
        }
        let hash = hash_text(token);
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.load().map_err(|_| Denied)?;
        if !file.enabled {
            return Err(Denied);
        }
        // Every share is compared, so the time taken does not say whether or
        // where the token matched.
        let mut found = None;
        for (i, share) in file.shares.iter().enumerate() {
            if ct_eq(&share.token_hash, &hash) {
                found = Some(i);
            }
        }
        let share = &mut file.shares[found.ok_or(Denied)?];
        if !share.active(now) {
            return Err(Denied);
        }
        if !crate::core::threads::utils::get_thread_metadata_path(&self.root, &share.thread_id).is_file() {
            return Err(Denied);
        }
        let cookie_ok = match (&share.bound_hash, cookie) {
            (Some(bound), Some(value)) if binder_shape(value) => ct_eq(bound, &hash_text(value)),
            _ => false,
        };
        let mut access = Access {
            share_id: share.id.clone(),
            thread_id: share.thread_id.clone(),
            include_reasoning: share.include_reasoning,
            expires_ms: share.expires_ms,
            cookie_name: cookie_name_for(&hash),
            new_binder: None,
        };
        match mode {
            Mode::Page => Ok(access),
            Mode::Live if cookie_ok => Ok(access),
            Mode::Join if cookie_ok => Ok(access),
            Mode::Join if share.bound_hash.is_none() => {
                let binder = new_hex(16);
                share.bound_hash = Some(hash_text(&binder));
                self.save(&file).map_err(|_| Denied)?;
                access.new_binder = Some(binder);
                Ok(access)
            }
            _ => Err(Denied),
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_000_000_000;

    fn data() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let thread = dir.path().join("threads").join("t1");
        std::fs::create_dir_all(&thread).unwrap();
        std::fs::write(thread.join("thread.json"), r#"{"id":"t1","title":"Hello"}"#).unwrap();
        dir
    }

    fn on(dir: &tempfile::TempDir) -> Store {
        let store = Store::new(dir.path());
        store.set_enabled(true, T0).unwrap();
        store
    }

    #[test]
    fn off_by_default_and_create_refuses() {
        let dir = data();
        let store = Store::new(dir.path());
        assert!(!store.enabled());
        assert!(store.create("t1", None, false, T0).is_err());
        store.set_enabled(true, T0).unwrap();
        assert!(store.enabled());
        assert!(store.create("t1", None, false, T0).is_ok());
    }

    #[test]
    fn only_the_hash_is_stored_and_the_token_is_never_listed() {
        let dir = data();
        let store = on(&dir);
        let (view, token) = store.create("t1", None, false, T0).unwrap();
        assert!(token_shape(&token));
        let raw = std::fs::read_to_string(dir.path().join("web-server").join("guest-shares.json")).unwrap();
        assert!(!raw.contains(&token), "the token must not be on disk");
        assert!(raw.contains(&hash_text(&token)));
        let listed = serde_json::to_string(&store.list(None, T0).unwrap()).unwrap();
        assert!(!listed.contains(&token) && !listed.contains(&hash_text(&token)));
        assert_eq!(view.pending, 0);
    }

    #[test]
    fn expiry_defaults_to_a_day_and_is_capped_at_a_week() {
        let dir = data();
        let store = on(&dir);
        let (a, _) = store.create("t1", None, false, T0).unwrap();
        assert_eq!(a.expires_ms, T0 + 24 * HOUR_MS);
        let (b, _) = store.create("t1", Some(10_000), false, T0).unwrap();
        assert_eq!(b.expires_ms, T0 + 168 * HOUR_MS);
        let c = store.set_expiry(&b.id, 0, T0).unwrap();
        assert_eq!(c.expires_ms, T0 + HOUR_MS);
        let d = store.set_expiry(&b.id, 48, T0).unwrap();
        assert_eq!(d.expires_ms, T0 + 48 * HOUR_MS);
    }

    #[test]
    fn a_new_link_ends_the_old_one_at_once() {
        let dir = data();
        let store = on(&dir);
        let (_, old) = store.create("t1", None, false, T0).unwrap();
        assert!(store.authorize(&old, None, Mode::Page, T0).is_ok());
        let (_, new) = store.create("t1", None, false, T0).unwrap();
        assert_eq!(store.authorize(&old, None, Mode::Page, T0), Err(Denied));
        assert!(store.authorize(&new, None, Mode::Page, T0).is_ok());
        assert_eq!(store.list(Some("t1"), T0).unwrap().len(), 1);
    }

    #[test]
    fn unknown_expired_stopped_and_off_all_look_the_same() {
        let dir = data();
        let store = on(&dir);
        let (view, token) = store.create("t1", Some(1), false, T0).unwrap();
        assert_eq!(store.authorize("short", None, Mode::Page, T0), Err(Denied));
        assert_eq!(store.authorize(&"a".repeat(32), None, Mode::Page, T0), Err(Denied));
        assert!(store.authorize(&token, None, Mode::Page, T0 + HOUR_MS - 1).is_ok());
        assert_eq!(store.authorize(&token, None, Mode::Page, T0 + HOUR_MS), Err(Denied));
        assert!(store.stop(&view.id, T0).unwrap());
        assert_eq!(store.authorize(&token, None, Mode::Page, T0), Err(Denied));
        let (_, token2) = store.create("t1", None, false, T0).unwrap();
        store.set_enabled(false, T0).unwrap();
        assert_eq!(store.authorize(&token2, None, Mode::Page, T0), Err(Denied));
        // Turning it back on does not revive the link.
        store.set_enabled(true, T0).unwrap();
        assert_eq!(store.authorize(&token2, None, Mode::Page, T0), Err(Denied));
    }

    #[test]
    fn a_deleted_thread_ends_the_link() {
        let dir = data();
        let store = on(&dir);
        let (_, token) = store.create("t1", None, false, T0).unwrap();
        std::fs::remove_file(dir.path().join("threads").join("t1").join("thread.json")).unwrap();
        assert_eq!(store.authorize(&token, None, Mode::Page, T0), Err(Denied));
    }

    #[test]
    fn end_thread_ends_every_share_of_it() {
        let dir = data();
        let store = on(&dir);
        let (_, token) = store.create("t1", None, false, T0).unwrap();
        assert_eq!(store.end_thread("t1", T0).unwrap(), 1);
        assert_eq!(store.authorize(&token, None, Mode::Page, T0), Err(Denied));
        assert!(store.list(None, T0).unwrap().is_empty());
    }

    #[test]
    fn the_first_browser_binds_and_others_are_refused() {
        let dir = data();
        let store = on(&dir);
        let (_, token) = store.create("t1", None, false, T0).unwrap();
        // Not joined yet: nothing can read the thread.
        assert_eq!(store.authorize(&token, None, Mode::Live, T0), Err(Denied));
        let joined = store.authorize(&token, None, Mode::Join, T0).unwrap();
        let binder = joined.new_binder.clone().expect("the first open sets the cookie");
        assert!(binder_shape(&binder));
        assert_eq!(joined.cookie_name, cookie_name_for(&hash_text(&token)));
        let raw = std::fs::read_to_string(dir.path().join("web-server").join("guest-shares.json")).unwrap();
        assert!(!raw.contains(&binder), "the cookie value must not be on disk");
        // The same browser keeps working, and joining again sets nothing new.
        assert!(store.authorize(&token, Some(&binder), Mode::Live, T0).is_ok());
        assert_eq!(store.authorize(&token, Some(&binder), Mode::Join, T0).unwrap().new_binder, None);
        // Another browser: no cookie, or a made-up one.
        assert_eq!(store.authorize(&token, None, Mode::Live, T0), Err(Denied));
        assert_eq!(store.authorize(&token, None, Mode::Join, T0), Err(Denied));
        let other = "0".repeat(32);
        assert_eq!(store.authorize(&token, Some(&other), Mode::Live, T0), Err(Denied));
        assert_eq!(store.authorize(&token, Some("junk"), Mode::Live, T0), Err(Denied));
        // The page itself needs only the token (see `Mode::Page`).
        assert!(store.authorize(&token, None, Mode::Page, T0).is_ok());
        // A cookie from another share's token does not carry over.
        let (_, token_b) = {
            std::fs::create_dir_all(dir.path().join("threads").join("t2")).unwrap();
            std::fs::write(dir.path().join("threads").join("t2").join("thread.json"), r#"{"id":"t2"}"#).unwrap();
            store.create("t2", None, false, T0).unwrap()
        };
        let b = store.authorize(&token_b, None, Mode::Join, T0).unwrap();
        assert_eq!(store.authorize(&token, b.new_binder.as_deref(), Mode::Live, T0), Err(Denied));
    }

    #[test]
    fn the_queue_holds_messages_with_limits() {
        let dir = data();
        let store = on(&dir);
        let (view, _) = store.create("t1", None, false, T0).unwrap();
        let first = store.queue_message(&view.id, "hi".into(), vec![], T0).unwrap();
        assert_eq!(store.queue_message(&view.id, "again".into(), vec![], T0 + 10), Err(QueueError::TooFast));
        let mut t = T0;
        for _ in 1..MAX_PENDING {
            t += MESSAGE_COOLDOWN_MS;
            store.queue_message(&view.id, "x".into(), vec![], t).unwrap();
        }
        t += MESSAGE_COOLDOWN_MS;
        assert_eq!(store.queue_message(&view.id, "x".into(), vec![], t), Err(QueueError::TooMany));
        assert_eq!(store.queue_message("nope", "x".into(), vec![], t), Err(QueueError::Gone));
        let pending = store.pending("t1", t).unwrap();
        assert_eq!(pending.len(), MAX_PENDING);
        assert_eq!(pending[0].id, first);
        assert_eq!(pending[0].text, "hi");
        // Taking one removes it.
        let taken = store.take_pending(&view.id, &first, true, t).unwrap();
        assert_eq!(taken.text, "hi");
        assert_eq!(store.pending("t1", t).unwrap().len(), MAX_PENDING - 1);
        assert!(store.take_pending(&view.id, &first, true, t).is_err());
    }

    #[test]
    fn stopping_discards_pending_messages_and_their_files() {
        let dir = data();
        let store = on(&dir);
        let (view, token) = store.create("t1", None, false, T0).unwrap();
        let id = "ab".repeat(16);
        let folder = dir.path().join("web-server").join("uploads").join(&id);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("a.txt"), "x").unwrap();
        let attachment = Attachment { id, name: "a.txt".into(), size: 1, path: folder.join("a.txt").to_string_lossy().into() };
        store.queue_message(&view.id, "see file".into(), vec![attachment], T0).unwrap();
        store.stop(&view.id, T0).unwrap();
        assert!(!folder.exists());
        assert!(store.pending("t1", T0).unwrap().is_empty());
        assert_eq!(store.authorize(&token, None, Mode::Page, T0), Err(Denied));
        // An id that is not an upload id never reaches the filesystem.
        let evil = Attachment { id: "../..".into(), name: "x".into(), size: 0, path: String::new() };
        remove_attachment(dir.path(), &evil);
        assert!(dir.path().join("threads").exists());
    }

    #[test]
    fn long_ended_shares_are_dropped_from_the_file() {
        let dir = data();
        let store = on(&dir);
        let (_, _) = store.create("t1", Some(1), false, T0).unwrap();
        store.set_enabled(true, T0 + HOUR_MS + KEEP_ENDED_MS + 1).unwrap();
        let raw = std::fs::read_to_string(dir.path().join("web-server").join("guest-shares.json")).unwrap();
        assert!(!raw.contains("tokenHash"));
    }

    #[test]
    fn a_bad_thread_id_is_refused() {
        let dir = data();
        let store = on(&dir);
        assert!(store.create("../x", None, false, T0).is_err());
        assert!(store.create("missing", None, false, T0).is_err());
    }
}
