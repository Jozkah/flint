//! Attachments sent from a phone: a chunked upload into
//! `<data>/uploads/remote/<id>/<name>` (owner-only), checked by size and by
//! its bytes, then handed to the window when the phone sends the message.
//!
//! - `POST   /remote/v1/upload`                 `{name, size, mime}` -> `{uploadId, chunkSize}`
//! - `PUT    /remote/v1/upload/<id>?offset=N`   raw bytes, in order
//! - `POST   /remote/v1/upload/<id>/finish`     -> `{uploadId, name, size, mime}`
//! - `DELETE /remote/v1/upload/<id>`
//!
//! The window never sees a path the phone chose: it asks for uploads by id
//! (`remote_upload_take`), and only for the device that made them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Bytes per PUT. Small enough for a phone on a weak link to retry cheaply.
pub const CHUNK_SIZE: usize = 1024 * 1024;
/// Uploads one device may have in progress or waiting to be sent.
pub const MAX_PENDING_PER_DEVICE: usize = 20;
/// How long an upload stays claimable after its last chunk.
pub const UPLOAD_TTL: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Clone, PartialEq)]
pub struct Upload {
    pub id: String,
    pub device_id: String,
    pub name: String,
    pub size: u64,
    pub claimed_mime: String,
    pub received: u64,
    pub path: PathBuf,
    pub mime: Option<String>,
    pub touched: Instant,
    /// A chunk of this upload is being appended. A second PUT at the same
    /// offset arriving meanwhile is refused instead of appending twice.
    pub writing: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadInfo {
    pub upload_id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum UploadError {
    TooLarge(u32),
    Empty,
    TooMany,
    NotFound,
    BadOffset(u64),
    Overflow,
    Incomplete,
    Rejected(&'static str),
    Io(String),
}

impl UploadError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::TooLarge(_) => "too_large",
            Self::Empty => "empty",
            Self::TooMany => "too_many",
            Self::NotFound => "not_found",
            Self::BadOffset(_) => "bad_offset",
            Self::Overflow => "too_large",
            Self::Incomplete => "incomplete",
            Self::Rejected(_) => "rejected",
            Self::Io(_) => "io",
        }
    }
    pub fn message(&self) -> String {
        match self {
            Self::TooLarge(mb) => format!("Files from a phone can be up to {mb} MB"),
            Self::Empty => "This file is empty".into(),
            Self::TooMany => "Too many uploads waiting; send or remove some first".into(),
            Self::NotFound => "That upload is gone; add the file again".into(),
            Self::BadOffset(at) => format!("Resume from byte {at}"),
            Self::Overflow => "More bytes than announced".into(),
            Self::Incomplete => "The upload did not finish".into(),
            Self::Rejected(why) => (*why).into(),
            Self::Io(e) => format!("Could not save the file: {e}"),
        }
    }
}

/// A name safe to put on disk: no separators, controls or leading dots.
pub fn clean_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .take(120)
        .collect();
    let cleaned = cleaned
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .to_string();
    if cleaned.is_empty() {
        "upload".into()
    } else {
        avoid_device_name(cleaned)
    }
}

/// Windows opens these names as devices whatever the extension (`CON.txt`), and
/// reading one blocks on console input. Such a name gets a leading underscore.
pub fn avoid_device_name(name: String) -> String {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        format!("_{name}")
    } else {
        name
    }
}

/// The type the bytes say, from their first few bytes. `None`: no binary
/// signature (text is checked separately).
pub fn sniff(head: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8]| head.starts_with(sig);
    if starts(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if starts(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some("image/gif");
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Some("audio/wav");
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return Some(match &head[8..12] {
            b"heic" | b"heix" | b"mif1" | b"msf1" | b"hevc" => "image/heic",
            b"qt  " => "video/quicktime",
            b"M4A " => "audio/mp4",
            _ => "video/mp4",
        });
    }
    if starts(b"%PDF-") {
        return Some("application/pdf");
    }
    if starts(b"PK\x03\x04") {
        return Some("application/zip");
    }
    if starts(b"ID3") || (head.len() > 1 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0) {
        return Some("audio/mpeg");
    }
    // Programs are never attachments.
    if starts(b"MZ") || starts(b"\x7fELF") || starts(&[0xCF, 0xFA, 0xED, 0xFE]) || starts(&[0xCA, 0xFE, 0xBA, 0xBE]) {
        return Some("application/x-executable");
    }
    None
}

fn looks_like_text(head: &[u8]) -> bool {
    !head.contains(&0)
        && match std::str::from_utf8(head) {
            Ok(_) => true,
            // A multi-byte character cut by the sample's end is still text.
            Err(e) => e.error_len().is_none() && head.len() - e.valid_up_to() < 4,
        }
}

/// The type to record, or why the file is refused: the bytes must agree with
/// what the phone said it is, and programs are refused outright.
pub fn decide_mime(claimed: &str, name: &str, head: &[u8]) -> Result<String, &'static str> {
    let claimed = claimed.to_ascii_lowercase();
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match sniff(head) {
        Some("application/x-executable") => Err("Programs can't be attached"),
        Some("application/zip") => {
            // docx/xlsx/pptx/odt are zip containers; keep the Office type.
            if ["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"].contains(&ext.as_str()) {
                Ok(if claimed.is_empty() || claimed == "application/octet-stream" {
                    "application/zip".into()
                } else {
                    claimed
                })
            } else {
                Err("Archives can't be attached")
            }
        }
        Some(m) => {
            let family = |s: &str| s.split('/').next().unwrap_or("").to_string();
            if claimed.starts_with("image/") || claimed.starts_with("audio/") || claimed.starts_with("video/") {
                if family(&claimed) != family(m) && !(family(m) == "video" && claimed.starts_with("audio/")) {
                    return Err("The file's contents don't match its type");
                }
            }
            Ok(m.to_string())
        }
        None if looks_like_text(head) => {
            if claimed.starts_with("image/") || claimed.starts_with("video/") || claimed.starts_with("audio/") {
                Err("The file's contents don't match its type")
            } else if claimed.starts_with("text/") || claimed.contains("json") || claimed.contains("xml") {
                Ok(claimed)
            } else {
                Ok("text/plain".into())
            }
        }
        None => Err("This kind of file can't be attached"),
    }
}

