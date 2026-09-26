import type {
  ChangeActorInput,
  ToolResources,
} from '@janhq/tauri-plugin-agent-tools-api'
import {
  advertisedToolSchemas,
  executeTool,
  executeToolStreaming,
  executeToolUnsandboxedRetry,
  executeToolUnsandboxedWithdraw,
  previewChange,
  sandboxStatus,
  sandboxToolchains,
  threadWorkspaceDelete,
  threadWorkspaceSweep,
  type ComponentReport,
  type OmittedTool,
  type SandboxStatus,
  type ToolchainReport,
  type ToolSchema,
  type WorkspaceScope,
} from '@janhq/tauri-plugin-agent-tools-api'
import { Channel, invoke } from '@tauri-apps/api/core'
import { getServiceHub } from '@/hooks/useServiceHub'

type AdvertisedTools = Awaited<ReturnType<typeof advertisedToolSchemas>>
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { errorText } from '@/lib/errorText'
import { SESSION_MESSAGING_TOOL_NAMES } from '@/lib/sessionMessagingTools'
import { runAccessRequest } from '@/lib/accessRequests'
import { listPluginsForModel } from '@/lib/pluginInventory'

/**
 * The built-in agent tools the desktop can dispatch.
 *
 * `write` and `edit` are included: they can only touch the thread's ephemeral
 * sandbox, which is deleted with the conversation, so `execute_tool` allows them
 * without a prompt. Withholding them while `bash` can write the same files would
 * be a restriction a sibling tool trivially bypasses.
 *
 * `web_search`/`web_fetch` are also built-ins but are already advertised through
 * the websearch plugin (see `webSearchTool.ts`), so they are not duplicated here.
 */
export const AGENT_TOOL_NAMES = new Set([
  'read',
  'ls',
  'find',
  'grep',
  'write',
  'edit',
  'bash',
  'memory_list',
  'memory_read',
  'memory_write',
  'skill_list',
  'skill_read',
  'skill_write',
  // Renders a local .html/.svg with headless Chrome so the agent can see what
  // it built. Read capability: it writes nothing back.
  'screenshot',
  // Cross-session messaging (docs/SESSION_MESSAGING.md). Read capability, no
  // paths. Only meaningful for a Cowork session: the chat transport drops them.
  ...SESSION_MESSAGING_TOOL_NAMES,
  // Answered by the desktop, not the tool core: a prompt the user answers, and
  // Flint's own plugin state. See `executeAgentTool`.
  'request_access',
  'list_plugins',
  // The host's git and gh, outside the sandbox (tools/git_tool.rs). Reads run
  // without asking; everything else is put to the user by the dispatcher
  // (see `gitApproval`), and a push or pull request every time.
  'git',
  // Read-only facts about an attached clone.
  'git_inspect',
])

// Keyed by what the answer depends on. One module-level list shared by chat
// and Cowork meant whichever surface asked first decided the tool set for every
// later caller -- a chat with no folder, say, fixing the list a Cowork session
// with a folder then received.
let schemaCache: ToolSchema[] | null = null
let schemaCacheKey = ''
let omittedCache: OmittedTool[] = []
let statusCache: Promise<SandboxStatus> | null = null

/**
 * The sandbox backend for this machine, fetched once. A failure is treated as
 * "no sandbox", which withholds `bash` rather than offering something that
 * cannot run.
 *
 * Kept alongside readiness rather than replaced by it: the system prompt needs
 * a synchronous answer to this one question, and `sandboxEnforces()` is that.
 */
export function getSandboxStatus(): Promise<SandboxStatus> {
  statusCache ??= sandboxStatus()
    .catch((e) => {
      console.warn('[agentTools] Failed to read sandbox status:', messageOf(e))
      return { backend: 'none', enforces: false }
    })
    .then((s) => {
      enforcesNow = s.enforces
      return s
    })
  return statusCache
}

