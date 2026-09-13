//! What a dispatched request was made of, by category. AH-087.
//!
//! Every surface used to answer "what is filling the window?" its own way: the
//! TUI rebuilt the system prompt from disk and re-serialized the tool schemas,
//! Chat and Cowork counted what they had in memory, and the headless CLI had no
//! answer at all. Three derivations of one number disagree the moment anything
//! moves -- a skill added since, a memory forgotten, a tool that was never
//! advertised on this run -- and the one thing none of them read was the
//! request that was actually sent.
//!
//! This reads that. The input is a prompt snapshot's payload: the exact bytes
//! the provider received. Categories are cut from it, never re-derived, so the
//! parts sum to the whole and the whole is what went out.
//!
//! Two honesty rules the callers depend on:
//!
//! * A count is marked `exact` only when the provider reported it. Everything
//!   cut from the payload is an estimate (bytes over four, the same divisor the
//!   compaction gauge uses) and says so.
//! * A window this build does not know is `None`, not a guess. Free space is
//!   then unknown too, rather than a number computed from a default nobody
//!   chose.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The categories a request is cut into. Ordered as a reader reads them:
/// what the harness put there first, then the conversation, then what is
/// reserved for the answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    /// The harness's own instructions: role, guidelines, environment.
    SystemPrompt,
    /// Project context files (`JAN.md` and its parents).
    ProjectContext,
    /// The skills catalog offered in the prompt.
    Skills,
    /// Memory offered in the prompt, by scope.
    Memory,
    /// Custom agents and roles named in the prompt.
    CustomAgents,
    /// Tool definitions the request carried.
    ToolsTransmitted,
    /// Tool definitions the run has but did not send. Never counted in the
    /// used total: a definition that was not transmitted cost nothing.
    ToolsDeferred,
    /// Summaries standing in for conversation that was compacted away.
    CompactedHistory,
    /// The conversation itself.
    Messages,
    /// Images and files carried in messages.
    Attachments,
    /// Space the request asked to keep for the answer (`max_tokens`).
    ReservedOutput,
    /// What is left of the window.
    FreeSpace,
}

impl Category {
    pub fn tag(self) -> &'static str {
        match self {
            Self::SystemPrompt => "system-prompt",
            Self::ProjectContext => "project-context",
            Self::Skills => "skills",
            Self::Memory => "memory",
            Self::CustomAgents => "custom-agents",
            Self::ToolsTransmitted => "tools-transmitted",
            Self::ToolsDeferred => "tools-deferred",
            Self::CompactedHistory => "compacted-history",
            Self::Messages => "messages",
            Self::Attachments => "attachments",
            Self::ReservedOutput => "reserved-output",
            Self::FreeSpace => "free-space",
        }
    }

    /// A short label for a person.
    pub fn label(self) -> &'static str {
        match self {
            Self::SystemPrompt => "System prompt",
            Self::ProjectContext => "Project context",
            Self::Skills => "Skills",
            Self::Memory => "Memory",
            Self::CustomAgents => "Custom agents",
            Self::ToolsTransmitted => "Tools sent",
            Self::ToolsDeferred => "Tools not sent",
            Self::CompactedHistory => "Compacted history",
            Self::Messages => "Messages",
            Self::Attachments => "Attachments",
            Self::ReservedOutput => "Reserved for the answer",
            Self::FreeSpace => "Free space",
        }
    }

    /// Whether this category is part of what the request occupied.
    ///
    /// Deferred tools are not: they were never sent. Reserved output and free
    /// space are not either: they are what is left, not what was used.
    pub fn counts_as_used(self) -> bool {
        !matches!(
            self,
            Self::ToolsDeferred | Self::ReservedOutput | Self::FreeSpace
        )
    }
}

/// One category's share of the request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    pub category: Category,
    pub label: String,
    pub tokens: u64,
    /// How many things are in it -- messages, tools, attachments -- when
    /// counting them means anything.
    #[serde(default)]
    pub items: u64,
    /// False when the number is bytes over four rather than a provider's count.
    pub exact: bool,
}

