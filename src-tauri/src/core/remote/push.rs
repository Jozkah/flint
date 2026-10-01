//! Web Push to paired phones: the standard protocol, sent straight from this
//! computer to the browser vendor's push service (FCM, Mozilla, Apple). No
//! Flint-hosted relay sits in between.
//!
//! - RFC 8292 (VAPID): this computer signs a short JWT with its own P-256 key
//!   (`<data>/remote/vapid.json`, owner-only), so the push service knows the
//!   sender is the one the phone subscribed with.
//! - RFC 8291 (`aes128gcm`): the payload is encrypted to the phone's
//!   subscription keys, so the push service only ever sees ciphertext.
//!
//! Crypto uses crates already linked: `ring` (ECDH P-256, ECDSA P-256),
//! `hkdf`/`sha2` and `aes-gcm`. A test checks the RFC 8291 test vector.
//!
//! Payloads stay minimal (title, short body, a deep-link path, a collapse
//! tag) and never carry secrets; "hide content" replaces title and body with
//! a generic line.

use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::auth::write_private_json;

/// Record size written in the header; one record always fits a payload.
const RECORD_SIZE: u32 = 4096;
/// Push services accept at least 4096 bytes of ciphertext.
pub const MAX_PAYLOAD: usize = 3000;
/// How long a JWT is valid (RFC 8292 allows up to 24 h).
const JWT_TTL_SECS: u64 = 12 * 3600;
/// VAPID `sub`: a contact for the push service. Apple requires a mailto: or
/// https: URL; the project page is a real one that names no user.
pub const VAPID_SUBJECT: &str = "https://github.com/Jozkah/flint";
/// Push services phones subscribe through. Anything else is refused, so a
/// paired phone cannot point this computer at an arbitrary URL.
const PUSH_HOST_SUFFIXES: &[&str] = &[
    ".googleapis.com",
    ".push.services.mozilla.com",
    ".push.apple.com",
    ".notify.windows.com",
];

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .map_err(|_| "bad base64url".to_string())
}

// ---------------------------------------------------------------------------
// VAPID
// ---------------------------------------------------------------------------

pub struct VapidKey {
    pkcs8: Vec<u8>,
    pair: EcdsaKeyPair,
}

#[derive(Serialize, Deserialize)]
struct VapidFile {
    pkcs8: String,
}

impl VapidKey {
    pub fn generate() -> Result<Self, String> {
        let rng = SystemRandom::new();
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
            .map_err(|_| "could not generate the VAPID key".to_string())?;
        Self::from_pkcs8(doc.as_ref())
    }

    pub fn from_pkcs8(bytes: &[u8]) -> Result<Self, String> {
        let pair = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            bytes,
            &SystemRandom::new(),
        )
        .map_err(|_| "invalid VAPID key".to_string())?;
        Ok(Self {
            pkcs8: bytes.to_vec(),
            pair,
        })
    }

    /// Loads `path`, or makes a key and writes it there (owner-only).
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        if let Some(key) = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<VapidFile>(&raw).ok())
            .and_then(|f| unb64(&f.pkcs8).ok())
            .and_then(|b| Self::from_pkcs8(&b).ok())
        {
            return Ok(key);
        }
        let key = Self::generate()?;
        write_private_json(
            path,
            &VapidFile {
                pkcs8: b64(&key.pkcs8),
            },
        )
        .map_err(|e| format!("could not save the VAPID key: {e}"))?;
        Ok(key)
    }

    /// Uncompressed public point, base64url: the phone's `applicationServerKey`.
    pub fn public_key_b64(&self) -> String {
        b64(self.pair.public_key().as_ref())
    }

    /// RFC 8292 JWT (ES256) for `aud` (the push service's origin).
    pub fn jwt(&self, aud: &str, sub: &str, exp: u64) -> Result<String, String> {
        let header = b64(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = b64(json!({ "aud": aud, "exp": exp, "sub": sub }).to_string().as_bytes());
        let input = format!("{header}.{claims}");
        let sig = self
            .pair
            .sign(&SystemRandom::new(), input.as_bytes())
            .map_err(|_| "could not sign".to_string())?;
        Ok(format!("{input}.{}", b64(sig.as_ref())))
    }
}

// ---------------------------------------------------------------------------
// Subscriptions and preferences
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// A browser `PushSubscription` as `toJSON()` gives it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

