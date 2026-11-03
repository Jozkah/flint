//! The text format `apply_patch` takes, parsed and applied in memory.
//!
//! One patch changes several files at once:
//!
//! ```text
//! *** Begin Patch
//! *** Add File: notes/new.txt
//! +first line
//! *** Update File: src/a.rs
//! *** Move to: src/b.rs
//! @@ fn main
//!  context line
//! -old line
//! +new line
//! *** Delete File: old.txt
//! *** End Patch
//! ```
//!
//! Nothing here touches the disk. [`parse`] turns text into [`Hunk`]s,
//! [`Hunk::touched`] names every path a hunk reaches (the permission gate asks
//! about each one before anything runs), and [`apply_update`] computes the new
//! text of one file so the caller can check every file before writing any.

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const ADD: &str = "*** Add File: ";
const DELETE: &str = "*** Delete File: ";
const UPDATE: &str = "*** Update File: ";
const MOVE: &str = "*** Move to: ";
const END_OF_FILE: &str = "*** End of File";

/// One `@@` section of an update: the lines it expects (`old`), the lines that
/// replace them (`new`), and the optional header text that narrows where the
/// section starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub header: Option<String>,
    pub old: Vec<String>,
    pub new: Vec<String>,
    /// Marked `*** End of File`: the section is anchored at the end.
    pub at_end: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hunk {
    Add { path: String, content: String },
    Delete { path: String },
    Update { path: String, move_to: Option<String>, chunks: Vec<Chunk> },
}

/// How a touched path is changed. The gate treats an update like `edit`
/// and everything else like `write`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Touch {
    Add,
    Update,
    Delete,
    MoveFrom,
    MoveTo,
}

impl Hunk {
    /// Every path this hunk reaches, with what happens to it.
    pub fn touched(&self) -> Vec<(&str, Touch)> {
        match self {
            Hunk::Add { path, .. } => vec![(path, Touch::Add)],
            Hunk::Delete { path } => vec![(path, Touch::Delete)],
            Hunk::Update { path, move_to: None, .. } => vec![(path, Touch::Update)],
            Hunk::Update { path, move_to: Some(to), .. } => {
                vec![(path, Touch::MoveFrom), (to, Touch::MoveTo)]
            }
        }
    }
}

/// Every path a patch reaches, in order.
pub fn touched(hunks: &[Hunk]) -> Vec<(&str, Touch)> {
    hunks.iter().flat_map(Hunk::touched).collect()
}

/// Parse a patch. Strict about structure (one clear error naming the line),
/// forgiving about what models get wrong most: a missing `*** End Patch`, a
/// blank line inside a section standing for an empty context line, and a
/// patch wrapped in a code fence or a heredoc.
pub fn parse(text: &str) -> Result<Vec<Hunk>, String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() && lines[i].trim() != BEGIN {
        // A fence or a `apply_patch <<'EOF'` line before the marker is noise.
        if !lines[i].trim().is_empty() && !is_wrapper(lines[i]) {
            return Err(format!(
                "patch must start with `{BEGIN}` (found `{}`)",
                clip(lines[i])
            ));
        }
        i += 1;
    }
    if i == lines.len() {
        return Err(format!("patch must start with `{BEGIN}` and end with `{END}`"));
    }
    i += 1;
    let mut hunks = Vec::new();
    while i < lines.len() {
        let line = lines[i];
        if line.trim() == END || line.trim().starts_with("```") || line.trim() == "EOF" {
            break;
        }
        if let Some(path) = line.strip_prefix(ADD) {
            let path = clean_path(path)?;
            i += 1;
            let mut content = String::new();
            while i < lines.len() && !is_marker(lines[i]) {
                match lines[i].strip_prefix('+') {
                    Some(rest) => {
                        content.push_str(rest);
                        content.push('\n');
                    }
                    None => {
                        return Err(format!(
                            "Add File {path}: every line must start with `+` (line {}: `{}`)",
                            i + 1,
                            clip(lines[i])
                        ))
                    }
                }
                i += 1;
            }
            hunks.push(Hunk::Add { path, content });
        } else if let Some(path) = line.strip_prefix(DELETE) {
            hunks.push(Hunk::Delete { path: clean_path(path)? });
            i += 1;
        } else if let Some(path) = line.strip_prefix(UPDATE) {
            let path = clean_path(path)?;
            i += 1;
            let mut move_to = None;
            if i < lines.len() {
                if let Some(to) = lines[i].strip_prefix(MOVE) {
                    move_to = Some(clean_path(to)?);
                    i += 1;
                }
            }
            let (chunks, next) = parse_chunks(&lines, i, &path)?;
            i = next;
            if chunks.is_empty() && move_to.is_none() {
                return Err(format!("Update File {path}: no changes (expected `@@` sections)"));
            }
            hunks.push(Hunk::Update { path, move_to, chunks });
        } else if line.trim().is_empty() {
            i += 1;
        } else {
            return Err(format!(
                "line {}: expected `*** Add File:`, `*** Update File:`, `*** Delete File:` or `{END}`, found `{}`",
                i + 1,
                clip(line)
            ));
        }
    }
    if hunks.is_empty() {
        return Err("patch changes no files".to_string());
    }
    Ok(hunks)
}

