//! `flint cli threads export`: a conversation as Markdown, Obsidian Markdown or
//! JSON, the way the desktop's export does it (`web-app/src/lib/exportMarkdown.ts`).
//!
//! The default view reads like a conversation: one line per tool call, no
//! reasoning, and absolute paths from this machine cut down to the file name.
//! `verbose` adds tool input and output and the reasoning, and keeps paths.
//! PDF and PNG are layout output and stay in the app.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Markdown,
    Obsidian,
    Json,
}

impl Format {
    pub fn parse(s: &str) -> Result<Format, String> {
        match s {
            "markdown" | "md" => Ok(Format::Markdown),
            "obsidian" => Ok(Format::Obsidian),
            "json" => Ok(Format::Json),
            other => Err(format!("unknown format '{other}' (markdown, obsidian, json)")),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Format::Markdown | Format::Obsidian => "md",
            Format::Json => "json",
        }
    }
}

struct Tool {
    name: String,
    input: Option<Value>,
    output: Option<Value>,
}

struct Turn {
    role: String,
    text: String,
    reasoning: String,
    images: usize,
    tools: Vec<Tool>,
    at: Option<i64>,
}

static WIN_ABS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(^|[^A-Za-z0-9])([A-Za-z]:[\\/](?:[^\s"'`<>|*?\\/]+[\\/])*[^\s"'`<>|*?\\/]*)"#)
        .expect("windows path")
});
static POSIX_ABS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:^|[\s("'`])(/(?:home|Users|root|var|tmp|opt|etc|mnt|private|srv|usr)/(?:[^\s"'`<>|*?/]+/)*[^\s"'`<>|*?/]*)"#)
        .expect("posix path")
});
static AT_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"@([A-Za-z0-9_./\\-]+[A-Za-z0-9_])(?::\d+(?:-\d+)?)?"#).expect("at reference")
});

fn base_name(path: &str) -> String {
    path.split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .last()
        .filter(|s| !(s.len() == 2 && s.ends_with(':')))
        .unwrap_or("[path]")
        .to_string()
}

/// Cut absolute paths from this machine down to their last segment.
pub fn strip_absolute_paths(text: &str) -> String {
    let once = WIN_ABS
        .replace_all(text, |c: &regex::Captures| format!("{}{}", &c[1], base_name(&c[2])))
        .to_string();
    POSIX_ABS
        .replace_all(&once, |c: &regex::Captures| {
            let whole = &c[0];
            let path = &c[1];
            format!("{}{}", &whole[..whole.len() - path.len()], base_name(path))
        })
        .to_string()
}

fn fenced(body: &str, lang: &str) -> String {
    let longest = body
        .split(|c| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    format!("{fence}{lang}\n{body}\n{fence}")
}

fn stringify(v: &Option<Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn stamp(at: Option<i64>) -> String {
    at.and_then(chrono::DateTime::from_timestamp_millis)
        .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// Stored timestamps are seconds in some paths and milliseconds in others.
fn to_millis(v: f64) -> i64 {
    if v < 1e11 {
        (v * 1000.0) as i64
    } else {
        v as i64
    }
}

fn turn_from(message: &Value) -> Option<Turn> {
    let role = message.get("role").and_then(Value::as_str)?;
    if !matches!(role, "user" | "assistant" | "system") {
        return None;
    }
    let mut texts = Vec::new();
    let mut reasoning = Vec::new();
    let mut tools = Vec::new();
    let mut images = 0;
    for part in message.get("content").and_then(Value::as_array).into_iter().flatten() {
        let value = part.pointer("/text/value").and_then(Value::as_str).filter(|s| !s.is_empty());
        match part.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => texts.extend(value.map(str::to_string)),
            "reasoning" => reasoning.extend(value.map(str::to_string)),
            "image_url" => images += 1,
            "tool_call" => tools.push(Tool {
                name: part.get("tool_name").and_then(Value::as_str).unwrap_or("tool").to_string(),
                input: part.get("input").cloned(),
                output: part.get("output").cloned(),
            }),
            _ => {}
        }
    }
    let at = message
        .get("created_at")
        .and_then(Value::as_f64)
        .filter(|v| *v > 0.0)
        .map(to_millis);
    Some(Turn {
        role: role.to_string(),
        text: texts.join("\n\n"),
        reasoning: reasoning.join("\n\n"),
        images,
        tools,
        at,
    })
}

fn label(role: &str) -> &'static str {
    match role {
        "user" => "User",
        "assistant" => "Assistant",
        _ => "System",
    }
}

fn render_turn(t: &Turn, verbose: bool, obsidian: bool) -> String {
    let when = stamp(t.at);
    let mut parts = vec![format!("## {}{}", label(&t.role), if when.is_empty() { String::new() } else { format!(" · {when}") })];
    if verbose && !t.reasoning.trim().is_empty() {
        parts.push(format!("<details>\n<summary>Reasoning</summary>\n\n{}\n\n</details>", t.reasoning.trim()));
    }
    let text = t.text.trim();
    if !text.is_empty() {
        let mut text = if verbose { text.to_string() } else { strip_absolute_paths(text) };
        if obsidian {
            text = AT_REF.replace_all(&text, "[[$1]]").to_string();
        }
        parts.push(text);
    }
    if t.images > 0 {
        parts.push(format!("_{} image{} attached_", t.images, if t.images == 1 { "" } else { "s" }));
    }
    if verbose {
        for tool in &t.tools {
            let mut block = vec![format!("**Tool: `{}`**", tool.name.replace('`', "'"))];
            let input = stringify(&tool.input);
            if !input.is_empty() {
                block.push(format!("Input:\n\n{}", fenced(&input, "json")));
            }
            let output = stringify(&tool.output);
            if !output.is_empty() {
                block.push(format!("Output:\n\n{}", fenced(&output, "")));
            }
            parts.push(block.join("\n\n"));
        }
    } else if !t.tools.is_empty() {
        let lines: Vec<String> = t
            .tools
            .iter()
            .map(|tool| strip_absolute_paths(&format!("- Used `{}`", tool.name.replace('`', "'"))))
            .collect();
        parts.push(lines.join("\n"));
    }
    if parts.len() == 1 {
        parts.push("_(no text)_".to_string());
    }
    parts.join("\n\n")
}

