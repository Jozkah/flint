import {
  advertisedToolSchemas,
  executeTool,
  sandboxStatus,
  threadWorkspaceDelete,
  threadWorkspaceSweep,
  type ComponentReport,
  type OmittedTool,
  type SandboxStatus,
  type ToolSchema,
  type WorkspaceScope,
} from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { errorText } from '@/lib/errorText'

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
])

let schemaCache: ToolSchema[] | null = null
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
  reported?: ComponentReport[]
): Promise<ToolSchema[]> {
  if (schemaCache) return schemaCache
  const [advertised] = await Promise.all([
    advertisedToolSchemas(projectRoot, reported).catch((e) => {
      console.warn('[agentTools] Failed to read readiness:', messageOf(e))
      return null
    }),
    getSandboxStatus(),
  ])
  if (!advertised) return schemaCache ?? []
  schemaCache = advertised.schemas.filter((s) =>
    AGENT_TOOL_NAMES.has(s.function.name)
  )
  omittedCache = advertised.omitted.filter((o) => AGENT_TOOL_NAMES.has(o.name))
  return schemaCache
}

type AgentToolResult = {
  content?: unknown
  error?: string
  /** Unified diff from `write`/`edit`. Display-only; never sent to the model. */
  diff?: string
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
 * in the Jan data folder.
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
   * that overlaps the workspace or the Jan data folder, rather than silently
   * dropping it, so an unusable attachment surfaces as a tool error.
   */
  readOnlyProject?: string | null
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
}

export async function executeAgentTool(
  toolName: string,
  input: unknown,
  threadId: string,
  options: AgentToolOptions = {}
): Promise<AgentToolResult> {
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (!dataFolder) return { error: 'Jan data folder is unavailable' }
    const args =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {}
    const result = await executeTool(
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
      options.scope ?? ('thread' as WorkspaceScope)
    )
    if (result.isError) return { error: result.content }
    return { content: result.content, diff: result.diff ?? undefined }
  } catch (e) {
    return { error: messageOf(e) }
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
    console.warn('[agentTools] Failed to sweep thread workspaces:', messageOf(e))
    return 0
  }
}