let enforcesNow = false

/**
 * Which common toolchain programs the sandboxed shell can run, and which are
 * installed but cannot run there, for the prompt's `# Environment` block.
 * `null` when unknown (the backend only reports this for the Windows
 * sandbox, and a failure is treated the same): the block then says nothing
 * rather than guess. The backend caches the answer per app session and drops
 * it on a readiness retry, so asking once per run is cheap.
 */
export async function getSandboxToolchains(): Promise<ToolchainReport | null> {
  try {
    return (await sandboxToolchains()) ?? null
  } catch (e) {
    console.warn('[agentTools] Failed to probe sandbox toolchains:', messageOf(e))
    return null
  }
}

/**
 * `advertised_tool_schemas` with its `scope` argument.
 *
 * The generated guest binding predates `scope`, so a scoped request goes to the
 * plugin command directly; an unscoped one keeps using the binding, which is
 * exactly the backend's `thread` default.
 */
function advertisedFor(
  projectRoot: string | undefined,
  reported: ComponentReport[] | undefined,
  scope: WorkspaceScope | undefined
): Promise<AdvertisedTools> {
  if (!scope) return advertisedToolSchemas(projectRoot, reported)
  return invoke<AdvertisedTools>('plugin:agent-tools|advertised_tool_schemas', {
    projectRoot,
    reported,
    scope,
  })
}

/**
 * Re-probe the environment, dropping every cache.
 *
 * Installing a sandbox backend, fixing a permission or attaching a folder
 * cannot take effect otherwise: the caches are module-level, and leaving
 * `schemaCache` behind would keep a tool withheld after the thing that withheld
 * it was fixed. Readiness changes must reach the next dispatch without a
 * restart, and this is how.
 */
export function refreshSandboxStatus(): Promise<SandboxStatus> {
  statusCache = null
  schemaCache = null
  omittedCache = []
  return getSandboxStatus()
}

/**
 * Synchronous view of the sandbox, for building the system prompt. `false` until
 * the probe resolves, which is safe: the prompt is assembled after
 * `getAgentToolSchemas`, so by then the answer is known.
 */
export function sandboxEnforces(): boolean {
  return enforcesNow
}

/**
 * Which tools were held back last time the list was built, and why.
 *
 * Recorded rather than discarded because a tool that silently disappears is
 * indistinguishable from a bug. This is what the activity log and the
 * Environment readiness card render, and what "what the model received" reports
 * as the reason a tool is not in the payload.
 */
export function omittedAgentTools(): OmittedTool[] {
  return omittedCache
}

/**
 * The schemas this environment can actually run.
 *
 * The single production decision about what a model is offered. Rust's
 * `schema.rs` is still the only source of the schemas themselves; what changed
 * is that the subset is chosen by capability rather than by one sandbox
 * boolean, so a machine with no shell keeps its filesystem tools and a machine
 * whose only shell is `cmd` keeps `bash` (a POSIX-only command is refused per
 * call, where the construct can be named, rather than reinterpreted).
 *
 * `reported` carries the components only the renderer's stores can answer for.
 * A failure to reach the backend withholds nothing beyond what the environment
 * already withholds: the previous list is kept if there is one, since an empty
 * tool set would silently turn an agent into a chatbot.
 */
export async function getAgentToolSchemas(
  projectRoot?: string,
  reported?: ComponentReport[],
  /**
   * Which surface is asking. `'session'` (Cowork) is the only scope the
   * backend offers the session-messaging tools to; omitted means `'thread'`.
   */
  scope?: WorkspaceScope
): Promise<ToolSchema[]> {
  const key = JSON.stringify([
    projectRoot ?? '',
    (reported ?? []).map((r) => `${r.component}:${r.state}`),
    scope ?? 'thread',
  ])
  if (schemaCache && schemaCacheKey === key) return schemaCache
  const [advertised] = await Promise.all([
    advertisedFor(projectRoot, reported, scope).catch((e) => {
      console.warn('[agentTools] Failed to read readiness:', messageOf(e))
      return null
    }),
    getSandboxStatus(),
  ])
  if (!advertised) return schemaCache ?? []
  schemaCache = advertised.schemas.filter((s) =>
    AGENT_TOOL_NAMES.has(s.function.name)
  )
  schemaCacheKey = key
  omittedCache = advertised.omitted.filter((o) => AGENT_TOOL_NAMES.has(o.name))
  return schemaCache
}

