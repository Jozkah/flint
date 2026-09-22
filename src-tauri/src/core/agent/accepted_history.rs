//! The canonical accepted conversation history, kept apart from the provider
//! request projection.
//!
//! Flint's agent loop historically carried one `Vec<Value>` that did three jobs
//! at once: the wire request, the record to persist, and the thing compaction
//! and provider retries rewrote. That coupling is what let a transient,
//! request-only edit (a changed system prompt, a per-turn reminder, a reasoning
//! opt-out for one provider) leak into the durable record, and what made
//! compaction destroy earlier history instead of standing in for it.
//!
//! This module splits the two jobs without replacing Flint's loop, compaction,
//! session, or MCP logic:
//!
//! ```text
//!   AcceptedHistory (append-only)   the record: durable turns + accepted
//!        |                          guidance + compaction summaries
//!        | project(&Projection)     pure: same record + same options => same bytes
//!        v
//!   Vec<Value> (the wire request)   placed prompt + history + transient blocks
//! ```
//!
//! Rules:
//!
//! - **The record is append-only and durable.** It holds user/assistant/tool
//!   messages, *accepted* guidance ([`Event::Prompt`]), and compaction
//!   summaries. It never holds a transient projection node.
//! - **Transient content is projection input, never recorded.** The per-turn
//!   volatile system block and request-only reminders live on [`Projection`],
//!   so they cannot enter the persisted or public history.
//! - **`project` is pure.** Two calls over an unchanged record with the same
//!   options produce byte-identical output; the stable prefix is a function of
//!   the record alone, and volatile content sits strictly below it, so a
//!   changed volatile block moves only suffix bytes.
//!
//! The placement of the stable prompt (head, or appended behind the history
//! when it changed) reuses [`crate::core::agent::upstream::set_system_prompt`],
//! so the #8960 append-only guarantee holds through the projection too.

use serde_json::Value;

use crate::core::agent::compaction::is_compaction_summary;
use crate::core::agent::r#loop::strip_assistant_reasoning;
use crate::core::agent::reminder;
use crate::core::agent::upstream::{
    drop_malformed_tool_calls, drop_orphaned_tool_results, is_system_node,
    repair_dangling_tool_calls, set_system_prompt,
};

/// One durable thing that happened, in the order it happened.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Event {
    /// A wire message: a user turn, an assistant turn, a tool result, or a
    /// compaction summary (which is history under the `system` role).
    Message(Value),
    /// Accepted stable guidance. The first one is the request's head; a later,
    /// changed one is appended behind the history so bytes an earlier request
    /// already sent are left alone.
    Prompt(String),
}

/// The canonical record of a session.
#[derive(Debug, Clone, Default)]
pub(crate) struct AcceptedHistory {
    events: Vec<Event>,
}

/// What the wire needs that the record deliberately does not hold.
#[derive(Debug, Clone, Default)]
pub(crate) struct Projection<'a> {
    /// The per-turn volatile system block (today's date, query-specific memory
    /// recall, plan/todo state). Placed in its slot below the accepted prefix
    /// and replaced when it changes; never recorded.
    pub volatile_system: Option<&'a str>,
    /// Request-only reminders folded into the trailing message. Transient, so
    /// they never enter the record.
    pub reminders: &'a [String],
    /// Resend prior assistant turns' `reasoning_content`. `false` is a provider
    /// capability answer, not a fact about the conversation, so it belongs here
    /// rather than in the record.
    pub send_reasoning: bool,
}

impl<'a> Projection<'a> {
    /// The projection used to persist/replay the durable record: no transient
    /// blocks, reasoning kept.
    pub(crate) fn persisted() -> Self {
        Self {
            volatile_system: None,
            reminders: &[],
            send_reasoning: true,
        }
    }
}

