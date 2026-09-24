//! Stream events emitted by the agent orchestration loop. Deliberately
//! Tauri-free: CLI/TUI consume these directly and `tauri-plugin-agent` bridges
//! them to a `tauri::ipc::Channel`. The loop emits per-token `Token` deltas
//! (the upstream call streams via SSE) plus per-step progress and one terminal
//! `Done`/`Error`.

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// A snapshot of the exact payload that was just dispatched. AH-078.
    ///
    /// Carries the identity and the hash, never the payload: the activity
    /// timeline links to the record rather than embedding a copy that could
    /// drift from it, and the redaction count tells a reader that something was
    /// removed without saying what.
    PromptSnapshot {
        id: String,
        hash: String,
        redactions: usize,
    },
    /// A streamed content delta from the model.
    Token { text: String },
    /// A streamed reasoning delta, carried natively when the upstream exposes
    /// it as a dedicated field (`reasoning_content`). Display-only: reasoning
    /// never joins the assistant `content` that is resent as history, and it
    /// must never leak into piped stdout. Providers that instead inline
    /// `<think>` tags in `content` stream those through [`Token`]; consumers
    /// fall back to stripping the tags manually.
    Reasoning { text: String },
    /// A new orchestration turn began (`index` is 1-based; `max` is the turn
    /// cap, `0` when the run is unbounded, which is the normal case).
    Step { index: u32, max: u32 },
    /// A tool call started streaming: emitted mid-stream the instant the model's
    /// tool-call `id` and `name` are known, before its arguments finish
    /// streaming. Lets a consumer show an in-progress indicator during the
    /// (potentially long) argument-streaming window; the full [`ToolCall`] with
    /// parsed `args` follows once the completion is assembled.
    ToolCallStarted { id: String, name: String },
    /// A chunk of a tool call's raw JSON arguments, exactly as it arrived on the
    /// wire. Emitted between [`ToolCallStarted`] and [`ToolCall`] so a consumer
    /// can render the arguments as they land -- the difference between a
    /// featureless spinner and a live preview while a large `write` streams.
    ///
    /// Deltas, not the accumulated buffer: re-sending the whole prefix on every
    /// chunk is quadratic in a file-sized argument. Consumers concatenate.
    /// The result is *incomplete JSON* until [`ToolCall`] arrives; parse it
    /// leniently or not at all.
    ToolCallArgsDelta { id: String, delta: String },
    /// The model requested a tool call. `args` is the parsed argument object
    /// (null if the model emitted non-JSON arguments).
    ToolCall {
        id: String,
        name: String,
        args: serde_json::Value,
    },
    /// A chunk of a tool's output, as it is produced. Emitted between
    /// [`ToolCall`] and [`ToolResult`] so a consumer can show a command's output
    /// while it runs instead of only once it exits.
    ///
    /// Deltas, not the accumulated buffer, for the same reason as
    /// [`ToolCallArgsDelta`]: resending the prefix on every chunk is quadratic in
    /// the output size. Chunks are raw fragments and may split a line.
    ///
    /// Keeps arriving after a `bash` call has backgrounded itself and returned a
    /// `job_id`, so a long-running job reports progress under the id of the call
    /// that started it.
    ToolOutputDelta { id: String, delta: String },
    /// A tool finished. `is_error` reflects the upstream "ERROR" encoding.
    /// `diff` is display-only focused-change text (line-prefixed `-`/`+`) for
    /// `write`/`edit`; `None` for other tools.
    ToolResult {
        id: String,
        content: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
    },
    /// What the commands a run started used, sent once as it ends (AH-174).
    RunResources {
        resources: tauri_plugin_agent_tools::resources::RunResources,
    },
    /// A backgrounded subagent run began. `run_id` identifies the run so a
    /// consumer can attribute concurrent children; brackets the child's wrapped
    /// events with `SubagentEnd`.
    SubagentStart {
        run_id: String,
        name: String,
        /// The task the child was dispatched with -- its sole user message.
        /// Carried on the event rather than left for consumers to correlate
        /// back to the `dispatch_subagent` call: two dispatches can share a
        /// `subagent_name`, so matching on name alone is ambiguous.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
    },
    /// A backgrounded subagent dispatch found the parent run's concurrency cap
    /// (`max_parallel_subagents`) exhausted and queued the child in FIFO order.
    /// `waiting` is the child's 1-based position in the queue (1 = next to
    /// start). The child's `SubagentStart` follows once a slot frees; a queued
    /// child aborted at parent teardown is closed by `SubagentEnd` like any
    /// other.
    SubagentQueued {
        run_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        waiting: u32,
    },
    /// A backgrounded subagent run finished (success or error). Pairs with the
    /// `SubagentStart` of the same `run_id`.
    SubagentEnd { run_id: String, name: String },
    /// A backgrounded subagent's own internal event, tagged with its run so a
    /// consumer can attribute it to the right child even when several run
    /// concurrently. `event` is a non-terminal child event (Token/Step/ToolCall/
    /// ToolResult/PermissionRequest); the child's terminal Done/Error is never
    /// wrapped (its result is delivered via `await_subagent`).
    Subagent {
        run_id: String,
        name: String,
        event: Box<StreamEvent>,
    },
    /// The loop's compaction reduced the conversation while retrying a
    /// context overflow. The client should replace its session history with
    /// `messages` for subsequent turns.
    MessagesUpdated { messages: Vec<serde_json::Value> },
    /// The `ask` tool is waiting for structured interactive input. Carries the
    /// `ask_timeout_secs` deadline (seconds until the loop auto-selects the
    /// recommended option) as `timeout_secs`, or `None` when no timeout is
    /// configured. It travels on the event so a client can render a countdown
    /// without re-reading config: the same value both arms the loop's timer and
    /// drives the display, keeping the two in agreement.
    AskRequest {
        request_id: String,
        request: crate::core::agent::interaction::AskRequest,
        timeout_secs: Option<u64>,
    },
    /// An `ask` request the loop resolved without a user answer (it timed out
    /// and auto-selected). Tells a client showing the live prompt for
    /// `request_id` to dismiss it, since no `respond` from that client is
    /// coming. User-driven answers never emit this: the client clears its own
    /// prompt as it responds.
    AskResolved { request_id: String },
    /// The canonical todo list changed (tool mutation or user edit in the
    /// TUI). Carries the full resulting snapshot for reconstruction.
    TodoUpdate {
        list: crate::core::agent::todo::TodoList,
    },
    /// Token usage for a single upstream request, emitted as soon as that
    /// request completes rather than waiting for the run to finish.
    ///
    /// `Done` carries only the *last* request's usage, which is too late and
    /// too little for a live display: a turn that calls tools makes many
    /// requests, and a subagent never emits `Done` into the parent stream at
    /// all. Consumers accumulate these to show context pressure, output
    /// volume, and throughput while the work is still happening -- for the
    /// parent run and, via the [`Subagent`] bracket, for each child.
    TurnUsage {
        usage: Usage,
        /// The provider's id for the execution that produced this usage, when
        /// it reported one. This is the handle a per-request billing lookup is
        /// keyed by. A sibling of `usage` rather than a field inside it, because
        /// it is a billing handle and not a token count. Absent on the default
        /// upstream path, which cannot see the response headers (see
        /// [`crate::core::agent::correlation`]).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_id: Option<String>,
    },
    /// Terminal success: the model returned a final (tool-free) completion.
    Done {
        stop_reason: String,
        usage: Option<Usage>,
    },
    /// Terminal failure (setup error, upstream/tool failure, or max_turns).
    Error { code: String, message: String },
    /// The loop needs the user to approve a gated tool call. The client replies via
    /// the `agent_permission_respond` command referencing `request_id`.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        capability: String,
        path: Option<String>,
        /// The shell command for exec prompts (drives the command-scoped
        /// "allow always" grant); `None` for non-exec tools.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        /// Focused diff preview for `write`/`edit` prompts so the user sees the
        /// change before approving; `None` for other tools.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
        /// The same change as reviewable hunks, with the base it was computed
        /// against. AH-146. The text diff above is for reading; this is for a
        /// client that wants to present, or decide on, one hunk at a time.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        patch: Option<tauri_plugin_agent_tools::patch::PatchView>,
        prompt_kind: String,
        offers_always: bool,
        /// Why this call is being asked about when a grant or auto-approval
        /// would otherwise have let it run: a destructive shell command, or the
        /// check-in after a long streak of auto-approved calls. `None` for an
        /// ordinary prompt.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// If `path` targets a file in the agent's skill or memory workspace, return the
