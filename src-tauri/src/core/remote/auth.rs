//! Device tokens, the paired-device store, one-time pairing, and per-IP rate
//! limits. Tauri-free, so every rule here is unit-tested without an app.
//!
//! A device token is shown to the phone exactly once. Only its SHA-256 is kept
//! on disk: a copy of `devices.json` (a backup, a synced data folder) must not
//! be enough to drive the desktop. SHA-256 rather than a slow KDF because the
//! token is 256 random bits, not a password -- there is nothing to brute-force.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How long a pairing code shown on the desktop stays usable.
pub const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
/// How long a claimed code waits for the user to click Confirm, and then for
/// the phone to collect its token.
pub const CONFIRM_TTL: Duration = Duration::from_secs(2 * 60);
/// How long an approved pairing can be polled again after the token was
/// handed out, so a lost response can be retried.
pub const APPROVED_POLL_GRACE: Duration = Duration::from_secs(30);
/// Longest device name kept; anything longer is cut, not rejected.
pub const MAX_DEVICE_NAME_CHARS: usize = 64;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `n` random bytes from the OS-seeded CSPRNG, base64url without padding.
pub fn random_b64(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// A fresh device token: 32 random bytes, base64url.
pub fn generate_token() -> String {
    random_b64(32)
}

/// Hex SHA-256 of a token, the only form of it that is stored.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Compares every byte whatever the first difference is, so response time
/// says nothing about how much of a guess was right.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The 6-digit number both screens show so the user can see that the phone
/// asking is the one holding their code. Derived, not random: the phone
/// computes the same number from the code it scanned.
pub fn confirmation_number(code: &str) -> String {
    let digest = Sha256::digest(format!("flint-remote-confirm:{code}").as_bytes());
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{n:06}")
}

/// Trims, drops control characters and caps the length. An empty result gets
/// a neutral name rather than an error: the user sees and confirms it anyway.
pub fn clean_device_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DEVICE_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        "Phone".to_string()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// Paired devices
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// Hex SHA-256 of the device token. Never sent to the frontend.
    pub token_hash: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
    /// Web Push subscription and switches; dropped with the device.
    #[serde(default)]
    pub push: super::push::DevicePush,
}

/// What the desktop UI is shown about a device: no hash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
    pub connected: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DeviceFile {
    devices: Vec<Device>,
}

/// `last_seen` is written back at most this often, so a busy phone does not
/// rewrite the file on every request.
const LAST_SEEN_PERSIST_EVERY_MS: u64 = 60_000;

#[derive(Debug)]
pub struct DeviceStore {
    path: Option<PathBuf>,
    devices: Vec<Device>,
}

impl DeviceStore {
    /// An in-memory store, for tests.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            devices: Vec::new(),
        }
    }

    /// Loads `path`. A missing or unreadable file is an empty store: the
    /// worst outcome is re-pairing, never a phone that stays trusted by
    /// accident.
    pub fn load(path: PathBuf) -> Self {
        let devices = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<DeviceFile>(&raw).ok())
            .map(|f| f.devices)
            .unwrap_or_default();
        Self {
            path: Some(path),
            devices,
        }
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let file = DeviceFile {
            devices: self.devices.clone(),
        };
        if let Err(e) = write_private_json(path, &file) {
            log::warn!("remote: could not save paired devices: {e}");
        }
    }

    pub fn list(&self) -> &[Device] {
        &self.devices
    }

    /// Adds a device and returns the token to hand to the phone once.
    pub fn add(&mut self, name: &str) -> (Device, String) {
        let token = generate_token();
        let device = Device {
            id: uuid::Uuid::new_v4().to_string(),
            name: clean_device_name(name),
            token_hash: hash_token(&token),
            paired_at: now_ms(),
            last_seen: None,
            push: Default::default(),
        };
        self.devices.push(device.clone());
        self.save();
        (device, token)
    }

    /// The device a presented token belongs to. Every stored hash is compared,
    /// match or not, so the time taken does not depend on where it matched.
    pub fn verify(&self, token: &str) -> Option<Device> {
        let presented = hash_token(token);
        let mut found = None;
        for d in &self.devices {
            if constant_time_eq(presented.as_bytes(), d.token_hash.as_bytes()) {
                found = Some(d.clone());
            }
        }
        found
    }

    pub fn touch(&mut self, id: &str, at: u64) {
        let mut dirty = false;
        if let Some(d) = self.devices.iter_mut().find(|d| d.id == id) {
            if d.last_seen.map_or(true, |prev| {
                at.saturating_sub(prev) >= LAST_SEEN_PERSIST_EVERY_MS
            }) {
                dirty = true;
            }
            d.last_seen = Some(at);
        }
        if dirty {
            self.save();
        }
    }

    pub fn get(&self, id: &str) -> Option<&Device> {
        self.devices.iter().find(|d| d.id == id)
    }

    /// Changes a device's push setup and saves. False when it is gone.
    pub fn update_push(&mut self, id: &str, f: impl FnOnce(&mut super::push::DevicePush)) -> bool {
        let Some(d) = self.devices.iter_mut().find(|d| d.id == id) else {
            return false;
        };
        f(&mut d.push);
        self.save();
        true
    }

    /// Deletes the device. Returns it so the caller can close its sockets.
    pub fn revoke(&mut self, id: &str) -> Option<Device> {
        let pos = self.devices.iter().position(|d| d.id == id)?;
        let removed = self.devices.remove(pos);
        self.save();
        Some(removed)
    }
}