fn parse_chunks(lines: &[&str], mut i: usize, path: &str) -> Result<(Vec<Chunk>, usize), String> {
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut current: Option<Chunk> = None;
    while i < lines.len() && !is_marker(lines[i]) {
        let line = lines[i];
        if let Some(header) = line.strip_prefix("@@") {
            if let Some(done) = current.take() {
                chunks.push(done);
            }
            let header = header.trim();
            current = Some(Chunk {
                header: (!header.is_empty() && !is_range_header(header)).then(|| header.to_string()),
                old: Vec::new(),
                new: Vec::new(),
                at_end: false,
            });
        } else if line.trim() == END_OF_FILE {
            if let Some(c) = current.as_mut() {
                c.at_end = true;
            }
        } else {
            // A section without its own `@@` is allowed for the first one.
            let c = current.get_or_insert(Chunk {
                header: None,
                old: Vec::new(),
                new: Vec::new(),
                at_end: false,
            });
            match line.chars().next() {
                Some(' ') => {
                    c.old.push(line[1..].to_string());
                    c.new.push(line[1..].to_string());
                }
                Some('-') => c.old.push(line[1..].to_string()),
                Some('+') => c.new.push(line[1..].to_string()),
                // A blank line is an empty context line.
                None => {
                    c.old.push(String::new());
                    c.new.push(String::new());
                }
                Some(_) => {
                    return Err(format!(
                        "Update File {path}: line {} must start with ` `, `-`, `+` or `@@` (found `{}`)",
                        i + 1,
                        clip(line)
                    ))
                }
            }
        }
        i += 1;
    }
    if let Some(done) = current.take() {
        chunks.push(done);
    }
    // A trailing blank line before the next marker is padding, not content.
    for c in chunks.iter_mut() {
        while c.old.last().is_some_and(String::is_empty)
            && c.new.last().is_some_and(String::is_empty)
            && c.old.len() > 1
        {
            c.old.pop();
            c.new.pop();
        }
    }
    Ok((chunks, i))
}

/// `-2,2 +2,2 @@`, the line-number header of a unified diff. It names no text
/// to find, and models write it from habit, so it is read as no header.
fn is_range_header(header: &str) -> bool {
    let inner = header.trim_end_matches("@@").trim();
    !inner.is_empty()
        && inner
            .split_whitespace()
            .all(|part| part.trim_start_matches(['-', '+']).split(',').all(|n| n.parse::<u32>().is_ok()))
}

fn is_marker(line: &str) -> bool {
    line.starts_with("*** ") && (line.starts_with(ADD) || line.starts_with(DELETE)
        || line.starts_with(UPDATE) || line.trim() == END
        || line.trim().starts_with("```"))
}

fn is_wrapper(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("```") || t.starts_with("apply_patch") || t.starts_with("cat ")
}

fn clean_path(raw: &str) -> Result<String, String> {
    let p = raw.trim();
    if p.is_empty() {
        return Err("a file header names no path".to_string());
    }
    Ok(p.to_string())
}

fn clip(line: &str) -> String {
    line.chars().take(60).collect()
}

