//! The phone app's files, served under `/m/`.
//!
//! A request path is checked segment by segment before it touches the disk,
//! then the resolved file must still sit inside the root after symlinks are
//! followed: either check alone would be enough today, both keep it so.

use std::path::{Component, Path, PathBuf};

/// Shown when no phone bundle is installed yet.
pub const PLACEHOLDER_HTML: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flint</title>
<style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111;color:#eee;text-align:center;padding:24px}p{color:#aaa;max-width:32em}</style>
</head><body><main><h1>Flint</h1>
<p>Remote access is on, but this version of Flint does not include the phone app yet.</p>
</main></body></html>
"#;

#[derive(Debug, PartialEq, Eq)]
pub enum StaticError {
    /// The path tries to leave the root, or is not a plain relative path.
    Forbidden,
    NotFound,
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Turns the part of the URL after `/m/` into a relative path, or refuses it.
/// Decoding happens first, so `%2e%2e` is caught like `..`.
pub fn sanitize(rel: &str) -> Result<PathBuf, StaticError> {
    let decoded = percent_decode(rel).ok_or(StaticError::Forbidden)?;
    if decoded.contains('\\') || decoded.contains('\0') || decoded.contains(':') {
        return Err(StaticError::Forbidden);
    }
    let mut out = PathBuf::new();
    for seg in decoded.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err(StaticError::Forbidden),
            s => out.push(s),
        }
    }
    // Belt and braces: only plain components may remain.
    if out.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(StaticError::Forbidden);
    }
    Ok(out)
}

/// The file on disk for `rel` under `root`. A path with no extension that
/// does not exist falls back to `index.html`, so client-side routes load.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, StaticError> {
    let rel = sanitize(rel)?;
    let root = root.canonicalize().map_err(|_| StaticError::NotFound)?;
    let mut candidate = root.join(&rel);
    if candidate.is_dir() {
        candidate = candidate.join("index.html");
    }
    if !candidate.exists() && rel.extension().is_none() {
        candidate = root.join("index.html");
    }
    let real = candidate
        .canonicalize()
        .map_err(|_| StaticError::NotFound)?;
    if !real.starts_with(&root) {
        return Err(StaticError::Forbidden);
    }
    if !real.is_file() {
        return Err(StaticError::NotFound);
    }
    Ok(real)
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}
