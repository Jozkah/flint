# Generated from protocol/rpc-schema.json by packages/agent-sdk/scripts/generate.mjs.
# Do not edit by hand: run `node packages/agent-sdk/scripts/generate.mjs` after
# changing the Rust dispatcher, and commit the regenerated output with it.

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict, Union

PROTOCOL_VERSION = 1

#: The JSON-RPC methods this protocol accepts, in schema order.
RPC_METHODS: tuple[str, ...] = (
    "initialize",
    "session/list",
    "session/start",
    "session/resume",
    "session/fork",
    "session/archive",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "permission/respond",
    "tool/respond",
    "session/tools/get",
    "session/tools/set",
    "session/model/set",
    "session/reset",
)

#: The ``type`` tag of an event, which is also its ``item/<tag>`` method name.
EVENT_TAGS: tuple[str, ...] = (
    "prompt_snapshot",
    "request_provenance",
    "token",
    "reasoning",
    "step",
    "tool_call_started",
    "tool_call_args_delta",
    "tool_call",
    "tool_output_delta",
    "tool_result",
    "run_resources",
    "subagent_start",
    "subagent_queued",
    "subagent_end",
    "subagent",
    "messages_updated",
    "ask_request",
    "ask_resolved",
    "todo_update",
    "turn_usage",
    "done",
    "error",
    "permission_request",
    "tool_request",
    "tool_request_cancelled",
    "tool_details",
)

RpcMethod = Literal[
    "initialize",
    "session/list",
    "session/start",
    "session/resume",
    "session/fork",
    "session/archive",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "permission/respond",
    "tool/respond",
    "session/tools/get",
    "session/tools/set",
    "session/model/set",
    "session/reset",
]

EventTag = Literal[
    "prompt_snapshot",
    "request_provenance",
    "token",
    "reasoning",
    "step",
    "tool_call_started",
    "tool_call_args_delta",
    "tool_call",
    "tool_output_delta",
    "tool_result",
    "run_resources",
    "subagent_start",
    "subagent_queued",
    "subagent_end",
    "subagent",
    "messages_updated",
    "ask_request",
    "ask_resolved",
    "todo_update",
    "turn_usage",
    "done",
    "error",
    "permission_request",
    "tool_request",
    "tool_request_cancelled",
    "tool_details",
]

# -------------------------------------------------------------------------
# Shared definitions
# -------------------------------------------------------------------------

class AskRequest(TypedDict):
    questions: list[Question]

class ClientInfo(TypedDict):
    name: str
    version: str

# What a host says a tool does, which decides how the loop treats it. Absent means opaque: prompted unless `auto_approve`, sequential, withheld in Plan mode -- the plugin/MCP default.
HostCapability = Union[Literal["read"], Literal["actuator"]]

# The declaration shape, for the document only: the dispatcher parses the real `HostToolDecl`, which lives outside this module and carries no schema.
class HostToolDeclSchema(TypedDict):
    name: str
    description: NotRequired[str]
    # JSON Schema for the arguments, advertised to the model verbatim.
    parameters: NotRequired[Union[dict[str, Any], None]]
    capability: NotRequired[Union[HostCapability, None]]

# One contiguous change: lines removed from the base and lines put in their place. Line numbers are 1-based, against the base and against the full proposal respectively.
class Hunk(TypedDict):
    # Position in [`StagedPatch::hunks`], and the id a selection names.
    index: int
    oldStart: int
    oldLen: int
    newStart: int
    newLen: int
    removed: list[str]
    added: list[str]

class OptionItem(TypedDict):
    label: str
    description: NotRequired[Union[str, None]]

# What a client receives: the hunks and the base they were computed against.
class PatchView(TypedDict):
    base: str
    hunks: list[Hunk]

# Who gates host tool calls. `jan` prompts through `permission_request` the way any opaque tool is prompted; `host` means the host's own callback is the gate, so Jan never asks about a host tool.
PermissionOwner = Literal["jan", "host"]