/// kind (`"skill"`/`"memory"`) and the item name (file stem). None otherwise.
fn classify_agent_path(path: &str) -> Option<(&'static str, String)> {
    let norm = path.replace('\\', "/");
    for (needle, kind) in [
        (".jan/agent/skills/", "skill"),
        (".jan/agent/memory/", "memory"),
    ] {
        if let Some(idx) = norm.find(needle) {
            let rest = &norm[idx + needle.len()..];
            if rest.is_empty() || rest.ends_with('/') {
                return Some((kind, String::new()));
            }
            let stem = std::path::Path::new(rest)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(rest);
            return Some((kind, stem.to_string()));
        }
    }
    None
}

/// Human-facing one-line status for a tool call. Reads/writes of skill or memory
/// files get a semantic label (e.g. "Reading skill: deploy", "Updating memory:
/// decisions") instead of the raw tool name + path. Everything else falls back
/// to `name` + compact args.
pub fn describe_tool_call(name: &str, args: &serde_json::Value) -> String {
    // Dedicated skill/memory tools are self-describing via their name + `name` arg.
    let dedicated = match name {
        "memory_list" => Some(("Reading", "memory", String::new())),
        "skill_list" => Some(("Reading", "skill", String::new())),
        "memory_read" => Some(("Reading", "memory", arg_name(args))),
        "memory_write" => Some(("Updating", "memory", arg_name(args))),
        "skill_read" => Some(("Reading", "skill", arg_name(args))),
        "skill_write" => Some(("Updating", "skill", arg_name(args))),
        _ => None,
    };
    // Fallback: generic read/write/edit hitting the workspace by path.
    let labelled = dedicated.or_else(|| {
        args.get("path")
            .and_then(|v| v.as_str())
            .and_then(classify_agent_path)
            .map(|(kind, item)| {
                let verb = if matches!(name, "write" | "edit") {
                    "Updating"
                } else {
                    "Reading"
                };
                (verb, kind, item)
            })
    });
    if let Some((verb, kind, item)) = labelled {
        return if item.is_empty() {
            let plural = if kind == "memory" {
                "memory notes"
            } else {
                "skills"
            };
            format!("{verb} {plural}")
        } else {
            format!("{verb} {kind}: {item}")
        };
    }
    format!("{name} {args}")
}

