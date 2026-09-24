//! Fallback matching for the `edit` tool when `old_string` is not an exact
//! substring of the file.
//!
//! Models routinely reproduce a file's text with small, meaning-free drift:
//! LF where the file has CRLF, typographic quotes or non-breaking spaces,
//! re-indented or trailing-whitespace-trimmed lines, or a character or two of
//! noise. Rejecting those edits outright costs a full round trip, so we try a
//! chain of progressively looser matchers and accept the first that yields a
//! single unambiguous location:
//!
//! 1. line-ending normalisation (CRLF <-> LF),
//! 2. smart-quote / dash / non-breaking-space normalisation,
//! 3. whole-line match ignoring indentation and trailing whitespace,
//! 4. Levenshtein similarity over line windows (>= [`SIMILARITY_THRESHOLD`]).
//!
//! Every fallback writes the replacement using the file's own line ending, and
//! the line-based fallbacks re-indent `new_string` to the file's indentation.

use std::ops::Range;

/// Minimum normalised similarity for the Levenshtein fallback.
pub const SIMILARITY_THRESHOLD: f64 = 0.9;

/// Below this a "closest match" is noise and is not shown.
const MIN_REPORTED_SIMILARITY: f64 = 0.5;

/// Windows larger than this (in chars, either side) skip the Levenshtein pass:
/// it is quadratic, and a near-match of that size is better re-read than guessed.
const MAX_FUZZY_CHARS: usize = 8_000;

/// A resolved edit location: the byte range of `content` to replace and the
/// text to put there.
#[derive(Debug, PartialEq, Eq)]
pub struct Resolved {
    pub range: Range<usize>,
    pub replacement: String,
}

/// Why no location could be resolved. `Display` is the model-facing detail.
#[derive(Debug, PartialEq)]
pub enum MatchError {
    /// Nothing close enough. Carries the closest window, if any was scored.
    NotFound { closest: Option<(usize, String, f64)> },
    /// Several equally plausible locations (1-based line numbers).
    Ambiguous { lines: Vec<usize> },
}

impl std::fmt::Display for MatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MatchError::NotFound { closest: None } => write!(f, "old_string not found"),
            MatchError::NotFound { closest: Some((line, snippet, sim)) } => write!(
                f,
                "old_string not found; closest match at line {line} ({:.0}% similar):\n{snippet}",
                sim * 100.0
            ),
            MatchError::Ambiguous { lines } => {
                let list: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
                write!(
                    f,
                    "old_string matches approximately at several places (lines {}); \
                     include more surrounding context to make it unique",
                    list.join(", ")
                )
            }
        }
    }
}

/// The file's dominant line ending.
fn line_ending(content: &str) -> &'static str {
    let crlf = content.matches("\r\n").count();
    let lf = content.matches('\n').count() - crlf;
    if crlf > lf {
        "\r\n"
    } else {
        "\n"
    }
}

/// `s` with its line endings converted to `content`'s dominant one.
pub fn in_file_ending(content: &str, s: &str) -> String {
    to_ending(s, line_ending(content))
}

fn to_ending(s: &str, eol: &str) -> String {
    let lf = s.replace("\r\n", "\n");
    if eol == "\n" {
        lf
    } else {
        lf.replace('\n', eol)
    }
}

/// One-to-one character normalisation: typographic punctuation to ASCII,
/// exotic spaces to a plain space. One char in, one char out, so positions in
/// the normalised text map straight back to the original.
fn norm_char(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{2033}' => '"',
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
        '\u{00A0}' | '\u{2007}' | '\u{202F}' | '\u{2009}' | '\u{200A}' | '\u{3000}' => ' ',
        _ => c,
    }
}

fn norm_str(s: &str) -> String {
    s.chars().map(norm_char).collect()
}

/// Every start byte offset of `needle` in `hay` (non-overlapping).
fn find_all(hay: &str, needle: &str) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    hay.match_indices(needle).map(|(i, _)| i).collect()
}

fn line_of(content: &str, byte: usize) -> usize {
    content[..byte].matches('\n').count() + 1
}

/// Lines of `content` as byte ranges excluding the terminator.
fn line_spans(content: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in content.bytes().enumerate() {
        if b == b'\n' {
            let end = if i > start && content.as_bytes()[i - 1] == b'\r' { i - 1 } else { i };
            out.push(start..end);
            start = i + 1;
        }
    }
    if start < content.len() {
        out.push(start..content.len());
    }
    out
}

fn split_lines(s: &str) -> Vec<&str> {
    let s = s.strip_suffix('\n').unwrap_or(s);
    let s = s.strip_suffix('\r').unwrap_or(s);
    s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

fn leading_ws(s: &str) -> &str {
    &s[..s.len() - s.trim_start().len()]
}

/// Smallest indentation among non-blank lines.
fn min_indent<'a>(lines: &[&'a str]) -> &'a str {
    lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| leading_ws(l))
        .min_by_key(|w| w.len())
        .unwrap_or("")
}

