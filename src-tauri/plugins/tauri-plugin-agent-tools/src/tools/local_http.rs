//! The `local_http` tool: a GET or HEAD to a server on this computer.
//!
//! The `bash` sandbox blocks loopback, so an agent that started a dev server
//! could not check that it answers, and `web_fetch` is for the internet. This
//! runs in the host process. It is deliberately narrow: plain `http`, only an
//! address that is loopback after the name is resolved, only GET and HEAD, no
//! redirects followed (the `Location` is reported instead), and a bounded
//! response. A hostname is resolved once and the connection goes to that
//! checked address, so a name cannot be pointed somewhere else between the
//! check and the connection.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const DEFAULT_BYTES: usize = 16 * 1024;
const MAX_BYTES: usize = 64 * 1024;
const TIMEOUT_SECS: u64 = 15;

#[derive(Debug, PartialEq)]
pub struct Request {
    pub head: bool,
    pub host: String,
    pub port: u16,
    pub target: String,
    pub max_bytes: usize,
}

/// Split `http://host[:port]/path?query` by hand: nothing here follows a scheme
/// other than plain http, and no credentials are accepted.
pub fn parse(args: &Value) -> Result<Request, String> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or("ERROR: local_http needs a 'url', such as http://localhost:5173/.")?;
    let head = match args.get("method").and_then(Value::as_str) {
        None => false,
        Some(m) if m.eq_ignore_ascii_case("get") => false,
        Some(m) if m.eq_ignore_ascii_case("head") => true,
        Some(_) => return Err("ERROR: local_http 'method' must be GET or HEAD.".into()),
    };
    let max_bytes = match args.get("max_bytes") {
        None | Some(Value::Null) => DEFAULT_BYTES,
        Some(v) => v
            .as_u64()
            .ok_or("ERROR: local_http 'max_bytes' must be a whole number.")?
            .clamp(256, MAX_BYTES as u64) as usize,
    };
    let rest = url
        .strip_prefix("http://")
        .ok_or("ERROR: local_http only takes http:// addresses on this computer.")?;
    let (authority, target) = match rest.find(['/', '?']) {
        Some(i) if rest.as_bytes()[i] == b'/' => (&rest[..i], rest[i..].to_string()),
        Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
        None => (rest, "/".to_string()),
    };
    if authority.is_empty() || authority.contains('@') {
        return Err("ERROR: local_http addresses carry no username or password.".into());
    }
    if target.chars().any(|c| c.is_control() || c == ' ') {
        return Err("ERROR: local_http addresses may not contain spaces or control characters.".into());
    }
    let bad_port = "ERROR: the port is not a number from 0 to 65535.";
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let (h, after) = inner.split_once(']').ok_or("ERROR: the address is malformed.")?;
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| bad_port)?,
            None if after.is_empty() => 80,
            None => return Err("ERROR: the address is malformed.".into()),
        };
        (h.to_string(), port)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        (h.to_string(), p.parse::<u16>().map_err(|_| bad_port)?)
    } else {
        (authority.to_string(), 80)
    };
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':')) {
        return Err("ERROR: the host name is malformed.".into());
    }
    Ok(Request { head, host, port, target, max_bytes })
}

/// The one address a request may use: every resolved address must be loopback.
fn loopback_only(addrs: &[SocketAddr]) -> Result<SocketAddr, String> {
    let first = addrs.first().ok_or("ERROR: that name did not resolve.")?;
    if addrs.iter().all(|a| ip_is_loopback(a.ip())) {
        Ok(*first)
    } else {
        Err("ERROR: local_http only reaches this computer (localhost, 127.0.0.1, [::1]). Use web_fetch for anything else.".into())
    }
}

fn ip_is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    }
}

/// Status line, the headers worth showing, then the body as text.
fn render(raw: &[u8], head: bool, truncated: bool) -> String {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n");
    let (header_bytes, body) = match split {
        Some(i) => (&raw[..i], &raw[i + 4..]),
        None => (raw, &raw[raw.len()..]),
    };
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.lines();
    let status = lines.next().unwrap_or("").to_string();
    let shown: Vec<&str> = lines
        .filter(|l| {
            let name = l.split(':').next().unwrap_or("").to_ascii_lowercase();
            matches!(name.as_str(), "content-type" | "content-length" | "location" | "server" | "www-authenticate")
        })
        .collect();
    let mut out = format!("{status}\n{}", shown.join("\n"));
    if !head {
        let text = String::from_utf8_lossy(body);
        out.push_str("\n\n");
        out.push_str(&crate::secrets::redact_secrets(&text));
        if truncated {
            out.push_str("\n[body cut; raise max_bytes (up to 65536)]");
        }
    }
    out
}

