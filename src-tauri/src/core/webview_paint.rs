//! Keeps the Windows WebView2 surface from staying blank ("white until the
//! window is resized").
//!
//! Chromium's native window occlusion tracker (`CalculateNativeWinOcclusion`)
//! marks a window it believes is covered as hidden and stops producing frames
//! for it. When that verdict is wrong -- after the lock screen, display sleep,
//! a virtual-desktop switch, RDP, or restoring from the tray -- the content
//! area stays white until something (a resize) forces a new layout pass
//! (Chromium docs: windows_native_window_occlusion_tracking.md). Two layers:
//!
//! 1. The tracker is turned off for every WebView2 in the process, through
//!    `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, before the first webview exists.
//!    The env var applies one value to every environment, so the main window,
//!    "Open in new window" windows and web previews keep matching options.
//!    Minimised windows are still throttled (that path is WM_SIZE, not the
//!    occlusion tracker).
//! 2. When the window comes back (focus, restore), the controller is told its
//!    parent moved and gets its own bounds again: the same notification a
//!    resize sends, without changing the OS window, so nothing moves or flashes.

/// Features wry disables by default; the env var replaces wry's own argument
/// string, so they are repeated here.
const WRY_DEFAULT_DISABLED: [&str; 3] = ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"];
const OCCLUSION_FEATURE: &str = "CalculateNativeWinOcclusion";

/// Browser arguments with native occlusion tracking disabled, built on top of
/// `existing` (the user's own `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, if any).
///
/// Chromium reads only the last `--disable-features` switch, so the feature is
/// merged into an existing one instead of appending a second switch. Returns
/// `None` when `existing` already disables it.
pub fn browser_args_without_occlusion(existing: Option<&str>) -> Option<String> {
    const SWITCH: &str = "--disable-features=";
    let Some(existing) = existing.map(str::trim).filter(|s| !s.is_empty()) else {
        let mut features = WRY_DEFAULT_DISABLED.to_vec();
        features.push(OCCLUSION_FEATURE);
        return Some(format!("{SWITCH}{}", features.join(",")));
    };
    let parts: Vec<&str> = existing.split_whitespace().collect();
    let last = parts.iter().rposition(|p| p.starts_with(SWITCH));
    match last {
        Some(i) => {
            let listed = &parts[i][SWITCH.len()..];
            if listed.split(',').any(|f| f == OCCLUSION_FEATURE) {
                return None;
            }
            let merged = if listed.is_empty() {
                format!("{SWITCH}{OCCLUSION_FEATURE}")
            } else {
                format!("{SWITCH}{listed},{OCCLUSION_FEATURE}")
            };
            let out: Vec<String> = parts
                .iter()
                .enumerate()
                .map(|(j, p)| {
                    if j == i {
                        merged.clone()
                    } else {
                        (*p).to_string()
                    }
                })
                .collect();
            Some(out.join(" "))
        }
        None => Some(format!("{existing} {SWITCH}{OCCLUSION_FEATURE}")),
    }
}

/// Chromium draws LCD (ClearType) text only where the text sits in an opaque,
/// non-composited layer; text in a composited layer (a mask fade, an
/// animation, an overlap-promoted sibling) falls back to grayscale. One pane
/// then mixed both, and the LCD labels read as bolder, varying with zoom as
/// layers moved. Grayscale everywhere keeps every label the same weight.
const LCD_TEXT_SWITCH: &str = "--disable-lcd-text";

/// `args` with `--disable-lcd-text` appended, unless it is already there.
pub fn browser_args_with_grayscale_text(args: &str) -> String {
    if args.split_whitespace().any(|p| p == LCD_TEXT_SWITCH) {
        return args.to_string();
    }
    format!("{} {LCD_TEXT_SWITCH}", args.trim())
        .trim()
        .to_string()
}

/// Set the env var for this process. Call from `main` before any thread or
/// webview starts.
#[cfg(windows)]
pub fn disable_native_occlusion() {
    const VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let existing = std::env::var(VAR).ok();
    let args = browser_args_without_occlusion(existing.as_deref())
        .or(existing)
        .unwrap_or_default();
    std::env::set_var(VAR, browser_args_with_grayscale_text(&args));
}