/// The new text of `original` with every chunk applied in order. Each chunk is
/// found at or after where the previous one ended, so two edits to the same
/// text land in the order written. Matching is exact first, then ignoring
/// trailing whitespace, then ignoring indentation. A file's line endings and
/// final newline are kept.
pub fn apply_update(original: &str, chunks: &[Chunk], shown: &str) -> Result<String, String> {
    let crlf = original.contains("\r\n");
    let had_final_newline = original.is_empty() || original.ends_with('\n');
    let mut lines: Vec<String> = original
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    if original.ends_with('\n') || original.is_empty() {
        lines.pop();
    }
    let mut cursor = 0usize;
    for (n, chunk) in chunks.iter().enumerate() {
        let mut from = cursor;
        if let Some(header) = &chunk.header {
            match lines[from..].iter().position(|l| l.trim() == header.trim()) {
                Some(at) => from += at + 1,
                None => {
                    return Err(format!(
                        "{shown}: section {} header `{}` not found after line {}",
                        n + 1,
                        clip(header),
                        from
                    ))
                }
            }
        }
        if chunk.old.is_empty() {
            // Pure insertion: after the header line, else at the end.
            let at = if chunk.header.is_some() { from } else { lines.len() };
            lines.splice(at..at, chunk.new.iter().cloned());
            cursor = at + chunk.new.len();
            continue;
        }
        let at = if chunk.at_end {
            find_from_end(&lines, &chunk.old, from)
        } else {
            find(&lines, &chunk.old, from)
        };
        let Some(at) = at else {
            return Err(format!(
                "{shown}: section {} does not match the file. Expected these lines at or after line {}:\n{}\nRead the file again and rebuild the patch from its current text.",
                n + 1,
                from + 1,
                chunk.old.iter().take(6).map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n")
            ));
        };
        let end = at + chunk.old.len();
        lines.splice(at..end, chunk.new.iter().cloned());
        cursor = at + chunk.new.len();
    }
    let eol = if crlf { "\r\n" } else { "\n" };
    let mut out = lines.join(eol);
    if !lines.is_empty() && had_final_newline {
        out.push_str(eol);
    }
    Ok(out)
}

fn find(lines: &[String], old: &[String], from: usize) -> Option<usize> {
    for mode in 0..3 {
        if let Some(at) = scan(lines, old, from, mode, false) {
            return Some(at);
        }
    }
    None
}

fn find_from_end(lines: &[String], old: &[String], from: usize) -> Option<usize> {
    for mode in 0..3 {
        if let Some(at) = scan(lines, old, from, mode, true) {
            return Some(at);
        }
    }
    None
}

fn scan(lines: &[String], old: &[String], from: usize, mode: u8, last: bool) -> Option<usize> {
    if old.len() > lines.len() || from > lines.len() - old.len() {
        return None;
    }
    let same = |a: &str, b: &str| match mode {
        0 => a == b,
        1 => a.trim_end() == b.trim_end(),
        _ => a.trim() == b.trim(),
    };
    let hit = |at: usize| old.iter().enumerate().all(|(k, o)| same(&lines[at + k], o));
    let range = from..=lines.len() - old.len();
    if last {
        range.rev().find(|at| hit(*at))
    } else {
        range.into_iter().find(|at| hit(*at))
    }
}

