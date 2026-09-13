//! Custom certificate authorities for outbound HTTPS (AH-190).
//!
//! A company that inspects TLS, or runs its own model gateway, signs server
//! certificates with a private CA the operating system does not know. Without a
//! way to say "also trust this CA", the only way through is to turn
//! verification off -- which trusts everyone. This module is the narrow way:
//! it adds the roots in one PEM bundle to every outbound client that talks to
//! a configured endpoint, and changes nothing else.
//!
//! ## Where the bundle is named
//!
//! Only where the user, not a project, decides:
//!
//! 1. `JAN_CA_BUNDLE` in the environment of the process;
//! 2. the CLI: `ca_bundle` in `~/.jan/config.toml` (`jan cli net ca set`);
//! 3. the desktop app: the HTTPS proxy settings (`caBundlePath`).
//!
//! A project's `agent.toml` cannot name one: the repository is written by
//! whoever can push to it, and trust in a certificate authority is not theirs
//! to grant. The CLI does not inherit the desktop's setting either -- trust is
//! stated where it is used, not picked up from somewhere else.
//!
//! ## What it changes, and what it does not
//!
//! * The bundle's roots are **added** to the platform's. Verification stays on:
//!   the certificate must still chain to a trusted root, name the host that was
//!   asked for, and be in date. A custom CA never makes a wrong host or an
//!   expired certificate acceptable.
//! * Nothing ever falls back to plain HTTP.
//! * A bundle that is named but cannot be used -- missing, unreadable, too
//!   large, holding no certificate, or holding something that is not one --
//!   is refused by kind when it is set, reported by kind in status, and makes
//!   every client **fail closed**: built-in roots are switched off and nothing
//!   is trusted, so a typo cannot silently mean "the bundle is ignored".
//!
//! Clients built before the bundle changed are replaced: callers that cache a
//! client key it on [`fingerprint`].

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError};

/// The environment variable that names a bundle for one process.
pub const ENV: &str = "JAN_CA_BUNDLE";

/// The largest bundle read. A CA bundle is a few kilobytes; a file this big is
/// not one.
pub const MAX_BUNDLE_BYTES: u64 = 1024 * 1024;

/// The desktop settings key the HTTPS proxy settings are stored under, and the
/// field inside it that names the bundle.
pub const DESKTOP_SETTINGS_KEY: &str = "setting-proxy-config";
pub const DESKTOP_FIELD: &str = "caBundlePath";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Environment,
    CliConfig,
    DesktopSettings,
}

impl Source {
    pub fn tag(self) -> &'static str {
        match self {
            Source::Environment => "environment (JAN_CA_BUNDLE)",
            Source::CliConfig => "~/.jan/config.toml (ca_bundle)",
            Source::DesktopSettings => "desktop HTTPS proxy settings (caBundlePath)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaErrorKind {
    NotFound,
    Unreadable,
    TooLarge,
    NoCertificates,
    Malformed,
}

impl CaErrorKind {
    pub fn tag(self) -> &'static str {
        match self {
            CaErrorKind::NotFound => "not_found",
            CaErrorKind::Unreadable => "unreadable",
            CaErrorKind::TooLarge => "too_large",
            CaErrorKind::NoCertificates => "no_certificates",
            CaErrorKind::Malformed => "malformed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaError {
    pub kind: CaErrorKind,
    pub path: PathBuf,
    pub message: String,
}

impl std::fmt::Display for CaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<&CaError> for HarnessError {
    fn from(error: &CaError) -> Self {
        let kind = match error.kind {
            CaErrorKind::NotFound => ErrorKind::NotFound,
            CaErrorKind::Unreadable => ErrorKind::Io,
            CaErrorKind::TooLarge | CaErrorKind::NoCertificates | CaErrorKind::Malformed => ErrorKind::InvalidInput,
        };
        HarnessError::new(kind, error.message.clone())
    }
}

/// One loaded bundle.
#[derive(Clone)]
pub struct Bundle {
    pub path: PathBuf,
    pub source: Source,
    /// SHA-256 of each certificate's DER, hex, so a person can check what is
    /// trusted against what they meant to trust.
    pub fingerprints: Vec<String>,
    pem: Vec<u8>,
}

impl std::fmt::Debug for Bundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bundle")
            .field("path", &self.path)
            .field("source", &self.source)
            .field("fingerprints", &self.fingerprints)
            .finish()
    }
}

