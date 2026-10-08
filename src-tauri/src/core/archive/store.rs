//! The archive: what "delete" means before "delete forever".
//!
//! Deleting a thread, a room, a Cowork session or a project moves it to
//! `<data>/.archive/<kind>/<id>/` instead of destroying it. Two shapes:
//!
//! * a directory item (threads, rooms) is the original directory, renamed
//!   into place, with a `meta.json` added. The list functions of the original
//!   stores only read their own directories, so an archived item is invisible
//!   to them without any change.
//! * a payload item (Cowork sessions, projects) has no directory of its own,
//!   so the caller hands over its JSON, which is kept as `payload.json`.
//!
//! Purge is the old delete. It is the only place anything is destroyed, and a
//! caller-supplied hook runs first so kind-specific cleanup (request records,
//! scratch dirs, the worktree guard) happens at purge and never at archive.
//!
//! Every id names one plain path component and is validated before the disk is
//! touched; the restore destination is derived from the kind and the id in
//! `meta.json`, never from a path stored in it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::threads::constants::THREADS_DIR;
use crate::core::threads::utils::validate_thread_id;

const ROOMS_DIR: &str = "rooms";

pub const ARCHIVE_DIR: &str = ".archive";
const META_FILE: &str = "meta.json";
pub(super) const PAYLOAD_FILE: &str = "payload.json";
const SETTINGS_FILE: &str = "archive-settings.json";
/// Collision suffixes tried before giving up.
const MAX_SUFFIX: u32 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Thread,
    Room,
    Cowork,
    Project,
    /// An assistant (agent profile); a payload.
    Assistant,
    /// A generated image or video: its media file and recipe.
    Studio,
}

impl Kind {
    pub const ALL: [Kind; 6] = [
        Kind::Thread,
        Kind::Room,
        Kind::Cowork,
        Kind::Project,
        Kind::Assistant,
        Kind::Studio,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Thread => "thread",
            Kind::Room => "room",
            Kind::Cowork => "cowork",
            Kind::Project => "project",
            Kind::Assistant => "assistant",
            Kind::Studio => "studio",
        }
    }

    pub fn parse(s: &str) -> Result<Kind, String> {
        Kind::ALL
            .into_iter()
            .find(|k| k.as_str() == s)
            .ok_or_else(|| format!("unknown archive kind {s:?}"))
    }

    /// Where live items of this kind sit, for kinds that are directories.
    fn live_dir(self, data: &Path) -> Option<PathBuf> {
        match self {
            Kind::Thread => Some(data.join(THREADS_DIR)),
            Kind::Room => Some(data.join(ROOMS_DIR)),
            Kind::Cowork | Kind::Project | Kind::Assistant | Kind::Studio => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    Dir,
    Payload,
    /// Loose files from a gallery folder; `extra.gallery` says which.
    Files,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMeta {
    pub kind: Kind,
    /// The id the item had when it was live.
    pub id: String,
    pub title: String,
    /// Milliseconds since the epoch.
    pub archived_at: u64,
    /// Where it came from, for display (`threads/<id>`); never used as a path.
    pub origin: String,
    pub storage: Storage,
    /// Kind-specific data the purge hook needs (a Cowork session's worktree).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedItem {
    /// The name of the item inside `.archive/<kind>/`; differs from
    /// `meta.id` when a collision added a suffix.
    pub archive_id: String,
    #[serde(flatten)]
    pub meta: ArchiveMeta,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub kind: Kind,
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeReport {
    pub purged: usize,
    /// Items the hook refused, with its reason, so nothing is lost silently.
    pub blocked: Vec<Blocked>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    pub kind: Kind,
    pub archive_id: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArchiveSettings {
    /// Off means delete behaves as it always did.
    pub enabled: bool,
    /// Purge archived items older than this many days; 0 keeps them forever.
    pub auto_delete_days: u32,
    /// Archive threads untouched for this many days; 0 is off.
    pub auto_archive_thread_days: u32,
}

impl Default for ArchiveSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_delete_days: 30,
            auto_archive_thread_days: 0,
        }
    }
}

/// The settings file next to the data, defaulting when absent or unreadable.
pub fn read_settings(data: &Path) -> ArchiveSettings {
    fs::read(data.join(SETTINGS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn write_settings(data: &Path, settings: &ArchiveSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    write_atomic(&data.join(SETTINGS_FILE), &bytes)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("write {}: {e}", path.display())
    })
}

fn check_id(id: &str) -> Result<(), String> {
    validate_thread_id(id)?;
    if id.starts_with('.') {
        return Err(format!("invalid id {id:?}"));
    }
    Ok(())
}

fn kind_dir(data: &Path, kind: Kind) -> PathBuf {
    data.join(ARCHIVE_DIR).join(kind.as_str())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A free name under `dir` for `id`: `id`, then `id-2`, `id-3`, ...
fn free_name(dir: &Path, id: &str) -> Result<String, String> {
    if fs::symlink_metadata(dir.join(id)).is_err() {
        return Ok(id.to_string());
    }
    for n in 2..=MAX_SUFFIX {
        let name = format!("{id}-{n}");
        if fs::symlink_metadata(dir.join(&name)).is_err() {
            return Ok(name);
        }
    }
    Err(format!("no free archive name for {id}"))
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir(&from, &to)?;
        } else if ty.is_file() {
            fs::copy(&from, &to)?;
        }
        // Links are not followed or recreated: an archive must not reach
        // outside the directory it was given.
    }
    Ok(())
}

/// Rename, or copy then remove when the rename cannot work (another volume, or
/// a handle that blocks the rename on Windows). The source is removed only
/// after the copy is complete; a failed copy removes the partial copy and
/// leaves the source alone.
fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    if let Err(e) = copy_dir(src, dst) {
        let _ = fs::remove_dir_all(dst);
        return Err(format!("archive {}: {e}", src.display()));
    }
    fs::remove_dir_all(src).map_err(|e| {
        format!(
            "archived {} but could not remove the original: {e}",
            src.display()
        )
    })
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

pub(super) fn read_meta(dir: &Path) -> Result<ArchiveMeta, String> {
    let bytes = fs::read(dir.join(META_FILE)).map_err(|e| format!("read {META_FILE}: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {META_FILE}: {e}"))
}

fn write_meta(dir: &Path, meta: &ArchiveMeta) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(META_FILE), &bytes)
}