/// What one dispatched request was made of.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakdown {
    /// The snapshot this was cut from, so a reader can go and look at it.
    #[serde(default)]
    pub snapshot_id: String,
    /// Whether this request opened a turn or continued one (AH-087).
    #[serde(default)]
    pub dispatch: String,
    #[serde(default)]
    pub model: String,
    /// The model's window, when this build knows it. `None` is unknown, never
    /// a default.
    #[serde(default)]
    pub window_tokens: Option<u64>,
    /// What the request occupied. The provider's own count when it reported
    /// one, otherwise the sum of the estimated slices.
    pub used_tokens: u64,
    /// True only when `used_tokens` came from the provider.
    pub used_exact: bool,
    pub slices: Vec<Slice>,
}

impl Breakdown {
    /// The share of the window in use, when the window is known.
    pub fn percent(&self) -> Option<f64> {
        let window = self.window_tokens.filter(|w| *w > 0)?;
        Some((self.used_tokens as f64 / window as f64) * 100.0)
    }

    pub fn slice(&self, category: Category) -> Option<&Slice> {
        self.slices.iter().find(|s| s.category == category)
    }
}

/// Bytes over four, the divisor every other estimate in the harness uses.
fn tokens_of(bytes: usize) -> u64 {
    (bytes / 4) as u64
}

/// The text of a message's content, whatever shape it arrived in, plus the
/// bytes that belong to attachments rather than to words.
fn content_bytes(content: Option<&Value>) -> (usize, usize, u64) {
    match content {
        Some(Value::String(text)) => (text.len(), 0, 0),
        Some(Value::Array(parts)) => {
            let (mut text, mut attached, mut count) = (0usize, 0usize, 0u64);
            for part in parts {
                let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "text" => {
                        text += part.get("text").and_then(Value::as_str).map_or(0, str::len)
                    }
                    // An image or a file: its bytes are the attachment, not the
                    // conversation, and a data URI is most of the request.
                    _ => {
                        attached += serde_json::to_string(part).map_or(0, |s| s.len());
                        count += 1;
                    }
                }
            }
            (text, attached, count)
        }
        _ => (0, 0, 0),
    }
}

/// Section headings the system prompt builder writes, and the category each
/// belongs to. What is not under one of these is the harness's own prompt.
const SECTIONS: &[(&str, Category)] = &[
    ("# Project Context", Category::ProjectContext),
    ("# Available Skills", Category::Skills),
    ("# Available Memories", Category::Memory),
    ("# Memory", Category::Memory),
    ("# Subagents", Category::CustomAgents),
    ("# Available Agents", Category::CustomAgents),
];

/// Cut the system text into its sections, by the headings that wrote them.
///
/// A heading this build does not know leaves its text in the system prompt,
/// which is the safe direction: a category that over-reports would hide text
/// the reader is looking for.
fn split_system(text: &str) -> Vec<(Category, usize)> {
    let mut marks: Vec<(usize, Category)> = Vec::new();
    for (heading, category) in SECTIONS {
        let mut from = 0usize;
        while let Some(at) = text[from..].find(heading) {
            let at = from + at;
            // Only at the start of a line: a heading quoted inside prose is
            // prose.
            if at == 0 || text.as_bytes()[at - 1] == b'\n' {
                marks.push((at, *category));
            }
            from = at + heading.len();
        }
    }
    marks.sort_by_key(|(at, _)| *at);
    let mut out: Vec<(Category, usize)> = Vec::new();
    let mut prompt_bytes = marks.first().map_or(text.len(), |(at, _)| *at);
    for (i, (at, category)) in marks.iter().enumerate() {
        let end = marks.get(i + 1).map_or(text.len(), |(next, _)| *next);
        let len = end.saturating_sub(*at);
        match out.iter_mut().find(|(c, _)| c == category) {
            Some((_, bytes)) => *bytes += len,
            None => out.push((*category, len)),
        }
    }
    if prompt_bytes == text.len() && marks.is_empty() {
        prompt_bytes = text.len();
    }
    out.insert(0, (Category::SystemPrompt, prompt_bytes));
    out
}

