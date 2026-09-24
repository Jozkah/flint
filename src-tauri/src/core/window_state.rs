//! Where the main window was, so a restart puts it back.
//!
//! The window uses the operating system's own title bar, so moving, snapping,
//! maximising and dragging between monitors are the platform's business. What
//! the platform does not do is remember any of it across a restart. This
//! module records the window's *normal* (restored) frame plus whether it was
//! maximised or fullscreen, and on the next start validates that record
//! against the monitors that exist now before applying it.
//!
//! The normal frame is read from the operating system's own placement record
//! (`GetWindowPlacement`), which Windows keeps current while the window is
//! maximised or minimised. Reconstructing it from move and resize events does
//! not work: a maximise reports its move before its size, so an event-driven
//! reading records the maximised position as the normal one, and a move made
//! just before a maximise is lost to the debounce.
//!
//! Units follow what survives a change of display scaling:
//!
//!  - the position is the outer frame's top-left in *physical* pixels, which is
//!    the virtual-desktop coordinate every monitor is placed in;
//!  - the size is the outer frame in *logical* pixels, so a window that was
//!    1200x800 on a 150% monitor is still 1200x800 when it comes back on a 100%
//!    one, instead of shrinking or growing by the ratio of the two.
//!
//! The pure logic ([`resolve_placement`], [`from_placement`]) has no Tauri or
//! Win32 types in it and is what the unit tests exercise.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Name of the file under the Flint data folder.
pub const STATE_FILE: &str = "window-state.json";

/// One window's remembered placement.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SavedWindow {
    /// Outer frame top-left, physical pixels, of the normal (not maximised) frame.
    pub x: i32,
    pub y: i32,
    /// Outer frame size, logical pixels, of the normal frame.
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

/// A monitor's usable area (excluding the taskbar), physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// What to do with the window at startup.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Placement {
    /// Put the normal frame here, then maximise or go fullscreen if asked.
    Restore {
        x: i32,
        y: i32,
        width: f64,
        height: f64,
        maximized: bool,
        fullscreen: bool,
    },
    /// The record is unusable (or points at a monitor that is gone): keep the
    /// configured default size, centred, but still honour maximised.
    Default { maximized: bool, fullscreen: bool },
}

/// How much of the frame's top strip must land on a monitor for the record to
/// count. A window whose title bar is off every screen cannot be grabbed, so it
/// falls back to the default rather than restoring somewhere unreachable.
const GRAB_BAND_LOGICAL: f64 = 32.0;
const MIN_VISIBLE_GRAB_WIDTH_LOGICAL: f64 = 96.0;

/// Decide where the window goes, given the record and today's monitors.
pub fn resolve_placement(
    saved: &SavedWindow,
    monitors: &[MonitorArea],
    min_size: (f64, f64),
) -> Placement {
    let fallback = Placement::Default {
        maximized: saved.maximized,
        fullscreen: saved.fullscreen,
    };
    let sane = saved.width.is_finite()
        && saved.height.is_finite()
        && saved.width > 0.0
        && saved.height > 0.0;
    if !sane || monitors.is_empty() {
        return fallback;
    }

    // The monitor holding most of the title strip is the one it belongs to.
    let mut best: Option<(&MonitorArea, i64)> = None;
    for m in monitors {
        if m.width == 0 || m.height == 0 || !(m.scale.is_finite() && m.scale > 0.0) {
            continue;
        }
        let frame_w = (saved.width * m.scale).round() as i64;
        let band_h = (GRAB_BAND_LOGICAL * m.scale).round() as i64;
        let ix = overlap(saved.x as i64, frame_w, m.x as i64, m.width as i64);
        let iy = overlap(saved.y as i64, band_h, m.y as i64, m.height as i64);
        let needed = (MIN_VISIBLE_GRAB_WIDTH_LOGICAL * m.scale).round() as i64;
        if ix >= needed.min(frame_w) && iy >= band_h / 2 {
            let area = ix * iy;
            if best.is_none_or(|(_, a)| area > a) {
                best = Some((m, area));
            }
        }
    }
    let Some((m, _)) = best else {
        return fallback;
    };

    // Never larger than the monitor it lands on, never smaller than the
    // window's own minimum.
    let max_w = m.width as f64 / m.scale;
    let max_h = m.height as f64 / m.scale;
    let width = saved.width.min(max_w).max(min_size.0.min(max_w));
    let height = saved.height.min(max_h).max(min_size.1.min(max_h));

    // Pull a frame that hangs off the edge back inside the work area, so the
    // whole window -- not just its title bar -- is on screen after a monitor
    // arrangement changed.
    let frame_w = (width * m.scale).round() as i64;
    let frame_h = (height * m.scale).round() as i64;
    let x = clamp_into(saved.x as i64, frame_w, m.x as i64, m.width as i64);
    let y = clamp_into(saved.y as i64, frame_h, m.y as i64, m.height as i64);

    Placement::Restore {
        x: x as i32,
        y: y as i32,
        width,
        height,
        maximized: saved.maximized,
        fullscreen: saved.fullscreen,
    }
}

