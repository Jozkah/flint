//! A deterministic trimmer for the assembled system prompt (`[prompt] trim`).
//!
//! No model is involved: the output is a pure function of the input text, so
//! the same prompt always trims to the same bytes and a provider's prefix cache
//! keeps hitting. Three things happen, in this order:
//!
//! 1. whitespace is canonicalised (line endings, trailing blanks, runs of blank
//!    lines), so two prompts that differ only in incidental spacing trim to the
//!    same bytes;
//! 2. a paragraph that repeats an earlier one is dropped. The *first* copy
//!    always wins, so the leading bytes of the prompt -- the part a cache
//!    reuses -- never move when a later block happens to repeat them. Headings
//!    and fenced code are never deduplicated;
//! 3. a heading with no content anywhere under it (its subtree is only blank
//!    space and other empty headings) is dropped.
//!
//! The trimmer never reorders anything: the order of the blocks is the cache
//! line's business (`prompt.rs`), and reordering prose changes what it means.
//! Trimming is idempotent -- `trim(trim(x)) == trim(x)` -- which is what lets a
//! resumed run re-trim a stored prompt without churning the cache.

use std::collections::HashSet;

/// Paragraphs shorter than this (after whitespace is folded) are never treated
/// as duplicates: a one-word line repeating is formatting, not a repeated
/// instruction block.
const MIN_DEDUPE_CHARS: usize = 24;

#[derive(Debug, Clone)]
enum Kind {
    Heading(usize),
    Para,
    Fence,
}

#[derive(Debug, Clone)]
struct Unit {
    kind: Kind,
    lines: Vec<String>,
    /// Whether a blank line separated this unit from the one before it.
    blank_before: bool,
}

/// `#`..`######` followed by a space: an ATX heading's level.
fn heading_level(line: &str) -> Option<usize> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') && !line[hashes..].trim().is_empty() {
        Some(hashes)
    } else {
        None
    }
}