pub async fn local_http(args: &Value) -> String {
    let req = match parse(args) {
        Ok(req) => req,
        Err(message) => return message,
    };
    let resolved: Vec<SocketAddr> = match tokio::net::lookup_host((req.host.as_str(), req.port)).await {
        Ok(addrs) => addrs.collect(),
        Err(e) => return format!("ERROR: could not resolve {}: {e}", req.host),
    };
    let addr = match loopback_only(&resolved) {
        Ok(addr) => addr,
        Err(message) => return message,
    };
    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect(addr)
            .await
            .map_err(|e| format!("ERROR: could not connect to {addr}: {e}"))?;
        let method = if req.head { "HEAD" } else { "GET" };
        // HTTP/1.0 with a closed connection: the body is not chunked.
        let request = format!(
            "{method} {} HTTP/1.0\r\nHost: {}:{}\r\nUser-Agent: Flint\r\nAccept: */*\r\nConnection: close\r\n\r\n",
            req.target, req.host, req.port
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| format!("ERROR: could not send the request: {e}"))?;
        let mut raw = Vec::new();
        let limit = req.max_bytes + 8 * 1024;
        let mut chunk = [0u8; 8192];
        let mut truncated = false;
        loop {
            let n = stream
                .read(&mut chunk)
                .await
                .map_err(|e| format!("ERROR: the connection failed: {e}"))?;
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..n]);
            if raw.len() > limit {
                raw.truncate(limit);
                truncated = true;
                break;
            }
        }
        Ok::<_, String>((raw, truncated))
    };
    match tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), exchange).await {
        Err(_) => format!("ERROR: {} did not answer within {TIMEOUT_SECS} seconds.", req.host),
        Ok(Err(message)) => message,
        Ok(Ok((raw, truncated))) => render(&raw, req.head, truncated),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_host_port_and_path() {
        let r = parse(&json!({ "url": "http://localhost:5173/api/x?y=1" })).unwrap();
        assert_eq!((r.host.as_str(), r.port, r.target.as_str(), r.head), ("localhost", 5173, "/api/x?y=1", false));
        let r = parse(&json!({ "url": "http://127.0.0.1", "method": "head" })).unwrap();
        assert_eq!((r.port, r.target.as_str(), r.head), (80, "/", true));
        let r = parse(&json!({ "url": "http://[::1]:8080?q=1" })).unwrap();
        assert_eq!((r.host.as_str(), r.port, r.target.as_str()), ("::1", 8080, "/?q=1"));
    }

    #[test]
    fn refuses_other_schemes_methods_and_credentials() {
        for url in [
            "https://localhost/",
            "ftp://localhost/",
            "localhost",
            "http://user:pw@localhost/",
            "http://",
            "http://local host/",
            "http://localhost:99999/",
            "http://localhost/a b",
        ] {
            assert!(parse(&json!({ "url": url })).is_err(), "{url}");
        }
        assert!(parse(&json!({ "url": "http://localhost/", "method": "POST" })).is_err());
    }

    #[test]
    fn only_loopback_addresses_are_reachable() {
        let lo: SocketAddr = "127.0.0.1:80".parse().unwrap();
        let lo6: SocketAddr = "[::1]:80".parse().unwrap();
        let lan: SocketAddr = "192.168.1.1:80".parse().unwrap();
        let meta: SocketAddr = "169.254.169.254:80".parse().unwrap();
        assert!(loopback_only(&[lo, lo6]).is_ok());
        assert!(loopback_only(&[lan]).is_err());
        assert!(loopback_only(&[meta]).is_err());
        assert!(loopback_only(&[lo, lan]).is_err());
        assert!(loopback_only(&[]).is_err());
    }

    #[test]
    fn renders_status_chosen_headers_and_a_redacted_body() {
        let raw = b"HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=b\r\nServer: x\r\n\r\nhello";
        let out = render(raw, false, false);
        assert!(out.starts_with("HTTP/1.0 200 OK\nContent-Type: text/plain\nServer: x"));
        assert!(!out.contains("Set-Cookie"));
        assert!(out.ends_with("hello"));
        assert!(!render(raw, true, false).contains("hello"));
    }

    #[tokio::test]
    async fn answers_from_a_server_on_this_computer() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            s.write_all(b"HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\npong").await.unwrap();
        });
        let out = local_http(&json!({ "url": format!("http://127.0.0.1:{port}/ping") })).await;
        assert!(out.contains("200 OK") && out.ends_with("pong"), "{out}");
    }

    #[tokio::test]
    async fn refuses_a_lan_address_before_connecting() {
        let out = local_http(&json!({ "url": "http://192.168.1.1/" })).await;
        assert!(out.contains("only reaches this computer"), "{out}");
    }
}