# One image in an outbound request, as [`StreamEvent::RequestProvenance`] reports it: identity, not content.
class ProvenanceImage(TypedDict):
    # SHA-256 over the image's decoded bytes (over the URL text for a remote image, which has no bytes here).
    sha256: str
    mime_type: str
    # Decoded length in bytes.
    bytes: int
    # The tool call whose result carried it, when one did. `None` for an image the user attached.
    tool_call_id: NotRequired[Union[str, None]]

class Question(TypedDict):
    id: str
    question: str
    options: list[OptionItem]
    multi: NotRequired[bool]
    recommended: NotRequired[Union[int, None]]

# What a whole run's commands used.
class RunResources(TypedDict):
    # Commands the run started.
    commands: int
    # Of those, how many were measured.
    measuredCommands: int
    # CPU time across the measured commands, in milliseconds.
    cpuMs: int
    # The highest peak of any one measured command, in bytes. Commands can overlap, so this is a floor on the run's peak, not a sum.
    peakMemoryBytes: int
    # Processes across the measured commands.
    processes: int
    # Why some were not measured, when some were not.
    unmeasuredReason: NotRequired[Union[str, None]]

class TodoItem(TypedDict):
    content: str
    status: TodoStatus

class TodoList(TypedDict):
    phases: list[TodoPhase]

class TodoPhase(TypedDict):
    name: str
    tasks: list[TodoItem]

TodoStatus = Literal["pending", "in_progress", "completed", "abandoned"]

# A host tool's answer: text, or OpenAI content parts (`text` / `image_url` with a base64 `data:` URL) under the same caps as a user message.
ToolResultContent = Union[str, list[Any]]

class Usage(TypedDict):
    prompt_tokens: NotRequired[Union[int, None]]
    completion_tokens: NotRequired[Union[int, None]]
    total_tokens: NotRequired[Union[int, None]]
    # Prompt tokens the provider read from its cache (`prompt_tokens_details.cached_tokens`). `None` when the provider did not say, which is not the same as nothing having been cached.
    cached_prompt_tokens: NotRequired[Union[int, None]]
    # Prompt tokens written to the provider's cache. Part of the prompt total, never added to it again.
    cache_write_tokens: NotRequired[Union[int, None]]

# -------------------------------------------------------------------------
# Request parameters, one type per Rust params struct
# -------------------------------------------------------------------------

class InitializeParams(TypedDict):
    """`initialize`"""

    protocolVersion: int
    clientInfo: ClientInfo
    capabilities: NotRequired[Any]

class SessionListParams(TypedDict):
    """`session/list`"""
    pass

class SessionStartParams(TypedDict):
    """`session/start`"""

    cwd: str
    model: NotRequired[Union[str, None]]
    ephemeral: NotRequired[bool]
    # Host tools this session may call. Kept as raw values until declaration so a malformed entry is reported as `invalid_tools` with the reason, rather than as a generic params error that names nothing.
    tools: NotRequired[list[HostToolDeclSchema]]
    # `false` advertises only the host tools: no built-ins, MCP, plugin, `ask`, `todo`, subagent or monitor tools.
    builtins: NotRequired[bool]
    permissions: NotRequired[PermissionOwner]

class SessionIdParams(TypedDict):
    """`session/resume`, `session/fork`, `session/archive`, `turn/interrupt`, `session/tools/get`, `session/reset`"""

    sessionId: str

class TurnStartParams(TypedDict):
    """`turn/start`"""

    sessionId: str
    input: Any

class TurnSteerParams(TypedDict):
    """`turn/steer`"""

    sessionId: str
    input: str

class PermissionResponseParams(TypedDict):
    """`permission/respond`"""

    requestId: str
    decision: str

class ToolRespondParams(TypedDict):
    """`tool/respond`"""

    requestId: str
    content: ToolResultContent
    isError: NotRequired[bool]
    # Host/UI-only data, echoed as `item/tool_details` and never sent to the model.
    details: NotRequired[Union[dict[str, Any], None]]

