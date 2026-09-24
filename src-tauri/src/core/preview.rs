//! `flintpreview:` URI scheme for HTML artifact previews (#135).
//!
//! Previews used to be rendered through `<iframe srcdoc>`. An `about:srcdoc`
//! document inherits the policy container -- and therefore the CSP -- of the
//! document that created it, and the app's own `script-src` carries no
//! `'unsafe-inline'` (Tauri also appends hashes to it, which would make
//! `'unsafe-inline'` ignored anyway). Every inline script in a preview,
//! including the injected element inspector, was blocked in release builds.
//!
//! Serving the document from its own scheme makes it a real navigation, so it
//! gets only the CSP sent with this response. The web side registers the
//! document under an unguessable id, points the sandboxed iframe at
//! `flintpreview://localhost/<id>` (`http://flintpreview.localhost/<id>` on
//! Windows) and releases the id when the preview closes or is replaced.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::http::{header, Response, StatusCode};

pub const PREVIEW_SCHEME: &str = "flintpreview";

/// Upper bound on documents kept at once, so a caller that never releases
/// (a crashed view, a missed cleanup) cannot grow the store without limit.
const MAX_ENTRIES: usize = 64;

struct Entry {
    html: String,
    csp: String,
    seq: u64,
}

#[derive(Default)]
pub struct PreviewStore {
    entries: HashMap<String, Entry>,
    next_seq: u64,
}

impl PreviewStore {
    pub fn insert(&mut self, html: String, allow_network: bool, allow_scripts: bool) -> String {
        if self.entries.len() >= MAX_ENTRIES {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.seq)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        // v4 UUID: 122 random bits, so another frame cannot guess a live id.
        let id = uuid::Uuid::new_v4().simple().to_string();
        self.next_seq += 1;
        self.entries.insert(
            id.clone(),
            Entry {
                html,
                csp: build_csp(allow_network, allow_scripts),
                seq: self.next_seq,
            },
        );
        id
    }

    pub fn remove(&mut self, id: &str) {
        self.entries.remove(id);
    }

    /// Build the response for a request path (`/<id>`).
    pub fn respond(&self, path: &str) -> Response<Vec<u8>> {
        let id = path
            .trim_start_matches('/')
            .split(['?', '#'])
            .next()
            .unwrap_or("");
        match self.entries.get(id) {
            Some(entry) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CONTENT_SECURITY_POLICY, entry.csp.as_str())
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .header(header::CACHE_CONTROL, "no-store")
                .header(header::REFERRER_POLICY, "no-referrer")
                .body(entry.html.clone().into_bytes())
                .unwrap_or_else(|_| not_found()),
            None => not_found(),
        }
    }
}

fn not_found() -> Response<Vec<u8>> {
    let mut res = Response::new(b"not found".to_vec());
    *res.status_mut() = StatusCode::NOT_FOUND;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    res
}

/// Mirror of `buildCsp` in `web-app/src/lib/htmlSandbox.ts`, plus a `sandbox`
/// directive so the document stays in an opaque origin even if it is ever
/// opened outside the sandboxed iframe. `connect-src` never lists `ipc:`, so
/// the preview cannot reach Tauri IPC.
pub fn build_csp(allow_network: bool, allow_scripts: bool) -> String {
    let directives: &[&str] = if !allow_scripts {
        &[
            "default-src 'none'",
            "img-src data: blob:",
            "style-src 'unsafe-inline'",
            "font-src data:",
            "connect-src 'none'",
            "sandbox",
        ]
    } else if allow_network {
        &[
            "default-src 'none'",
            "script-src 'unsafe-inline' https:",
            "style-src 'unsafe-inline' https:",
            "img-src data: blob: https:",
            "font-src data: https:",
            "connect-src https:",
            "sandbox allow-scripts",
        ]
    } else {
        &[
            "default-src 'none'",
            "script-src 'unsafe-inline'",
            "style-src 'unsafe-inline'",
            "img-src data: blob:",
            "font-src data:",
            "connect-src 'none'",
            "sandbox allow-scripts",
        ]
    };
    directives.join("; ")
}

static STORE: LazyLock<Mutex<PreviewStore>> =
    LazyLock::new(|| Mutex::new(PreviewStore::default()));

fn store() -> std::sync::MutexGuard<'static, PreviewStore> {
    STORE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Protocol handler registered on the Tauri builder.
pub fn handle(path: &str) -> Response<Vec<u8>> {
    store().respond(path)
}

/// Store a preview document; returns the id to load it by.
#[tauri::command]
pub fn preview_register(html: String, allow_network: bool, allow_scripts: bool) -> String {
    store().insert(html, allow_network, allow_scripts)
}

/// Drop a preview document once its view closes or is replaced.
#[tauri::command]
pub fn preview_release(id: String) {
    store().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(res: &'a Response<Vec<u8>>, name: header::HeaderName) -> &'a str {
        res.headers().get(name).unwrap().to_str().unwrap()
    }

    #[test]
    fn serves_document_with_its_own_csp_and_html_type() {
        let mut store = PreviewStore::default();
        let id = store.insert("<p>hi</p><script>1</script>".into(), false, true);
        let res = store.respond(&format!("/{id}"));
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(get(&res, header::CONTENT_TYPE), "text/html; charset=utf-8");
        let csp = get(&res, header::CONTENT_SECURITY_POLICY);
        assert!(csp.contains("script-src 'unsafe-inline'"));
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("sandbox allow-scripts"));
        assert!(!csp.contains("ipc:"));
        assert!(!csp.contains("allow-same-origin"));
        assert_eq!(res.body().as_slice(), b"<p>hi</p><script>1</script>");
    }

    #[test]
    fn static_mode_forbids_scripts() {
        let mut store = PreviewStore::default();
        let id = store.insert("<svg/>".into(), false, false);
        let res = store.respond(&format!("/{id}"));
        let csp = get(&res, header::CONTENT_SECURITY_POLICY);
        assert!(!csp.contains("script-src"));
        assert!(csp.starts_with("default-src 'none'"));
    }

    #[test]
    fn network_mode_allows_https_only() {
        let csp = build_csp(true, true);
        assert!(csp.contains("connect-src https:"));
        assert!(!csp.contains("http:"));
    }

    #[test]
    fn unknown_or_released_id_is_404() {
        let mut store = PreviewStore::default();
        assert_eq!(store.respond("/nope").status(), StatusCode::NOT_FOUND);
        let id = store.insert("x".into(), false, true);
        store.remove(&id);
        assert_eq!(
            store.respond(&format!("/{id}")).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn ids_are_unique_and_long() {
        let mut store = PreviewStore::default();
        let a = store.insert("a".into(), false, true);
        let b = store.insert("b".into(), false, true);
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn store_is_bounded() {
        let mut store = PreviewStore::default();
        let first = store.insert("0".into(), false, true);
        for i in 0..MAX_ENTRIES {
            store.insert(i.to_string(), false, true);
        }
        assert_eq!(store.entries.len(), MAX_ENTRIES);
        assert_eq!(
            store.respond(&format!("/{first}")).status(),
            StatusCode::NOT_FOUND
        );
    }
}
