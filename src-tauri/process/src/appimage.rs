//! Keep the AppImage runtime's environment out of host programs.
//!
//! An AppImage's `AppRun` prepends its own mount (`$APPDIR`) to library and
//! plugin search paths, and to `PATH`. That is right for Flint and for the
//! sidecars that ship in the bundle. It is wrong for a program Flint starts
//! *on the host's behalf* -- `git`, `gh`, `xdg-open`, the user's shell, a hook,
//! an MCP server, a browser: such a program resolves the bundle's older
//! `libssl`/`libcurl`/Python instead of the distro's own and fails or crashes
//! (Atomic-Chat #164, #205, #229, #273).
//!
//! The rule here is narrow on purpose. Only entries that point *into* the
//! AppDir are dropped from the path-like variables below; whatever the host
//! put there is kept, in order. Outside an AppImage nothing is touched, so a
//! developer's own `LD_LIBRARY_PATH` or `PYTHONHOME` in a source run survives.
//!
//! Do not call this on a sidecar that is meant to run inside the bundle (the
//! llama.cpp worker, the bundled `bun`'s own children): those rely on it.

use std::ffi::OsString;
use std::process::Command as StdCommand;
use tokio::process::Command as TokioCommand;

/// Variables an AppImage's `AppRun` prepends its own mount to; a spawned host
/// program that inherits them loads the bundle's libraries instead of the host's.
pub const APPIMAGE_PATH_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "PATH",
    "XDG_DATA_DIRS",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "GST_PLUGIN_PATH",
    "GTK_PATH",
    "GIO_EXTRA_MODULES",
];

/// What to do with one variable: `None` leaves it alone, `Some(None)` removes
/// it, `Some(Some(v))` sets it to `v`.
fn scrub_one(appdir: &str, var: &str, value: &str) -> Option<Option<String>> {
    if !APPIMAGE_PATH_VARS.contains(&var) {
        return None;
    }
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() {
        return None;
    }
    let under = |entry: &str| {
        entry == appdir || entry.strip_prefix(appdir).is_some_and(|r| r.starts_with('/'))
    };
    if !value.split(':').any(under) {
        return None;
    }
    let kept: Vec<&str> = value
        .split(':')
        .filter(|e| !e.is_empty() && !under(e))
        .collect();
    Some((!kept.is_empty()).then(|| kept.join(":")))
}

/// For each inherited variable that has an entry under `appdir`, the value to
/// set (`Some`) or `None` to remove it. Variables that are unset or have no
/// such entry are left out, so the child still inherits them untouched.
pub fn env_scrubs(
    appdir: &str,
    get: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, Option<String>)> {
    APPIMAGE_PATH_VARS
        .iter()
        .filter_map(|&var| {
            let value = get(var)?;
            scrub_one(appdir, var, &value).map(|scrubbed| (var, scrubbed))
        })
        .collect()
}

/// The AppImage mount this process runs from, or `None` outside an AppImage
/// (and everywhere but Linux).
pub fn appdir() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE")?;
        std::env::var("APPDIR").ok().filter(|dir| !dir.is_empty())
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// `std::env::var_os(key)` with the AppDir's entries dropped, for the code that
/// builds a child's environment from an allowlist (`env_clear()` and then
/// copying keys back) rather than by inheritance.
pub fn host_env_var(key: &str) -> Option<OsString> {
    let raw = std::env::var_os(key)?;
    if let (Some(appdir), Some(text)) = (appdir(), raw.to_str()) {
        match scrub_one(&appdir, key, text) {
            Some(Some(value)) => return Some(OsString::from(value)),
            Some(None) => return None,
            None => {}
        }
    }
    Some(raw)
}

/// Starts a host program with the AppImage runtime's paths removed from its
/// inherited environment. A no-op outside an AppImage.
pub trait HostProcessEnv {
    /// Apply the scrub. Call it before any explicit `.env(..)` for the same
    /// variable, so a value the caller sets on purpose still wins.
    fn host_env(&mut self) -> &mut Self;
}

impl HostProcessEnv for StdCommand {
    fn host_env(&mut self) -> &mut Self {
        if let Some(appdir) = appdir() {
            for (var, value) in env_scrubs(&appdir, |k| std::env::var(k).ok()) {
                match value {
                    Some(v) => self.env(var, v),
                    None => self.env_remove(var),
                };
            }
        }
        self
    }
}

impl HostProcessEnv for TokioCommand {
    fn host_env(&mut self) -> &mut Self {
        if let Some(appdir) = appdir() {
            for (var, value) in env_scrubs(&appdir, |k| std::env::var(k).ok()) {
                match value {
                    Some(v) => self.env(var, v),
                    None => self.env_remove(var),
                };
            }
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_appdir_entries_and_keeps_host_ones() {
        let get = |k: &str| match k {
            "LD_LIBRARY_PATH" => Some("/tmp/.mount_x/usr/lib:/opt/cuda/lib".to_string()),
            "PYTHONHOME" => Some("/tmp/.mount_x/usr".to_string()),
            "PATH" => Some("/usr/bin:/bin".to_string()),
            _ => None,
        };
        let out = env_scrubs("/tmp/.mount_x", get);
        assert_eq!(
            out,
            vec![
                ("LD_LIBRARY_PATH", Some("/opt/cuda/lib".to_string())),
                ("PYTHONHOME", None),
            ]
        );
    }

    #[test]
    fn sibling_prefix_is_not_under_appdir() {
        let get = |k: &str| (k == "PATH").then(|| "/tmp/.mount_xy/bin".to_string());
        assert!(env_scrubs("/tmp/.mount_x", get).is_empty());
    }

    #[test]
    fn path_keeps_host_order_and_a_trailing_slash_on_appdir_is_fine() {
        let get = |k: &str| {
            (k == "PATH").then(|| "/tmp/.mount_x/usr/bin:/usr/local/bin:/tmp/.mount_x:/bin".to_string())
        };
        assert_eq!(
            env_scrubs("/tmp/.mount_x/", get),
            vec![("PATH", Some("/usr/local/bin:/bin".to_string()))]
        );
    }

    #[test]
    fn an_empty_appdir_scrubs_nothing() {
        let get = |_: &str| Some("/usr/bin".to_string());
        assert!(env_scrubs("", get).is_empty());
        assert!(env_scrubs("/", get).is_empty());
    }

    #[test]
    fn variables_outside_the_list_are_never_touched() {
        assert_eq!(scrub_one("/tmp/.mount_x", "HOME", "/tmp/.mount_x/home"), None);
    }
}
