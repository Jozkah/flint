//! A session's canonical events, written out for analysis elsewhere. AH-177.
//!
//! An export is a folder under `<data>/exports/`:
//!
//! * `events.jsonl` -- the envelopes (`event_log`), in log order;
//! * `manifest.json` -- what it is, whose, how many, the first and last
//!   sequence numbers, whether content was included, and the SHA-256 of
//!   `events.jsonl`.
//!
//! By default an export is metadata only: each payload is cut down to a short
//! list of fields that describe what happened without saying what was in it
//! (a status, a phase, a tool's name, a duration, an exit code). Prompts,
//! tool inputs and outputs, paths, file content and memory are included only
//! when the caller asks for them, and even then the payloads are the ones the
//! log stored, which were redacted before they were written.
//!
//! Nothing is sent anywhere. The folder is assembled under a `.partial` name
//! and renamed only when complete; stopping or failing part-way removes it.
//!
//! [`inspect`] reads an export back as untrusted input: exactly the two files,
//! no links, a strict manifest, a hash that matches, lines that are all
//! envelopes of one session in strictly increasing order. It reports what is
//! there and never acts on any of it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::event_log::{self, decode_line, Envelope, LogError, ENVELOPE_VERSION};

pub const EXPORT_SCHEMA: u32 = 1;
pub const EXPORT_KIND: &str = "jan-event-export";
pub const MAX_EVENTS: usize = 200_000;
pub const MAX_EXPORT_BYTES: u64 = 64 * 1024 * 1024;

