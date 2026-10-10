use crate::{RagError, MAX_PARSE_FILE_SIZE};
use std::borrow::Cow;
use std::fs;
use std::io::{Cursor, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use calamine::{open_workbook_auto, Data, Reader as _};
use chardetng::EncodingDetector;
use csv as csv_crate;
use quick_xml::events::Event;
use quick_xml::Reader;
use zip::read::ZipArchive;

/// Run `f`, turning a panic into an error message (parsers can panic on
/// malformed PDFs; that must not take the app down).
fn guard<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(payload) => {
            let reason = if let Some(s) = payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown parser panic".to_string()
            };
            Err(format!("parser panicked: {reason}"))
        }
    }
}

/// Lenient second extractor. `pdf-extract` aborts on the first page, font or
/// content stream it cannot interpret; this walks the pages with lopdf
/// directly and keeps whatever text each page yields. Encrypted documents are
/// opened with the empty user password.
fn extract_pdf_text_lenient(bytes: &[u8]) -> Result<String, String> {
    guard(|| {
        let mut doc = lopdf::Document::load_mem(bytes).map_err(|e| e.to_string())?;
        if doc.is_encrypted() {
            doc.decrypt("").map_err(|e| match e {
                lopdf::Error::Decryption(lopdf::encryption::DecryptionError::IncorrectPassword) => {
                    "the PDF is password protected".to_string()
                }
                other => format!("unsupported encryption ({other})"),
            })?;
        }
        let mut out = String::new();
        let mut first_err = None;
        for page in doc.get_pages().keys() {
            for chunk in doc.extract_text_chunks(&[*page]) {
                match chunk {
                    Ok(t) => out.push_str(&t),
                    Err(e) => {
                        first_err.get_or_insert_with(|| e.to_string());
                    }
                }
            }
            out.push_str("\n");
        }
        if out.chars().all(char::is_whitespace) {
            if let Some(e) = first_err {
                return Err(e);
            }
        }
        Ok(out)
    })
}

/// Strict extractor first, lenient lopdf walk second, clear error if both fail.
fn extract_pdf_text(bytes: &[u8]) -> Result<String, RagError> {
    let primary = guard(|| pdf_extract::extract_text_from_mem(bytes).map_err(|e| e.to_string()));
    let primary_err = match primary {
        Ok(t) if t.chars().any(|c| !c.is_whitespace()) => return Ok(t),
        // Parsed but empty: let the fallback try before calling it a scan.
        Ok(t) => {
            return Ok(extract_pdf_text_lenient(bytes).unwrap_or(t));
        }
        Err(e) => e,
    };
    match extract_pdf_text_lenient(bytes) {
        Ok(t) => Ok(t),
        Err(fallback_err) => Err(RagError::ParseError(format!(
            "Could not read this PDF. It may be corrupted, password protected or use unsupported encryption.              (primary parser: {primary_err}; fallback parser: {fallback_err})"
        ))),
    }
}

pub fn parse_pdf(file_path: &str) -> Result<String, RagError> {
    let metadata = fs::metadata(file_path)?;
    if metadata.len() > MAX_PARSE_FILE_SIZE {
        return Err(RagError::ParseError("File too large (max 200MB)".to_string()));
    }
    let bytes = fs::read(file_path)?;
    let text = extract_pdf_text(&bytes)?;

    // Validate that the PDF has extractable text (not image-based/scanned)
    // Count meaningful characters (excluding whitespace)
    let meaningful_chars = text.chars()
        .filter(|c| !c.is_whitespace())
        .count();

    // Require at least 50 non-whitespace characters to consider it a text PDF
    // This threshold filters out PDFs that are purely images or scanned documents
    if meaningful_chars < 50 {
        return Err(RagError::ParseError(
            "PDF appears to be image-based or scanned. OCR is not supported yet. Please use a text-based PDF.".to_string()
        ));
    }

    Ok(text)
}

pub fn parse_text(file_path: &str) -> Result<String, RagError> {
    read_text_auto(file_path)
}