fn overlap(a: i64, a_len: i64, b: i64, b_len: i64) -> i64 {
    ((a + a_len).min(b + b_len) - a.max(b)).max(0)
}

fn clamp_into(pos: i64, len: i64, area: i64, area_len: i64) -> i64 {
    if len >= area_len {
        return area;
    }
    pos.clamp(area, area + area_len - len)
}

/// How the window is shown, as the operating system's placement record says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shown {
    Normal,
    Maximized,
    /// Minimised; `restores_maximized` is whether un-minimising maximises it.
    Minimized { restores_maximized: bool },
}

/// The record, from the operating system's placement: the normal frame (in
/// screen coordinates, physical pixels), the scale it was measured at, and how
/// the window is shown. A minimised window keeps whatever it will restore to.
pub fn from_placement(
    normal: (i32, i32, i32, i32),
    scale: f64,
    shown: Shown,
    fullscreen: bool,
) -> Option<SavedWindow> {
    let (left, top, right, bottom) = normal;
    if right <= left || bottom <= top || !(scale.is_finite() && scale > 0.0) {
        return None;
    }
    let maximized = match shown {
        Shown::Normal => false,
        Shown::Maximized => true,
        Shown::Minimized { restores_maximized } => restores_maximized,
    };
    Some(SavedWindow {
        x: left,
        y: top,
        width: (right - left) as f64 / scale,
        height: (bottom - top) as f64 / scale,
        maximized,
        fullscreen,
    })
}

/// Every window's record, by label.
pub type StateFile = BTreeMap<String, SavedWindow>;

pub fn state_path(data_folder: &Path) -> PathBuf {
    data_folder.join(STATE_FILE)
}

/// Read the records. A missing or unreadable file is no record, not an error:
/// the window then opens where the configuration puts it.
pub fn load(path: &Path) -> StateFile {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<StateFile>(&b).ok())
        .unwrap_or_default()
}

/// Write the records through a temporary file so a crash mid-write leaves the
/// previous file intact rather than a truncated one.
pub fn store(path: &Path, state: &StateFile) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

#[cfg(all(windows, not(feature = "cli")))]
pub use tauri_glue::{install, restore_and_show};

