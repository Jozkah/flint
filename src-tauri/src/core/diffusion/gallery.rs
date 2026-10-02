//! What was generated, kept on disk.
//!
//! Each result is a media file beside a small JSON file with how it was made (the
//! prompt, size, steps and seed), so a result can be shown, reproduced and
//! deleted without a database. Images live in `<data>/images/`, videos in
//! `<data>/videos/`. Writes go to a temporary name first and are renamed, so a
//! crash never leaves half a file in the gallery.

use super::catalog::Kind;
use crate::core::app::commands::get_jan_data_folder_path;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Runtime;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub job_id: String,
    pub kind: Kind,
    pub prompt: String,
    pub negative_prompt: String,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    /// The seed of this image. Reproduce a batch with `batch_seed`.
    pub seed: u32,
    pub batch_seed: u32,
    pub model_id: String,
    pub model_name: String,
    pub frames: Option<u32>,
    pub fps: Option<u32>,
    pub created_at_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryItem {
    pub id: String,
    pub kind: Kind,
    pub path: String,
    pub recipe: Recipe,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn folder_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Image => "images",
        Kind::Video => "videos",
    }
}

pub fn dir_for<R: Runtime>(app: &tauri::AppHandle<R>, kind: Kind) -> PathBuf {
    get_jan_data_folder_path(app.clone()).join(folder_name(kind))
}

/// Only letters, digits, `-` and `_`, so a job id can never name a path.
fn file_safe(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if cleaned.is_empty() { "job".to_string() } else { cleaned }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not save the result: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save the result: {e}")
    })
}

fn save<R: Runtime>(
    app: &tauri::AppHandle<R>,
    recipe: &Recipe,
    id: String,
    extension: &str,
    bytes: &[u8],
) -> Result<Saved, String> {
    let dir = dir_for(app, recipe.kind);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the gallery folder: {e}"))?;
    let media = dir.join(format!("{id}.{extension}"));
    write_atomically(&media, bytes)?;
    let json = serde_json::to_vec_pretty(recipe).map_err(|e| e.to_string())?;
    write_atomically(&dir.join(format!("{id}.json")), &json)?;
    Ok(Saved { id, path: media })
}

pub fn save_image<R: Runtime>(
    app: &tauri::AppHandle<R>,
    recipe: &Recipe,
    index: u32,
    png: &[u8],
) -> Result<Saved, String> {
    let id = format!("{}-{}-{:02}", recipe.created_at_ms, file_safe(&recipe.job_id), index);
    save(app, recipe, id, "png", png)
}

/// The picture format of `bytes` by its signature: the extension to keep it
/// under, or `None` when it is not a picture Studio shows (an HTML error page
/// from a provider, for one, must never land in the gallery).
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// A picture a hosted provider made, kept in the gallery like a local one.
pub fn save_external_image<R: Runtime>(
    app: &tauri::AppHandle<R>,
    recipe: &Recipe,
    index: u32,
    bytes: &[u8],
) -> Result<Saved, String> {
    let extension = sniff_image(bytes).ok_or("The provider did not return a picture.")?;
    let id = format!("{}-{}-{:02}", recipe.created_at_ms, file_safe(&recipe.job_id), index);
    save(app, recipe, id, extension, bytes)
}

pub fn save_video<R: Runtime>(
    app: &tauri::AppHandle<R>,
    recipe: &Recipe,
    webm: &[u8],
) -> Result<Saved, String> {
    let id = format!("{}-{}", recipe.created_at_ms, file_safe(&recipe.job_id));
    save(app, recipe, id, "webm", webm)
}

/// Every extension a result can be kept under.
const MEDIA_EXTENSIONS: [&str; 4] = ["png", "jpg", "webp", "webm"];

fn media_file(dir: &Path, id: &str) -> Option<PathBuf> {
    MEDIA_EXTENSIONS
        .iter()
        .map(|ext| dir.join(format!("{id}.{ext}")))
        .find(|p| p.is_file())
}

/// Every result of `kind`, newest first. A JSON file without its media file, or
/// one that cannot be read, is skipped rather than failing the list.
pub fn list<R: Runtime>(app: &tauri::AppHandle<R>, kind: Kind) -> Vec<GalleryItem> {
    list_in(&dir_for(app, kind), kind)
}

