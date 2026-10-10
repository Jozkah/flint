// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMABUF renderer gives a blank window or Wayland "Error 71" on
    // some NVIDIA setups (Tauri "Linux Graphics Issues"). Only the NVIDIA
    // proprietary driver is affected, so leave everyone else on the fast path,
    // and never override a value the user set. Must run before any thread starts.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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

    // Fix PATH before anything that may spawn subprocesses, so the engine
    // worker (and any other child) inherits directories added by fix_path_env.
    let _ = fix_path_env::fix();

    // Exits early if invoked as the Windows sandbox helper for a `bash` tool call.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

    app_lib::run();
}

/// True when /etc/os-release names Fedora (ID=fedora).
#[cfg(target_os = "linux")]
fn is_fedora() -> bool {
    std::fs::read_to_string("/etc/os-release")
        .map(|c| os_release_is_fedora(&c))
        .unwrap_or(false)
}

#[cfg(any(target_os = "linux", test))]
fn os_release_is_fedora(content: &str) -> bool {
    content
        .lines()
        .any(|l| matches!(l.trim(), "ID=fedora" | "ID=\"fedora\""))
}

#[cfg(test)]
mod tests {
    use super::os_release_is_fedora;

    #[test]
    fn detects_fedora_only() {
        assert!(os_release_is_fedora("NAME=\"Fedora Linux\"\nID=fedora\nVERSION_ID=43\n"));
        assert!(os_release_is_fedora("ID=\"fedora\"\n"));
        assert!(!os_release_is_fedora("ID=ubuntu\nID_LIKE=debian\n"));
        assert!(!os_release_is_fedora("ID_LIKE=\"rhel centos fedora\"\n"));
    }
}
