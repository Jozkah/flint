//! Schema versioning and per-item health classification.
//!
//! The migration needs to know two things about the legacy data before it
//! touches anything: what *schema version* it was written by (so it can refuse
//! data from a newer, unknown Flint), and whether each individual item is
//! healthy enough to copy. Both are pure functions over the filesystem so they
//! are trivially testable.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The newest schema version this build of the migration understands. Data
/// written by exactly this version (or older) can be migrated; anything
/// numerically greater is [`ItemStatus::NewerThanSupported`] and must not be
/// blindly consumed.
pub const SUPPORTED_SCHEMA: u32 = 1;

/// The JSON key holding the schema version inside `settings.json` (and inside
/// any per-category descriptor that carries one).
pub const SCHEMA_VERSION_KEY: &str = "schema_version";

/// Health of a single migratable item (a file or a directory).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ItemStatus {
    /// Present and (for JSON) parseable.
    Ok,
    /// Present but unparseable JSON — quarantined, never migrated in place.
    Corrupt(String),
    /// A half-written artefact: `.tmp`/temp name, or a zero-byte file.
    Partial(String),
    /// The item does not exist.
    Missing,
    /// Written by a schema newer than [`SUPPORTED_SCHEMA`].
    NewerThanSupported(u32),
}

impl ItemStatus {
    /// Whether this item is safe to copy verbatim into Flint.
    pub fn is_migratable(&self) -> bool {
        matches!(self, ItemStatus::Ok)
    }

    /// Whether this item is present but damaged (corrupt or partial) and should
    /// be quarantined rather than dropped silently.
    pub fn is_quarantinable(&self) -> bool {
        matches!(self, ItemStatus::Corrupt(_) | ItemStatus::Partial(_))
    }

    /// A short, content-free reason string (safe for the manifest).
    pub fn reason(&self) -> Option<String> {
        match self {
            ItemStatus::Corrupt(r) => Some(format!("corrupt: {r}")),
            ItemStatus::Partial(r) => Some(format!("partial: {r}")),
            ItemStatus::NewerThanSupported(v) => {
                Some(format!("schema {v} newer than supported {SUPPORTED_SCHEMA}"))
            }
            ItemStatus::Missing => Some("missing".to_string()),
            ItemStatus::Ok => None,
        }
    }
}

/// Read `schema_version` from a `settings.json`-shaped file.
///
/// Returns `Ok(None)` when the file is absent or has no `schema_version` key
/// (legacy data predates the field — treated as version 0 by callers, i.e.
/// supported). Returns `Err` only when the file exists but is unreadable or is
/// not valid JSON.
pub fn read_schema_version(settings_json: &Path) -> Result<Option<u32>, String> {
    if !settings_json.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(settings_json)
        .map_err(|e| format!("read {}: {e}", settings_json.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("parse {}: {e}", settings_json.display()))?;
    Ok(value
        .get(SCHEMA_VERSION_KEY)
        .and_then(|v| v.as_u64())
        .map(|v| v as u32))
}

/// Classify an item's health.
///
/// - missing path                          -> [`ItemStatus::Missing`]
/// - `.tmp`/temp-suffixed name, zero-byte  -> [`ItemStatus::Partial`]
/// - `.json` that fails to parse           -> [`ItemStatus::Corrupt`]
/// - otherwise                             -> [`ItemStatus::Ok`]
///
/// `schema_version` is the version detected for the item's category (usually
/// the settings-wide version); when it exceeds [`SUPPORTED_SCHEMA`] the item is
/// reported as [`ItemStatus::NewerThanSupported`] regardless of parseability,
/// because consuming unknown-newer data is the more dangerous failure.
pub fn classify_item(path: &Path, schema_version: Option<u32>) -> ItemStatus {
    if let Some(v) = schema_version {
        if v > SUPPORTED_SCHEMA {
            return ItemStatus::NewerThanSupported(v);
        }
    }

    if !path.exists() {
        return ItemStatus::Missing;
    }

    // Partial: temp-named artefacts anywhere in the final path component.
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".tmp") || lower.ends_with(".partial") || lower.contains(".tmp.") {
            return ItemStatus::Partial(format!("temp artefact: {name}"));
        }
    }

    if path.is_file() {
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if len == 0 {
            return ItemStatus::Partial("zero-byte file".to_string());
        }
        // Only JSON is validated for parseability; opaque blobs (models,
        // encrypted secrets) are copied verbatim and never parsed.
        if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            match std::fs::read_to_string(path) {
                Ok(text) => {
                    if serde_json::from_str::<serde_json::Value>(&text).is_err() {
                        return ItemStatus::Corrupt("unparseable JSON".to_string());
                    }
                }
                Err(e) => return ItemStatus::Corrupt(format!("unreadable: {e}")),
            }
        }
    }

    ItemStatus::Ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        p
    }

    #[test]
    fn missing_settings_yields_none() {
        let td = tempfile::tempdir().unwrap();
        assert_eq!(
            read_schema_version(&td.path().join("nope.json")).unwrap(),
            None
        );
    }

    #[test]
    fn reads_and_defaults_schema_version() {
        let td = tempfile::tempdir().unwrap();
        let with = write(td.path(), "s1.json", br#"{"schema_version": 1, "x": 2}"#);
        let without = write(td.path(), "s2.json", br#"{"x": 2}"#);
        assert_eq!(read_schema_version(&with).unwrap(), Some(1));
        assert_eq!(read_schema_version(&without).unwrap(), None);
    }

    #[test]
    fn corrupt_settings_is_error() {
        let td = tempfile::tempdir().unwrap();
        let bad = write(td.path(), "bad.json", b"{not json");
        assert!(read_schema_version(&bad).is_err());
    }

    #[test]
    fn classify_missing_partial_corrupt_ok() {
        let td = tempfile::tempdir().unwrap();
        assert_eq!(
            classify_item(&td.path().join("gone.json"), None),
            ItemStatus::Missing
        );

        let empty = write(td.path(), "empty.json", b"");
        assert!(matches!(
            classify_item(&empty, None),
            ItemStatus::Partial(_)
        ));

        let tmp = write(td.path(), "thread.json.tmp", b"{}");
        assert!(matches!(classify_item(&tmp, None), ItemStatus::Partial(_)));

        let corrupt = write(td.path(), "c.json", b"{broken");
        assert!(matches!(
            classify_item(&corrupt, None),
            ItemStatus::Corrupt(_)
        ));

        let good = write(td.path(), "ok.json", br#"{"a":1}"#);
        assert_eq!(classify_item(&good, None), ItemStatus::Ok);

        // Opaque non-JSON blob is Ok even though it is not parseable JSON.
        let blob = write(td.path(), "provider_secrets.enc", b"\x00\x01\x02");
        assert_eq!(classify_item(&blob, None), ItemStatus::Ok);
    }

    #[test]
    fn newer_than_supported_wins() {
        let td = tempfile::tempdir().unwrap();
        let good = write(td.path(), "ok.json", br#"{"a":1}"#);
        assert_eq!(
            classify_item(&good, Some(SUPPORTED_SCHEMA + 1)),
            ItemStatus::NewerThanSupported(SUPPORTED_SCHEMA + 1)
        );
    }
}
