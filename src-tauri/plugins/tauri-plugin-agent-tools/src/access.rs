//! Folders and files the user let an agent reach outside its workspace, by
//! answering a `request_access` prompt.
//!
//! The model names a path and says why. It never gets to decide what that path
//! means: [`prepare`] canonicalizes it (resolving `..`, symlinks and Windows
//! junctions, so the scope shown to the user is the scope enforced) and refuses
//! anything too broad or too sensitive to be granted by a one-line prompt -- a
//! drive root, the home directory or one of its parents, `.ssh`, a browser
//! profile, a credential store, Jan's own data folder, a device path, a UNC
//! share. Only a prepared request can become a grant, and [`grant`] prepares it
//! again rather than trusting a path handed back by the caller.
//!
//! A grant lives for the session it was issued to unless the user explicitly
//! chose to keep it. Session grants are held in this process only, with an
//! expiry, so a restart or the expiry ends them. Kept grants are written to the
//! data folder and apply to every session until revoked.
//!
//! Every grant is re-canonicalized each time it is enforced ([`active_roots`]).
//! A folder that has since been swapped for a link to somewhere else resolves
//! to a different path and is dropped instead of followed.
//!
//! Requests, decisions and revocations are appended to the permission audit
//! log with the normalized scope and expiry. Never file contents, and the
//! reason is redacted by the audit writer like every other record.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// How long a session grant lasts when the caller does not say.
pub const DEFAULT_SESSION_TTL_SECS: u64 = 8 * 60 * 60;

/// File under the data folder holding grants the user chose to keep.
const PERSISTED_FILE: &str = "access_grants.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    Read,
    Write,
}

impl AccessMode {
    pub fn parse(raw: Option<&str>) -> Result<Self, Refusal> {
        match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("read") | Some("read-only") | Some("readonly") => {
                Ok(Self::Read)
            }
            Some("write") | Some("read-write") | Some("readwrite") => Ok(Self::Write),
            Some(other) => Err(Refusal::new(
                RefusalCode::InvalidMode,
                format!("access_mode must be \"read\" or \"write\", not \"{other}\""),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

/// Why a request could not be offered to the user at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalCode {
    InvalidPath,
    InvalidMode,
    NotAbsolute,
    NotFound,
    Traversal,
    DevicePath,
    UncPath,
    DriveRoot,
    HomeDirectory,
    ContainsHome,
    Sensitive,
    ContainsSensitive,
    DataFolder,
    Workspace,
    SystemWrite,
}

impl RefusalCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPath => "invalid_path",
            Self::InvalidMode => "invalid_mode",
            Self::NotAbsolute => "not_absolute",
            Self::NotFound => "not_found",
            Self::Traversal => "traversal",
            Self::DevicePath => "device_path",
            Self::UncPath => "unc_path",
            Self::DriveRoot => "drive_root",
            Self::HomeDirectory => "home_directory",
            Self::ContainsHome => "contains_home",
            Self::Sensitive => "sensitive",
            Self::ContainsSensitive => "contains_sensitive",
            Self::DataFolder => "data_folder",
            Self::Workspace => "workspace",
            Self::SystemWrite => "system_write",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    pub code: RefusalCode,
    pub message: String,
}

impl Refusal {
    fn new(code: RefusalCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// A request that may be shown to the user: the exact scope they would grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// Canonical, as enforced. On Windows this keeps the `\\?\` prefix.
    #[serde(skip)]
    pub canonical: PathBuf,
    /// The canonical path as a person reads it.
    pub display: String,
    pub is_dir: bool,
    pub mode: AccessMode,
    /// The path as the model spelled it, when that differs from `display`
    /// (a link, `.`/case differences), so the prompt can show both.
    pub requested: String,
    pub resolved_differs: bool,
}

/// What the machine looks like, for [`prepare`]. Injected so tests can put the
/// home and data folders anywhere.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub data_folder: Option<PathBuf>,
    pub workspace: Option<PathBuf>,
    /// Absolute locations that must never be granted, beyond the built-in list.
    pub extra_sensitive: Vec<PathBuf>,
}

impl Env {
    /// The real machine: `$HOME`/`%USERPROFILE%`, plus what the caller knows.
    pub fn host(data_folder: Option<&Path>, workspace: Option<&Path>) -> Self {
        #[cfg(windows)]
        let home = std::env::var_os("USERPROFILE");
        #[cfg(not(windows))]
        let home = std::env::var_os("HOME");
        Self {
            home: home.map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()),
            data_folder: data_folder.map(Path::to_path_buf),
            workspace: workspace.map(Path::to_path_buf),
            extra_sensitive: Vec::new(),
        }
    }
}

/// Directory names that hold credentials wherever they appear.
const SENSITIVE_NAMES: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".gpg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".password-store",
    ".vault",
    ".secrets",
    "secrets",
    ".credentials",
    "credentials",
    "keychains",
    ".pki",
    ".gcloud",
    "gcloud",
    ".terraform.d",
];