impl AcceptedHistory {
    /// Adopt a history that came from outside (a stored thread or a request
    /// body). This is the one place the record heals, so it only ever holds
    /// turns a strict upstream accepts:
    ///
    /// - a tool call left with unparsable arguments is dropped with its result
    ///   ([`drop_malformed_tool_calls`]);
    /// - a tool result whose call is not in the history is dropped
    ///   ([`drop_orphaned_tool_results`]);
    /// - a surviving call that lost its result gets the synthetic error reply
    ///   ([`repair_dangling_tool_calls`]).
    ///
    /// A stable system prompt is read back as an [`Event::Prompt`] so the
    /// projection places it exactly as the live list did; a compaction summary
    /// is history and stays a [`Event::Message`].
    pub(crate) fn from_history(mut messages: Vec<Value>) -> Self {
        let poisoned = drop_malformed_tool_calls(&mut messages);
        if poisoned > 0 {
            log::warn!("agent: dropped {poisoned} unusable tool call(s) from history");
        }
        let orphaned = drop_orphaned_tool_results(&mut messages);
        if orphaned > 0 {
            log::warn!("agent: dropped {orphaned} tool result(s) whose call is not in the history");
        }
        let repaired = repair_dangling_tool_calls(&mut messages);
        if repaired > 0 {
            log::warn!("agent: repaired {repaired} dangling tool call(s) with no prior result");
        }

        let events = messages
            .into_iter()
            .map(|message| {
                if is_system_node(&message) && !is_compaction_summary(&message) {
                    match message.get("content").and_then(|c| c.as_str()) {
                        Some(text) => Event::Prompt(text.to_string()),
                        None => Event::Message(message),
                    }
                } else {
                    Event::Message(message)
                }
            })
            .collect();
        Self { events }
    }

    /// Project the record onto a wire request. Pure: it borrows `&self` and
    /// never mutates the record.
    ///
    /// Layout: `[stable prompt] [messages] [changed guidance] [volatile block]`,
    /// with request-only reminders folded into the trailing message. The stable
    /// prompt and any changed guidance are placed by
    /// [`set_system_prompt`], so the prefix stays byte-identical when unchanged
    /// and a changed prompt only appends.
    pub(crate) fn project(&self, opts: &Projection) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::with_capacity(self.events.len() + 2);
        let mut prompts: Vec<&str> = Vec::new();

        // 1. Durable messages, in order; a stable prompt read back is collected
        //    for placement rather than emitted inline.
        for event in &self.events {
            match event {
                Event::Message(message) => out.push(message.clone()),
                Event::Prompt(text) => prompts.push(text.as_str()),
            }
        }

        // 2. Reasoning opt-out: a per-provider capability, applied to the
        //    projection only.
        if !opts.send_reasoning {
            out = strip_assistant_reasoning(&out);
        }

        // 3. Place accepted guidance. The first stable prompt is the head; a
        //    later, changed one is appended behind the bytes already sent by
        //    `set_system_prompt` (an unchanged one is a no-op). The head is
        //    inserted explicitly rather than through `set_system_prompt`, whose
        //    append-on-change rule would otherwise place it *after* a leading
        //    compaction summary instead of at index 0.
        let mut prompts = prompts.into_iter();
        if let Some(head) = prompts.next() {
            out.insert(0, serde_json::json!({ "role": "system", "content": head }));
        }
        for text in prompts {
            set_system_prompt(&mut out, text);
        }

        // 4. The volatile block sits strictly below the accepted prefix, so a
        //    change to it moves only suffix bytes.
        if let Some(volatile) = opts.volatile_system {
            out.push(serde_json::json!({ "role": "system", "content": volatile }));
        }

        // 5. Request-only reminders fold into the trailing message.
        for reminder_text in opts.reminders {
            reminder::attach(&mut out, reminder_text);
        }

