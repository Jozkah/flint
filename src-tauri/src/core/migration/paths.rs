//! Path construction for the JAN -> Flint first-launch migration.
//!
//! Every path the migration touches is derived here. The pure builders take an
//! injected [`Roots`] so tests can point them at temp directories: they never
//! read the real environment or `dirs::*`. Only [`Roots::discover`] reads the
//! process environment, and it is used solely by the (untested) Tauri command
//! layer.
//!
//! ## Legacy JAN layout (verified against the app crate)
//! - config dir:  `dirs::data_dir()/Jan`      (holds `settings.json`)
//! - data folder: `dirs::data_dir()/Jan/data` (default; overridable by
//!   `FLINT_DATA_FOLDER` then `JAN_DATA_FOLDER`)
//! - legacy home: `~/.jan`                     (`JAN_HOME`/`FLINT_HOME` override)
//! - bundle-id dir: `dirs::data_dir()/jan.ai.app` (Tauri identifier fallback)
//!
//! ## Flint layout (introduced by this module)
//! - config dir:  `dirs::data_dir()/Flint`
//! - data folder: `dirs::data_dir()/Flint/data`
//!
//! The existing `Jan` resolution functions in `core::app::commands` are left
//! untouched; this module only *reads* the legacy locations and *defines* the
//! new Flint ones.

use std::path::{Path, PathBuf};

/// Legacy product name (`dirs::data_dir()/Jan`). Matches `CARGO_PKG_NAME`.
pub const APP_NAME_LEGACY: &str = "Jan";
/// New product name (`dirs::data_dir()/Flint`).
pub const APP_NAME_FLINT: &str = "Flint";
/// Tauri bundle identifier, used as a legacy config-recovery fallback.
pub const BUNDLE_ID: &str = "jan.ai.app";
/// Directory name of the legacy per-user home (`~/.jan`).
pub const LEGACY_HOME_DIRNAME: &str = ".jan";
/// The `data` subdirectory under a config dir that holds the data folder.
pub const DATA_SUBDIR: &str = "data";

/// Injected filesystem roots so the pure path builders never read real env.
///
/// The command layer fills these from `dirs::data_dir()` / `dirs::home_dir()`
/// and the `FLINT_/JAN_` compat env; tests fill them with temp directories.
#[derive(Debug, Clone)]
pub struct Roots {
    /// Base equivalent to `dirs::data_dir()` (e.g. `%APPDATA%` on Windows,
    /// `~/Library/Application Support` on macOS, `~/.local/share` on Linux).
    pub data_dir: PathBuf,
    /// Base equivalent to `dirs::home_dir()`.
    pub home_dir: PathBuf,
    /// Explicit legacy data-folder override (from `FLINT_DATA_FOLDER` then
    /// `JAN_DATA_FOLDER`). When set it wins over `<data_dir>/Jan/data`.
    pub data_folder_override: Option<PathBuf>,
    /// Explicit legacy home override (from `FLINT_HOME` then `JAN_HOME`). When
    /// set it wins over `<home_dir>/.jan`.
    pub home_override: Option<PathBuf>,
}

impl Roots {
    /// Build roots from explicit directories, no overrides. Handy for tests.
    pub fn new(data_dir: impl Into<PathBuf>, home_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            home_dir: home_dir.into(),
            data_folder_override: None,
            home_override: None,
        }
    }

    /// Discover roots from the real environment. Reads `dirs::*` and the
    /// `FLINT_/JAN_` compat env; used only by the Tauri command layer.
    #[allow(dead_code)]
    pub fn discover() -> Self {
        let data_folder_override = crate::core::compat_env::var("DATA_FOLDER")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let home_override = crate::core::compat_env::var_os("HOME")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        Self {
            data_dir: dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")),
            home_dir: dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
            data_folder_override,
            home_override,
        }
    }
}

/// The set of legacy JAN locations, all derived from [`Roots`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyPaths {
    /// `<data_dir>/Jan` — holds `settings.json`.
    pub config_dir: PathBuf,
    /// `<data_dir>/Jan/data` (or the override) — the data folder.
    pub data_folder: PathBuf,
    /// `~/.jan` — the legacy per-user home / old data root.
    pub home: PathBuf,
    /// `<data_dir>/jan.ai.app` — the Tauri bundle-id directory.
    pub bundle_dir: PathBuf,
}

/// The set of Flint locations this module introduces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlintPaths {
    /// `<data_dir>/Flint` — Flint config dir.
    pub config_dir: PathBuf,
    /// `<data_dir>/Flint/data` — Flint data folder.
    pub data_folder: PathBuf,
}

/// Legacy config dir: `<data_dir>/Jan`.
pub fn legacy_config_dir(roots: &Roots) -> PathBuf {
    roots.data_dir.join(APP_NAME_LEGACY)
}

