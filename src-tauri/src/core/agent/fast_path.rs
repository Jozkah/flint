//! A fast path for prompts that plainly need no tools (`[agent] fast_path`).
//!
//! "hi", "thanks", "what's a mutex?" do not need a repository map, a skill
//! catalog, a delegation guide and forty tool schemas in front of them; on a
//! small local model that preamble is most of the time to first token. When the
//! opt-in is on and the opening prompt is plainly trivial, the first attempt is
//! made with a lean prompt and the minimal tool set.
//!
//! What the fast path keeps, and what it can never do:
//!
//! - **Safety is not preamble.** The assistant's instructions, the always-on
//!   guidelines, the project's instruction file, the runtime environment and
//!   remembered facts stay. Only the guides, catalogs and maps that exist to
//!   help *use tools* are left out.
//! - **No tool ever runs on the fast path.** The attempt is wrapped in a probe
//!   ([`FastProbe`]): the moment the model answers with a tool call the attempt
//!   is abandoned before anything is dispatched, and the run restarts on the
//!   full path -- full prompt, full tool set, every gate -- from the untouched
//!   conversation. A fast answer is therefore always a plain-text one.
//! - Only a run's *opening* turn is eligible: one user message, no history, no
//!   plan mode, no goal mode, no hooks, no subagent. Anything else takes the
//!   full path without trying.

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::core::agent::events::StreamEvent;
use crate::core::agent::prompt::Composer;
use crate::core::agent::r#loop::ModelInvoker;
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError};

/// Words that mean the prompt is about the user's machine or project, or about
/// something that needs a tool to answer. Any one of them disqualifies the
/// prompt: the fast path only ever errs toward the full path.
const NEEDS_CONTEXT: &[&str] = &[
    "file", "files", "folder", "directory", "dir", "repo", "repository", "project", "code",
    "codebase", "function", "class", "method", "module", "bug", "error", "errors", "fix",
    "edit", "write", "create", "make", "build", "delete", "remove", "rename", "run", "test",
    "tests", "install", "search", "find", "grep", "read", "open", "list", "show", "check",
    "look", "debug", "refactor", "implement", "add", "change", "update", "commit", "git",
    "branch", "deploy", "script", "command", "terminal", "shell", "download", "upload",
    "browse", "website", "web", "url", "link", "latest", "current", "today", "now", "news",
    "weather", "price", "remember", "forget", "save", "note", "memory", "skill", "this",
    "these", "that", "above", "below", "attached", "attachment", "image", "screenshot",
    "pdf", "my", "our", "here",
];

const GREETINGS: &[&str] = &[
    "hi", "hello", "hey", "yo", "hiya", "howdy", "sup", "thanks", "thank you", "thx", "ty",
    "ok", "okay", "cool", "great", "nice", "good morning", "good afternoon", "good evening",
    "good night", "bye", "goodbye", "hi there", "hello there", "hey there", "how are you",
    "who are you", "what can you do",
];

const QUESTION_STARTS: &[&str] = &[
    "who", "what", "whats", "when", "where", "why", "how", "is", "are", "can", "does", "do",
    "did", "which", "whose", "was", "were", "will",
];

/// The longest prompt that can be trivial, in characters.
const MAX_CHARS: usize = 140;
/// The most words a question can have and still be a "short" one.
const MAX_QUESTION_WORDS: usize = 14;

/// Whether `text` is plainly answerable from the model's own knowledge.
pub(crate) fn is_trivial(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > MAX_CHARS || text.contains('\n') {
        return false;
    }
    // Anything shaped like code, a path, a URL or a mention is about something
    // outside the model's head.
    if text.chars().any(|c| matches!(c, '`' | '/' | '\\' | '@' | '$' | '=' | '{' | '}' | '[' | ']' | '<' | '>' | '|' | ';' | '#')) {
        return false;
    }
    let lowered = text.to_lowercase();
    let words: Vec<&str> = lowered
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return false;
    }
    // A token like `main.rs` or `v1.2`: an identifier with a dot inside it.
    if lowered
        .split_whitespace()
        .any(|t| t.trim_matches(|c: char| !c.is_alphanumeric()).contains('.'))
    {
        return false;
    }
    if words.iter().any(|w| NEEDS_CONTEXT.contains(w)) {
        return false;
    }
    let bare = words.join(" ");
    if GREETINGS.contains(&bare.as_str()) {
        return true;
    }
    text.ends_with('?')
        && words.len() <= MAX_QUESTION_WORDS
        && words.first().is_some_and(|w| QUESTION_STARTS.contains(w))
}

