// Generated from protocol/rpc-schema.json by packages/agent-sdk/scripts/generate.mjs.
// Do not edit by hand: run `node packages/agent-sdk/scripts/generate.mjs` after
// changing the Rust dispatcher, and commit the regenerated output with it.

export declare const PROTOCOL_VERSION: 1

/** The JSON-RPC methods this protocol accepts, in schema order. */
export type RpcMethod =
  | "initialize"
  | "session/list"
  | "session/start"
  | "session/resume"
  | "session/fork"
  | "session/archive"
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "permission/respond"
  | "tool/respond"
  | "session/tools/get"
  | "session/tools/set"
  | "session/model/set"
  | "session/reset"

/** The `type` tag of an event, which is also its `item/<tag>` method name. */
export type EventTag =
  | "prompt_snapshot"
  | "request_provenance"
  | "token"
  | "reasoning"
  | "step"
  | "tool_call_started"
  | "tool_call_args_delta"
  | "tool_call"
  | "tool_output_delta"
  | "tool_result"
  | "run_resources"
  | "subagent_start"
  | "subagent_queued"
  | "subagent_title"
  | "subagent_end"
  | "subagent_finished"
  | "subagent"
  | "compaction"
  | "retry"
  | "messages_updated"
  | "ask_request"
  | "ask_resolved"
  | "todo_update"
  | "turn_usage"
  | "done"
  | "error"
  | "permission_request"
  | "tool_request"
  | "tool_request_cancelled"
  | "tool_details"

export declare const EVENT_TAGS: readonly EventTag[]

// ---------------------------------------------------------------------------
// Shared definitions
// ---------------------------------------------------------------------------

export interface AskRequest {
  "questions": Question[]
}

export interface ClientInfo {
  "name": string
  "version": string
}

/** Where a [`StreamEvent::Compaction`] is in its round trip. */
export type CompactionPhase = "started" | "finished" | "failed"

/** Which path asked for a [`StreamEvent::Compaction`]. */
export type CompactionReason = "preflight" | "context_overflow" | "session_budget"

/** What a host says a tool does, which decides how the loop treats it. Absent means opaque: prompted unless `auto_approve`, sequential, withheld in Plan mode -- the plugin/MCP default. */
export type HostCapability = "read" | "actuator"

/** The declaration shape, for the document only: the dispatcher parses the real `HostToolDecl`, which lives outside this module and carries no schema. */
export interface HostToolDeclSchema {
  "name": string
  "description"?: string
  /** JSON Schema for the arguments, advertised to the model verbatim. */
  "parameters"?: Record<string, unknown> | null
  "capability"?: HostCapability | null
}

/** One contiguous change: lines removed from the base and lines put in their place. Line numbers are 1-based, against the base and against the full proposal respectively. */
export interface Hunk {
  /** Position in [`StagedPatch::hunks`], and the id a selection names. */
  "index": number
  "oldStart": number
  "oldLen": number
  "newStart": number
  "newLen": number
  "removed": string[]
  "added": string[]
}

export interface OptionItem {
  "label": string
  "description"?: string | null
}

/** What a client receives: the hunks and the base they were computed against. */
export interface PatchView {
  "base": string
  "hunks": Hunk[]
}

/** Who gates host tool calls. `jan` prompts through `permission_request` the way any opaque tool is prompted; `host` means the host's own callback is the gate, so Jan never asks about a host tool. */
export type PermissionOwner = "jan" | "host"

/** One image in an outbound request, as [`StreamEvent::RequestProvenance`] reports it: identity, not content. */
export interface ProvenanceImage {
  /** SHA-256 over the image's decoded bytes (over the URL text for a remote image, which has no bytes here). */
  "sha256": string
  "mime_type": string
  /** Decoded length in bytes. */
  "bytes": number
  /** The tool call whose result carried it, when one did. `None` for an image the user attached. */
  "tool_call_id"?: string | null
}

export interface Question {
  "id": string
  "question": string
  "options": OptionItem[]
  "multi"?: boolean
  "recommended"?: number | null
}

