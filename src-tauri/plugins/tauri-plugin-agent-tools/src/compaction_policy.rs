//! One compaction policy, read by every surface (AH-076).
//!
//! Compaction used to be decided twice. The Rust loop (CLI and the desktop's
//! agent runs) kept a fixed eight-message tail and triggered at
//! `window - [agent].compaction_reserve_tokens`, a key only the CLI read; the
//! TypeScript chat transport budgeted by the model's output cap, summarised in
//! 512 tokens, and switched on only through a per-model inference parameter.
//! The same conversation compacted differently depending on which window it
//! was open in.
//!
//! This is the single definition. It lives in
//! `<data folder>/compaction.json` (the user's choice, shared by the desktop
//! and the CLI) and may be overridden per project in
//! `<project>/.jan/agent/compaction.json`. Every field records where it came
//! from, so a surface can show why it compacted when it did.
//!
//! A file that will not parse, carries an unknown field, or holds a value
//! outside its range is refused with a typed `invalid_input` naming the file
//! and field -- never quietly replaced by the default, which would compact at a
//! point nobody chose.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::harness_error::{ErrorKind, HarnessError, Stage};

/// How older conversation is removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Strategy {
    /// Summarise the dropped span with the run's own model.
    Summarize,
    /// Drop it, leaving a note that it was dropped. No model call.
    Trim,
}

/// Where a value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Default,
    User,
    Project,
}

/// The effective policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// Compact before a request would overflow, rather than only after a
    /// provider refuses one.
    pub auto: bool,
    /// Headroom kept free: compaction triggers once use passes
    /// `window - reserve_tokens`.
    pub reserve_tokens: u64,
    /// Most recent messages always kept verbatim.
    pub keep_recent: usize,
    pub strategy: Strategy,
    /// Longest summary asked for.
    pub summary_max_tokens: u64,
    pub origins: Origins,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Origins {
    pub auto: Origin,
    pub reserve_tokens: Origin,
    pub keep_recent: Origin,
    pub strategy: Origin,
    pub summary_max_tokens: Origin,
}

pub const DEFAULT_RESERVE_TOKENS: u64 = 16_384;
pub const DEFAULT_KEEP_RECENT: usize = 8;
pub const DEFAULT_SUMMARY_MAX_TOKENS: u64 = 512;

impl Default for Policy {
    fn default() -> Self {
        Self {
            auto: true,
            reserve_tokens: DEFAULT_RESERVE_TOKENS,
            keep_recent: DEFAULT_KEEP_RECENT,
            strategy: Strategy::Summarize,
            summary_max_tokens: DEFAULT_SUMMARY_MAX_TOKENS,
            origins: Origins {
                auto: Origin::Default,
                reserve_tokens: Origin::Default,
                keep_recent: Origin::Default,
                strategy: Origin::Default,
                summary_max_tokens: Origin::Default,
            },
        }
    }
}

/// One file's contents: every field optional, unknown fields refused.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserve_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_recent: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<Strategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_max_tokens: Option<u64>,
}

pub fn user_path(data_folder: &Path) -> PathBuf {
    data_folder.join("compaction.json")
}

pub fn project_path(project_root: &Path) -> PathBuf {
    project_root.join(".jan").join("agent").join("compaction.json")
}

fn invalid(path: &Path, message: impl std::fmt::Display) -> HarnessError {
    HarnessError::new(
        ErrorKind::InvalidInput,
        format!("{}: {message}", path.file_name().map(|f| f.to_string_lossy()).unwrap_or_default()),
    )
    .at(Stage::Startup)
}

impl Layer {
    /// Refuse values no surface could honour.
    pub fn validate(&self, path: &Path) -> Result<(), HarnessError> {
        if let Some(k) = self.keep_recent {
            if !(2..=200).contains(&k) {
                return Err(invalid(path, format!("keepRecent must be between 2 and 200, not {k}")));
            }
        }
        if let Some(r) = self.reserve_tokens {
            if r > 1_000_000 {
                return Err(invalid(path, format!("reserveTokens must be at most 1000000, not {r}")));
            }
        }
        if let Some(s) = self.summary_max_tokens {
            if !(64..=8192).contains(&s) {
                return Err(invalid(path, format!("summaryMaxTokens must be between 64 and 8192, not {s}")));
            }
        }
        Ok(())
    }

    /// Read a layer. No file is an empty layer, which is not an error.
    pub fn read(path: &Path) -> Result<Self, HarnessError> {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(invalid(path, format!("could not be read: {e}"))),
        };
        let layer: Layer = serde_json::from_str(&raw).map_err(|e| invalid(path, e))?;
        layer.validate(path)?;
        Ok(layer)
    }
}

impl Policy {
    fn apply(&mut self, layer: &Layer, origin: Origin) {
        if let Some(v) = layer.auto {
            self.auto = v;
            self.origins.auto = origin;
        }
        if let Some(v) = layer.reserve_tokens {
            self.reserve_tokens = v;
            self.origins.reserve_tokens = origin;
        }
        if let Some(v) = layer.keep_recent {
            self.keep_recent = v;
            self.origins.keep_recent = origin;
        }
        if let Some(v) = layer.strategy {
            self.strategy = v;
            self.origins.strategy = origin;
        }
        if let Some(v) = layer.summary_max_tokens {
            self.summary_max_tokens = v;
            self.origins.summary_max_tokens = origin;
        }
    }

