//! The diagnostic bundle's size caps and archive format, shared by the CLI
//! (`flint bug-report`, `/bug`) and the desktop "Save diagnostic bundle"
//! action, so both write the same `.tar.gz` shape under the same limits.

use flate2::write::GzEncoder;
use flate2::Compression;

/// Largest one member may be: the newest bytes are kept.
pub const MEMBER_CAP: usize = 1024 * 1024;
/// Largest the members may be together.
pub const TOTAL_CAP: usize = 8 * 1024 * 1024;

/// Cut each member to its share, keeping its tail (the newest messages and
/// log lines) behind a note that says what was dropped. Returns one line per
/// member cut, for the preview.
pub fn cap_members(members: &mut [(String, String)], member_cap: usize, total_cap: usize) -> Vec<String> {
    let mut notes = Vec::new();
    let mut left = total_cap;
    for (name, content) in members.iter_mut() {
        let cap = member_cap.min(left);
        if content.len() > cap {
            let original = content.len();
            let mut start = original - cap;
            while !content.is_char_boundary(start) {
                start += 1;
            }
            // Start on a whole line when one begins inside the kept part.
            if let Some(nl) = content[start..].find('\n') {
                if nl + 1 < content.len() - start {
                    start += nl + 1;
                }
            }
            let kept = content.len() - start;
            *content = format!("[truncated: kept the last {kept} of {original} bytes]\n{}", &content[start..]);
            notes.push(format!("{name}: kept the last {kept} of {original} bytes"));
        }
        left = left.saturating_sub(content.len());
    }
    notes
}

/// Write `members` as a gzipped tar into `writer`, in order, owner-only modes.
pub fn write_archive<W: std::io::Write>(writer: W, members: &[(String, String)]) -> Result<W, String> {
    let mut tar = tar::Builder::new(GzEncoder::new(writer, Compression::default()));
    for (name, content) in members {
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o600);
        header.set_mtime(chrono::Utc::now().timestamp().max(0) as u64);
        header.set_cksum();
        tar.append_data(&mut header, name, content.as_bytes())
            .map_err(|e| format!("archive write error: {e}"))?;
    }
    let enc = tar
        .into_inner()
        .map_err(|e| format!("archive finalize error: {e}"))?;
    enc.finish().map_err(|e| format!("gzip finish error: {e}"))
}
