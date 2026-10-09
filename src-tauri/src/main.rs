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

    // Fix PATH before anything that may spawn subprocesses, so the engine
    // worker (and any other child) inherits directories added by fix_path_env.
    let _ = fix_path_env::fix();

    // Exits early if invoked as the Windows sandbox helper for a `bash` tool call.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

    app_lib::run();
}