/// The added text of a patch as a `+++`/`+` diff, one file after another, for
/// the credential scan and the permission prompt. Removals are shown as `-`
/// lines so a person sees what goes.
pub fn render_diff(hunks: &[Hunk]) -> String {
    let mut out = String::new();
    for h in hunks {
        match h {
            Hunk::Add { path, content } => {
                out.push_str(&format!("+++ {path} (new file)\n"));
                for l in content.lines() {
                    out.push_str(&format!("+{l}\n"));
                }
            }
            Hunk::Delete { path } => out.push_str(&format!("--- {path} (deleted)\n")),
            Hunk::Update { path, move_to, chunks } => {
                match move_to {
                    Some(to) => out.push_str(&format!("+++ {to} (moved from {path})\n")),
                    None => out.push_str(&format!("+++ {path}\n")),
                }
                for c in chunks {
                    for l in &c.old {
                        if !c.new.contains(l) {
                            out.push_str(&format!("-{l}\n"));
                        }
                    }
                    for l in &c.new {
                        if !c.old.contains(l) {
                            out.push_str(&format!("+{l}\n"));
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(body: &str) -> String {
        format!("*** Begin Patch\n{body}*** End Patch\n")
    }

    #[test]
    fn parses_every_hunk_kind() {
        let p = patch(
            "*** Add File: a.txt\n+one\n+two\n\
             *** Update File: b.rs\n*** Move to: c.rs\n@@ fn main\n ctx\n-old\n+new\n\
             *** Delete File: d.txt\n",
        );
        let hunks = parse(&p).unwrap();
        assert_eq!(hunks.len(), 3);
        assert_eq!(hunks[0], Hunk::Add { path: "a.txt".into(), content: "one\ntwo\n".into() });
        match &hunks[1] {
            Hunk::Update { path, move_to, chunks } => {
                assert_eq!(path, "b.rs");
                assert_eq!(move_to.as_deref(), Some("c.rs"));
                assert_eq!(chunks[0].header.as_deref(), Some("fn main"));
                assert_eq!(chunks[0].old, ["ctx", "old"]);
                assert_eq!(chunks[0].new, ["ctx", "new"]);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(hunks[2], Hunk::Delete { path: "d.txt".into() });
        let paths: Vec<_> = touched(&hunks).iter().map(|(p, _)| *p).collect();
        assert_eq!(paths, ["a.txt", "b.rs", "c.rs", "d.txt"]);
    }

    #[test]
    fn refuses_malformed_patches_with_the_line() {
        assert!(parse("nothing here").unwrap_err().contains("must start"));
        assert!(parse(&patch("")).unwrap_err().contains("no files"));
        let bad_add = parse(&patch("*** Add File: a\nno plus\n")).unwrap_err();
        assert!(bad_add.contains("must start with `+`"), "{bad_add}");
        let bad_upd = parse(&patch("*** Update File: a\n@@\n?what\n")).unwrap_err();
        assert!(bad_upd.contains("must start with"), "{bad_upd}");
        let junk = parse(&patch("*** Rename File: a\n")).unwrap_err();
        assert!(junk.contains("expected"), "{junk}");
    }

    #[test]
    fn tolerates_a_fence_and_a_missing_end_marker() {
        let p = "```\n*** Begin Patch\n*** Delete File: x\n```\n";
        assert_eq!(parse(p).unwrap(), vec![Hunk::Delete { path: "x".into() }]);
        let ok = "*** Begin Patch\n*** Delete File: x\n";
        assert_eq!(parse(ok).unwrap(), vec![Hunk::Delete { path: "x".into() }]);
    }

    fn chunks(body: &str) -> Vec<Chunk> {
        match parse(&patch(&format!("*** Update File: f\n{body}"))).unwrap().remove(0) {
            Hunk::Update { chunks, .. } => chunks,
            _ => unreachable!(),
        }
    }

    #[test]
    fn applies_in_order_and_keeps_crlf_and_final_newline() {
        let c = chunks("@@\n a\n-b\n+B\n@@\n-d\n+D\n+E\n");
        let out = apply_update("a\r\nb\r\nc\r\nd\r\n", &c, "f").unwrap();
        assert_eq!(out, "a\r\nB\r\nc\r\nD\r\nE\r\n");
        let no_nl = apply_update("a\nb", &chunks("@@\n a\n-b\n+x\n"), "f").unwrap();
        assert_eq!(no_nl, "a\nx");
    }

    #[test]
    fn header_narrows_the_match_and_insertion_goes_after_it() {
        let c = chunks("@@ fn two\n-    x\n+    y\n");
        let src = "fn one\n    x\n}\nfn two\n    x\n}\n";
        let out = apply_update(src, &c, "f").unwrap();
        assert_eq!(out, "fn one\n    x\n}\nfn two\n    y\n}\n");
        let ins = chunks("@@ fn one\n+// hi\n");
        assert_eq!(apply_update("fn one\nbody\n", &ins, "f").unwrap(), "fn one\n// hi\nbody\n");
    }

    #[test]
    fn a_unified_diff_range_header_is_not_a_header() {
        let c = chunks("@@ -2,2 +2,2 @@\n-b\n+B\n");
        assert_eq!(c[0].header, None);
        assert_eq!(apply_update("a\nb\n", &c, "f").unwrap(), "a\nB\n");
        assert!(!is_range_header("fn main"));
    }

    #[test]
    fn matches_loosely_when_whitespace_differs() {
        let c = chunks("@@\n-  keep  \n+kept\n");
        assert_eq!(apply_update("x\nkeep\n", &c, "f").unwrap(), "x\nkept\n");
    }

    #[test]
    fn a_section_that_does_not_match_is_an_error_naming_it() {
        let err = apply_update("a\nb\n", &chunks("@@\n-zzz\n+y\n"), "f").unwrap_err();
        assert!(err.contains("section 1 does not match"), "{err}");
        let hdr = apply_update("a\n", &chunks("@@ nope\n-a\n+b\n"), "f").unwrap_err();
        assert!(hdr.contains("header `nope` not found"), "{hdr}");
    }

    #[test]
    fn render_diff_lists_added_lines_per_file() {
        let h = parse(&patch("*** Add File: n.txt\n+key\n*** Update File: u\n@@\n-a\n+b\n")).unwrap();
        let d = render_diff(&h);
        assert!(d.contains("+++ n.txt") && d.contains("+key") && d.contains("+++ u") && d.contains("-a") && d.contains("+b"), "{d}");
    }
}
