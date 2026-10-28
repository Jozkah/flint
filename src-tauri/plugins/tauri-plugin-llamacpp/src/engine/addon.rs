//! Engine add-ons: GPU backend modules that are not in the installer.
//!
//! The installers carry the Vulkan engine only, which keeps them small. An
//! NVIDIA machine runs noticeably faster on ggml's CUDA backend, so the CUDA
//! module and the runtime it links against (cudart, cuBLAS, cuBLASLt) are
//! published next to each release as a *pack* the app downloads when the user
//! asks for it:
//!
//! ```text
//! flint-engine-cuda13-<tag>-win-x64.zip        the pack
//! flint-engine-cuda13-<tag>-win-x64.json       its manifest (sizes, SHA-256)
//! flint-engine-cuda13-<tag>-win-x64.json.sig   Ed25519 signature of the manifest
//! ```
//!
//! # Security model
//!
//! A pack is native code the engine worker loads, so it is only installed when
//! all of these hold:
//!
//! * The manifest's Ed25519 signature verifies against the public key compiled
//!   into this build ([`PUBKEY_B64`]). The private key lives only in the release
//!   workflow's secrets. A build without a key (a local build, a fork) offers
//!   no add-on at all: there is no "unsigned but trusted" path.
//! * The manifest names this build's exact llama.cpp commit (the ABI the
//!   module was compiled against), the platform, and the release tag the app
//!   was built for. A pack from another release is refused.
//! * The archive matches the manifest's size and SHA-256, and every file in it
//!   matches its own size and SHA-256. The zip carries the signed manifest too,
//!   so "Install from file" (offline machines) runs the same checks.
//! * Archive entries are plain file names listed in the manifest. Directories,
//!   paths, symlinks and anything unlisted are refused, so nothing is written
//!   outside the staging directory, and no entry is read past its signed size.
//! * Downloads go over HTTPS to this repository's own release on github.com,
//!   following redirects only to GitHub's download hosts. The URL is built
//!   from constants and the app's own tag; nothing user-supplied reaches it.
//!   `FLINT_ADDON_BASE_URL` / `FLINT_ADDON_PUBKEY` overrides exist for testing
//!   and are compiled out of release builds.
//!
//! Installation extracts into a staging directory and renames it into place,
//! so a crash leaves either the old add-on or the new one, never half of one.
//! At engine start only the signature and file sizes are rechecked (hashing
//! ~700 MB on every start would cost seconds); "Check again" rehashes. Someone
//! who can write to the user's data folder can already replace anything the
//! app runs, so a local attacker is out of scope.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Where releases are published. Packs are only ever fetched from here.
pub const REPO_OWNER: &str = "Jozkah";
pub const REPO_NAME: &str = "flint";

/// The CUDA pack. Its name carries the CUDA major so a later `cuda14` or a
/// `hip6` pack can sit beside it with the same manifest format.
pub const CUDA_KIND: &str = "cuda13";

/// CUDA 13 runs on R580 and newer (engine/driver.rs). The manifest can raise it.
pub const CUDA13_MIN_DRIVER: u32 = 580;

/// CUDA 13 dropped Maxwell, Pascal and Volta; the pack is built for sm_75+.
pub const CUDA13_MIN_COMPUTE: u32 = 75;

/// The manifest format this build reads.
pub const MANIFEST_SCHEMA: u32 = 1;

/// Hosts a release download may be served from. github.com answers the
/// release URL with a redirect to one of the others.
pub const ALLOWED_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// Ceilings that turn a malicious manifest into a refusal rather than a full disk.
const MAX_FILES: usize = 64;
const MAX_TOTAL_BYTES: u64 = 4 << 30;

/// The Ed25519 public key release packs are signed with, base64 of the 32 raw
/// bytes, from `addon-signing.pub` or `FLINT_ADDON_PUBKEY` at build time.
pub const PUBKEY_B64: &str = env!("FLINT_ADDON_PUBKEY_BUILD");

/// The release tag this build was made for (`v0.9.0`, `nightly-20261017-12`),
/// set by the release workflow. Local builds fall back to `v<app version>`.
pub const BUILD_RELEASE_TAG: Option<&str> = option_env!("FLINT_RELEASE_TAG");

/// Name of the signed manifest inside an installed add-on and inside the zip.
pub const MANIFEST_FILE: &str = "manifest.json";
pub const SIGNATURE_FILE: &str = "manifest.json.sig";

