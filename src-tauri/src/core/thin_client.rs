//! The phone app's link to a desktop: a loopback HTTP proxy in front of the
//! desktop's remote-access listener, over TLS pinned to that desktop's
//! certificate.
//!
//! The listener serves a self-signed certificate, which a webview refuses and
//! cannot be told to trust. The phone client (`web-app/src/mobile`) is plain
//! `fetch` and `WebSocket` against a base URL, so the app points it at this
//! proxy instead. The proxy speaks TLS to the desktop itself and accepts
//! exactly one certificate: the one it saw on first connect (trust on first
//! use, the same check the pairing screen asks a person to do by eye with the
//! fingerprint). A different certificate later is an error, not a prompt.
//!
//! Only the loopback interface is bound, and the listener still requires the
//! phone's token, so another app on the phone gains nothing from the port.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use http_body_util::{combinators::BoxBody, BodyExt, Empty};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderValue, HOST, ORIGIN};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

type Body = BoxBody<Bytes, hyper::Error>;

/// Origins the app's own webview page is served from.
const APP_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

#[derive(Debug, Clone)]
struct Target {
    host: String,
    port: u16,
    /// SHA-256 of the desktop's leaf certificate.
    pin: [u8; 32],
}

#[derive(Default)]
struct State {
    port: Option<u16>,
    target: Option<Arc<Target>>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

fn fingerprint(digest: &[u8]) -> String {
    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Accepts one certificate, or any certificate while learning one.
#[derive(Debug)]
struct PinVerifier {
    expected: Option<[u8; 32]>,
    seen: Mutex<Option<[u8; 32]>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let digest: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        *self.seen.lock().unwrap_or_else(|e| e.into_inner()) = Some(digest);
        match self.expected {
            Some(expected) if expected != digest => Err(rustls::Error::General(
                "the desktop's certificate is not the one this phone pinned".into(),
            )),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Opens a TLS connection to the desktop. Returns the stream and the digest of
/// the certificate it presented.
async fn connect_tls(
    host: &str,
    port: u16,
    expected: Option<[u8; 32]>,
) -> Result<(tokio_rustls::client::TlsStream<TcpStream>, [u8; 32]), String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(PinVerifier {
        expected,
        seen: Mutex::new(None),
        provider: provider.clone(),
    });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("could not reach {host}:{port}: {e}"))?;
    let _ = tcp.set_nodelay(true);
    let name = ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
    let tls = TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|e| format!("TLS to {host}:{port} failed: {e}"))?;
    let seen = verifier
        .seen
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ok_or_else(|| "the desktop presented no certificate".to_string())?;
    Ok((tls, seen))
}

fn bad_gateway(message: &str) -> Response<Body> {
    let mut res = Response::new(
        http_body_util::Full::new(Bytes::from(message.to_string()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *res.status_mut() = StatusCode::BAD_GATEWAY;
    res
}

fn allowed_origin(req: &Request<Incoming>) -> Option<HeaderValue> {
    let origin = req.headers().get(ORIGIN)?;
    let text = origin.to_str().ok()?;
    APP_ORIGINS.contains(&text).then(|| origin.clone())
}

fn with_cors(mut res: Response<Body>, origin: Option<HeaderValue>) -> Response<Body> {
    if let Some(origin) = origin {
        let h = res.headers_mut();
        h.insert("access-control-allow-origin", origin);
        h.insert("vary", HeaderValue::from_static("origin"));
    }
    res
}

async fn handle(
    mut req: Request<Incoming>,
    target: Option<Arc<Target>>,
) -> Result<Response<Body>, hyper::Error> {
    let origin = allowed_origin(&req);

    if req.method() == Method::OPTIONS {
        let mut res = Response::new(Empty::<Bytes>::new().map_err(|never| match never {}).boxed());
        *res.status_mut() = StatusCode::NO_CONTENT;
        let h = res.headers_mut();
        h.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        h.insert(
            "access-control-allow-headers",
            HeaderValue::from_static("authorization, content-type, x-flint-request"),
        );
        h.insert("access-control-max-age", HeaderValue::from_static("600"));
        return Ok(with_cors(res, origin));
    }

    let Some(target) = target else {
        return Ok(with_cors(bad_gateway("no desktop is connected"), origin));
    };

    let (stream, seen) = match connect_tls(&target.host, target.port, Some(target.pin)).await {
        Ok(ok) => ok,
        Err(e) => return Ok(with_cors(bad_gateway(&e), origin)),
    };
    debug_assert_eq!(seen, target.pin);

    let (mut sender, conn) = match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    {
        Ok(ok) => ok,
        Err(e) => return Ok(with_cors(bad_gateway(&e.to_string()), origin)),
    };
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });

    // The listener takes no `Origin` from a native client other than its own,
    // and the Host header must name it.
    let want_upgrade = req.headers().contains_key(hyper::header::UPGRADE);
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let host_header = format!("{}:{}", target.host, target.port);
    let incoming_upgrade = want_upgrade.then(|| hyper::upgrade::on(&mut req));
    let (mut parts, body) = req.into_parts();
    parts.uri = match path.parse() {
        Ok(uri) => uri,
        Err(_) => return Ok(with_cors(bad_gateway("bad request path"), origin)),
    };
    parts.headers.remove(ORIGIN);
    if let Ok(value) = HeaderValue::from_str(&host_header) {
        parts.headers.insert(HOST, value);
    }
    let outgoing = Request::from_parts(parts, body);

    let mut res = match sender.send_request(outgoing).await {
        Ok(res) => res,
        Err(e) => return Ok(with_cors(bad_gateway(&e.to_string()), origin)),
    };

    if res.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(incoming_upgrade) = incoming_upgrade {
            let outgoing_upgrade = hyper::upgrade::on(&mut res);
            tokio::spawn(async move {
                if let (Ok(a), Ok(b)) = (incoming_upgrade.await, outgoing_upgrade.await) {
                    let (mut a, mut b) = (TokioIo::new(a), TokioIo::new(b));
                    let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
                }
            });
        }
    }

    let (parts, body) = res.into_parts();
    Ok(with_cors(Response::from_parts(parts, body.boxed()), origin))
}

/// Binds the loopback proxy once and returns its port.
async fn ensure_proxy() -> Result<u16, String> {
    if let Some(port) = state().lock().unwrap_or_else(|e| e.into_inner()).port {
        return Ok(port);
    }
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    state().lock().unwrap_or_else(|e| e.into_inner()).port = Some(port);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                continue;
            };
            tokio::spawn(async move {
                let svc = service_fn(|req| {
                    let target = state().lock().unwrap_or_else(|e| e.into_inner()).target.clone();
                    handle(req, target)
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tcp), svc)
                    .with_upgrades()
                    .await;
            });
        }
    });
    Ok(port)
}

