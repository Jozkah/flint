//! Remote-access settings and the choice of address and transport.
//!
//! The listener binds one concrete address, never `0.0.0.0`: "reachable
//! through Tailscale" must mean exactly that, not "and every other network the
//! computer happens to be on".
//!
//! Transport, in order of preference:
//! - A certificate the user points at (cert + key paths) -> HTTPS.
//! - Tailscale with a MagicDNS certificate (`tailscale cert`) -> HTTPS.
//! - Tailscale without one -> plain HTTP. WireGuard already encrypts and
//!   authenticates every packet between tailnet devices, so the bearer token
//!   never crosses a network in the clear.
//! - This computer only -> plain HTTP; loopback never leaves the machine.
//! - Home Wi-Fi -> always HTTPS, with a self-signed certificate made on first
//!   use. Plain HTTP on a shared LAN would hand the token to anyone on it. The
//!   certificate's SHA-256 fingerprint is shown so it can be checked (pinned)
//!   when the phone first trusts it.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 1340;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Interface {
    #[default]
    Tailscale,
    Lan,
    Localhost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteConfig {
    /// Off unless the user turns it on.
    pub enabled: bool,
    pub interface: Interface,
    pub port: u16,
    pub cert_path: Option<String>,
    pub key_path: Option<String>,
    /// Phones may answer tool-approval prompts.
    pub allow_approvals: bool,
    /// Phones may grant "Always allow". Off by default: a standing grant from
    /// a device in someone's pocket is the broadest thing a phone could do.
    pub allow_always_allow: bool,
    /// Largest file a phone may upload as an attachment, in MiB.
    pub max_upload_mb: u32,
    /// The Cowork session's live preview (a localhost dev server) may be
    /// proxied to paired phones.
    pub allow_preview_proxy: bool,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interface: Interface::Tailscale,
            port: DEFAULT_PORT,
            cert_path: None,
            key_path: None,
            allow_approvals: true,
            allow_always_allow: false,
            max_upload_mb: 25,
            allow_preview_proxy: true,
        }
    }
}

impl RemoteConfig {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        super::auth::write_private_json(path, self)
    }

    /// Rejects what the listener could not honour. Ports below 1024 need
    /// privileges on Unix and are never what the user meant here.
    pub fn validate(&self) -> Result<(), String> {
        if self.port < 1024 {
            return Err("Port must be between 1024 and 65535".into());
        }
        if !(1..=200).contains(&self.max_upload_mb) {
            return Err("The upload limit must be between 1 and 200 MB".into());
        }
        match (&self.cert_path, &self.key_path) {
            (Some(c), Some(k)) if !c.trim().is_empty() && !k.trim().is_empty() => Ok(()),
            (None, None) => Ok(()),
            _ => Err("Set both the certificate and the key, or neither".into()),
        }
    }

    pub fn custom_cert(&self) -> Option<(PathBuf, PathBuf)> {
        match (&self.cert_path, &self.key_path) {
            (Some(c), Some(k)) if !c.trim().is_empty() && !k.trim().is_empty() => {
                Some((PathBuf::from(c), PathBuf::from(k)))
            }
            _ => None,
        }
    }
}

/// Tailscale hands out addresses from the CGNAT range 100.64.0.0/10.
pub fn is_tailscale_ip(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0b1100_0000) == 64
}

/// RFC 1918 private ranges: what a home router hands out.
pub fn is_private_lan_ip(ip: Ipv4Addr) -> bool {
    ip.is_private() && !is_tailscale_ip(ip)
}

/// The local address the OS would use to reach `target`. `connect` on a UDP
/// socket only picks a route; nothing is sent.
fn route_source(target: Ipv4Addr) -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    sock.connect((target, 53)).ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) => Some(v4),
        IpAddr::V6(_) => None,
    }
}

/// This machine's Tailscale IPv4. 100.100.100.100 is Tailscale's own resolver
/// and only routes through the tailnet interface, so the source address the
/// OS picks for it is the tailnet address. Falls back to `tailscale ip -4`.
pub fn detect_tailscale_ip() -> Option<Ipv4Addr> {
    if let Some(ip) =
        route_source(Ipv4Addr::new(100, 100, 100, 100)).filter(|ip| is_tailscale_ip(*ip))
    {
        return Some(ip);
    }
    let out = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<Ipv4Addr>().ok())
        .find(|ip| is_tailscale_ip(*ip))
}

/// The primary private LAN address: the source of the default route, when
/// that is a private address (not a public IP, not the tailnet).
pub fn detect_lan_ip() -> Option<Ipv4Addr> {
    route_source(Ipv4Addr::new(192, 0, 2, 1)) // TEST-NET-1: routed by default, never answered
        .filter(|ip| is_private_lan_ip(*ip))
}

/// Picks the bind address for `iface` from what was detected. Pure, so the
/// rules are tested without a network: a detected address outside the
/// interface's range is refused rather than bound.
pub fn select_bind_ip(
    iface: Interface,
    tailscale: Option<Ipv4Addr>,
    lan: Option<Ipv4Addr>,
) -> Result<Ipv4Addr, String> {
    match iface {
        Interface::Localhost => Ok(Ipv4Addr::LOCALHOST),
        Interface::Tailscale => tailscale
            .filter(|ip| is_tailscale_ip(*ip))
            .ok_or_else(|| "Tailscale is not running on this computer".to_string()),
        Interface::Lan => lan
            .filter(|ip| is_private_lan_ip(*ip))
            .ok_or_else(|| "No home network address found".to_string()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TlsSource {
    Custom,
    Tailscale,
    SelfSigned,
    /// Plain HTTP: only ever chosen for Tailscale or loopback.
    None,
}

/// The transport rules from the module comment, as a function.
pub fn plan_tls(iface: Interface, has_custom: bool, has_tailscale_cert: bool) -> TlsSource {
    if has_custom {
        return TlsSource::Custom;
    }
    match iface {
        Interface::Tailscale if has_tailscale_cert => TlsSource::Tailscale,
        Interface::Tailscale | Interface::Localhost => TlsSource::None,
        Interface::Lan => TlsSource::SelfSigned,
    }
}