/// Locations under the home directory that hold credentials, browser profiles
/// or key material. Relative to the home; separators normalized at compare.
const SENSITIVE_UNDER_HOME: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".config/gh",
    ".config/google-chrome",
    ".config/chromium",
    ".config/BraveSoftware",
    ".mozilla",
    ".password-store",
    ".netrc",
    ".git-credentials",
    "Library/Keychains",
    "Library/Cookies",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Microsoft Edge",
    "Library/Safari",
    "AppData/Roaming/Microsoft/Credentials",
    "AppData/Local/Microsoft/Credentials",
    "AppData/Roaming/Microsoft/Protect",
    "AppData/Roaming/Microsoft/Crypto",
    "AppData/Roaming/Microsoft/SystemCertificates",
    "AppData/Local/Microsoft/Vault",
    "AppData/Local/Google/Chrome/User Data",
    "AppData/Local/Microsoft/Edge/User Data",
    "AppData/Local/BraveSoftware",
    "AppData/Roaming/Mozilla/Firefox",
    "AppData/Roaming/Opera Software",
    "AppData/Local/Vivaldi",
    "AppData/Roaming/GitHub CLI",
];

/// File names that are key material or credentials in their own right.
fn is_sensitive_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    crate::project_browse::is_sensitive_name(name)
        || lower == ".netrc"
        || lower == "_netrc"
        || lower == ".git-credentials"
        || lower == "login data"
        || lower == "cookies"
        || lower.ends_with(".kdbx")
        || lower.starts_with("id_rsa")
        || lower.starts_with("id_ed25519")
        || lower.starts_with("id_ecdsa")
}

/// Windows device names, which name a device in every directory.
const RESERVED_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "conin$", "conout$", "com1", "com2", "com3", "com4", "com5",
    "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7",
    "lpt8", "lpt9",
];

fn is_reserved_device_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end()
        .to_ascii_lowercase();
    RESERVED_DEVICE_NAMES.contains(&stem.as_str())
}

/// Case- and separator-insensitive form used for every containment check.
fn key(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let raw = raw
        .strip_prefix("//?/")
        .map(str::to_string)
        .unwrap_or(raw);
    let raw = raw.trim_end_matches('/').to_string();
    if cfg!(windows) {
        raw.to_lowercase()
    } else {
        raw
    }
}

