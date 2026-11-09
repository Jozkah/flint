//! The subagent tools as the model sees them: their schemas, the parsing of
//! their arguments, the texts they answer with, and the forked history a
//! child starts from. Pure functions of their inputs; the running of children
//! stays in the parent module.

use std::path::{Path, PathBuf};

use super::*;

/// The model-callable subagent tools, handled by the loop's tool invoker ahead
/// of the built-in fs/exec gate and the MCP fallback.
pub fn is_subagent_tool(name: &str) -> bool {
    matches!(
        name,
        "dispatch_subagent"
            | "await_subagent"
            | "create_subagent"
            | "list_subagents"
            | "list_subagent_runs"
            | "cancel_subagent"
            | "consensus"
    )
}

/// `list_subagent_runs`, for the model: this run's dispatched children and
/// where each one is.
pub(crate) fn format_subagent_runs(runs: &[SubagentRunInfo]) -> String {
    if runs.is_empty() {
        return "No background subagents are waiting to be collected in this run.".to_string();
    }
    let mut out = String::from("Background subagents in this run (oldest first):");
    for run in runs {
        out.push_str(&format!(
            "\n- {} [{}] {}, {}s: {}",
            run.run_id,
            run.name,
            run.state.as_str(),
            run.elapsed_ms / 1000,
            run.description.chars().take(160).collect::<String>()
        ));
    }
    out
}

/// `cancel_subagent`, for the model: exactly what the cancel did.
pub(crate) fn format_subagent_cancel(run_id: &str, outcome: SubagentCancelOutcome) -> String {
    match outcome {
        SubagentCancelOutcome::CancelledQueued => format!(
            "Cancelled {run_id} before it started; it will not run. await_subagent on it returns Cancelled."
        ),
        SubagentCancelOutcome::CancelledRunning => format!(
            "Cancelled {run_id}; it was stopped mid-run and its partial work is discarded. await_subagent on it returns Cancelled."
        ),
        SubagentCancelOutcome::AlreadyFinished => format!(
            "{run_id} had already finished, so nothing was cancelled. Collect its result with await_subagent."
        ),
        SubagentCancelOutcome::AlreadyCancelled => {
            format!("{run_id} was already cancelled; nothing more to do.")
        }
        SubagentCancelOutcome::Unknown => {
            format!("ERROR: unknown or already-collected subagent run '{run_id}'")
        }
    }
}

/// One-line "name [scope]: description" per definition; shadowed user-scope
/// entries are listed alongside their project-scope shadows.
pub fn format_subagent_list(registry: &SubagentRegistry) -> String {
    let defs = registry.list();
    if defs.is_empty() {
        return "No subagents are configured in the user or project scope.".to_string();
    }
    let mut lines = Vec::with_capacity(defs.len());
    for d in defs {
        let scope = match d.scope {
            SubagentScope::User => "user",
            SubagentScope::Project => "project",
            SubagentScope::Plugin => "plugin",
            SubagentScope::Builtin => "built-in",
        };
        lines.push(format!("{} [{}]: {}", d.name, scope, d.description));
    }
    lines.join("\n")
}

/// What `dispatch_subagent` tells the model. Written to steer behaviour, not
/// just to document arguments: when to delegate, how to brief, that several
/// calls in one message run together, when not to, and that the user never sees
/// the child's output. Kept short enough for a small local model (see
/// `dispatch_description_stays_compact`).
pub(super) fn dispatch_description(registry: &SubagentRegistry, max_parallel: u32) -> String {
    let saved: Vec<&str> = {
        let mut names: Vec<&str> = registry
            .list()
            .iter()
            .filter(|d| d.scope != SubagentScope::Builtin)
            .map(|d| d.name.as_str())
            .collect();
        names.sort_unstable();
        names.dedup();
        names
    };
    let mut out = format!(
        "Hand a self-contained job to a subagent: a nested agent with its own context and tools. \
It cannot see this chat, so `description` must be a complete brief: the goal, the files or names involved, and what to report back.\n\
Delegate when: a search or investigation is open-ended and needs many reads or rounds; the work splits into independent parts that can run in parallel; the output would be large and you only need the conclusion; or a role below fits.\n\
Do not delegate: a lookup you can do in one or two tool calls, a file or symbol you already know, or work another subagent is already doing.\n\
Runs in the BACKGROUND and returns a run_id at once. Several dispatch_subagent calls in one message run concurrently (up to {max_parallel}; extras queue); then call await_subagent for each run_id. \
The user does not see the subagent's output: read it and tell them what matters.\n\
Roles: {}.",
        crate::core::agent::roles::role_menu()
    );
    if !saved.is_empty() {
        out.push_str(&format!(" Saved: {}.", saved.join(", ")));
    }
    out.push_str(" For a one-off, give a descriptive subagent_name and a system_prompt.");
    out
}