class SessionToolsSetParams(TypedDict):
    """`session/tools/set`"""

    sessionId: str
    tools: list[HostToolDeclSchema]

class SessionModelSetParams(TypedDict):
    """`session/model/set`"""

    sessionId: str
    model: str

# -------------------------------------------------------------------------
# Events: the payload of an ``item/<tag>`` notification
# -------------------------------------------------------------------------

class PromptSnapshotEvent(TypedDict):
    """`item/prompt_snapshot`"""

    id: str
    hash: str
    redactions: int
    type: Literal["prompt_snapshot"]

class RequestProvenanceEvent(TypedDict):
    """`item/request_provenance`"""

    # The run that made the request (the same id its prompt snapshot and invocation records carry).
    run_id: NotRequired[Union[str, None]]
    # The session the request belongs to, when the run has one.
    session_id: NotRequired[Union[str, None]]
    # The configured provider the model resolved to, when known.
    provider: NotRequired[Union[str, None]]
    # The model id the upstream receives, without a `<provider>/` prefix.
    model: str
    # The wire API the request is built for (`anthropic`, `google`, `openai-responses`), absent for chat/completions.
    api_type: NotRequired[Union[str, None]]
    # SHA-256 of the request body as Jan built it.
    request_sha256: str
    body_bytes: int
    # SHA-256 of the `tools` array as sent, able to change while the model id does not.
    tools_sha256: NotRequired[Union[str, None]]
    # Every image in the body, in order, hashed over its decoded bytes.
    images: NotRequired[list[ProvenanceImage]]
    type: Literal["request_provenance"]

class TokenEvent(TypedDict):
    """`item/token`"""

    text: str
    type: Literal["token"]

class ReasoningEvent(TypedDict):
    """`item/reasoning`"""

    text: str
    type: Literal["reasoning"]

class StepEvent(TypedDict):
    """`item/step`"""

    index: int
    max: int
    type: Literal["step"]

class ToolCallStartedEvent(TypedDict):
    """`item/tool_call_started`"""

    id: str
    name: str
    type: Literal["tool_call_started"]

class ToolCallArgsDeltaEvent(TypedDict):
    """`item/tool_call_args_delta`"""

    id: str
    delta: str
    type: Literal["tool_call_args_delta"]

class ToolCallEvent(TypedDict):
    """`item/tool_call`"""

    id: str
    name: str
    args: Any
    type: Literal["tool_call"]

class ToolOutputDeltaEvent(TypedDict):
    """`item/tool_output_delta`"""

    id: str
    delta: str
    type: Literal["tool_output_delta"]

class ToolResultEvent(TypedDict):
    """`item/tool_result`"""

    id: str
    content: str
    is_error: bool
    diff: NotRequired[Union[str, None]]
    type: Literal["tool_result"]

class RunResourcesEvent(TypedDict):
    """`item/run_resources`"""

    resources: RunResources
    type: Literal["run_resources"]

class SubagentStartEvent(TypedDict):
    """`item/subagent_start`"""

    run_id: str
    name: str
    # The task the child was dispatched with -- its sole user message. Carried on the event rather than left for consumers to correlate back to the `dispatch_subagent` call: two dispatches can share a `subagent_name`, so matching on name alone is ambiguous.
    task: NotRequired[Union[str, None]]
    type: Literal["subagent_start"]

class SubagentQueuedEvent(TypedDict):
    """`item/subagent_queued`"""

    run_id: str
    name: str
    task: NotRequired[Union[str, None]]
    waiting: int
    type: Literal["subagent_queued"]

class SubagentEndEvent(TypedDict):
    """`item/subagent_end`"""

    run_id: str
    name: str
    type: Literal["subagent_end"]

class SubagentEvent(TypedDict):
    """`item/subagent`"""

    run_id: str
    name: str
    event: Any
    type: Literal["subagent"]

class MessagesUpdatedEvent(TypedDict):
    """`item/messages_updated`"""

    messages: list[Any]
    type: Literal["messages_updated"]

