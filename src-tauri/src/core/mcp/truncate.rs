//! Size cap for MCP tool results.
//!
//! A tool result is injected verbatim into conversation history, so one call to
//! a tool that dumps a whole page (Flint Browser MCP's snapshot, for instance) can
//! exhaust the model's context on its own, regardless of how large that context
//! is. Everything that hands an MCP result to a model funnels through here first
//! so the payload is bounded and the clipping is announced rather than silent.

use rmcp::model::{CallToolResult, ContentBlock};
use std::path::Path;
use std::io::Write as _;
use std::time::{Duration, SystemTime};

/// Most characters of an MCP tool description (or server instructions) sent to
/// the model. A server controls this text and it rides on every request, so an
/// unbounded one is a standing tax on the context of every turn.
pub const MCP_DESCRIPTION_MAX_CHARS: usize = 4096;

/// Cap `text` at `max_chars` characters (not bytes, so a cut never lands inside
/// a multi-byte character), appending `[truncated N chars]` where N is how much
/// was dropped. Text within the cap is returned unchanged.
pub fn cap_description(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let kept: String = text.chars().take(max_chars).collect();
    format!("{kept}
[truncated {} chars]", total - max_chars)
}

/// Total text characters carried by a result, across every text block.
fn total_text_chars(result: &CallToolResult) -> usize {
    result
        .content
        .iter()
        .filter_map(|c| c.as_text())
        .map(|t| t.text.chars().count())
        .sum()
}

fn truncation_marker(retained: usize, total: usize) -> String {
    format!(
        "[Tool output truncated: {retained} of {total} characters retained. \
Increase \"Max tool output characters\" in Settings > MCP Servers to retain more.]"
    )
}

/// Cap the combined text of `result` at `max_chars`, appending a marker block
/// that reports how much was kept.
///
/// The budget spans all text blocks rather than each block individually, since
/// the model receives their concatenation. Blocks are filled in order: earlier
/// ones survive intact, the block that crosses the budget is cut mid-way, and
/// later ones are dropped. Non-text blocks (images, resources, audio) are never
/// counted or altered - they aren't the payload that blows up, and clipping
/// their base64 would corrupt them.
///
/// `max_chars == 0` disables the cap, which is how a user opts out.
pub fn truncate_tool_result(result: &CallToolResult, max_chars: u64) -> CallToolResult {
    if max_chars == 0 {
        return result.clone();
    }
    let max_chars = max_chars as usize;

    let total = total_text_chars(result);
    if total <= max_chars {
        return result.clone();
    }

    let mut used = 0usize;
    let mut new_content: Vec<ContentBlock> = Vec::with_capacity(result.content.len() + 1);

    for block in &result.content {
        let Some(text) = block.as_text() else {
            // Non-text block: pass through untouched.
            new_content.push(block.clone());
            continue;
        };

        if used >= max_chars {
            continue; // Budget spent; this block and the rest are dropped.
        }

        let len = text.text.chars().count();
        let keep = len.min(max_chars - used);
        used += keep;

        if keep == len {
            new_content.push(block.clone());
        } else {
            new_content.push(ContentBlock::text(
                text.text.chars().take(keep).collect::<String>(),
            ));
        }
    }

    new_content.push(ContentBlock::text(truncation_marker(used, total)));

    let mut truncated = result.clone();
    truncated.content = new_content;
    truncated
}

/// [`truncate_tool_result`], except that when the result is over the cap and
/// `spill_dir` is given, the full text is first written to a file there and the
/// marker points at it, so the model can page through the rest with `read`
/// instead of calling the tool again. Any failure to write falls back to the
/// plain truncation: a result is never lost to a full disk.
pub fn truncate_or_spill(
    result: &CallToolResult,
    max_chars: u64,
    spill_dir: Option<&Path>,
    label: &str,
) -> CallToolResult {
    let mut capped = truncate_tool_result(result, max_chars);
    let (Some(dir), true) = (spill_dir, max_chars > 0) else {
        return capped;
    };
    let total = total_text_chars(result);
    if total <= max_chars as usize {
        return capped;
    }
    let Some(path) = write_spill(dir, label, result) else {
        return capped;
    };
    // `truncate_tool_result` ended with its own marker; swap in the pointer.
    capped.content.pop();
    let kept = total_text_chars(&capped);
    capped.content.push(ContentBlock::text(format!(
        "[Tool output truncated: {kept} of {total} characters shown. The full output is saved to {}. Read it with the `read` tool (use offset and limit) rather than calling the tool again.]",
        path.display()
    )));
    capped
}

fn write_spill(dir: &Path, label: &str, result: &CallToolResult) -> Option<std::path::PathBuf> {
    static PRUNED: std::sync::Once = std::sync::Once::new();
    let safe: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(48)
        .collect();
    let text = result
        .content
        .iter()
        .filter_map(|c| c.as_text())
        .map(|t| t.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::create_dir_all(dir).ok()?;
    // Old spill files are pruned once per process, on the first spill.
    PRUNED.call_once(|| {
        prune_spills(dir, SystemTime::now(), SPILL_MAX_AGE, SPILL_MAX_TOTAL_BYTES);
    });
    let ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // `create_new` never reuses a name, so a restarted counter cannot clobber
    // an earlier spill the model may still be reading.
    for _ in 0..8 {
        let rand = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let path = dir.join(format!("{safe}-{ms}-{rand}.txt"));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(text.as_bytes()).ok()?;
                return Some(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

const SPILL_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const SPILL_MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
/// Entries looked at per prune, so a huge directory cannot stall the first spill.
const SPILL_SCAN_LIMIT: usize = 5000;

/// `<label>-<unix ms>-<8 hex>.txt`, the only names `write_spill` produces.
fn is_spill_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".txt") else {
        return false;
    };
    let mut parts = stem.rsplitn(3, '-');
    let (Some(rand), Some(ms), Some(label)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    rand.len() == 8
        && rand.bytes().all(|b| b.is_ascii_hexdigit())
        && !ms.is_empty()
        && ms.bytes().all(|b| b.is_ascii_digit())
        && !label.is_empty()
}

/// Delete spill files older than `max_age`, then the oldest ones until the rest
/// fit in `max_total`. Touches only files matching the spill name pattern.
fn prune_spills(dir: &Path, now: SystemTime, max_age: Duration, max_total: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut kept: Vec<(SystemTime, u64, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten().take(SPILL_SCAN_LIMIT) {
        let path = entry.path();
        if !is_spill_name(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(now);
        if now.duration_since(modified).is_ok_and(|age| age > max_age) {
            let _ = std::fs::remove_file(&path);
        } else {
            kept.push((modified, meta.len(), path));
        }
    }
    let mut total: u64 = kept.iter().map(|(_, len, _)| len).sum();
    kept.sort_by_key(|(modified, _, _)| *modified);
    for (_, len, path) in kept {
        if total <= max_total {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_oversized_result_spills_to_a_file_and_points_at_it() {
        let dir = tempfile::tempdir().unwrap();
        let big = CallToolResult::success(vec![ContentBlock::text("x".repeat(500))]);
        let out = truncate_or_spill(&big, 100, Some(dir.path()), "srv/tool name");
        let blocks: Vec<String> = out.content.iter().filter_map(|c| c.as_text()).map(|t| t.text.clone()).collect();
        assert_eq!(blocks[0].len(), 100, "head kept");
        let marker = blocks.last().unwrap();
        assert!(marker.contains("100 of 500") && marker.contains("`read`"), "{marker}");
        let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(files.len(), 1);
        let path = files[0].as_ref().unwrap().path();
        assert!(marker.contains(&path.display().to_string()));
        assert_eq!(std::fs::read_to_string(&path).unwrap().len(), 500, "full text saved");
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("srv_tool_name-"));
    }

    #[test]
    fn a_small_result_or_no_spill_dir_is_unchanged_behaviour() {
        let dir = tempfile::tempdir().unwrap();
        let small = CallToolResult::success(vec![ContentBlock::text("hi")]);
        assert_eq!(truncate_or_spill(&small, 100, Some(dir.path()), "t"), small);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        let big = CallToolResult::success(vec![ContentBlock::text("x".repeat(500))]);
        assert_eq!(truncate_or_spill(&big, 100, None, "t"), truncate_tool_result(&big, 100));
    }

    #[test]
    fn spill_names_unique_across_counter_reset() {
        let dir = tempfile::tempdir().unwrap();
        let big = CallToolResult::success(vec![ContentBlock::text("x".repeat(50))]);
        let paths: std::collections::HashSet<_> =
            (0..30).map(|_| write_spill(dir.path(), "srv/tool", &big).unwrap()).collect();
        assert_eq!(paths.len(), 30);
        for p in &paths {
            assert!(is_spill_name(&p.file_name().unwrap().to_string_lossy()));
        }
    }

    #[test]
    fn spill_prune_removes_old_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("srv-1-0123abcd.txt");
        let fresh = dir.path().join("srv-2-0123abcd.txt");
        let foreign = dir.path().join("notes.txt");
        for p in [&old, &fresh, &foreign] {
            std::fs::write(p, "x").unwrap();
        }
        let now = SystemTime::now();
        let long_ago = now - Duration::from_secs(30 * 24 * 60 * 60);
        for p in [&old, &foreign] {
            std::fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(long_ago).unwrap();
        }
        prune_spills(dir.path(), now, SPILL_MAX_AGE, SPILL_MAX_TOTAL_BYTES);
        assert!(!old.exists(), "old spill removed");
        assert!(fresh.exists(), "fresh spill kept");
        assert!(foreign.exists(), "non-spill file untouched");
        // Over the size budget, the oldest spill goes first.
        let newer = dir.path().join("srv-3-0123abcd.txt");
        std::fs::write(&newer, "yy").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&fresh)
            .unwrap()
            .set_modified(now - Duration::from_secs(60))
            .unwrap();
        prune_spills(dir.path(), now, SPILL_MAX_AGE, 2);
        assert!(!fresh.exists());
        assert!(newer.exists());
    }

    #[test]
    fn an_unwritable_spill_dir_falls_back_to_plain_truncation() {
        let file = tempfile::NamedTempFile::new().unwrap();
        // A file where the directory should be: create_dir_all fails.
        let big = CallToolResult::success(vec![ContentBlock::text("x".repeat(500))]);
        let out = truncate_or_spill(&big, 100, Some(&file.path().join("sub")), "t");
        assert_eq!(out, truncate_tool_result(&big, 100));
    }

    fn text_result(parts: &[&str]) -> CallToolResult {
        CallToolResult::success(parts.iter().map(|p| ContentBlock::text(*p)).collect())
    }

    fn texts(result: &CallToolResult) -> Vec<String> {
        result
            .content
            .iter()
            .filter_map(|c| c.as_text())
            .map(|t| t.text.clone())
            .collect()
    }

    /// The web layer reads `content[].text` off the serialized result and feeds
    /// it straight into conversation history, so the cap has to hold on the wire,
    /// not just in the struct.
    #[test]
    fn serialized_result_the_web_layer_receives_is_bounded() {
        // Stand-in for a Flint Browser MCP page snapshot: one enormous text block.
        let snapshot =
            CallToolResult::success(vec![ContentBlock::text("<div>page</div>".repeat(100_000))]);

        let capped = truncate_tool_result(&snapshot, 40_000);
        let wire = serde_json::to_value(&capped).expect("serializes");

        let blocks = wire["content"].as_array().expect("content array");
        let wire_chars: usize = blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .map(|t| t.chars().count())
            .sum();

        assert!(
            wire_chars < 41_000,
            "1.5M-char snapshot reached the model as {wire_chars} chars"
        );
        assert!(blocks
            .last()
            .and_then(|b| b["text"].as_str())
            .is_some_and(|t| t.contains("truncated")));
    }

    #[test]
    fn small_output_passes_through_untouched() {
        let result = text_result(&["hello world"]);
        let capped = truncate_tool_result(&result, 100);

        assert_eq!(texts(&capped), vec!["hello world".to_string()]);
        assert_eq!(capped.content.len(), 1, "no marker on untruncated output");
    }

    #[test]
    fn output_exactly_at_cap_is_not_truncated() {
        let result = text_result(&["0123456789"]);
        let capped = truncate_tool_result(&result, 10);

        assert_eq!(texts(&capped), vec!["0123456789".to_string()]);
        assert_eq!(capped.content.len(), 1);
    }

    #[test]
    fn oversized_output_is_capped_to_max_chars() {
        let result = text_result(&["x".repeat(5_000).as_str()]);
        let capped = truncate_tool_result(&result, 100);

        let retained: usize = capped
            .content
            .iter()
            .take(capped.content.len() - 1)
            .filter_map(|c| c.as_text())
            .map(|t| t.text.chars().count())
            .sum();
        assert_eq!(retained, 100);
    }

    #[test]
    fn truncation_marker_reports_retained_and_total() {
        let result = text_result(&["y".repeat(5_000).as_str()]);
        let capped = truncate_tool_result(&result, 100);

        let marker = texts(&capped).pop().expect("marker block");
        assert!(marker.contains("truncated"), "marker text: {marker}");
        assert!(marker.contains("100 of 5000"), "marker text: {marker}");
        assert!(
            marker.contains("Max tool output characters"),
            "marker points the user at the setting: {marker}"
        );
    }

    #[test]
    fn multi_block_budget_spans_all_text_blocks() {
        let result = text_result(&["aaaa", "bbbb", "cccc"]);
        let capped = truncate_tool_result(&result, 6);

        let blocks = texts(&capped);
        // First block intact, second cut mid-way, third dropped, marker appended.
        assert_eq!(blocks[0], "aaaa");
        assert_eq!(blocks[1], "bb");
        assert_eq!(
            blocks.len(),
            3,
            "third block dropped, marker added: {blocks:?}"
        );
        assert!(blocks[2].contains("6 of 12"), "marker text: {}", blocks[2]);
    }

    #[test]
    fn non_text_blocks_survive_truncation() {
        let result = CallToolResult::success(vec![
            ContentBlock::text("z".repeat(1_000)),
            ContentBlock::image("ZmFrZQ==".to_string(), "image/png".to_string()),
        ]);
        let capped = truncate_tool_result(&result, 10);

        assert!(
            capped.content.iter().any(|c| c.as_image().is_some()),
            "image block must not be dropped by the text cap"
        );
        assert_eq!(texts(&capped)[0].chars().count(), 10);
    }

    #[test]
    fn zero_max_chars_disables_the_cap() {
        let result = text_result(&["w".repeat(10_000).as_str()]);
        let capped = truncate_tool_result(&result, 0);

        assert_eq!(texts(&capped)[0].chars().count(), 10_000);
        assert_eq!(capped.content.len(), 1);
    }

    #[test]
    fn error_flag_and_structured_content_are_preserved() {
        let mut result = text_result(&["e".repeat(500).as_str()]);
        result.is_error = Some(true);
        result.structured_content = Some(serde_json::json!({ "code": 42 }));

        let capped = truncate_tool_result(&result, 10);

        assert_eq!(capped.is_error, Some(true));
        assert_eq!(
            capped.structured_content,
            Some(serde_json::json!({ "code": 42 }))
        );
    }

    #[test]
    fn descriptions_are_capped_with_a_marker_on_char_boundaries() {
        assert_eq!(cap_description("short", MCP_DESCRIPTION_MAX_CHARS), "short");
        let exact = "x".repeat(MCP_DESCRIPTION_MAX_CHARS);
        assert_eq!(cap_description(&exact, MCP_DESCRIPTION_MAX_CHARS), exact);
        let long = "あ".repeat(MCP_DESCRIPTION_MAX_CHARS + 10);
        let capped = cap_description(&long, MCP_DESCRIPTION_MAX_CHARS);
        assert!(capped.ends_with("[truncated 10 chars]"), "{capped}");
        assert!(capped.starts_with(&"あ".repeat(MCP_DESCRIPTION_MAX_CHARS)));
    }

    #[test]
    fn multibyte_text_is_cut_on_char_boundaries() {
        let result = text_result(&["日本語テキスト".repeat(100).as_str()]);
        let capped = truncate_tool_result(&result, 5);

        assert_eq!(texts(&capped)[0], "日本語テキ");
    }
}