fn tag_segment(s: &str) -> String {
    let mapped: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    mapped.trim_matches('-').to_string()
}

/// A conversation as text, from a thread record and its messages.
pub fn render(thread: &Value, messages: &[Value], format: Format, verbose: bool, exported_at: &str) -> String {
    let title = thread.get("title").and_then(Value::as_str).map(one_line).unwrap_or_default();
    let title = if title.is_empty() { "Untitled".to_string() } else { title };
    let model = thread
        .pointer("/assistants/0/model/id")
        .or_else(|| thread.pointer("/model/id"))
        .and_then(Value::as_str)
        .map(one_line);
    if format == Format::Json {
        let doc = serde_json::json!({
            "title": title,
            "exportedAt": exported_at,
            "model": model,
            "messages": messages,
        });
        return format!("{}\n", serde_json::to_string_pretty(&doc).unwrap_or_default());
    }
    let turns: Vec<Turn> = messages.iter().filter_map(turn_from).collect();
    let obsidian = format == Format::Obsidian;
    let body = if turns.is_empty() {
        "_This conversation is empty._".to_string()
    } else {
        turns.iter().map(|t| render_turn(t, verbose, obsidian)).collect::<Vec<_>>().join("\n\n---\n\n")
    };
    if obsidian {
        let mut front = vec![
            "---".to_string(),
            format!("title: {}", serde_json::to_string(&title).unwrap_or_default()),
            format!("created: {}", serde_json::to_string(exported_at).unwrap_or_default()),
            "source: Flint".to_string(),
            "type: chat".to_string(),
        ];
        if let Some(m) = &model {
            front.push(format!("model: {}", serde_json::to_string(m).unwrap_or_default()));
        }
        front.push(format!("messages: {}", turns.len()));
        front.push("tags:".to_string());
        for tag in ["flint", "flint/chat"] {
            let clean: Vec<String> = tag.split('/').map(tag_segment).filter(|s| !s.is_empty()).collect();
            front.push(format!("  - {}", clean.join("/")));
        }
        front.push("---".to_string());
        return format!("{}\n\n# {title}\n\n{body}\n", front.join("\n"));
    }
    let mut line = vec!["Exported from Flint".to_string(), exported_at.chars().take(10).collect()];
    if let Some(m) = model {
        line.push(m);
    }
    format!("# {title}\n\n> {}\n\n{body}\n", line.join(" · "))
}

/// A file name that is legal on Windows, macOS and Linux.
pub fn file_name(title: &str, ext: &str) -> String {
    let mut stem: String = title
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) { '-' } else if c.is_control() { ' ' } else { c })
        .collect();
    stem = one_line(&stem);
    stem = stem.trim_matches(|c| c == '.' || c == ' ').chars().take(80).collect();
    stem = stem.trim_end_matches(|c| c == '.' || c == ' ').to_string();
    if stem.is_empty() {
        stem = "export".to_string();
    }
    let lower = stem.to_lowercase();
    let reserved = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || ((lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.len() == 4
            && lower.chars().last().is_some_and(|c| ('1'..='9').contains(&c)));
    if reserved {
        stem = format!("_{stem}");
    }
    format!("{stem}.{ext}")
}