/// Checks the endpoint is HTTPS on a known push service and the keys have
/// the right sizes.
pub fn validate_subscription(sub: &Subscription) -> Result<(), &'static str> {
    let url = url::Url::parse(&sub.endpoint).map_err(|_| "Invalid push endpoint")?;
    if url.scheme() != "https" || url.port().is_some_and(|p| p != 443) {
        return Err("Push endpoints must be HTTPS");
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if !PUSH_HOST_SUFFIXES
        .iter()
        .any(|s| host.ends_with(s) || host == s[1..])
    {
        return Err("Unknown push service");
    }
    let p = unb64(&sub.keys.p256dh).map_err(|_| "Invalid subscription key")?;
    let a = unb64(&sub.keys.auth).map_err(|_| "Invalid subscription key")?;
    if p.len() != 65 || p[0] != 4 || a.len() != 16 {
        return Err("Invalid subscription key");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Approval,
    RunFinished,
    RunFailed,
    Pr,
    RoomWaiting,
    Synthesis,
    ChatReply,
    Test,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietHours {
    pub enabled: bool,
    /// Minutes after the phone's local midnight.
    pub start: u16,
    pub end: u16,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self {
            enabled: false,
            start: 22 * 60,
            end: 7 * 60,
        }
    }
}

/// Per-device switches, as Settings > Notifications on the phone shows them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PushPrefs {
    pub approvals: bool,
    pub run_finished: bool,
    pub run_failed: bool,
    pub pr: bool,
    pub room_waiting: bool,
    pub synthesis: bool,
    pub chat_reply: bool,
    /// Send "Flint needs you" instead of the title and body.
    pub hide_content: bool,
    /// Approvals still come through during quiet hours.
    pub quiet_hours: QuietHours,
    /// The phone's offset from UTC, so quiet hours follow its clock.
    pub utc_offset_minutes: i32,
}

impl Default for PushPrefs {
    fn default() -> Self {
        Self {
            approvals: true,
            run_finished: true,
            run_failed: true,
            pr: true,
            room_waiting: true,
            synthesis: true,
            chat_reply: false,
            hide_content: false,
            quiet_hours: QuietHours::default(),
            utc_offset_minutes: 0,
        }
    }
}

/// What a device has set up for push, kept with its pairing record (so
/// unpairing removes it).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DevicePush {
    pub subscription: Option<Subscription>,
    pub prefs: PushPrefs,
}

/// A notification the desktop wants sent (`{type: "push.notify", ...}`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushNotice {
    pub category: Category,
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// A path in the phone app (`/m/#/...`), never an absolute URL.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub tag: String,
    /// Approvals: lets the notification offer Allow once / Deny.
    #[serde(default)]
    pub request_id: Option<String>,
}

fn in_quiet_hours(q: &QuietHours, minute: u16) -> bool {
    if !q.enabled || q.start == q.end {
        return false;
    }
    if q.start < q.end {
        minute >= q.start && minute < q.end
    } else {
        minute >= q.start || minute < q.end
    }
}

/// The phone's local minute of day at `now_ms` (UTC).
pub fn local_minute(now_ms: u64, offset_min: i32) -> u16 {
    let m = (now_ms / 60_000) as i64 + offset_min as i64;
    m.rem_euclid(1440) as u16
}

/// Whether `prefs` lets this category through at `now_ms`.
pub fn allowed(prefs: &PushPrefs, category: Category, now_ms: u64) -> bool {
    let on = match category {
        Category::Approval => prefs.approvals,
        Category::RunFinished => prefs.run_finished,
        Category::RunFailed => prefs.run_failed,
        Category::Pr => prefs.pr,
        Category::RoomWaiting => prefs.room_waiting,
        Category::Synthesis => prefs.synthesis,
        Category::ChatReply => prefs.chat_reply,
        Category::Test => true,
    };
    if !on {
        return false;
    }
    let quiet = in_quiet_hours(
        &prefs.quiet_hours,
        local_minute(now_ms, prefs.utc_offset_minutes),
    );
    !quiet || matches!(category, Category::Approval | Category::Test)
}

fn clip(s: &str, n: usize) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).collect();
    if s.chars().count() <= n {
        s
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    }
}

/// Only an in-app path: `/m/...`. Anything else becomes the app's root.
fn safe_url(url: &str) -> String {
    if url.starts_with("/m/") && !url.contains("//") && url.len() <= 300 {
        url.to_string()
    } else {
        "/m/".to_string()
    }
}

/// The JSON the service worker receives.
pub fn payload(n: &PushNotice, prefs: &PushPrefs) -> Value {
    let (title, body) = if prefs.hide_content {
        ("Flint needs you".to_string(), String::new())
    } else {
        (clip(&n.title, 80), clip(&n.body, 160))
    };
    let mut v = json!({
        "title": title,
        "body": body,
        "url": safe_url(&n.url),
        "tag": clip(&n.tag, 64),
        "category": n.category,
    });
    if let (Category::Approval, Some(r)) = (n.category, &n.request_id) {
        v["requestId"] = json!(clip(r, 128));
    }
    v
}

