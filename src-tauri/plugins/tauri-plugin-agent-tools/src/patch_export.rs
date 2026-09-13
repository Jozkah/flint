//! A change as a patch someone else can read and apply. AH-168.
//!
//! Text files become a unified diff in the form `git apply` reads: a
//! `diff --git` header, `new file` and `deleted file` markers, three lines of
//! context and the "no newline at end of file" note. A file that is not text
//! -- not UTF-8, or holding a NUL byte -- cannot be carried faithfully in a
//! text diff, so it is listed apart and its new content is shipped whole next
//! to the patch.

use similar::TextDiff;

use crate::proposal::FileInput;

/// A file the patch cannot carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WholeFile {
    pub path: String,
    /// `None` when the change deletes it.
    pub content: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PatchText {
    pub patch: String,
    pub whole: Vec<WholeFile>,
}

fn as_text(bytes: Option<&[u8]>) -> Option<Option<&str>> {
    match bytes {
        None => Some(None),
        Some(b) if b.contains(&0) => None,
        Some(b) => std::str::from_utf8(b).ok().map(Some),
    }
}

/// The unified patch for these changes, in path order.
pub fn unified_patch(inputs: &[FileInput]) -> PatchText {
    let mut sorted: Vec<&FileInput> = inputs.iter().filter(|i| i.base != i.proposed).collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut out = PatchText::default();
    for input in sorted {
        let (Some(base), Some(new)) = (as_text(input.base.as_deref()), as_text(input.proposed.as_deref()))
        else {
            out.whole.push(WholeFile {
                path: input.path.clone(),
                content: input.proposed.clone(),
            });
            continue;
        };
        let path = &input.path;
        out.patch.push_str(&format!("diff --git a/{path} b/{path}\n"));
        let (old_name, new_name) = match (base, new) {
            (None, _) => {
                out.patch.push_str("new file mode 100644\n");
                ("/dev/null".to_string(), format!("b/{path}"))
            }
            (_, None) => {
                out.patch.push_str("deleted file mode 100644\n");
                (format!("a/{path}"), "/dev/null".to_string())
            }
            _ => (format!("a/{path}"), format!("b/{path}")),
        };
        let (a, b) = (base.unwrap_or(""), new.unwrap_or(""));
        let diff = TextDiff::from_lines(a, b);
        let body = diff
            .unified_diff()
            .context_radius(3)
            .missing_newline_hint(true)
            .header(&old_name, &new_name)
            .to_string();
        out.patch.push_str(&body);
        if !body.is_empty() && !body.ends_with('\n') {
            out.patch.push('\n');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Reading a patch back (AH-169)
// ---------------------------------------------------------------------------

/// One file's section of a patch, as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePatch {
    pub path: String,
    pub added: bool,
    pub deleted: bool,
    hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Hunk {
    old_start: usize,
    old_len: usize,
    /// `(' ' | '-' | '+', text including its newline when it has one)`.
    lines: Vec<(char, String)>,
}

fn range(spec: &str) -> Option<(usize, usize)> {
    let mut parts = spec.splitn(2, ',');
    let start = parts.next()?.parse().ok()?;
    let len = match parts.next() {
        Some(l) => l.parse().ok()?,
        None => 1,
    };
    Some((start, len))
}

/// Split a patch written by [`unified_patch`] into its files.
///
/// Strict on purpose: the text comes from outside Jan. Anything this module
/// does not itself write -- a rename or mode header, a binary patch, a hunk
/// whose line counts disagree with its header, a path that differs between
/// its `a/` and `b/` names -- is an error rather than a guess.
pub fn split_patch(text: &str) -> Result<Vec<FilePatch>, String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut out: Vec<FilePatch> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let Some(rest) = line.strip_prefix("diff --git a/") else {
            return Err(format!("line {}: expected a `diff --git` header", i + 1));
        };
        let rest = rest.trim_end_matches('\n');
        let Some((a, b)) = rest.split_once(" b/") else {
            return Err(format!("line {}: malformed `diff --git` header", i + 1));
        };
        if a != b || a.is_empty() {
            return Err(format!("line {}: a file's two names differ ({a} / {b})", i + 1));
        }
        let path = a.to_string();
        i += 1;
        let mut fp = FilePatch { path: path.clone(), added: false, deleted: false, hunks: Vec::new() };
        match lines.get(i).map(|l| l.trim_end_matches('\n')) {
            Some("new file mode 100644") => {
                fp.added = true;
                i += 1;
            }
            Some("deleted file mode 100644") => {
                fp.deleted = true;
                i += 1;
            }
            _ => {}
        }
        let old = lines.get(i).map(|l| l.trim_end_matches('\n'));
        let new = lines.get(i + 1).map(|l| l.trim_end_matches('\n'));
        let want_old = if fp.added { "--- /dev/null".to_string() } else { format!("--- a/{path}") };
        let want_new = if fp.deleted { "+++ /dev/null".to_string() } else { format!("+++ b/{path}") };
        if old != Some(want_old.as_str()) || new != Some(want_new.as_str()) {
            return Err(format!("{path}: file header lines do not match the file"));
        }
        i += 2;
        while i < lines.len() && lines[i].starts_with("@@ ") {
            let header = lines[i].trim_end_matches('\n');
            let inner = header
                .strip_prefix("@@ -")
                .and_then(|h| h.split_once(" @@"))
                .map(|(r, _)| r)
                .ok_or_else(|| format!("{path}: malformed hunk header {header:?}"))?;
            let (old_spec, new_spec) = inner
                .split_once(" +")
                .ok_or_else(|| format!("{path}: malformed hunk header {header:?}"))?;
            let (old_start, old_len) = range(old_spec).ok_or_else(|| format!("{path}: bad range {old_spec}"))?;
            let (_, new_len) = range(new_spec).ok_or_else(|| format!("{path}: bad range {new_spec}"))?;
            i += 1;
            let mut hunk = Hunk { old_start, old_len, lines: Vec::new() };
            let (mut seen_old, mut seen_new) = (0, 0);
            while i < lines.len() && (seen_old < old_len || seen_new < new_len) {
                let l = lines[i];
                let (sign, body) = l.split_at(l.char_indices().nth(1).map_or(l.len(), |(n, _)| n));
                let sign = sign.chars().next().unwrap_or(' ');
                match sign {
                    ' ' => {
                        seen_old += 1;
                        seen_new += 1;
                    }
                    '-' => seen_old += 1,
                    '+' => seen_new += 1,
                    _ => return Err(format!("{path}: unexpected line in a hunk: {l:?}")),
                }
                hunk.lines.push((sign, body.to_string()));
                i += 1;
                if lines.get(i).is_some_and(|n| n.starts_with("\\ ")) {
                    if let Some(last) = hunk.lines.last_mut() {
                        if let Some(stripped) = last.1.strip_suffix('\n') {
                            last.1 = stripped.to_string();
                        }
                    }
                    i += 1;
                }
            }
            if seen_old != old_len || seen_new != new_len {
                return Err(format!("{path}: a hunk is shorter than its header says"));
            }
            fp.hunks.push(hunk);
        }
        if out.iter().any(|o| o.path == path) {
            return Err(format!("{path} appears twice in the patch"));
        }
        out.push(fp);
    }
    Ok(out)
}

/// Apply one file's section to the exact base it was made from.
///
/// Every context and removed line must match the base where the hunk says it
/// is. `Ok(None)` is a deletion.
pub fn apply_file_patch(base: Option<&str>, fp: &FilePatch) -> Result<Option<String>, String> {
    if fp.added && base.is_some() {
        return Err(format!("{} is added by the patch but exists at the base", fp.path));
    }
    if !fp.added && base.is_none() {
        return Err(format!("{} is changed by the patch but is not at the base", fp.path));
    }
    let base_lines: Vec<&str> = base.unwrap_or("").split_inclusive('\n').collect();
    let mut out = String::new();
    let mut at = 0usize;
    for h in &fp.hunks {
        // `-k,0` inserts after line k; otherwise the hunk starts at line k.
        let start = if h.old_len == 0 { h.old_start } else { h.old_start.saturating_sub(1) };
        if start < at || start > base_lines.len() {
            return Err(format!("{}: a hunk is out of order or past the end", fp.path));
        }
        out.extend(base_lines[at..start].iter().copied());
        at = start;
        for (sign, text) in &h.lines {
            match sign {
                ' ' | '-' => {
                    if base_lines.get(at).copied() != Some(text.as_str()) {
                        return Err(format!("{}: the patch does not fit its base at line {}", fp.path, at + 1));
                    }
                    if *sign == ' ' {
                        out.push_str(text);
                    }
                    at += 1;
                }
                _ => out.push_str(text),
            }
        }
    }
    out.extend(base_lines[at..].iter().copied());
    if fp.deleted {
        if !out.is_empty() {
            return Err(format!("{}: a deletion leaves content behind", fp.path));
        }
        return Ok(None);
    }
    Ok(Some(out))
}

#[cfg(test)]
mod read_back_tests {
    use super::*;

    fn case(path: &str, base: Option<&str>, new: Option<&str>) -> FileInput {
        FileInput {
            path: path.into(),
            base: base.map(|s| s.as_bytes().to_vec()),
            proposed: new.map(|s| s.as_bytes().to_vec()),
        }
    }

    /// Whatever [`unified_patch`] writes, [`split_patch`] and
    /// [`apply_file_patch`] turn back into exactly the proposed content.
    #[test]
    fn a_written_patch_reads_back_to_the_same_content() {
        let long: String = (1..=40).map(|i| format!("line {i}\n")).collect();
        let edited = long.replace("line 3\n", "LINE 3\n").replace("line 30\n", "").replace("line 39\n", "line 39\nextra\n");
        let cases = vec![
            case("a.txt", Some("one\ntwo\n"), Some("one\nTWO\n")),
            case("b/new.txt", None, Some("fresh\nfile")),
            case("gone.txt", Some("bye\n"), None),
            case("long.txt", Some(&long), Some(&edited)),
            case("nl.txt", Some("a\nb"), Some("a\nb\n")),
            case("nl2.txt", Some("a\nb\n"), Some("a\nc")),
            case("empty.txt", Some("x\n"), Some("")),
        ];
        let patch = unified_patch(&cases);
        let files = split_patch(&patch.patch).unwrap();
        assert_eq!(files.len(), cases.len());
        for c in &cases {
            let fp = files.iter().find(|f| f.path == c.path).unwrap();
            let base = c.base.as_deref().map(|b| std::str::from_utf8(b).unwrap());
            let got = apply_file_patch(base, fp).unwrap();
            let want = c.proposed.as_deref().map(|b| std::str::from_utf8(b).unwrap().to_string());
            assert_eq!(got, want, "{}", c.path);
        }
    }

    #[test]
    fn a_patch_that_does_not_fit_or_is_malformed_is_refused() {
        let patch = unified_patch(&[case("a.txt", Some("one\ntwo\n"), Some("one\nTWO\n"))]).patch;
        let fp = &split_patch(&patch).unwrap()[0];
        assert!(apply_file_patch(Some("one\nthree\n"), fp).is_err(), "a different base");
        assert!(apply_file_patch(None, fp).is_err(), "a missing base");
        for bad in [
            patch.replace("diff --git a/a.txt b/a.txt", "diff --git a/a.txt b/other.txt"),
            patch.replace("+TWO", "+TWO\n+more"),
            patch.replace("--- a/a.txt", "--- a/x.txt"),
            "rename from a\n".to_string(),
            format!("{patch}{patch}"),
        ] {
            assert!(split_patch(&bad).is_err(), "accepted: {bad:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(path: &str, base: Option<&str>, new: Option<&str>) -> FileInput {
        FileInput {
            path: path.into(),
            base: base.map(|s| s.as_bytes().to_vec()),
            proposed: new.map(|s| s.as_bytes().to_vec()),
        }
    }

    #[test]
    fn text_changes_become_one_git_style_patch() {
        let p = unified_patch(&[
            input("b.txt", Some("one\ntwo\n"), Some("one\nTWO\n")),
            input("a.txt", None, Some("new\n")),
            input("gone.txt", Some("bye\n"), None),
            input("same.txt", Some("x\n"), Some("x\n")),
        ]);
        assert!(p.whole.is_empty());
        let a = p.patch.find("diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt").unwrap();
        let b = p.patch.find("diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt").unwrap();
        assert!(a < b, "files are in path order");
        assert!(p.patch.contains("-two\n+TWO\n"));
        assert!(p.patch.contains("deleted file mode 100644\n--- a/gone.txt\n+++ /dev/null"));
        assert!(!p.patch.contains("same.txt"), "an unchanged file is not in the patch");
    }

    #[test]
    fn a_missing_final_newline_is_marked() {
        let p = unified_patch(&[input("n.txt", Some("a\n"), Some("a\nb"))]);
        assert!(p.patch.contains("\\ No newline at end of file"), "{}", p.patch);
    }

    #[test]
    fn a_file_that_is_not_text_ships_whole() {
        let p = unified_patch(&[FileInput {
            path: "img.png".into(),
            base: Some(vec![0x89, 0x50, 0x00]),
            proposed: Some(vec![0x89, 0x50, 0x01, 0x00]),
        }]);
        assert!(p.patch.is_empty());
        assert_eq!(p.whole, vec![WholeFile { path: "img.png".into(), content: Some(vec![0x89, 0x50, 0x01, 0x00]) }]);
    }
}
