//! The spare "solo" window kept hidden so "Open in new window" can show a
//! conversation without booting a webview first.
//!
//! The spare is created by the main window's frontend under a label starting
//! with [`SPARE_LABEL_PREFIX`], hidden, and shown by its own frontend once a
//! conversation is assigned to it. An assigned window keeps its label but is
//! visible, which is how an idle spare is told from a window in use.
//!
//! Without cleanup a hidden spare would keep the process alive after the main
//! window is gone, so [`close_idle_spares`] runs when the main window is
//! destroyed.

/// Label prefix of every spare (and of the window it becomes once assigned).
pub const SPARE_LABEL_PREFIX: &str = "chat-window-spare-";

/// Whether a window is an unassigned spare that should be closed with the app.
pub fn is_idle_spare(label: &str, visible: bool) -> bool {
    label.starts_with(SPARE_LABEL_PREFIX) && !visible
}

/// Close every hidden spare. Visible solo windows are left to their users.
#[cfg(not(feature = "cli"))]
pub fn close_idle_spares<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    for (label, window) in app.webview_windows() {
        let visible = window.is_visible().unwrap_or(true);
        if is_idle_spare(&label, visible) {
            log::info!("solo-window: closing idle spare {label}");
            let _ = window.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hidden_spare_is_idle() {
        assert!(is_idle_spare("chat-window-spare-1a", false));
    }

    #[test]
    fn a_visible_spare_is_in_use() {
        assert!(!is_idle_spare("chat-window-spare-1a", true));
    }

    #[test]
    fn other_windows_are_never_idle_spares() {
        assert!(!is_idle_spare("main", false));
        assert!(!is_idle_spare("chat-window-1a", false));
        assert!(!is_idle_spare("logs-app-window", false));
    }
}