/**
 * The schemas already read for this folder, or null when none have been.
 *
 * Never asks the backend: the session details use it to measure the tool set
 * before a run without probing readiness. A miss is reported as a miss, and
 * the caller says that part is measured when the first run starts.
 */
export function peekAgentToolSchemas(
  projectRoot: string | undefined,
  scope?: WorkspaceScope
): ToolSchema[] | null {
  if (!schemaCache) return null
  try {
    const [root, , cachedScope] = JSON.parse(schemaCacheKey) as [
      string,
      unknown,
      string,
    ]
    if (root !== (projectRoot ?? '') || cachedScope !== (scope ?? 'thread')) {
      return null
    }
  } catch {
    return null
  }
  return schemaCache
}

type AgentToolResult = {
  content?: unknown
  error?: string
  /** Unified diff from `write`/`edit`. Display-only; never sent to the model. */
  diff?: string
  /** What the call's command used (AH-174), failed or not. */
  resources?: ToolResources
  /**
   * Set when a `bash` call failed only because Windows' null device refuses
   * sandboxed programs: the id `retryAgentToolUnsandboxed` redeems, once the
   * user approves, to run the same call outside the sandbox.
   */
  unsandboxedRetry?: string
}

/** Shared so a rejected Tauri command never renders as `[object Object]`. */
const messageOf = errorText

/**
 * Execute one built-in agent tool.
 *
 * The filesystem tools are confined to this thread's own sandbox, so scratch
 * files from one conversation are invisible to the next; memory and skill tools
 * reach the permanent store instead and persist. No project path is passed --
 * the desktop has no project picker yet, so the plugin uses the permanent store
 * in the Flint data folder.
 *
 * `bash` additionally runs under an OS sandbox, whose network access follows the
 * `bashNetworkEnabled` setting. It is read here, per call, rather than captured
 * once, so toggling it takes effect on the next command instead of the next
 * restart.
 */
/**
 * How a tool call should be run, by name rather than by position.
 *
 * The generated binding underneath is positional and several of its arguments
 * are optional strings — `WorkspaceScope` among them — so a value handed to the
 * wrong slot type-checks and is accepted in silence. That is not hypothetical:
 * the session scope once landed in the write-grant slot and Cowork sessions ran
 * under the thread sweep for a commit. Callers now name what they mean, and the
 * one place that still knows the order is the adapter below.
 */
