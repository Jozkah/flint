use std::path::Path;

/// Environment variable Flint sets on every `mlx-server` it starts. The startup
/// sweep stops an orphaned `mlx-server` only when it carries this, because the
/// server's name, path and flags can all belong to one someone runs themselves.
pub const MLX_OWNER_ENV: &str = "JAN_MLX_OWNER";

/// Runs a blocking probe (a disk-space query, which can hang on a dead network
/// mount) on the blocking pool and waits at most `limit` for it. `None` when
/// it timed out or panicked, so the caller skips the check rather than stall;
/// the stuck thread is left to finish on its own.
pub async fn run_bounded<T, F>(limit: std::time::Duration, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::time::timeout(limit, tokio::task::spawn_blocking(f))
        .await
        .ok()?
        .ok()
}

/// Returns true when the current process is running inside a Flatpak sandbox
pub fn is_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

/// Whether the bundled `bun` can run on this CPU.
///
/// The `bun` Jan bundles is the regular x86-64 build, which requires AVX2. On
/// a CPU without it `bun` dies on its first instruction ("panic: Illegal
/// instruction", "Features: no_avx2"), and every MCP server Jan starts through
/// `npx` fails with it. That check used to run only on Intel macOS, so Windows
/// and Linux machines without AVX2 lost every npx-based MCP server
/// (janhq/jan#8314). Non-x86 CPUs are unaffected.
pub fn bun_runs_on_cpu(is_x86: bool, has_avx2: bool) -> bool {
    !is_x86 || has_avx2
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn this_cpu_runs_bun() -> bool {
    bun_runs_on_cpu(true, is_x86_feature_detected!("avx2"))
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn this_cpu_runs_bun() -> bool {
    bun_runs_on_cpu(false, false)
}

/// Checks if npx can be overridden with bun binary
pub fn can_override_npx(bun_path: String) -> bool {
    if !this_cpu_runs_bun() {
        #[cfg(feature = "logging")]
        log::warn!("Your CPU doesn't support AVX2 instruction, default npx binary will be used");
        return false; // we cannot override npx with bun binary
    }
    // Check if bun_path exists
    if !std::path::Path::new(bun_path.as_str()).exists() {
        #[cfg(feature = "logging")]
        log::warn!(
            "bun binary not found at '{}', default npx binary will be used",
            bun_path
        );
        return false;
    }
    true // by default, we can override npx with bun binary
}

/// Checks if uv_path exists and determines if uvx can be overridden with the uv binary
pub fn can_override_uvx(uv_path: String) -> bool {
    if !std::path::Path::new(uv_path.as_str()).exists() {
        #[cfg(feature = "logging")]
        log::warn!(
            "uv binary not found at '{}', default uvx binary will be used",
            uv_path
        );
        return false;
    }
    true // by default, we can override uvx with uv binary
}

/// A long-lived background worker (the llama.cpp worker, ...): hidden console
/// on Windows, its own process group. Thin name over
/// [`jan_process::CommandConsole::background_in_new_group`], kept so existing
/// call sites read the same.
pub fn setup_windows_process_flags(command: &mut tokio::process::Command) {
    use jan_process::CommandConsole;
    command.background_in_new_group();
}

/// Keep a short-lived `std::process::Command` (git, cmd, ...) spawned from the
/// GUI from flashing a console window on Windows.
///
/// Thin name over [`jan_process::CommandConsole::background`], which is where
/// the flags are decided; new code can call that directly on a std or tokio
/// `Command`. Unlike [`setup_windows_process_flags`] this sets no process-group
/// flag: these are one-shot `.output()`/`.status()` calls.
///
/// Every caller starts a host program (`git`, `gh`, `cmd`), so this also drops
/// the AppImage runtime's library and `PATH` entries from what the child
/// inherits (see [`jan_process::appimage`]).
pub fn hide_console_window(command: &mut std::process::Command) {
    use jan_process::{CommandConsole, HostProcessEnv};
    command.background().host_env();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_flatpak_returns_bool() {
        let result = is_flatpak();
        if Path::new("/.flatpak-info").exists() {
            assert!(result);
        } else {
            assert!(!result);
        }
    }
}

#[cfg(test)]
mod bun_cpu_tests {
    use super::bun_runs_on_cpu;

    // janhq/jan#8314: the regular x86-64 bun build dies on a CPU without AVX2.
    #[test]
    fn an_x86_cpu_without_avx2_cannot_run_the_bundled_bun() {
        assert!(!bun_runs_on_cpu(true, false));
    }

    #[test]
    fn an_x86_cpu_with_avx2_can() {
        assert!(bun_runs_on_cpu(true, true));
    }

    #[test]
    fn a_non_x86_cpu_is_unaffected() {
        assert!(bun_runs_on_cpu(false, false));
    }
}

#[cfg(test)]
mod run_bounded_tests {
    use super::run_bounded;
    use std::time::Duration;

    #[tokio::test]
    async fn returns_the_value_of_a_fast_probe() {
        assert_eq!(run_bounded(Duration::from_secs(2), || 7u64).await, Some(7));
    }

    #[tokio::test]
    async fn free_space_check_timeout_skips() {
        let started = std::time::Instant::now();
        let out = run_bounded(Duration::from_millis(100), || {
            std::thread::sleep(Duration::from_millis(1500));
            Some(1u64)
        })
        .await;
        assert_eq!(out, None);
        assert!(started.elapsed() < Duration::from_millis(1200), "waited for the slow probe");
    }

    #[tokio::test]
    async fn a_panicking_probe_is_skipped() {
        let out: Option<u64> = run_bounded(Duration::from_secs(2), || panic!("probe")).await;
        assert_eq!(out, None);
    }
}
