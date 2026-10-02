//! `browser_screenshot`: a PNG of the browser pane.
//!
//! Capture is platform code (WebView2's `CapturePreview` on Windows; nothing
//! equivalent is exposed through Tauri elsewhere), so everything around it is
//! kept pure and testable on any machine: the size cap, PNG validation and
//! dimensions, file naming and the "not supported here" result.
//!
//! The image is page content like the text is. It is saved for the user (the
//! tool card shows it) and the model is told where and how big it is; the
//! desktop tool pipeline carries text, so the pixels themselves do not go to
//! the model.

use std::path::{Path, PathBuf};

/// Largest PNG accepted. A pane-sized capture is a few hundred KiB; past this
/// something is wrong (a huge pane, an animation frame) and the tool says so
/// rather than sending megabytes over IPC.
pub const MAX_PNG_BYTES: usize = 4 * 1024 * 1024;
/// Captures kept on disk; the oldest go first.
pub const KEEP_FILES: usize = 20;

pub const UNSUPPORTED: &str = "browser_screenshot is not supported on this platform yet: capturing the browser pane needs Windows (WebView2). Use browser_snapshot or browser_read_text instead.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    Unsupported,
    /// The webview did not answer in time (the window may be minimized).
    Unresponsive,
    Failed(String),
}