/// `inner` is `outer` or below it.
fn within(inner: &Path, outer: &Path) -> bool {
    let (i, o) = (key(inner), key(outer));
    i == o || i.starts_with(&format!("{o}/"))
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// The canonical path as a person reads it: no `\\?\` prefix.
pub fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

fn is_unc_or_device_text(raw: &str) -> Option<RefusalCode> {
    let norm = raw.replace('/', "\\");
    let lower = norm.to_ascii_lowercase();
    if lower.starts_with(r"\\.\") || lower.starts_with(r"\??\") || lower.starts_with(r"\\?\globalroot")
    {
        return Some(RefusalCode::DevicePath);
    }
    if lower.starts_with(r"\\?\unc\") {
        return Some(RefusalCode::UncPath);
    }
    if lower.starts_with(r"\\?\") {
        // A verbatim path is how Jan writes canonical paths, never how a person
        // names a folder. Asking for one is asking to skip normalization.
        return Some(RefusalCode::DevicePath);
    }
    if lower.starts_with(r"\\") {
        return Some(RefusalCode::UncPath);
    }
    if cfg!(unix) {
        for dev in ["/dev", "/proc", "/sys"] {
            if raw == dev || raw.starts_with(&format!("{dev}/")) {
                return Some(RefusalCode::DevicePath);
            }
        }
    }
    None
}

/// Validate what the model asked for and resolve it to the scope a grant
/// would cover. Every refusal is structured, so the model can be told exactly
/// why and offered something else instead of retrying the same request.
pub fn prepare(raw: &str, mode: AccessMode, env: &Env) -> Result<Prepared, Refusal> {
    let requested = raw.trim();
    // Transcript audit #5: `"C:\tmp"` in JSON arrives as `C:<TAB>mp`.
    let repaired;
    let requested = match crate::tools::path_repair::repair("path", requested, &|p| {
        Path::new(p).exists()
    }) {
        Ok(Some(fixed)) => {
            repaired = fixed;
            repaired.as_str()
        }
        Ok(None) => requested,
        Err(e) => return Err(Refusal::new(RefusalCode::InvalidPath, e)),
    };
    if requested.is_empty() || requested.contains('\0') {
        return Err(Refusal::new(RefusalCode::InvalidPath, "path is empty"));
    }
    if let Some(code) = is_unc_or_device_text(requested) {
        let what = if code == RefusalCode::UncPath {
            "a network (UNC) share"
        } else {
            "a device or verbatim path"
        };
        return Err(Refusal::new(
            code,
            format!("{requested} is {what}, which cannot be granted"),
        ));
    }
    if requested.contains(['*', '?']) && !requested.starts_with(r"\\?\") {
        return Err(Refusal::new(
            RefusalCode::InvalidPath,
            "path contains a wildcard; name one folder or file",
        ));
    }
    if requested.starts_with('~') {
        return Err(Refusal::new(
            RefusalCode::NotAbsolute,
            "`~` is not expanded; give the full absolute path",
        ));
    }
    let path = Path::new(requested);
    if !path.is_absolute() {
        return Err(Refusal::new(
            RefusalCode::NotAbsolute,
            format!("{requested} is relative; give the full absolute path"),
        ));
    }
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(Refusal::new(
                    RefusalCode::Traversal,
                    "path contains `..`; name the folder directly",
                ))
            }
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                if cfg!(windows) && is_reserved_device_component(&name) {
                    return Err(Refusal::new(
                        RefusalCode::DevicePath,
                        format!("`{name}` is a Windows device name, not a file"),
                    ));
                }
                // An alternate data stream (`file.txt:stream`) is not the file
                // the prompt would show.
                if cfg!(windows) && name.contains(':') {
                    return Err(Refusal::new(
                        RefusalCode::InvalidPath,
                        "path names an alternate data stream",
                    ));
                }
            }
            _ => {}
        }
    }

    let canonical = path.canonicalize().map_err(|e| {
        Refusal::new(
            RefusalCode::NotFound,
            format!("{requested} does not exist or cannot be resolved ({e})"),
        )
    })?;
    let display = display_path(&canonical);
    // A mapped drive or a link can resolve onto a share even when the text did
    // not name one.
    if let Some(code) = is_unc_or_device_text(&display) {
        return Err(Refusal::new(
            code,
            format!("{requested} resolves to {display}, which cannot be granted"),
        ));
    }
    if canonical.parent().is_none() || Path::new(&display).parent().is_none() {
        return Err(Refusal::new(
            RefusalCode::DriveRoot,
            format!("{display} is a drive or filesystem root; name the folder you need"),
        ));
    }

    if let Some(home) = env.home.as_deref() {
        let home = canonical_or_self(home);
        if within(&home, &canonical) {
            let code = if key(&home) == key(&canonical) {
                RefusalCode::HomeDirectory
            } else {
                RefusalCode::ContainsHome
            };
            return Err(Refusal::new(
                code,
                format!(
                    "{display} is or contains the home directory; ask for the specific \
                     folder inside it that you need"
                ),
            ));
        }
        for rel in SENSITIVE_UNDER_HOME {
            let loc = home.join(rel);
            if within(&canonical, &loc) {
                return Err(Refusal::new(
                    RefusalCode::Sensitive,
                    format!(
                        "{display} is inside {} (credentials, keys or a browser profile)",
                        display_path(&loc)
                    ),
                ));
            }
            if within(&loc, &canonical) {
                return Err(Refusal::new(
                    RefusalCode::ContainsSensitive,
                    format!(
                        "{display} contains {}, which holds credentials, keys or a browser \
                         profile; ask for a narrower folder",
                        display_path(&loc)
                    ),
                ));
            }
        }
    }
    for extra in &env.extra_sensitive {
        let extra = canonical_or_self(extra);
        if within(&canonical, &extra) || within(&extra, &canonical) {
            return Err(Refusal::new(
                RefusalCode::Sensitive,
                format!("{display} overlaps a protected location"),
            ));
        }
    }
    for component in canonical.components() {
        if let Component::Normal(name) = component {
            let lower = name.to_string_lossy().to_ascii_lowercase();
            if SENSITIVE_NAMES.contains(&lower.as_str()) {
                return Err(Refusal::new(
                    RefusalCode::Sensitive,
                    format!("{display} is inside a `{lower}` directory, which holds secrets"),
                ));
            }
        }
    }
    let is_dir = canonical.is_dir();
    if !is_dir {
        if let Some(name) = canonical.file_name() {
            if is_sensitive_file_name(&name.to_string_lossy()) {
                return Err(Refusal::new(
                    RefusalCode::Sensitive,
                    format!("{display} looks like a credential or key file"),
                ));
            }
        }
    }
    if let Some(data) = env.data_folder.as_deref() {
        let data = canonical_or_self(data);
        if within(&canonical, &data) || within(&data, &canonical) {
            return Err(Refusal::new(
                RefusalCode::DataFolder,
                format!(
                    "{display} overlaps Flint's data folder, which holds provider keys and \
                     session state. Use list_plugins, skill_list or memory_list for what is \
                     in it"
                ),
            ));
        }
    }
    if let Some(ws) = env.workspace.as_deref() {
        let ws = canonical_or_self(ws);
        if within(&canonical, &ws) {
            return Err(Refusal::new(
                RefusalCode::Workspace,
                format!("{display} is already inside the workspace; no grant is needed"),
            ));
        }
        if within(&ws, &canonical) {
            return Err(Refusal::new(
                RefusalCode::ContainsHome,
                format!("{display} contains the agent workspace; ask for a narrower folder"),
            ));
        }
    }
    if mode == AccessMode::Write && is_system_location(&canonical) {
        return Err(Refusal::new(
            RefusalCode::SystemWrite,
            format!("{display} is a system location and cannot be granted for writing"),
        ));
    }

    let resolved_differs = key(Path::new(requested)) != key(&canonical);
    Ok(Prepared {
        canonical,
        display,
        is_dir,
        mode,
        requested: requested.to_string(),
        resolved_differs,
    })
}

fn is_system_location(path: &Path) -> bool {
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    for var in [
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
    ] {
        if let Some(v) = std::env::var_os(var) {
            roots.push(PathBuf::from(v));
        }
    }
    #[cfg(unix)]
    for p in [
        "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/var", "/opt", "/System",
        "/Library", "/Applications",
    ] {
        roots.push(PathBuf::from(p));
    }
    roots
        .iter()
        .any(|r| within(path, &canonical_or_self(r)))
}