fn refuse(kind: CaErrorKind, path: &Path, message: String) -> CaError {
    CaError { kind, path: path.to_path_buf(), message }
}

/// Read and check a bundle. Every certificate in it must parse for both HTTP
/// stacks the app uses; one that does not refuses the whole bundle, rather than
/// trusting whatever parsed.
pub fn load(path: &Path, source: Source) -> Result<Bundle, CaError> {
    let shown = path.display().to_string();
    let metadata = std::fs::metadata(path).map_err(|e| {
        let kind = if e.kind() == std::io::ErrorKind::NotFound { CaErrorKind::NotFound } else { CaErrorKind::Unreadable };
        refuse(kind, path, format!("the CA bundle {shown} cannot be used: {e}"))
    })?;
    if !metadata.is_file() {
        return Err(refuse(CaErrorKind::Unreadable, path, format!("the CA bundle {shown} is not a file")));
    }
    if metadata.len() > MAX_BUNDLE_BYTES {
        return Err(refuse(
            CaErrorKind::TooLarge,
            path,
            format!("the CA bundle {shown} is {} bytes; a bundle over {MAX_BUNDLE_BYTES} bytes is not read", metadata.len()),
        ));
    }
    let pem = std::fs::read(path).map_err(|e| refuse(CaErrorKind::Unreadable, path, format!("the CA bundle {shown} cannot be read: {e}")))?;
    let text = String::from_utf8_lossy(&pem);
    let blocks = pem_blocks(&text);
    if blocks.is_empty() {
        return Err(refuse(
            CaErrorKind::NoCertificates,
            path,
            format!("the CA bundle {shown} holds no PEM certificate (-----BEGIN CERTIFICATE-----)"),
        ));
    }
    let mut fingerprints = Vec::with_capacity(blocks.len());
    for (index, block) in blocks.iter().enumerate() {
        use base64::Engine as _;
        let der = base64::engine::general_purpose::STANDARD.decode(block).map_err(|e| {
            refuse(CaErrorKind::Malformed, path, format!("certificate {} in {shown} is not valid base64: {e}", index + 1))
        })?;
        let one = format!("-----BEGIN CERTIFICATE-----\n{block}\n-----END CERTIFICATE-----\n");
        reqwest::Certificate::from_pem(one.as_bytes()).map_err(|e| {
            refuse(CaErrorKind::Malformed, path, format!("certificate {} in {shown} is not a certificate: {e}", index + 1))
        })?;
        reqwest13::Certificate::from_pem(one.as_bytes()).map_err(|e| {
            refuse(CaErrorKind::Malformed, path, format!("certificate {} in {shown} is not a certificate: {e}", index + 1))
        })?;
        // native-tls parses lazily on some platforms; a DER that is not an
        // X.509 certificate at all is refused here instead of at the handshake.
        if !looks_like_x509(&der) {
            return Err(refuse(
                CaErrorKind::Malformed,
                path,
                format!("certificate {} in {shown} is not an X.509 certificate", index + 1),
            ));
        }
        fingerprints.push(hex::encode(Sha256::digest(&der)));
    }
    Ok(Bundle { path: path.to_path_buf(), source, fingerprints, pem })
}

/// The base64 bodies of the `CERTIFICATE` blocks in `text`.
fn pem_blocks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines().map(str::trim) {
        match (&mut current, line) {
            (None, "-----BEGIN CERTIFICATE-----") => current = Some(String::new()),
            (Some(body), "-----END CERTIFICATE-----") => {
                out.push(std::mem::take(body));
                current = None;
            }
            (Some(body), line) => body.push_str(line),
            (None, _) => {}
        }
    }
    out
}