/// Payload fields kept in a metadata-only export: what happened, never what
/// was in it.
pub const METADATA_FIELDS: &[&str] = &[
    "status", "phase", "stoppedBy", "tool", "capability", "resourceKind", "agent", "elapsedMs",
    "exitCode", "index", "max", "count", "model", "decision",
];

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportErrorKind {
    NoEvents,
    TooLarge,
    Cancelled,
    /// The session's own log cannot be read (see `LogError`).
    LogUnreadable,
    /// Inspecting: not an export folder, or it holds something else.
    NotAnExport,
    UnsupportedVersion,
    ManifestInvalid,
    HashMismatch,
    /// Inspecting: a line that is not an envelope, or fewer lines than the
    /// manifest says.
    Truncated,
    /// Inspecting: an event of another session than the manifest names.
    CrossSession,
    /// Inspecting: sequence numbers that do not strictly increase.
    OutOfOrder,
    Io,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportError {
    pub kind: ExportErrorKind,
    pub message: String,
}

impl ExportError {
    pub fn new(kind: ExportErrorKind, message: impl Into<String>) -> Self {
        ExportError { kind, message: message.into() }
    }
}

fn io(e: impl std::fmt::Display) -> ExportError {
    ExportError::new(ExportErrorKind::Io, e.to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub kind: String,
    pub envelope_version: u16,
    pub session: String,
    #[serde(default)]
    pub run: Option<String>,
    pub metadata_only: bool,
    pub count: usize,
    pub first_seq: u64,
    pub last_seq: u64,
    pub events_sha256: String,
    pub created_at: String,
    pub note: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub manifest: Manifest,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InspectReport {
    pub manifest: Manifest,
    /// How many events of each kind, and how many kinds this build does not
    /// know (kept, not interpreted).
    pub kinds: BTreeMap<String, usize>,
    pub unknown_kinds: usize,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn metadata_only(payload: &Value) -> Value {
    let mut out = Map::new();
    if let Value::Object(map) = payload {
        for key in METADATA_FIELDS {
            if let Some(v) = map.get(*key) {
                // Scalars only: a nested value could carry anything.
                if v.is_number() || v.is_boolean() || (v.is_string() && v.as_str().is_some_and(|s| s.len() <= 64)) {
                    out.insert((*key).to_string(), v.clone());
                }
            }
        }
    }
    Value::Object(out)
}

fn exports_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("exports")
}

/// Write a session's events (one run's, if `run` is given) to a new export.
pub fn export(
    data_folder: &Path,
    session: &str,
    run: Option<&str>,
    include_content: bool,
    cancel: &AtomicBool,
) -> Result<ExportReport, ExportError> {
    let events = event_log::read_session(data_folder, session)
        .map_err(|e| ExportError::new(ExportErrorKind::LogUnreadable, e.message()))?;
    let events: Vec<Envelope> = events.into_iter().filter(|e| run.map_or(true, |r| e.run == r)).collect();
    if events.is_empty() {
        return Err(ExportError::new(ExportErrorKind::NoEvents, "there are no recorded events to export"));
    }
    if events.len() > MAX_EVENTS {
        return Err(ExportError::new(ExportErrorKind::TooLarge, "there are more events than an export holds"));
    }
    let dir = exports_dir(data_folder);
    std::fs::create_dir_all(&dir).map_err(io)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{:013}", d.as_millis()))
        .unwrap_or_default();
    let short: String = sha256_hex(session.as_bytes())[..8].to_string();
    let name = format!("events-{stamp}-{short}");
    let partial = dir.join(format!("{name}.partial"));
    let done = dir.join(&name);

    let build = || -> Result<Manifest, ExportError> {
        std::fs::create_dir_all(&partial).map_err(io)?;
        let mut body = String::new();
        for e in &events {
            if cancel.load(Ordering::SeqCst) {
                return Err(ExportError::new(ExportErrorKind::Cancelled, "the export was stopped; nothing was kept"));
            }
            let mut e = e.clone();
            if !include_content {
                e.payload = metadata_only(&e.payload);
            }
            body.push_str(&serde_json::to_string(&e).map_err(io)?);
            body.push('\n');
            if body.len() as u64 > MAX_EXPORT_BYTES {
                return Err(ExportError::new(ExportErrorKind::TooLarge, "the export would be larger than allowed"));
            }
        }
        std::fs::write(partial.join("events.jsonl"), body.as_bytes()).map_err(io)?;
        let manifest = Manifest {
            schema_version: EXPORT_SCHEMA,
            kind: EXPORT_KIND.into(),
            envelope_version: ENVELOPE_VERSION,
            session: session.to_string(),
            run: run.map(str::to_string),
            metadata_only: !include_content,
            count: events.len(),
            first_seq: events.first().map_or(0, |e| e.seq),
            last_seq: events.last().map_or(0, |e| e.seq),
            events_sha256: sha256_hex(body.as_bytes()),
            created_at: crate::audit::now(),
            note: if include_content {
                "Includes the recorded payloads (redacted when they were recorded): prompts, tool inputs and outputs, paths. Share with care.".into()
            } else {
                "Metadata only: kinds, order, identities, times, statuses. No prompts, tool inputs or outputs, paths or content.".into()
            },
        };
        std::fs::write(partial.join("manifest.json"), serde_json::to_vec_pretty(&manifest).map_err(io)?).map_err(io)?;
        if cancel.load(Ordering::SeqCst) {
            return Err(ExportError::new(ExportErrorKind::Cancelled, "the export was stopped; nothing was kept"));
        }
        std::fs::rename(&partial, &done).map_err(io)?;
        Ok(manifest)
    };
    match build() {
        Ok(manifest) => Ok(ExportReport { path: done.to_string_lossy().to_string(), manifest }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&partial);
            Err(e)
        }
    }
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Read an export as untrusted input and say what it holds. Nothing in it is
/// run, replayed or applied.
pub fn inspect(path: &Path) -> Result<InspectReport, ExportError> {
    let not_export = |m: &str| ExportError::new(ExportErrorKind::NotAnExport, m.to_string());
    let meta = std::fs::symlink_metadata(path).map_err(|_| not_export("there is no export at that path"))?;
    if is_link(&meta) || !meta.is_dir() {
        return Err(not_export("an export is the folder Jan wrote"));
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(path).map_err(io)? {
        let entry = entry.map_err(io)?;
        let m = std::fs::symlink_metadata(entry.path()).map_err(io)?;
        if is_link(&m) || !m.is_file() {
            return Err(not_export("the export holds a link or a folder"));
        }
        if m.len() > MAX_EXPORT_BYTES {
            return Err(ExportError::new(ExportErrorKind::TooLarge, "the export is larger than allowed"));
        }
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    names.sort();
    if names != ["events.jsonl", "manifest.json"] {
        return Err(not_export("an export holds exactly events.jsonl and manifest.json"));
    }
    let raw: Value = serde_json::from_slice(&std::fs::read(path.join("manifest.json")).map_err(io)?)
        .map_err(|e| ExportError::new(ExportErrorKind::ManifestInvalid, format!("the manifest is not JSON: {e}")))?;
    if raw.get("kind").and_then(Value::as_str) != Some(EXPORT_KIND) {
        return Err(not_export("the manifest is not an event export's"));
    }
    match raw.get("schemaVersion").and_then(Value::as_u64) {
        Some(v) if v == u64::from(EXPORT_SCHEMA) => {}
        Some(v) => return Err(ExportError::new(ExportErrorKind::UnsupportedVersion, format!("export schema {v} is not one this build reads"))),
        None => return Err(ExportError::new(ExportErrorKind::ManifestInvalid, "the manifest has no schema version")),
    }
    let manifest: Manifest = serde_json::from_value(raw)
        .map_err(|e| ExportError::new(ExportErrorKind::ManifestInvalid, format!("the manifest is malformed: {e}")))?;
    if manifest.envelope_version > ENVELOPE_VERSION {
        return Err(ExportError::new(ExportErrorKind::UnsupportedVersion, "the events use a newer envelope than this build reads"));
    }
    let body = std::fs::read(path.join("events.jsonl")).map_err(io)?;
    if sha256_hex(&body) != manifest.events_sha256 {
        return Err(ExportError::new(ExportErrorKind::HashMismatch, "events.jsonl does not match the manifest's hash"));
    }
    let text = String::from_utf8(body).map_err(|_| ExportError::new(ExportErrorKind::Truncated, "events.jsonl is not text"))?;
    let mut kinds = BTreeMap::new();
    let mut unknown = 0;
    let mut last_seq = 0u64;
    let mut count = 0usize;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let e = decode_line(line).map_err(|e| match e {
            LogError::UnsupportedVersion(v) => ExportError::new(ExportErrorKind::UnsupportedVersion, format!("an event uses envelope version {v}")),
            other => ExportError::new(ExportErrorKind::Truncated, other.message()),
        })?;
        if e.session != manifest.session {
            return Err(ExportError::new(ExportErrorKind::CrossSession, "the export holds events of another session"));
        }
        if let Some(run) = &manifest.run {
            if &e.run != run {
                return Err(ExportError::new(ExportErrorKind::CrossSession, "the export holds events of another run"));
            }
        }
        if count > 0 && e.seq <= last_seq {
            return Err(ExportError::new(ExportErrorKind::OutOfOrder, "the events are not in log order"));
        }
        last_seq = e.seq;
        if !e.is_known() {
            unknown += 1;
        }
        *kinds.entry(e.kind).or_insert(0) += 1;
        count += 1;
        if count > MAX_EVENTS {
            return Err(ExportError::new(ExportErrorKind::TooLarge, "the export holds more events than allowed"));
        }
    }
    if count != manifest.count {
        return Err(ExportError::new(
            ExportErrorKind::Truncated,
            format!("the manifest says {} events and the file holds {count}", manifest.count),
        ));
    }
    Ok(InspectReport { manifest, kinds, unknown_kinds: unknown })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_log::{append, NewEvent};
    use serde_json::json;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-evexport-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed(d: &Path) {
        let mut add = |id: &str, run: &str, kind: &str, payload: Value| {
            append(d, NewEvent { id: id.into(), session: "s1".into(), run: run.into(), invocation: String::new(), kind: kind.into(), payload }).unwrap();
        };
        add("a", "r1", "run.started", json!({ "model": "m", "title": "fix the login bug in C:/work/app" }));
        add("b", "r1", "tool.requested", json!({ "tool": "read", "resource": "C:/work/app/src/secret.rs", "summary": "read the file" }));
        add("c", "r1", "tool.succeeded", json!({ "tool": "read", "elapsedMs": 12 }));
        add("d", "r1", "run.ended", json!({ "stoppedBy": "done" }));
        add("e", "r2", "run.started", json!({ "model": "m" }));
        append(d, NewEvent { id: "x".into(), session: "s2".into(), run: "r9".into(), invocation: String::new(), kind: "run.started".into(), payload: json!({}) }).unwrap();
    }

    #[test]
    fn a_metadata_only_export_keeps_order_and_leaves_content_out() {
        let d = dir("meta");
        seed(&d);
        let report = export(&d, "s1", None, false, &AtomicBool::new(false)).unwrap();
        assert!(report.manifest.metadata_only);
        assert_eq!(report.manifest.count, 5);
        let body = std::fs::read_to_string(Path::new(&report.path).join("events.jsonl")).unwrap();
        for leaked in ["C:/work", "secret.rs", "fix the login", "read the file"] {
            assert!(!body.contains(leaked), "{leaked} reached a metadata-only export");
        }
        assert!(body.contains("\"tool\":\"read\"") && body.contains("\"elapsedMs\":12"));
        let back = inspect(Path::new(&report.path)).unwrap();
        assert_eq!(back.kinds["run.started"], 2);
        assert_eq!(back.manifest.first_seq, 1);
        assert_eq!(back.manifest.last_seq, 5);
        assert!(!body.contains("\"session\":\"s2\""), "another session's events are not exported");
    }

    #[test]
    fn content_is_exported_only_when_asked_and_one_run_can_be_chosen() {
        let d = dir("content");
        seed(&d);
        let report = export(&d, "s1", Some("r1"), true, &AtomicBool::new(false)).unwrap();
        assert!(!report.manifest.metadata_only);
        assert_eq!(report.manifest.count, 4);
        let body = std::fs::read_to_string(Path::new(&report.path).join("events.jsonl")).unwrap();
        assert!(body.contains("secret.rs"));
        assert!(!body.contains("\"run\":\"r2\""));
        assert_eq!(inspect(Path::new(&report.path)).unwrap().manifest.run.as_deref(), Some("r1"));
    }

    #[test]
    fn nothing_to_export_and_a_stopped_export_leave_nothing() {
        let d = dir("refuse");
        assert_eq!(export(&d, "s1", None, false, &AtomicBool::new(false)).unwrap_err().kind, ExportErrorKind::NoEvents);
        seed(&d);
        let err = export(&d, "s1", None, false, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err.kind, ExportErrorKind::Cancelled);
        assert_eq!(std::fs::read_dir(exports_dir(&d)).unwrap().count(), 0, "a stopped export left something");
    }

    #[test]
    fn a_damaged_or_foreign_export_is_a_typed_refusal() {
        let d = dir("inspect");
        seed(&d);
        let good = PathBuf::from(export(&d, "s1", None, true, &AtomicBool::new(false)).unwrap().path);
        let variant = |tag: &str, change: &dyn Fn(&Path)| -> PathBuf {
            let out = d.join(format!("v-{tag}"));
            std::fs::create_dir_all(&out).unwrap();
            for f in ["events.jsonl", "manifest.json"] {
                std::fs::copy(good.join(f), out.join(f)).unwrap();
            }
            change(&out);
            out
        };
        let rewrite = |p: &Path, f: &dyn Fn(String) -> String| {
            let t = std::fs::read_to_string(p).unwrap();
            std::fs::write(p, f(t)).unwrap();
        };
        let rehash = |p: &Path| {
            let body = std::fs::read(p.join("events.jsonl")).unwrap();
            let m = p.join("manifest.json");
            let mut v: Value = serde_json::from_slice(&std::fs::read(&m).unwrap()).unwrap();
            v["eventsSha256"] = json!(sha256_hex(&body));
            std::fs::write(m, serde_json::to_vec(&v).unwrap()).unwrap();
        };
        let cases: Vec<(&str, PathBuf, ExportErrorKind)> = vec![
            ("tampered", variant("tampered", &|p| rewrite(&p.join("events.jsonl"), &|t| t.replace("read", "rm"))), ExportErrorKind::HashMismatch),
            ("truncated", variant("truncated", &|p| {
                rewrite(&p.join("events.jsonl"), &|t| t[..t.len() / 2].to_string());
                rehash(p);
            }), ExportErrorKind::Truncated),
            ("cross-session", variant("cross", &|p| {
                rewrite(&p.join("events.jsonl"), &|t| t.replacen("\"session\":\"s1\"", "\"session\":\"s2\"", 1));
                rehash(p);
            }), ExportErrorKind::CrossSession),
            ("out-of-order", variant("order", &|p| {
                rewrite(&p.join("events.jsonl"), &|t| {
                    let mut lines: Vec<&str> = t.lines().collect();
                    lines.swap(0, 1);
                    lines.join("\n") + "\n"
                });
                rehash(p);
            }), ExportErrorKind::OutOfOrder),
            ("version", variant("version", &|p| rewrite(&p.join("manifest.json"), &|t| t.replace("\"schemaVersion\": 1", "\"schemaVersion\": 7"))), ExportErrorKind::UnsupportedVersion),
            ("extra", variant("extra", &|p| std::fs::write(p.join("run.sh"), "echo").unwrap()), ExportErrorKind::NotAnExport),
            ("unknown-field", variant("field", &|p| rewrite(&p.join("manifest.json"), &|t| t.replacen('{', "{\"exec\": \"x\",", 1))), ExportErrorKind::ManifestInvalid),
        ];
        for (tag, path, kind) in cases {
            assert_eq!(inspect(&path).unwrap_err().kind, kind, "{tag}");
        }
        assert_eq!(inspect(&d.join("nope")).unwrap_err().kind, ExportErrorKind::NotAnExport);
    }
}