/** What a whole run's commands used. */
export interface RunResources {
  /** Commands the run started. */
  "commands": number
  /** Of those, how many were measured. */
  "measuredCommands": number
  /** CPU time across the measured commands, in milliseconds. */
  "cpuMs": number
  /** The highest peak of any one measured command, in bytes. Commands can overlap, so this is a floor on the run's peak, not a sum. */
  "peakMemoryBytes": number
  /** Processes across the measured commands. */
  "processes": number
  /** Why some were not measured, when some were not. */
  "unmeasuredReason"?: string | null
}

export interface TodoItem {
  "content": string
  "status": TodoStatus
}

export interface TodoList {
  "phases": TodoPhase[]
}

export interface TodoPhase {
  "name": string
  "tasks": TodoItem[]
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned"

/** A host tool's answer: text, or OpenAI content parts (`text` / `image_url` with a base64 `data:` URL) under the same caps as a user message. */
export type ToolResultContent = string | unknown[]

export interface Usage {
  "prompt_tokens"?: number | null
  "completion_tokens"?: number | null
  "total_tokens"?: number | null
  /** Prompt tokens the provider read from its cache (`prompt_tokens_details.cached_tokens`). `None` when the provider did not say, which is not the same as nothing having been cached. */
  "cached_prompt_tokens"?: number | null
  /** Prompt tokens written to the provider's cache. Part of the prompt total, never added to it again. */
  "cache_write_tokens"?: number | null
}

// ---------------------------------------------------------------------------
// Request parameters, one type per Rust params struct
// ---------------------------------------------------------------------------

/** `initialize` */
export interface InitializeParams {
  "protocolVersion": number
  "clientInfo": ClientInfo
  "capabilities"?: unknown
}

/** `session/list` */
export type SessionListParams = Record<string, unknown>

/** `session/start` */
export interface SessionStartParams {
  "cwd": string
  "model"?: string | null
  "ephemeral"?: boolean
  /** Host tools this session may call. Kept as raw values until declaration so a malformed entry is reported as `invalid_tools` with the reason, rather than as a generic params error that names nothing. */
  "tools"?: HostToolDeclSchema[]
  /** `false` advertises only the host tools: no built-ins, MCP, plugin, `ask`, `todo`, subagent or monitor tools. */
  "builtins"?: boolean
  "permissions"?: PermissionOwner
}

/** `session/resume`, `session/fork`, `session/archive`, `turn/interrupt`, `session/tools/get`, `session/reset` */
export interface SessionIdParams {
  "sessionId": string
}

/** `turn/start` */
export interface TurnStartParams {
  "sessionId": string
  "input": unknown
}

/** `turn/steer` */
export interface TurnSteerParams {
  "sessionId": string
  "input": string
}

/** `permission/respond` */
export interface PermissionResponseParams {
  "requestId": string
  "decision": string
}

/** `tool/respond` */
export interface ToolRespondParams {
  "requestId": string
  "content": ToolResultContent
  "isError"?: boolean
  /** Host/UI-only data, echoed as `item/tool_details` and never sent to the model. */
  "details"?: Record<string, unknown> | null
}

/** `session/tools/set` */
export interface SessionToolsSetParams {
  "sessionId": string
  "tools": HostToolDeclSchema[]
}

/** `session/model/set` */
export interface SessionModelSetParams {
  "sessionId": string
  "model": string
}

/** The params a given method accepts, refused at compile time when they mismatch. */
export type RpcParams<M extends RpcMethod> =
  | (M extends "initialize" ? InitializeParams : never)
  | (M extends "session/list" ? SessionListParams : never)
  | (M extends "session/start" ? SessionStartParams : never)
  | (M extends "session/resume" | "session/fork" | "session/archive" | "turn/interrupt" | "session/tools/get" | "session/reset" ? SessionIdParams : never)
  | (M extends "turn/start" ? TurnStartParams : never)
  | (M extends "turn/steer" ? TurnSteerParams : never)
  | (M extends "permission/respond" ? PermissionResponseParams : never)
  | (M extends "tool/respond" ? ToolRespondParams : never)
  | (M extends "session/tools/set" ? SessionToolsSetParams : never)
  | (M extends "session/model/set" ? SessionModelSetParams : never)

// ---------------------------------------------------------------------------
// Events: the payload of an `item/<tag>` notification
// ---------------------------------------------------------------------------

/** A snapshot of the exact payload that was just dispatched. AH-078. Carries the identity and the hash, never the payload: the activity timeline links to the record rather than embedding a copy that could drift from it, and the redaction count tells a reader that something was removed without saying what. */
export interface PromptSnapshotEvent {
  "id": string
  "hash": string
  "redactions": number
  "type": "prompt_snapshot"
}

/** What the run is about to send a provider, emitted immediately before each request goes out (upstream janhq/jan#9056): identity, not content. The hashes describe the body Jan built for the adapter, so two runs can be compared field by field without copying prompts or frames around. Nothing here is model input or output: it never joins the transcript, and a consumer may render it, store it or ignore it. */
export interface RequestProvenanceEvent {
  /** The run that made the request (the same id its prompt snapshot and invocation records carry). */
  "run_id"?: string | null
  /** The session the request belongs to, when the run has one. */
  "session_id"?: string | null
  /** The configured provider the model resolved to, when known. */
  "provider"?: string | null
  /** The model id the upstream receives, without a `<provider>/` prefix. */
  "model": string
  /** The wire API the request is built for (`anthropic`, `google`, `openai-responses`), absent for chat/completions. */
  "api_type"?: string | null
  /** SHA-256 of the request body as Jan built it. */
  "request_sha256": string
  "body_bytes": number
  /** SHA-256 of the `tools` array as sent, able to change while the model id does not. */
  "tools_sha256"?: string | null
  /** Every image in the body, in order, hashed over its decoded bytes. */
  "images"?: ProvenanceImage[]
  "type": "request_provenance"
}

/** A streamed content delta from the model. */
export interface TokenEvent {
  "text": string
  "type": "token"
}

/** A streamed reasoning delta, carried natively when the upstream exposes it as a dedicated field (`reasoning_content`). Display-only: reasoning never joins the assistant `content` that is resent as history, and it must never leak into piped stdout. Providers that instead inline `<think>` tags in `content` stream those through [`Token`]; consumers fall back to stripping the tags manually. */
export interface ReasoningEvent {
  "text": string
  "type": "reasoning"
}

/** A new orchestration turn began (`index` is 1-based; `max` is the turn cap, `0` when the run is unbounded, which is the normal case). */
export interface StepEvent {
  "index": number
  "max": number
  "type": "step"
}

/** A tool call started streaming: emitted mid-stream the instant the model's tool-call `id` and `name` are known, before its arguments finish streaming. Lets a consumer show an in-progress indicator during the (potentially long) argument-streaming window; the full [`ToolCall`] with parsed `args` follows once the completion is assembled. */
export interface ToolCallStartedEvent {
  "id": string
  "name": string
  "type": "tool_call_started"
}

/** A chunk of a tool call's raw JSON arguments, exactly as it arrived on the wire. Emitted between [`ToolCallStarted`] and [`ToolCall`] so a consumer can render the arguments as they land -- the difference between a featureless spinner and a live preview while a large `write` streams. Deltas, not the accumulated buffer: re-sending the whole prefix on every chunk is quadratic in a file-sized argument. Consumers concatenate. The result is *incomplete JSON* until [`ToolCall`] arrives; parse it leniently or not at all. */
export interface ToolCallArgsDeltaEvent {
  "id": string
  "delta": string
  "type": "tool_call_args_delta"
}

/** The model requested a tool call. `args` is the parsed argument object (null if the model emitted non-JSON arguments). */
export interface ToolCallEvent {
  "id": string
  "name": string
  "args": unknown
  "type": "tool_call"
}

/** A chunk of a tool's output, as it is produced. Emitted between [`ToolCall`] and [`ToolResult`] so a consumer can show a command's output while it runs instead of only once it exits. Deltas, not the accumulated buffer, for the same reason as [`ToolCallArgsDelta`]: resending the prefix on every chunk is quadratic in the output size. Chunks are raw fragments and may split a line. Keeps arriving after a `bash` call has backgrounded itself and returned a `job_id`, so a long-running job reports progress under the id of the call that started it. */
export interface ToolOutputDeltaEvent {
  "id": string
  "delta": string
  "type": "tool_output_delta"
}

/** A tool finished. `is_error` reflects the upstream "ERROR" encoding. `diff` is display-only focused-change text (line-prefixed `-`/`+`) for `write`/`edit`; `None` for other tools. */
export interface ToolResultEvent {
  "id": string
  "content": string
  "is_error": boolean
  "diff"?: string | null
  "type": "tool_result"
}

/** What the commands a run started used, sent once as it ends (AH-174). */
export interface RunResourcesEvent {
  "resources": RunResources
  "type": "run_resources"
}

/** A backgrounded subagent run began. `run_id` identifies the run so a consumer can attribute concurrent children; brackets the child's wrapped events with `SubagentEnd`. */
export interface SubagentStartEvent {
  "run_id": string
  "name": string
  /** The task the child was dispatched with -- its sole user message. Carried on the event rather than left for consumers to correlate back to the `dispatch_subagent` call: two dispatches can share a `subagent_name`, so matching on name alone is ambiguous. */
  "task"?: string | null
  "type": "subagent_start"
}

/** A backgrounded subagent dispatch found the parent run's concurrency cap (`max_parallel_subagents`) exhausted and queued the child in FIFO order. `waiting` is the child's 1-based position in the queue (1 = next to start). The child's `SubagentStart` follows once a slot frees; a queued child aborted at parent teardown is closed by `SubagentEnd` like any other. */
export interface SubagentQueuedEvent {
  "run_id": string
  "name": string
  "task"?: string | null
  "waiting": number
  "type": "subagent_queued"
}

/** The short name the dispatch gave an errand, sent before its `SubagentQueued` or `SubagentStart`. Its own event so those keep their shape for the consumers that match them; a dispatch with no title sends none. */
export interface SubagentTitleEvent {
  "run_id": string
  "name": string
  "title": string
  "type": "subagent_title"
}

/** A backgrounded subagent run finished (success or error). Pairs with the `SubagentStart` of the same `run_id`. */
export interface SubagentEndEvent {
  "run_id": string
  "name": string
  "type": "subagent_end"
}

/** How a backgrounded subagent ended and what it cost, sent just before its `SubagentEnd`. A separate event so `SubagentEnd` keeps its shape for the consumers that match it. `status` is `done`, `error` or `turn_limit`; `usage` is the child's own token usage when the provider reported any; `detail` is a bounded one-line reason for a non-`done` ending. */
export interface SubagentFinishedEvent {
  "run_id": string
  "name": string
  "status": string
  "usage"?: unknown
  "detail"?: string | null
  "type": "subagent_finished"
}

/** A backgrounded subagent's own internal event, tagged with its run so a consumer can attribute it to the right child even when several run concurrently. `event` is a non-terminal child event (Token/Step/ToolCall/ ToolResult/PermissionRequest); the child's terminal Done/Error is never wrapped (its result is delivered via `await_subagent`). Never a `ToolRequest`: a client answers a request by `request_id` on stdin, and it is told nothing about this wrapper, so a nested request would be unanswerable. A child's host tool call is routed to the root channel unwrapped instead, attributed by `ToolRequest.run_id`. */
export interface SubagentEvent {
  "run_id": string
  "name": string
  "event": unknown
  "type": "subagent"
}

/** The loop is summarizing part of the conversation to make room. Sent as `Started` before the summarizer call and `Finished` or `Failed` after it, so a consumer can show progress for what is otherwise a silent round trip. `reason` says which path asked. `messages` is how many messages the compaction removed from the history, `None` except on `Finished`. Display-only and never journaled; the compacted history itself arrives as `MessagesUpdated`. */
export interface CompactionEvent {
  "phase": CompactionPhase
  "reason": CompactionReason
  "messages"?: number | null
  "type": "compaction"
}

/** The upstream request failed before anything streamed and is about to be sent again after `delay_ms`. `attempt` is the 1-based attempt that follows the wait, out of `max_attempts`; `reason` is the failure that prompted it. Sent once per retry so a consumer can say "retrying" rather than show a spinner that looks like a slow model. Display-only and never journaled; the turn continues with the next event or ends in `Error`. */
export interface RetryEvent {
  "attempt": number
  "max_attempts": number
  "delay_ms": number
  "reason": string
  "type": "retry"
}

/** The loop's compaction reduced the conversation while retrying a context overflow. The client should replace its session history with `messages` for subsequent turns. */
export interface MessagesUpdatedEvent {
  "messages": unknown[]
  "type": "messages_updated"
}

/** The `ask` tool is waiting for structured interactive input. Carries the `ask_timeout_secs` deadline (seconds until the loop auto-selects the recommended option) as `timeout_secs`, or `None` when no timeout is configured. It travels on the event so a client can render a countdown without re-reading config: the same value both arms the loop's timer and drives the display, keeping the two in agreement. */
export interface AskRequestEvent {
  "request_id": string
  "request": AskRequest
  "timeout_secs"?: number | null
  "type": "ask_request"
}

/** An `ask` request the loop resolved without a user answer (it timed out and auto-selected). Tells a client showing the live prompt for `request_id` to dismiss it, since no `respond` from that client is coming. User-driven answers never emit this: the client clears its own prompt as it responds. */
export interface AskResolvedEvent {
  "request_id": string
  "type": "ask_resolved"
}

/** The canonical todo list changed (tool mutation or user edit in the TUI). Carries the full resulting snapshot for reconstruction. */
export interface TodoUpdateEvent {
  "list": TodoList
  "type": "todo_update"
}

/** Token usage for a single upstream request, emitted as soon as that request completes rather than waiting for the run to finish. `Done` carries only the *last* request's usage, which is too late and too little for a live display: a turn that calls tools makes many requests, and a subagent never emits `Done` into the parent stream at all. Consumers accumulate these to show context pressure, output volume, and throughput while the work is still happening -- for the parent run and, via the [`Subagent`] bracket, for each child. */
export interface TurnUsageEvent {
  "usage": Usage
  /** The provider's id for the execution that produced this usage, when it reported one. This is the handle a per-request billing lookup is keyed by. A sibling of `usage` rather than a field inside it, because it is a billing handle and not a token count. Absent on the default upstream path, which cannot see the response headers (see [`crate::core::agent::correlation`]). */
  "execution_id"?: string | null
  "type": "turn_usage"
}

/** Terminal success: the model returned a final (tool-free) completion. */
export interface DoneEvent {
  "stop_reason": string
  "usage"?: Usage | null
  "type": "done"
}

/** Terminal failure (setup error, upstream/tool failure, or max_turns). */
export interface ErrorEvent {
  "code": string
  "message": string
  "type": "error"
}

/** The loop needs the user to approve a gated tool call. The client replies via the `agent_permission_respond` command referencing `request_id`. */
export interface PermissionRequestEvent {
  "request_id": string
  "tool_name": string
  "capability": string
  "path"?: string | null
  /** The shell command for exec prompts (drives the command-scoped "allow always" grant); `None` for non-exec tools. */
  "command"?: string | null
  /** Focused diff preview for `write`/`edit` prompts so the user sees the change before approving; `None` for other tools. */
  "diff"?: string | null
  /** The same change as reviewable hunks, with the base it was computed against. AH-146. The text diff above is for reading; this is for a client that wants to present, or decide on, one hunk at a time. */
  "patch"?: PatchView | null
  "prompt_kind": string
  "offers_always": boolean
  /** Why this call is being asked about when a grant or auto-approval would otherwise have let it run: a destructive shell command, or the check-in after a long streak of auto-approved calls. `None` for an ordinary prompt. */
  "reason"?: string | null
  "type": "permission_request"
}

/** A host-registered tool was called and the run is waiting for the host to execute it. The client replies with a `tool_result` line carrying this `request_id`; until it does, the turn is parked on this one call. `tool_name` is the name the *host* declared, not the `host__`-prefixed name the model calls: the host dispatches on the name it chose and never has to know this layer's prefixing rule. */
export interface ToolRequestEvent {
  "request_id": string
  "tool_name": string
  /** The arguments the model produced, already parsed from the call's JSON string. Validated against nothing here -- the host owns the schema it declared and is the only party that can enforce it. */
  "args": unknown
  /** Which run raised the request: `None` for the main run, the child's run id for a subagent. Attribution only -- the host answers by `request_id` alone, and a child's request is emitted unwrapped at the top level so the same answer path serves both. */
  "run_id"?: string | null
  "type": "tool_request"
}

/** A pending [`StreamEvent::ToolRequest`] was withdrawn: the host must not answer it any more, and a late answer is reported as not pending. `reason` is `aborted` | `interrupted` | `client_gone`. */
export interface ToolRequestCancelledEvent {
  "request_id": string
  "reason": string
  "type": "tool_request_cancelled"
}

/** Host/UI-only structured data a host tool returned alongside its result, emitted right after that call's [`StreamEvent::ToolResult`] (same `id`). Never sent to the model; a display may render it or ignore it. */
export interface ToolDetailsEvent {
  "id": string
  "details": unknown
  "type": "tool_details"
}

/** Every event a session may report, discriminated on `type`. */
export type StreamEvent =
  | PromptSnapshotEvent
  | RequestProvenanceEvent
  | TokenEvent
  | ReasoningEvent
  | StepEvent
  | ToolCallStartedEvent
  | ToolCallArgsDeltaEvent
  | ToolCallEvent
  | ToolOutputDeltaEvent
  | ToolResultEvent
  | RunResourcesEvent
  | SubagentStartEvent
  | SubagentQueuedEvent
  | SubagentTitleEvent
  | SubagentEndEvent
  | SubagentFinishedEvent
  | SubagentEvent
  | CompactionEvent
  | RetryEvent
  | MessagesUpdatedEvent
  | AskRequestEvent
  | AskResolvedEvent
  | TodoUpdateEvent
  | TurnUsageEvent
  | DoneEvent
  | ErrorEvent
  | PermissionRequestEvent
  | ToolRequestEvent
  | ToolRequestCancelledEvent
  | ToolDetailsEvent

/** The event a given tag carries. */
export interface EventByTag {
  "prompt_snapshot": PromptSnapshotEvent
  "request_provenance": RequestProvenanceEvent
  "token": TokenEvent
  "reasoning": ReasoningEvent
  "step": StepEvent
  "tool_call_started": ToolCallStartedEvent
  "tool_call_args_delta": ToolCallArgsDeltaEvent
  "tool_call": ToolCallEvent
  "tool_output_delta": ToolOutputDeltaEvent
  "tool_result": ToolResultEvent
  "run_resources": RunResourcesEvent
  "subagent_start": SubagentStartEvent
  "subagent_queued": SubagentQueuedEvent
  "subagent_title": SubagentTitleEvent
  "subagent_end": SubagentEndEvent
  "subagent_finished": SubagentFinishedEvent
  "subagent": SubagentEvent
  "compaction": CompactionEvent
  "retry": RetryEvent
  "messages_updated": MessagesUpdatedEvent
  "ask_request": AskRequestEvent
  "ask_resolved": AskResolvedEvent
  "todo_update": TodoUpdateEvent
  "turn_usage": TurnUsageEvent
  "done": DoneEvent
  "error": ErrorEvent
  "permission_request": PermissionRequestEvent
  "tool_request": ToolRequestEvent
  "tool_request_cancelled": ToolRequestCancelledEvent
  "tool_details": ToolDetailsEvent
}