/// A DER X.509 certificate is a SEQUENCE of three things: tbsCertificate (a
/// SEQUENCE), the signature algorithm (a SEQUENCE) and the signature (a BIT
/// STRING). Checked structurally, without a parser dependency.
fn looks_like_x509(der: &[u8]) -> bool {
    fn header(bytes: &[u8]) -> Option<(u8, usize, usize)> {
        let tag = *bytes.first()?;
        let first = *bytes.get(1)? as usize;
        if first < 0x80 {
            return Some((tag, 2, first));
        }
        let count = first & 0x7f;
        if count == 0 || count > 4 {
            return None;
        }
        let mut length = 0usize;
        for i in 0..count {
            length = (length << 8) | *bytes.get(2 + i)? as usize;
        }
        Some((tag, 2 + count, length))
    }
    let Some((0x30, head, length)) = header(der) else { return false };
    let Some(body) = der.get(head..head + length) else { return false };
    let mut rest = body;
    let mut tags = Vec::new();
    while !rest.is_empty() {
        let Some((tag, head, length)) = header(rest) else { return false };
        tags.push(tag);
        let Some(next) = rest.get(head + length..) else { return false };
        rest = next;
    }
    tags == [0x30, 0x30, 0x03]
}

/// Where the bundle is named, if anywhere, in precedence order.
pub fn configured_path() -> Option<(PathBuf, Source)> {
    if let Some(value) = std::env::var_os(ENV).filter(|v| !v.is_empty()) {
        return Some((PathBuf::from(value), Source::Environment));
    }
    #[cfg(feature = "cli")]
    {
        if let Ok(Some(path)) = crate::core::agent::global_config::ca_bundle() {
            return Some((PathBuf::from(path), Source::CliConfig));
        }
    }
    #[cfg(not(feature = "cli"))]
    {
        if let Some(path) = desktop_setting(crate::core::app::settings_store::settings_get(DESKTOP_SETTINGS_KEY.to_string())) {
            return Some((path, Source::DesktopSettings));
        }
    }
    None
}