/// Tools a child never gets whatever its allowlist says: it cannot dispatch
/// (nesting is capped at one) and has no `ask` client or todo list of its own.
pub(super) fn never_delegated(name: &str) -> bool {
    is_subagent_tool(name) || matches!(name, "ask" | "todo")
}

/// Pin every `allowed_tools` array in the subagent schemas to the tools this
/// run can actually hand a child, as a JSON-schema `enum`.
///
/// Left free-form, models filled the optional array with names that match
/// nothing (`bash`, `search`, `read_file`), which silently narrowed the child
/// to the forced skill tools. With the names fixed a strict provider cannot
/// emit a stray one, and every other provider is at least shown the set.
/// `offered` is the run's final tool array, so MCP, plugin and host tools are
/// included. The names are sorted and derived from per-run inputs alone, so
/// the array stays byte-identical across the run's turns (prompt cache).
pub fn constrain_tool_names(offered: &mut [serde_json::Value]) {
    let mut names: Vec<String> = offered
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .filter(|n| !never_delegated(n))
        .map(str::to_string)
        .collect();
    names.sort_unstable();
    names.dedup();
    for tool in offered.iter_mut() {
        let name = tool["function"]["name"].as_str().unwrap_or_default();
        if !matches!(name, "dispatch_subagent" | "create_subagent") {
            continue;
        }
        let Some(properties) = tool["function"]["parameters"]["properties"].as_object_mut()
        else {
            continue;
        };
        // Nothing to hand a child: an empty `enum` is invalid JSON Schema that
        // some providers reject, failing every request, so the field is
        // dropped and a child simply inherits the (empty) set.
        if names.is_empty() {
            properties.remove("allowed_tools");
        } else if let Some(items) = properties
            .get_mut("allowed_tools")
            .and_then(|field| field.get_mut("items"))
        {
            items["enum"] = serde_json::json!(names);
        }
    }
}