/// One grant: a scope, the session it belongs to, and how long it lasts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessGrant {
    pub id: String,
    /// The session it was issued in. A kept grant applies to every session.
    pub session: String,
    /// Canonical, as enforced.
    pub path: PathBuf,
    pub display: String,
    pub is_dir: bool,
    pub mode: AccessMode,
    pub reason: String,
    /// Unix seconds.
    pub granted_at: u64,
    /// Unix seconds; `None` for a kept grant.
    pub expires_at: Option<u64>,
    pub persistent: bool,
}

fn registry() -> &'static Mutex<HashMap<String, AccessGrant>> {
    static REG: OnceLock<Mutex<HashMap<String, AccessGrant>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serializes read-modify-write of the kept-grant file.
fn persist_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("acc-{:x}-{:x}-{n:x}", now_secs(), nanos)
}

fn persisted_path(data_folder: &Path) -> PathBuf {
    data_folder.join(PERSISTED_FILE)
}

fn load_persisted(data_folder: &Path) -> Vec<AccessGrant> {
    std::fs::read_to_string(persisted_path(data_folder))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<AccessGrant>>(&s).ok())
        .unwrap_or_default()
}

fn save_persisted(data_folder: &Path, grants: &[AccessGrant]) -> Result<(), String> {
    std::fs::create_dir_all(data_folder).map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(grants).map_err(|e| e.to_string())?;
    let path = persisted_path(data_folder);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Who asked, for the audit record of a `request_access` call: the run and
/// tool call it came from, the agent, and the project the session is bound
/// to. Sent by the renderer; every field optional, so a caller that has none
/// records what it did before (session 8411d403's records had empty
/// `agent`/`project`/`run`/`call`, unlike every other decision in the log).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuditIds {
    pub run: Option<String>,
    pub call: Option<String>,
    pub agent: Option<String>,
    pub project: Option<String>,
}

impl AuditIds {
    fn stamp(&self, r: crate::audit::PermissionRecord) -> crate::audit::PermissionRecord {
        let pick = |v: &Option<String>| v.as_deref().map(str::trim).unwrap_or("").to_string();
        r.with_run(pick(&self.run))
            .with_call(pick(&self.call))
            .with_agent(pick(&self.agent))
            .with_project(pick(&self.project))
    }
}

/// Issue a grant. The path is prepared again here: a grant can only ever
/// cover what [`prepare`] would have shown.
#[allow(clippy::too_many_arguments)]
pub fn grant(
    data_folder: &Path,
    env: &Env,
    session: &str,
    path: &str,
    mode: AccessMode,
    reason: &str,
    persistent: bool,
    ttl_secs: Option<u64>,
) -> Result<AccessGrant, Refusal> {
    grant_as(
        data_folder,
        env,
        session,
        path,
        mode,
        reason,
        persistent,
        ttl_secs,
        &AuditIds::default(),
    )
}

/// [`grant`], recording who asked.
#[allow(clippy::too_many_arguments)]
pub fn grant_as(
    data_folder: &Path,
    env: &Env,
    session: &str,
    path: &str,
    mode: AccessMode,
    reason: &str,
    persistent: bool,
    ttl_secs: Option<u64>,
    ids: &AuditIds,
) -> Result<AccessGrant, Refusal> {
    let prepared = prepare(path, mode, env)?;
    let now = now_secs();
    let grant = AccessGrant {
        id: new_id(),
        session: session.to_string(),
        path: prepared.canonical.clone(),
        display: prepared.display.clone(),
        is_dir: prepared.is_dir,
        mode,
        reason: truncate(reason, 500),
        granted_at: now,
        expires_at: if persistent {
            None
        } else {
            Some(now + ttl_secs.unwrap_or(DEFAULT_SESSION_TTL_SECS))
        },
        persistent,
    };
    if persistent {
        let _guard = persist_lock().lock().unwrap_or_else(|e| e.into_inner());
        let mut all = load_persisted(data_folder);
        all.retain(|g| !(key(&g.path) == key(&grant.path) && g.mode == grant.mode));
        all.push(grant.clone());
        save_persisted(data_folder, &all)
            .map_err(|e| Refusal::new(RefusalCode::InvalidPath, format!("could not save: {e}")))?;
    } else if let Ok(mut reg) = registry().lock() {
        reg.insert(grant.id.clone(), grant.clone());
    }
    audit_event_as(
        data_folder,
        session,
        "granted",
        &grant.display,
        mode,
        &grant_detail(&grant),
        ids,
    );
    Ok(grant)
}