/// The bundle path inside the desktop's stored proxy settings, a Zustand
/// `persist` blob: `{"state": {"caBundlePath": "..."}, "version": 0}`.
pub fn desktop_setting(stored: Option<String>) -> Option<PathBuf> {
    let value: serde_json::Value = serde_json::from_str(&stored?).ok()?;
    let path = value.get("state")?.get(DESKTOP_FIELD)?.as_str()?.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// The configured bundle: `None` when nothing is configured.
pub fn configured() -> Option<Result<Bundle, CaError>> {
    let (path, source) = configured_path()?;
    Some(load(&path, source))
}

/// A cheap key for "which bundle is in force": the path, its size and its
/// modification time. A caller caching a client rebuilds it when this changes.
pub fn fingerprint() -> u64 {
    use std::hash::{Hash, Hasher};
    let Some((path, source)) = configured_path() else { return 0 };
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    (source as u8).hash(&mut h);
    if let Ok(meta) = std::fs::metadata(&path) {
        meta.len().hash(&mut h);
        if let Ok(modified) = meta.modified() {
            modified.hash(&mut h);
        }
    }
    h.finish() | 1
}

/// Log a broken bundle once per distinct problem, not once per client.
fn report_broken(error: &CaError) {
    static SEEN: Mutex<Option<String>> = Mutex::new(None);
    let mut seen = SEEN.lock().unwrap_or_else(|p| p.into_inner());
    if seen.as_deref() != Some(error.message.as_str()) {
        log::error!("{} -- outbound HTTPS trusts nothing until it is fixed", error.message);
        *seen = Some(error.message.clone());
    }
}

/// Apply `bundle` to a reqwest 0.12 client: its roots added to the platform's,
/// or -- for a bundle that cannot be used -- nothing trusted at all.
pub fn with_bundle12(builder: reqwest::ClientBuilder, bundle: Option<&Result<Bundle, CaError>>) -> reqwest::ClientBuilder {
    match bundle {
        None => builder,
        Some(Ok(bundle)) => {
            let certs = reqwest::Certificate::from_pem_bundle(&bundle.pem).unwrap_or_default();
            certs.into_iter().fold(builder, |b, cert| b.add_root_certificate(cert))
        }
        Some(Err(error)) => {
            report_broken(error);
            builder.tls_built_in_root_certs(false)
        }
    }
}

/// Apply `bundle` to a reqwest 0.13 client, with the same rules.
pub fn with_bundle13(builder: reqwest13::ClientBuilder, bundle: Option<&Result<Bundle, CaError>>) -> reqwest13::ClientBuilder {
    match bundle {
        None => builder,
        Some(Ok(bundle)) => {
            let certs = reqwest13::Certificate::from_pem_bundle(&bundle.pem).unwrap_or_default();
            builder.tls_certs_merge(certs)
        }
        Some(Err(error)) => {
            report_broken(error);
            builder.tls_certs_only(Vec::new())
        }
    }
}

/// The configured bundle, applied to a reqwest 0.12 client.
pub fn apply12(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let bundle = configured();
    with_bundle12(builder, bundle.as_ref())
}

/// The configured bundle, applied to a reqwest 0.13 client.
pub fn apply13(builder: reqwest13::ClientBuilder) -> reqwest13::ClientBuilder {
    let bundle = configured();
    with_bundle13(builder, bundle.as_ref())
}

/// Why a failed request failed, when the reason is the server's certificate
/// (R13). `None` for anything else -- a refused connection, a timeout, a
/// protocol error -- which may be worth another attempt; a certificate failure
/// never is, and a person needs to be told which one it was.
///
/// Read from the error's source chain: the platform TLS error codes first
/// (Windows SChannel, the only ones exercised on this machine), then the wording
/// the other TLS implementations use (OpenSSL on Linux, Security.framework on
/// macOS, rustls on mobile), which is documented but not exercised here.
pub fn certificate_failure(err: &(dyn std::error::Error + 'static)) -> Option<String> {
    const WINDOWS: &[(i32, &str)] = &[
        (-2146762487, "the certificate chain ends in a root certificate that is not trusted (CERT_E_UNTRUSTEDROOT)"),
        (-2146762481, "the certificate is not valid for this host name (CERT_E_CN_NO_MATCH)"),
        (-2146762495, "the certificate has expired or is not yet valid (CERT_E_EXPIRED)"),
        (-2146762486, "the certificate chain could not be built to a trusted root (CERT_E_CHAINING)"),
        (-2146762484, "the certificate has been revoked (CERT_E_REVOKED)"),
        (-2146762480, "the certificate is not valid for this use (CERT_E_WRONG_USAGE)"),
        (-2146869244, "the certificate's signature is not valid (TRUST_E_CERT_SIGNATURE)"),
        (-2146893022, "the certificate is not valid for this host name (SEC_E_WRONG_PRINCIPAL)"),
        (-2146893019, "the certificate chain ends in a root certificate that is not trusted (SEC_E_UNTRUSTED_ROOT)"),
        (-2146893017, "the certificate could not be verified (SEC_E_CERT_UNKNOWN)"),
        (-2146893016, "the certificate has expired (SEC_E_CERT_EXPIRED)"),
    ];
    const WORDING: &[(&str, &str)] = &[
        // Windows SChannel's own text, as captured from a real refusal.
        ("not trusted by the trust provider", "the certificate chain ends in a root certificate that is not trusted"),
        ("cn name does not match", "the certificate is not valid for this host name"),
        ("unable to get local issuer certificate", "the certificate chain ends in a root certificate that is not trusted"),
        ("self signed certificate", "the server's certificate is self-signed and not trusted"),
        ("self-signed certificate", "the server's certificate is self-signed and not trusted"),
        ("certificate has expired", "the certificate has expired"),
        ("hostname mismatch", "the certificate is not valid for this host name"),
        ("notvalidforname", "the certificate is not valid for this host name"),
        ("not valid for name", "the certificate is not valid for this host name"),
        ("unknownissuer", "the certificate chain ends in a root certificate that is not trusted"),
        ("unknown issuer", "the certificate chain ends in a root certificate that is not trusted"),
        ("invalid peer certificate", "the server's certificate is not valid"),
        ("certificate verify failed", "the server's certificate could not be verified"),
        ("certificate is not trusted", "the server's certificate is not trusted"),
    ];
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = current {
        if let Some(code) = e.downcast_ref::<std::io::Error>().and_then(std::io::Error::raw_os_error) {
            if let Some((_, reason)) = WINDOWS.iter().find(|(c, _)| *c == code) {
                return Some(reason.to_string());
            }
        }
        let text = e.to_string().to_lowercase();
        // The same code as the operating system prints it. Needed because the
        // io::Error is not always reachable by downcast: hyper's connect error
        // keeps its cause behind a type of its own, and only the text of it
        // surfaces through `source()`.
        if let Some((_, reason)) = WINDOWS.iter().find(|(code, _)| text.contains(&format!("os error {code}"))) {
            return Some(reason.to_string());
        }
        if let Some((_, reason)) = WORDING.iter().find(|(needle, _)| text.contains(needle)) {
            return Some(reason.to_string());
        }
        current = e.source();
    }
    None
}

/// What is in force, for `jan cli net ca status` and the settings page.
pub fn status() -> serde_json::Value {
    match configured() {
        None => serde_json::json!({ "state": "none", "trusts": "the platform's roots only" }),
        Some(Ok(bundle)) => serde_json::json!({
            "state": "in_use",
            "path": bundle.path.display().to_string(),
            "source": bundle.source.tag(),
            "certificates": bundle.fingerprints.len(),
            "sha256": bundle.fingerprints,
            "trusts": "the platform's roots and these certificates",
        }),
        Some(Err(error)) => serde_json::json!({
            "state": "broken",
            "kind": error.kind.tag(),
            "path": error.path.display().to_string(),
            "message": error.message,
            "trusts": "nothing: outbound HTTPS fails until the bundle is fixed or removed",
        }),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A throwaway CA, server certificates signed by it and a junk bundle,
    /// written by the TLS fixture with the `cryptography` package already
    /// installed. A machine without Python or that package fails these tests
    /// loudly rather than skipping them.
    pub(crate) fn make_ca() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mock_tls_server.py");
        let python = ["python3", "python"]
            .into_iter()
            .find(|p| std::process::Command::new(p).arg("--version").output().is_ok_and(|o| o.status.success()))
            .expect("python is required for the TLS fixture");
        let made = std::process::Command::new(python).arg(&script).arg("--make-ca").arg(dir.path()).output().expect("run the TLS fixture");
        assert!(made.status.success(), "the TLS fixture could not make a CA: {}", String::from_utf8_lossy(&made.stderr));
        dir
    }

    pub(crate) struct Server {
        child: std::process::Child,
        pub port: u16,
        log: PathBuf,
    }

    impl Server {
        pub(crate) fn start(ca: &Path, mode: &str) -> Self {
            use std::io::BufRead;
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mock_tls_server.py");
            let python = ["python3", "python"]
                .into_iter()
                .find(|p| std::process::Command::new(p).arg("--version").output().is_ok_and(|o| o.status.success()))
                .expect("python is required for the TLS fixture");
            let log = ca.join(format!("{mode}-{}.log", std::process::id()));
            let mut child = std::process::Command::new(python)
                .arg(&script)
                .args(["--serve"])
                .arg(ca)
                .args(["--mode", mode, "--log"])
                .arg(&log)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("start the TLS fixture");
            let mut line = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
            let port = line.trim().trim_start_matches("PORT ").parse().expect("fixture port");
            Server { child, port, log }
        }

        pub(crate) fn requests(&self) -> usize {
            std::fs::read_to_string(&self.log).map(|t| t.lines().count()).unwrap_or(0)
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
    }

    #[test]
    fn a_bundle_that_cannot_be_used_is_refused_by_kind() {
        let ca = make_ca();
        let ok = load(&ca.path().join("ca.pem"), Source::Environment).unwrap();
        assert_eq!(ok.fingerprints.len(), 1);
        assert_eq!(ok.fingerprints[0].len(), 64);

        let kind = |path: &Path| load(path, Source::Environment).unwrap_err().kind;
        assert_eq!(kind(&ca.path().join("missing.pem")), CaErrorKind::NotFound);
        assert_eq!(kind(ca.path()), CaErrorKind::Unreadable, "a directory is not a bundle");
        assert_eq!(kind(&ca.path().join("junk.pem")), CaErrorKind::Malformed);
        let empty = ca.path().join("empty.pem");
        std::fs::write(&empty, "no certificates here\n").unwrap();
        assert_eq!(kind(&empty), CaErrorKind::NoCertificates);
        let key_only = ca.path().join("server.key");
        assert_eq!(kind(&key_only), CaErrorKind::NoCertificates, "a private key is not a CA");
        let huge = ca.path().join("huge.pem");
        std::fs::write(&huge, vec![b'a'; (MAX_BUNDLE_BYTES + 1) as usize]).unwrap();
        assert_eq!(kind(&huge), CaErrorKind::TooLarge);
        // One bad certificate refuses the whole bundle.
        let mixed = ca.path().join("mixed.pem");
        let good = std::fs::read_to_string(ca.path().join("ca.pem")).unwrap();
        let bad = std::fs::read_to_string(ca.path().join("junk.pem")).unwrap();
        std::fs::write(&mixed, format!("{good}{bad}")).unwrap();
        assert_eq!(kind(&mixed), CaErrorKind::Malformed);
        let e = load(&mixed, Source::Environment).unwrap_err();
        assert_eq!(HarnessError::from(&e).kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn the_desktop_setting_is_read_from_the_stored_proxy_settings() {
        let stored = r#"{"state":{"proxyEnabled":false,"caBundlePath":"C:\\certs\\corp.pem"},"version":0}"#;
        assert_eq!(desktop_setting(Some(stored.to_string())), Some(PathBuf::from(r"C:\certs\corp.pem")));
        assert_eq!(desktop_setting(Some(r#"{"state":{"caBundlePath":"  "},"version":0}"#.to_string())), None);
        assert_eq!(desktop_setting(Some("not json".to_string())), None);
        assert_eq!(desktop_setting(None), None);
    }

    async fn get12(bundle: Option<&Result<Bundle, CaError>>, url: &str) -> Result<String, reqwest::Error> {
        let client = with_bundle12(reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)), bundle).build().unwrap();
        Ok(client.get(url).send().await?.text().await.unwrap_or_default())
    }

    async fn get13(bundle: Option<&Result<Bundle, CaError>>, url: &str) -> Result<String, reqwest13::Error> {
        let client = with_bundle13(reqwest13::Client::builder().timeout(std::time::Duration::from_secs(10)), bundle).build().unwrap();
        Ok(client.get(url).send().await?.text().await.unwrap_or_default())
    }

    /// The classified reason, or a panic that shows the unclassified error. Never
    /// a fallback string: the raw error's own text contains words like "not
    /// trusted", so a fallback would let an unclassified failure pass a check
    /// meant for the classifier (found while fixing R13).
    fn reason(err: &(dyn std::error::Error + 'static)) -> String {
        certificate_failure(err).unwrap_or_else(|| panic!("not classified as a certificate failure: {err:?}"))
    }

    /// The five TLS proofs, on both HTTP stacks: (1) an untrusted server is
    /// refused by default, (2) the bundle makes it trusted, (3) a certificate
    /// for another host is refused even with the bundle, (4) a broken bundle
    /// trusts nothing, and (5) a TLS failure is never retried in plain HTTP.
    #[test]
    fn the_five_tls_proofs_hold_on_both_http_stacks() {
        let ca = make_ca();
        let good = Some(load(&ca.path().join("ca.pem"), Source::Environment));
        let broken = Some(load(&ca.path().join("junk.pem"), Source::Environment));
        assert!(broken.as_ref().unwrap().is_err());
        runtime().block_on(async {
            let valid = Server::start(ca.path(), "valid");
            let url = format!("https://127.0.0.1:{}/v1/models", valid.port);
            let localhost = format!("https://localhost:{}/v1/models", valid.port);
            // (1), and R13: the refusal says why.
            let untrusted12 = get12(None, &url).await.unwrap_err();
            let untrusted13 = get13(None, &url).await.unwrap_err();
            assert!(reason(&untrusted12).contains("not trusted"), "{}", reason(&untrusted12));
            assert!(reason(&untrusted13).contains("not trusted"), "{}", reason(&untrusted13));
            assert_eq!(valid.requests(), 0, "an untrusted server received a request");
            // (2)
            assert!(get12(good.as_ref(), &url).await.unwrap().contains("tls-model"));
            assert!(get13(good.as_ref(), &url).await.unwrap().contains("tls-model"));
            assert!(get13(good.as_ref(), &localhost).await.unwrap().contains("tls-model"));
            assert_eq!(valid.requests(), 3);
            // (4)
            let closed12 = get12(broken.as_ref(), &url).await.unwrap_err();
            let closed13 = get13(broken.as_ref(), &url).await.unwrap_err();
            assert!(certificate_failure(&closed12).is_some(), "a broken bundle's refusal was not read as a certificate failure: {closed12:?}");
            assert!(certificate_failure(&closed13).is_some(), "a broken bundle's refusal was not read as a certificate failure: {closed13:?}");
            assert_eq!(valid.requests(), 3, "a broken bundle let a request through");

            // (3)
            let other = Server::start(ca.path(), "wrong-host");
            let url = format!("https://127.0.0.1:{}/v1/models", other.port);
            let wrong12 = get12(good.as_ref(), &url).await.unwrap_err();
            let wrong13 = get13(good.as_ref(), &url).await.unwrap_err();
            assert!(reason(&wrong12).contains("host name"), "{}", reason(&wrong12));
            assert!(reason(&wrong13).contains("host name"), "{}", reason(&wrong13));
            assert_eq!(other.requests(), 0, "a certificate for another host was accepted");

            // (5)
            let plain = Server::start(ca.path(), "plain");
            let url = format!("https://127.0.0.1:{}/v1/models", plain.port);
            let plain12 = get12(good.as_ref(), &url).await.unwrap_err();
            let plain13 = get13(good.as_ref(), &url).await.unwrap_err();
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            assert_eq!(plain.requests(), 0, "a request was sent in plain HTTP after TLS failed");
            // Not a certificate failure: a protocol mismatch is reported as what it is.
            assert!(certificate_failure(&plain12).is_none(), "{plain12:?}");
            assert!(certificate_failure(&plain13).is_none(), "{plain13:?}");

            // Nor is a refused connection.
            let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = closed.local_addr().unwrap().port();
            drop(closed);
            let refused = get13(good.as_ref(), &format!("https://127.0.0.1:{port}/")).await.unwrap_err();
            assert!(certificate_failure(&refused).is_none(), "{refused:?}");
        });
    }

    /// Cancellation: a request abandoned during a stalled handshake leaves no
    /// connection behind -- the server sees its socket closed.
    #[test]
    fn an_abandoned_handshake_leaves_no_connection_open() {
        let ca = make_ca();
        let good = Some(load(&ca.path().join("ca.pem"), Source::Environment));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = std::thread::spawn(move || {
            use std::io::Read;
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(15))).unwrap();
            let mut buffer = [0u8; 4096];
            // Read the ClientHello, answer nothing, and wait for the close.
            let started = std::time::Instant::now();
            loop {
                match socket.read(&mut buffer) {
                    Ok(0) => return Some(started.elapsed()),
                    Ok(_) => continue,
                    Err(_) => return None,
                }
            }
        });
        runtime().block_on(async {
            let client = with_bundle13(reqwest13::Client::builder(), good.as_ref()).build().unwrap();
            let request = client.get(format!("https://127.0.0.1:{port}/v1/models")).send();
            let abandoned = tokio::time::timeout(std::time::Duration::from_millis(500), request).await;
            assert!(abandoned.is_err(), "the stalled handshake completed");
            drop(client);
        });
        let closed = accepted.join().unwrap();
        assert!(closed.is_some(), "the abandoned connection was never closed");
    }

    /// Security: where trust is decided is out of a project's and a run's
    /// reach. The bundle is read only from the environment, the user's own
    /// config and the desktop settings -- `configured_path` has no project
    /// input -- and a run that tries to write the user's config to name one is
    /// stopped at the permission gate even in a project that allows everything
    /// else by default.
    #[test]
    fn a_run_cannot_grant_itself_trust_in_a_certificate_authority() {
        use tauri_plugin_agent_tools::permissions::{PermissionDefault, ToolPermissions};
        use tauri_plugin_agent_tools::tools::gate::{resolve_decision, Decision, NetworkPolicy, PromptKind, SessionGrants};

        let project = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".jan").join("config.toml");
        let write = tauri_plugin_agent_tools::tools::lookup("write").expect("the write tool");
        let permissive = ToolPermissions::new(PermissionDefault::Allow, &[], &[], &[]);
        let args = serde_json::json!({ "path": config.to_string_lossy(), "content": "ca_bundle = \"/tmp/evil.pem\"
" });
        let decision = resolve_decision(
            write,
            &args,
            project.path(),
            None,
            &[],
            &permissive,
            &SessionGrants::default(),
            false,
            &NetworkPolicy::open(),
            &tauri_plugin_agent_tools::subject::Subject::MainAgent,
        );
        assert_eq!(decision, Decision::Prompt(PromptKind::WriteEscape), "a run could write the user's CA setting without asking");

        // A project that says otherwise is inert: nothing here reads it.
        std::fs::create_dir_all(project.path().join(".jan/agent")).unwrap();
        std::fs::write(project.path().join(".jan/agent/agent.toml"), "[network]
ca_bundle = \"/tmp/evil.pem\"
").unwrap();
        assert_eq!(desktop_setting(Some("{\"state\":{},\"version\":0}".to_string())), None);
    }
}