/// OpenAI tool schemas for the subagent tools. The dispatch tool's description
/// lists the roles and saved subagents so the model can pick one without a
/// separate discovery call.
pub fn subagent_tool_schemas(
    registry: &SubagentRegistry,
    max_parallel: u32,
) -> Vec<serde_json::Value> {
    use serde_json::json;
    let dispatch_desc = dispatch_description(registry, max_parallel);
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "dispatch_subagent",
                "description": dispatch_desc,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "A short name for this errand, 3-6 words, shown on its row (for example 'Map the lexer')." },
                        "subagent_name": { "type": "string", "description": "Name of a saved subagent to run. For a one-off (no saved definition), pick a short descriptive name here AND pass system_prompt in the same call -- an unrecognized name with no system_prompt fails." },
                        "description": { "type": "string", "description": "The task for the subagent, as its sole user message. Include everything it needs; it does not see this conversation." },
                        "system_prompt": { "type": "string", "description": "Required alongside subagent_name whenever that name isn't already saved -- defines the one-off subagent's role. Omit only when subagent_name matches a saved subagent." },
                        "allowed_tools": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Tool allowlist. For a saved subagent this further narrows its own allowed_tools (never widens); for a one-off it is the subagent's toolset."
                        },
                        "isolate": { "type": "boolean", "description": "Whether the subagent works in a checkout of its own. Default: yes when the project is a git repository and the subagent can change files, so concurrent subagents never edit the same tree. Its changes then wait for the user's review instead of landing in the project. Pass false only for work that must change the project directly." },
                        "durable": { "type": "boolean", "description": "Whether the subagent runs as a job of its own that keeps running if this app or process exits, and can be awaited, listed or cancelled later by its run_id -- including after a restart. Default: false, a background task inside this run. Pass true for long work that should survive an interruption. It cannot fork this conversation." },
                        "fork_context": { "type": "boolean", "description": "Whether the subagent starts from a copy of this conversation instead of from the task alone. Default: false, a clean brief, which is cheaper and usually clearer. Pass true only when the task cannot be understood without what was already discussed here; the subagent then receives a copy of the recent messages, and nothing it says comes back into this conversation." },
                        "max_turns": { "type": "integer", "minimum": 1, "description": "Most model turns the subagent may take before it is stopped without an answer. Default 60; raise it only for genuinely long work." },
                        "continue_run_id": { "type": "string", "description": "The run_id of a subagent of yours that already finished, to send it a follow-up instead of starting over: it resumes with its own earlier conversation, and `description` is your next message to it. Repeat its subagent_name. Only a subagent you dispatched yourself, that did not work in a checkout of its own, and whose conversation is still kept (the last 8) can be continued. The follow-up runs as a new subagent with a new run_id." }
                    },
                    "required": ["subagent_name", "description"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "await_subagent",
                "description": "Block until a backgrounded subagent (started by dispatch_subagent) finishes, and return its final answer. Pass the run_id that dispatch_subagent returned. Each run_id can be awaited once. If the answer comes back shortened, call again with the same run_id and an offset to read the omitted part.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "run_id": { "type": "string", "description": "The run_id returned by dispatch_subagent." },
                        "offset": { "type": "integer", "minimum": 0, "description": "Only for an answer that came back shortened: the character to continue reading from." }
                    },
                    "required": ["run_id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "create_subagent",
                "description": "Author a new reusable subagent definition. Writes to the project scope by default (shareable with collaborators); use scope 'user' for a personal one reusable across projects (this requires user approval).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Subagent name: letters, digits, '-' and '_' only." },
                        "description": { "type": "string", "description": "One line describing what the subagent is for." },
                        "system_prompt": { "type": "string", "description": "The subagent's full system prompt." },
                        "allowed_tools": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Optional default tool allowlist for the subagent."
                        },
                        "scope": { "type": "string", "enum": ["user", "project"], "description": "Where to store it (default 'project')." },
                        "overwrite": { "type": "boolean", "description": "Replace an existing same-name definition in that scope (default false)." }
                    },
                    "required": ["name", "description", "system_prompt"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_subagents",
                "description": "List the subagents available to dispatch, with their scope (user or project) and description. No arguments.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_subagent_runs",
                "description": "List the subagents this run has dispatched and not yet collected, with each one's run_id and state (queued, running, finished, cancelled). Does not wait and does not collect. No arguments.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "cancel_subagent",
                "description": "Cancel one background subagent by run_id, leaving the others running. A queued one never starts; a running one is stopped and its partial work discarded. A finished one is left alone. await_subagent on a cancelled run returns Cancelled.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "run_id": { "type": "string", "description": "The run_id dispatch_subagent returned." }
                    },
                    "required": ["run_id"]
                }
            }
        }),
        // AH-112: a decision that needs agreement from several independent
        // read-only reviewers, by a stated quorum, kept for later.
        json!({
            "type": "function",
            "function": {
                "name": "consensus",
                "description": "Put a decision to several independent read-only reviewers and decide it by a quorum, instead of deciding alone. Each reviewer (explorer, planner, reviewer, security, or a saved read-only subagent) investigates separately, never sees the others' answers, and must answer VERDICT: approve or VERDICT: reject; an answer without that line is not counted and is never an approval. The outcome is approved, rejected or undecided, and the whole gate is recorded -- call again with just `id` to read an earlier gate back, including after a restart.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "The decision to make, as a question the reviewers can answer yes or no." },
                        "context": { "type": "string", "description": "What the reviewers need to know: the change, the files, the risk." },
                        "reviewers": { "type": "array", "items": { "type": "string" }, "description": "Two to seven different read-only reviewers." },
                        "quorum": { "type": "string", "description": "all (default), majority, or a number of approvals." },
                        "id": { "type": "string", "description": "Read back an earlier gate instead of deciding a new one." }
                    },
                    "required": []
                }
            }
        }),
    ]
}