/// Rate limit for the repaint nudge: focus and restore events arrive in
/// bursts, one notification per burst is enough.
pub const NUDGE_MIN_GAP_MS: u64 = 250;

/// Whether a nudge is due, given milliseconds since the last one (`None` = never).
pub fn nudge_due(since_last_ms: Option<u64>) -> bool {
    since_last_ms.is_none_or(|ms| ms >= NUDGE_MIN_GAP_MS)
}

/// Re-send the parent-moved notification and the current bounds to the
/// WebView2 controller whenever the window regains focus or is restored.
#[cfg(all(windows, not(feature = "cli")))]
pub fn install_repaint_nudge<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use std::sync::Mutex;
    use std::time::Instant;
    use tauri::WindowEvent;

    let last: Mutex<Option<Instant>> = Mutex::new(None);
    let win = window.clone();
    window.on_window_event(move |event| {
        let wake = match event {
            WindowEvent::Focused(true) => true,
            // A restore from minimised arrives as a resize to a non-zero size.
            WindowEvent::Resized(size) => {
                size.width > 0 && size.height > 0 && !win.is_minimized().unwrap_or(false)
            }
            WindowEvent::ScaleFactorChanged { .. } => true,
            _ => false,
        };
        if !wake {
            return;
        }
        {
            let mut slot = last.lock().unwrap_or_else(|e| e.into_inner());
            let since = slot.map(|t| t.elapsed().as_millis() as u64);
            if !nudge_due(since) {
                return;
            }
            *slot = Some(Instant::now());
        }
        let _ = win.with_webview(|wv| {
            let controller = wv.controller();
            // SAFETY: called on the UI thread by `with_webview`; the controller
            // is alive for the duration of the closure.
            unsafe {
                let _ = controller.NotifyParentWindowPositionChanged();
                let mut rect = windows::Win32::Foundation::RECT::default();
                if controller.Bounds(&mut rect).is_ok() {
                    let _ = controller.SetBounds(rect);
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_keeps_wry_flags_and_adds_occlusion() {
        assert_eq!(
            browser_args_without_occlusion(None).unwrap(),
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion"
        );
        assert_eq!(
            browser_args_without_occlusion(Some("  ")),
            browser_args_without_occlusion(None)
        );
    }

    #[test]
    fn merges_into_the_last_disable_features_switch() {
        assert_eq!(
            browser_args_without_occlusion(Some(
                "--remote-debugging-port=9 --disable-features=A,B --x"
            ))
            .unwrap(),
            "--remote-debugging-port=9 --disable-features=A,B,CalculateNativeWinOcclusion --x"
        );
        assert_eq!(
            browser_args_without_occlusion(Some("--disable-features=A --disable-features="))
                .unwrap(),
            "--disable-features=A --disable-features=CalculateNativeWinOcclusion"
        );
    }

    #[test]
    fn appends_when_no_switch_and_leaves_already_disabled() {
        assert_eq!(
            browser_args_without_occlusion(Some("--remote-debugging-port=9")).unwrap(),
            "--remote-debugging-port=9 --disable-features=CalculateNativeWinOcclusion"
        );
        assert_eq!(
            browser_args_without_occlusion(Some(
                "--disable-features=X,CalculateNativeWinOcclusion"
            )),
            None
        );
    }

    #[test]
    fn grayscale_text_switch_is_added_once() {
        let base = browser_args_without_occlusion(None).unwrap();
        assert_eq!(
            browser_args_with_grayscale_text(&base),
            format!("{base} --disable-lcd-text")
        );
        assert_eq!(
            browser_args_with_grayscale_text("--x --disable-lcd-text"),
            "--x --disable-lcd-text"
        );
        assert_eq!(browser_args_with_grayscale_text(""), "--disable-lcd-text");
    }

    #[test]
    fn nudge_is_rate_limited() {
        assert!(nudge_due(None));
        assert!(!nudge_due(Some(0)));
        assert!(!nudge_due(Some(NUDGE_MIN_GAP_MS - 1)));
        assert!(nudge_due(Some(NUDGE_MIN_GAP_MS)));
    }
}