/// Environment variable the app sets for the worker: the add-on directory to
/// load backend modules from before the bundled ones.
pub const WORKER_ADDON_ENV: &str = "FLINT_ENGINE_ADDON_DIR";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AddonError {
    #[error("engine add-ons are not available on this platform")]
    UnsupportedPlatform,
    #[error("this build has no add-on signing key, so add-ons are disabled")]
    NoSigningKey,
    #[error("the add-on signature does not verify")]
    BadSignature,
    #[error("the add-on manifest is unreadable: {0}")]
    BadManifest(String),
    #[error("the add-on does not match this app: {0}")]
    Mismatch(String),
    #[error("the add-on archive is unsafe: {0}")]
    UnsafeArchive(String),
    #[error("the add-on is corrupt: {0}")]
    Corrupt(String),
    #[error("not enough free disk space: {need_mb} MB needed, {free_mb} MB free")]
    DiskSpace { need_mb: u64, free_mb: u64 },
    #[error("no add-on is published for this release yet")]
    NotPublished,
    #[error("could not reach GitHub: {0}")]
    Offline(String),
    #[error("download refused: {0}")]
    BadUrl(String),
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Io(String),
}

impl AddonError {
    /// A stable code for the frontend, which words the error itself.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::NoSigningKey => "no_signing_key",
            Self::BadSignature => "bad_signature",
            Self::BadManifest(_) => "bad_manifest",
            Self::Mismatch(_) => "mismatch",
            Self::UnsafeArchive(_) => "unsafe_archive",
            Self::Corrupt(_) => "corrupt",
            Self::DiskSpace { .. } => "disk_space",
            Self::NotPublished => "not_published",
            Self::Offline(_) => "offline",
            Self::BadUrl(_) => "bad_url",
            Self::Cancelled => "cancelled",
            Self::Io(_) => "io",
        }
    }
}

impl From<std::io::Error> for AddonError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Platform, tag and URL

/// The pack platform for this build, or None where no pack is published.
pub fn platform() -> Option<&'static str> {
    platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn platform_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("win-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        _ => None,
    }
}

