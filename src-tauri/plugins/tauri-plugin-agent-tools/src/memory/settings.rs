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
    /// Which scopes are recalled into requests. Stored records are kept either
    /// way; turning a scope off only stops it being sent.
    #[serde(default)]
    pub recall: Recall,
    /// Whether remembered facts are added to requests at all.
    ///
    /// On by default, so an install that predates the switch keeps behaving as
    /// it did. Honoured by `memory_retrieve`, which answers "nothing" before
    /// opening a store when this is off -- the renderer is told, it does not
    /// decide. Separate from `automatically_save`: turning memory off for
    /// prompts is not a decision about what may be saved, and the saved
    /// memories stay where they are, manageable in Settings.
    #[serde(default = "default_enabled")]
    pub memory_enabled: bool,
    #[serde(default = "default_schema")]
    pub schema_version: u32,
}

/// Per-scope recall switches. On by default, matching behaviour before they
/// existed, so an upgrade changes nothing a user already relies on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recall {
    #[serde(default = "on")]
    pub session: bool,
    #[serde(default = "on")]
    pub project: bool,
    #[serde(default = "on")]
    pub user: bool,
}

fn on() -> bool {
    true
}

impl Default for Recall {
    fn default() -> Self {
        Self {
            session: true,
            project: true,
            user: true,
        }
    }
}

impl Recall {
    /// Every scope off: the answer when the settings cannot be read, because
    /// a user who turned recall off must not have it silently turned back on.
    pub fn none() -> Self {
        Self {
            session: false,
            project: false,
            user: false,
        }
    }

    pub fn allows(&self, scope: super::record::Scope) -> bool {
        match scope {
            super::record::Scope::Session => self.session,
            super::record::Scope::Project => self.project,
            super::record::Scope::User => self.user,
        }
    }
}

fn default_schema() -> u32 {
    1
}

fn default_enabled() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            automatically_save: false,
            recall: Recall::default(),
            memory_enabled: default_enabled(),
            schema_version: default_schema(),
        }
    }
}

/// Settings, and why they are not the stored ones when they are not.
///
/// A missing file is the defaults with no complaint. A file that exists but
/// cannot be read or parsed is reported, and fails closed: nothing saved
/// without asking, and nothing recalled, until the user looks.
pub fn load_report(store_root: &Path) -> (Settings, Option<String>) {
    let path = settings_path(store_root);
    match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Settings::default(), None),
        Err(e) => (
            Settings {
                recall: Recall::none(),
                ..Settings::default()
            },
            Some(format!("memory settings could not be read ({e}); recall is off until they are saved again")),
        ),
        Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
            Ok(s) => (s, None),
            Err(e) => (
                Settings {
                    recall: Recall::none(),
                    ..Settings::default()
                },
                Some(format!("memory settings are damaged ({e}); recall is off until they are saved again")),
            ),
        },
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
        assert!(
            load(&root).automatically_save,
            "the setting did not persist"
        );
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
    fn recall_is_on_by_default_and_old_files_keep_it_on() {
        let root = unique_root();
        assert_eq!(load_report(&root), (Settings::default(), None));
        assert!(Settings::default().recall.user);
        std::fs::create_dir_all(super::super::memory_dir(&root)).unwrap();
        // Written before recall switches existed.
        std::fs::write(settings_path(&root), r#"{"automaticallySave":false}"#).unwrap();
        let (s, issue) = load_report(&root);
        assert_eq!(s.recall, Recall::default());
        assert!(issue.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_turned_off_scope_survives_a_restart() {
        let root = unique_root();
        let mut s = Settings::default();
        s.recall.user = false;
        save(&root, &s).unwrap();
        let (back, issue) = load_report(&root);
        assert!(!back.recall.user && back.recall.project && back.recall.session);
        assert!(issue.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Damaged settings must not quietly turn recall back on for someone who
    /// switched it off, and must say so.
    #[test]
    fn damaged_settings_turn_recall_off_and_report_it() {
        let root = unique_root();
        std::fs::create_dir_all(super::super::memory_dir(&root)).unwrap();
        std::fs::write(settings_path(&root), "{ not json").unwrap();
        let (s, issue) = load_report(&root);
        assert_eq!(s.recall, Recall::none());
        assert!(!s.automatically_save);
        assert!(issue.expect("reported").contains("damaged"));
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