// ---------------------------------------------------------------------------
// RFC 8291
// ---------------------------------------------------------------------------

/// Encrypts with given key material (exposed for the RFC test vector).
pub fn encrypt_with(
    ecdh_secret: &[u8],
    as_public: &[u8],
    ua_public: &[u8],
    auth: &[u8],
    salt: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    if plaintext.len() + 17 > RECORD_SIZE as usize {
        return Err("payload too large".into());
    }
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), ecdh_secret)
        .expand(&key_info, &mut ikm)
        .map_err(|_| "hkdf")?;
    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| "hkdf")?;
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| "hkdf")?;
    let mut record = plaintext.to_vec();
    record.push(2); // last (only) record
    let ct = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| "aes")?
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| "aes")?;
    let mut out = Vec::with_capacity(21 + as_public.len() + ct.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(as_public.len() as u8);
    out.extend_from_slice(as_public);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Encrypts `plaintext` to `sub` with a fresh ephemeral key and salt.
pub fn encrypt(sub: &Subscription, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
    let rng = SystemRandom::new();
    let ua_public = unb64(&sub.keys.p256dh)?;
    let auth = unb64(&sub.keys.auth)?;
    let eph = EphemeralPrivateKey::generate(&ECDH_P256, &rng).map_err(|_| "ecdh")?;
    let as_public = eph.compute_public_key().map_err(|_| "ecdh")?.as_ref().to_vec();
    let mut salt = [0u8; 16];
    rng.fill(&mut salt).map_err(|_| "rng")?;
    let secret = agree_ephemeral(eph, &UnparsedPublicKey::new(&ECDH_P256, &ua_public), |s| {
        s.to_vec()
    })
    .map_err(|_| "Invalid subscription key".to_string())?;
    encrypt_with(&secret, &as_public, &ua_public, &auth, &salt, plaintext)
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct PushRequest {
    pub endpoint: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

/// `Topic` (collapse key): at most 32 base64url characters, so a hash of the tag.
fn topic_of(tag: &str) -> Option<String> {
    (!tag.is_empty()).then(|| b64(&Sha256::digest(tag.as_bytes())[..24]))
}

pub fn build_request(
    vapid: &VapidKey,
    sub: &Subscription,
    payload: &Value,
    category: Category,
    now_ms: u64,
) -> Result<PushRequest, String> {
    let bytes = payload.to_string().into_bytes();
    if bytes.len() > MAX_PAYLOAD {
        return Err("payload too large".into());
    }
    let body = encrypt(sub, &bytes)?;
    let url = url::Url::parse(&sub.endpoint).map_err(|_| "bad endpoint")?;
    let aud = url.origin().ascii_serialization();
    let jwt = vapid.jwt(&aud, VAPID_SUBJECT, now_ms / 1000 + JWT_TTL_SECS)?;
    let (ttl, urgency) = match category {
        Category::Approval => ("600", "high"),
        Category::Test => ("60", "high"),
        Category::RunFailed | Category::RoomWaiting => ("3600", "normal"),
        _ => ("3600", "low"),
    };
    let mut headers = vec![
        (
            "authorization",
            format!("vapid t={jwt}, k={}", vapid.public_key_b64()),
        ),
        ("content-encoding", "aes128gcm".to_string()),
        ("content-type", "application/octet-stream".to_string()),
        ("ttl", ttl.to_string()),
        ("urgency", urgency.to_string()),
    ];
    if let Some(t) = payload.get("tag").and_then(Value::as_str).and_then(topic_of) {
        headers.push(("topic", t));
    }
    Ok(PushRequest {
        endpoint: sub.endpoint.clone(),
        headers,
        body,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub enum SendOutcome {
    Delivered,
    /// 404/410: the subscription is gone and should be dropped.
    Gone,
    Failed(String),
}

pub fn outcome_of(status: u16) -> SendOutcome {
    match status {
        200..=299 => SendOutcome::Delivered,
        404 | 410 => SendOutcome::Gone,
        s => SendOutcome::Failed(format!("push service answered {s}")),
    }
}

pub async fn send(client: &reqwest::Client, req: PushRequest) -> SendOutcome {
    let mut b = client.post(&req.endpoint).body(req.body);
    for (k, v) in req.headers {
        b = b.header(k, v);
    }
    match b.timeout(std::time::Duration::from_secs(20)).send().await {
        Ok(r) => outcome_of(r.status().as_u16()),
        Err(e) => SendOutcome::Failed(e.to_string()),
    }
}
