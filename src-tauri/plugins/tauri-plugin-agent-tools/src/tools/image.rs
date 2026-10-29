//! Image detection for the `read` tool: a file whose bytes are a recognized
//! raster image (or, failing that, whose extension names one) is returned as an
//! OpenAI `image_url` content part instead of a text read. Detection prefers the
//! file signature so a misnamed image still renders, falling back to the
//! extension so an unusual-but-valid file is still picked up.

/// The MIME type inferred for a byte prefix, or `None` when the bytes do not
/// match a supported image signature. Mirrors the TUI's accepted set
/// (`image_mime_of`): png, jpeg, gif, webp.
pub fn mime_from_signature(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    // WebP: "RIFF" + 4 bytes size + "WEBP".
    if bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// The MIME type for a known image file extension, or `None`.
pub fn mime_from_extension(path: &std::path::Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// The MIME type of the image at `path`, decided by file signature first and
/// extension second. `None` when neither identifies a supported image.
#[allow(dead_code)]
pub fn detect(path: &std::path::Path) -> Option<&'static str> {
    use std::io::Read;
    let mut header = Vec::with_capacity(16);
    std::fs::File::open(path).ok()?.take(16).read_to_end(&mut header).ok()?;
    mime_from_signature(&header).or_else(|| mime_from_extension(path))
}

/// [`detect`] on bytes already read from `path`, with no second disk read.
pub fn detect_bytes(path: &std::path::Path, bytes: &[u8]) -> Option<&'static str> {
    mime_from_signature(&bytes[..bytes.len().min(16)]).or_else(|| mime_from_extension(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_recognizes_each_supported_format() {
        assert_eq!(
            mime_from_signature(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(mime_from_signature(b"\xff\xd8\xffrest"), Some("image/jpeg"));
        assert_eq!(mime_from_signature(b"GIF89a rest"), Some("image/gif"));
        assert_eq!(mime_from_signature(b"GIF87a rest"), Some("image/gif"));
        assert_eq!(
            mime_from_signature(b"RIFF\x00\x00\x00\x00WEBPrest"),
            Some("image/webp")
        );
        assert_eq!(mime_from_signature(b"plain text"), None);
    }

    #[test]
    fn image_detect_reads_header_only() {
        let dir = std::env::temp_dir().join(format!("flint-image-detect-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.dat");
        let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
        data.resize(8 * 1024 * 1024, 0);
        std::fs::write(&file, data).unwrap();
        assert_eq!(detect(&file), Some("image/png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_bytes_uses_the_bytes_in_hand() {
        let p = std::path::Path::new("no-such-file.bin");
        assert_eq!(detect_bytes(p, b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(detect_bytes(std::path::Path::new("x.gif"), b"text"), Some("image/gif"));
        assert_eq!(detect_bytes(p, b""), None);
    }

    #[test]
    fn webp_requires_the_webp_fourcc() {
        assert_eq!(mime_from_signature(b"RIFF\x00\x00\x00\x00WAVErest"), None);
        assert_eq!(mime_from_signature(b"RIFF"), None);
    }

    #[test]
    fn extension_is_case_insensitive_and_unknown_is_none() {
        assert_eq!(
            mime_from_extension(std::path::Path::new("a.PNG")),
            Some("image/png")
        );
        assert_eq!(
            mime_from_extension(std::path::Path::new("a.jpeg")),
            Some("image/jpeg")
        );
        assert_eq!(
            mime_from_extension(std::path::Path::new("a.jpg")),
            Some("image/jpeg")
        );
        assert_eq!(
            mime_from_extension(std::path::Path::new("a.webp")),
            Some("image/webp")
        );
        assert_eq!(mime_from_extension(std::path::Path::new("a.pdf")), None);
        assert_eq!(mime_from_extension(std::path::Path::new("noext")), None);
    }
}
