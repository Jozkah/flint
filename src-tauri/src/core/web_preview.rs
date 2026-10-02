//! Native web preview: a child webview laid over the preview rail.
//!
//! The rail used to render remote pages in an `<iframe>`, which cannot show
//! sites that send `X-Frame-Options` or `frame-ancestors` (github.com and most
//! large sites). A child webview is a top-level browsing context, so those
//! headers do not apply. The web side measures the rail's content box and
//! drives the view through the commands below.
//!
//! Isolation:
//! - label prefix `web-preview-`; capabilities are scoped to the `main`
//!   webview label, so no capability matches the preview and remote pages get
//!   no Tauri commands (app commands are ACL-checked for remote origins too);
//! - its own WebView2/WebKit data directory, so it never sees Flint's storage;
//! - navigation is limited to http(s); `file:`, custom schemes, their
//!   `*.localhost` aliases on Windows and the app's own dev origin are blocked.

use serde::{Deserialize, Serialize};
use url::Url;

/// Label prefix for every preview child webview.
pub const LABEL_PREFIX: &str = "web-preview-";
/// Event emitted to the main webview on page loads and title changes.
pub const EVENT_NAVIGATED: &str = "web-preview://navigated";

/// Hosts that Tauri/wry use to serve custom schemes on Windows/Android
/// (`<scheme>://localhost` becomes `http://<scheme>.localhost`).
const RESERVED_LOCALHOST_SCHEMES: &[&str] = &["tauri", "ipc", "asset", "flintpreview", "customprotocol"];

/// Whether `url` may be loaded in a preview webview. `app_origin` is the app's
/// own dev origin (devUrl), which Tauri treats as local and would therefore
/// grant app commands to; it is never allowed.
pub fn is_allowed_preview_url(url: &Url, app_origin: Option<&Url>) -> bool {
    match url.scheme() {
        "http" | "https" => {}
        // Blank pages happen transiently while a view is created.
        "about" => return url.as_str() == "about:blank",
        _ => return false,
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    if let Some(sub) = host.strip_suffix(".localhost") {
        if RESERVED_LOCALHOST_SCHEMES.contains(&sub) {
            return false;
        }
    }
    if let Some(app) = app_origin {
        if app.scheme() == url.scheme()
            && app.host_str().map(|h| h.eq_ignore_ascii_case(&host)) == Some(true)
            && app.port_or_known_default() == url.port_or_known_default()
        {
            return false;
        }
    }
    true
}

/// Parse and validate a URL coming from the web side.
pub fn parse_preview_url(raw: &str, app_origin: Option<&Url>) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("invalid url: {e}"))?;
    if url.scheme() == "about" || !is_allowed_preview_url(&url, app_origin) {
        return Err(format!("url not allowed in preview: {raw}"));
    }
    Ok(url)
}

/// Preview ids come from the web side; keep them to a safe label alphabet.
pub fn label_for(id: &str) -> Result<String, String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid preview id".into());
    }
    Ok(format!("{LABEL_PREFIX}{id}"))
}

