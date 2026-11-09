//! Certificates for the remote listener: a user-supplied pair, a Tailscale
//! MagicDNS certificate, or a self-signed one for the home network. See
//! `config.rs` for which is used when.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rustls::ServerConfig;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use sha2::{Digest, Sha256};

use super::auth::write_private;

/// A certificate ready to serve, and what the UI shows about it.
pub struct LoadedTls {
    pub config: Arc<ServerConfig>,
    /// SHA-256 of the leaf certificate, `AB:CD:...`.
    pub fingerprint: String,
    /// The name the certificate is for, when it is a DNS name (Tailscale).
    pub hostname: Option<String>,
}

pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn server_config(
    certs: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<Arc<ServerConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("certificate and key do not match: {e}"))?;
    // HTTP/1.1 only: the server speaks nothing else, and WebSocket upgrades
    // need it.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// Loads a PEM certificate chain and private key.
pub fn load_pem(cert: &Path, key: &Path, hostname: Option<String>) -> Result<LoadedTls, String> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .map_err(|e| format!("cannot read certificate {}: {e}", cert.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("invalid certificate {}: {e}", cert.display()))?;
    let leaf = certs
        .first()
        .ok_or_else(|| format!("no certificate in {}", cert.display()))?;
    let fp = fingerprint(leaf.as_ref());
    let key = PrivateKeyDer::from_pem_file(key)
        .map_err(|e| format!("cannot read key {}: {e}", key.display()))?;
    Ok(LoadedTls {
        config: server_config(certs, key)?,
        fingerprint: fp,
        hostname,
    })
}

/// How long a self-signed certificate is issued for. Apple devices refuse a
/// TLS server certificate valid for more than 825 days, and a key that leaked
/// should stop working within about a year rather than never.
pub const SELF_SIGNED_VALIDITY_DAYS: i64 = 397;

/// A certificate this close to its end is replaced at the next start, so it
/// never expires under a running phone without warning.
pub const SELF_SIGNED_RENEW_BEFORE_DAYS: i64 = 30;

/// When the self-signed certificate in `dir` stops being used. Read from the
/// file written next to it; a certificate from before that file existed was
/// issued with rcgen's open-ended default and counts from when it was made.
pub fn self_signed_expiry(dir: &Path) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Some(at) = std::fs::read_to_string(dir.join("lan-cert.expires"))
        .ok()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t.trim()).ok())
    {
        return Some(at.with_timezone(&chrono::Utc));
    }
    let made: chrono::DateTime<chrono::Utc> = std::fs::metadata(dir.join("lan-cert.pem"))
        .and_then(|m| m.modified())
        .ok()?
        .into();
    Some(made + chrono::Duration::days(SELF_SIGNED_VALIDITY_DAYS))
}

/// `at` as the year, month and day `rcgen::date_time_ymd` takes. Always a real
/// calendar date, so that call cannot fail.
fn ymd(at: chrono::DateTime<chrono::Utc>) -> (i32, u8, u8) {
    use chrono::Datelike;
    (at.year(), at.month() as u8, at.day() as u8)
}

/// The self-signed certificate for `ip` (and `host`, the custom host name,
/// when set), made once and reused while both stay the same and it is not
/// near its end (so a phone that trusted it keeps trusting it).
///
/// Issued for [`SELF_SIGNED_VALIDITY_DAYS`] and replaced at the first start
/// within [`SELF_SIGNED_RENEW_BEFORE_DAYS`] of that. A phone sees the new
/// certificate the way it sees one made for a new address: the browser asks
/// it to trust a new certificate, whose fingerprint Settings > Remote access
/// shows. There is no way to serve the old and new one side by side on one
/// address, so that one re-trust a year is the cost of a key that expires.
pub fn self_signed(dir: &Path, ip: &str, host: Option<&str>) -> Result<LoadedTls, String> {
    self_signed_at(dir, ip, host, chrono::Utc::now())
}