fn make_meta(
    kind: Kind,
    id: &str,
    title: &str,
    storage: Storage,
    extra: Option<Value>,
) -> ArchiveMeta {
    let origin = match kind.live_dir(Path::new("")) {
        Some(rel) => format!("{}/{id}", rel.display()),
        None => kind.as_str().to_string(),
    };
    ArchiveMeta {
        kind,
        id: id.to_string(),
        title: title.to_string(),
        archived_at: now_ms(),
        origin,
        storage,
        extra,
    }
}

/// Move the live directory of a thread or room into the archive. Returns the
/// archive id. A missing source is an error: there is nothing to archive.
pub fn archive_dir(
    data: &Path,
    kind: Kind,
    id: &str,
    title: &str,
    extra: Option<Value>,
) -> Result<String, String> {
    check_id(id)?;
    let live = kind
        .live_dir(data)
        .ok_or_else(|| format!("{} is not a directory kind", kind.as_str()))?;
    let src = live.join(id);
    match fs::symlink_metadata(&src) {
        Ok(m) if m.is_dir() => {}
        _ => return Err(format!("{} {id} not found", kind.as_str())),
    }
    let dir = kind_dir(data, kind);
    fs::create_dir_all(&dir).map_err(|e| format!("create archive: {e}"))?;
    let name = free_name(&dir, id)?;
    let dst = dir.join(&name);
    move_dir(&src, &dst)?;
    if let Err(e) = write_meta(&dst, &make_meta(kind, id, title, Storage::Dir, extra)) {
        // Without its meta the item could not be listed; put it back.
        let _ = move_dir(&dst, &src);
        return Err(e);
    }
    Ok(name)
}

/// Keep a payload (a Cowork session, a project) in the archive.
pub fn archive_payload(
    data: &Path,
    kind: Kind,
    id: &str,
    title: &str,
    payload: &Value,
    extra: Option<Value>,
) -> Result<String, String> {
    check_id(id)?;
    if kind.live_dir(data).is_some() {
        return Err(format!("{} is a directory kind", kind.as_str()));
    }
    let dir = kind_dir(data, kind);
    fs::create_dir_all(&dir).map_err(|e| format!("create archive: {e}"))?;
    let name = free_name(&dir, id)?;
    let dst = dir.join(&name);
    fs::create_dir_all(&dst).map_err(|e| format!("create archive: {e}"))?;
    let result = serde_json::to_vec(payload)
        .map_err(|e| e.to_string())
        .and_then(|bytes| write_atomic(&dst.join(PAYLOAD_FILE), &bytes))
        .and_then(|_| write_meta(&dst, &make_meta(kind, id, title, Storage::Payload, extra)));
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&dst);
        return Err(e);
    }
    Ok(name)
}