/// The opening prompt, when this conversation is eligible for the fast path:
/// exactly one non-system message, from the user, as plain text, and trivial.
pub(crate) fn trivial_opening(messages: &[Value]) -> bool {
    let mut users = messages.iter().filter(|m| m.get("role").and_then(Value::as_str) != Some("system"));
    let (Some(only), None) = (users.next(), users.next()) else {
        return false;
    };
    if only.get("role").and_then(Value::as_str) != Some("user") {
        return false;
    }
    // A string only: a content array may carry an image or a file.
    match only.get("content").and_then(Value::as_str) {
        Some(text) => !crate::core::agent::reminder::is_reminder_text(text) && is_trivial(text),
        None => false,
    }
}

/// The prompt blocks that survive the fast path. Everything left out is
/// guidance for *using tools* or *navigating a project*; everything kept is
/// who the assistant is, how it must behave, what the user told it, and where
/// it is running.
pub(crate) fn lean_blocks(blocks: &[(Composer, String)]) -> Vec<(Composer, String)> {
    blocks
        .iter()
        .filter(|(composer, _)| keeps(*composer))
        .cloned()
        .collect()
}

fn keeps(composer: Composer) -> bool {
    match composer {
        Composer::AssistantInstructions
        | Composer::Guidelines
        | Composer::MemoryPrecedence
        | Composer::ProjectContext
        | Composer::RuntimeEnvironment
        | Composer::RememberedMemories
        | Composer::Date => true,
        Composer::SubagentGuide
        | Composer::SkillGuide
        | Composer::WebToolsGuide
        | Composer::Skills
        | Composer::ProjectTooling
        | Composer::RepoMap
        | Composer::MemoryCatalog
        | Composer::SessionHooks
        | Composer::PlanAddendum
        | Composer::EagerTodoAddendum
        | Composer::ToolSchemas
        | Composer::PromptSubmitHooks
        | Composer::TodoUpkeep => false,
    }
}

/// The minimal tool set a fast attempt is shown: enough that a model which
/// does want a tool asks for it (and so triggers the fallback) instead of
/// improvising one in prose.
pub(crate) fn lean_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter(|t| {
            t["function"]["name"]
                .as_str()
                .is_some_and(|n| crate::core::agent::tool_profile::MINIMAL_TOOLS.contains(&n))
        })
        .cloned()
        .collect()
}

fn is_tool_event(event: &StreamEvent) -> bool {
    matches!(
        event,
        StreamEvent::ToolCallStarted { .. } | StreamEvent::ToolCallArgsDelta { .. } | StreamEvent::ToolCall { .. }
    )
}

/// Whether a completion asks for a tool.
pub(crate) fn asks_for_tool(completion: &Value) -> bool {
    completion["choices"][0]["message"]["tool_calls"]
        .as_array()
        .is_some_and(|calls| !calls.is_empty())
}

/// Wraps the run's model for the fast attempt: hides the model's tool-call
/// stream from the UI, and abandons the attempt when the reply asks for a tool.
///
/// Non-tool events are held until the reply is known: forwarded in order when
/// the attempt stands, dropped when it is abandoned, so the full path's rerun
/// does not show the abandoned attempt's text a second time. The trade-off is
/// that tokens appear once the (short) fast reply completes rather than live.
pub(crate) struct FastProbe<'a> {
    inner: &'a dyn ModelInvoker,
    missed: AtomicBool,
}

impl<'a> FastProbe<'a> {
    pub(crate) fn new(inner: &'a dyn ModelInvoker) -> Self {
        Self { inner, missed: AtomicBool::new(false) }
    }