pub fn self_signed_at(
    dir: &Path,
    ip: &str,
    host: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<LoadedTls, String> {
    let cert_path = dir.join("lan-cert.pem");
    let key_path = dir.join("lan-key.pem");
    let ip_path = dir.join("lan-cert.ip");
    let expires_path = dir.join("lan-cert.expires");
    let current = std::fs::read_to_string(&ip_path).ok();
    // Without a host name this is the bare address, as before, so existing
    // certificates stay in use.
    let subject = match host {
        Some(h) => format!("{ip} {h}"),
        None => ip.to_string(),
    };
    let renew_from = now + chrono::Duration::days(SELF_SIGNED_RENEW_BEFORE_DAYS);
    let ending = self_signed_expiry(dir).is_none_or(|at| at <= renew_from);
    if current.as_deref() != Some(subject.as_str())
        || !cert_path.exists()
        || !key_path.exists()
        || ending
    {
        let mut names = vec![ip.to_string(), "localhost".to_string()];
        names.extend(host.map(str::to_string));
        let mut params = rcgen::CertificateParams::new(names).map_err(|e| e.to_string())?;
        let not_after = now + chrono::Duration::days(SELF_SIGNED_VALIDITY_DAYS);
        // A day back, so a phone whose clock runs a little slow does not see
        // a certificate from the future.
        let (y, m, d) = ymd(now - chrono::Duration::days(1));
        params.not_before = rcgen::date_time_ymd(y, m, d);
        let (y, m, d) = ymd(not_after);
        params.not_after = rcgen::date_time_ymd(y, m, d);
        let key_pair = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
        let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;
        write_private(&cert_path, cert.pem().as_bytes()).map_err(|e| e.to_string())?;
        write_private(&key_path, key_pair.serialize_pem().as_bytes())
            .map_err(|e| e.to_string())?;
        write_private(&ip_path, subject.as_bytes()).map_err(|e| e.to_string())?;
        write_private(&expires_path, not_after.to_rfc3339().as_bytes())
            .map_err(|e| e.to_string())?;
        log::info!(
            "remote: generated a self-signed certificate for {subject}, valid until {}",
            not_after.format("%Y-%m-%d")
        );
    }
    load_pem(&cert_path, &key_path, None)
}

/// A Tailscale certificate is renewed when older than this; Let's Encrypt
/// issues them for 90 days.
const TAILSCALE_CERT_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

/// The MagicDNS name of this machine, without the trailing dot.
fn tailscale_dns_name() -> Option<String> {
    let mut cmd = super::config::tailscale_command();
    cmd.args(["status", "--json"]);
    let out = super::config::output_within(cmd, super::config::TAILSCALE_TIMEOUT)?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let name = v
        .get("Self")?
        .get("DNSName")?
        .as_str()?
        .trim_end_matches('.')
        .to_string();
    (!name.is_empty()).then_some(name)
}

/// Fetches (or reuses) a certificate with `tailscale cert`. Best effort: it
/// needs HTTPS enabled for the tailnet and, on some Linux setups, rights on
/// the tailscaled socket. Any failure means plain HTTP over WireGuard.
pub fn tailscale_cert(dir: &Path) -> Option<(PathBuf, PathBuf, String)> {
    let name = tailscale_dns_name()?;
    let cert = dir.join("tailscale.crt");
    let key = dir.join("tailscale.key");
    let fresh = std::fs::metadata(&cert)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < TAILSCALE_CERT_MAX_AGE);
    let name_path = dir.join("tailscale.name");
    let same_name = std::fs::read_to_string(&name_path).ok().as_deref() == Some(name.as_str());
    if !(fresh && same_name && key.exists()) {
        std::fs::create_dir_all(dir).ok()?;
        let mut cmd = super::config::tailscale_command();
        cmd.arg("cert")
            .arg("--cert-file")
            .arg(&cert)
            .arg("--key-file")
            .arg(&key)
            .arg(&name);
        // Issuing a certificate can take a while on first use.
        let status = super::config::output_within(cmd, std::time::Duration::from_secs(90))?;
        if !status.status.success() {
            log::info!(
                "remote: no Tailscale certificate ({}); serving HTTP over WireGuard",
                String::from_utf8_lossy(&status.stderr).trim()
            );
            return None;
        }
        let _ = write_private(&name_path, name.as_bytes());
    }
    Some((cert, key, name))
}