/// The gallery folders a Studio result can come from, and the only ones a
/// restore will write to.
const GALLERIES: [&str; 2] = ["images", "videos"];
/// Every extension the gallery saves under (a hosted provider's JPEG or WebP
/// is kept as it came), so none is left behind by an archive.
const GALLERY_EXTS: [&str; 5] = ["png", "jpg", "webp", "webm", "json"];

/// Move one generated result (its media file and its recipe) out of
/// `<data>/<gallery>/` into the archive. `id` is the gallery's file stem.
pub fn archive_studio(
    data: &Path,
    gallery: &str,
    id: &str,
    title: &str,
) -> Result<String, String> {
    check_id(id)?;
    if !GALLERIES.contains(&gallery) {
        return Err(format!("unknown gallery {gallery:?}"));
    }
    let src = data.join(gallery);
    let files: Vec<PathBuf> = GALLERY_EXTS
        .iter()
        .map(|ext| src.join(format!("{id}.{ext}")))
        .filter(|p| p.is_file())
        .collect();
    if files.is_empty() {
        return Err(format!("{gallery} item {id} not found"));
    }
    let dir = kind_dir(data, Kind::Studio);
    fs::create_dir_all(&dir).map_err(|e| format!("create archive: {e}"))?;
    let name = free_name(&dir, &format!("{gallery}-{id}"))?;
    let dst = dir.join(&name);
    fs::create_dir_all(&dst).map_err(|e| format!("create archive: {e}"))?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| -> Result<(), String> {
        for file in &files {
            let to = dst.join(file.file_name().ok_or("bad file name")?);
            move_file(file, &to)?;
            moved.push((file.clone(), to));
        }
        let mut meta = make_meta(
            Kind::Studio,
            id,
            title,
            Storage::Files,
            Some(serde_json::json!({ "gallery": gallery })),
        );
        meta.origin = format!("{gallery}/{id}");
        write_meta(&dst, &meta)
    })();
    if let Err(e) = result {
        for (from, to) in moved.into_iter().rev() {
            let _ = move_file(&to, &from);
        }
        let _ = fs::remove_dir_all(&dst);
        return Err(e);
    }
    Ok(name)
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| format!("move {}: {e}", from.display()))?;
    fs::remove_file(from).map_err(|e| format!("move {}: {e}", from.display()))
}

/// Every archived item, newest first. Items whose meta cannot be read are
/// skipped (they are still on disk, and `purge` can remove them by name).
pub fn list(data: &Path) -> Vec<ArchivedItem> {
    let mut items = Vec::new();
    for kind in Kind::ALL {
        let Ok(entries) = fs::read_dir(kind_dir(data, kind)) else {
            continue;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(meta) = read_meta(&entry.path()) else {
                continue;
            };
            if meta.kind != kind {
                continue;
            }
            items.push(ArchivedItem {
                archive_id: name,
                size_bytes: dir_size(&entry.path()),
                meta,
            });
        }
    }
    items.sort_by(|a, b| {
        b.meta
            .archived_at
            .cmp(&a.meta.archived_at)
            .then_with(|| a.archive_id.cmp(&b.archive_id))
    });
    items
}

/// Total bytes held by the archive.
pub fn disk_usage(data: &Path) -> u64 {
    dir_size(&data.join(ARCHIVE_DIR))
}

pub(super) fn item_dir(data: &Path, kind: Kind, archive_id: &str) -> Result<PathBuf, String> {
    check_id(archive_id)?;
    let dir = kind_dir(data, kind).join(archive_id);
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => Ok(dir),
        _ => Err(format!("archived {} {archive_id} not found", kind.as_str())),
    }
}