pub fn parse_document(file_path: &str, file_type: &str) -> Result<String, RagError> {
    match file_type.to_lowercase().as_str() {
        "pdf" | "application/pdf" => parse_pdf(file_path),
        "txt" | "text/plain" | "md" | "text/markdown"
        // JavaScript / TypeScript
        | "js" | "mjs" | "cjs" | "ts" | "mts" | "cts" | "jsx" | "tsx"
        // Python
        | "py" | "pyw" | "pyi"
        // C / C++
        | "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx"
        // Systems languages
        | "rs" | "go" | "swift" | "zig"
        // JVM languages
        | "java" | "kt" | "kts" | "scala" | "groovy" | "clj" | "cljs" | "hs" | "lhs" | "ml" | "mli" | "f" | "f77" | "f90" | "f95" | "f03" | "f08"
        // Scripting languages
        | "rb" | "php" | "lua" | "pl" | "pm" | "r" | "jl" | "vbs" | "asm" | "s" | "m" | "mm" | "pas" | "pp" | "erl" | "hrl" | "ex" | "exs"
        // .NET
        | "cs" | "fs" | "vb" | "xaml" | "csproj" | "sln"
        // CUDA
        | "cu" | "cuh"
        // Shaders
        | "hlsl" | "glsl" | "cg" | "shader"
        // Shell
        | "sh" | "bash" | "zsh" | "fish" | "ps1" | "psm1" | "bat" | "cmd"
        // Web
        | "css" | "scss" | "sass" | "less" | "vue" | "svelte" | "astro" | "asp" | "aspx" | "jsp"
        // Data / config formats
        | "json" | "jsonc" | "yaml" | "yml" | "toml" | "xml" | "ini"
        | "cfg" | "conf" | "config" | "env" | "properties" | "lock"
        // Query / markup
        | "sql" | "graphql" | "gql" | "tex" | "rst" | "adoc" | "textile"
        // Misc text
        | "log" | "diff" | "patch" | "gitignore" | "dockerfile" | "makefile" | "cmake" => parse_text(file_path),
        "csv" | "text/csv" => parse_csv(file_path),
        // Excel family via calamine
        "xlsx"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "xls"
        | "application/vnd.ms-excel"
        | "ods"
        | "application/vnd.oasis.opendocument.spreadsheet" => parse_spreadsheet(file_path),
        // PowerPoint
        "pptx"
        | "application/vnd.openxmlformats-officedocument.presentationml.presentation" => parse_pptx(file_path),
        // HTML
        "html" | "htm" | "text/html" => parse_html(file_path),
        "docx"
        | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            parse_docx(file_path)
        }
        other => {
            // Try MIME sniffing when extension or MIME is unknown
            match infer::get_from_path(file_path) {
                Ok(Some(k)) => {
                    let mime = k.mime_type();
                    // Guard against infinite recursion if mime matches the unknown extension
                    if mime != other {
                        return parse_document(file_path, mime);
                    }
                    Err(RagError::UnsupportedFileType(other.to_string()))
                }
                _ => {
                    // infer returned None → no binary magic bytes detected, treat as plain text
                    parse_text(file_path)
                }
            }
        }
    }
}

fn parse_docx(file_path: &str) -> Result<String, RagError> {
    let metadata = std::fs::metadata(file_path)?;
    if metadata.len() > MAX_PARSE_FILE_SIZE {
        return Err(RagError::ParseError("File too large (max 200MB)".to_string()));
    }
    let file = std::fs::File::open(file_path)?;
    let mut zip = ZipArchive::new(file).map_err(|e| RagError::ParseError(e.to_string()))?;

    // Standard DOCX stores document text at word/document.xml
    let mut doc_xml = match zip.by_name("word/document.xml") {
        Ok(f) => f,
        Err(_) => return Err(RagError::ParseError("document.xml not found".into())),
    };
    let mut xml_content = String::new();
    doc_xml
        .read_to_string(&mut xml_content)
        .map_err(|e| RagError::ParseError(e.to_string()))?;

    // Parse XML and extract text from w:t nodes; add newlines on w:p boundaries
    let mut reader = Reader::from_str(&xml_content);
    // No trim_text: quick-xml 0.38+ splits text at every entity reference,
    // and trimming each piece would eat the spaces around "&amp;".
    let mut buf = Vec::new();
    let mut result = String::new();
    let mut in_text = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":t") || name == "w:t" || name == "t" {
                    in_text = true;
                }
            }
            Ok(Event::End(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":t") || name == "w:t" || name == "t" {
                    in_text = false;
                    result.push(' ');
                }
                if name.ends_with(":p") || name == "w:p" || name == "p" {
                    // Paragraph end – add newline
                    result.push_str("\n\n");
                }
            }
            Ok(Event::Text(t)) => {
                if in_text {
                    result.push_str(&t.decode().unwrap_or_default());
                }
            }
            // quick-xml 0.38+ reports `&amp;`, `&#x41;` and friends as their
            // own events instead of unescaping them inside Text.
            Ok(Event::GeneralRef(r)) => {
                if in_text {
                    push_entity(&mut result, &r);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(RagError::ParseError(e.to_string())),
            _ => {}
        }
    }

    // Normalize whitespace
    let normalized = result
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(normalized)
}

