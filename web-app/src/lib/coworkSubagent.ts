/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  convertToModelMessages,
  streamText,
  type LanguageModel,
  type Tool,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import type { Usage } from '@/types/coworkSession'
import type { ToolActivityContext } from '@/lib/toolActivity'
import type { SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import {
  ASK_TOOL_NAME,
  TASK_TOOL_NAME,
  TEAM_TOOL_NAME,
  TODO_TOOL_NAME,
} from '@/lib/coworkTools'
import { MAX_SUBAGENT_STEPS } from '@/lib/coworkBudget'
import { BACKGROUND_TASK_TOOLS } from '@/lib/coworkBackgroundTasks'
import { SESSION_MESSAGING_TOOL_NAMES } from '@/lib/sessionMessagingTools'
import { createUsageCollector } from '@/lib/tokenUsage'
import {
  runTurn,
  type PendingToolCall,
  type StreamSink,
  type ToolOutcome,
} from '@/lib/coworkRunner'
import {
  buildSubagentSystemPrompt,
  environmentOptions,
  type CoworkEnvironmentOptions,
  type PromptFolderAccess,
} from '@/lib/coworkPrompt'
import { streamCutOff } from '@/lib/streamFinish'
import { prepareToolResultImagesForModel } from '@/lib/toolResultImages'
import type { StreamEvent } from '@/hooks/useCoworkRun'

/**
 * Nested subagent runs.
 *
 * Deliberately not routed through `CoworkChatTransport`: the transport writes
 * app-global singletons (`setCurrentStreamThreadId`, `updateLoadingModel`,
 * `updateLiveTokenStats`) that a nested run would clobber for its parent, so the
 * header would report the child's progress as the session's. This calls
 * `streamText` directly and reuses only the parent's already-created model
 * instance, so a child costs no second llama-server load.
 *
 * The cost of that reuse: llama.cpp slot params are baked in at model creation,
 * so a child prefills on the parent's slot and evicts its KV prefix, which the
 * parent then re-prefills on its next step. Fixing it means a dedicated
 * subagent slot, which is part of the still-open slot-reservation decision.
 *
 * The Rust pair `dispatch_subagent`/`await_subagent` collapses to one blocking
 * `task` call here. The SDK already emits several tool calls per step and the
 * runner dispatches them in order, so a run id to await later buys nothing.
 */

/** Concurrent children, mirroring `DEFAULT_MAX_PARALLEL_SUBAGENTS`. */
export const MAX_PARALLEL_SUBAGENTS = 3

/**
 * Longest child answer handed to the parent whole. Past this the middle is cut:
 * a child that pastes a whole listing into its final message would otherwise
 * spend the parent's context window on exactly what delegating was meant to
 * keep out of it. Mirrors `MAX_CHILD_RESULT_CHARS` in `core/agent/subagent.rs`.
 */
export const MAX_SUBAGENT_RESULT_CHARS = 14_000
/** What survives the cut: the conclusion at the start, the caveats at the end. */
export const SUBAGENT_RESULT_HEAD_CHARS = 9_000
export const SUBAGENT_RESULT_TAIL_CHARS = 3_500

/**
 * A child's final message, capped for its parent.
 *
 * A short answer comes back untouched. A long one keeps its head and tail with a
 * note saying how much was dropped. The dispatcher keeps the full text (`full`
 * on the outcome) and adds the line that says how to read the rest with
 * `await_task`, so the whole answer stays reachable without a file or a
 * permission prompt.
 */
export function capSubagentOutput(text: string): string {
  // Code points, not UTF-16 units, so a surrogate pair is never split.
  const chars = Array.from(text)
  if (chars.length <= MAX_SUBAGENT_RESULT_CHARS) return text
  const omitted =
    chars.length - SUBAGENT_RESULT_HEAD_CHARS - SUBAGENT_RESULT_TAIL_CHARS
  return (
    chars.slice(0, SUBAGENT_RESULT_HEAD_CHARS).join('') +
    `\n\n[... ${omitted} characters omitted from the middle of the subagent's answer. ` +
    '...]\n\n' +
    chars.slice(chars.length - SUBAGENT_RESULT_TAIL_CHARS).join('')
  )
}

/**
 * Always granted to a child, whatever the allowlist says.
 *
 * A skill is a procedure the child may need to follow, and a Claude-style
 * `tools:` list never names these — so a narrowed toolset must not strip them.
 * Read-side only: authoring stays with the top-level agent.
 * Ported from `subagent.rs::SUBAGENT_SKILL_TOOLS`.
 */
const SUBAGENT_SKILL_TOOLS = ['skill_list', 'skill_read']

/**
 * Never offered to a child, whatever the allowlist says.
 *
 * `task` and `team` are the depth cap: a subagent cannot spawn subagents, alone
 * or in a graph. `ask` and `todo` belong to the parent's conversation — no card
 * is rendered for a child, and the todo list is the session's, not the errand's.
 * Matches the Rust child args, which null out `ask_requests` and
 * `todo_registry`.
 *
 * Withholding is only half of it: the dispatcher refuses these by name as well,
 * because a model can emit a call to a tool that was never advertised.
 */
const WITHHELD_FROM_SUBAGENTS = new Set<string>([
  TASK_TOOL_NAME,
  TEAM_TOOL_NAME,
  ASK_TOOL_NAME,
  TODO_TOOL_NAME,
  // Managing the parent's background tasks is the parent's business.
  ...BACKGROUND_TASK_TOOLS,
  // Cross-session messaging speaks for the session, not for an errand: a child
  // must not discover, message or wait on other sessions.
  ...SESSION_MESSAGING_TOOL_NAMES,
])

export type SubagentRequest = {
  subagent_name: string
  description: string
  system_prompt?: string
  allowed_tools?: string[]
  /** The parent did not wait for this child (`task` with `background: true`). */
  background?: boolean
  /** A short name for this errand (3-6 words), shown on its row. */
  title?: string
  /** A configured model to run this child on, checked when it starts. */
  model?: string
}

export type ResolvedSubagent = {
  name: string
  systemPrompt: string
  /** `null` inherits the parent's toolset minus what is withheld. */
  allowedTools: string[] | null
  model: string | null
  /**
   * Where the definition came from. `builtin` is one of Flint's roles
   * (AH-094..099), which is what makes a change "changed by the reviewer role"
   * rather than by an agent someone named (AH-110).
   */
  scope?: SubagentDefinition['scope']
}

/**
 * The durable identity of a resolved subagent (AH-110): a role for a built-in,
 * otherwise a named agent. Renaming the display name of a saved definition
 * changes what is shown, never what past changes point at.
 */
export function subagentActorId(resolved: {
  name: string
  scope?: SubagentDefinition['scope']
}): string {
  return `${resolved.scope === 'builtin' ? 'role' : 'agent'}:${resolved.name}`
}

/** Reject a malformed `task` call rather than running an errand with no brief. */
export function parseSubagentRequest(input: unknown): SubagentRequest | string {
  const raw = (input ?? {}) as Partial<SubagentRequest>
  if (typeof raw.subagent_name !== 'string' || !raw.subagent_name.trim()) {
    return '`task` requires a non-empty `subagent_name`'
  }
  if (typeof raw.description !== 'string' || !raw.description.trim()) {
    return '`task` requires a `description`: the subagent cannot see this conversation, so state everything it needs'
  }
  const req: SubagentRequest = {
    subagent_name: raw.subagent_name,
    description: raw.description,
  }
  if (typeof raw.system_prompt === 'string' && raw.system_prompt.trim()) {
    req.system_prompt = raw.system_prompt
  }
  if (Array.isArray(raw.allowed_tools)) {
    req.allowed_tools = raw.allowed_tools.filter(
      (t): t is string => typeof t === 'string'
    )
  }
  if (raw.background === true) req.background = true
  if (typeof raw.title === 'string' && raw.title.trim()) req.title = raw.title.trim()
  if (typeof raw.model === 'string' && raw.model.trim()) req.model = raw.model.trim().slice(0, 200)
  return req
}

/**
 * The child's effective allowlist: the definition's list, narrowed by the
 * call-site list, narrowed by what the parent itself can call.
 *
 * Never widens. Fails closed on a tool the definition or the parent does not
 * permit, rather than dropping it silently — a child that quietly lost the one
 * tool it needed looks like a model failure. A definition-listed tool the parent
 * lacks *is* dropped: the definition's author cannot know the parent's mode.
 * Ported from `subagent.rs::intersect_allowed_tools`.
 */
export function intersectAllowedTools(
  definition: string[] | null | undefined,
  request: string[] | null | undefined,
  parentTools: string[]
): { tools: string[] | null } | { error: string } {
  const parent = new Set(parentTools)
  const withSkills = (tools: string[]) => {
    const out = [...tools]
    for (const skill of SUBAGENT_SKILL_TOOLS) {
      if (!out.includes(skill) && parent.has(skill)) out.push(skill)
    }
    return out
  }

  if (request && request.length > 0) {
    const effective: string[] = []
    for (const tool of request) {
      if (definition && !definition.includes(tool)) {
        return {
          error: `tool '${tool}' is outside the subagent definition's allowed_tools`,
        }
      }
      if (!parent.has(tool)) {
        return { error: `tool '${tool}' is not available to this run` }
      }
      effective.push(tool)
    }
    return { tools: withSkills(effective) }
  }
  if (definition) {
    return { tools: withSkills(definition.filter((t) => parent.has(t))) }
  }
  return { tools: null }
}

/**
 * Resolve a request against the saved definitions.
 *
 * An unknown name is only an error when no inline `system_prompt` was supplied:
 * a one-off subagent is first-class, which is what keeps `task` useful before
 * anything is saved. Ported from `subagent.rs::resolve_dispatch`.
 */
export function resolveSubagent(
  req: SubagentRequest,
  definitions: SubagentDefinition[],
  parentTools: string[]
): ResolvedSubagent | { error: string } {
  const saved = definitions.find((d) => d.name === req.subagent_name)
  const narrowed = intersectAllowedTools(
    saved ? saved.allowed_tools : (req.allowed_tools ?? null),
    // An inline allowlist *is* the one-off's definition, so it is not also
    // applied as a call-site narrowing (that would compare it to itself).
    saved ? (req.allowed_tools ?? null) : null,
    parentTools
  )
  if ('error' in narrowed) return narrowed
  if (saved) {
    return {
      name: saved.name,
      systemPrompt: saved.system_prompt,
      allowedTools: narrowed.tools,
      model: saved.model,
      scope: saved.scope,
    }
  }
  if (!req.system_prompt) {
    return {
      error:
        `unknown subagent '${req.subagent_name}': no saved definition. For a ` +
        'one-off, retry with a `system_prompt` describing its role.',
    }
  }
  return {
    name: req.subagent_name,
    systemPrompt: req.system_prompt,
    allowedTools: narrowed.tools,
    model: null,
  }
}

/** The child's advertised tools: the parent's set, minus what a child never
 * gets, then narrowed to its allowlist. */
export function subagentTools(
  parentTools: Record<string, Tool>,
  allowedTools: string[] | null
): Record<string, Tool> {
  const out: Record<string, Tool> = {}
  for (const [name, tool] of Object.entries(parentTools)) {
    if (WITHHELD_FROM_SUBAGENTS.has(name)) continue
    if (allowedTools && !allowedTools.includes(name)) continue
    out[name] = tool
  }
  return out
}

/** Tool names a child may call, for narrowing a nested request. */
export function parentToolNames(tools: Record<string, Tool>): string[] {
  return Object.keys(tools).filter((n) => !WITHHELD_FROM_SUBAGENTS.has(n))
}

/**
 * A fair FIFO gate over concurrent children.
 *
 * Resolves in call order rather than whatever order the microtask queue
 * happens to run, so the queue position reported to the UI is the position the
 * child actually gets.
 */
class Semaphore {
  private free: number
  private waiters: Array<() => void> = []

  constructor(private readonly cap: number) {
    this.free = Math.max(1, cap)
  }

  /** Number of callers currently waiting, for the queued badge. */
  get waiting(): number {
    return this.waiters.length
  }

  /** Free permits; zero means the next `acquire` will queue. */
  get available(): number {
    return this.free
  }

  async acquire(): Promise<() => void> {
    if (this.free > 0) {
      this.free -= 1
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    return () => this.release()
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.free = Math.min(this.cap, this.free + 1)
  }
}

const gate = new Semaphore(MAX_PARALLEL_SUBAGENTS)

export type SubagentEvents = {
  /** Waiting for a concurrency slot; `waiting` is 1-based FIFO position. */
  onQueued: (waiting: number) => void
  onStart: () => void
  /** One event in the child's own transcript lane. */
  onInner: (event: StreamEvent) => void
  onEnd: (usage: Usage | null) => void
}

export type RunSubagentOptions = {
  resolved: ResolvedSubagent
  description: string
  /** The parent's model instance. Reused so no second load happens. */
  model: LanguageModel
  /**
   * Whether that model can see images. Decides if an image a child's tool
   * returned (a `read` of a png) is attached for it or replaced by a note.
   */
  supportsVision?: boolean
  /**
   * The parent's per-request reasoning options (the provider's native
   * thinking/effort settings). The body-level ones -- llama.cpp's budget and
   * `enable_thinking`, `reasoning_effort` -- are already part of `model`.
   */
  providerOptions?: Record<string, JSONObject>
  parentTools: Record<string, Tool>
  system: {
    workspacePath: string | null
    readOnlyFolder: string | null
    /** The session's extra attached folders, as the parent was told. */
    extraFolders?: readonly string[]
    extraFoldersWritable?: boolean
    bashAvailable: boolean
    /**
     * The run's frozen access, so the child is told the same thing the parent
     * was. A child that believes the folder is editable when it is not writes
     * into refusals and reports work it did not do.
     */
    folderAccess?: PromptFolderAccess
    /** The parent's `JAN.md`, handed down for the same reason. */
    projectInstructions?: string | null
    /**
     * The parent's compatibility instructions, verbatim.
     *
     * The same frozen manifest, not a fresh scan: a child resolving its own
     * would be following a different set of instructions from the agent that
     * dispatched it, in the same repository, in the same run.
     */
    compatInstructions?: readonly { name: string; content: string }[]
    /** The managed worktree's own branch, handed down like the access. */
    worktreeBranch?: string | null
  } & CoworkEnvironmentOptions
  /**
   * Blocks appended to the child's system prompt after everything else: the
   * assistant or work profile the Subagents settings chose. Prompt text only;
   * the child's tools and approvals are not read from here.
   */
  extraSystem?: string[]
  /** Runs one of the child's tool calls. Same sandbox as the parent. */
  dispatch: (call: PendingToolCall, signal: AbortSignal) => Promise<ToolOutcome>
  /** Who the child's calls are recorded as (see `RunDeps.activity`). */
  activity?: () => ToolActivityContext
  signal: AbortSignal
  events: SubagentEvents
  /** Session tokens already spent, so a child cannot outrun the session cap. */
  sessionTokens?: number
  maxSteps?: number
  /**
   * The most tokens this child may spend, for a surface with a budget of its
   * own (a Room). Absent is the run's own allowance, which is none.
   */
  tokenLimit?: number
}

export type SubagentResult = {
  /** The child's final answer, which becomes the `task` tool's output. */
  output: string
  usage: Usage | null
  isError?: boolean
  /** The answer was shortened by `capSubagentOutput`. */
  capped?: boolean
  /** The whole answer, when `output` is a shortened copy of it. */
  full?: string
  /** The child used its whole step budget without finishing. */
  stoppedAtLimit?: boolean
  sessionTokens: number
}

/** One model turn for a child, as a UI message stream the runner can consume. */
function childStep(opts: {
  model: LanguageModel
  providerOptions?: Record<string, JSONObject>
  system: string
  tools: Record<string, Tool>
  messages: UIMessage[]
  supportsVision?: boolean
  signal: AbortSignal
  /** The closing turn after the loop guard stopped the run: no tool calls. */
  textOnly?: boolean
}): Promise<ReadableStream<UIMessageChunk>> {
  return (async () => {
    // An image in a tool result goes to a model that can see as an image part
    // after the tool turn, and to one that cannot as a note: never as base64
    // inside the tool message's text.
    const prepared = prepareToolResultImagesForModel(opts.messages, {
      supportsVision: opts.supportsVision === true,
    })
    const modelMessages = await convertToModelMessages(prepared, {
      ignoreIncompleteToolCalls: true,
    })
    const result = streamText({
      model: opts.model,
      system: opts.system,
      messages: modelMessages,
      abortSignal: opts.signal,
      ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
      tools: Object.keys(opts.tools).length > 0 ? opts.tools : undefined,
      toolChoice:
        Object.keys(opts.tools).length > 0
          ? opts.textOnly
            ? 'none'
            : 'auto'
          : undefined,
    })
    const usage = createUsageCollector()
    return result.toUIMessageStream({
      messageMetadata: ({ part }) => {
        usage.observe(part)
        if (part.type !== 'finish') return undefined
        return {
          usage: usage.total((part as any).totalUsage),
          streamCutOff: streamCutOff(part),
        }
      },
      onError: (error) =>
        error instanceof Error ? error.message : String(error),
    })
  })()
}

/**
 * Run one subagent to completion and return its final answer.
 *
 * Blocking by design: the parent's `task` call resolves with the result, so the
 * model needs no run-id bookkeeping. Never throws — a failed child comes back as
 * an error string the parent can read and work around.
 */
export async function runSubagent(
  opts: RunSubagentOptions
): Promise<SubagentResult> {
  const { events, resolved } = opts
  let sessionTokens = opts.sessionTokens ?? 0

  // Report the position before queueing, so the badge shows where this child
  // actually sits rather than "queued" with no sense of how far back.
  if (gate.available === 0) events.onQueued(gate.waiting + 1)
  const release = await gate.acquire()
  try {
    if (opts.signal.aborted) {
      events.onEnd(null)
      return { output: '(cancelled)', usage: null, isError: true, sessionTokens }
    }
    events.onStart()

    const tools = subagentTools(opts.parentTools, resolved.allowedTools)
    const baseSystem = buildSubagentSystemPrompt(resolved.systemPrompt, {
      availableTools: Object.keys(tools),
      workspacePath: opts.system.workspacePath,
      readOnlyFolder: opts.system.readOnlyFolder,
      extraFolders: opts.system.extraFolders,
      extraFoldersWritable: opts.system.extraFoldersWritable,
      bashAvailable: opts.system.bashAvailable && 'bash' in tools,
      folderAccess: opts.system.folderAccess,
      projectInstructions: opts.system.projectInstructions,
      compatInstructions: opts.system.compatInstructions,
      worktreeBranch: opts.system.worktreeBranch,
      ...environmentOptions(opts.system),
      // Derived, not passed: the intersection above may have dropped them.
      webSearch: 'web_search' in tools,
    })

    const system = [baseSystem, ...(opts.extraSystem ?? [])].join('\n\n')

    // A fresh history: the child does not see the parent's conversation, so the
    // description is the whole brief.
    const messages: UIMessage[] = [
      {
        id: 'sub-user-0',
        role: 'user',
        parts: [{ type: 'text', text: opts.description }],
      } as UIMessage,
    ]

    let finalText = ''
    const sink: StreamSink = {
      onText: (delta) => events.onInner({ type: 'token', text: delta }),
      onToolStart: (id, name) =>
        events.onInner({ type: 'tool_call_started', id, name }),
      onToolArgsDelta: (id, delta) =>
        events.onInner({ type: 'tool_call_args_delta', id, delta }),
      onToolCall: (call) =>
        events.onInner({
          type: 'tool_call',
          id: call.toolCallId,
          name: call.toolName,
          args: call.input,
        }),
    }

    let n = 0
    const outcome = await runTurn({
      messages,
      signal: opts.signal,
      maxSteps: opts.maxSteps ?? MAX_SUBAGENT_STEPS,
      sessionTokens,
      ...(opts.tokenLimit !== undefined ? { sessionTokenLimit: opts.tokenLimit } : {}),
      deps: {
        sendStep: (msgs, signal, stepOpts) =>
          childStep({
            model: opts.model,
            providerOptions: opts.providerOptions,
            system,
            tools,
            messages: msgs,
            supportsVision: opts.supportsVision,
            signal,
            textOnly: stepOpts?.textOnly,
          }),
        dispatch: opts.dispatch,
        activity: opts.activity,
        sink,
        onStep: ({ result, outcomes }) => {
          if (result.text.trim()) finalText = result.text
          for (const [id, o] of outcomes) {
            events.onInner({
              type: 'tool_result',
              id,
              content: o.output,
              is_error: o.isError ?? false,
              diff: o.diff,
            })
          }
        },
        nextMessageId: () => `sub-asst-${n++}`,
      },
    })
    sessionTokens = outcome.sessionTokens
    events.onEnd(outcome.usage)

    if (outcome.stoppedBy === 'error') {
      return {
        output: outcome.errorText ?? 'the subagent failed',
        usage: outcome.usage,
        isError: true,
        sessionTokens,
      }
    }
    if (outcome.stoppedBy === 'aborted') {
      return {
        output: '(the subagent was cancelled)',
        usage: outcome.usage,
        isError: true,
        sessionTokens,
      }
    }
    if (
      outcome.stoppedBy === 'steps' ||
      outcome.stoppedBy === 'tokens' ||
      outcome.stoppedBy === 'deadline' ||
      outcome.stoppedBy === 'timeout' ||
      outcome.stoppedBy === 'loop'
    ) {
      // Report the cap plainly with whatever it did produce: the parent can
      // usually finish the errand itself, but not if it thinks the child
      // answered in full. Every limit lands here, including the ones added
      // later -- a child stopped for going in circles that reported "no
      // answer" told the parent nothing it could act on.
      const cap =
        outcome.stoppedBy === 'steps'
          ? `its ${opts.maxSteps ?? MAX_SUBAGENT_STEPS}-step budget`
          : outcome.stoppedBy === 'tokens'
            ? 'the session token budget'
            : outcome.stoppedBy === 'deadline'
              ? 'the run time limit'
              : outcome.stoppedBy === 'timeout'
                ? 'a model stream that stopped responding'
                : 'a repeating loop it could not get out of'
      return {
        output:
          `The subagent '${resolved.name}' stopped at ${cap} without finishing.` +
          (finalText
            ? `\n\nIts last output was:\n${capSubagentOutput(finalText)}`
            : ''),
        usage: outcome.usage,
        isError: true,
        sessionTokens,
        // The step budget gets its own label in the Tasks panel; the other
        // limits are the run's, not the child's.
        ...(outcome.stoppedBy === 'steps' ? { stoppedAtLimit: true } : {}),
        ...(finalText && capSubagentOutput(finalText) !== finalText
          ? { capped: true, full: finalText }
          : {}),
      }
    }
    const capped = finalText ? capSubagentOutput(finalText) : ''
    return {
      output: finalText ? capped : '(the subagent returned no answer)',
      usage: outcome.usage,
      sessionTokens,
      ...(finalText && capped !== finalText ? { capped: true, full: finalText } : {}),
    }
  } finally {
    release()
  }
}

export const __testing = { Semaphore, SUBAGENT_SKILL_TOOLS }