/// Whether a message is a compaction summary standing in for dropped history.
fn is_compaction(content: &str) -> bool {
    content.contains("[Earlier conversation was omitted")
        || content.contains("Summary of the earlier conversation")
        || content.starts_with("[compacted]")
}

/// What the request was made of.
///
/// `payload` is the snapshot's stored request. `window` is the model's context
/// window when it is known; `provider_prompt_tokens` is what the provider said
/// the request cost, when it said anything. `deferred_tools` is how many tool
/// definitions the run holds but did not send, which is reported and never
/// counted.
pub fn classify(
    payload: &Value,
    window: Option<u64>,
    provider_prompt_tokens: Option<u64>,
    deferred_tools: u64,
) -> Breakdown {
    let mut system_bytes = 0usize;
    let mut message_bytes = 0usize;
    let mut compacted_bytes = 0usize;
    let mut attachment_bytes = 0usize;
    let (mut messages, mut attachments, mut compacted) = (0u64, 0u64, 0u64);

    if let Some(list) = payload.get("messages").and_then(Value::as_array) {
        for message in list {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            let (text, attached, count) = content_bytes(message.get("content"));
            attachment_bytes += attached;
            attachments += count;
            // A tool call's arguments are part of the conversation's cost.
            let calls = message
                .get("tool_calls")
                .map_or(0, |c| serde_json::to_string(c).map_or(0, |s| s.len()));
            if role == "system" {
                system_bytes += text;
                continue;
            }
            let is_summary = message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(is_compaction);
            if is_summary {
                compacted_bytes += text;
                compacted += 1;
            } else {
                message_bytes += text + calls;
                messages += 1;
            }
        }
    }

    let tools = payload.get("tools").and_then(Value::as_array);
    let tool_bytes = tools.map_or(0, |t| serde_json::to_string(t).map_or(0, |s| s.len()));
    let tool_count = tools.map_or(0, |t| t.len() as u64);
    let reserved = payload
        .get("max_tokens")
        .or_else(|| payload.get("max_completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let mut slices: Vec<Slice> = Vec::new();
    let mut push = |category: Category, tokens: u64, items: u64| {
        if tokens == 0 && items == 0 {
            return;
        }
        slices.push(Slice {
            category,
            label: category.label().to_string(),
            tokens,
            items,
            exact: false,
        });
    };

    // The system message, cut into the sections that wrote it.
    let system_text: String = payload
        .get("messages")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|m| m.get("role").and_then(Value::as_str) == Some("system"))
                .filter_map(|m| m.get("content").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let _ = system_bytes;
    for (category, bytes) in split_system(&system_text) {
        push(category, tokens_of(bytes), 0);
    }
    push(Category::ToolsTransmitted, tokens_of(tool_bytes), tool_count);
    // Reported, never counted: a definition that was not sent cost nothing.
    push(Category::ToolsDeferred, 0, deferred_tools);
    push(Category::CompactedHistory, tokens_of(compacted_bytes), compacted);
    push(Category::Messages, tokens_of(message_bytes), messages);
    push(Category::Attachments, tokens_of(attachment_bytes), attachments);
    push(Category::ReservedOutput, reserved, 0);

    let estimated_used: u64 = slices
        .iter()
        .filter(|s| s.category.counts_as_used())
        .map(|s| s.tokens)
        .sum();
    let (used, exact) = match provider_prompt_tokens {
        Some(counted) => (counted, true),
        None => (estimated_used, false),
    };
    if let Some(window) = window {
        let free = window.saturating_sub(used + reserved);
        slices.push(Slice {
            category: Category::FreeSpace,
            label: Category::FreeSpace.label().to_string(),
            tokens: free,
            items: 0,
            // Free space is as exact as the number it was subtracted from.
            exact,
        });
    }

    Breakdown {
        snapshot_id: String::new(),
        dispatch: String::new(),
        model: payload
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        window_tokens: window,
        used_tokens: used,
        used_exact: exact,
        slices,
    }
}

/// What one recorded dispatch was made of, read from the session's own
/// snapshots (AH-087).
///
/// `snapshot_id` names the request; `None` is the session's most recent one.
/// The request is looked up inside the session that owns it, so an id from
/// another session names nothing here.
pub fn of_snapshot(
    data_folder: &std::path::Path,
    session: &str,
    snapshot_id: Option<&str>,
    window: Option<u64>,
    deferred_tools: u64,
) -> Result<Breakdown, crate::harness_error::HarnessError> {
    use crate::harness_error::{ErrorKind, HarnessError, Stage};
    let mine = crate::snapshot::by_session(data_folder, session);
    let found = match snapshot_id {
        Some(id) => mine.into_iter().find(|s| s.id == id),
        None => mine.into_iter().next_back(),
    };
    let Some(snapshot) = found else {
        return Err(HarnessError::new(
            ErrorKind::NotFound,
            match snapshot_id {
                Some(id) => format!("this session has no request {id:?}"),
                None => "this session has not sent a request yet".to_string(),
            },
        )
        .at(Stage::Context));
    };
    if snapshot.payload.is_null() {
        return Err(HarnessError::new(
            ErrorKind::NotFound,
            "the request was recorded without its payload, so what it was made of cannot be read",
        )
        .at(Stage::Context));
    }
    // No provider count travels with a snapshot, so the categories and the
    // total are both estimates here, and say so. A caller that has the
    // provider's own number for this request passes it to `classify`.
    let mut breakdown = classify(&snapshot.payload, window, None, deferred_tools);
    breakdown.snapshot_id = snapshot.id.clone();
    breakdown.dispatch = match snapshot.kind {
        crate::snapshot::DispatchKind::Initial => "initial",
        crate::snapshot::DispatchKind::Continuation => "continuation",
        crate::snapshot::DispatchKind::Retry => "retry",
        crate::snapshot::DispatchKind::Compaction => "compaction",
    }
    .to_string();
    if breakdown.model.is_empty() {
        breakdown.model = snapshot.model.clone();
    }
    Ok(breakdown)
}

/// The breakdown as readable text, for the headless CLI and the TUI.
pub fn render(breakdown: &Breakdown) -> String {
    let mut out = String::new();
    let thousands = |n: u64| {
        let text = n.to_string();
        let mut grouped = String::new();
        for (i, c) in text.chars().enumerate() {
            if i > 0 && (text.len() - i) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(c);
        }
        grouped
    };
    out.push_str(&format!(
        "Context for {}{}\n",
        if breakdown.model.is_empty() { "the model" } else { &breakdown.model },
        match breakdown.dispatch.as_str() {
            "" => String::new(),
            kind => format!(" ({kind} dispatch)"),
        }
    ));
    match breakdown.window_tokens {
        Some(window) => out.push_str(&format!(
            "  {} of {} tokens in use ({:.0}%), counted by {}\n",
            thousands(breakdown.used_tokens),
            thousands(window),
            breakdown.percent().unwrap_or(0.0),
            if breakdown.used_exact { "the provider" } else { "estimate" }
        )),
        None => out.push_str(&format!(
            "  {} tokens in use, counted by {}; this model's window is not known\n",
            thousands(breakdown.used_tokens),
            if breakdown.used_exact { "the provider" } else { "estimate" }
        )),
    }
    for slice in &breakdown.slices {
        let items = match slice.items {
            0 => String::new(),
            n => format!(" ({n})"),
        };
        out.push_str(&format!(
            "  {:<24} {:>9}{}{}\n",
            slice.label,
            thousands(slice.tokens),
            items,
            if slice.exact { "" } else { " ~" }
        ));
    }
    if breakdown.slices.iter().any(|s| !s.exact) {
        out.push_str("  ~ estimated from the request's own text\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload() -> Value {
        json!({
            "model": "m",
            "max_tokens": 500,
            "messages": [
                { "role": "system", "content": "You are helpful.\n\n# Project Context\n\nproject rules here\n\n# Available Skills\n\n## Skill: deploy\n\n# Available Memories\n\n- a memory" },
                { "role": "user", "content": "hello there" },
                { "role": "assistant", "content": "[Earlier conversation was omitted to fit the model's context window.]" },
                { "role": "user", "content": [
                    { "type": "text", "text": "look at this" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAABBBBCCCCDDDD" } }
                ] }
            ],
            "tools": [ { "type": "function", "function": { "name": "ls", "parameters": {} } } ]
        })
    }

    /// The categories are cut from the request that was sent, and what is
    /// counted as used is only what the request actually carried.
    #[test]
    fn a_request_is_cut_into_what_it_was_made_of() {
        let b = classify(&payload(), Some(10_000), None, 7);
        let got: Vec<&str> = b.slices.iter().map(|s| s.category.tag()).collect();
        for expected in [
            "system-prompt",
            "project-context",
            "skills",
            "memory",
            "tools-transmitted",
            "tools-deferred",
            "compacted-history",
            "messages",
            "attachments",
            "reserved-output",
            "free-space",
        ] {
            assert!(got.contains(&expected), "{expected} is missing from {got:?}");
        }
        // The conversation and the compaction summary are told apart.
        assert_eq!(b.slice(Category::Messages).unwrap().items, 2);
        assert_eq!(b.slice(Category::CompactedHistory).unwrap().items, 1);
        assert_eq!(b.slice(Category::Attachments).unwrap().items, 1);
        assert_eq!(b.slice(Category::ToolsTransmitted).unwrap().items, 1);

        // Deferred tools are reported and cost nothing.
        let deferred = b.slice(Category::ToolsDeferred).unwrap();
        assert_eq!(deferred.items, 7);
        assert_eq!(deferred.tokens, 0);
        assert!(!Category::ToolsDeferred.counts_as_used());

        // Used is the sum of what was sent, and does not include what was
        // reserved for the answer or what is free.
        let summed: u64 = b
            .slices
            .iter()
            .filter(|s| s.category.counts_as_used())
            .map(|s| s.tokens)
            .sum();
        assert_eq!(b.used_tokens, summed);
        assert!(!b.used_exact, "an estimate must not claim to be exact");
        assert_eq!(
            b.slice(Category::FreeSpace).unwrap().tokens,
            10_000 - summed - 500
        );
    }

    /// A provider's own count wins, and says so; the categories stay estimates.
    #[test]
    fn the_providers_count_is_used_when_there_is_one() {
        let b = classify(&payload(), Some(10_000), Some(1_234), 0);
        assert_eq!(b.used_tokens, 1_234);
        assert!(b.used_exact);
        assert!(
            b.slices.iter().filter(|s| s.category != Category::FreeSpace).all(|s| !s.exact),
            "a category cut from text is an estimate"
        );
        assert_eq!(b.percent().unwrap().round(), 12.0);
    }

    /// A window this build does not know is unknown, not a default: there is
    /// no percentage and no free space rather than an invented one.
    #[test]
    fn an_unknown_window_stays_unknown() {
        let b = classify(&payload(), None, None, 0);
        assert!(b.window_tokens.is_none());
        assert!(b.percent().is_none());
        assert!(b.slice(Category::FreeSpace).is_none());
        let text = render(&b);
        assert!(text.contains("window is not known"), "{text}");
    }

    /// An empty request is empty, not a division by zero.
    #[test]
    fn an_empty_request_reports_nothing() {
        let b = classify(&json!({}), Some(0), None, 0);
        assert_eq!(b.used_tokens, 0);
        assert!(b.percent().is_none(), "a zero window is not a percentage");
        assert!(b.slices.iter().all(|s| s.category == Category::FreeSpace || s.tokens == 0));
    }

    /// The text form says which numbers are counted and which are estimated.
    #[test]
    fn the_text_form_distinguishes_counted_from_estimated() {
        let counted = render(&classify(&payload(), Some(10_000), Some(1_234), 0));
        assert!(counted.contains("counted by the provider"), "{counted}");
        assert!(counted.contains("~ estimated from the request's own text"), "{counted}");
        let estimated = render(&classify(&payload(), Some(10_000), None, 0));
        assert!(estimated.contains("counted by estimate"), "{estimated}");
    }
}