    /// Whether the model asked for a tool, so the full path must run instead.
    pub(crate) fn missed(&self) -> bool {
        self.missed.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl ModelInvoker for FastProbe<'_> {
    async fn invoke(
        &self,
        request: &Value,
        events: &mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<Value, HarnessError> {
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
        let relay = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Some(event) = rx.recv().await {
                if !is_tool_event(&event) {
                    held.push(event);
                }
            }
            held
        });
        let result = self.inner.invoke(request, &tx).await;
        drop(tx);
        let held = relay.await.unwrap_or_default();
        match result {
            Ok(completion) if asks_for_tool(&completion) => {
                // Abandoned: the held events belong to a reply nobody will see.
                self.missed.store(true, Ordering::SeqCst);
                Err(HarnessError::new(
                    ErrorKind::Internal,
                    "fast path: the model asked for a tool; running the full path",
                ))
            }
            other => {
                for event in held {
                    let _ = events.send(event);
                }
                other
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn greetings_and_short_questions_are_trivial() {
        for text in ["hi", "Hello!", "thanks", "Thank you.", "good morning", "who are you?", "What is a mutex?", "how does DNS work?", "Is Rust faster than Go?"] {
            assert!(is_trivial(text), "{text:?} should be trivial");
        }
    }

    #[test]
    fn anything_that_needs_the_machine_or_a_tool_is_not() {
        for text in [
            "fix the bug in main.rs",
            "what is in my project folder?",
            "run the tests",
            "what's the weather today?",
            "explain this code",
            "read C:\\tmp\\notes.txt",
            "look at https://example.com",
            "hi, can you refactor my build script?",
            "what does `git rebase` do?",
            "latest news about rust?",
            "how do I install node?",
            "what is the price of bitcoin now?",
            "remember that I like tabs",
            "",
            "   ",
        ] {
            assert!(!is_trivial(text), "{text:?} must take the full path");
        }
    }

    #[test]
    fn long_or_multiline_prompts_are_never_trivial() {
        assert!(!is_trivial(&"what is a mutex? ".repeat(20)));
        assert!(!is_trivial("hi\nwhat is a mutex?"));
        assert!(!is_trivial("what is the difference between a mutex and a semaphore and a monitor and a latch in practice?"));
    }

    #[test]
    fn a_statement_without_a_question_mark_is_not_a_question() {
        assert!(!is_trivial("what a mutex is"));
        assert!(!is_trivial("tell me a joke"));
    }

    fn user(text: &str) -> Value {
        serde_json::json!({ "role": "user", "content": text })
    }

    #[test]
    fn only_a_lone_trivial_user_message_is_an_eligible_opening() {
        assert!(trivial_opening(&[user("hi")]));
        let system = serde_json::json!({ "role": "system", "content": "be nice" });
        assert!(trivial_opening(&[system.clone(), user("hi")]));
        // History: not an opening.
        let reply = serde_json::json!({ "role": "assistant", "content": "hello" });
        assert!(!trivial_opening(&[user("hi"), reply, user("thanks")]));
        // Two users, an image part, a non-trivial prompt.
        assert!(!trivial_opening(&[user("hi"), user("hi")]));
        let image = serde_json::json!({ "role": "user", "content": [{ "type": "text", "text": "hi" }] });
        assert!(!trivial_opening(&[image]));
        assert!(!trivial_opening(&[user("fix the bug")]));
        assert!(!trivial_opening(&[]));
    }

    #[test]
    fn the_lean_prompt_keeps_safety_and_drops_tool_guidance() {
        let blocks: Vec<(Composer, String)> = Composer::ALL
            .iter()
            .map(|c| (*c, c.id().to_string()))
            .collect();
        let lean = lean_blocks(&blocks);
        let ids: Vec<&str> = lean.iter().map(|(c, _)| c.id()).collect();
        for kept in ["assistant_instructions", "guidelines", "project_context", "runtime_environment", "remembered_memories"] {
            assert!(ids.contains(&kept), "{kept} must survive: {ids:?}");
        }
        for dropped in ["repo_map", "skills", "skill_guide", "subagent_guide", "web_tools_guide", "memory_catalog", "project_tooling"] {
            assert!(!ids.contains(&dropped), "{dropped} must go: {ids:?}");
        }
        // Order is the registry's, untouched.
        let order: Vec<usize> = lean
            .iter()
            .map(|(c, _)| Composer::ALL.iter().position(|a| a == c).unwrap())
            .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn the_guidelines_are_never_dropped() {
        // The invariant the whole feature leans on, stated on its own.
        assert!(keeps(Composer::Guidelines));
        assert!(keeps(Composer::AssistantInstructions));
        assert!(keeps(Composer::ProjectContext));
    }

    #[test]
    fn lean_tools_are_the_minimal_set_only() {
        let tools: Vec<Value> = ["read", "bash", "browser", "git_branch", "ask", "dispatch_subagent"]
            .iter()
            .map(|n| serde_json::json!({ "type": "function", "function": { "name": n } }))
            .collect();
        let names: Vec<String> = lean_tools(&tools)
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["read", "bash", "ask"]);
    }

    struct Scripted(Mutex<Vec<Value>>);

    #[async_trait]
    impl ModelInvoker for Scripted {
        async fn invoke(&self, _request: &Value, events: &mpsc::UnboundedSender<StreamEvent>) -> Result<Value, HarnessError> {
            let _ = events.send(StreamEvent::Token { text: "hey".to_string() });
            let _ = events.send(StreamEvent::ToolCallStarted { id: "c1".to_string(), name: "read".to_string() });
            Ok(self.0.lock().unwrap().remove(0))
        }
    }

    fn reply(message: Value) -> Value {
        serde_json::json!({ "choices": [{ "message": message, "finish_reason": "stop" }] })
    }

    #[tokio::test]
    async fn a_plain_answer_passes_through_and_the_probe_stays_quiet() {
        let model = Scripted(Mutex::new(vec![reply(serde_json::json!({ "role": "assistant", "content": "Hello!" }))]));
        let probe = FastProbe::new(&model);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let out = probe.invoke(&serde_json::json!({}), &tx).await.expect("answer");
        assert_eq!(out["choices"][0]["message"]["content"], "Hello!");
        assert!(!probe.missed());
        drop(tx);
        let mut seen = Vec::new();
        while let Some(e) = rx.recv().await {
            seen.push(e);
        }
        assert!(seen.iter().any(|e| matches!(e, StreamEvent::Token { .. })), "text still streams");
        assert!(!seen.iter().any(is_tool_event), "a tool-call stream never reaches the UI from the fast attempt");
    }

    #[tokio::test]
    async fn abandoned_attempt_events_are_not_forwarded() {
        let call = serde_json::json!({ "id": "c1", "type": "function", "function": { "name": "read", "arguments": "{}" } });
        let model = Scripted(Mutex::new(vec![reply(serde_json::json!({ "role": "assistant", "content": null, "tool_calls": [call] }))]));
        let probe = FastProbe::new(&model);
        let (tx, mut rx) = mpsc::unbounded_channel();
        assert!(probe.invoke(&serde_json::json!({}), &tx).await.is_err());
        assert!(probe.missed());
        drop(tx);
        assert!(rx.recv().await.is_none(), "the abandoned attempt's tokens leaked to the UI");
    }

    struct Chatty;

    #[async_trait]
    impl ModelInvoker for Chatty {
        async fn invoke(&self, _request: &Value, events: &mpsc::UnboundedSender<StreamEvent>) -> Result<Value, HarnessError> {
            for t in ["a", "b", "c"] {
                let _ = events.send(StreamEvent::Token { text: t.to_string() });
            }
            Ok(reply(serde_json::json!({ "role": "assistant", "content": "abc" })))
        }
    }

    #[tokio::test]
    async fn plain_answer_events_flushed_in_order() {
        let probe = FastProbe::new(&Chatty);
        let (tx, mut rx) = mpsc::unbounded_channel();
        probe.invoke(&serde_json::json!({}), &tx).await.expect("answer");
        drop(tx);
        let mut text = String::new();
        while let Some(e) = rx.recv().await {
            if let StreamEvent::Token { text: t } = e {
                text.push_str(&t);
            }
        }
        assert_eq!(text, "abc");
    }

    #[tokio::test]
    async fn a_tool_call_abandons_the_attempt_before_anything_could_run() {
        let call = serde_json::json!({ "id": "c1", "type": "function", "function": { "name": "read", "arguments": "{}" } });
        let model = Scripted(Mutex::new(vec![reply(serde_json::json!({ "role": "assistant", "content": null, "tool_calls": [call] }))]));
        let probe = FastProbe::new(&model);
        let (tx, _rx) = mpsc::unbounded_channel();
        let out = probe.invoke(&serde_json::json!({}), &tx).await;
        assert!(out.is_err());
        assert!(probe.missed());
    }

    #[test]
    fn an_empty_tool_call_array_is_not_a_tool_call() {
        assert!(!asks_for_tool(&reply(serde_json::json!({ "content": "x", "tool_calls": [] }))));
        assert!(!asks_for_tool(&serde_json::json!({})));
    }
}