// ---- pins, persisted per `host:port` -------------------------------------

#[derive(Default, Serialize, Deserialize)]
struct Pins(BTreeMap<String, String>);

fn pins_path(dir: &std::path::Path) -> PathBuf {
    dir.join("thin_client_pins.json")
}

fn load_pins(dir: &std::path::Path) -> Pins {
    std::fs::read(pins_path(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_pins(dir: &std::path::Path, pins: &Pins) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(pins).map_err(|e| e.to_string())?;
    std::fs::write(pins_path(dir), bytes).map_err(|e| e.to_string())
}

fn digest_from_hex(text: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(text).ok()?;
    bytes.try_into().ok()
}

/// `https://host:port[/...]` or a bare `host:port`, from the desktop's address
/// or its pairing link.
fn parse_desktop(input: &str) -> Result<(String, u16), String> {
    let trimmed = input.trim();
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let authority = rest.split(['/', '#', '?']).next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => {
            let port = p.parse::<u16>().map_err(|_| format!("bad port in {input}"))?;
            (h.trim_matches(['[', ']']).to_string(), port)
        }
        _ => (authority.trim_matches(['[', ']']).to_string(), 443),
    };
    if host.is_empty() {
        return Err("no host in the desktop address".into());
    }
    Ok((host, port))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    /// Base URL the phone client uses in place of the page's own origin.
    pub base: String,
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    /// True when this call learned the certificate (nothing was pinned yet).
    pub first_use: bool,
}

/// Points the proxy at a desktop, learning its certificate on first use.
pub async fn connect(data_dir: PathBuf, url: &str) -> Result<Connected, String> {
    let (host, port) = parse_desktop(url)?;
    let key = format!("{host}:{port}");
    let mut pins = load_pins(&data_dir);
    let known = pins.0.get(&key).and_then(|h| digest_from_hex(h));
    let (_stream, seen) = connect_tls(&host, port, known).await?;
    let first_use = known.is_none();
    if first_use {
        pins.0.insert(key, hex::encode(seen));
        save_pins(&data_dir, &pins)?;
    }
    let target = Arc::new(Target {
        host: host.clone(),
        port,
        pin: seen,
    });
    let proxy_port = ensure_proxy().await?;
    state().lock().unwrap_or_else(|e| e.into_inner()).target = Some(target);
    Ok(Connected {
        base: format!("http://127.0.0.1:{proxy_port}"),
        host,
        port,
        fingerprint: fingerprint(&seen),
        first_use,
    })
}

/// Drops the pin for a desktop whose certificate was replaced on purpose.
pub fn forget(data_dir: PathBuf, url: &str) -> Result<(), String> {
    let (host, port) = parse_desktop(url)?;
    let mut pins = load_pins(&data_dir);
    pins.0.remove(&format!("{host}:{port}"));
    save_pins(&data_dir, &pins)
}

#[tauri::command]
pub async fn thin_client_connect(app: tauri::AppHandle, url: String) -> Result<Connected, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    connect(dir, &url).await
}

#[tauri::command]
pub async fn thin_client_forget(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    forget(dir, &url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_addresses_and_pairing_links() {
        assert_eq!(
            parse_desktop("https://192.168.1.20:1340/m/#pair=abc&name=PC").unwrap(),
            ("192.168.1.20".into(), 1340)
        );
        assert_eq!(parse_desktop("pc.tail.ts.net:8443").unwrap(), ("pc.tail.ts.net".into(), 8443));
        assert_eq!(parse_desktop("https://pc.local").unwrap(), ("pc.local".into(), 443));
        assert_eq!(parse_desktop("https://[fd00::1]:1340/m/").unwrap(), ("fd00::1".into(), 1340));
        assert!(parse_desktop("https://:1340").is_err());
        assert!(parse_desktop("host:notaport").is_err());
    }

    #[test]
    fn fingerprint_matches_the_desktops_format() {
        assert_eq!(fingerprint(&[0xab, 0x01, 0xff]), "AB:01:FF");
    }
}