/// Put an archived item back. A directory item returns to its live place; a
/// payload item hands its payload back for the caller to re-register.
pub fn restore(data: &Path, kind: Kind, archive_id: &str) -> Result<Restored, String> {
    let dir = item_dir(data, kind, archive_id)?;
    let meta = read_meta(&dir)?;
    // The destination comes from the validated id, not from anything stored.
    check_id(&meta.id)?;
    match meta.storage {
        Storage::Dir => {
            let live = kind
                .live_dir(data)
                .ok_or_else(|| format!("{} has no directory", kind.as_str()))?;
            let dst = live.join(&meta.id);
            if fs::symlink_metadata(&dst).is_ok() {
                return Err(format!(
                    "a {} with the id {} already exists, so \"{}\" was not restored",
                    kind.as_str(),
                    meta.id,
                    meta.title
                ));
            }
            fs::create_dir_all(&live).map_err(|e| format!("restore: {e}"))?;
            move_dir(&dir, &dst)?;
            let _ = fs::remove_file(dst.join(META_FILE));
            Ok(Restored {
                kind,
                id: meta.id,
                title: meta.title,
                payload: None,
                extra: meta.extra,
            })
        }
        Storage::Files => {
            let gallery = meta
                .extra
                .as_ref()
                .and_then(|e| e.get("gallery"))
                .and_then(Value::as_str)
                .filter(|g| GALLERIES.contains(g))
                .ok_or_else(|| "this archived item has no gallery to return to".to_string())?
                .to_string();
            let live = data.join(&gallery);
            let mut files = Vec::new();
            for entry in fs::read_dir(&dir).map_err(|e| format!("restore: {e}"))?.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == META_FILE {
                    continue;
                }
                // Only the files an archive of this id can hold go back.
                let ok = GALLERY_EXTS
                    .iter()
                    .any(|ext| name == format!("{}.{ext}", meta.id));
                if !ok {
                    return Err(format!("unexpected file {name} in an archived result"));
                }
                if live.join(&name).exists() {
                    return Err(format!(
                        "a result named {} already exists, so \"{}\" was not restored",
                        meta.id, meta.title
                    ));
                }
                files.push(name);
            }
            fs::create_dir_all(&live).map_err(|e| format!("restore: {e}"))?;
            for name in &files {
                move_file(&dir.join(name), &live.join(name))?;
            }
            fs::remove_dir_all(&dir).map_err(|e| format!("restore: {e}"))?;
            Ok(Restored {
                kind,
                id: meta.id,
                title: meta.title,
                payload: None,
                extra: meta.extra,
            })
        }
        Storage::Payload => {
            let bytes = fs::read(dir.join(PAYLOAD_FILE)).map_err(|e| format!("read payload: {e}"))?;
            let payload: Value =
                serde_json::from_slice(&bytes).map_err(|e| format!("parse payload: {e}"))?;
            fs::remove_dir_all(&dir).map_err(|e| format!("restore: {e}"))?;
            Ok(Restored {
                kind,
                id: meta.id,
                title: meta.title,
                payload: Some(payload),
                extra: meta.extra,
            })
        }
    }
}

/// Destroy one archived item. `hook` runs first and may refuse; when it does
/// nothing is removed. An item whose meta cannot be read gets a default meta so
/// a corrupt entry can still be cleared.
pub fn purge_with<F>(data: &Path, kind: Kind, archive_id: &str, hook: &mut F) -> Result<(), String>
where
    F: FnMut(&ArchiveMeta, &Path) -> Result<(), String>,
{
    let dir = item_dir(data, kind, archive_id)?;
    if let Ok(meta) = read_meta(&dir) {
        hook(&meta, &dir)?;
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("delete {}: {e}", dir.display()))
}

/// Purge every item (optionally one kind, optionally only those archived at or
/// before `cutoff_ms`). Refused items are reported, not retried.
pub fn purge_matching<F>(
    data: &Path,
    kind: Option<Kind>,
    cutoff_ms: Option<u64>,
    hook: &mut F,
) -> PurgeReport
where
    F: FnMut(&ArchiveMeta, &Path) -> Result<(), String>,
{
    let mut report = PurgeReport::default();
    for item in list(data) {
        if kind.is_some_and(|k| k != item.meta.kind) {
            continue;
        }
        if cutoff_ms.is_some_and(|c| item.meta.archived_at > c) {
            continue;
        }
        match purge_with(data, item.meta.kind, &item.archive_id, hook) {
            Ok(()) => report.purged += 1,
            Err(reason) => report.blocked.push(Blocked {
                kind: item.meta.kind,
                archive_id: item.archive_id,
                title: item.meta.title,
                reason,
            }),
        }
    }
    report
}