        out
    }

    /// The durable projection to persist or replay: no transient blocks.
    pub(crate) fn project_persisted(&self) -> Vec<Value> {
        self.project(&Projection::persisted())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> Value {
        json!({ "role": "user", "content": text })
    }
    fn assistant(text: &str) -> Value {
        json!({ "role": "assistant", "content": text })
    }
    fn system(text: &str) -> Value {
        json!({ "role": "system", "content": text })
    }
    fn bytes(messages: &[Value]) -> String {
        serde_json::to_string(messages).unwrap()
    }
    fn roles(messages: &[Value]) -> Vec<&str> {
        messages
            .iter()
            .map(|m| m["role"].as_str().unwrap_or(""))
            .collect()
    }

    fn sample() -> AcceptedHistory {
        AcceptedHistory::from_history(vec![system("SYS"), user("hi"), assistant("hello")])
    }

    /// Projecting must never mutate the record.
    #[test]
    fn canonical_history_unchanged_after_projection() {
        let h = sample();
        let before = h.clone();
        let _ = h.project(&Projection {
            volatile_system: Some("today is friday"),
            reminders: &["ping".to_string()],
            send_reasoning: true,
        });
        let _ = h.project_persisted();
        assert_eq!(h.events, before.events);
    }

    /// A changed volatile block changes only the suffix; the stable prefix is
    /// byte-identical.
    #[test]
    fn changed_volatile_guidance_changes_only_suffix_bytes() {
        let h = sample();
        let a = h.project(&Projection {
            volatile_system: Some("date: mon"),
            reminders: &[],
            send_reasoning: true,
        });
        let b = h.project(&Projection {
            volatile_system: Some("date: tue"),
            reminders: &[],
            send_reasoning: true,
        });
        // Same length, same leading messages; only the trailing volatile differs.
        assert_eq!(a.len(), b.len());
        assert_eq!(bytes(&a[..a.len() - 1]), bytes(&b[..b.len() - 1]));
        assert_ne!(a.last().unwrap(), b.last().unwrap());
        assert_eq!(a.last().unwrap()["content"], "date: mon");
    }

    /// The stable prefix is byte-identical across turns that only append below.
    #[test]
    fn stable_prefix_is_byte_identical_across_turns() {
        let h = sample();
        let turn1 = h.project(&Projection {
            volatile_system: Some("v1"),
            reminders: &[],
            send_reasoning: true,
        });
        // A new turn arrives: the user speaks again (same accepted prefix).
        let h2 = AcceptedHistory::from_history(vec![
            system("SYS"),
            user("hi"),
            assistant("hello"),
            user("again"),
        ]);
        let turn2 = h2.project(&Projection {
            volatile_system: Some("v2"),
            reminders: &[],
            send_reasoning: true,
        });
        // turn1 without its volatile tail is a byte-identical prefix of turn2.
        let prefix1 = bytes(&turn1[..turn1.len() - 1]);
        let prefix2 = bytes(&turn2[..turn1.len() - 1]);
        assert_eq!(prefix1, prefix2);
    }

    /// Accepted guidance recorded in a prior session is read back on resume and
    /// placed at the head.
    #[test]
    fn accepted_guidance_retained_after_resume() {
        let persisted = sample().project_persisted();
        // A client stores and resends exactly that.
        let resumed = AcceptedHistory::from_history(persisted);
        let projected = resumed.project_persisted();
        assert_eq!(projected[0]["role"], "system");
        assert_eq!(projected[0]["content"], "SYS");
        assert_eq!(roles(&projected), ["system", "user", "assistant"]);
    }

    /// Transient guidance never enters the persisted history, even across a
    /// resume.
    #[test]
    fn transient_guidance_absent_from_persisted_history() {
        let h = sample();
        // A live turn carries a volatile block and a reminder.
        let _live = h.project(&Projection {
            volatile_system: Some("VOLATILE-SECRET"),
            reminders: &["REMINDER-SECRET".to_string()],
            send_reasoning: true,
        });
        // What gets persisted is the durable projection, and re-adopting it
        // must not resurrect the transient nodes.
        let persisted = h.project_persisted();
        let round_trip = AcceptedHistory::from_history(persisted).project_persisted();
        let text = bytes(&round_trip);
        assert!(!text.contains("VOLATILE-SECRET"), "{text}");
        assert!(!text.contains("REMINDER-SECRET"), "{text}");
    }

    /// A compaction summary is history under the `system` role: it stays, and a
    /// later prompt change lands behind it rather than deleting it.
    #[test]
    fn compaction_summary_retained_on_next_turn() {
        let summary = json!({
            "role": "system",
            "content": "[Summary of earlier conversation, condensed to save context]\n\nX did Y."
        });
        // History carrying the original prompt, a compaction summary, a turn,
        // and a changed prompt appended behind it (as #8982 would persist it).
        let h = AcceptedHistory::from_history(vec![
            system("SYS"),
            summary.clone(),
            user("continue"),
            system("SYS v2"),
        ]);

        let projected = h.project_persisted();
        assert!(
            projected.iter().any(|m| m == &summary),
            "summary must survive: {projected:?}"
        );
        // Head is the original prompt; the change is appended behind history.
        assert_eq!(projected[0]["content"], "SYS");
        assert_eq!(projected.last().unwrap()["content"], "SYS v2");
    }

    /// Adopting history repairs a tool call whose result was lost, so the pair
    /// is intact on the wire.
    #[test]
    fn tool_call_result_pairing_is_restored() {
        let history = vec![
            user("run it"),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "bash", "arguments": "{}" }
                }]
            }),
            // No matching tool result for call_1.
        ];
        let projected = AcceptedHistory::from_history(history).project_persisted();
        let tool = projected
            .iter()
            .find(|m| m["role"] == "tool")
            .expect("a synthetic tool result was inserted");
        assert_eq!(tool["tool_call_id"], "call_1");
    }

    /// A tool result whose call is not in the history is dropped on adoption.
    #[test]
    fn orphaned_tool_result_is_removed() {
        let history = vec![
            user("hi"),
            json!({ "role": "tool", "tool_call_id": "ghost", "content": "stale" }),
        ];
        let projected = AcceptedHistory::from_history(history).project_persisted();
        assert!(
            !projected.iter().any(|m| m["role"] == "tool"),
            "orphan tool result must be dropped: {projected:?}"
        );
    }

    /// `send_reasoning: false` strips prior reasoning from the projection but
    /// leaves the record intact.
    #[test]
    fn reasoning_opt_out_is_projection_only() {
        let h = AcceptedHistory::from_history(vec![
            system("SYS"),
            json!({
                "role": "assistant",
                "content": "answer",
                "reasoning_content": "SECRET-THOUGHT"
            }),
        ]);
        let stripped = bytes(&h.project(&Projection {
            volatile_system: None,
            reminders: &[],
            send_reasoning: false,
        }));
        assert!(!stripped.contains("SECRET-THOUGHT"), "{stripped}");
        // The record still has it (a later provider may accept it).
        let kept = bytes(&h.project_persisted());
        assert!(kept.contains("SECRET-THOUGHT"), "{kept}");
    }

    /// The projection carries no Anthropic-only fields; a generic
    /// OpenAI-compatible provider receives none. (Flint applies prompt caching
    /// via byte-stable prefixes, never `cache_control` blocks.)
    #[test]
    fn projection_has_no_anthropic_only_fields() {
        let h = sample();
        let text = bytes(&h.project(&Projection {
            volatile_system: Some("v"),
            reminders: &["r".to_string()],
            send_reasoning: true,
        }));
        assert!(!text.contains("cache_control"), "{text}");
    }

    /// An unchanged prompt across a repeated projection produces no second
    /// system node (the #8982 append-only guarantee, through the projection).
    #[test]
    fn an_unchanged_prompt_is_not_duplicated() {
        // Two identical stable prompts in the adopted history must collapse to
        // a single system node in the projection.
        let h = AcceptedHistory::from_history(vec![
            system("SYS"),
            user("hi"),
            assistant("hello"),
            system("SYS"),
        ]);
        let projected = h.project_persisted();
        let system_nodes = projected.iter().filter(|m| m["role"] == "system").count();
        assert_eq!(system_nodes, 1, "{projected:?}");
    }
}