export type AgentToolOptions = {
  /**
   * A project folder to attach read-only. Rust validates it and refuses one
   * that overlaps the workspace or the Flint data folder, rather than silently
   * dropping it, so an unusable attachment surfaces as a tool error.
   */
  readOnlyProject?: string | null
  /**
   * The session's additional attached folders, each readable exactly like
   * `readOnlyProject` and validated the same way by Rust.
   */
  extraProjects?: readonly string[] | null
  /**
   * Which sandbox namespace `threadId` names. Load-bearing: a Cowork session id
   * is not a chat thread id, so running one under `'thread'` would put its files
   * where the thread sweep's keep-list can never mention them — and the sweep
   * would delete the only copy of the agent's work.
   */
  scope?: WorkspaceScope
  /**
   * An opaque grant authorizing this run to write to the attached folder.
   *
   * Never a path: the backend resolves the id against the session it was issued
   * to, so nothing a model emits can widen or redirect where a write lands.
   */
  writeGrant?: string | null
  /**
   * The run this call belongs to. Given, the backend journals the files a
   * `write` or `edit` changes against it, so the turn can be undone (AH-202).
   */
  undoRun?: string
  /**
   * The call's id. With `undoRun`, what its command uses is kept against the
   * run and returned with the result (AH-174).
   */
  callId?: string
  /**
   * Who is making the call (AH-110). Journaled with every file the call
   * changes, so a change can name the agent that made it after a restart. The
   * backend refuses an identity that is not an agent rather than attributing
   * the change to no one -- or to the wrong one.
   */
  actor?: ChangeActorInput
  /**
   * The asking run's signal. A `request_access` prompt still on screen when it
   * aborts is withdrawn, so a stopped run's question cannot be answered later.
   */
  signal?: AbortSignal
  /** Shown in a `request_access` prompt: which conversation or task is asking. */
  taskLabel?: string
  /** Shown in a `request_access` prompt when a subagent or child is asking. */
  origin?: string
  /**
   * Receives a `bash` command's output as it is produced, raw (ANSI colours
   * intact). Given, the call streams; the returned result is unchanged.
   */
  onOutput?: (text: string) => void
}

export async function executeAgentTool(
  toolName: string,
  input: unknown,
  threadId: string,
  options: AgentToolOptions = {}
): Promise<AgentToolResult> {
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (!dataFolder) return { error: 'Flint data folder is unavailable' }
    // Answered here, where the user and Flint's plugin state are reachable.
    // Both return ordinary results: a denial is something the model acts on,
    // not an error it retries.
    if (toolName === 'request_access') {
      return {
        content: await runAccessRequest(input, threadId, {
          dataFolder,
          scope: options.scope,
          signal: options.signal,
          taskLabel: options.taskLabel,
          origin: options.origin,
          audit: {
            run: options.undoRun,
            call: options.callId,
            // The primary agent is recorded as `main`, as the backend's own
            // decision records spell it; a subagent by its actor id.
            agent:
              !options.actor || options.actor.id === 'agent'
                ? 'main'
                : options.actor.id,
            project: options.readOnlyProject ?? undefined,
          },
        }),
      }
    }
    if (toolName === 'list_plugins') {
      return { content: await listPluginsForModel(options.readOnlyProject) }
    }
    const args =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {}
    const result =
      options.onOutput && toolName === 'bash'
        ? await runStreaming(dataFolder, threadId, toolName, args, options)
        : await executeTool(
            dataFolder,
            threadId,
            toolName,
            args,
            undefined,
            undefined,
            useAgentToolsConfig.getState().bashNetworkEnabled,
            // The only place argument order is known. Keep these adjacent to the
            // binding's parameter list so a change there is visible here.
            options.readOnlyProject ?? undefined,
            options.writeGrant ?? undefined,
            options.scope ?? ('thread' as WorkspaceScope),
            options.callId,
            options.undoRun,
            options.actor,
            extraProjectsOf(options)
          )
    const resources = result.resources ?? undefined
    if (result.isError) {
      return {
        error: result.content,
        resources,
        ...(result.unsandboxedRetry
          ? { unsandboxedRetry: result.unsandboxedRetry }
          : {}),
      }
    }
    return {
      content: result.content,
      diff: result.diff ?? undefined,
      resources,
    }
  } catch (e) {
    return { error: messageOf(e) }
  }
}

/**
 * Run a failed `bash` call again outside the sandbox. Only after the user
 * approved it: `retry` is the `unsandboxedRetry` id the failed call carried,
 * and it names that exact call.
 */
export async function retryAgentToolUnsandboxed(
  threadId: string,
  retry: string
): Promise<AgentToolResult & { ran: boolean }> {
  try {
    const result = await executeToolUnsandboxedRetry(threadId, retry)
    const resources = result.resources ?? undefined
    if (result.isError) return { error: result.content, resources, ran: true }
    return { content: result.content, resources, ran: true }
  } catch (e) {
    // Refused before anything ran: the offer was used, expired, or unknown.
    return { error: messageOf(e), ran: false }
  }
}