/// `threads export <id> [--format F] [--verbose] [--all-versions] [--out PATH]`.
/// Without `--out` the text goes to stdout. A directory `--out` gets a file
/// named after the thread. Returns where it was written, if anywhere.
pub fn export_thread(
    data: &Path,
    thread_id: &str,
    format: Format,
    verbose: bool,
    all_versions: bool,
    out: Option<&Path>,
) -> Result<Option<std::path::PathBuf>, String> {
    let thread = super::cli_get_thread_in(data, thread_id)?;
    let messages = super::cli_list_messages_active_in(data, thread_id, all_versions && format == Format::Json)?;
    let now = chrono::Utc::now().to_rfc3339();
    let text = render(&thread, &messages, format, verbose, &now);
    match out {
        None => {
            print!("{text}");
            Ok(None)
        }
        Some(path) => {
            let target = if path.is_dir() {
                let title = thread.get("title").and_then(Value::as_str).unwrap_or("");
                path.join(file_name(title, format.extension()))
            } else {
                path.to_path_buf()
            };
            if text.len() > 50 * 1024 * 1024 {
                return Err("the export is over 50 MB, so it was not written".to_string());
            }
            std::fs::write(&target, text).map_err(|e| format!("write {}: {e}", target.display()))?;
            Ok(Some(target))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(role: &str, text: &str) -> Value {
        json!({ "role": role, "created_at": 1_700_000_000, "content": [{ "type": "text", "text": { "value": text } }] })
    }

    #[test]
    fn paths_are_cut_to_file_names_but_urls_are_left() {
        assert_eq!(strip_absolute_paths(r"see C:\Users\me\proj\main.rs now"), "see main.rs now");
        assert_eq!(strip_absolute_paths("open /home/me/proj/a.ts please"), "open a.ts please");
        assert_eq!(strip_absolute_paths("https://example.com/home/x"), "https://example.com/home/x");
    }

    #[test]
    fn markdown_default_and_verbose_differ_in_tools_and_reasoning() {
        let thread = json!({ "title": "A/B?", "assistants": [{ "model": { "id": "m1" } }] });
        let assistant = json!({
            "role": "assistant", "created_at": 1_700_000_001,
            "content": [
                { "type": "reasoning", "text": { "value": "thinking hard" } },
                { "type": "text", "text": { "value": "done in C:\\a\\b.txt" } },
                { "type": "tool_call", "tool_name": "read", "input": { "path": "x" }, "output": "ok" }
            ]
        });
        let msgs = vec![message("user", "hello @src/a.ts:3"), assistant];
        let plain = render(&thread, &msgs, Format::Markdown, false, "2026-10-09T00:00:00Z");
        assert!(plain.starts_with("# A/B?\n\n> Exported from Flint · 2026-10-09 · m1"));
        assert!(plain.contains("- Used `read`"));
        assert!(plain.contains("done in b.txt"));
        assert!(!plain.contains("thinking hard"));
        assert!(!plain.contains("Input:"));
        let verbose = render(&thread, &msgs, Format::Markdown, true, "2026-10-09T00:00:00Z");
        assert!(verbose.contains("thinking hard"));
        assert!(verbose.contains("Input:"));
        assert!(verbose.contains("C:\\a\\b.txt"));
    }

    #[test]
    fn obsidian_has_frontmatter_and_wikilinks_and_json_keeps_messages() {
        let thread = json!({ "title": "Notes" });
        let msgs = vec![message("user", "look at @src/a.ts:3")];
        let o = render(&thread, &msgs, Format::Obsidian, false, "2026-10-09T00:00:00Z");
        assert!(o.starts_with("---\ntitle: \"Notes\""));
        assert!(o.contains("  - flint/chat"));
        assert!(o.contains("[[src/a.ts]]"));
        let j: Value = serde_json::from_str(&render(&thread, &msgs, Format::Json, false, "x")).unwrap();
        assert_eq!(j["messages"].as_array().unwrap().len(), 1);
        let empty = render(&thread, &[], Format::Markdown, false, "2026-10-09T00:00:00Z");
        assert!(empty.contains("_This conversation is empty._"));
    }

    #[test]
    fn file_names_are_portable() {
        assert_eq!(file_name("a/b: c?", "md"), "a-b- c-.md");
        assert_eq!(file_name("", "md"), "export.md");
        assert_eq!(file_name("CON", "md"), "_CON.md");
        assert_eq!(file_name("  ..x.. ", "json"), "x.json");
    }

    #[test]
    fn export_writes_into_a_directory_and_refuses_unknown_formats() {
        crate::core::app::commands::with_temp_data_folder(|data| {
            let created = crate::core::cli::archive_cmd::create_thread(Some("My chat")).unwrap();
            let id = created["id"].as_str().unwrap();
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(crate::core::threads::storage::create_message_in(
                data,
                json!({ "thread_id": id, "role": "user", "content": [{ "type": "text", "text": { "value": "hi" } }] }),
            ))
            .unwrap();
            let out = data.join("out");
            std::fs::create_dir_all(&out).unwrap();
            let written = export_thread(data, id, Format::Markdown, false, false, Some(&out)).unwrap().unwrap();
            assert_eq!(written.file_name().unwrap(), "My chat.md");
            assert!(std::fs::read_to_string(written).unwrap().contains("## User"));
            assert!(Format::parse("pdf").is_err());
        });
    }
}