fn fence_marker(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if t.starts_with("```") {
        Some("```")
    } else if t.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

fn parse(text: &str) -> Vec<Unit> {
    let mut units: Vec<Unit> = Vec::new();
    let mut para: Vec<String> = Vec::new();
    let mut para_blank_before = false;
    let mut pending_blank = false;
    let mut fence: Option<(&'static str, Vec<String>, bool)> = None;

    fn flush(units: &mut Vec<Unit>, para: &mut Vec<String>, blank_before: bool) {
        if !para.is_empty() {
            units.push(Unit { kind: Kind::Para, lines: std::mem::take(para), blank_before });
        }
    }

    for raw in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        let line = raw.trim_end().to_string();
        if let Some((marker, lines, _)) = fence.as_mut() {
            lines.push(line.clone());
            let closes = fence_marker(&line) == Some(*marker);
            if closes {
                let (_, lines, blank_before) = fence.take().expect("checked above");
                units.push(Unit { kind: Kind::Fence, lines, blank_before });
            }
            continue;
        }
        if line.is_empty() {
            flush(&mut units, &mut para, para_blank_before);
            pending_blank = true;
            continue;
        }
        if let Some(marker) = fence_marker(&line) {
            flush(&mut units, &mut para, para_blank_before);
            fence = Some((if marker == "```" { "```" } else { "~~~" }, vec![line], pending_blank));
            pending_blank = false;
            continue;
        }
        if let Some(level) = heading_level(&line) {
            flush(&mut units, &mut para, para_blank_before);
            units.push(Unit { kind: Kind::Heading(level), lines: vec![line], blank_before: pending_blank });
            pending_blank = false;
            continue;
        }
        if para.is_empty() {
            para_blank_before = pending_blank;
            pending_blank = false;
        }
        para.push(line);
    }
    flush(&mut units, &mut para, para_blank_before);
    // An unterminated fence is still one atomic unit.
    if let Some((_, lines, blank_before)) = fence {
        units.push(Unit { kind: Kind::Fence, lines, blank_before });
    }
    units
}

/// A paragraph's identity for duplicate detection: its words, case kept (an
/// instruction's capitalisation can carry meaning), whitespace folded.
fn fingerprint(lines: &[String]) -> String {
    lines
        .iter()
        .flat_map(|l| l.split_whitespace())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Drop `index`, handing its spacing to the unit that follows it.
fn remove(units: &mut [Unit], keep: &mut [bool], index: usize) {
    keep[index] = false;
    let blank = units[index].blank_before;
    if let Some(next) = (index + 1..units.len()).find(|i| keep[*i]) {
        units[next].blank_before |= blank;
    }
}

/// Trim `prompt`. See the module docs for exactly what that means.
pub(crate) fn trim(prompt: &str) -> String {
    let mut units = parse(prompt);
    let mut keep = vec![true; units.len()];

    // 2. Repeated paragraphs, first copy wins.
    let mut seen: HashSet<String> = HashSet::new();
    for i in 0..units.len() {
        if !matches!(units[i].kind, Kind::Para) {
            continue;
        }
        let print = fingerprint(&units[i].lines);
        if print.chars().count() < MIN_DEDUPE_CHARS {
            continue;
        }
        if !seen.insert(print) {
            remove(&mut units, &mut keep, i);
        }
    }

    // 3. Headings with nothing under them. Content is any surviving paragraph
    //    or fence inside the heading's subtree (up to the next heading of the
    //    same or a shallower level).
    for i in 0..units.len() {
        let Kind::Heading(level) = units[i].kind else { continue };
        if !keep[i] {
            continue;
        }
        let mut has_content = false;
        for j in i + 1..units.len() {
            if !keep[j] {
                continue;
            }
            match units[j].kind {
                Kind::Heading(l) if l <= level => break,
                Kind::Heading(_) => {}
                _ => {
                    has_content = true;
                    break;
                }
            }
        }
        if !has_content {
            remove(&mut units, &mut keep, i);
        }
    }

    let mut out = String::with_capacity(prompt.len());
    let mut first = true;
    for (unit, kept) in units.iter().zip(&keep) {
        if !kept {
            continue;
        }
        if !first {
            out.push_str(if unit.blank_before { "\n\n" } else { "\n" });
        }
        first = false;
        out.push_str(&unit.lines.join("\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULE: &str = "Always ask before deleting anything outside the project folder.";

    #[test]
    fn a_repeated_instruction_block_keeps_only_its_first_copy() {
        let prompt = format!("# Rules\n\n{RULE}\n\n# More\n\nSomething else entirely, in its own words.\n\n{RULE}");
        let out = trim(&prompt);
        assert_eq!(out.matches(RULE).count(), 1);
        assert!(out.starts_with("# Rules\n\n"), "the first copy stays where it was: {out}");
        assert!(out.contains("Something else entirely"));
    }

    #[test]
    fn duplicates_are_found_through_spacing_differences() {
        let a = "Use   the project's\nformatter before every commit, always.";
        let b = "Use the project's formatter before every commit, always.";
        let out = trim(&format!("{a}\n\n{b}"));
        assert_eq!(out.matches("formatter").count(), 1);
    }

    #[test]
    fn short_lines_and_headings_are_never_deduplicated() {
        let out = trim("# Notes\n\nok\n\n# Notes\n\nok\n\nSecond notes body is long enough to count.");
        assert_eq!(out.matches("# Notes").count(), 2, "{out}");
        assert_eq!(out.matches("\nok").count(), 2, "{out}");
    }

    #[test]
    fn fenced_code_is_atomic_and_never_deduplicated() {
        let fence = "```\nrun the same thing twice here\n\nwith a blank line inside\n```";
        let out = trim(&format!("Intro paragraph that explains the example below.\n\n{fence}\n\n{fence}"));
        assert_eq!(out.matches("with a blank line inside").count(), 2, "{out}");
    }

    #[test]
    fn an_empty_section_is_dropped_and_a_populated_one_kept() {
        let out = trim("# Empty\n\n# Full\n\nthis section has a real body of text.\n\n## Child\n\n# Tail\n");
        assert!(!out.contains("# Empty"), "{out}");
        assert!(!out.contains("## Child"), "{out}");
        assert!(!out.contains("# Tail"), "{out}");
        assert!(out.contains("# Full") && out.contains("real body"));
    }

    #[test]
    fn a_parent_with_only_empty_children_is_dropped_too() {
        let out = trim("# Parent\n\n## A\n\n## B\n\n# Next\n\nbody text that is not empty at all.");
        assert_eq!(out, "# Next\n\nbody text that is not empty at all.");
    }

    #[test]
    fn a_parent_whose_child_has_content_stays() {
        let out = trim("# Parent\n\n## A\n\nchild body that is long enough to matter.");
        assert!(out.contains("# Parent") && out.contains("## A"));
    }

    #[test]
    fn a_heading_inside_a_fence_is_not_a_heading() {
        let out = trim("Some leading text that is a paragraph.\n\n```\n# not a heading\n```");
        assert!(out.contains("# not a heading"));
    }

    #[test]
    fn output_is_cache_stable_across_incidental_whitespace() {
        let a = "# A\r\n\r\n\r\n\r\nbody one is a decently long line.   \r\n\r\n# B\r\n\r\nbody two is another long line.\r\n";
        let b = "# A\n\nbody one is a decently long line.\n\n# B\n\nbody two is another long line.";
        assert_eq!(trim(a), trim(b));
    }

    #[test]
    fn trimming_is_idempotent() {
        let samples = [
            format!("# Rules\n\n{RULE}\n\n# Empty\n\n## Nested\n\n{RULE}\n\ntext after\n\n\n\n```\ncode\n```"),
            "just one line".to_string(),
            "# H\ntight body line that is long enough here\n# H2\n".to_string(),
            String::new(),
            "\n\n  \n".to_string(),
        ];
        for s in samples {
            let once = trim(&s);
            assert_eq!(trim(&once), once, "not idempotent for {s:?}");
        }
    }

    #[test]
    fn the_same_input_always_gives_the_same_bytes() {
        let prompt = format!("# One\n\n{RULE}\n\n{RULE}\n\n# Two\n");
        let first = trim(&prompt);
        for _ in 0..5 {
            assert_eq!(trim(&prompt), first);
        }
    }

    #[test]
    fn a_prompt_with_nothing_to_trim_is_unchanged_apart_from_whitespace() {
        let prompt = "# Guidelines\n\nBe careful with destructive actions.\n\n# Environment\n\nWindows, PowerShell.";
        assert_eq!(trim(prompt), prompt);
    }

    #[test]
    fn tight_heading_and_body_stay_tight() {
        let prompt = "# H\nbody directly under the heading, long enough.";
        assert_eq!(trim(prompt), prompt);
    }

    #[test]
    fn a_tail_that_repeats_the_head_does_not_move_the_head() {
        let head = format!("# Rules\n\n{RULE}");
        let with_repeat = format!("{head}\n\n# Env\n\nWindows.\n\n{RULE}");
        let without = format!("{head}\n\n# Env\n\nWindows.");
        assert_eq!(trim(&with_repeat), trim(&without));
    }
}