fn list_in(dir: &Path, kind: Kind) -> Vec<GalleryItem> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items: Vec<GalleryItem> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            let recipe: Recipe = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
            if recipe.kind != kind {
                return None;
            }
            let media = media_file(dir, &id)?;
            Some(GalleryItem {
                id,
                kind,
                path: media.to_string_lossy().into_owned(),
                recipe,
            })
        })
        .collect();
    items.sort_by(|a, b| b.recipe.created_at_ms.cmp(&a.recipe.created_at_ms).then(a.id.cmp(&b.id)));
    items
}

/// Delete one result and its recipe. The id must be one the gallery made.
pub fn delete<R: Runtime>(app: &tauri::AppHandle<R>, kind: Kind, id: &str) -> Result<(), String> {
    delete_in(&dir_for(app, kind), id)
}

/// Move one result into the archive instead of deleting it. Same id rules as
/// `delete`; the archive's title is the start of the prompt.
pub fn archive<R: Runtime>(app: &tauri::AppHandle<R>, kind: Kind, id: &str) -> Result<(), String> {
    archive_in(&get_jan_data_folder_path(app.clone()), kind, id)
}

fn archive_in(data: &Path, kind: Kind, id: &str) -> Result<(), String> {
    if id.is_empty() || id != file_safe(id) {
        return Err("That is not a gallery item.".to_string());
    }
    let folder = folder_name(kind);
    let title = std::fs::read(data.join(folder).join(format!("{id}.json")))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Recipe>(&bytes).ok())
        .map(|r| r.prompt.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect::<String>())
        .unwrap_or_default();
    crate::core::archive::store::archive_studio(data, folder, id, &title).map(|_| ())
}

fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    if id.is_empty() || id != file_safe(id) {
        return Err("That is not a gallery item.".to_string());
    }
    for ext in ["png", "jpg", "webp", "webm", "json"] {
        let path = dir.join(format!("{id}.{ext}"));
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// The largest result handed to a phone as a data URL.
pub const MAX_MEDIA_BYTES: u64 = 48 * 1024 * 1024;

/// One result's media as a `data:` URL. The id must be one the gallery made,
/// so it can only name a file inside the gallery folder.
pub fn media_data_url<R: Runtime>(app: &tauri::AppHandle<R>, kind: Kind, id: &str) -> Result<String, String> {
    media_in(&dir_for(app, kind), id)
}

fn media_in(dir: &Path, id: &str) -> Result<String, String> {
    use base64::Engine as _;
    if id.is_empty() || id != file_safe(id) {
        return Err("That is not a gallery item.".to_string());
    }
    let path = media_file(dir, id).ok_or_else(|| "That item is gone.".to_string())?;
    let size = std::fs::metadata(&path).map_err(|e| format!("Could not read it: {e}"))?.len();
    if size > MAX_MEDIA_BYTES {
        return Err("That file is too large to send to a phone.".to_string());
    }
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("webm") => "video/webm",
        Some("jpg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read it: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recipe(job: &str, at: u64, kind: Kind) -> Recipe {
        Recipe {
            job_id: job.into(),
            kind,
            prompt: "a cat".into(),
            negative_prompt: String::new(),
            width: 1024,
            height: 1024,
            steps: 8,
            seed: 7,
            batch_seed: 7,
            model_id: "z-image-turbo".into(),
            model_name: "Z-Image Turbo".into(),
            frames: None,
            fps: None,
            created_at_ms: at,
            duration_ms: 1200,
        }
    }

    fn put(dir: &Path, id: &str, ext: &str, r: &Recipe) {
        std::fs::write(dir.join(format!("{id}.{ext}")), b"media").unwrap();
        std::fs::write(dir.join(format!("{id}.json")), serde_json::to_vec(r).unwrap()).unwrap();
    }

    #[test]
    fn the_list_is_newest_first_and_only_the_asked_kind() {
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "a", "png", &recipe("job_1", 100, Kind::Image));
        put(dir.path(), "b", "png", &recipe("job_2", 300, Kind::Image));
        put(dir.path(), "c", "webm", &recipe("job_3", 200, Kind::Video));
        let ids: Vec<_> = list_in(dir.path(), Kind::Image).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["b", "a"]);
        assert_eq!(list_in(dir.path(), Kind::Video).len(), 1);
    }

    #[test]
    fn a_recipe_without_media_or_unreadable_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("lonely.json"),
            serde_json::to_vec(&recipe("j", 1, Kind::Image)).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.path().join("junk.json"), b"not json").unwrap();
        assert!(list_in(dir.path(), Kind::Image).is_empty());
        assert!(list_in(&dir.path().join("missing"), Kind::Image).is_empty());
    }

    #[test]
    fn archiving_moves_the_media_and_recipe_out_of_the_list_and_back() {
        use crate::core::archive::store as archive;
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().join("images");
        std::fs::create_dir_all(&dir).unwrap();
        put(&dir, "1-job-00", "png", &recipe("job", 1, Kind::Image));
        assert_eq!(list_in(&dir, Kind::Image).len(), 1);

        archive_in(data.path(), Kind::Image, "1-job-00").unwrap();
        assert!(list_in(&dir, Kind::Image).is_empty());
        let items = archive::list(data.path());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].meta.title, "a cat");

        archive::restore(data.path(), archive::Kind::Studio, &items[0].archive_id).unwrap();
        assert_eq!(list_in(&dir, Kind::Image).len(), 1);
        assert!(archive_in(data.path(), Kind::Image, "../x").is_err());
        assert!(archive_in(data.path(), Kind::Image, "").is_err());
    }

    #[test]
    fn deleting_removes_the_media_and_its_recipe_and_refuses_a_path() {
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "x", "png", &recipe("j", 1, Kind::Image));
        delete_in(dir.path(), "x").unwrap();
        assert!(!dir.path().join("x.png").exists() && !dir.path().join("x.json").exists());
        assert!(delete_in(dir.path(), "../x").is_err());
        assert!(delete_in(dir.path(), "a/b").is_err());
        assert!(delete_in(dir.path(), "").is_err());
    }

    #[test]
    fn media_is_a_data_url_and_refuses_a_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("1-a.png"), b"png").unwrap();
        assert_eq!(media_in(dir.path(), "1-a").unwrap(), "data:image/png;base64,cG5n");
        assert!(media_in(dir.path(), "../1-a").is_err());
        assert!(media_in(dir.path(), "missing").is_err());
    }

    #[test]
    fn pictures_are_told_by_their_signature() {
        assert_eq!(sniff_image(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]), Some("png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(sniff_image(b"RIFF   WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_image(b"<html>429 Too Many Requests</html>"), None);
        assert_eq!(sniff_image(b""), None);
        assert_eq!(sniff_image(b"RIFF   WAVEfmt "), None);
    }

    #[test]
    fn a_jpeg_and_a_webp_are_listed_deleted_and_sent_with_their_own_type() {
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "j", "jpg", &recipe("j1", 2, Kind::Image));
        put(dir.path(), "w", "webp", &recipe("j2", 1, Kind::Image));
        assert_eq!(list_in(dir.path(), Kind::Image).len(), 2);
        assert!(media_in(dir.path(), "j").unwrap().starts_with("data:image/jpeg;base64,"));
        assert!(media_in(dir.path(), "w").unwrap().starts_with("data:image/webp;base64,"));
        delete_in(dir.path(), "j").unwrap();
        assert!(!dir.path().join("j.jpg").exists() && !dir.path().join("j.json").exists());
    }

    #[test]
    fn job_ids_become_safe_file_names() {
        assert_eq!(file_safe("job_ab-12"), "job_ab-12");
        assert_eq!(file_safe("../x y"), "---x-y");
        assert_eq!(file_safe(""), "job");
    }

    #[test]
    fn a_recipe_round_trips_in_camel_case() {
        let r = recipe("job_1", 5, Kind::Image);
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"jobId\"") && json.contains("\"createdAtMs\""));
        assert_eq!(serde_json::from_str::<Recipe>(&json).unwrap(), r);
    }
}