/// Release tags as the release workflow accepts them.
pub fn is_valid_tag(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The tag this app's own release was published under.
pub fn release_tag(app_version: &str) -> String {
    match BUILD_RELEASE_TAG {
        Some(tag) if is_valid_tag(tag) => tag.to_string(),
        _ => format!("v{app_version}"),
    }
}

/// `flint-engine-cuda13-v0.9.0-win-x64`, the stem every asset of a pack shares.
pub fn asset_stem(kind: &str, tag: &str, platform: &str) -> String {
    format!("flint-engine-{kind}-{tag}-{platform}")
}

/// The base URL packs are fetched from. Debug builds honour
/// `FLINT_ADDON_BASE_URL` so a pack can be served from a local test server.
pub fn base_url(tag: &str) -> Result<String, AddonError> {
    if !is_valid_tag(tag) {
        return Err(AddonError::BadUrl(format!("not a release tag: {tag}")));
    }
    if cfg!(debug_assertions) {
        if let Ok(over) = std::env::var("FLINT_ADDON_BASE_URL") {
            let over = over.trim().trim_end_matches('/');
            if !over.is_empty() {
                return Ok(format!("{over}/"));
            }
        }
    }
    Ok(format!(
        "https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/download/{tag}/"
    ))
}

/// Whether a download (or a redirect) may go to `url`. Release builds accept
/// only HTTPS on [`ALLOWED_HOSTS`]; a debug override also accepts its own host.
pub fn url_allowed(url: &str, override_base: Option<&str>) -> bool {
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    let host = authority
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map_or(authority, |(h, _)| h)
        .to_ascii_lowercase();
    if scheme.eq_ignore_ascii_case("https") && ALLOWED_HOSTS.contains(&host.as_str()) {
        return true;
    }
    if let Some(base) = override_base {
        if let Some((bs, brest)) = base.split_once("://") {
            let bauth = brest.split('/').next().unwrap_or("");
            return bs.eq_ignore_ascii_case(scheme) && bauth.eq_ignore_ascii_case(authority);
        }
    }
    false
}

/// The debug override in effect, if any (always None in a release build).
pub fn override_base() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("FLINT_ADDON_BASE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// The public key in effect: the compiled one, or in a debug build
/// `FLINT_ADDON_PUBKEY`.
pub fn pubkey() -> Option<String> {
    if cfg!(debug_assertions) {
        if let Ok(k) = std::env::var("FLINT_ADDON_PUBKEY") {
            if !k.trim().is_empty() {
                return Some(k.trim().to_string());
            }
        }
    }
    let k = PUBKEY_B64.trim();
    (!k.is_empty()).then(|| k.to_string())
}

// ---------------------------------------------------------------------------
// Manifest and signature

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackManifest {
    pub schema: u32,
    /// `cuda13`; names the pack and its install directory.
    pub kind: String,
    /// The ggml backend it adds (`cuda`, later `hip`).
    pub backend: String,
    pub release_tag: String,
    pub platform: String,
    /// The llama.cpp build the module was compiled against: the ABI pin.
    pub engine_tag: String,
    pub engine_commit: String,
    #[serde(default)]
    pub cuda_toolkit: Option<String>,
    /// Oldest NVIDIA driver branch (580 = R580).
    pub min_driver: u32,
    /// Oldest compute capability, as major*10+minor (75 = Turing).
    pub min_compute: u32,
    pub files: Vec<PackFile>,
    /// The zip itself: present in the published manifest, absent from the copy
    /// inside the zip (which cannot name its own hash).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<PackFile>,
}

impl PackManifest {
    pub fn installed_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// What a pack has to match to be loaded by this build.
#[derive(Debug, Clone)]
pub struct Expect<'a> {
    pub kind: &'a str,
    pub platform: &'a str,
    pub engine_commit: &'a str,
    /// Required for downloads (the pack of *this* release). A file the user
    /// picked only has to match the engine ABI.
    pub release_tag: Option<&'a str>,
}

pub fn decode_b64(text: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .ok()
}

/// Verifies `sig_b64` (64 raw bytes, base64) over `bytes` with `pubkey_b64`.
pub fn verify_signature(bytes: &[u8], sig_b64: &str, pubkey_b64: &str) -> Result<(), AddonError> {
    use ed25519_dalek::{Signature, VerifyingKey};
    let key: [u8; 32] = decode_b64(pubkey_b64)
        .and_then(|k| k.try_into().ok())
        .ok_or(AddonError::NoSigningKey)?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| AddonError::NoSigningKey)?;
    let sig: [u8; 64] = decode_b64(sig_b64)
        .and_then(|s| s.try_into().ok())
        .ok_or(AddonError::BadSignature)?;
    key.verify_strict(bytes, &Signature::from_bytes(&sig))
        .map_err(|_| AddonError::BadSignature)
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// A file name a pack may contain: a bare name, no path, nothing hidden.
pub fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && name != MANIFEST_FILE
        && name != SIGNATURE_FILE
}

/// Parses a manifest whose signature has already been checked, and refuses one
/// that does not fit this build.
pub fn parse_manifest(bytes: &[u8], expect: &Expect) -> Result<PackManifest, AddonError> {
    let m: PackManifest =
        serde_json::from_slice(bytes).map_err(|e| AddonError::BadManifest(e.to_string()))?;
    if m.schema != MANIFEST_SCHEMA {
        return Err(AddonError::BadManifest(format!("schema {}", m.schema)));
    }
    if m.kind != expect.kind {
        return Err(AddonError::Mismatch(format!("pack is {}, not {}", m.kind, expect.kind)));
    }
    if m.platform != expect.platform {
        return Err(AddonError::Mismatch(format!(
            "pack is for {}, this is {}",
            m.platform, expect.platform
        )));
    }
    if m.engine_commit != expect.engine_commit {
        return Err(AddonError::Mismatch(format!(
            "pack was built for engine {} ({}), this app runs {}",
            m.engine_tag,
            short(&m.engine_commit),
            short(expect.engine_commit)
        )));
    }
    if let Some(tag) = expect.release_tag {
        if m.release_tag != tag {
            return Err(AddonError::Mismatch(format!(
                "pack belongs to release {}, this app is {tag}",
                m.release_tag
            )));
        }
    }
    if !is_valid_tag(&m.release_tag) {
        return Err(AddonError::BadManifest("release tag".into()));
    }
    if m.files.is_empty() || m.files.len() > MAX_FILES {
        return Err(AddonError::BadManifest(format!("{} files", m.files.len())));
    }
    let mut seen = std::collections::HashSet::new();
    let mut total: u64 = 0;
    for f in m.files.iter().chain(m.archive.iter()) {
        if !is_safe_file_name(&f.name) || !is_hex64(&f.sha256) {
            return Err(AddonError::BadManifest(format!("entry {:?}", f.name)));
        }
        total = total.saturating_add(f.size);
    }
    for f in &m.files {
        if !seen.insert(f.name.to_ascii_lowercase()) {
            return Err(AddonError::BadManifest(format!("duplicate {}", f.name)));
        }
    }
    if total > MAX_TOTAL_BYTES {
        return Err(AddonError::BadManifest("too large".into()));
    }
    Ok(m)
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

/// Signature check plus [`parse_manifest`].
pub fn verify_manifest(
    bytes: &[u8],
    sig_b64: &str,
    pubkey_b64: Option<&str>,
    expect: &Expect,
) -> Result<PackManifest, AddonError> {
    let key = pubkey_b64.ok_or(AddonError::NoSigningKey)?;
    verify_signature(bytes, sig_b64, key)?;
    parse_manifest(bytes, expect)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

// ---------------------------------------------------------------------------
// Eligibility

/// What the hardware plugin reported, reduced to what the offer needs.
#[derive(Debug, Clone, Default)]
pub struct HostFacts {
    pub platform: Option<&'static str>,
    /// Compute capability (major*10+minor) of each NVIDIA GPU.
    pub nvidia_compute: Vec<u32>,
    /// The driver release branch (617 for 617.12), when NVML answered.
    pub driver_branch: Option<u32>,
    /// The installed engine already carries a CUDA module (CUDA installer, dev).
    pub bundled_cuda: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Eligibility {
    /// macOS, ARM, ...: no CUDA pack exists. Never mentioned in the UI.
    UnsupportedPlatform,
    /// No NVIDIA GPU (AMD, Intel, none). Never mentioned in the UI.
    NoNvidia,
    /// Only GPUs older than the pack's oldest architecture: stay on Vulkan.
    GpuTooOld,
    /// NVML did not report a driver: no offer, nothing claimed.
    DriverUnknown,
    /// The driver is older than CUDA 13 needs: suggest updating it.
    DriverTooOld,
    /// The engine already has CUDA built in.
    AlreadyBundled,
    Eligible,
}

pub fn parse_driver_branch(version: &str) -> Option<u32> {
    version.trim().split('.').next()?.parse().ok()
}

/// "8.9" -> 89.
pub fn parse_compute(cc: &str) -> Option<u32> {
    let (major, minor) = cc.trim().split_once('.')?;
    Some(major.parse::<u32>().ok()? * 10 + minor.parse::<u32>().ok()?.min(9))
}

pub fn eligibility(host: &HostFacts, min_driver: u32, min_compute: u32) -> Eligibility {
    if host.platform.is_none() {
        return Eligibility::UnsupportedPlatform;
    }
    if host.nvidia_compute.is_empty() {
        return Eligibility::NoNvidia;
    }
    if host.bundled_cuda {
        return Eligibility::AlreadyBundled;
    }
    if !host.nvidia_compute.iter().any(|&cc| cc >= min_compute) {
        return Eligibility::GpuTooOld;
    }
    match host.driver_branch {
        None => Eligibility::DriverUnknown,
        Some(branch) if branch < min_driver => Eligibility::DriverTooOld,
        Some(_) => Eligibility::Eligible,
    }
}

// ---------------------------------------------------------------------------
// Installed add-ons

#[derive(Debug, Clone, Serialize)]
pub struct InstalledAddon {
    pub kind: String,
    pub dir: PathBuf,
    pub release_tag: String,
    pub engine_tag: String,
    pub size: u64,
    /// Matches this build's engine; a mismatched one is never loaded.
    pub compatible: bool,
}

/// `<root>/<kind>-<tag>`.
pub fn install_dir(root: &Path, kind: &str, tag: &str) -> PathBuf {
    root.join(format!("{kind}-{tag}"))
}

/// Reads one installed add-on directory: signature, manifest and the presence
/// and size of each file. Hashes are not recomputed here (see [`rehash`]).
pub fn read_installed(
    dir: &Path,
    pubkey_b64: Option<&str>,
    expect: &Expect,
) -> Result<PackManifest, AddonError> {
    let bytes = fs::read(dir.join(MANIFEST_FILE))?;
    let sig = fs::read_to_string(dir.join(SIGNATURE_FILE))?;
    let m = verify_manifest(&bytes, &sig, pubkey_b64, expect)?;
    for f in &m.files {
        let meta = fs::metadata(dir.join(&f.name))
            .map_err(|_| AddonError::Corrupt(format!("{} is missing", f.name)))?;
        if meta.len() != f.size {
            return Err(AddonError::Corrupt(format!("{} has the wrong size", f.name)));
        }
    }
    Ok(m)
}

/// Rehashes every file of an installed add-on.
pub fn rehash(dir: &Path, m: &PackManifest) -> Result<(), AddonError> {
    for f in &m.files {
        let got = sha256_file(&dir.join(&f.name))
            .map_err(|_| AddonError::Corrupt(format!("{} is missing", f.name)))?;
        if got != f.sha256 {
            return Err(AddonError::Corrupt(format!("{} does not match its hash", f.name)));
        }
    }
    Ok(())
}

/// Every add-on directory of `kind` under `root`, valid or not.
pub fn list_dirs(root: &Path, kind: &str) -> Vec<PathBuf> {
    let prefix = format!("{kind}-");
    let Ok(rd) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

/// The add-on the worker should load: the first directory that verifies and
/// matches this build. A corrupt or mismatched one is skipped with one log
/// line, so the engine silently stays on Vulkan.
pub fn active_addon(root: &Path, pubkey_b64: Option<&str>, expect: &Expect) -> Option<PathBuf> {
    for dir in list_dirs(root, expect.kind) {
        match read_installed(&dir, pubkey_b64, expect) {
            Ok(_) => return Some(dir),
            Err(e) => warn_once(&dir, &e),
        }
    }
    None
}

/// One log line per add-on and reason for the life of the process: the check
/// runs on every engine start and status read.
fn warn_once(dir: &Path, e: &AddonError) {
    use std::sync::{Mutex, OnceLock};
    static SEEN: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let key = format!("{}|{e}", dir.display());
    let first = SEEN
        .get_or_init(Default::default)
        .lock()
        .map(|mut seen| seen.insert(key))
        .unwrap_or(true);
    if first {
        log::warn!(
            "engine add-on {} not used ({e}); staying on the bundled backends",
            dir.display()
        );
    }
}

pub fn dir_size(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Extraction and atomic install

/// Unix file type bits from a zip entry's external attributes.
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;

fn random_suffix() -> String {
    use rand::Rng;
    let n: u64 = rand::thread_rng().gen();
    format!("{n:016x}")
}

/// Extracts a pack into `staging` (which must not exist), checking every
/// entry against the signed manifest inside the zip. Returns that manifest.
pub fn extract_pack(
    zip_path: &Path,
    staging: &Path,
    pubkey_b64: Option<&str>,
    expect: &Expect,
) -> Result<PackManifest, AddonError> {
    let file = fs::File::open(zip_path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AddonError::UnsafeArchive(format!("not a zip: {e}")))?;

    let read_small = |zip: &mut zip::ZipArchive<fs::File>, name: &str| -> Result<Vec<u8>, AddonError> {
        let entry = zip
            .by_name(name)
            .map_err(|_| AddonError::UnsafeArchive(format!("no {name}")))?;
        let mut buf = Vec::new();
        entry.take(1 << 20).read_to_end(&mut buf)?;
        Ok(buf)
    };
    let manifest_bytes = read_small(&mut zip, MANIFEST_FILE)?;
    let sig = String::from_utf8(read_small(&mut zip, SIGNATURE_FILE)?)
        .map_err(|_| AddonError::BadSignature)?;
    let manifest = verify_manifest(&manifest_bytes, &sig, pubkey_b64, expect)?;
    let wanted: BTreeMap<&str, &PackFile> =
        manifest.files.iter().map(|f| (f.name.as_str(), f)).collect();

    fs::create_dir_all(staging.parent().unwrap_or(staging))?;
    fs::create_dir(staging)?;
    let mut written = std::collections::HashSet::new();
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| AddonError::UnsafeArchive(e.to_string()))?;
        let name = entry.name().to_string();
        if name == MANIFEST_FILE || name == SIGNATURE_FILE {
            continue;
        }
        if entry.is_dir() {
            return Err(AddonError::UnsafeArchive(format!("directory entry {name}")));
        }
        if let Some(mode) = entry.unix_mode() {
            if mode & S_IFMT != 0 && mode & S_IFMT != S_IFREG {
                return Err(AddonError::UnsafeArchive(format!("{name} is not a regular file")));
            }
        }
        let Some(expected) = wanted.get(name.as_str()) else {
            return Err(AddonError::UnsafeArchive(format!("unlisted entry {name:?}")));
        };
        if entry.size() != expected.size || !written.insert(name.clone()) {
            return Err(AddonError::UnsafeArchive(format!("{name} does not match the manifest")));
        }
        let out_path = staging.join(&expected.name);
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&out_path)?;
        let mut hasher = Sha256::new();
        let mut limited = (&mut entry).take(expected.size + 1);
        let mut buf = vec![0u8; 1 << 20];
        let mut total: u64 = 0;
        loop {
            // A read error here is the zip's own CRC or a truncated stream.
            let n = limited
                .read(&mut buf)
                .map_err(|e| AddonError::Corrupt(format!("{name}: {e}")))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > expected.size {
                return Err(AddonError::UnsafeArchive(format!("{name} is larger than declared")));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        out.sync_all()?;
        if total != expected.size || hex(&hasher.finalize()) != expected.sha256 {
            return Err(AddonError::Corrupt(format!("{name} does not match its hash")));
        }
    }
    if written.len() != wanted.len() {
        let missing: Vec<_> = wanted.keys().filter(|k| !written.contains(**k)).collect();
        return Err(AddonError::Corrupt(format!("missing {missing:?}")));
    }
    fs::write(staging.join(MANIFEST_FILE), &manifest_bytes)?;
    fs::write(staging.join(SIGNATURE_FILE), sig.trim())?;
    Ok(manifest)
}

/// Extracts and swaps a pack into place under `root`. On any failure the
/// staging directory is removed and the previous add-on is left as it was.
/// Other versions of the same kind are removed once the new one is in place.
pub fn install_pack(
    root: &Path,
    zip_path: &Path,
    pubkey_b64: Option<&str>,
    expect: &Expect,
) -> Result<(PathBuf, PackManifest), AddonError> {
    fs::create_dir_all(root)?;
    let staging = root.join(format!(".staging-{}", random_suffix()));
    let manifest = match extract_pack(zip_path, &staging, pubkey_b64, expect) {
        Ok(m) => m,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    let target = install_dir(root, &manifest.kind, &manifest.release_tag);
    let backup = root.join(format!(".old-{}", random_suffix()));
    let had_old = target.exists();
    if had_old {
        if let Err(e) = fs::rename(&target, &backup) {
            let _ = fs::remove_dir_all(&staging);
            return Err(e.into());
        }
    }
    if let Err(e) = fs::rename(&staging, &target) {
        // Roll back: the old add-on goes back where it was.
        if had_old {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(e.into());
    }
    if had_old {
        let _ = fs::remove_dir_all(&backup);
    }
    for other in list_dirs(root, &manifest.kind) {
        if other != target {
            if let Err(e) = fs::remove_dir_all(&other) {
                // A DLL the running worker holds cannot be deleted on Windows;
                // the next start sweeps it.
                log::info!("old engine add-on {} left for later: {e}", other.display());
            }
        }
    }
    Ok((target, manifest))
}

/// Removes every add-on of `kind`, plus leftovers of interrupted installs.
pub fn remove_all(root: &Path, kind: &str) -> Result<(), AddonError> {
    let mut first_err = None;
    for dir in list_dirs(root, kind) {
        if let Err(e) = fs::remove_dir_all(&dir) {
            first_err.get_or_insert(e);
        }
    }
    sweep_leftovers(root);
    match first_err {
        Some(e) => Err(e.into()),
        None => Ok(()),
    }
}

/// Deletes `.staging-*` / `.old-*` directories a crash left behind.
pub fn sweep_leftovers(root: &Path) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for e in rd.filter_map(Result::ok) {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(".staging-") || name.starts_with(".old-") {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

// ---------------------------------------------------------------------------
// Download

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    /// `download`, `verify`, `install`.
    pub phase: &'static str,
    pub received: u64,
    pub total: u64,
}

/// Free bytes on the volume holding `path`.
pub fn free_space(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let path_s = path.to_string_lossy().to_ascii_lowercase();
    let path_s = path_s.trim_start_matches(r"\\?\");
    disks
        .list()
        .iter()
        .filter(|d| {
            path_s.starts_with(&d.mount_point().to_string_lossy().to_ascii_lowercase().to_string())
        })
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

/// Space a download still needs: what is left to fetch, the extracted files,
/// and room for the old add-on until the swap.
pub fn space_needed(archive: u64, already: u64, installed: u64) -> u64 {
    archive.saturating_sub(already) + installed + (64 << 20)
}

pub fn http_client() -> Result<reqwest::Client, AddonError> {
    let over = override_base();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 8 {
            attempt.error("too many redirects")
        } else if url_allowed(attempt.url().as_str(), over.as_deref()) {
            attempt.follow()
        } else {
            let msg = format!("redirect to {} refused", attempt.url());
            attempt.error(msg)
        }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .user_agent(concat!("Flint engine add-on/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AddonError::Offline(e.to_string()))
}

fn net_err(e: reqwest::Error) -> AddonError {
    if e.is_redirect() {
        AddonError::BadUrl(e.to_string())
    } else {
        AddonError::Offline(e.to_string())
    }
}

/// Fetches a small asset (manifest, signature), refusing anything off the list.
pub async fn fetch_small(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, AddonError> {
    if !url_allowed(url, override_base().as_deref()) {
        return Err(AddonError::BadUrl(url.to_string()));
    }
    let res = client.get(url).send().await.map_err(net_err)?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AddonError::NotPublished);
    }
    if !res.status().is_success() {
        return Err(AddonError::Offline(format!("HTTP {}", res.status())));
    }
    let bytes = res.bytes().await.map_err(net_err)?;
    if bytes.len() > 1 << 20 {
        return Err(AddonError::BadManifest("too large".into()));
    }
    Ok(bytes.to_vec())
}

/// Downloads `url` to `part`, resuming from what is already there. The caller
/// checks size and hash afterwards. `expected` bounds what is accepted.
pub async fn download_resumable(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    expected: u64,
    cancel: &std::sync::atomic::AtomicBool,
    on_progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(), AddonError> {
    let over = override_base();
    download_resumable_to(client, url, over.as_deref(), part, expected, cancel, on_progress).await
}

#[allow(clippy::too_many_arguments)]
async fn download_resumable_to(
    client: &reqwest::Client,
    url: &str,
    override_base: Option<&str>,
    part: &Path,
    expected: u64,
    cancel: &std::sync::atomic::AtomicBool,
    on_progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(), AddonError> {
    use futures_util::StreamExt;
    use std::sync::atomic::Ordering;
    if !url_allowed(url, override_base) {
        return Err(AddonError::BadUrl(url.to_string()));
    }
    let mut have = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    if have > expected {
        fs::remove_file(part)?;
        have = 0;
    }
    if have == expected {
        return Ok(());
    }
    let mut req = client.get(url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let res = req.send().await.map_err(net_err)?;
    let status = res.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(AddonError::NotPublished);
    }
    if !status.is_success() {
        return Err(AddonError::Offline(format!("HTTP {status}")));
    }
    // A server that ignores Range answers 200 with the whole file.
    let resume = have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resume {
        have = 0;
    }
    let mut out = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resume)
        .truncate(!resume)
        .open(part)?;
    let mut stream = res.bytes_stream();
    let mut last = std::time::Instant::now();
    on_progress(Progress { phase: "download", received: have, total: expected });
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            out.flush()?;
            return Err(AddonError::Cancelled);
        }
        let chunk = chunk.map_err(net_err)?;
        have += chunk.len() as u64;
        if have > expected {
            drop(out);
            let _ = fs::remove_file(part);
            return Err(AddonError::Corrupt("the download is larger than the manifest says".into()));
        }
        out.write_all(&chunk)?;
        if last.elapsed() >= std::time::Duration::from_millis(250) {
            last = std::time::Instant::now();
            on_progress(Progress { phase: "download", received: have, total: expected });
        }
    }
    out.sync_all()?;
    on_progress(Progress { phase: "download", received: have, total: expected });
    if have != expected {
        return Err(AddonError::Offline("the connection closed early; try again to resume".into()));
    }
    Ok(())
}

/// The published manifest of this release's pack, verified.
pub async fn fetch_manifest(
    client: &reqwest::Client,
    tag: &str,
    expect: &Expect<'_>,
) -> Result<PackManifest, AddonError> {
    let pubkey = pubkey();
    if pubkey.is_none() {
        return Err(AddonError::NoSigningKey);
    }
    let base = base_url(tag)?;
    let stem = asset_stem(expect.kind, tag, expect.platform);
    let bytes = fetch_small(client, &format!("{base}{stem}.json")).await?;
    let sig = fetch_small(client, &format!("{base}{stem}.json.sig")).await?;
    let sig = String::from_utf8(sig).map_err(|_| AddonError::BadSignature)?;
    let m = verify_manifest(&bytes, &sig, pubkey.as_deref(), expect)?;
    if m.archive.is_none() {
        return Err(AddonError::BadManifest("no archive entry".into()));
    }
    Ok(m)
}

/// Download, verify and install this release's pack.
pub async fn download_and_install(
    root: &Path,
    tag: &str,
    expect: &Expect<'_>,
    cancel: &std::sync::atomic::AtomicBool,
    on_progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(PathBuf, PackManifest), AddonError> {
    let client = http_client()?;
    let manifest = fetch_manifest(&client, tag, expect).await?;
    let archive = manifest.archive.clone().expect("checked in fetch_manifest");
    let downloads = root.join(".download");
    fs::create_dir_all(&downloads)?;
    let part = downloads.join(format!("{}.part", archive.name));
    // A partial file of a different pack (other hash) is not resumed.
    let marker = downloads.join(format!("{}.sha256", archive.name));
    if fs::read_to_string(&marker).ok().as_deref() != Some(archive.sha256.as_str()) {
        let _ = fs::remove_file(&part);
        fs::write(&marker, &archive.sha256)?;
    }
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let need = space_needed(archive.size, have, manifest.installed_size());
    let probe_root = root.to_path_buf();
    let free = jan_utils::system::run_bounded(std::time::Duration::from_secs(3), move || {
        free_space(&probe_root)
    })
    .await
    .flatten();
    if let Some(free) = free {
        if free < need {
            return Err(AddonError::DiskSpace { need_mb: need >> 20, free_mb: free >> 20 });
        }
    }
    let url = format!("{}{}", base_url(tag)?, archive.name);
    download_resumable(&client, &url, &part, archive.size, cancel, on_progress).await?;

    on_progress(Progress { phase: "verify", received: 0, total: archive.size });
    let part2 = part.clone();
    let got = tokio::task::spawn_blocking(move || sha256_file(&part2))
        .await
        .map_err(|e| AddonError::Io(e.to_string()))??;
    if got != archive.sha256 {
        let _ = fs::remove_file(&part);
        let _ = fs::remove_file(&marker);
        return Err(AddonError::Corrupt("the download does not match the signed hash".into()));
    }

    on_progress(Progress { phase: "install", received: 0, total: manifest.installed_size() });
    let (root2, part2) = (root.to_path_buf(), part.clone());
    let key = pubkey();
    let exp = OwnedExpect::from(expect);
    let res = tokio::task::spawn_blocking(move || {
        install_pack(&root2, &part2, key.as_deref(), &exp.as_expect())
    })
    .await
    .map_err(|e| AddonError::Io(e.to_string()))?;
    if res.is_ok() {
        let _ = fs::remove_file(&part);
        let _ = fs::remove_file(&marker);
    }
    res
}

/// [`Expect`] that can cross into a blocking task.
#[derive(Debug, Clone)]
pub struct OwnedExpect {
    pub kind: String,
    pub platform: String,
    pub engine_commit: String,
    pub release_tag: Option<String>,
}

impl OwnedExpect {
    pub fn as_expect(&self) -> Expect<'_> {
        Expect {
            kind: &self.kind,
            platform: &self.platform,
            engine_commit: &self.engine_commit,
            release_tag: self.release_tag.as_deref(),
        }
    }
}

impl From<&Expect<'_>> for OwnedExpect {
    fn from(e: &Expect<'_>) -> Self {
        Self {
            kind: e.kind.into(),
            platform: e.platform.into(),
            engine_commit: e.engine_commit.into(),
            release_tag: e.release_tag.map(Into::into),
        }
    }
}

/// The ggml CUDA module's file name on this platform.
pub fn cuda_module_name() -> &'static str {
    if cfg!(windows) {
        "ggml-cuda.dll"
    } else {
        "libggml-cuda.so"
    }
}

#[cfg(test)]
#[path = "addon_tests.rs"]
mod tests;