/// Re-indent `new_string` from the indentation `old_string` used to the one
/// the matched file lines use, joined with the file's line ending.
fn reindent(new_string: &str, old_lines: &[&str], file_lines: &[&str], eol: &str) -> String {
    let old_base = min_indent(old_lines);
    let file_base = min_indent(file_lines);
    let had_trailing_nl = new_string.ends_with('\n');
    let mut out: Vec<String> = Vec::new();
    for l in split_lines(new_string) {
        if l.trim().is_empty() {
            out.push(String::new());
        } else if let Some(rest) = l.strip_prefix(old_base) {
            out.push(format!("{file_base}{rest}"));
        } else {
            out.push(format!("{file_base}{}", l.trim_start()));
        }
    }
    let mut s = out.join(eol);
    if had_trailing_nl && !new_string.is_empty() {
        s.push_str(eol);
    }
    s
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

fn similarity(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let max = a.len().max(b.len());
    if max == 0 {
        return 1.0;
    }
    1.0 - levenshtein(&a, &b) as f64 / max as f64
}

/// Canonical form of a block of lines for the whitespace-insensitive passes.
fn canon(lines: &[&str]) -> String {
    lines
        .iter()
        .map(|l| norm_str(l.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Resolve where a single (non-`replace_all`) edit applies, trying the
/// fallback chain after exact matching: either a location or the reason
/// there is none.
pub fn resolve(content: &str, old: &str, new: &str) -> Result<Resolved, MatchError> {
    let eol = line_ending(content);

    // 0/1. Exact, then with old/new converted to the file's line ending.
    for (o, n) in [
        (old.to_string(), new.to_string()),
        (to_ending(old, eol), to_ending(new, eol)),
    ] {
        let hits = find_all(content, &o);
        match hits.len() {
            0 => continue,
            1 => {
                return Ok(Resolved { range: hits[0]..hits[0] + o.len(), replacement: n });
            }
            _ => {
                return Err(MatchError::Ambiguous {
                    lines: hits.iter().map(|&h| line_of(content, h)).collect(),
                })
            }
        }
    }

    // 2. Character normalisation (1:1 chars, so map via char byte offsets).
    let old_eol = to_ending(old, eol);
    let norm_old = norm_str(&old_eol);
    let offsets: Vec<usize> = content
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(content.len()))
        .collect();
    let norm_content = norm_str(content);
    let norm_offsets: Vec<usize> = norm_content
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(norm_content.len()))
        .collect();
    let hits = find_all(&norm_content, &norm_old);
    if !hits.is_empty() {
        if hits.len() > 1 {
            return Err(MatchError::Ambiguous {
                lines: hits.iter().map(|&h| line_of(&norm_content, h)).collect(),
            });
        }
        let start_char = norm_offsets.binary_search(&hits[0]).unwrap_or(0);
        let end_char = norm_offsets
            .binary_search(&(hits[0] + norm_old.len()))
            .unwrap_or(norm_offsets.len() - 1);
        return Ok(Resolved {
            range: offsets[start_char]..offsets[end_char],
            replacement: to_ending(new, eol),
        });
    }

    // 3/4. Line-window passes.
    let old_lines = split_lines(old);
    if old.trim().is_empty() {
        return Err(MatchError::NotFound { closest: None });
    }
    let spans = line_spans(content);
    let file_lines: Vec<&str> = spans.iter().map(|r| &content[r.clone()]).collect();
    let n = old_lines.len();
    if n > file_lines.len() {
        return Err(MatchError::NotFound { closest: None });
    }
    let want = canon(&old_lines);
    let resolved_at = |start: usize| -> Resolved {
        let range = spans[start].start..spans[start + n - 1].end;
        let replacement = reindent(new, &old_lines, &file_lines[start..start + n], eol);
        // `old` usually excludes the final newline; keep the file's own.
        let replacement = replacement
            .strip_suffix(eol)
            .map(str::to_string)
            .unwrap_or(replacement);
        Resolved { range, replacement }
    };

    let windows: Vec<String> = (0..=file_lines.len() - n)
        .map(|s| canon(&file_lines[s..s + n]))
        .collect();

    let exact: Vec<usize> = (0..windows.len()).filter(|&s| windows[s] == want).collect();
    match exact.len() {
        1 => return Ok(resolved_at(exact[0])),
        0 => {}
        _ => return Err(MatchError::Ambiguous { lines: exact.iter().map(|s| s + 1).collect() }),
    }

    let want_len = want.chars().count();
    let mut scored: Vec<(usize, f64)> = Vec::new();
    for (s, w) in windows.iter().enumerate() {
        let wl = w.chars().count();
        if wl > MAX_FUZZY_CHARS || want_len > MAX_FUZZY_CHARS {
            continue;
        }
        // Length gap alone bounds similarity; skip windows that cannot pass
        // unless we still need a "closest" candidate.
        let bound = 1.0 - (wl.abs_diff(want_len)) as f64 / wl.max(want_len).max(1) as f64;
        if bound < SIMILARITY_THRESHOLD && !scored.is_empty() && bound < best_of(&scored) {
            continue;
        }
        scored.push((s, similarity(w, &want)));
    }
    let passing: Vec<&(usize, f64)> =
        scored.iter().filter(|(_, sim)| *sim >= SIMILARITY_THRESHOLD).collect();
    match passing.len() {
        1 => Ok(resolved_at(passing[0].0)),
        0 => {
            let closest = scored
                .iter()
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .filter(|&&(_, sim)| sim >= MIN_REPORTED_SIMILARITY)
                .map(|&(s, sim)| (s + 1, file_lines[s..s + n].join("\n"), sim));
            Err(MatchError::NotFound { closest })
        }
        _ => {
            // A single strictly-best candidate still wins; ties are ambiguous.
            let best = passing.iter().map(|p| p.1).fold(f64::MIN, f64::max);
            let top: Vec<usize> = passing
                .iter()
                .filter(|p| (p.1 - best).abs() < 1e-9)
                .map(|p| p.0)
                .collect();
            if top.len() == 1 && overlapping_only(&passing, top[0], n) {
                Ok(resolved_at(top[0]))
            } else {
                Err(MatchError::Ambiguous { lines: passing.iter().map(|p| p.0 + 1).collect() })
            }
        }
    }
}

fn best_of(scored: &[(usize, f64)]) -> f64 {
    scored.iter().map(|s| s.1).fold(f64::MIN, f64::max)
}

/// True when every passing candidate overlaps the best one -- i.e. they are
/// the same location seen through shifted windows, not distinct sites.
fn overlapping_only(passing: &[&(usize, f64)], best: usize, n: usize) -> bool {
    passing.iter().all(|p| p.0.abs_diff(best) < n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(content: &str, old: &str, new: &str) -> Result<String, MatchError> {
        let r = resolve(content, old, new)?;
        let mut s = content.to_string();
        s.replace_range(r.range, &r.replacement);
        Ok(s)
    }

    #[test]
    fn exact_match_still_wins() {
        assert_eq!(apply("a b c", "b", "x").unwrap(), "a x c");
    }

    #[test]
    fn crlf_file_with_lf_old_string_preserves_crlf() {
        let content = "fn a() {\r\n    one();\r\n}\r\n";
        let out = apply(content, "fn a() {\n    one();\n}", "fn a() {\n    two();\n}").unwrap();
        assert_eq!(out, "fn a() {\r\n    two();\r\n}\r\n");
    }

    #[test]
    fn smart_quotes_and_nbsp_normalised() {
        let content = "say(\"hi\");\u{00A0}// done\n";
        let out = apply(content, "say(\u{201C}hi\u{201D}); // done", "say(\"bye\");").unwrap();
        assert_eq!(out, "say(\"bye\");\n");
    }

    #[test]
    fn indent_and_trailing_ws_insensitive_reindents_new() {
        let content = "impl X {\n        fn f() {\n            a();   \n        }\n}\n";
        let old = "fn f() {\n    a();\n}";
        let new = "fn f() {\n    b();\n}";
        let out = apply(content, old, new).unwrap();
        assert_eq!(out, "impl X {\n        fn f() {\n            b();\n        }\n}\n");
    }

    #[test]
    fn levenshtein_accepts_small_typo() {
        let content = "let alpha = compute_value(first, second);\nlet beta = 2;\n";
        let out = apply(content, "let alpha = compute_valeu(first, second);", "let alpha = 1;").unwrap();
        assert_eq!(out, "let alpha = 1;\nlet beta = 2;\n");
    }

    #[test]
    fn levenshtein_ambiguity_lists_lines() {
        let content = "let result_value = compute(aaa);\nx\nlet result_value = compute(bbb);\n";
        let err = resolve(content, "let result_value = compute(ccc);", "y").unwrap_err();
        match err {
            MatchError::Ambiguous { lines } => assert_eq!(lines, vec![1, 3]),
            e => panic!("unexpected {e:?}"),
        }
    }

    #[test]
    fn not_found_reports_closest_with_percentage() {
        let content = "let foo = bar(1, 2, 3);\nother\n";
        let err = resolve(content, "let foo = baz(9, 8);", "x").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("closest match at line 1"), "{msg}");
        assert!(msg.contains('%'), "{msg}");
        assert!(msg.contains("let foo = bar(1, 2, 3);"), "{msg}");
    }

    #[test]
    fn exact_duplicates_are_ambiguous() {
        let err = resolve("a\na\n", "a", "b").unwrap_err();
        assert_eq!(err, MatchError::Ambiguous { lines: vec![1, 2] });
    }

    #[test]
    fn similarity_math() {
        assert!((similarity("abcd", "abcd") - 1.0).abs() < 1e-9);
        assert!((similarity("abcd", "abce") - 0.75).abs() < 1e-9);
    }
}
