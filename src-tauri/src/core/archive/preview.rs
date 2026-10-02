//! A bounded, read-only look inside an archived item, without restoring it.
//!
//! Everything here reads only inside `<data>/.archive/<kind>/<archive id>/`,
//! reached through `store::item_dir`, which validates the id the same way a
//! restore does. Nothing is written, moved or removed. Every read is capped
//! (bytes, messages, characters, list lengths) so a huge conversation or a
//! hostile file cannot make the dialog slow or large, and a symlinked file is
//! never followed.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::store::{self, Kind, PAYLOAD_FILE};

/// Messages shown for a thread or a room.
pub const MAX_MESSAGES: usize = 10;
/// Turns shown for a Cowork session (the end of the conversation).
pub const MAX_TURNS: usize = 4;
/// Characters of one message or field kept.
pub const MAX_TEXT_CHARS: usize = 400;
/// Characters of an assistant's instructions kept.
pub const MAX_INSTRUCTION_CHARS: usize = 2000;
/// Titles or names listed for a project or a room.
pub const MAX_LISTED: usize = 50;
/// Bytes read from a message file looking for its first messages.
const MAX_JSONL_BYTES: u64 = 512 * 1024;
/// A single JSON file (thread, room, recipe, payload) larger than this is not
/// parsed; the preview then holds the title only.
const MAX_JSON_BYTES: u64 = 32 * 1024 * 1024;
/// The largest picture inlined as a thumbnail; a bigger one is skipped.
pub const MAX_THUMBNAIL_BYTES: u64 = 200 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PreviewMessage {
    /// `user`, `assistant`, or a participant's name for a room.
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreviewField {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreview {
    pub kind: Kind,
    pub title: String,
    /// Milliseconds since the epoch, when the item records them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    /// A Cowork session's attached folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Room participants.
    pub participants: Vec<String>,
    pub messages: Vec<PreviewMessage>,
    /// How many messages or turns the item holds, when known; more than
    /// `messages.len()` means the list is cut.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_messages: Option<usize>,
    /// Titles of a project's threads.
    pub threads: Vec<String>,
    /// An assistant's instructions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Other short labelled values (a Studio recipe, a room's objective).
    pub fields: Vec<PreviewField>,
    /// A small picture as a `data:` URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

impl ArchivePreview {
    fn new(kind: Kind, title: &str) -> Self {
        Self {
            kind,
            title: title.to_string(),
            created_at: None,
            updated_at: None,
            folder: None,
            participants: Vec::new(),
            messages: Vec::new(),
            total_messages: None,
            threads: Vec::new(),
            instructions: None,
            fields: Vec::new(),
            thumbnail: None,
        }
    }

    fn field(&mut self, label: &str, value: impl Into<String>) {
        let value = clip(&value.into(), MAX_TEXT_CHARS);
        if !value.is_empty() {
            self.fields.push(PreviewField { label: label.to_string(), value });
        }
    }
}

/// Collapse whitespace and cut to `max` characters, with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max).collect();
    out.push('…');
    out
}

/// A file's bytes when it is a plain file (not a link) within `cap`.
fn read_capped(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    fs::read(path).ok()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&read_capped(path, MAX_JSON_BYTES)?).ok()
}

/// The first `limit` non-empty lines of a JSONL file, reading at most
/// `MAX_JSONL_BYTES`. A line the cap cuts off is dropped.
fn first_jsonl(path: &Path, limit: usize) -> Vec<Value> {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Vec::new();
    };
    if !meta.is_file() {
        return Vec::new();
    }
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let reader = BufReader::new(file.take(MAX_JSONL_BYTES));
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            out.push(v);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

/// Epoch seconds or milliseconds, as milliseconds.
fn to_ms(v: &Value) -> Option<u64> {
    let n = v.as_f64()?;
    if n <= 0.0 {
        return None;
    }
    Some(if n < 100_000_000_000.0 { (n * 1000.0) as u64 } else { n as u64 })
}

/// The text of a message `content`: a string, or an array of parts whose text
/// parts (`{type:"text", text:"..."}` or `text:{value:"..."}`) are joined.
/// Tool calls, tool results and images contribute nothing.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str).is_none_or(|t| t == "text"))
            .filter_map(|p| match p.get("text") {
                Some(Value::String(s)) => Some(s.as_str()),
                Some(Value::Object(o)) => o.get("value").and_then(Value::as_str),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn thread_preview(dir: &Path, title: &str) -> ArchivePreview {
    let mut p = ArchivePreview::new(Kind::Thread, title);
    if let Some(thread) = read_json(&dir.join("thread.json")) {
        if let Some(t) = str_of(&thread, "title").filter(|t| !t.is_empty()) {
            p.title = t.to_string();
        }
        p.created_at = thread.get("created").and_then(to_ms);
        p.updated_at = thread.get("updated").and_then(to_ms);
    }
    // Read a few more lines than shown so tool-only rows do not eat the budget.
    for line in first_jsonl(&dir.join("messages.jsonl"), MAX_MESSAGES * 4) {
        let role = str_of(&line, "role").unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = clip(&content_text(line.get("content").unwrap_or(&Value::Null)), MAX_TEXT_CHARS);
        if text.is_empty() {
            continue;
        }
        p.messages.push(PreviewMessage { role: role.to_string(), text });
        if p.messages.len() >= MAX_MESSAGES {
            break;
        }
    }
    p
}

fn room_preview(dir: &Path, title: &str) -> ArchivePreview {
    let mut p = ArchivePreview::new(Kind::Room, title);
    if let Some(room) = read_json(&dir.join("room.json")) {
        if let Some(t) = str_of(&room, "title").filter(|t| !t.is_empty()) {
            p.title = t.to_string();
        }
        p.created_at = room.get("createdAt").and_then(to_ms);
        p.updated_at = room.get("updatedAt").and_then(to_ms);
        if let Some(o) = str_of(&room, "objective") {
            p.field("objective", o);
        }
        if let Some(parts) = room.get("participants").and_then(Value::as_array) {
            p.participants = parts
                .iter()
                .filter(|x| x.get("removed").and_then(Value::as_bool) != Some(true))
                .filter_map(|x| str_of(x, "name"))
                .map(|n| clip(n, 80))
                .filter(|n| !n.is_empty())
                .take(MAX_LISTED)
                .collect();
        }
    }
    for line in first_jsonl(&dir.join("journal.jsonl"), MAX_MESSAGES * 4) {
        if str_of(&line, "type") != Some("message") {
            continue;
        }
        let Some(message) = line.get("message") else { continue };
        let text = clip(str_of(message, "text").unwrap_or(""), MAX_TEXT_CHARS);
        if text.is_empty() {
            continue;
        }
        let author = message.get("author");
        let role = match author.and_then(|a| str_of(a, "kind")) {
            Some("user") => "user".to_string(),
            Some("system") => "system".to_string(),
            _ => author.and_then(|a| str_of(a, "name")).unwrap_or("").to_string(),
        };
        p.messages.push(PreviewMessage { role: clip(&role, 80), text });
        if p.messages.len() >= MAX_MESSAGES {
            break;
        }
    }
    p
}

fn cowork_preview(dir: &Path, title: &str) -> ArchivePreview {
    let mut p = ArchivePreview::new(Kind::Cowork, title);
    let Some(payload) = read_json(&dir.join(PAYLOAD_FILE)) else {
        return p;
    };
    let session = payload.get("session").unwrap_or(&payload);
    if let Some(t) = str_of(session, "title").filter(|t| !t.is_empty()) {
        p.title = t.to_string();
    }
    p.folder = str_of(session, "folder").filter(|f| !f.is_empty()).map(|f| clip(f, 300));
    if let Some(turns) = session.get("turns").and_then(Value::as_array) {
        let talk: Vec<&Value> = turns
            .iter()
            .filter(|t| matches!(str_of(t, "role"), Some("user") | Some("assistant")))
            .filter(|t| t.get("hidden").and_then(Value::as_bool) != Some(true))
            .collect();
        p.total_messages = Some(talk.len());
        let start = talk.len().saturating_sub(MAX_TURNS);
        for turn in &talk[start..] {
            let text = clip(str_of(turn, "content").unwrap_or(""), MAX_TEXT_CHARS);
            if text.is_empty() {
                continue;
            }
            p.messages.push(PreviewMessage {
                role: str_of(turn, "role").unwrap_or("").to_string(),
                text,
            });
        }
    }
    p
}

fn project_preview(data: &Path, dir: &Path, title: &str) -> ArchivePreview {
    let mut p = ArchivePreview::new(Kind::Project, title);
    let Some(payload) = read_json(&dir.join(PAYLOAD_FILE)) else {
        return p;
    };
    if let Some(n) = payload.get("folder").and_then(|f| str_of(f, "name")).filter(|n| !n.is_empty()) {
        p.title = n.to_string();
    }
    let ids: Vec<&str> = payload
        .get("threadIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    p.total_messages = None;
    // The project's threads sit in the archive beside it; their titles come
    // from there. Newest archive of an id wins.
    let archived = store::list(data);
    for id in ids.iter().take(MAX_LISTED) {
        if let Some(t) = archived
            .iter()
            .find(|i| i.meta.kind == Kind::Thread && i.meta.id == *id)
        {
            let name = clip(&t.meta.title, 120);
            p.threads.push(if name.is_empty() { (*id).to_string() } else { name });
        }
    }
    p.field("threads", ids.len().to_string());
    p
}

fn assistant_preview(dir: &Path, title: &str) -> ArchivePreview {
    let mut p = ArchivePreview::new(Kind::Assistant, title);
    let Some(payload) = read_json(&dir.join(PAYLOAD_FILE)) else {
        return p;
    };
    if let Some(n) = str_of(&payload, "name").filter(|n| !n.is_empty()) {
        p.title = n.to_string();
    }
    p.instructions = str_of(&payload, "instructions")
        .map(|i| clip(i, MAX_INSTRUCTION_CHARS))
        .filter(|i| !i.is_empty());
    p
}

fn studio_preview(dir: &Path, title: &str) -> ArchivePreview {
    use base64::Engine as _;
    let mut p = ArchivePreview::new(Kind::Studio, title);
    let mut image: Option<(std::path::PathBuf, &'static str)> = None;
    let mut recipe: Option<Value> = None;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            match path.extension().and_then(|e| e.to_str()) {
                Some("json") if path.file_name().is_some_and(|n| n != "meta.json") => {
                    recipe = read_json(&path);
                }
                Some("png") => image = Some((path, "image/png")),
                Some("jpg") => image = Some((path, "image/jpeg")),
                Some("webp") => image = Some((path, "image/webp")),
                _ => {}
            }
        }
    }
    if let Some(r) = &recipe {
        if let Some(prompt) = str_of(r, "prompt") {
            p.field("prompt", prompt);
        }
        if let Some(neg) = str_of(r, "negativePrompt") {
            p.field("negative prompt", neg);
        }
        if let Some(m) = str_of(r, "modelName") {
            p.field("model", m);
        }
        if let (Some(w), Some(h)) = (r.get("width").and_then(Value::as_u64), r.get("height").and_then(Value::as_u64)) {
            p.field("size", format!("{w} x {h}"));
        }
        if let Some(s) = r.get("steps").and_then(Value::as_u64) {
            p.field("steps", s.to_string());
        }
        if let Some(s) = r.get("seed").and_then(Value::as_u64) {
            p.field("seed", s.to_string());
        }
        if let Some(f) = r.get("frames").and_then(Value::as_u64) {
            p.field("frames", f.to_string());
        }
        p.created_at = r.get("createdAtMs").and_then(to_ms);
    }
    // A small picture is inlined; a larger one (and any video) is skipped
    // rather than shrunk, so the preview never carries a big payload.
    if let Some((path, mime)) = image {
        if let Some(bytes) = read_capped(&path, MAX_THUMBNAIL_BYTES) {
            p.thumbnail = Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ));
        }
    }
    p
}

/// What is inside archived item `archive_id` of `kind`. The id is validated
/// like a restore's; the item is never changed.
pub fn preview(data: &Path, kind: Kind, archive_id: &str) -> Result<ArchivePreview, String> {
    let dir = store::item_dir(data, kind, archive_id)?;
    let meta = store::read_meta(&dir)?;
    if meta.kind != kind {
        return Err(format!("archived {} {archive_id} not found", kind.as_str()));
    }
    Ok(match kind {
        Kind::Thread => thread_preview(&dir, &meta.title),
        Kind::Room => room_preview(&dir, &meta.title),
        Kind::Cowork => cowork_preview(&dir, &meta.title),
        Kind::Project => project_preview(data, &dir, &meta.title),
        Kind::Assistant => assistant_preview(&dir, &meta.title),
        Kind::Studio => studio_preview(&dir, &meta.title),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn data() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn lines(values: &[Value]) -> String {
        values.iter().map(|v| format!("{v}\n")).collect()
    }

    #[test]
    fn a_thread_shows_title_dates_and_the_first_ten_text_messages() {
        let d = data();
        let dir = d.path().join("threads/t1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("thread.json"),
            json!({"id":"t1","title":"Plan","created":1_700_000_000,"updated":1_700_000_100}).to_string(),
        )
        .unwrap();
        let mut rows = vec![json!({"role":"system","content":[{"type":"text","text":"sys"}]})];
        for i in 0..15 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            rows.push(json!({"role":role,"content":[{"type":"text","text":{"value":format!("m{i}")}}]}));
        }
        // A tool row and a tool-call-only row add nothing.
        rows.insert(2, json!({"role":"tool","content":[{"type":"text","text":"SECRET TOOL OUTPUT"}]}));
        rows.insert(3, json!({"role":"assistant","content":[{"type":"tool_call","text":"x"}]}));
        fs::write(dir.join("messages.jsonl"), lines(&rows)).unwrap();
        store::archive_dir(d.path(), Kind::Thread, "t1", "Plan", None).unwrap();

        let p = preview(d.path(), Kind::Thread, "t1").unwrap();
        assert_eq!(p.title, "Plan");
        assert_eq!(p.created_at, Some(1_700_000_000_000));
        assert_eq!(p.updated_at, Some(1_700_000_100_000));
        assert_eq!(p.messages.len(), MAX_MESSAGES);
        assert_eq!(p.messages[0], PreviewMessage { role: "user".into(), text: "m0".into() });
        assert!(p.messages.iter().all(|m| !m.text.contains("SECRET")));
        // Nothing was restored.
        assert!(!d.path().join("threads/t1").exists());
        assert_eq!(store::list(d.path()).len(), 1);
    }

    #[test]
    fn long_messages_are_truncated_and_plain_string_content_works() {
        let d = data();
        let dir = d.path().join("threads/t2");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("thread.json"), json!({"title":"T"}).to_string()).unwrap();
        let long = "word ".repeat(500);
        fs::write(dir.join("messages.jsonl"), lines(&[json!({"role":"user","content":long})])).unwrap();
        store::archive_dir(d.path(), Kind::Thread, "t2", "T", None).unwrap();
        let p = preview(d.path(), Kind::Thread, "t2").unwrap();
        assert!(p.messages[0].text.chars().count() <= MAX_TEXT_CHARS + 1);
        assert!(p.messages[0].text.ends_with('…'));
    }

    #[test]
    fn a_huge_message_file_is_read_only_up_to_the_cap() {
        let d = data();
        let dir = d.path().join("threads/big");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("thread.json"), "{}").unwrap();
        let row = json!({"role":"user","content":"x".repeat(1000)}).to_string();
        let mut body = String::new();
        while (body.len() as u64) < MAX_JSONL_BYTES * 4 {
            body.push_str(&row);
            body.push('\n');
        }
        fs::write(dir.join("messages.jsonl"), body).unwrap();
        store::archive_dir(d.path(), Kind::Thread, "big", "Big", None).unwrap();
        let p = preview(d.path(), Kind::Thread, "big").unwrap();
        assert_eq!(p.messages.len(), MAX_MESSAGES);
        assert_eq!(p.title, "Big");
    }

    #[test]
    fn a_room_shows_title_participants_and_first_messages() {
        let d = data();
        let dir = d.path().join("rooms/r1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("room.json"),
            json!({
                "id":"r1","title":"Debate","objective":"Pick a stack","createdAt":1_700_000_000_000u64,
                "participants":[
                    {"name":"Ada","removed":false},
                    {"name":"Gone","removed":true},
                    {"name":"Bo","removed":false}
                ]
            })
            .to_string(),
        )
        .unwrap();
        let mut rows = vec![json!({"type":"turn-start","turnId":"a"})];
        for i in 0..12 {
            rows.push(json!({"type":"message","message":{
                "author": if i == 0 { json!({"kind":"user"}) } else { json!({"kind":"participant","participantId":"p","name":"Ada"}) },
                "text": format!("line {i}")
            }}));
        }
        fs::write(dir.join("journal.jsonl"), lines(&rows)).unwrap();
        store::archive_dir(d.path(), Kind::Room, "r1", "Debate", None).unwrap();

        let p = preview(d.path(), Kind::Room, "r1").unwrap();
        assert_eq!(p.title, "Debate");
        assert_eq!(p.participants, vec!["Ada", "Bo"]);
        assert_eq!(p.messages.len(), MAX_MESSAGES);
        assert_eq!(p.messages[0].role, "user");
        assert_eq!(p.messages[1].role, "Ada");
        assert_eq!(p.fields[0], PreviewField { label: "objective".into(), value: "Pick a stack".into() });
        assert!(d.path().join(".archive/room/r1/room.json").exists());
    }

    #[test]
    fn a_cowork_session_shows_folder_and_the_last_turns() {
        let d = data();
        let turns: Vec<Value> = (0..9)
            .map(|i| json!({"role": if i % 2 == 0 {"user"} else {"assistant"}, "content": format!("turn {i}")}))
            .chain([json!({"role":"tool","content":"TOOL BODY"})])
            .collect();
        store::archive_payload(
            d.path(),
            Kind::Cowork,
            "s1",
            "Work",
            &json!({"session":{"id":"s1","title":"Work","folder":"C:/code/app","turns":turns}}),
            None,
        )
        .unwrap();
        let p = preview(d.path(), Kind::Cowork, "s1").unwrap();
        assert_eq!(p.folder.as_deref(), Some("C:/code/app"));
        assert_eq!(p.total_messages, Some(9));
        assert_eq!(p.messages.len(), MAX_TURNS);
        assert_eq!(p.messages.last().unwrap().text, "turn 8");
        assert!(p.messages.iter().all(|m| m.text != "TOOL BODY"));
    }

    #[test]
    fn a_project_lists_its_archived_thread_titles() {
        let d = data();
        for (id, title) in [("a", "Alpha"), ("b", "Beta")] {
            let dir = d.path().join("threads").join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("thread.json"), "{}").unwrap();
            store::archive_dir(d.path(), Kind::Thread, id, title, None).unwrap();
        }
        store::archive_payload(
            d.path(),
            Kind::Project,
            "p1",
            "Proj",
            &json!({"folder":{"id":"p1","name":"Proj"},"threadIds":["a","b","gone"]}),
            None,
        )
        .unwrap();
        let p = preview(d.path(), Kind::Project, "p1").unwrap();
        assert_eq!(p.title, "Proj");
        assert_eq!(p.threads, vec!["Alpha", "Beta"]);
        assert_eq!(p.fields[0].value, "3");
    }

    #[test]
    fn an_assistant_shows_name_and_instructions() {
        let d = data();
        store::archive_payload(
            d.path(),
            Kind::Assistant,
            "h",
            "Helper",
            &json!({"id":"h","name":"Helper","instructions":"be   brief\nand kind"}),
            None,
        )
        .unwrap();
        let p = preview(d.path(), Kind::Assistant, "h").unwrap();
        assert_eq!(p.title, "Helper");
        assert_eq!(p.instructions.as_deref(), Some("be brief and kind"));
    }

    fn studio(d: &Path, png: &[u8]) -> String {
        let dir = d.join("images");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("9-job-00.png"), png).unwrap();
        fs::write(
            dir.join("9-job-00.json"),
            json!({"prompt":"a red cat","negativePrompt":"blur","width":512,"height":768,
                   "steps":20,"seed":7,"modelName":"SD","createdAtMs":5_000})
            .to_string(),
        )
        .unwrap();
        store::archive_studio(d, "images", "9-job-00", "a red cat").unwrap()
    }

    #[test]
    fn a_studio_item_shows_its_recipe_and_a_small_thumbnail() {
        let d = data();
        let name = studio(d.path(), b"png-bytes");
        let p = preview(d.path(), Kind::Studio, &name).unwrap();
        let get = |l: &str| p.fields.iter().find(|f| f.label == l).map(|f| f.value.clone());
        assert_eq!(get("prompt").as_deref(), Some("a red cat"));
        assert_eq!(get("size").as_deref(), Some("512 x 768"));
        assert_eq!(get("seed").as_deref(), Some("7"));
        assert_eq!(p.thumbnail.as_deref(), Some("data:image/png;base64,cG5nLWJ5dGVz"));
    }

    #[test]
    fn a_studio_picture_over_the_cap_is_skipped() {
        let d = data();
        let name = studio(d.path(), &vec![0u8; MAX_THUMBNAIL_BYTES as usize + 1]);
        let p = preview(d.path(), Kind::Studio, &name).unwrap();
        assert!(p.thumbnail.is_none());
        assert!(!p.fields.is_empty());
    }

    #[test]
    fn bad_ids_and_wrong_kinds_are_refused_and_nothing_outside_is_read() {
        let d = data();
        fs::write(d.path().join("secret.json"), "{}").unwrap();
        for bad in ["..", "../x", "a/b", "a\\b", "", ".archive", "sqlite:1"] {
            assert!(preview(d.path(), Kind::Thread, bad).is_err(), "{bad}");
        }
        store::archive_payload(d.path(), Kind::Assistant, "h", "H", &json!({}), None).unwrap();
        assert!(preview(d.path(), Kind::Thread, "h").is_err());
        assert!(preview(d.path(), Kind::Assistant, "missing").is_err());
    }

    #[test]
    fn a_corrupt_or_oversized_file_still_gives_a_title() {
        let d = data();
        store::archive_payload(d.path(), Kind::Cowork, "s", "Kept", &json!({}), None).unwrap();
        fs::write(d.path().join(".archive/cowork/s/payload.json"), "{not json").unwrap();
        let p = preview(d.path(), Kind::Cowork, "s").unwrap();
        assert_eq!(p.title, "Kept");
        assert!(p.messages.is_empty());
    }
}