#[cfg(all(windows, not(feature = "cli")))]
mod tauri_glue {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{Manager, Runtime, WebviewWindow, WindowEvent};
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, SetWindowPlacement, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED,
        WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED,
    };

    fn hwnd_of<R: Runtime>(window: &WebviewWindow<R>) -> Option<HWND> {
        window.hwnd().ok().map(|h| h.0 as HWND)
    }

    /// Placement rectangles are in *workspace* coordinates, which are offset
    /// from screen coordinates by the space a taskbar docked at the top or
    /// left of that monitor takes. Returns the offset to add to go from
    /// workspace to screen coordinates, for the monitor nearest `rect`.
    fn workspace_offset(rect: &RECT) -> (i32, i32) {
        unsafe {
            let monitor = MonitorFromRect(rect, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return (0, 0);
            }
            (
                info.rcWork.left - info.rcMonitor.left,
                info.rcWork.top - info.rcMonitor.top,
            )
        }
    }

    fn read_placement(hwnd: HWND) -> Option<WINDOWPLACEMENT> {
        unsafe {
            let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
            wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            (GetWindowPlacement(hwnd, &mut wp) != 0).then_some(wp)
        }
    }

    /// Apply the remembered placement and show the window.
    ///
    /// The window is created hidden (`visible: false` in the Windows
    /// configuration) so it never paints at the default spot and then jumps.
    /// The normal frame is set with `SetWindowPlacement` while it is still
    /// hidden -- synchronous, unlike tao's positioning, which is queued and
    /// used to land after the maximise and undo it. It is shown whatever
    /// happens here: a bad record must cost the user their placement, never
    /// their window.
    pub fn restore_and_show<R: Runtime>(window: &WebviewWindow<R>, data_folder: &Path) {
        let label = window.label().to_string();
        if let (Some(saved), Some(hwnd)) = (
            load(&state_path(data_folder)).get(&label).copied(),
            hwnd_of(window),
        ) {
            let monitors: Vec<MonitorArea> = window
                .available_monitors()
                .unwrap_or_default()
                .iter()
                .map(|m| {
                    let wa = m.work_area();
                    MonitorArea {
                        x: wa.position.x,
                        y: wa.position.y,
                        width: wa.size.width,
                        height: wa.size.height,
                        scale: m.scale_factor(),
                    }
                })
                .collect();
            let placement = resolve_placement(&saved, &monitors, (1024.0, 740.0));
            log::info!("window-state: restoring {label}: {placement:?}");
            let (maximized, fullscreen) = match placement {
                Placement::Restore {
                    x,
                    y,
                    width,
                    height,
                    maximized,
                    fullscreen,
                } => {
                    // Physical size at the scale the window has now. When the
                    // frame lands on a monitor with a different scale, the
                    // move raises WM_DPICHANGED and the window is rescaled to
                    // keep this logical size. (Not exercised on a host whose
                    // monitors share one scale.)
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let w = (width * scale).round() as i32;
                    let h = (height * scale).round() as i32;
                    let screen = RECT {
                        left: x,
                        top: y,
                        right: x + w,
                        bottom: y + h,
                    };
                    let (ox, oy) = workspace_offset(&screen);
                    if let Some(mut wp) = read_placement(hwnd) {
                        wp.rcNormalPosition = RECT {
                            left: x - ox,
                            top: y - oy,
                            right: x + w - ox,
                            bottom: y + h - oy,
                        };
                        // Still hidden: only the normal frame is set here.
                        wp.showCmd = SW_HIDE as u32;
                        wp.flags = 0;
                        wp.ptMinPosition = POINT { x: -1, y: -1 };
                        wp.ptMaxPosition = POINT { x: -1, y: -1 };
                        if unsafe { SetWindowPlacement(hwnd, &wp) } == 0 {
                            log::warn!("window-state: could not place {label}");
                        }
                    }
                    (maximized, fullscreen)
                }
                Placement::Default {
                    maximized,
                    fullscreen,
                } => {
                    let _ = window.center();
                    (maximized, fullscreen)
                }
            };
            if fullscreen {
                let _ = window.set_fullscreen(true);
            } else if maximized {
                let _ = window.maximize();
            }
        }
        if let Err(e) = window.show() {
            log::error!("window-state: could not show {label}: {e}");
        }
        let _ = window.set_focus();
    }

    /// Record the window's placement as it changes.
    ///
    /// Moves and resizes arrive dozens of times a second while a frame is being
    /// dragged, so writes are debounced; closing writes at once. What is
    /// written is always read back from the operating system's placement, so
    /// the timing of events never decides what the normal frame was.
    pub fn install<R: Runtime>(window: &WebviewWindow<R>, data_folder: PathBuf) {
        let path = state_path(&data_folder);
        let label = window.label().to_string();
        let last: Arc<Mutex<Option<SavedWindow>>> =
            Arc::new(Mutex::new(load(&path).get(&label).copied()));
        let generation = Arc::new(AtomicU64::new(0));

        let win = window.clone();
        window.on_window_event(move |event| {
            let immediate = match event {
                WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. } => false,
                WindowEvent::CloseRequested { .. } => true,
                _ => return,
            };
            let gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
            let win = win.clone();
            let last = last.clone();
            let generation = generation.clone();
            let path = path.clone();
            let label = label.clone();
            let flush = move || {
                let Some(record) = read_record(&win) else { return };
                let mut slot = last.lock().unwrap_or_else(|e| e.into_inner());
                if *slot == Some(record) {
                    return;
                }
                *slot = Some(record);
                let mut file = load(&path);
                file.insert(label.clone(), record);
                if let Err(e) = store(&path, &file) {
                    log::warn!("window-state: could not save {label}: {e}");
                }
            };
            if immediate {
                flush();
            } else {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(400));
                    if generation.load(Ordering::SeqCst) == gen {
                        flush();
                    }
                });
            }
        });
    }

    fn read_record<R: Runtime>(win: &WebviewWindow<R>) -> Option<SavedWindow> {
        let hwnd = hwnd_of(win)?;
        let wp = read_placement(hwnd)?;
        let r = wp.rcNormalPosition;
        let (ox, oy) = workspace_offset(&r);
        let shown = if wp.showCmd == SW_SHOWMAXIMIZED as u32 {
            Shown::Maximized
        } else if wp.showCmd == SW_SHOWMINIMIZED as u32 {
            Shown::Minimized {
                restores_maximized: wp.flags & WPF_RESTORETOMAXIMIZED != 0,
            }
        } else {
            Shown::Normal
        };
        let fullscreen = win.is_fullscreen().unwrap_or(false);
        // A fullscreen window's frame is the monitor, not the user's; keep
        // the last normal frame and only note the state.
        if fullscreen {
            let mut prior = load(&state_path_of(win)?).get(win.label()).copied()?;
            prior.fullscreen = true;
            return Some(prior);
        }
        let scale = win.scale_factor().ok()?;
        from_placement(
            (r.left + ox, r.top + oy, r.right + ox, r.bottom + oy),
            scale,
            shown,
            false,
        )
    }

    fn state_path_of<R: Runtime>(win: &WebviewWindow<R>) -> Option<PathBuf> {
        Some(state_path(&crate::core::app::commands::get_jan_data_folder_path(
            win.app_handle().clone(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: (f64, f64) = (1024.0, 740.0);

    fn primary() -> MonitorArea {
        // 1920x1080 at 100%, taskbar taking the bottom 48px.
        MonitorArea { x: 0, y: 0, width: 1920, height: 1032, scale: 1.0 }
    }

    fn right_hidpi() -> MonitorArea {
        // A 4K monitor at 150% to the right of the primary.
        MonitorArea { x: 1920, y: 0, width: 3840, height: 2112, scale: 1.5 }
    }

    fn saved(x: i32, y: i32, w: f64, h: f64) -> SavedWindow {
        SavedWindow { x, y, width: w, height: h, maximized: false, fullscreen: false }
    }

    #[test]
    fn a_frame_on_screen_comes_back_exactly_where_it_was() {
        let s = saved(200, 100, 1200.0, 800.0);
        assert_eq!(
            resolve_placement(&s, &[primary()], MIN),
            Placement::Restore { x: 200, y: 100, width: 1200.0, height: 800.0, maximized: false, fullscreen: false }
        );
    }

    #[test]
    fn a_frame_on_the_scaled_monitor_keeps_its_logical_size() {
        // Logical 1200x800 on the 150% monitor is 1800x1200 physical; the record
        // stays in logical units so it is not rescaled on the way back.
        let s = saved(2400, 300, 1200.0, 800.0);
        assert_eq!(
            resolve_placement(&s, &[primary(), right_hidpi()], MIN),
            Placement::Restore { x: 2400, y: 300, width: 1200.0, height: 800.0, maximized: false, fullscreen: false }
        );
    }

    #[test]
    fn a_frame_on_a_monitor_that_is_gone_falls_back_to_the_default() {
        // Saved on the right monitor, which is unplugged today.
        let s = saved(2400, 300, 1200.0, 800.0);
        assert_eq!(
            resolve_placement(&s, &[primary()], MIN),
            Placement::Default { maximized: false, fullscreen: false }
        );
    }

    #[test]
    fn a_frame_whose_title_bar_is_above_every_screen_is_not_restored() {
        let s = saved(200, -600, 1200.0, 800.0);
        assert!(matches!(resolve_placement(&s, &[primary()], MIN), Placement::Default { .. }));
    }

    #[test]
    fn a_frame_hanging_off_the_edge_is_pulled_back_inside() {
        let s = saved(1500, 600, 1200.0, 800.0);
        match resolve_placement(&s, &[primary()], MIN) {
            Placement::Restore { x, y, width, height, .. } => {
                assert_eq!((width, height), (1200.0, 800.0));
                assert_eq!(x, 1920 - 1200);
                assert_eq!(y, 1032 - 800);
            }
            other => panic!("expected a restore, got {other:?}"),
        }
    }

    #[test]
    fn a_frame_larger_than_its_monitor_shrinks_to_fit() {
        let s = saved(0, 0, 3000.0, 2000.0);
        match resolve_placement(&s, &[primary()], MIN) {
            Placement::Restore { x, y, width, height, .. } => {
                assert_eq!((x, y), (0, 0));
                assert_eq!((width, height), (1920.0, 1032.0));
            }
            other => panic!("expected a restore, got {other:?}"),
        }
    }

    #[test]
    fn a_frame_below_the_minimum_grows_to_it() {
        let s = saved(100, 100, 300.0, 200.0);
        match resolve_placement(&s, &[primary()], MIN) {
            Placement::Restore { width, height, .. } => assert_eq!((width, height), MIN),
            other => panic!("expected a restore, got {other:?}"),
        }
    }

    #[test]
    fn nonsense_sizes_fall_back() {
        for (w, h) in [(f64::NAN, 800.0), (0.0, 800.0), (1200.0, -1.0), (f64::INFINITY, 1.0)] {
            let s = saved(100, 100, w, h);
            assert!(matches!(resolve_placement(&s, &[primary()], MIN), Placement::Default { .. }), "{w}x{h}");
        }
        assert!(matches!(resolve_placement(&saved(0, 0, 1200.0, 800.0), &[], MIN), Placement::Default { .. }));
    }

    #[test]
    fn maximised_survives_both_a_restore_and_a_fallback() {
        let mut s = saved(200, 100, 1200.0, 800.0);
        s.maximized = true;
        assert!(matches!(resolve_placement(&s, &[primary()], MIN), Placement::Restore { maximized: true, .. }));
        s.x = 9000;
        assert_eq!(resolve_placement(&s, &[primary()], MIN), Placement::Default { maximized: true, fullscreen: false });
    }

    #[test]
    fn the_normal_frame_is_what_the_placement_says_whatever_the_window_shows() {
        // Maximised: the placement still holds the frame restore-down goes
        // back to, and that is what is kept -- not the monitor-sized frame.
        let max = from_placement((300, 200, 1596, 1099), 1.0, Shown::Maximized, false).unwrap();
        assert_eq!((max.x, max.y, max.width, max.height), (300, 200, 1296.0, 899.0));
        assert!(max.maximized);

        let normal = from_placement((300, 200, 1596, 1099), 1.0, Shown::Normal, false).unwrap();
        assert!(!normal.maximized);
    }

    #[test]
    fn a_minimised_window_keeps_what_it_will_restore_to() {
        // Windows parks a minimised window at -32000; the placement's normal
        // frame is unaffected, and so is the record.
        let min_from_max = from_placement(
            (300, 200, 1596, 1099),
            1.0,
            Shown::Minimized { restores_maximized: true },
            false,
        )
        .unwrap();
        assert!(min_from_max.maximized);
        assert_eq!((min_from_max.x, min_from_max.y), (300, 200));
        let min_from_normal = from_placement(
            (300, 200, 1596, 1099),
            1.0,
            Shown::Minimized { restores_maximized: false },
            false,
        )
        .unwrap();
        assert!(!min_from_normal.maximized);
    }

    #[test]
    fn the_size_is_recorded_in_logical_pixels() {
        let rec = from_placement((0, 0, 1800, 1200), 1.5, Shown::Normal, false).unwrap();
        assert_eq!((rec.width, rec.height), (1200.0, 800.0));
        assert!(from_placement((0, 0, 0, 10), 1.0, Shown::Normal, false).is_none());
        assert!(from_placement((0, 0, 10, 10), 0.0, Shown::Normal, false).is_none());
    }

    #[test]
    fn the_file_round_trips_and_a_corrupt_one_is_no_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        assert!(load(&path).is_empty());
        let mut file = StateFile::new();
        file.insert("main".into(), saved(10, 20, 1300.0, 900.0));
        store(&path, &file).unwrap();
        assert_eq!(load(&path), file);
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).is_empty());
    }

    #[test]
    fn records_written_before_fullscreen_existed_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::write(&path, br#"{"main":{"x":1,"y":2,"width":1100.0,"height":800.0,"maximized":true}}"#).unwrap();
        let rec = load(&path)["main"];
        assert!(rec.maximized && !rec.fullscreen);
    }
}
