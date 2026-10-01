//! Save a chat or Cowork export (Markdown, PDF or PNG) where the user chooses.
//!
//! The renderer never supplies the destination: it sends the content and a
//! suggested name, and this command opens the save dialog itself. A command
//! that wrote wherever the renderer said would be a write-anywhere primitive.

use base64::Engine;
use std::path::{Path, PathBuf};

/// Largest export accepted, in bytes. A pasted-in screenshot book is not a chat.
pub const MAX_EXPORT_BYTES: usize = 50 * 1024 * 1024;

/// The extensions an export may be written with.
const ALLOWED_EXT: [&str; 4] = ["md", "pdf", "png", "html"];

/// Names Windows reserves regardless of extension.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// What an export wrote, and how many credentials it left out.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportSaveReport {
    pub path: String,
    pub redactions: usize,
}

/// `md`, `pdf`, `png` or `html` (any case, optional leading dot); anything else is refused.
pub fn validate_ext(ext: &str) -> Result<&'static str, String> {
    let wanted = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    ALLOWED_EXT
        .iter()
        .copied()
        .find(|allowed| *allowed == wanted)
        .ok_or_else(|| format!("exports can be saved as md, pdf, png or html, not {ext:?}"))
}

/// A file name that is legal on Windows, macOS and Linux, ending in `.ext`.
pub fn sanitize_file_name(name: &str, ext: &str) -> String {
    let mut stem: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if (c as u32) < 0x20 || c == '\u{7f}' => ' ',
            c => c,
        })
        .collect();
    // Drop an extension the caller already put on, so it is not doubled.
    let suffix = format!(".{ext}");
    if stem.to_ascii_lowercase().ends_with(&suffix) {
        stem.truncate(stem.len() - suffix.len());
    }
    let stem = stem.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem: String = stem
        .trim_matches(|c| c == '.' || c == ' ')
        .chars()
        .take(80)
        .collect();
    let mut stem = stem.trim_end_matches(|c| c == '.' || c == ' ').to_string();
    if stem.is_empty() {
        stem = "export".to_string();
    }
    if RESERVED.contains(&stem.to_ascii_lowercase().as_str()) {
        stem.insert(0, '_');
    }
    format!("{stem}.{ext}")
}

fn decode_body(text: Option<String>, base64: Option<String>) -> Result<Vec<u8>, String> {
    match (text, base64) {
        (Some(text), None) => Ok(text.into_bytes()),
        (None, Some(data)) => {
            // 4 base64 characters carry 3 bytes: refuse before allocating.
            if data.len() / 4 * 3 > MAX_EXPORT_BYTES + 3 {
                return Err("the export is larger than 50 MB".to_string());
            }
            base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|e| format!("the export content is not valid base64: {e}"))
        }
        _ => Err("an export carries either text or base64 content".to_string()),
    }
}

async fn pick_path(ext: &str, file_name: &str) -> Option<PathBuf> {
    // Test-only: the smoke harness scripts the picker, as it does for folders.
    #[cfg(feature = "cowork-smoke")]
    if let Some(scripted) = super::smoke_dialog::scripted_save_response() {
        return scripted.map(PathBuf::from);
    }
    rfd::AsyncFileDialog::new()
        .add_filter(ext.to_ascii_uppercase(), &[ext])
        .set_file_name(file_name)
        .save_file()
        .await
        .map(|f| f.path().to_path_buf())
}

fn write_atomically(path: &Path, body: &[u8]) -> Result<(), String> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, body).map_err(|e| format!("could not write the export: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("could not write the export: {e}")
    })
}

/// Save an export to a file the user picks. `None` means the user cancelled.
///
/// Text (Markdown or HTML) has credentials redacted here as well as in the renderer,
/// so a secret that slipped past the first pass is still not written.
#[tauri::command]
pub async fn export_save_file(
    ext: String,
    suggested_name: String,
    text: Option<String>,
    base64: Option<String>,
) -> Result<Option<ExportSaveReport>, String> {
    let ext = validate_ext(&ext)?;
    let mut redactions = 0;
    let text = text.map(|t| {
        let cleaned = tauri_plugin_agent_tools::secrets::redact_secrets(&t);
        if cleaned.lines().ne(t.lines()) {
            redactions += 1;
            cleaned
        } else {
            t
        }
    });
    let body = decode_body(text, base64)?;
    if body.len() > MAX_EXPORT_BYTES {
        return Err("the export is larger than 50 MB".to_string());
    }
    let name = sanitize_file_name(&suggested_name, ext);
    let Some(mut path) = pick_path(ext, &name).await else {
        return Ok(None);
    };
    // A name typed without an extension still gets the format's.
    if path.extension().is_none() {
        path.set_extension(ext);
    }
    write_atomically(&path, &body)?;
    Ok(Some(ExportSaveReport {
        path: path.to_string_lossy().to_string(),
        redactions,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_md_pdf_png_are_accepted() {
        assert_eq!(validate_ext("md"), Ok("md"));
        assert_eq!(validate_ext(".PDF"), Ok("pdf"));
        assert_eq!(validate_ext(" png "), Ok("png"));
        assert_eq!(validate_ext("HTML"), Ok("html"));
        for bad in ["exe", "htm", "svg", "md.exe", "", "../md", "bat"] {
            assert!(validate_ext(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_lose_illegal_characters() {
        assert_eq!(sanitize_file_name("a/b:c*d?.md", "md"), "a-b-c-d-.md");
        assert_eq!(sanitize_file_name("..\\..\\evil", "md"), "-..-evil.md");
        assert_eq!(sanitize_file_name("CON", "pdf"), "_CON.pdf");
        assert_eq!(sanitize_file_name("   ", "png"), "export.png");
        assert_eq!(sanitize_file_name("notes.md", "md"), "notes.md");
        assert_eq!(sanitize_file_name("x\ny", "md"), "x y.md");
        assert_eq!(sanitize_file_name(&"a".repeat(300), "md").len(), 83);
    }

    #[test]
    fn content_must_be_text_or_base64_and_fit() {
        assert!(decode_body(None, None).is_err());
        assert!(decode_body(Some("a".into()), Some("YQ==".into())).is_err());
        assert_eq!(decode_body(None, Some("YQ==".into())).unwrap(), b"a");
        assert!(decode_body(None, Some("!!!".into())).is_err());
        let huge = "A".repeat(MAX_EXPORT_BYTES / 3 * 4 + 64);
        assert!(decode_body(None, Some(huge)).is_err());
    }

    #[test]
    fn a_write_replaces_the_file_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.md");
        std::fs::write(&path, "old").unwrap();
        write_atomically(&path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert!(!dir.path().join("out.md.tmp").exists());
    }
}