fn arg_name(args: &serde_json::Value) -> String {
    args.get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().trim_end_matches(".md").to_string())
        .unwrap_or_default()
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Usage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    /// Prompt tokens the provider read from its cache
    /// (`prompt_tokens_details.cached_tokens`). `None` when the provider did
    /// not say, which is not the same as nothing having been cached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_prompt_tokens: Option<u64>,
    /// Prompt tokens written to the provider's cache. Part of the prompt
    /// total, never added to it again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

impl Usage {
    pub(crate) fn from_completion(completion: &serde_json::Value) -> Option<Self> {
        let usage = completion.get("usage")?;
        let details = usage.get("prompt_tokens_details");
        Some(Self {
            prompt_tokens: usage.get("prompt_tokens").and_then(|v| v.as_u64()),
            completion_tokens: usage.get("completion_tokens").and_then(|v| v.as_u64()),
            total_tokens: usage.get("total_tokens").and_then(|v| v.as_u64()),
            cached_prompt_tokens: details
                .and_then(|d| d.get("cached_tokens"))
                .and_then(|v| v.as_u64()),
            // Anthropic's name, as the server converter and OpenAI-shaped
            // proxies in front of Anthropic pass it through.
            cache_write_tokens: usage
                .get("cache_creation_input_tokens")
                .or_else(|| details.and_then(|d| d.get("cache_creation_tokens")))
                .and_then(|v| v.as_u64()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn token_serializes_with_snake_case_tag() {
        let v = serde_json::to_value(StreamEvent::Token { text: "hi".into() }).unwrap();
        assert_eq!(v, json!({ "type": "token", "text": "hi" }));
    }

    #[test]
    fn reasoning_serializes_with_snake_case_tag() {
        let v = serde_json::to_value(StreamEvent::Reasoning { text: "hmm".into() }).unwrap();
        assert_eq!(v, json!({ "type": "reasoning", "text": "hmm" }));
    }

    #[test]
    fn step_serializes_with_snake_case_tag() {
        let v = serde_json::to_value(StreamEvent::Step { index: 1, max: 8 }).unwrap();
        assert_eq!(v, json!({ "type": "step", "index": 1, "max": 8 }));
    }

    #[test]
    fn describe_labels_dedicated_skill_and_memory_tools() {
        assert_eq!(
            describe_tool_call("memory_write", &json!({"name": "decisions"})),
            "Updating memory: decisions"
        );
        assert_eq!(
            describe_tool_call("memory_read", &json!({"name": "drift.md"})),
            "Reading memory: drift"
        );
        assert_eq!(
            describe_tool_call("skill_write", &json!({"name": "deploy"})),
            "Updating skill: deploy"
        );
        assert_eq!(
            describe_tool_call("memory_list", &json!({})),
            "Reading memory notes"
        );
        assert_eq!(
            describe_tool_call("skill_list", &json!({})),
            "Reading skills"
        );
    }

    #[test]
    fn describe_labels_fallback_path_ops() {
        assert_eq!(
            describe_tool_call("read", &json!({"path": ".jan/agent/skills/deploy.md"})),
            "Reading skill: deploy"
        );
        assert_eq!(
            describe_tool_call("write", &json!({"path": ".jan/agent/memory/decisions.md"})),
            "Updating memory: decisions"
        );
    }

    #[test]
    fn describe_falls_back_for_non_workspace_calls() {
        assert_eq!(
            describe_tool_call("read", &json!({"path": "src/main.rs"})),
            "read {\"path\":\"src/main.rs\"}"
        );
        assert_eq!(
            describe_tool_call("search", &json!({"q": "rust"})),
            "search {\"q\":\"rust\"}"
        );
    }

    #[test]
    fn tool_call_started_serializes_to_wire_shape() {
        let v = serde_json::to_value(StreamEvent::ToolCallStarted {
            id: "c1".into(),
            name: "write".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            json!({ "type": "tool_call_started", "id": "c1", "name": "write" })
        );
    }

    #[test]
    fn tool_call_and_result_serialize_to_wire_shape() {
        let call = serde_json::to_value(StreamEvent::ToolCall {
            id: "c1".into(),
            name: "search".into(),
            args: json!({ "q": "rust" }),
        })
        .unwrap();
        assert_eq!(
            call,
            json!({ "type": "tool_call", "id": "c1", "name": "search", "args": { "q": "rust" } })
        );

        let result = serde_json::to_value(StreamEvent::ToolResult {
            id: "c1".into(),
            content: "ok".into(),
            is_error: false,
            diff: None,
        })
        .unwrap();
        assert_eq!(
            result,
            json!({ "type": "tool_result", "id": "c1", "content": "ok", "is_error": false })
        );
    }

    #[test]
    fn done_and_error_serialize_to_wire_shape() {
        let done = serde_json::to_value(StreamEvent::Done {
            stop_reason: "stop".into(),
            usage: None,
        })
        .unwrap();
        assert_eq!(
            done,
            json!({ "type": "done", "stop_reason": "stop", "usage": null })
        );

        let err = serde_json::to_value(StreamEvent::Error {
            code: "error".into(),
            message: "boom".into(),
        })
        .unwrap();
        assert_eq!(
            err,
            json!({ "type": "error", "code": "error", "message": "boom" })
        );
    }

    #[test]
    fn permission_request_serializes_to_wire_shape() {
        let v = serde_json::to_value(StreamEvent::PermissionRequest {
            request_id: "perm-1".into(),
            tool_name: "write".into(),
            capability: "write".into(),
            path: Some("out.txt".into()),
            command: None,
            diff: Some("@@ created file @@\n+ hi".into()),
            patch: None,
            prompt_kind: "write".into(),
            offers_always: true,
            reason: None,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({
                "type": "permission_request",
                "request_id": "perm-1",
                "tool_name": "write",
                "capability": "write",
                "path": "out.txt",
                "diff": "@@ created file @@\n+ hi",
                "prompt_kind": "write",
                "offers_always": true
            })
        );
    }

    #[test]
    fn subagent_bracket_events_serialize_to_wire_shape() {
        let start = serde_json::to_value(StreamEvent::SubagentStart {
            run_id: "sub-1".into(),
            name: "rust-reviewer".into(),
            task: None,
        })
        .unwrap();
        assert_eq!(
            start,
            json!({ "type": "subagent_start", "run_id": "sub-1", "name": "rust-reviewer" })
        );
        let queued = serde_json::to_value(StreamEvent::SubagentQueued {
            run_id: "sub-2".into(),
            name: "rust-reviewer".into(),
            task: None,
            waiting: 2,
        })
        .unwrap();
        assert_eq!(
            queued,
            json!({
                "type": "subagent_queued",
                "run_id": "sub-2",
                "name": "rust-reviewer",
                "waiting": 2
            })
        );
        let end = serde_json::to_value(StreamEvent::SubagentEnd {
            run_id: "sub-1".into(),
            name: "rust-reviewer".into(),
        })
        .unwrap();
        assert_eq!(
            end,
            json!({ "type": "subagent_end", "run_id": "sub-1", "name": "rust-reviewer" })
        );
    }

    #[test]
    fn wrapped_subagent_event_nests_inner_event() {
        let v = serde_json::to_value(StreamEvent::Subagent {
            run_id: "sub-1".into(),
            name: "reviewer".into(),
            event: Box::new(StreamEvent::Token { text: "hi".into() }),
        })
        .unwrap();
        assert_eq!(
            v,
            json!({
                "type": "subagent",
                "run_id": "sub-1",
                "name": "reviewer",
                "event": { "type": "token", "text": "hi" }
            })
        );
    }

    #[test]
    fn usage_parses_present_fields_and_none_when_absent() {
        let parsed = Usage::from_completion(&json!({
            "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15 }
        }))
        .unwrap();
        assert_eq!(parsed.prompt_tokens, Some(10));
        assert_eq!(parsed.completion_tokens, Some(5));
        assert_eq!(parsed.total_tokens, Some(15));

        assert!(Usage::from_completion(&json!({ "choices": [] })).is_none());
    }

    #[test]
    fn usage_keeps_cache_counts_only_when_reported() {
        let cached = Usage::from_completion(&json!({
            "usage": {
                "prompt_tokens": 5974, "completion_tokens": 8, "total_tokens": 5982,
                "prompt_tokens_details": { "cached_tokens": 5957 },
                "cache_creation_input_tokens": 12
            }
        }))
        .unwrap();
        assert_eq!(cached.cached_prompt_tokens, Some(5957));
        assert_eq!(cached.cache_write_tokens, Some(12));

        // A measured zero stays a zero.
        let zero = Usage::from_completion(&json!({
            "usage": { "prompt_tokens": 10, "prompt_tokens_details": { "cached_tokens": 0 } }
        }))
        .unwrap();
        assert_eq!(zero.cached_prompt_tokens, Some(0));

        // Nothing reported is nothing known, and is not serialized as zero.
        let silent = Usage::from_completion(&json!({
            "usage": { "prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11 }
        }))
        .unwrap();
        assert_eq!(silent.cached_prompt_tokens, None);
        assert_eq!(silent.cache_write_tokens, None);
        let wire = serde_json::to_value(&silent).unwrap();
        assert!(wire.get("cached_prompt_tokens").is_none());
        assert!(wire.get("cache_write_tokens").is_none());
    }
}