/** Drop an unsandboxed-retry offer the user declined. Never throws. */
export async function withdrawAgentToolUnsandboxed(
  threadId: string,
  retry: string
): Promise<void> {
  try {
    await executeToolUnsandboxedWithdraw(threadId, retry)
  } catch {
    // An offer that cannot be withdrawn expires on its own.
  }
}

/**
 * `executeTool` over the streaming command, forwarding each output chunk to
 * `options.onOutput` in order. Same arguments, same result.
 */
async function runStreaming(
  dataFolder: string,
  threadId: string,
  toolName: string,
  args: Record<string, unknown>,
  options: AgentToolOptions
) {
  const onOutput = options.onOutput
  const channel = new Channel<{ seq: number; text: string }>()
  let next = 0
  const early = new Map<number, string>()
  // Chunks carry a monotonic `seq`; deliver strictly in order.
  channel.onmessage = (chunk) => {
    early.set(chunk.seq, chunk.text)
    while (early.has(next)) {
      onOutput?.(early.get(next) as string)
      early.delete(next)
      next += 1
    }
  }
  return executeToolStreaming(dataFolder, threadId, toolName, args, channel, {
    allowNetwork: useAgentToolsConfig.getState().bashNetworkEnabled,
    readOnlyProject: options.readOnlyProject ?? undefined,
    writeGrant: options.writeGrant ?? undefined,
    scope: options.scope ?? ('thread' as WorkspaceScope),
    callId: options.callId,
    undoRun: options.undoRun,
    actor: options.actor,
    extraProjects: extraProjectsOf(options),
  })
}

/** The extra folders as the binding takes them: absent when there are none. */
const extraProjectsOf = (options: AgentToolOptions): string[] | undefined =>
  options.extraProjects && options.extraProjects.length > 0
    ? [...options.extraProjects]
    : undefined

/**
 * The diff a `write` or `edit` call would make, for its approval prompt
 * (AH-146). Computed by the backend against the same path resolution the call
 * would use, and only where it could write. `undefined` when there is none --
 * another tool, no change, a path it may not write, or a failure: a missing
 * preview never stops the prompt, it only leaves it without the diff.
 */
export async function previewAgentChange(
  toolName: string,
  input: unknown,
  threadId: string,
  options: Pick<AgentToolOptions, 'scope' | 'writeGrant'> = {}
): Promise<string | undefined> {
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (!dataFolder) return undefined
    const args =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {}
    const diff = await previewChange(dataFolder, threadId, toolName, args, {
      writeGrant: options.writeGrant ?? undefined,
      scope: options.scope ?? ('thread' as WorkspaceScope),
    })
    return diff ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Delete a thread's sandbox. Best-effort: a failure here leaves a directory
 * behind for the next startup sweep to collect, which is not worth surfacing
 * while the user is deleting a thread.
 */
export async function cleanupThreadWorkspace(threadId: string): Promise<void> {
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (!dataFolder) return
    await threadWorkspaceDelete(dataFolder, threadId)
  } catch (e) {
    console.warn(
      `[agentTools] Failed to delete workspace for thread ${threadId}:`,
      messageOf(e)
    )
  }
}

/**
 * Delete sandboxes left behind by threads that no longer exist, returning how
 * many were removed. Best-effort, same reasoning as above.
 */
export async function sweepThreadWorkspaces(
  liveThreadIds: string[]
): Promise<number> {
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (!dataFolder) return 0
    return await threadWorkspaceSweep(dataFolder, liveThreadIds)
  } catch (e) {
    console.warn(
      '[agentTools] Failed to sweep thread workspaces:',
      messageOf(e)
    )
    return 0
  }
}