fn grant_detail(g: &AccessGrant) -> String {
    match g.expires_at {
        Some(t) => format!(
            "scope={} mode={} session-only expires={}",
            g.display,
            g.mode.as_str(),
            crate::audit::format_rfc3339(t)
        ),
        None => format!("scope={} mode={} kept until revoked", g.display, g.mode.as_str()),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// Record that a request was made, or refused, or denied by the user.
pub fn audit_event(
    data_folder: &Path,
    session: &str,
    event: &str,
    scope: &str,
    mode: AccessMode,
    detail: &str,
) {
    audit_event_as(data_folder, session, event, scope, mode, detail, &AuditIds::default())
}

/// [`audit_event`], recording who asked.
pub fn audit_event_as(
    data_folder: &Path,
    session: &str,
    event: &str,
    scope: &str,
    mode: AccessMode,
    detail: &str,
    ids: &AuditIds,
) {
    use crate::audit::{Outcome, PermissionRecord};
    let outcome = match event {
        "granted" => Outcome::Granted,
        "requested" => Outcome::Prompt,
        "denied" => Outcome::Refused,
        "revoked" => Outcome::Revoked,
        "cancelled" => Outcome::Cancelled,
        _ => Outcome::Deny,
    };
    let record = PermissionRecord::new(
        crate::audit::now(),
        session,
        "request_access",
        mode.as_str(),
        &crate::resource::Resource::Path(PathBuf::from(scope)),
        outcome,
        format!("{event}: {detail}"),
    );
    crate::audit::append(data_folder, &ids.stamp(record));
}

/// Withdraw one grant, session or kept.
pub fn revoke(data_folder: &Path, id: &str) -> bool {
    let removed = registry().lock().ok().and_then(|mut r| r.remove(id));
    if let Some(g) = removed {
        audit_event(data_folder, &g.session, "revoked", &g.display, g.mode, "by user");
        return true;
    }
    let _guard = persist_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load_persisted(data_folder);
    let Some(pos) = all.iter().position(|g| g.id == id) else {
        return false;
    };
    let g = all.remove(pos);
    if save_persisted(data_folder, &all).is_err() {
        return false;
    }
    audit_event(data_folder, &g.session, "revoked", &g.display, g.mode, "by user");
    true
}

/// Withdraw every session grant a session holds (kept grants stay).
pub fn revoke_session(data_folder: &Path, session: &str) -> usize {
    let Ok(mut reg) = registry().lock() else {
        return 0;
    };
    let gone: Vec<AccessGrant> = reg
        .values()
        .filter(|g| g.session == session)
        .cloned()
        .collect();
    for g in &gone {
        reg.remove(&g.id);
        audit_event(data_folder, session, "revoked", &g.display, g.mode, "session ended");
    }
    gone.len()
}

/// Every grant that applies to `session` now: its own unexpired session
/// grants and every kept grant. Expired ones are dropped as a side effect.
pub fn list(data_folder: &Path, session: &str, now: u64) -> Vec<AccessGrant> {
    let mut out: Vec<AccessGrant> = Vec::new();
    if let Ok(mut reg) = registry().lock() {
        reg.retain(|_, g| g.expires_at.map_or(true, |t| t > now));
        out.extend(reg.values().filter(|g| g.session == session).cloned());
    }
    out.extend(load_persisted(data_folder));
    out.sort_by(|a, b| a.granted_at.cmp(&b.granted_at).then(a.id.cmp(&b.id)));
    out
}

/// Every grant anywhere, for the revocation surface.
pub fn list_all(data_folder: &Path, now: u64) -> Vec<AccessGrant> {
    let mut out: Vec<AccessGrant> = Vec::new();
    if let Ok(mut reg) = registry().lock() {
        reg.retain(|_, g| g.expires_at.map_or(true, |t| t > now));
        out.extend(reg.values().cloned());
    }
    out.extend(load_persisted(data_folder));
    out.sort_by(|a, b| a.granted_at.cmp(&b.granted_at).then(a.id.cmp(&b.id)));
    out
}

/// The roots a tool call in `session` may read and write, re-resolved now.
///
/// A grant whose path no longer canonicalizes to what was approved -- deleted,
/// or replaced by a link or junction to somewhere else -- is skipped rather
/// than followed. A write grant is also a read grant.
pub fn active_roots(data_folder: &Path, session: &str, now: u64) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut read = Vec::new();
    let mut write = Vec::new();
    for g in list(data_folder, session, now) {
        let Ok(current) = g.path.canonicalize() else {
            continue;
        };
        if key(&current) != key(&g.path) {
            continue;
        }
        if !read.iter().any(|p: &PathBuf| key(p) == key(&current)) {
            read.push(current.clone());
        }
        if g.mode == AccessMode::Write && !write.iter().any(|p: &PathBuf| key(p) == key(&current))
        {
            write.push(current);
        }
    }
    (read, write)
}

/// The structured answer `request_access` hands the model.
pub fn result_json(status: &str, fields: serde_json::Value) -> String {
    let mut obj = serde_json::json!({ "status": status });
    if let (Some(dst), Some(src)) = (obj.as_object_mut(), fields.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    obj.to_string()
}

/// What a refused request tells the model: the reason, and what to do instead
/// of asking again.
pub fn refusal_result(refusal: &Refusal) -> String {
    result_json(
        "refused",
        serde_json::json!({
            "code": refusal.code.as_str(),
            "message": refusal.message,
            "next": refusal_next(refusal.code),
        }),
    )
}

/// What to do instead, chosen by why the request was refused. "Ask for a
/// narrower folder" only helps when the folder was too broad; for a path
/// already in the workspace, a system location or a malformed path it sent
/// the model to ask the user for something that could never be granted.
fn refusal_next(code: RefusalCode) -> &'static str {
    match code {
        RefusalCode::HomeDirectory
        | RefusalCode::ContainsHome
        | RefusalCode::DriveRoot
        | RefusalCode::ContainsSensitive => {
            "Do not repeat this request. Ask the user for a narrower, specific folder, \
             or for them to paste or attach the content, or work from what you can \
             already read."
        }
        RefusalCode::Workspace => {
            "No grant is needed: the path is already inside your workspace. Use it \
             directly with read, ls, write or bash."
        }
        RefusalCode::InvalidPath
        | RefusalCode::InvalidMode
        | RefusalCode::NotAbsolute
        | RefusalCode::NotFound
        | RefusalCode::Traversal => {
            "Fix the request itself: give an existing absolute path and a mode of read or \
             write. Do not repeat it unchanged."
        }
        RefusalCode::SystemWrite => {
            "Do not repeat this request. System locations cannot be granted for writing; \
             ask for read access instead, or ask the user to make the change themselves."
        }
        RefusalCode::DevicePath
        | RefusalCode::UncPath
        | RefusalCode::Sensitive
        | RefusalCode::DataFolder => {
            "Do not repeat this request; this location cannot be granted. Ask the user to \
             paste or attach the content, or work from what you can already read."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        base: PathBuf,
        home: PathBuf,
        data: PathBuf,
        ws: PathBuf,
        outside: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn fixture(tag: &str) -> Fixture {
        let base = std::env::temp_dir().join(format!(
            "jan_access_{tag}_{}_{}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let data = home.join("AppData/Roaming/Jan/data");
        let ws = data.join("agent-workspace/sessions/s1");
        let outside = base.join("projects/notes");
        for d in [&home, &data, &ws, &outside, &home.join(".ssh"), &home.join("Documents/proj")] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(outside.join("todo.txt"), "x").unwrap();
        std::fs::write(home.join(".ssh/id_ed25519"), "k").unwrap();
        let base = base.canonicalize().unwrap();
        Fixture {
            home: base.join("home"),
            data: base.join("home/AppData/Roaming/Jan/data"),
            ws: base.join("home/AppData/Roaming/Jan/data/agent-workspace/sessions/s1"),
            outside: base.join("projects/notes"),
            base,
        }
    }

    fn env(f: &Fixture) -> Env {
        Env {
            home: Some(f.home.clone()),
            data_folder: Some(f.data.clone()),
            workspace: Some(f.ws.clone()),
            extra_sensitive: Vec::new(),
        }
    }

    fn s(p: &Path) -> String {
        display_path(p)
    }

    #[test]
    fn prepares_a_plain_folder_and_file() {
        let f = fixture("plain");
        let p = prepare(&s(&f.outside), AccessMode::Read, &env(&f)).unwrap();
        assert!(p.is_dir);
        assert_eq!(key(&p.canonical), key(&f.outside));
        let file = prepare(&s(&f.outside.join("todo.txt")), AccessMode::Read, &env(&f)).unwrap();
        assert!(!file.is_dir);
    }

    #[test]
    fn refuses_relative_tilde_wildcard_and_empty() {
        let f = fixture("rel");
        let e = env(&f);
        assert_eq!(prepare("notes", AccessMode::Read, &e).unwrap_err().code, RefusalCode::NotAbsolute);
        assert_eq!(prepare("~/x", AccessMode::Read, &e).unwrap_err().code, RefusalCode::NotAbsolute);
        assert_eq!(prepare("", AccessMode::Read, &e).unwrap_err().code, RefusalCode::InvalidPath);
        let wild = format!("{}/*", s(&f.outside));
        assert_eq!(prepare(&wild, AccessMode::Read, &e).unwrap_err().code, RefusalCode::InvalidPath);
    }

    #[test]
    fn refuses_traversal_even_when_it_lands_somewhere_allowed() {
        let f = fixture("trav");
        let sneaky = format!("{}/../notes", s(&f.outside));
        assert_eq!(
            prepare(&sneaky, AccessMode::Read, &env(&f)).unwrap_err().code,
            RefusalCode::Traversal
        );
        let to_home = format!("{}/../../home", s(&f.outside));
        assert_eq!(
            prepare(&to_home, AccessMode::Read, &env(&f)).unwrap_err().code,
            RefusalCode::Traversal
        );
    }

    #[test]
    fn refuses_home_its_parents_and_drive_root() {
        let f = fixture("home");
        let e = env(&f);
        assert_eq!(prepare(&s(&f.home), AccessMode::Read, &e).unwrap_err().code, RefusalCode::HomeDirectory);
        assert_eq!(prepare(&s(&f.base), AccessMode::Read, &e).unwrap_err().code, RefusalCode::ContainsHome);
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        let code = prepare(root, AccessMode::Read, &e).unwrap_err().code;
        assert!(matches!(code, RefusalCode::DriveRoot | RefusalCode::ContainsHome), "{code:?}");
        // A folder inside the home is fine.
        assert!(prepare(&s(&f.home.join("Documents/proj")), AccessMode::Read, &e).is_ok());
    }

    #[test]
    fn refuses_sensitive_dirs_files_and_their_parents() {
        let f = fixture("sens");
        let e = env(&f);
        assert_eq!(prepare(&s(&f.home.join(".ssh")), AccessMode::Read, &e).unwrap_err().code, RefusalCode::Sensitive);
        assert_eq!(
            prepare(&s(&f.home.join(".ssh/id_ed25519")), AccessMode::Read, &e).unwrap_err().code,
            RefusalCode::Sensitive
        );
        // AppData contains the credential store and browser profiles.
        let appdata = f.home.join("AppData");
        assert_eq!(prepare(&s(&appdata), AccessMode::Read, &e).unwrap_err().code, RefusalCode::ContainsSensitive);
        // A `.ssh` anywhere, not only under the home.
        let stray = f.outside.join(".ssh");
        std::fs::create_dir_all(&stray).unwrap();
        assert_eq!(prepare(&s(&stray), AccessMode::Read, &e).unwrap_err().code, RefusalCode::Sensitive);
        let env_file = f.outside.join(".env");
        std::fs::write(&env_file, "K=V").unwrap();
        assert_eq!(prepare(&s(&env_file), AccessMode::Read, &e).unwrap_err().code, RefusalCode::Sensitive);
    }

    #[test]
    fn refuses_the_data_folder_and_the_workspace() {
        let f = fixture("data");
        let e = env(&f);
        assert_eq!(prepare(&s(&f.data), AccessMode::Read, &e).unwrap_err().code, RefusalCode::DataFolder);
        assert_eq!(
            prepare(&s(&f.data.join("agent-workspace")), AccessMode::Read, &e).unwrap_err().code,
            RefusalCode::DataFolder
        );
    }

    #[test]
    fn refuses_device_unc_and_verbatim_paths() {
        let f = fixture("dev");
        let e = env(&f);
        for p in [r"\\.\nul", r"\\.\PhysicalDrive0", r"\\?\C:\Windows", r"\??\C:\x", r"\\?\GLOBALROOT\Device"] {
            assert_eq!(prepare(p, AccessMode::Read, &e).unwrap_err().code, RefusalCode::DevicePath, "{p}");
        }
        for p in [r"\\server\share", "//server/share/x", r"\\?\UNC\server\share"] {
            assert_eq!(prepare(p, AccessMode::Read, &e).unwrap_err().code, RefusalCode::UncPath, "{p}");
        }
        #[cfg(windows)]
        {
            let nul = format!("{}\\nul", s(&f.outside));
            assert_eq!(prepare(&nul, AccessMode::Read, &e).unwrap_err().code, RefusalCode::DevicePath);
            let con = format!("{}\\CON.txt", s(&f.outside));
            assert_eq!(prepare(&con, AccessMode::Read, &e).unwrap_err().code, RefusalCode::DevicePath);
            let ads = format!("{}\\todo.txt:hidden", s(&f.outside));
            assert_eq!(prepare(&ads, AccessMode::Read, &e).unwrap_err().code, RefusalCode::InvalidPath);
        }
        #[cfg(unix)]
        assert_eq!(prepare("/dev/sda", AccessMode::Read, &e).unwrap_err().code, RefusalCode::DevicePath);
    }

    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            // A junction needs no privilege, unlike a symlink.
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    }

    #[test]
    fn a_link_resolves_to_its_target_and_is_judged_there() {
        let f = fixture("link");
        let e = env(&f);
        let innocent = f.outside.join("docs");
        if !link_dir(&f.home.join(".ssh"), &innocent) {
            eprintln!("skipping: cannot create a link here");
            return;
        }
        let err = prepare(&s(&innocent), AccessMode::Read, &e).unwrap_err();
        assert_eq!(err.code, RefusalCode::Sensitive);
        // A link to an allowed folder is shown as its target.
        let good = f.base.join("projects/alias");
        assert!(link_dir(&f.home.join("Documents/proj"), &good));
        let p = prepare(&s(&good), AccessMode::Read, &e).unwrap();
        assert!(p.resolved_differs);
        assert_eq!(key(&p.canonical), key(&f.home.join("Documents/proj")));
    }

    #[test]
    fn a_granted_folder_swapped_for_a_link_stops_applying() {
        let f = fixture("swap");
        let e = env(&f);
        let target = f.base.join("projects/swapme");
        std::fs::create_dir_all(&target).unwrap();
        let sess = "swap-session";
        grant(&f.data, &e, sess, &s(&target), AccessMode::Read, "r", false, None).unwrap();
        let (read, _) = active_roots(&f.data, sess, now_secs());
        assert_eq!(read.len(), 1);
        std::fs::remove_dir_all(&target).unwrap();
        if !link_dir(&f.home.join(".ssh"), &target) {
            revoke_session(&f.data, sess);
            return;
        }
        let (read, _) = active_roots(&f.data, sess, now_secs());
        assert!(read.is_empty(), "swapped grant still applied: {read:?}");
        revoke_session(&f.data, sess);
    }

    #[test]
    fn write_to_a_system_location_is_refused_read_may_be_allowed() {
        let e = Env::default();
        #[cfg(windows)]
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        #[cfg(unix)]
        let sys = "/etc".to_string();
        assert_eq!(prepare(&sys, AccessMode::Write, &e).unwrap_err().code, RefusalCode::SystemWrite);
        assert!(prepare(&sys, AccessMode::Read, &e).is_ok());
    }

    #[test]
    fn grant_revoke_and_expiry_for_one_session() {
        let f = fixture("life");
        let e = env(&f);
        let sess = "life-session";
        let g = grant(&f.data, &e, sess, &s(&f.outside), AccessMode::Read, "check notes", false, Some(60)).unwrap();
        assert!(!g.persistent);
        let (read, write) = active_roots(&f.data, sess, now_secs());
        assert_eq!(read.len(), 1);
        assert!(write.is_empty(), "read grant must not allow writes");
        // Another session sees nothing.
        assert!(active_roots(&f.data, "other-session", now_secs()).0.is_empty());
        // Past its expiry it is gone.
        assert!(active_roots(&f.data, sess, now_secs() + 61).0.is_empty());
        assert!(list(&f.data, sess, now_secs()).is_empty());
        let g2 = grant(&f.data, &e, sess, &s(&f.outside), AccessMode::Read, "again", false, None).unwrap();
        assert!(revoke(&f.data, &g2.id));
        assert!(!revoke(&f.data, &g2.id));
        assert!(active_roots(&f.data, sess, now_secs()).0.is_empty());
    }

    #[test]
    fn write_grant_is_separate_and_implies_read() {
        let f = fixture("write");
        let e = env(&f);
        let sess = "write-session";
        grant(&f.data, &e, sess, &s(&f.outside), AccessMode::Write, "fix it", false, None).unwrap();
        let (read, write) = active_roots(&f.data, sess, now_secs());
        assert_eq!(read.len(), 1);
        assert_eq!(write.len(), 1);
        revoke_session(&f.data, sess);
        assert!(active_roots(&f.data, sess, now_secs()).1.is_empty());
    }

    #[test]
    fn kept_grants_persist_across_sessions_until_revoked() {
        let f = fixture("keep");
        let e = env(&f);
        let g = grant(&f.data, &e, "a", &s(&f.outside), AccessMode::Read, "keep", true, None).unwrap();
        assert!(g.expires_at.is_none());
        assert_eq!(active_roots(&f.data, "b", now_secs()).0.len(), 1);
        // Kept on disk, not only in this process's registry.
        assert!(std::fs::read_to_string(f.data.join(PERSISTED_FILE)).unwrap().contains(&g.id));
        assert_eq!(active_roots(&f.data, "c", now_secs()).0.len(), 1);
        assert!(revoke(&f.data, &g.id));
        assert!(active_roots(&f.data, "c", now_secs()).0.is_empty());
    }

    #[test]
    fn grant_reprepares_and_cannot_widen() {
        let f = fixture("wide");
        let e = env(&f);
        let err = grant(&f.data, &e, "w", &s(&f.home), AccessMode::Read, "x", false, None).unwrap_err();
        assert_eq!(err.code, RefusalCode::HomeDirectory);
    }

    #[test]
    fn simultaneous_requests_get_distinct_grants() {
        let f = fixture("multi");
        let e = env(&f);
        let a = f.base.join("projects/a");
        let b = f.base.join("projects/b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let data = f.data.clone();
        let (sa, sb) = (s(&a), s(&b));
        let e1 = e.clone();
        let d1 = data.clone();
        let t1 = std::thread::spawn(move || grant(&d1, &e1, "m", &sa, AccessMode::Read, "a", false, None));
        let t2 = std::thread::spawn(move || grant(&data, &e, "m", &sb, AccessMode::Read, "b", false, None));
        let g1 = t1.join().unwrap().unwrap();
        let g2 = t2.join().unwrap().unwrap();
        assert_ne!(g1.id, g2.id);
        assert_eq!(active_roots(&f.data, "m", now_secs()).0.len(), 2);
        revoke_session(&f.data, "m");
    }

    #[test]
    fn refusal_result_is_structured_and_says_not_to_repeat() {
        let r = refusal_result(&Refusal::new(RefusalCode::HomeDirectory, "too broad"));
        let v: serde_json::Value = serde_json::from_str(&r).unwrap();
        assert_eq!(v["status"], "refused");
        assert_eq!(v["code"], "home_directory");
        assert!(v["next"].as_str().unwrap().contains("Do not repeat"));
        assert!(v["next"].as_str().unwrap().contains("narrower"));
    }

    #[test]
    fn refusal_next_does_not_suggest_a_narrower_folder_where_that_cannot_help() {
        for code in [
            RefusalCode::Workspace,
            RefusalCode::SystemWrite,
            RefusalCode::DataFolder,
            RefusalCode::Sensitive,
            RefusalCode::NotAbsolute,
        ] {
            let r = refusal_result(&Refusal::new(code, "x"));
            let v: serde_json::Value = serde_json::from_str(&r).unwrap();
            assert!(!v["next"].as_str().unwrap().contains("narrower"), "{code:?}");
        }
        let r = refusal_result(&Refusal::new(RefusalCode::Workspace, "x"));
        assert!(r.contains("already inside your workspace"), "{r}");
    }

    #[test]
    fn audit_records_scope_without_contents() {
        let f = fixture("audit");
        let e = env(&f);
        let file = f.outside.join("todo.txt");
        std::fs::write(&file, "SECRET-CONTENT-123").unwrap();
        grant(&f.data, &e, "aud", &s(&file), AccessMode::Read, "read todo", false, None).unwrap();
        let log = crate::audit::read_all(&f.data);
        let text = serde_json::to_string(&log).unwrap();
        assert!(text.contains("request_access"));
        assert!(text.contains("todo.txt"));
        assert!(!text.contains("SECRET-CONTENT-123"));
        revoke_session(&f.data, "aud");
    }
}