/// Startup sweep: purge what is older than the retention. 0 days keeps all.
pub fn sweep<F>(data: &Path, auto_delete_days: u32, now: u64, hook: &mut F) -> PurgeReport
where
    F: FnMut(&ArchiveMeta, &Path) -> Result<(), String>,
{
    if auto_delete_days == 0 {
        return PurgeReport::default();
    }
    let span = u64::from(auto_delete_days) * 86_400_000;
    purge_matching(data, None, Some(now.saturating_sub(span)), hook)
}

/// Archive threads whose last activity is older than `days`. Activity is the
/// newer of the thread's `updated` stamp (seconds) and its message file's
/// modification time, so a thread that is still being written to is never old.
/// Favourites are left alone. Returns the ids archived.
pub fn auto_archive_threads(data: &Path, days: u32, now: u64) -> Vec<String> {
    if days == 0 {
        return Vec::new();
    }
    let cutoff_ms = now.saturating_sub(u64::from(days) * 86_400_000);
    let Ok(entries) = fs::read_dir(data.join(THREADS_DIR)) else {
        return Vec::new();
    };
    let mut archived = Vec::new();
    for entry in entries.flatten() {
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if check_id(&id).is_err() || !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let Ok(bytes) = fs::read(dir.join("thread.json")) else {
            continue;
        };
        let Ok(thread) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if thread.get("isFavorite").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let stamp_ms = thread
            .get("updated")
            .and_then(Value::as_f64)
            .map(|s| (s * 1000.0) as u64)
            .unwrap_or(0);
        let file_ms = ["thread.json", "messages.jsonl"]
            .iter()
            .filter_map(|f| fs::metadata(dir.join(f)).ok())
            .filter_map(|m| m.modified().ok())
            .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .max()
            .unwrap_or(0);
        if stamp_ms.max(file_ms) > cutoff_ms {
            continue;
        }
        let title = thread
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if archive_dir(data, Kind::Thread, &id, &title, None).is_ok() {
            archived.push(id);
        }
    }
    archived
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn data() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn thread(data: &Path, id: &str, updated: f64) {
        let dir = data.join(THREADS_DIR).join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("thread.json"),
            json!({"id": id, "title": format!("t {id}"), "updated": updated}).to_string(),
        )
        .unwrap();
        fs::write(dir.join("messages.jsonl"), "{\"a\":1}\n").unwrap();
    }

    fn allow(_: &ArchiveMeta, _: &Path) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn archive_hides_the_thread_and_restore_returns_it() {
        let d = data();
        thread(d.path(), "abc", 1.0);
        let name = archive_dir(d.path(), Kind::Thread, "abc", "t abc", None).unwrap();
        assert_eq!(name, "abc");
        assert!(!d.path().join("threads/abc").exists());
        let items = list(d.path());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].meta.title, "t abc");
        assert!(items[0].size_bytes > 0);

        let restored = restore(d.path(), Kind::Thread, "abc").unwrap();
        assert_eq!(restored.id, "abc");
        assert!(d.path().join("threads/abc/thread.json").exists());
        assert!(!d.path().join("threads/abc/meta.json").exists());
        assert!(list(d.path()).is_empty());
    }

    #[test]
    fn a_second_archive_of_the_same_id_gets_a_suffix() {
        let d = data();
        thread(d.path(), "abc", 1.0);
        archive_dir(d.path(), Kind::Thread, "abc", "one", None).unwrap();
        thread(d.path(), "abc", 2.0);
        let second = archive_dir(d.path(), Kind::Thread, "abc", "two", None).unwrap();
        assert_eq!(second, "abc-2");
        // Restoring the suffixed one brings back the original id.
        let restored = restore(d.path(), Kind::Thread, "abc-2").unwrap();
        assert_eq!(restored.id, "abc");
        assert_eq!(restored.title, "two");
    }

    #[test]
    fn restore_refuses_to_overwrite_a_live_item() {
        let d = data();
        thread(d.path(), "abc", 1.0);
        archive_dir(d.path(), Kind::Thread, "abc", "old", None).unwrap();
        thread(d.path(), "abc", 2.0);
        let err = restore(d.path(), Kind::Thread, "abc").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        // Still archived, live one untouched.
        assert_eq!(list(d.path()).len(), 1);
        let live = fs::read_to_string(d.path().join("threads/abc/thread.json")).unwrap();
        assert!(live.contains("2.0"));
    }

    #[test]
    fn rooms_are_archived_from_the_rooms_directory() {
        let d = data();
        let dir = d.path().join("rooms/r1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("room.json"), "{}").unwrap();
        archive_dir(d.path(), Kind::Room, "r1", "Room", None).unwrap();
        assert!(!dir.exists());
        restore(d.path(), Kind::Room, "r1").unwrap();
        assert!(dir.join("room.json").exists());
    }

    #[test]
    fn payload_items_round_trip() {
        let d = data();
        let payload = json!({"session": {"id": "s1", "title": "Work"}});
        let extra = json!({"worktree": {"branch": "b"}});
        archive_payload(d.path(), Kind::Cowork, "s1", "Work", &payload, Some(extra.clone()))
            .unwrap();
        let items = list(d.path());
        assert_eq!(items[0].meta.storage, Storage::Payload);
        assert_eq!(items[0].meta.extra, Some(extra));
        let restored = restore(d.path(), Kind::Cowork, "s1").unwrap();
        assert_eq!(restored.payload, Some(payload));
        assert!(list(d.path()).is_empty());
    }

    #[test]
    fn path_traversal_ids_are_refused() {
        let d = data();
        for bad in ["..", "../x", "a/b", "a\\b", "", "C:x", ".archive", ".hidden"] {
            assert!(archive_dir(d.path(), Kind::Thread, bad, "x", None).is_err(), "{bad}");
            assert!(
                archive_payload(d.path(), Kind::Cowork, bad, "x", &json!({}), None).is_err(),
                "{bad}"
            );
            assert!(restore(d.path(), Kind::Thread, bad).is_err(), "{bad}");
            assert!(purge_with(d.path(), Kind::Thread, bad, &mut allow).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_tampered_meta_id_cannot_steer_the_restore() {
        let d = data();
        thread(d.path(), "abc", 1.0);
        archive_dir(d.path(), Kind::Thread, "abc", "t", None).unwrap();
        let meta_path = d.path().join(".archive/thread/abc/meta.json");
        let mut meta: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
        meta["id"] = json!("../../escaped");
        fs::write(&meta_path, meta.to_string()).unwrap();
        assert!(restore(d.path(), Kind::Thread, "abc").is_err());
        assert!(!d.path().join("escaped").exists());
    }

    #[test]
    fn missing_source_is_an_error_not_a_panic() {
        let d = data();
        assert!(archive_dir(d.path(), Kind::Thread, "nope", "x", None).is_err());
    }

    #[test]
    fn purge_runs_the_hook_first_and_a_refusal_keeps_the_item() {
        let d = data();
        thread(d.path(), "abc", 1.0);
        archive_dir(d.path(), Kind::Thread, "abc", "t", None).unwrap();
        let mut refuse = |_: &ArchiveMeta, _: &Path| Err("unmerged work".to_string());
        let err = purge_with(d.path(), Kind::Thread, "abc", &mut refuse).unwrap_err();
        assert_eq!(err, "unmerged work");
        assert_eq!(list(d.path()).len(), 1);
        purge_with(d.path(), Kind::Thread, "abc", &mut allow).unwrap();
        assert!(list(d.path()).is_empty());
    }

    #[test]
    fn empty_reports_what_the_hook_blocked() {
        let d = data();
        thread(d.path(), "a", 1.0);
        thread(d.path(), "b", 1.0);
        archive_dir(d.path(), Kind::Thread, "a", "A", None).unwrap();
        archive_dir(d.path(), Kind::Thread, "b", "B", None).unwrap();
        let mut hook = |m: &ArchiveMeta, _: &Path| {
            if m.id == "b" {
                Err("blocked".to_string())
            } else {
                Ok(())
            }
        };
        let report = purge_matching(d.path(), None, None, &mut hook);
        assert_eq!(report.purged, 1);
        assert_eq!(report.blocked.len(), 1);
        assert_eq!(report.blocked[0].title, "B");
        assert_eq!(list(d.path()).len(), 1);
    }

    #[test]
    fn sweep_removes_only_items_past_the_retention() {
        let d = data();
        thread(d.path(), "old", 1.0);
        thread(d.path(), "new", 1.0);
        archive_dir(d.path(), Kind::Thread, "old", "old", None).unwrap();
        archive_dir(d.path(), Kind::Thread, "new", "new", None).unwrap();
        let day = 86_400_000u64;
        // Age "old" by rewriting its meta.
        let p = d.path().join(".archive/thread/old/meta.json");
        let mut meta: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        let now = now_ms();
        meta["archivedAt"] = json!(now - 40 * day);
        fs::write(&p, meta.to_string()).unwrap();

        let none = sweep(d.path(), 0, now, &mut allow);
        assert_eq!(none.purged, 0, "0 days keeps everything");
        let report = sweep(d.path(), 30, now, &mut allow);
        assert_eq!(report.purged, 1);
        let left = list(d.path());
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].meta.id, "new");
    }

    #[test]
    fn auto_archive_takes_only_idle_threads() {
        let d = data();
        // Stamps far in the past, but the files were just written, so the
        // file time keeps them "active" -- back-date by archiving with a huge
        // window instead.
        thread(d.path(), "idle", 1.0);
        thread(d.path(), "fav", 1.0);
        let fav = d.path().join("threads/fav/thread.json");
        fs::write(&fav, json!({"id":"fav","updated":1.0,"isFavorite":true}).to_string()).unwrap();
        let far_future = now_ms() + 100 * 86_400_000;
        assert!(auto_archive_threads(d.path(), 0, far_future).is_empty());
        let archived = auto_archive_threads(d.path(), 30, far_future);
        assert_eq!(archived, vec!["idle".to_string()]);
        assert!(d.path().join("threads/fav").exists());
        // Fresh threads are untouched.
        thread(d.path(), "fresh", (now_ms() / 1000) as f64);
        assert!(auto_archive_threads(d.path(), 30, now_ms()).is_empty());
    }

    #[test]
    fn settings_default_and_round_trip() {
        let d = data();
        let s = read_settings(d.path());
        assert!(s.enabled);
        assert_eq!(s.auto_delete_days, 30);
        assert_eq!(s.auto_archive_thread_days, 0);
        write_settings(
            d.path(),
            &ArchiveSettings { enabled: false, auto_delete_days: 0, auto_archive_thread_days: 7 },
        )
        .unwrap();
        let s = read_settings(d.path());
        assert!(!s.enabled);
        assert_eq!(s.auto_archive_thread_days, 7);
    }

    fn result(data: &Path, gallery: &str, id: &str) {
        let dir = data.join(gallery);
        fs::create_dir_all(&dir).unwrap();
        let ext = if gallery == "videos" { "webm" } else { "png" };
        fs::write(dir.join(format!("{id}.{ext}")), b"media").unwrap();
        fs::write(dir.join(format!("{id}.json")), b"{}").unwrap();
    }

    #[test]
    fn studio_results_archive_restore_and_purge() {
        let d = data();
        result(d.path(), "images", "17-job-00");
        let name = archive_studio(d.path(), "images", "17-job-00", "a cat").unwrap();
        assert_eq!(name, "images-17-job-00");
        assert!(!d.path().join("images/17-job-00.png").exists());
        assert!(!d.path().join("images/17-job-00.json").exists());
        let items = list(d.path());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].meta.kind, Kind::Studio);
        assert_eq!(items[0].meta.storage, Storage::Files);
        assert!(items[0].size_bytes > 0);

        restore(d.path(), Kind::Studio, &name).unwrap();
        assert!(d.path().join("images/17-job-00.png").exists());
        assert!(d.path().join("images/17-job-00.json").exists());
        assert!(list(d.path()).is_empty());

        archive_studio(d.path(), "images", "17-job-00", "a cat").unwrap();
        purge_with(d.path(), Kind::Studio, &name, &mut allow).unwrap();
        assert!(list(d.path()).is_empty());
        assert!(!d.path().join("images/17-job-00.png").exists());
    }

    #[test]
    fn studio_collisions_get_a_suffix_and_videos_use_their_own_folder() {
        let d = data();
        result(d.path(), "videos", "9-v");
        let first = archive_studio(d.path(), "videos", "9-v", "clip").unwrap();
        result(d.path(), "videos", "9-v");
        let second = archive_studio(d.path(), "videos", "9-v", "clip again").unwrap();
        assert_eq!((first.as_str(), second.as_str()), ("videos-9-v", "videos-9-v-2"));
        restore(d.path(), Kind::Studio, &second).unwrap();
        assert!(d.path().join("videos/9-v.webm").exists());
        // The other copy cannot overwrite the live one.
        let err = restore(d.path(), Kind::Studio, &first).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(list(d.path()).len(), 1);
    }

    #[test]
    fn a_jpeg_or_webp_result_from_a_hosted_provider_moves_with_its_recipe() {
        let d = data();
        let dir = d.path().join("images");
        fs::create_dir_all(&dir).unwrap();
        for (id, ext) in [("5-a-00", "jpg"), ("5-b-00", "webp")] {
            fs::write(dir.join(format!("{id}.{ext}")), b"media").unwrap();
            fs::write(dir.join(format!("{id}.json")), b"{}").unwrap();
            let name = archive_studio(d.path(), "images", id, "t").unwrap();
            // Nothing of the result stays behind in the gallery.
            assert!(!dir.join(format!("{id}.{ext}")).exists(), "{ext} media left behind");
            assert!(!dir.join(format!("{id}.json")).exists());
            restore(d.path(), Kind::Studio, &name).unwrap();
            assert!(dir.join(format!("{id}.{ext}")).exists(), "{ext} not restored");
            assert!(dir.join(format!("{id}.json")).exists());
        }
        assert!(list(d.path()).is_empty());
    }

    #[test]
    fn studio_archive_refuses_bad_ids_galleries_and_missing_results() {
        let d = data();
        result(d.path(), "images", "ok");
        for bad in ["../x", "a/b", "", ".hidden"] {
            assert!(archive_studio(d.path(), "images", bad, "t").is_err(), "{bad}");
        }
        assert!(archive_studio(d.path(), "../etc", "ok", "t").is_err());
        assert!(archive_studio(d.path(), "images", "nope", "t").is_err());
        assert!(d.path().join("images/ok.png").exists());
    }

    #[test]
    fn a_tampered_studio_meta_cannot_restore_elsewhere() {
        let d = data();
        result(d.path(), "images", "ok");
        let name = archive_studio(d.path(), "images", "ok", "t").unwrap();
        let p = d.path().join(".archive/studio").join(&name).join("meta.json");
        let mut meta: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        meta["extra"]["gallery"] = json!("../../escape");
        fs::write(&p, meta.to_string()).unwrap();
        assert!(restore(d.path(), Kind::Studio, &name).is_err());
        assert!(!d.path().join("escape").exists());
    }

    #[test]
    fn assistants_are_payload_items_that_round_trip_and_collide_safely() {
        let d = data();
        let a = json!({"id": "helper", "name": "Helper", "instructions": "be brief"});
        let first = archive_payload(d.path(), Kind::Assistant, "helper", "Helper", &a, None).unwrap();
        let second = archive_payload(d.path(), Kind::Assistant, "helper", "Helper v2", &a, None).unwrap();
        assert_eq!((first.as_str(), second.as_str()), ("helper", "helper-2"));
        assert_eq!(list(d.path()).iter().filter(|i| i.meta.kind == Kind::Assistant).count(), 2);
        let back = restore(d.path(), Kind::Assistant, &second).unwrap();
        assert_eq!(back.payload, Some(a));
        assert_eq!(back.title, "Helper v2");
        purge_with(d.path(), Kind::Assistant, &first, &mut allow).unwrap();
        assert!(list(d.path()).is_empty());
        assert!(archive_payload(d.path(), Kind::Assistant, "../x", "t", &json!({}), None).is_err());
    }

    #[test]
    fn sweep_covers_the_new_kinds() {
        let d = data();
        result(d.path(), "images", "old");
        archive_studio(d.path(), "images", "old", "t").unwrap();
        archive_payload(d.path(), Kind::Assistant, "a", "A", &json!({}), None).unwrap();
        let now = now_ms() + 31 * 86_400_000;
        let report = sweep(d.path(), 30, now, &mut allow);
        assert_eq!(report.purged, 2);
        assert!(list(d.path()).is_empty());
    }

    #[test]
    fn copy_fallback_moves_a_tree() {
        let d = data();
        let src = d.path().join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("sub/f.txt"), "x").unwrap();
        let dst = d.path().join("dst");
        copy_dir(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("sub/f.txt")).unwrap(), "x");
    }
}