impl CaptureError {
    pub fn message(&self) -> String {
        match self {
            CaptureError::Unsupported => UNSUPPORTED.to_string(),
            CaptureError::Unresponsive => super::step::PANE_UNRESPONSIVE.to_string(),
            CaptureError::Failed(why) => format!("could not capture the browser pane: {why}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// Width and height from the IHDR chunk, if `bytes` starts like a PNG.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// Check what the platform handed back before it is saved or sent anywhere.
pub fn validate(png: Vec<u8>) -> Result<Shot, String> {
    if png.is_empty() {
        return Err("the capture was empty (the pane may be hidden or still loading)".into());
    }
    if png.len() > MAX_PNG_BYTES {
        return Err(format!(
            "the capture is {} KiB, over the {} MiB limit; make the browser pane smaller and try again",
            png.len() / 1024,
            MAX_PNG_BYTES / 1024 / 1024
        ));
    }
    let Some((width, height)) = png_dimensions(&png) else {
        return Err("the capture was not a valid PNG".into());
    };
    Ok(Shot { png, width, height })
}

/// A file name that cannot escape its folder, whatever the run id holds.
pub fn file_name(run: &str, stamp_ms: u128) -> String {
    let safe: String = run
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(40)
        .collect();
    let safe = if safe.is_empty() { "run".to_string() } else { safe };
    format!("shot-{safe}-{stamp_ms}.png")
}

/// Delete all but the newest `KEEP_FILES` captures in `dir`.
pub fn prune(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("shot-"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(KEEP_FILES) {
        let _ = std::fs::remove_file(path);
    }
}

/// Save a validated capture under `dir`, returning its path.
pub fn save(dir: &Path, run: &str, shot: &Shot) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(file_name(run, stamp));
    std::fs::write(&path, &shot.png).map_err(|e| e.to_string())?;
    prune(dir);
    Ok(path)
}

// --- capture -----------------------------------------------------------------

#[cfg(windows)]
pub async fn capture<R: tauri::Runtime>(wv: &tauri::Webview<R>) -> Result<Vec<u8>, CaptureError> {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let send = move |r: Result<Vec<u8>, String>| {
        if let Some(t) = tx.lock().ok().and_then(|mut g| g.take()) {
            let _ = t.send(r);
        }
    };
    let send_start = send.clone();
    let w = wv.clone();
    let started = super::step::run_step(super::step::STEP_BUDGET, move || {
        w.with_webview(move |platform| unsafe {
            if let Err(e) = start_capture(platform, send) {
                send_start(Err(e));
            }
        })
    })
    .await;
    match started {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(CaptureError::Failed(e.to_string())),
        Err(super::step::StepError::Timeout) => return Err(CaptureError::Unresponsive),
        Err(super::step::StepError::Failed(m)) => return Err(CaptureError::Failed(m)),
    }
    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(Ok(png))) => Ok(png),
        Ok(Ok(Err(why))) => Err(CaptureError::Failed(why)),
        Ok(Err(_)) => Err(CaptureError::Failed("the capture was dropped".into())),
        Err(_) => Err(CaptureError::Unresponsive),
    }
}

/// Runs on the webview's thread. The completion handler fires there too, reads
/// the PNG out of the in-memory stream and hands the bytes to `send`.
#[cfg(windows)]
unsafe fn start_capture<F>(platform: tauri::webview::PlatformWebview, send: F) -> Result<(), String>
where
    F: Fn(Result<Vec<u8>, String>) + Clone + 'static,
{
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_END, STREAM_SEEK_SET};

    let core = platform
        .controller()
        .CoreWebView2()
        .map_err(|e| format!("no WebView2 core: {e}"))?;
    let stream: IStream =
        CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true).map_err(|e| e.to_string())?;
    let reader = stream.clone();
    let done = send.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        let outcome = (|| -> Result<Vec<u8>, String> {
            result.map_err(|e| e.to_string())?;
            let mut size = 0u64;
            reader.Seek(0, STREAM_SEEK_END, Some(&mut size)).map_err(|e| e.to_string())?;
            if size as usize > MAX_PNG_BYTES {
                return Err(format!(
                    "the capture is {} KiB, over the {} MiB limit; make the browser pane smaller and try again",
                    size / 1024,
                    MAX_PNG_BYTES / 1024 / 1024
                ));
            }
            reader.Seek(0, STREAM_SEEK_SET, None).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; size as usize];
            let mut read = 0u32;
            reader
                .Read(buf.as_mut_ptr() as *mut _, size as u32, Some(&mut read))
                .ok()
                .map_err(|e| e.to_string())?;
            buf.truncate(read as usize);
            Ok(buf)
        })();
        done(outcome);
        Ok(())
    }));
    core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub async fn capture<R: tauri::Runtime>(_wv: &tauri::Webview<R>) -> Result<Vec<u8>, CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal valid PNG header + IHDR for the given size, padded to `len`.
    fn fake_png(w: u32, h: u32, len: usize) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(SIGNATURE);
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.resize(len.max(v.len()), 0);
        v
    }

    #[test]
    fn dimensions_come_from_the_header() {
        assert_eq!(png_dimensions(&fake_png(1200, 800, 100)), Some((1200, 800)));
        assert_eq!(png_dimensions(&fake_png(0, 800, 100)), None);
        assert_eq!(png_dimensions(b"not a png at all, nope nope nope"), None);
        assert_eq!(png_dimensions(&[]), None);
        let mut wrong_chunk = fake_png(10, 10, 100);
        wrong_chunk[12..16].copy_from_slice(b"IDAT");
        assert_eq!(png_dimensions(&wrong_chunk), None);
    }

    #[test]
    fn validate_accepts_a_png_and_reports_its_size() {
        let shot = validate(fake_png(640, 480, 5000)).unwrap();
        assert_eq!((shot.width, shot.height), (640, 480));
        assert_eq!(shot.png.len(), 5000);
    }

    #[test]
    fn validate_enforces_the_size_cap_at_the_boundary() {
        assert!(validate(fake_png(10, 10, MAX_PNG_BYTES)).is_ok());
        let err = validate(fake_png(10, 10, MAX_PNG_BYTES + 1)).unwrap_err();
        assert!(err.contains("limit"), "{err}");
    }

    #[test]
    fn validate_refuses_empty_and_non_png() {
        assert!(validate(Vec::new()).unwrap_err().contains("empty"));
        assert!(validate(b"GIF89a....................".to_vec()).unwrap_err().contains("PNG"));
    }

    #[test]
    fn unsupported_platforms_get_a_clear_message() {
        let m = CaptureError::Unsupported.message();
        assert!(m.contains("not supported on this platform"), "{m}");
        assert!(m.contains("browser_snapshot"), "{m}");
        assert!(CaptureError::Failed("x".into()).message().contains("could not capture"));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_capture_is_unsupported_by_construction() {
        // `capture` needs a live webview; the contract is the error it returns.
        assert_eq!(CaptureError::Unsupported.message(), UNSUPPORTED);
    }

    #[test]
    fn file_names_cannot_escape_the_folder() {
        for run in ["../../etc/passwd", "a/b\\c", "run id with spaces", "", "ünï"] {
            let n = file_name(run, 5);
            assert!(n.starts_with("shot-") && n.ends_with("-5.png"), "{n}");
            assert!(!n.contains('/') && !n.contains('\\') && !n.contains(".."), "{n}");
        }
        assert!(file_name(&"x".repeat(500), 1).len() < 70);
    }

    #[test]
    fn save_writes_the_file_and_prunes_old_ones() {
        let dir = std::env::temp_dir().join(format!("flint-shot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shot = validate(fake_png(2, 2, 64)).unwrap();
        let mut last = PathBuf::new();
        for i in 0..(KEEP_FILES + 5) {
            last = save(&dir, &format!("r{i}"), &shot).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        assert!(last.exists());
        let count = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(count, KEEP_FILES);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