#[derive(Debug, Default)]
pub struct UploadBook {
    uploads: HashMap<String, Upload>,
}

impl UploadBook {
    /// Forgets the uploads that outlived [`UPLOAD_TTL`] and deletes their files.
    fn prune(&mut self, now: Instant) {
        let expired: Vec<String> = self
            .uploads
            .iter()
            .filter(|(_, u)| now.duration_since(u.touched) >= UPLOAD_TTL)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(u) = self.uploads.remove(&id) {
                if let Some(dir) = u.path.parent() {
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        }
    }

    /// Deletes every folder under `root` that no upload in the book owns: the
    /// book lives in memory, so after a restart whatever is on disk is
    /// unreachable.
    pub fn sweep(&self, root: &Path) {
        let Ok(entries) = std::fs::read_dir(root) else { return };
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if self.uploads.contains_key(&id) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    pub fn start(
        &mut self,
        root: &Path,
        device_id: &str,
        name: &str,
        size: u64,
        mime: &str,
        max_mb: u32,
        now: Instant,
    ) -> Result<Upload, UploadError> {
        self.prune(now);
        if size == 0 {
            return Err(UploadError::Empty);
        }
        if size > max_mb as u64 * 1024 * 1024 {
            return Err(UploadError::TooLarge(max_mb));
        }
        if self.uploads.values().filter(|u| u.device_id == device_id).count() >= MAX_PENDING_PER_DEVICE {
            return Err(UploadError::TooMany);
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let name = clean_name(name);
        let up = Upload {
            path: root.join(&id).join(&name),
            id: id.clone(),
            device_id: device_id.into(),
            name,
            size,
            claimed_mime: mime.chars().take(100).collect(),
            received: 0,
            mime: None,
            touched: now,
            writing: false,
        };
        self.uploads.insert(id, up.clone());
        Ok(up)
    }

    /// The upload `id` of `device_id`, if it is theirs.
    pub fn get(&self, device_id: &str, id: &str) -> Option<&Upload> {
        self.uploads.get(id).filter(|u| u.device_id == device_id)
    }

    /// Checks a chunk can go at `offset`; the caller writes it, then calls
    /// [`Self::wrote`].
    pub fn check_chunk(&self, device_id: &str, id: &str, offset: u64, len: usize) -> Result<Upload, UploadError> {
        let u = self.get(device_id, id).ok_or(UploadError::NotFound)?;
        if u.mime.is_some() || offset != u.received {
            return Err(UploadError::BadOffset(u.received));
        }
        if u.received + len as u64 > u.size {
            return Err(UploadError::Overflow);
        }
        Ok(u.clone())
    }

    /// [`Self::check_chunk`], and claims the upload for the write so that two
    /// PUTs at the same offset cannot both append. Pair it with [`Self::wrote`]
    /// or [`Self::release_chunk`].
    pub fn reserve_chunk(&mut self, device_id: &str, id: &str, offset: u64, len: usize) -> Result<Upload, UploadError> {
        let up = self.check_chunk(device_id, id, offset, len)?;
        if up.writing {
            return Err(UploadError::BadOffset(up.received));
        }
        if let Some(u) = self.uploads.get_mut(id) {
            u.writing = true;
        }
        Ok(up)
    }

    /// Gives the claim from [`Self::reserve_chunk`] back after a failed write.
    pub fn release_chunk(&mut self, id: &str) {
        if let Some(u) = self.uploads.get_mut(id) {
            u.writing = false;
        }
    }

    pub fn wrote(&mut self, id: &str, len: usize, now: Instant) -> u64 {
        match self.uploads.get_mut(id) {
            Some(u) => {
                u.writing = false;
                u.received += len as u64;
                u.touched = now;
                u.received
            }
            None => 0,
        }
    }

    pub fn finish(&mut self, device_id: &str, id: &str, head: &[u8]) -> Result<UploadInfo, UploadError> {
        let u = self.get(device_id, id).ok_or(UploadError::NotFound)?.clone();
        if u.received != u.size {
            return Err(UploadError::Incomplete);
        }
        let mime = match decide_mime(&u.claimed_mime, &u.name, head) {
            Ok(m) => m,
            Err(why) => {
                self.remove(device_id, id);
                return Err(UploadError::Rejected(why));
            }
        };
        if let Some(x) = self.uploads.get_mut(id) {
            x.mime = Some(mime.clone());
        }
        Ok(UploadInfo {
            upload_id: u.id,
            name: u.name,
            size: u.size,
            mime,
        })
    }

    /// Forgets an upload and deletes its file.
    pub fn remove(&mut self, device_id: &str, id: &str) -> bool {
        if self.get(device_id, id).is_none() {
            return false;
        }
        if let Some(u) = self.uploads.remove(id) {
            if let Some(dir) = u.path.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        true
    }

    /// Finished uploads of `device_id` among `ids`, for the window.
    pub fn finished(&self, device_id: &str, ids: &[String]) -> Vec<Upload> {
        ids.iter()
            .filter_map(|id| self.get(device_id, id))
            .filter(|u| u.mime.is_some())
            .cloned()
            .collect()
    }
}
