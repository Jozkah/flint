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

/// The self-signed certificate for `ip`, made once and reused while the
/// address stays the same (so a phone that trusted it keeps trusting it).
pub fn self_signed(dir: &Path, ip: &str) -> Result<LoadedTls, String> {
    let cert_path = dir.join("lan-cert.pem");
    let key_path = dir.join("lan-key.pem");
    let ip_path = dir.join("lan-cert.ip");
    let current = std::fs::read_to_string(&ip_path).ok();
    if current.as_deref() != Some(ip) || !cert_path.exists() || !key_path.exists() {
        let names = vec![ip.to_string(), "localhost".to_string()];
        let generated = rcgen::generate_simple_self_signed(names).map_err(|e| e.to_string())?;
        write_private(&cert_path, generated.cert.pem().as_bytes()).map_err(|e| e.to_string())?;
        write_private(&key_path, generated.key_pair.serialize_pem().as_bytes())
            .map_err(|e| e.to_string())?;
        write_private(&ip_path, ip.as_bytes()).map_err(|e| e.to_string())?;
        log::info!("remote: generated a self-signed certificate for {ip}");
    }
    load_pem(&cert_path, &key_path, None)
}

/// A Tailscale certificate is renewed when older than this; Let's Encrypt
/// issues them for 90 days.
const TAILSCALE_CERT_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

/// The MagicDNS name of this machine, without the trailing dot.
fn tailscale_dns_name() -> Option<String> {
    let out = super::config::tailscale_command()
        .args(["status", "--json"])
        .output()
        .ok()?;
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
        let status = super::config::tailscale_command()
            .arg("cert")
            .arg("--cert-file")
            .arg(&cert)
            .arg("--key-file")
            .arg(&key)
            .arg(&name)
            .output()
            .ok()?;
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