    /// The effective policy: defaults, then the user's file, then the
    /// project's. `legacy_reserve` is `[agent].compaction_reserve_tokens`, kept
    /// working as a project-level value when the project's file does not set
    /// one.
    pub fn resolve(
        data_folder: Option<&Path>,
        project_root: Option<&Path>,
        legacy_reserve: Option<u64>,
    ) -> Result<Self, HarnessError> {
        let mut policy = Self::default();
        if let Some(data) = data_folder {
            policy.apply(&Layer::read(&user_path(data))?, Origin::User);
        }
        if let Some(reserve) = legacy_reserve {
            policy.apply(&Layer { reserve_tokens: Some(reserve), ..Default::default() }, Origin::Project);
        }
        if let Some(root) = project_root {
            policy.apply(&Layer::read(&project_path(root))?, Origin::Project);
        }
        Ok(policy)
    }

    /// The reserve actually kept free in a window of this size: never more
    /// than a quarter of it. A 16K reserve is sensible headroom in a 128K
    /// window and would leave nothing at all in a 4K local model's, so the
    /// same policy has to mean the same proportion on every surface.
    pub fn effective_reserve(&self, context_window: u64) -> u64 {
        self.reserve_tokens.min(context_window / 4)
    }

    /// Whether compaction should run proactively at this usage.
    pub fn should_compact(&self, used_tokens: u64, context_window: u64) -> bool {
        self.auto
            && used_tokens > 0
            && used_tokens > context_window.saturating_sub(self.effective_reserve(context_window))
    }
}

/// Write the user's layer atomically, validated first.
pub fn save_user(data_folder: &Path, layer: &Layer) -> Result<(), HarnessError> {
    let path = user_path(data_folder);
    layer.validate(&path)?;
    std::fs::create_dir_all(data_folder)
        .map_err(|e| HarnessError::new(ErrorKind::Io, format!("the data folder is not writable: {e}")).at(Stage::Persistence))?;
    let text = serde_json::to_string_pretty(layer).unwrap_or_else(|_| "{}".into());
    let tmp = path.with_extension("json.partial");
    std::fs::write(&tmp, format!("{text}\n"))
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            HarnessError::new(ErrorKind::Io, format!("compaction.json could not be written: {e}")).at(Stage::Persistence)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan_compaction_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(d.join(".jan").join("agent")).unwrap();
        d
    }

    #[test]
    fn layers_apply_in_order_and_each_value_says_where_it_came_from() {
        let data = temp("data");
        let project = temp("project");
        assert_eq!(Policy::resolve(Some(&data), Some(&project), None).unwrap(), Policy::default());

        std::fs::write(user_path(&data), r#"{"keepRecent": 4, "strategy": "trim", "reserveTokens": 1000}"#).unwrap();
        std::fs::write(project_path(&project), r#"{"reserveTokens": 2000}"#).unwrap();
        let p = Policy::resolve(Some(&data), Some(&project), None).unwrap();
        assert_eq!((p.keep_recent, p.strategy, p.reserve_tokens), (4, Strategy::Trim, 2000));
        assert_eq!(p.origins.keep_recent, Origin::User);
        assert_eq!(p.origins.reserve_tokens, Origin::Project);
        assert_eq!(p.origins.auto, Origin::Default);
    }

    #[test]
    fn the_legacy_reserve_key_still_works_and_the_project_file_outranks_it() {
        let project = temp("legacy");
        let p = Policy::resolve(None, Some(&project), Some(4096)).unwrap();
        assert_eq!((p.reserve_tokens, p.origins.reserve_tokens), (4096, Origin::Project));
        std::fs::write(project_path(&project), r#"{"reserveTokens": 8192}"#).unwrap();
        assert_eq!(Policy::resolve(None, Some(&project), Some(4096)).unwrap().reserve_tokens, 8192);
    }

    #[test]
    fn a_file_that_cannot_be_honoured_is_refused_by_name_not_replaced_by_defaults() {
        let data = temp("bad");
        for (text, needle) in [
            (r#"{"keepRecent": 1}"#, "keepRecent"),
            (r#"{"summaryMaxTokens": 9999999}"#, "summaryMaxTokens"),
            (r#"{"reserveTokens": 99999999}"#, "reserveTokens"),
            (r#"{"strategy": "forget"}"#, "forget"),
            (r#"{"keepRecnt": 4}"#, "keepRecnt"),
            ("not json", "compaction.json"),
        ] {
            std::fs::write(user_path(&data), text).unwrap();
            let err = Policy::resolve(Some(&data), None, None).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidInput);
            assert!(err.message().contains(needle), "{text}: {}", err.message());
        }
    }

    #[test]
    fn should_compact_follows_auto_and_the_reserve() {
        let mut p = Policy::default();
        p.reserve_tokens = 1000;
        assert!(!p.should_compact(8000, 10_000));
        assert!(p.should_compact(9001, 10_000));
        assert!(!p.should_compact(0, 10_000));
        p.auto = false;
        assert!(!p.should_compact(9999, 10_000));
        // A reserve larger than the window allows keeps a quarter of it free,
        // not all of it.
        let big = Policy::default();
        assert_eq!(big.effective_reserve(4096), 1024);
        assert!(!big.should_compact(2000, 4096));
        assert!(big.should_compact(3100, 4096));
        assert_eq!(big.effective_reserve(128_000), 16_384);
    }

    #[test]
    fn saving_is_validated_and_survives_a_fresh_read() {
        let data = temp("save");
        assert!(save_user(&data, &Layer { keep_recent: Some(0), ..Default::default() }).is_err());
        assert!(!user_path(&data).exists(), "an invalid policy is never written");
        save_user(&data, &Layer { auto: Some(false), keep_recent: Some(12), ..Default::default() }).unwrap();
        let p = Policy::resolve(Some(&data), None, None).unwrap();
        assert_eq!((p.auto, p.keep_recent), (false, 12));
    }
}