class AskRequestEvent(TypedDict):
    """`item/ask_request`"""

    request_id: str
    request: AskRequest
    timeout_secs: NotRequired[Union[int, None]]
    type: Literal["ask_request"]

class AskResolvedEvent(TypedDict):
    """`item/ask_resolved`"""

    request_id: str
    type: Literal["ask_resolved"]

class TodoUpdateEvent(TypedDict):
    """`item/todo_update`"""

    list: TodoList
    type: Literal["todo_update"]

class TurnUsageEvent(TypedDict):
    """`item/turn_usage`"""

    usage: Usage
    # The provider's id for the execution that produced this usage, when it reported one. This is the handle a per-request billing lookup is keyed by. A sibling of `usage` rather than a field inside it, because it is a billing handle and not a token count. Absent on the default upstream path, which cannot see the response headers (see [`crate::core::agent::correlation`]).
    execution_id: NotRequired[Union[str, None]]
    type: Literal["turn_usage"]

class DoneEvent(TypedDict):
    """`item/done`"""

    stop_reason: str
    usage: NotRequired[Union[Usage, None]]
    type: Literal["done"]

class ErrorEvent(TypedDict):
    """`item/error`"""

    code: str
    message: str
    type: Literal["error"]

class PermissionRequestEvent(TypedDict):
    """`item/permission_request`"""

    request_id: str
    tool_name: str
    capability: str
    path: NotRequired[Union[str, None]]
    # The shell command for exec prompts (drives the command-scoped "allow always" grant); `None` for non-exec tools.
    command: NotRequired[Union[str, None]]
    # Focused diff preview for `write`/`edit` prompts so the user sees the change before approving; `None` for other tools.
    diff: NotRequired[Union[str, None]]
    # The same change as reviewable hunks, with the base it was computed against. AH-146. The text diff above is for reading; this is for a client that wants to present, or decide on, one hunk at a time.
    patch: NotRequired[Union[PatchView, None]]
    prompt_kind: str
    offers_always: bool
    # Why this call is being asked about when a grant or auto-approval would otherwise have let it run: a destructive shell command, or the check-in after a long streak of auto-approved calls. `None` for an ordinary prompt.
    reason: NotRequired[Union[str, None]]
    type: Literal["permission_request"]

class ToolRequestEvent(TypedDict):
    """`item/tool_request`"""

    request_id: str
    tool_name: str
    # The arguments the model produced, already parsed from the call's JSON string. Validated against nothing here -- the host owns the schema it declared and is the only party that can enforce it.
    args: Any
    # Which run raised the request: `None` for the main run, the child's run id for a subagent. Attribution only -- the host answers by `request_id` alone, and a child's request is emitted unwrapped at the top level so the same answer path serves both.
    run_id: NotRequired[Union[str, None]]
    type: Literal["tool_request"]

class ToolRequestCancelledEvent(TypedDict):
    """`item/tool_request_cancelled`"""

    request_id: str
    reason: str
    type: Literal["tool_request_cancelled"]

class ToolDetailsEvent(TypedDict):
    """`item/tool_details`"""

    id: str
    details: Any
    type: Literal["tool_details"]

#: Every event a session may report, discriminated on ``type``.
StreamEvent = Union[
    PromptSnapshotEvent,
    RequestProvenanceEvent,
    TokenEvent,
    ReasoningEvent,
    StepEvent,
    ToolCallStartedEvent,
    ToolCallArgsDeltaEvent,
    ToolCallEvent,
    ToolOutputDeltaEvent,
    ToolResultEvent,
    RunResourcesEvent,
    SubagentStartEvent,
    SubagentQueuedEvent,
    SubagentEndEvent,
    SubagentEvent,
    MessagesUpdatedEvent,
    AskRequestEvent,
    AskResolvedEvent,
    TodoUpdateEvent,
    TurnUsageEvent,
    DoneEvent,
    ErrorEvent,
    PermissionRequestEvent,
    ToolRequestEvent,
    ToolRequestCancelledEvent,
    ToolDetailsEvent,
]
