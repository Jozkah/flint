use super::*;

/// Read an image file into a `PendingImage` (base64 data URL + basename).
pub(super) fn load_image_file(path: &str) -> Result<PendingImage, String> {
    use base64::Engine;
    let len = std::fs::metadata(path)
        .map_err(|e| format!("{path}: {e}"))?
        .len();
    if len > MAX_IMAGE_BYTES {
        return Err(format!(
            "{path}: too large ({} MB, max {} MB)",
            len / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.is_empty() {
        return Err(format!("{path}: empty file"));
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();
    Ok(PendingImage {
        name,
        data_url: format!("data:{};base64,{b64}", image_mime(path)),
    })
}

/// Percent-decode a `file://` URI or plain path from clipboard text into a
/// filesystem path. Takes the first line (uri-lists are newline-separated) and
/// strips a `file://[host]` scheme; decodes `%XX` byte escapes.
pub(super) fn clipboard_path(text: &str) -> Option<String> {
    let line = text.lines().find(|l| !l.trim().is_empty())?.trim();
    let lb = line.as_bytes();
    let pathlike = line.starts_with("file://")
        || line.starts_with('/')
        || line.starts_with('~')
        || line.starts_with("\\\\")
        || (lb.len() >= 3
            && lb[0].is_ascii_alphabetic()
            && lb[1] == b':'
            && (lb[2] == b'\\' || lb[2] == b'/'));
    if !pathlike {
        return None;
    }
    let raw = line
        .strip_prefix("file://localhost")
        .or_else(|| line.strip_prefix("file://"))
        .unwrap_or(line);
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok().filter(|p| !p.is_empty())
}

/// Load the first loadable image out of a clipboard file list, skipping entries
/// that are missing, oversized, or not a known image type -- the list is
/// whatever the user copied, not necessarily an image.
pub(super) fn load_first_file_image(files: &[PathBuf]) -> Option<PendingImage> {
    files.iter().find_map(|p| {
        let path = p.to_str()?;
        image_mime_of(path)?;
        load_image_file(path).ok()
    })
}

/// Read an image from the OS clipboard into a `PendingImage`. Prefers raw image
/// data (PNG-encoding it); falls back to treating clipboard text as an image
/// file path or `file://` URI (as file managers and browsers put on the
/// clipboard). Errors when neither yields an image.
pub(super) fn clipboard_image() -> Result<PendingImage, String> {
    use base64::Engine;
    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = match clip.get_image() {
        Ok(img) => img,
        Err(image_err) => {
            if let Some(path) = clip.get_text().ok().as_deref().and_then(clipboard_path) {
                if std::path::Path::new(&path).is_file() {
                    return load_image_file(&path);
                }
            }
            // macOS Finder copies publish a file URL, not raster data.
            if let Some(img) = clip
                .get()
                .file_list()
                .ok()
                .and_then(|files| load_first_file_image(&files))
            {
                return Ok(img);
            }
            return Err(image_err.to_string());
        }
    };
    let mut png = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png, img.width as u32, img.height as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&img.bytes)
            .map_err(|e| e.to_string())?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(PendingImage {
        name: "clipboard.png".to_string(),
        data_url: format!("data:image/png;base64,{b64}"),
    })
}
