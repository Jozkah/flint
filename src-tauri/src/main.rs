// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMABUF renderer gives a blank window or Wayland "Error 71" on
    // some NVIDIA setups (Tauri "Linux Graphics Issues"), and on KDE/AMD/Intel
    // it can freeze the UI and leave a blank grey window after minimize/restore.
    // Turn it off everywhere on Linux; never override a value the user set (set
    // WEBKIT_DISABLE_DMABUF_RENDERER=0 to opt back in). Must run before any
    // thread starts.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // Compositing mode on WebKitGTK (Wayland, NVIDIA especially) can stall and
    // leave the window flat grey, so it is off by default. The cost is that
    // WebKit then paints every layer on the CPU, which can make typing and
    // scrolling slow where the GPU stack works. FLINT_WEBKIT_COMPOSITING=hardware
    // leaves it on (see docs/LINUX_TROUBLESHOOTING.md). A
    // WEBKIT_DISABLE_COMPOSITING_MODE the user set always wins.
    #[cfg(target_os = "linux")]
    if let Some(value) = compositing_default(
        std::env::var("FLINT_WEBKIT_COMPOSITING").ok().as_deref(),
        std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_some(),
    ) {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", value);
    }

    // Fedora 43's AT-SPI D-Bus stack is incompatible with GTK's accessibility
    // bridge and the app aborts at startup (Jan #7536). Turn the bridge off
    // there only, so other distros keep working screen-reader support. A value
    // the user already set always wins.
    #[cfg(target_os = "linux")]
    if is_fedora() {
        for (key, value) in [("NO_AT_BRIDGE", "1"), ("GTK_A11Y", "none")] {
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, value);
            }
        }
    }

    // Restrict where LoadLibrary looks for DLLs to System32 and the folder
    // holding this exe. The default search also tries the current directory
    // and every PATH entry, so a DLL planted in either (a downloads folder the
    // app was started from, a writable PATH directory) would be loaded into
    // the app. Static imports get the same rule from the linker flag set in
    // build.rs. Must run before any thread starts or any library is loaded.
    #[cfg(windows)]
    harden_dll_search();

    // A crashing llama-server or engine worker must exit, not wait in a WER
    // dialog holding its port. Children inherit the mode, so set it before
    // anything is spawned.
    #[cfg(windows)]
    jan_process::error_mode::suppress_crash_dialogs();

    // WebView2's native occlusion tracker can leave the window white until it
    // is resized; see core::webview_paint. Must run before any webview starts.
    #[cfg(windows)]
    app_lib::core::webview_paint::disable_native_occlusion();

    // Fix PATH before anything that may spawn subprocesses, so the engine
    // worker (and any other child) inherits directories added by fix_path_env.
    let _ = fix_path_env::fix();

    // Exits early if invoked as the Windows sandbox helper for a `bash` tool call.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

    app_lib::run();
}

#[cfg(windows)]
fn harden_dll_search() {
    use windows_sys::Win32::System::LibraryLoader::{
        SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_APPLICATION_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    // SAFETY: takes only flags; it changes this process's search order.
    let ok = unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_APPLICATION_DIR)
    };
    if ok == 0 {
        eprintln!(
            "SetDefaultDllDirectories failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// True when /etc/os-release names Fedora (ID=fedora).
#[cfg(target_os = "linux")]
fn is_fedora() -> bool {
    std::fs::read_to_string("/etc/os-release")
        .map(|c| os_release_is_fedora(&c))
        .unwrap_or(false)
}

/// The value to give WEBKIT_DISABLE_COMPOSITING_MODE, or None to leave it
/// alone. `choice` is FLINT_WEBKIT_COMPOSITING: "hardware" keeps WebKit's
/// accelerated compositing on; anything else keeps the safe software default.
#[cfg(any(target_os = "linux", test))]
fn compositing_default(choice: Option<&str>, user_set: bool) -> Option<&'static str> {
    if user_set {
        return None;
    }
    match choice.map(|c| c.trim().to_ascii_lowercase()).as_deref() {
        Some("hardware") => None,
        _ => Some("1"),
    }
}

#[cfg(any(target_os = "linux", test))]
fn os_release_is_fedora(content: &str) -> bool {
    content
        .lines()
        .any(|l| matches!(l.trim(), "ID=fedora" | "ID=\"fedora\""))
}

#[cfg(test)]
mod tests {
    use super::{compositing_default, os_release_is_fedora};

    #[test]
    fn compositing_defaults_to_software_unless_asked_or_set() {
        assert_eq!(compositing_default(None, false), Some("1"));
        assert_eq!(compositing_default(Some("software"), false), Some("1"));
        assert_eq!(compositing_default(Some("nonsense"), false), Some("1"));
        assert_eq!(compositing_default(Some("hardware"), false), None);
        assert_eq!(compositing_default(Some(" Hardware "), false), None);
        // A value the user set is never touched, whatever the choice.
        assert_eq!(compositing_default(None, true), None);
        assert_eq!(compositing_default(Some("software"), true), None);
    }

    #[test]
    fn detects_fedora_only() {
        assert!(os_release_is_fedora("NAME=\"Fedora Linux\"\nID=fedora\nVERSION_ID=43\n"));
        assert!(os_release_is_fedora("ID=\"fedora\"\n"));
        assert!(!os_release_is_fedora("ID=ubuntu\nID_LIKE=debian\n"));
        assert!(!os_release_is_fedora("ID_LIKE=\"rhel centos fedora\"\n"));
    }
}