pub(super) fn required_str(args: &serde_json::Value, key: &str) -> Result<String, SubagentError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| SubagentError::Upstream(format!("missing required argument '{key}'")))
}

pub(super) fn optional_tool_list(args: &serde_json::Value) -> Option<Vec<String>> {
    args.get("allowed_tools")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
}

/// Parse a `dispatch_subagent` tool-call argument object.
pub fn parse_dispatch_args(args: &serde_json::Value) -> Result<SubagentRequest, SubagentError> {
    Ok(SubagentRequest {
        title: clean_title(args.get("title").and_then(|v| v.as_str())),
        subagent_name: required_str(args, "subagent_name")?,
        description: required_str(args, "description")?,
        allowed_tools: optional_tool_list(args),
        system_prompt: args
            .get("system_prompt")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty()),
        // Only a real boolean is a choice; anything else is the default.
        isolate: args.get("isolate").and_then(|v| v.as_bool()),
        fork_context: args
            .get("fork_context")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        durable: args
            .get("durable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        // A positive whole number is a choice; anything else (absent, zero,
        // negative, a string) takes the default rather than failing the call.
        max_turns: args
            .get("max_turns")
            .and_then(|v| v.as_u64())
            .filter(|n| *n > 0)
            .map(|n| n.min(u64::from(u32::MAX)) as u32),
        continue_from: args
            .get("continue_run_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

/// The most messages and characters a fork carries.
///
/// A fork is a copy, and a copy of an hour-long conversation is an expensive
/// thing to hand a child that was asked one question. The most recent
/// exchanges are what the task usually depends on, so the tail is what is
/// kept, and the child is told plainly that it is a tail rather than the whole
/// conversation.
pub const MAX_FORK_MESSAGES: usize = 40;
pub const MAX_FORK_CHARS: usize = 96 * 1024;

/// The parent's conversation, as a child should receive it (AH-100).
///
/// Copied, never shared: what the child then says happens in its own history
/// and reaches the parent only as the result it returns. Tool calls are kept
/// with their results -- a call whose result was dropped would read as a tool
/// that never answered, which is the shape a model imitates.
pub fn forked_history(parent: &[serde_json::Value], task: &str) -> Vec<serde_json::Value> {
    let mut kept: Vec<serde_json::Value> = Vec::new();
    let mut chars = 0usize;
    // The parent's system prompt stays with the parent. The child has its own,
    // which is the whole reason it is a different agent; carrying the parent's
    // as well would tell the child to be two things at once.
    let parent: Vec<&serde_json::Value> = parent
        .iter()
        .filter(|m| m.get("role").and_then(|v| v.as_str()) != Some("system"))
        .collect();
    let mut cut = false;
    for message in parent.iter().rev() {
        let size = serde_json::to_string(*message)
            .map(|s| s.len())
            .unwrap_or(0);
        if kept.len() >= MAX_FORK_MESSAGES || chars + size > MAX_FORK_CHARS {
            cut = true;
            break;
        }
        chars += size;
        kept.push((*message).clone());
    }
    kept.reverse();
    // A `tool` message whose call is no longer here has nothing to answer, and
    // a provider rejects it outright; drop the orphans rather than send a
    // history that cannot be replayed.
    let call_ids: std::collections::BTreeSet<String> = kept
        .iter()
        .filter_map(|m| m.get("tool_calls").and_then(|v| v.as_array()))
        .flatten()
        .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    kept.retain(|m| {
        if m.get("role").and_then(|v| v.as_str()) != Some("tool") {
            return true;
        }
        m.get("tool_call_id")
            .and_then(|v| v.as_str())
            .is_some_and(|id| call_ids.contains(id))
    });
    // The other half of the same invariant, and the one the dispatching turn
    // always trips: the assistant message carrying this very `dispatch_subagent`
    // call has no result yet, because the result is what the child is about to
    // produce. An assistant message whose tool calls are unanswered is rejected
    // just as firmly as an orphan result, so the unanswered calls are dropped,
    // and an assistant message left with nothing at all goes with them.
    let answered: std::collections::BTreeSet<String> = kept
        .iter()
        .filter(|m| m.get("role").and_then(|v| v.as_str()) == Some("tool"))
        .filter_map(|m| {
            m.get("tool_call_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect();
    for message in kept.iter_mut() {
        let Some(calls) = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
        else {
            continue;
        };
        let live: Vec<serde_json::Value> = calls
            .into_iter()
            .filter(|c| {
                c.get("id")
                    .and_then(|v| v.as_str())
                    .is_some_and(|id| answered.contains(id))
            })
            .collect();
        // Only an object can have carried `tool_calls`.
        let Some(object) = message.as_object_mut() else {
            continue;
        };
        if live.is_empty() {
            object.remove("tool_calls");
        } else {
            object.insert("tool_calls".to_string(), serde_json::Value::Array(live));
        }
    }
    kept.retain(|m| {
        if m.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            return true;
        }
        let has_calls = m.get("tool_calls").is_some();
        let has_text = m
            .get("content")
            .and_then(|v| v.as_str())
            .is_some_and(|t| !t.trim().is_empty());
        has_calls || has_text
    });
    // Only a real cut is announced. Dropping the parent's system prompt, or the
    // dispatch call the child is the answer to, removes nothing the child could
    // have used, and a note saying otherwise would be a claim that is not true.
    let truncated = cut;
    let mut out = Vec::with_capacity(kept.len() + 2);
    if truncated {
        out.push(serde_json::json!({
            "role": "user",
            "content": "What follows is the most recent part of another conversation, copied \
                        here so you have its context. It is not the whole of it, and it is a \
                        copy: nothing you say goes back into it.",
        }));
    }
    out.extend(kept);
    out.push(serde_json::json!({ "role": "user", "content": task }));
    out
}

/// Parse an `await_subagent` tool-call argument object, returning the run_id.
pub fn parse_await_args(args: &serde_json::Value) -> Result<String, SubagentError> {
    required_str(args, "run_id")
}

/// The `offset` of an `await_subagent` call that is reading the rest of a
/// shortened answer, if it gave one.
pub fn parse_await_offset(args: &serde_json::Value) -> Option<usize> {
    args.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize)
}

/// Parse a `create_subagent` tool-call argument object into a definition plus
/// its target scope and the overwrite flag.
pub fn parse_create_args(
    args: &serde_json::Value,
) -> Result<(SubagentDefinition, SubagentScope, bool), SubagentError> {
    let name = required_str(args, "name")?;
    let description = required_str(args, "description")?;
    let system_prompt = required_str(args, "system_prompt")?;
    let scope = match args.get("scope").and_then(|v| v.as_str()) {
        Some("user") => SubagentScope::User,
        Some("project") | None => SubagentScope::Project,
        Some(other) => {
            return Err(SubagentError::Upstream(format!(
                "invalid scope '{other}': use 'user' or 'project'"
            )))
        }
    };
    let overwrite = args
        .get("overwrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok((
        SubagentDefinition {
            name,
            description,
            system_prompt,
            allowed_tools: optional_tool_list(args),
            model: args.get("model").and_then(|v| v.as_str()).map(String::from),
            auto_compact_window: None,
            extras: Default::default(),
            scope,
        },
        scope,
        overwrite,
    ))
}

/// The directory a scope writes to for this project. User scope needs a
/// resolvable home directory.
pub fn subagent_dir_for(
    project_root: &Path,
    scope: SubagentScope,
) -> Result<PathBuf, SubagentError> {
    match scope {
        SubagentScope::Project => Ok(project_subagents_dir(project_root)),
        SubagentScope::User => user_subagents_dir().ok_or_else(|| {
            SubagentError::Upstream("cannot resolve home directory for user scope".to_string())
        }),
        SubagentScope::Plugin => Err(SubagentError::Upstream(
            "plugin scope is read-only: plugin agents are managed via plugin install/remove"
                .to_string(),
        )),
        SubagentScope::Builtin => Err(SubagentError::PermissionDenied(
            "built-in roles are read-only; save a definition of the same name to replace one"
                .to_string(),
        )),
    }
}
