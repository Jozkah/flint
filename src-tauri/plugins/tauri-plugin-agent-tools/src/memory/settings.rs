//! Memory settings, stored beside the records they govern.
//!
//! One setting today, and it is a consent decision rather than a preference:
//! whether Jan may keep something it inferred without being asked. It defaults
//! to off, because a memory is replayed into every future prompt and a user who
//! has not agreed to that should not discover it later.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Whether an agent's proposal may be saved without the user approving it.
    ///
    /// Off by default. When off, an inferred memory becomes a proposal the user
    /// answers; when on, an eligible one is saved and shown in the activity
    /// timeline. Either way the refusals still apply -- automatic saving is
    /// permission to skip the question, not permission to store a credential.
    #[serde(default)]
    pub automatically_save: bool,
    #[serde(default = "default_schema")]
    pub schema_version: u32,
}

fn default_schema() -> u32 {
    1
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            automatically_save: false,
            schema_version: default_schema(),
        }
    }
}

/// `<store_root>/memory/settings.json`.
pub fn settings_path(store_root: &Path) -> PathBuf {
    super::memory_dir(store_root).join("settings.json")
}

/// Read the settings, falling back to the defaults.
///
/// A file that will not parse yields the defaults rather than an error: the
/// safe answer for "may Jan save memories without asking" is no, and refusing
/// to start because a settings file is damaged would be worse than assuming it.
pub fn load(store_root: &Path) -> Settings {
    std::fs::read_to_string(settings_path(store_root))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Write the settings through a temp file, so a crash cannot leave a half
/// written file that reads back as the defaults -- silently turning a setting
/// the user enabled back off.
pub fn save(store_root: &Path, settings: &Settings) -> Result<(), String> {
    let path = settings_path(store_root);
    let dir = path
        .parent()
        .ok_or_else(|| "ERROR: settings path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("ERROR: {e}"))?;

    let body = serde_json::to_string_pretty(settings).map_err(|e| format!("ERROR: {e}"))?;
    let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&temp, body).map_err(|e| format!("ERROR: {e}"))?;
    match std::fs::rename(&temp, &path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(format!("ERROR: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("jan_memset_{}_{}", std::process::id(), n))
    }

    /// The default is the consent-preserving one.
    #[test]
    fn automatic_saving_is_off_until_someone_turns_it_on() {
        let root = unique_root();
        assert!(!load(&root).automatically_save);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_setting_survives_a_restart() {
        let root = unique_root();
        save(
            &root,
            &Settings {
                automatically_save: true,
                ..Settings::default()
            },
        )
        .unwrap();
        assert!(load(&root).automatically_save, "the setting did not persist");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A damaged file must not be read as "yes".
    #[test]
    fn an_unreadable_settings_file_falls_back_to_off() {
        let root = unique_root();
        std::fs::create_dir_all(super::super::memory_dir(&root)).unwrap();
        std::fs::write(settings_path(&root), "{ not json").unwrap();
        assert!(!load(&root).automatically_save);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn saving_leaves_no_temp_file_behind() {
        let root = unique_root();
        save(&root, &Settings::default()).unwrap();
        let dir = super::super::memory_dir(&root);
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unknown_field_does_not_reset_the_setting() {
        let root = unique_root();
        std::fs::create_dir_all(super::super::memory_dir(&root)).unwrap();
        std::fs::write(
            settings_path(&root),
            r#"{"automaticallySave":true,"somethingNewer":42}"#,
        )
        .unwrap();
        assert!(load(&root).automatically_save);
        let _ = std::fs::remove_dir_all(&root);
    }
}