/// Physical-pixel rectangle relative to the window's client area.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct NavigatedPayload {
    pub id: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub loading: Option<bool>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
    use super::*;
    use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
    use tauri::{
        AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, PhysicalPosition,
        PhysicalSize, Rect, Runtime, Webview, WebviewUrl,
    };

    fn app_origin<R: Runtime>(app: &AppHandle<R>) -> Option<Url> {
        app.config().build.dev_url.clone()
    }

    fn get<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Webview<R>, String> {
        let label = label_for(id)?;
        app.get_webview(&label)
            .ok_or_else(|| format!("no preview webview {id}"))
    }

    fn rect(b: PreviewBounds) -> Rect {
        Rect {
            position: PhysicalPosition::new(b.x.round() as i32, b.y.round() as i32).into(),
            size: PhysicalSize::new(b.width.max(1.0).round() as u32, b.height.max(1.0).round() as u32)
                .into(),
        }
    }

    fn emit<R: Runtime>(app: &AppHandle<R>, payload: NavigatedPayload) {
        let _ = app.emit_to(EventTarget::webview("main"), EVENT_NAVIGATED, payload);
    }

    #[tauri::command]
    pub async fn web_preview_create<R: Runtime>(
        app: AppHandle<R>,
        id: String,
        url: String,
        bounds: PreviewBounds,
    ) -> Result<(), String> {
        let label = label_for(&id)?;
        let origin = app_origin(&app);
        let target = parse_preview_url(&url, origin.as_ref())?;
        if let Some(existing) = app.get_webview(&label) {
            let reused = existing
                .navigate(target.clone())
                .and_then(|_| existing.set_bounds(rect(bounds)))
                .and_then(|_| existing.show());
            match reused {
                Ok(()) => return Ok(()),
                // A view left over from a preview that was closing: drop it
                // and build a fresh one rather than failing the open.
                Err(e) => {
                    log::warn!("web preview: replacing stale view {label}: {e}");
                    let _ = existing.close();
                }
            }
        }
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("web-preview-profile");

        let nav_origin = origin.clone();
        let nav_label = label.clone();
        let nav_app = app.clone();
        let load_label = label.clone();
        let load_app = app.clone();
        let load_id = id.clone();
        let title_app = app.clone();
        let title_id = id.clone();
        let popup_app = app.clone();
        let popup_label = label.clone();
        let popup_origin = origin.clone();

        let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
            .data_directory(data_dir)
            .on_navigation(move |u| {
                let mut ok = is_allowed_preview_url(u, nav_origin.as_ref());
                if !ok {
                    log::warn!("web preview blocked navigation to {u}");
                } else if !crate::core::browser_agent::navigation_permitted(&nav_label, u) {
                    // The agent holds the pane and the policy stops this hop.
                    // This callback runs on the webview's thread: it only
                    // queues the notice and never waits.
                    crate::core::browser_agent::report_block(&nav_app, u);
                    ok = false;
                }
                ok
            })
            .on_page_load(move |_wv, payload| {
                crate::core::browser_agent::on_page_load(
                    &load_label,
                    matches!(payload.event(), PageLoadEvent::Started),
                );
                emit(
                    &load_app,
                    NavigatedPayload {
                        id: load_id.clone(),
                        url: Some(payload.url().to_string()),
                        title: None,
                        loading: Some(matches!(payload.event(), PageLoadEvent::Started)),
                    },
                );
            })
            .on_document_title_changed(move |_wv, title| {
                emit(
                    &title_app,
                    NavigatedPayload {
                        id: title_id.clone(),
                        url: None,
                        title: Some(title),
                        loading: None,
                    },
                );
            })
            // Popups (target=_blank, window.open) load in the same view
            // instead of spawning unmanaged windows.
            .on_new_window(move |u, _features| {
                if is_allowed_preview_url(&u, popup_origin.as_ref()) {
                    if let Some(wv) = popup_app.get_webview(&popup_label) {
                        let _ = wv.navigate(u);
                    }
                }
                NewWindowResponse::Deny
            });

        // Placeholder geometry; set_bounds below applies the physical rect.
        let wv = window
            .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
            .map_err(|e| e.to_string())?;
        wv.set_bounds(rect(bounds)).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub async fn web_preview_navigate<R: Runtime>(
        app: AppHandle<R>,
        id: String,
        url: String,
    ) -> Result<(), String> {
        let target = parse_preview_url(&url, app_origin(&app).as_ref())?;
        get(&app, &id)?.navigate(target).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn web_preview_back<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
        get(&app, &id)?.eval("history.back()").map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn web_preview_forward<R: Runtime>(
        app: AppHandle<R>,
        id: String,
    ) -> Result<(), String> {
        get(&app, &id)?.eval("history.forward()").map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn web_preview_reload<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
        get(&app, &id)?.reload().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn web_preview_set_bounds<R: Runtime>(
        app: AppHandle<R>,
        id: String,
        bounds: PreviewBounds,
    ) -> Result<(), String> {
        get(&app, &id)?.set_bounds(rect(bounds)).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn web_preview_show<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
        get(&app, &id)?.show().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn web_preview_hide<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
        get(&app, &id)?.hide().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn web_preview_close<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
        match get(&app, &id) {
            Ok(wv) => wv.close().map_err(|e| e.to_string()),
            Err(_) => Ok(()),
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use desktop::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_http_and_https() {
        assert!(is_allowed_preview_url(&u("https://github.com/"), None));
        assert!(is_allowed_preview_url(&u("http://localhost:3000/"), None));
        assert!(is_allowed_preview_url(&u("about:blank"), None));
    }

    #[test]
    fn blocks_file_and_custom_schemes() {
        for s in [
            "file:///C:/Windows/win.ini",
            "tauri://localhost/",
            "asset://localhost/x",
            "flintpreview://localhost/abc",
            "ipc://localhost/cmd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:srcdoc",
        ] {
            assert!(!is_allowed_preview_url(&u(s), None), "{s}");
        }
    }

    #[test]
    fn blocks_windows_custom_scheme_hosts() {
        for s in [
            "http://tauri.localhost/",
            "http://ipc.localhost/plugin:fs|read",
            "http://asset.localhost/C:/x",
            "https://FlintPreview.localhost/id",
        ] {
            assert!(!is_allowed_preview_url(&u(s), None), "{s}");
        }
        assert!(is_allowed_preview_url(&u("http://myapp.localhost:5173/"), None));
    }

    #[test]
    fn blocks_app_dev_origin() {
        let app = u("http://localhost:1420");
        assert!(!is_allowed_preview_url(&u("http://localhost:1420/settings"), Some(&app)));
        assert!(!is_allowed_preview_url(&u("http://LOCALHOST:1420/"), Some(&app)));
        assert!(is_allowed_preview_url(&u("http://localhost:1421/"), Some(&app)));
        assert!(is_allowed_preview_url(&u("https://localhost:1420/"), Some(&app)));
    }

    #[test]
    fn parse_rejects_blank_and_garbage() {
        assert!(parse_preview_url("about:blank", None).is_err());
        assert!(parse_preview_url("not a url", None).is_err());
        assert!(parse_preview_url("https://example.com", None).is_ok());
    }

    #[test]
    fn label_validation() {
        assert_eq!(label_for("rail").unwrap(), "web-preview-rail");
        assert!(label_for("").is_err());
        assert!(label_for("../main").is_err());
        assert!(label_for("a b").is_err());
        assert!(label_for(&"x".repeat(65)).is_err());
    }
}
