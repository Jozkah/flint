//! Minimal reproduction of the Windows sandbox launch, driven through the real
//! production helper path.
//!
//! Run it twice to see the difference the environment makes:
//!
//! ```text
//! cargo run -p tauri-plugin-agent-tools --no-default-features --example sandbox_probe -- allowlist
//! cargo run -p tauri-plugin-agent-tools --no-default-features --example sandbox_probe -- inherit
//! ```
//!
//! `allowlist` reproduces what `proc::spawn` gives the helper today (env_clear
//! plus `SANDBOX_ENV_ALLOW`); `inherit` leaves the parent environment intact.

use std::path::PathBuf;
use std::process::Command;

use tauri_plugin_agent_tools::tools::proc::SANDBOX_ENV_ALLOW;

fn main() {
    // When re-exec'd as the helper this returns only if the argv is not a
    // helper request, exactly as in `main.rs`.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

    let mode = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "allowlist".into());
    let root = std::env::temp_dir().join("jan-sandbox-probe");
    let workspace = root.join("workspace");
    let scratch = root.join("scratch");
    std::fs::create_dir_all(&workspace).expect("workspace");
    std::fs::create_dir_all(&scratch).expect("scratch");

    let shell = shell_path();
    println!("mode      : {mode}");
    println!("shell     : {}", shell.display());
    println!("exists    : {}", shell.exists());
    println!("workspace : {}", workspace.display());

    let args = tauri_plugin_agent_tools::tools::appcontainer::helper_args(
        &workspace,
        Some(&scratch),
        false,
        &shell,
        &["-c".to_string(), "pwd && echo probe-ok".to_string()],
    );

    let mut cmd = Command::new(std::env::current_exe().expect("current exe"));
    cmd.args(&args);
    if mode != "inherit" {
        // `allowlist` or `allowlist+VAR1,VAR2` to test what the block is missing.
        let extra: Vec<&str> = mode
            .split_once('+')
            .map(|(_, rest)| rest.split(',').collect())
            .unwrap_or_default();
        cmd.env_clear();
        for key in SANDBOX_ENV_ALLOW.iter().copied().chain(extra) {
            if let Some(val) = std::env::var_os(key) {
                cmd.env(key, val);
            }
        }
        for key in ["TMPDIR", "TMP", "TEMP"] {
            cmd.env(key, &scratch);
        }
    }
    let out = cmd.output().expect("spawn helper");
    println!("exit      : {:?}", out.status.code());
    print!("stdout    : {}", String::from_utf8_lossy(&out.stdout));
    println!();
    print!("stderr    : {}", String::from_utf8_lossy(&out.stderr));
    println!();
}

fn shell_path() -> PathBuf {
    if let Some(explicit) = std::env::args().nth(2) {
        return PathBuf::from(explicit);
    }
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(base) = std::env::var_os(var) {
            let candidate = PathBuf::from(base).join("Git").join("bin").join("bash.exe");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")
}