/// Writes JSON through a temp file and a rename, readable by the owner only
/// on Unix: the file holds token hashes and, for TLS, private keys live beside
/// it.
pub fn write_private_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_private(path, &json)
}

pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/// The one pairing in progress. Starting another replaces it, so at most one
/// code is ever valid.
#[derive(Debug)]
struct Pairing {
    code: String,
    confirm: String,
    expires_at: Instant,
    stage: Stage,
}

#[derive(Debug)]
enum Stage {
    /// Shown on the desktop, not yet used.
    Waiting,
    /// A phone used the code; the desktop user has not answered.
    Claimed {
        request_id: String,
        poll_id: String,
        device_name: String,
    },
    /// Confirmed: the token waits for the phone's next poll, once.
    Approved {
        poll_id: String,
        device_id: String,
        token: String,
    },
    Rejected {
        poll_id: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingStart {
    pub code: String,
    pub confirm_number: String,
    pub expires_in_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingClaim {
    pub request_id: String,
    pub poll_id: String,
    pub device_name: String,
    pub confirm_number: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PollResult {
    Pending,
    #[serde(rename_all = "camelCase")]
    Approved {
        token: String,
        device_id: String,
    },
    Rejected,
    /// Unknown poll id, expired, or already collected -- deliberately one
    /// answer, so a poll id cannot be probed.
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairError {
    /// Wrong, expired or already-used code: one answer for all three.
    InvalidCode,
    NoSuchRequest,
}

#[derive(Debug, Default)]
pub struct PairingBook {
    current: Option<Pairing>,
}

impl PairingBook {
    pub fn start(&mut self, now: Instant) -> PairingStart {
        // 16 bytes: unguessable within five minutes at any rate the limiter
        // lets through, and short enough for a QR code a phone reads easily.
        let code = random_b64(16);
        let confirm = confirmation_number(&code);
        self.current = Some(Pairing {
            code: code.clone(),
            confirm: confirm.clone(),
            expires_at: now + PAIRING_TTL,
            stage: Stage::Waiting,
        });
        PairingStart {
            code,
            confirm_number: confirm,
            expires_in_ms: PAIRING_TTL.as_millis() as u64,
        }
    }

    pub fn cancel(&mut self) {
        self.current = None;
    }

    fn live(&mut self, now: Instant) -> Option<&mut Pairing> {
        if self.current.as_ref().is_some_and(|p| now >= p.expires_at) {
            self.current = None;
        }
        self.current.as_mut()
    }

    /// A phone presents the code. Single use: the first valid claim moves the
    /// pairing on, and any later claim with the same code fails.
    pub fn claim(
        &mut self,
        code: &str,
        device_name: &str,
        now: Instant,
    ) -> Result<PairingClaim, PairError> {
        let Some(p) = self.live(now) else {
            return Err(PairError::InvalidCode);
        };
        if !matches!(p.stage, Stage::Waiting)
            || !constant_time_eq(code.as_bytes(), p.code.as_bytes())
        {
            return Err(PairError::InvalidCode);
        }
        let claim = PairingClaim {
            request_id: uuid::Uuid::new_v4().to_string(),
            poll_id: random_b64(24),
            device_name: clean_device_name(device_name),
            confirm_number: p.confirm.clone(),
        };
        p.stage = Stage::Claimed {
            request_id: claim.request_id.clone(),
            poll_id: claim.poll_id.clone(),
            device_name: claim.device_name.clone(),
        };
        p.expires_at = now + CONFIRM_TTL;
        Ok(claim)
    }

    /// The desktop user's answer. On approval the device is created by
    /// `add_device` and its token parked for the phone's next poll.
    pub fn confirm(
        &mut self,
        request_id: &str,
        approve: bool,
        now: Instant,
        add_device: impl FnOnce(&str) -> (Device, String),
    ) -> Result<Option<Device>, PairError> {
        let Some(p) = self.live(now) else {
            return Err(PairError::NoSuchRequest);
        };
        let Stage::Claimed {
            request_id: rid,
            poll_id,
            device_name,
        } = &p.stage
        else {
            return Err(PairError::NoSuchRequest);
        };
        if rid != request_id {
            return Err(PairError::NoSuchRequest);
        }
        let poll_id = poll_id.clone();
        p.expires_at = now + CONFIRM_TTL;
        if approve {
            let (device, token) = add_device(device_name);
            p.stage = Stage::Approved {
                poll_id,
                device_id: device.id.clone(),
                token,
            };
            Ok(Some(device))
        } else {
            p.stage = Stage::Rejected { poll_id };
            Ok(None)
        }
    }

    /// The phone asks how its request stands. An approved token can be asked
    /// for again for a short while ([`APPROVED_POLL_GRACE`]): the device is
    /// already stored when the phone first asks, and a response lost on a flaky
    /// link must not leave a paired device whose token nobody holds. After the
    /// grace the pairing is gone.
    pub fn poll(&mut self, poll_id: &str, now: Instant) -> PollResult {
        let Some(p) = self.live(now) else {
            return PollResult::Expired;
        };
        let matches = |id: &str| constant_time_eq(id.as_bytes(), poll_id.as_bytes());
        let result = match &p.stage {
            Stage::Claimed { poll_id: id, .. } if matches(id) => return PollResult::Pending,
            Stage::Approved {
                poll_id: id,
                device_id,
                token,
            } if matches(id) => {
                let result = PollResult::Approved {
                    token: token.clone(),
                    device_id: device_id.clone(),
                };
                p.expires_at = now + APPROVED_POLL_GRACE;
                return result;
            }
            Stage::Rejected { poll_id: id } if matches(id) => PollResult::Rejected,
            _ => return PollResult::Expired,
        };
        self.current = None;
        result
    }

    /// Whether a code is currently shown and unused, for the status view.
    pub fn is_waiting(&mut self, now: Instant) -> bool {
        self.live(now)
            .is_some_and(|p| matches!(p.stage, Stage::Waiting))
    }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/// A sliding-window counter per client IP.
#[derive(Debug)]
pub struct RateLimiter {
    limit: usize,
    window: Duration,
    hits: HashMap<IpAddr, VecDeque<Instant>>,
}

impl RateLimiter {
    pub fn new(limit: usize, window: Duration) -> Self {
        Self {
            limit,
            window,
            hits: HashMap::new(),
        }
    }

    fn prune(&mut self, ip: IpAddr, now: Instant) -> usize {
        let window = self.window;
        let q = self.hits.entry(ip).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) >= window) {
            q.pop_front();
        }
        q.len()
    }

    /// Whether `ip` is over its limit, without counting this call.
    pub fn is_blocked(&mut self, ip: IpAddr, now: Instant) -> bool {
        let n = self.prune(ip, now);
        if n == 0 {
            self.hits.remove(&ip);
        }
        n >= self.limit
    }

    /// Counts one event and says whether it was still within the limit.
    pub fn hit(&mut self, ip: IpAddr, now: Instant) -> bool {
        let n = self.prune(ip, now);
        if n >= self.limit {
            return false;
        }
        self.hits.entry(ip).or_default().push_back(now);
        // An address that is never seen again is never pruned by its own
        // calls, so a spread of sources would grow the table without end.
        if self.hits.len() > MAX_TRACKED_IPS {
            let window = self.window;
            self.hits
                .retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < window));
        }
        true
    }
}

/// Addresses a limiter tracks before it sweeps out the idle ones.
const MAX_TRACKED_IPS: usize = 4096;