fn parse_csv(file_path: &str) -> Result<String, RagError> {
    let metadata = fs::metadata(file_path)?;
    if metadata.len() > MAX_PARSE_FILE_SIZE {
        return Err(RagError::ParseError("File too large (max 200MB)".to_string()));
    }
    let mut rdr = csv_crate::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(file_path)
        .map_err(|e| RagError::ParseError(e.to_string()))?;
    let mut out = String::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| RagError::ParseError(e.to_string()))?;
        out.push_str(&rec.iter().collect::<Vec<_>>().join(", "));
        out.push('\n');
    }
    Ok(out)
}

fn parse_spreadsheet(file_path: &str) -> Result<String, RagError> {
    let metadata = fs::metadata(file_path)?;
    if metadata.len() > MAX_PARSE_FILE_SIZE {
        return Err(RagError::ParseError("File too large (max 200MB)".to_string()));
    }
    let mut workbook = open_workbook_auto(file_path)
        .map_err(|e| RagError::ParseError(e.to_string()))?;
    let mut out = String::new();
    for sheet_name in workbook.sheet_names().to_owned() {
        if let Ok(range) = workbook.worksheet_range(&sheet_name) {
            out.push_str(&format!("# Sheet: {}\n", sheet_name));
            for row in range.rows() {
                let cells = row
                    .iter()
                    .map(|c| match c {
                        Data::Empty => "".to_string(),
                        Data::String(s) => s.to_string(),
                        Data::Float(f) => format!("{}", f),
                        Data::Int(i) => i.to_string(),
                        Data::Bool(b) => b.to_string(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join("\t");
                out.push_str(&cells);
                out.push('\n');
            }
            out.push('\n');
        }
    }
    Ok(out)
}

fn parse_pptx(file_path: &str) -> Result<String, RagError> {
    let metadata = std::fs::metadata(file_path)?;
    if metadata.len() > MAX_PARSE_FILE_SIZE {
        return Err(RagError::ParseError("File too large (max 200MB)".to_string()));
    }
    let file = std::fs::File::open(file_path)?;
    let mut zip = ZipArchive::new(file).map_err(|e| RagError::ParseError(e.to_string()))?;

    // Collect slide files: ppt/slides/slide*.xml
    let mut slides = Vec::new();
    for i in 0..zip.len() {
        let name = zip.by_index(i).map(|f| f.name().to_string()).unwrap_or_default();
        if name.starts_with("ppt/slides/") && name.ends_with(".xml") {
            slides.push(name);
        }
    }
    slides.sort();

    let mut output = String::new();
    for slide_name in slides {
        let mut file = zip.by_name(&slide_name).map_err(|e| RagError::ParseError(e.to_string()))?;
        let mut xml = String::new();
        file.read_to_string(&mut xml).map_err(|e| RagError::ParseError(e.to_string()))?;
        output.push_str(&extract_pptx_text(&xml));
        output.push_str("\n\n");
    }
    Ok(output)
}

fn extract_pptx_text(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    // No trim_text: quick-xml 0.38+ splits text at every entity reference,
    // and trimming each piece would eat the spaces around "&amp;".
    let mut buf = Vec::new();
    let mut result = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":t") || name == "a:t" || name == "t" {
                    in_text = true;
                }
            }
            Ok(Event::End(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":t") || name == "a:t" || name == "t" {
                    in_text = false;
                    result.push(' ');
                }
            }
            Ok(Event::Text(t)) => {
                if in_text {
                    result.push_str(&t.decode().unwrap_or_default());
                }
            }
            // quick-xml 0.38+ reports `&amp;`, `&#x41;` and friends as their
            // own events instead of unescaping them inside Text.
            Ok(Event::GeneralRef(r)) => {
                if in_text {
                    push_entity(&mut result, &r);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    result
}

/// Append the text an entity reference stands for: a character reference
/// (`&#65;`, `&#x41;`) or one of the five predefined XML entities. Anything
/// else (a DTD-defined entity) is dropped, as `unescape` used to reject it.
fn push_entity(out: &mut String, r: &quick_xml::events::BytesRef<'_>) {
    if let Ok(Some(ch)) = r.resolve_char_ref() {
        out.push(ch);
        return;
    }
    if let Ok(name) = r.decode() {
        if let Some(text) = quick_xml::escape::resolve_predefined_entity(&name) {
            out.push_str(text);
        }
    }
}

fn parse_html(file_path: &str) -> Result<String, RagError> {
    let html = read_text_auto(file_path)?;
    // 80-column wrap default
    Ok(html2text::from_read(Cursor::new(html), 80))
}

fn read_text_auto(file_path: &str) -> Result<String, RagError> {
    let metadata = fs::metadata(file_path)?;
    if metadata.len() > MAX_PARSE_FILE_SIZE {
        return Err(RagError::ParseError("File too large (max 200MB)".to_string()));
    }
    let bytes = fs::read(file_path)?;
    // Detect encoding
    let mut detector = EncodingDetector::new();
    detector.feed(&bytes, true);
    let enc = detector.guess(None, true);
    let (decoded, _, had_errors) = enc.decode(&bytes);
    if had_errors {
        // fallback to UTF-8 lossy
        Ok(String::from_utf8_lossy(&bytes).to_string())
    } else {
        Ok(decoded.to_string())
    }
}

#[cfg(test)]
mod tests {
    //! #228: parser coverage. Fixtures are built in a per-test temp dir so no
    //! binary files live in the repo.
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "rag-parser-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn file(&self, name: &str, bytes: &[u8]) -> String {
            let path = self.0.join(name);
            fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn zip(&self, name: &str, entries: &[(&str, &str)]) -> String {
            let path = self.0.join(name);
            let file = fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            for (entry, body) in entries {
                zip.start_file(*entry, zip::write::FileOptions::default())
                    .unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
            path.to_string_lossy().into_owned()
        }

        /// A sparse file just over the parse limit, without writing 200 MB.
        fn oversized(&self, name: &str) -> String {
            let path = self.0.join(name);
            let file = fs::File::create(&path).unwrap();
            file.set_len(MAX_PARSE_FILE_SIZE + 1).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn is_too_large(err: RagError) -> bool {
        matches!(err, RagError::ParseError(ref m) if m.contains("too large"))
    }

    #[test]
    fn read_text_auto_reads_utf8() {
        let dir = TempDir::new("utf8");
        let path = dir.file("a.txt", "hello \u{00E9}t\u{00E9} \u{65E5}\u{672C}\n".as_bytes());
        assert_eq!(read_text_auto(&path).unwrap(), "hello \u{00E9}t\u{00E9} \u{65E5}\u{672C}\n");
    }

    #[test]
    fn read_text_auto_decodes_a_legacy_encoding() {
        let dir = TempDir::new("latin");
        // windows-1252 French text: not valid UTF-8.
        let bytes: &[u8] = b"Le caf\xE9 cr\xE8me de la r\xE9gion est tr\xE8s appr\xE9ci\xE9 \
            par les habitu\xE9s du march\xE9, \xE0 c\xF4t\xE9 de l'\xE9glise.\n";
        assert!(std::str::from_utf8(bytes).is_err());
        let path = dir.file("latin.txt", bytes);
        let text = read_text_auto(&path).unwrap();
        assert!(text.contains("caf\u{00E9}"), "{text}");
    }

    #[test]
    fn every_parser_rejects_an_oversized_file() {
        let dir = TempDir::new("big");
        for ext in ["txt", "csv", "html", "pdf", "docx", "pptx", "xlsx"] {
            let path = dir.oversized(&format!("big.{ext}"));
            let err = parse_document(&path, ext).unwrap_err();
            assert!(is_too_large(err), "{ext} accepted an oversized file");
        }
    }

    #[test]
    fn parse_csv_joins_cells_and_tolerates_ragged_rows() {
        let dir = TempDir::new("csv");
        let path = dir.file("a.csv", b"name,qty\napple,3\n\"b, c\",4,extra\n");
        let text = parse_document(&path, "csv").unwrap();
        assert_eq!(text, "name, qty\napple, 3\nb, c, 4, extra\n");
    }

    #[test]
    fn parse_csv_reports_invalid_utf8_as_an_error() {
        let dir = TempDir::new("csvbad");
        let path = dir.file("bad.csv", b"a,b\n\xFF\xFE,c\n");
        assert!(matches!(parse_document(&path, "csv"), Err(RagError::ParseError(_))));
    }

    #[test]
    fn parse_html_strips_markup() {
        let dir = TempDir::new("html");
        let path = dir.file(
            "a.html",
            b"<html><body><h1>Title</h1><p>Some <b>bold</b> text.</p><script>x()</script></body></html>",
        );
        let text = parse_document(&path, "html").unwrap();
        assert!(text.contains("Title"), "{text}");
        assert!(text.contains("bold"), "{text}");
        assert!(!text.contains("<p>"), "{text}");
    }

    #[test]
    fn parse_docx_extracts_paragraph_text() {
        let dir = TempDir::new("docx");
        let path = dir.zip(
            "a.docx",
            &[(
                "word/document.xml",
                r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>First &amp; one</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>"#,
            )],
        );
        let text = parse_document(&path, "docx").unwrap();
        assert_eq!(text, "First & one\nSecond");
    }

    #[test]
    fn parse_docx_without_document_xml_is_an_error() {
        let dir = TempDir::new("docxbad");
        let path = dir.zip("a.docx", &[("word/other.xml", "<x/>")]);
        let err = parse_document(&path, "docx").unwrap_err();
        assert!(matches!(err, RagError::ParseError(ref m) if m.contains("document.xml")));
    }

    #[test]
    fn a_non_zip_office_file_is_an_error_not_a_panic() {
        let dir = TempDir::new("notzip");
        for ext in ["docx", "pptx", "xlsx"] {
            let path = dir.file(&format!("a.{ext}"), b"this is not a zip archive");
            assert!(parse_document(&path, ext).is_err(), "{ext}");
        }
    }

    #[test]
    fn parse_pptx_reads_slides_in_order() {
        let dir = TempDir::new("pptx");
        let path = dir.zip(
            "a.pptx",
            &[
                ("ppt/slides/slide2.xml", r#"<p:sld xmlns:a="a" xmlns:p="p"><a:t>Second slide</a:t></p:sld>"#),
                ("ppt/slides/slide1.xml", r#"<p:sld xmlns:a="a" xmlns:p="p"><a:t>First slide</a:t></p:sld>"#),
                ("ppt/presentation.xml", "<p:presentation/>"),
            ],
        );
        let text = parse_document(&path, "pptx").unwrap();
        let first = text.find("First slide").expect("slide 1 text");
        let second = text.find("Second slide").expect("slide 2 text");
        assert!(first < second, "{text}");
    }

    #[test]
    fn a_malformed_pdf_is_an_error_not_a_panic() {
        let dir = TempDir::new("pdf");
        let path = dir.file("a.pdf", b"%PDF-1.4\nthis is truncated garbage");
        assert!(matches!(parse_document(&path, "pdf"), Err(RagError::ParseError(_))));
    }

    /// A structurally valid one-page PDF whose page draws nothing, with a real
    /// xref table so lopdf loads it without falling back to recovery.
    fn blank_pdf() -> Vec<u8> {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
            "<< /Length 0 >>\nstream\n\nendstream",
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
        }
        let xref_at = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for off in offsets {
            pdf.extend_from_slice(format!("{:010} 00000 n \n", off).as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref_at
            )
            .as_bytes(),
        );
        pdf
    }

    /// Build a PDF from object bodies (1-based ids) with a real xref table.
    fn build_pdf(objects: &[String], trailer_extra: &str) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4
".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj
{}
endobj
", i + 1, body).as_bytes());
        }
        let xref_at = pdf.len();
        pdf.extend_from_slice(format!("xref
0 {}
", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f 
");
        for off in offsets {
            pdf.extend_from_slice(format!("{:010} 00000 n 
", off).as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer
<< /Size {} /Root 1 0 R {} >>
startxref
{}
%%EOF
",
                objects.len() + 1,
                trailer_extra,
                xref_at
            )
            .as_bytes(),
        );
        pdf
    }

    fn stream(body: &str) -> String {
        format!("<< /Length {} >>
stream
{}
endstream", body.len(), body)
    }

    const SENTENCE: &str =
        "The quick brown fox jumps over the lazy dog while the PDF fallback extractor keeps reading";

    /// Page 1 is ordinary text. Page 2 selects a font whose resource points at
    /// an object that does not exist, which the strict extractor rejects.
    fn pdf_with_a_broken_second_page() -> Vec<u8> {
        let page1 = stream(&format!("BT /F1 12 Tf 20 100 Td ({SENTENCE}) Tj ET"));
        let page2 = stream("BT /F9 12 Tf 20 100 Td (Second page text) Tj ET");
        build_pdf(
            &[
                "<< /Type /Catalog /Pages 2 0 R >>".into(),
                "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>".into(),
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>".into(),
                page1,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F9 99 0 R >> >> /Contents 6 0 R >>".into(),
                page2,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),
            ],
            "",
        )
    }

    #[test]
    fn strict_extractor_rejects_the_broken_page_pdf() {
        let bytes = pdf_with_a_broken_second_page();
        // It panics rather than erroring; `guard` turns that into an Err.
        assert!(guard(|| pdf_extract::extract_text_from_mem(&bytes).map_err(|e| e.to_string())).is_err());
    }

    #[test]
    fn the_lenient_fallback_recovers_text_the_strict_parser_rejects() {
        let dir = TempDir::new("pdffallback");
        let path = dir.file("broken.pdf", &pdf_with_a_broken_second_page());
        let text = parse_document(&path, "pdf").unwrap();
        assert!(text.contains("quick brown fox"), "{text}");
    }

    #[test]
    fn unsupported_encryption_yields_a_clear_error() {
        let page = stream(&format!("BT /F1 12 Tf 20 100 Td ({SENTENCE}) Tj ET"));
        let bytes = build_pdf(
            &[
                "<< /Type /Catalog /Pages 2 0 R >>".into(),
                "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".into(),
                page,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),
                "<< /Filter /NoSuchHandler /V 9 /R 9 /O (x) /U (y) /P -4 >>".into(),
            ],
            "/Encrypt 6 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]",
        );
        let dir = TempDir::new("pdfenc");
        let path = dir.file("enc.pdf", &bytes);
        let err = parse_document(&path, "pdf").unwrap_err();
        assert!(
            matches!(err, RagError::ParseError(ref m) if m.contains("Could not read this PDF") && m.contains("encryption")),
            "{err:?}"
        );
    }

    #[test]
    fn a_pdf_with_too_little_text_is_reported_as_image_based() {
        let dir = TempDir::new("pdfblank");
        let path = dir.file("blank.pdf", &blank_pdf());
        let err = parse_document(&path, "pdf").unwrap_err();
        assert!(
            matches!(err, RagError::ParseError(ref m) if m.contains("image-based")),
            "{err:?}"
        );
    }

    #[test]
    fn parse_spreadsheet_reads_a_minimal_xlsx() {
        let dir = TempDir::new("xlsx");
        let path = dir.zip(
            "a.xlsx",
            &[
                (
                    "_rels/.rels",
                    r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
                ),
                (
                    "xl/workbook.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>apple</t></is></c><c r="B1"><v>3</v></c></row></sheetData></worksheet>"#,
                ),
            ],
        );
        let text = parse_document(&path, "xlsx").unwrap();
        assert!(text.contains("# Sheet: Data"), "{text}");
        assert!(text.contains("apple\t3"), "{text}");
    }

    #[test]
    fn unknown_extensions_without_magic_bytes_parse_as_text() {
        let dir = TempDir::new("unknown");
        let path = dir.file("notes.weird", b"plain words\n");
        assert_eq!(parse_document(&path, "weird").unwrap(), "plain words\n");
    }

    #[test]
    fn source_code_extensions_parse_as_text() {
        let dir = TempDir::new("code");
        let path = dir.file("main.rs", b"fn main() {}\n");
        assert_eq!(parse_document(&path, "rs").unwrap(), "fn main() {}\n");
    }

    #[test]
    fn pptx_text_resolves_entities_and_keeps_their_spacing() {
        let xml = r#"<p:sld xmlns:a="a" xmlns:p="p"><a:t>A &amp; B &#x43;&#68;</a:t></p:sld>"#;
        assert_eq!(extract_pptx_text(xml).trim(), "A & B CD");
    }
}