/// Legacy data folder: the override if set, else `<data_dir>/Jan/data`.
pub fn legacy_data_folder(roots: &Roots) -> PathBuf {
    if let Some(o) = &roots.data_folder_override {
        return o.clone();
    }
    legacy_config_dir(roots).join(DATA_SUBDIR)
}

/// Legacy home: the override if set, else `<home_dir>/.jan`.
pub fn legacy_home(roots: &Roots) -> PathBuf {
    if let Some(o) = &roots.home_override {
        return o.clone();
    }
    roots.home_dir.join(LEGACY_HOME_DIRNAME)
}

/// Legacy bundle-id dir: `<data_dir>/jan.ai.app`.
pub fn legacy_bundle_dir(roots: &Roots) -> PathBuf {
    roots.data_dir.join(BUNDLE_ID)
}

/// All legacy paths at once.
pub fn legacy_paths(roots: &Roots) -> LegacyPaths {
    LegacyPaths {
        config_dir: legacy_config_dir(roots),
        data_folder: legacy_data_folder(roots),
        home: legacy_home(roots),
        bundle_dir: legacy_bundle_dir(roots),
    }
}

/// Flint config dir: `<data_dir>/Flint`.
pub fn flint_config_dir(roots: &Roots) -> PathBuf {
    roots.data_dir.join(APP_NAME_FLINT)
}

/// Flint data folder: `<data_dir>/Flint/data`.
pub fn flint_data_folder(roots: &Roots) -> PathBuf {
    flint_config_dir(roots).join(DATA_SUBDIR)
}

/// All Flint paths at once.
pub fn flint_paths(roots: &Roots) -> FlintPaths {
    FlintPaths {
        config_dir: flint_config_dir(roots),
        data_folder: flint_data_folder(roots),
    }
}

/// Whether `path` is a non-empty directory (used to decide which legacy root
/// actually holds data).
pub(crate) fn is_non_empty_dir(path: &Path) -> bool {
    path.is_dir()
        && std::fs::read_dir(path)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_and_flint_layout_under_injected_roots() {
        let roots = Roots::new("/base/appdata", "/home/user");
        let l = legacy_paths(&roots);
        assert_eq!(l.config_dir, PathBuf::from("/base/appdata/Jan"));
        assert_eq!(l.data_folder, PathBuf::from("/base/appdata/Jan/data"));
        assert_eq!(l.home, PathBuf::from("/home/user/.jan"));
        assert_eq!(l.bundle_dir, PathBuf::from("/base/appdata/jan.ai.app"));

        let f = flint_paths(&roots);
        assert_eq!(f.config_dir, PathBuf::from("/base/appdata/Flint"));
        assert_eq!(f.data_folder, PathBuf::from("/base/appdata/Flint/data"));
    }

    #[test]
    fn data_folder_override_wins() {
        let mut roots = Roots::new("/base", "/home");
        roots.data_folder_override = Some(PathBuf::from("/custom/data"));
        assert_eq!(legacy_data_folder(&roots), PathBuf::from("/custom/data"));
    }

    #[test]
    fn home_override_wins() {
        let mut roots = Roots::new("/base", "/home");
        roots.home_override = Some(PathBuf::from("/custom/home"));
        assert_eq!(legacy_home(&roots), PathBuf::from("/custom/home"));
    }

    // Per-`target_os` path *construction* is `join`-only and therefore identical
    // across platforms once the roots are injected; the representative roots that
    // each platform's `dirs::data_dir()` would return still produce the expected
    // shape. These assert the shape for each platform's typical base.
    #[test]
    fn windows_shape() {
        let roots = Roots::new(r"C:\Users\me\AppData\Roaming", r"C:\Users\me");
        let l = legacy_paths(&roots);
        assert!(l.config_dir.ends_with("Jan"));
        assert!(l.data_folder.ends_with(PathBuf::from("Jan").join("data")));
        assert!(l.home.ends_with(".jan"));
        assert!(flint_paths(&roots).config_dir.ends_with("Flint"));
    }

    #[test]
    fn macos_shape() {
        let roots = Roots::new(
            "/Users/me/Library/Application Support",
            "/Users/me",
        );
        let l = legacy_paths(&roots);
        assert_eq!(
            l.config_dir,
            PathBuf::from("/Users/me/Library/Application Support/Jan")
        );
        assert_eq!(
            flint_paths(&roots).data_folder,
            PathBuf::from("/Users/me/Library/Application Support/Flint/data")
        );
    }

    #[test]
    fn linux_shape() {
        let roots = Roots::new("/home/me/.local/share", "/home/me");
        let l = legacy_paths(&roots);
        assert_eq!(l.config_dir, PathBuf::from("/home/me/.local/share/Jan"));
        assert_eq!(l.home, PathBuf::from("/home/me/.jan"));
        assert_eq!(
            flint_paths(&roots).config_dir,
            PathBuf::from("/home/me/.local/share/Flint")
        );
    }
}
