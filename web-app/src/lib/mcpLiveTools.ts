/**
 * The MCP tools a request should advertise, read when the request is built.
 *
 * A server turned on, connected or removed after a chat started used to reach
 * that chat only through a frozen copy taken at its first send (Cowork never
 * offered MCP at all), so the model reported "no MCP servers, restart the
 * conversation". Every surface now asks here at the start of each model
 * request. Nothing is listed again while the generation counter is unchanged:
 * it moves on a connect, disconnect, enable, disable or tools-changed event.
 */
import { toast } from 'sonner'
import type { MCPTool } from '@/types/completion'
import type { MCPService } from '@/services/mcp/types'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useToolAvailable } from '@/hooks/useToolAvailable'

let generation = 0
let cached: { gen: number; at: number; result: LiveMcp } | null = null
let inflight: { gen: number; promise: Promise<LiveMcp> } | null = null

/** Safety net for a change that raised no event; the counter is the primary signal. */
const CACHE_TTL_MS = 30_000
/** How long a request waits for servers that are still starting. */
export const MCP_START_WAIT_MS = 8_000

export const getMcpGeneration = () => generation

/** The set of servers or their tools may have changed: re-read at the next request. */
export function bumpMcpGeneration(): void {
  generation += 1
  cached = null
}

/** Names of the servers the user has switched on, sorted. */
export function enabledMcpServers(): string[] {
  const servers = useMCPServers.getState?.()?.mcpServers ?? {}
  return Object.entries(servers)
    .filter(([, config]) => config?.active)
    .map(([name]) => name)
    .sort()
}

// An enable or disable in Settings changes `active` without waiting for the
// backend's event, so the counter follows the store as well.
let activeSignature = ''
// Which servers were last seen switched on or off. A server the user switches
// on again starts with its tools on: the per-tool switches of an earlier
// session must not leave a freshly enabled server silently offering nothing.
const lastActive = new Map<string, boolean>()
useMCPServers.subscribe?.((state) => {
  for (const [name, config] of Object.entries(state.mcpServers ?? {})) {
    const now = Boolean(config?.active)
    if (lastActive.get(name) === false && now) {
      try {
        useToolAvailable.getState?.()?.enableServerTools?.(name)
      } catch {
        // Availability is a convenience; never block the settings toggle.
      }
    }
    lastActive.set(name, now)
  }
  const next = Object.entries(state.mcpServers ?? {})
    .map(([name, config]) => `${name}:${config?.active ? 1 : 0}`)
    .sort()
    .join('|')
  if (next === activeSignature) return
  activeSignature = next
  bumpMcpGeneration()
})

/** Server name -> sorted tool names. */
export type McpSnapshot = Record<string, string[]>

export type LiveMcp = {
  tools: MCPTool[]
  /** Enabled servers that had not finished starting when the wait ran out. */
  starting: string[]
}

export function snapshotMcpTools(
  tools: readonly { name: string; server?: string }[]
): McpSnapshot {
  const out: McpSnapshot = {}
  for (const tool of tools) {
    const server = tool.server || 'unknown'
    ;(out[server] ??= []).push(tool.name)
  }
  for (const names of Object.values(out)) names.sort()
  return out
}

/**
 * What the last request of a conversation advertised, and the note it earned.
 * Kept here rather than on a transport: Cowork builds a new transport for
 * every run, and the note must outlive it or the prompt prefix would change
 * again at the next run.
 */
const baselines = new Map<string, { snapshot: McpSnapshot; note: string | null }>()

export const readMcpBaseline = (key: string) => baselines.get(key)
export const writeMcpBaseline = (
  key: string,
  snapshot: McpSnapshot,
  note: string | null
) => void baselines.set(key, { snapshot, note })
export const clearMcpBaselines = () => baselines.clear()

export type McpChange = {
  added: { server: string; tools: number }[]
  removed: string[]
  resized: { server: string; from: number; to: number }[]
}

export function diffMcpSnapshots(
  prev: McpSnapshot,
  next: McpSnapshot
): McpChange {
  const change: McpChange = { added: [], removed: [], resized: [] }
  for (const server of Object.keys(next).sort()) {
    if (!(server in prev)) {
      change.added.push({ server, tools: next[server].length })
    } else if (prev[server].join('\n') !== next[server].join('\n')) {
      change.resized.push({
        server,
        from: prev[server].length,
        to: next[server].length,
      })
    }
  }
  for (const server of Object.keys(prev).sort()) {
    if (!(server in next)) change.removed.push(server)
  }
  return change
}

const count = (n: number) => `${n} tool${n === 1 ? '' : 's'}`

/**
 * A short note for the model when the advertised set differs from the last
 * request's, so it does not trust earlier turns that said "no MCP tools".
 * Null when nothing changed.
 */
export function mcpChangeNote(change: McpChange): string | null {
  const parts = [
    ...change.added.map(
      (a) => `${a.server} is now available (${count(a.tools)})`
    ),
    ...change.resized.map(
      (r) => `${r.server} now offers ${count(r.to)} (was ${r.from})`
    ),
    ...change.removed.map((s) => `${s} was removed`),
  ]
  if (parts.length === 0) return null
  return (
    `MCP servers changed: ${parts.join('; ')}. ` +
    'The tool list of this request is current; earlier messages claiming that MCP tools were missing, or that they were available, are out of date.'
  )
}

/** One label per server for the environment line; a starting server says so. */
export function mcpServerLabels(
  snapshot: McpSnapshot,
  starting: readonly string[] = [],
  withheld: readonly string[] = []
): string[] {
  return [
    ...Object.keys(snapshot)
      .sort()
      .map((s) => `${s} (${count(snapshot[s].length)})`),
    ...starting
      .filter((s) => !(s in snapshot))
      .sort()
      .map((s) => `${s} (still starting, tools not available yet)`),
    ...withheld,
  ]
}

/** An enabled server whose tools did not reach the request, and why. */
export type McpWithheld = {
  server: string
  /** Tools the server listed. Zero: it is enabled but listed nothing. */
  total: number
  /** How many of them the per-tool switches turn off. */
  disabled: number
}

export type McpAvailability = {
  withheld: McpWithheld[]
  /** One label per withheld server for the environment line. */
  labels: string[]
  /** What the model is told, so it does not report a missing server. */
  note: string | null
}

/**
 * Enabled servers that offered nothing to this request. A server that is
 * connected but whose every tool is switched off, or that is enabled but
 * listed no tools, used to vanish from the prompt without a word and the model
 * then said the server was not attached.
 */
export function mcpAvailability(
  listed: readonly { name: string; server?: string }[],
  offered: McpSnapshot,
  starting: readonly string[],
  isDisabled: (server: string, tool: string) => boolean,
  enabled: readonly string[] = enabledMcpServers()
): McpAvailability {
  const per = new Map<string, McpWithheld>()
  for (const tool of listed) {
    const server = tool.server || 'unknown'
    const entry = per.get(server) ?? { server, total: 0, disabled: 0 }
    entry.total += 1
    if (isDisabled(server, tool.name)) entry.disabled += 1
    per.set(server, entry)
  }
  for (const server of enabled) {
    if (!per.has(server) && !starting.includes(server)) {
      per.set(server, { server, total: 0, disabled: 0 })
    }
  }
  const withheld = [...per.values()]
    .filter((e) => !(offered[e.server]?.length > 0))
    .sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0))
  const describe = (e: McpWithheld) =>
    e.total === 0
      ? 'enabled, but it listed no tools (not connected?)'
      : e.disabled === e.total
        ? `${count(e.total)}, all switched off in the Tools menu`
        : `${count(e.total)}, none offered`
  const labels = withheld.map((e) => `${e.server} (${describe(e)})`)
  if (withheld.length === 0) return { withheld, labels, note: null }
  const parts = withheld.map((e) =>
    e.total === 0
      ? `${e.server} is enabled but listed no tools; it may have failed to start (Settings > MCP Servers shows its log)`
      : e.disabled === e.total
        ? `${e.server} is connected with ${count(e.total)}, but every one is switched off in the Tools menu, so none are offered`
        : `${e.server} is connected with ${count(e.total)}, none of which could be offered`
  )
  return {
    withheld,
    labels,
    note:
      `MCP tools withheld from this request: ${parts.join('; ')}. ` +
      'The server is not missing: tell the user which switch to turn on instead of saying it is not attached.',
  }
}

let lastWithheldKey = ''

/** Tell the person, once per change, that a server they enabled offers nothing. */
export function announceMcpWithheld(withheld: readonly McpWithheld[]): void {
  const key = withheld.map((e) => `${e.server}:${e.total}:${e.disabled}`).join('|')
  if (key === lastWithheldKey) return
  lastWithheldKey = key
  for (const e of withheld) {
    if (e.total === 0) {
      toast.info(`${e.server} is enabled but offered no tools`, {
        description: 'It may not be connected. Check its log in Settings > MCP Servers.',
      })
      continue
    }
    toast.info(`${e.server}: ${count(e.total)}, all switched off`, {
      description: 'Its tools are hidden from the model by the Tools menu.',
      action: {
        label: 'Switch on',
        onClick: () => {
          useToolAvailable.getState?.()?.enableServerTools?.(e.server)
          bumpMcpGeneration()
        },
      },
    })
  }
}

/**
 * The environment line naming this session's MCP servers. Never "none" while a
 * server is connected, and a server still starting is named as such.
 */
export function mcpServersLine(
  snapshot: McpSnapshot,
  starting: readonly string[] = []
): string {
  const names = mcpServerLabels(snapshot, starting)
  return `MCP servers in this session: ${names.length ? names.join(', ') : 'none'}.`
}

/** The model-facing note for servers that are enabled but not ready. */
export function mcpStartingNote(starting: readonly string[]): string | null {
  if (starting.length === 0) return null
  return `MCP server ${starting.join(', ')} is still starting; its tools are not available yet and will be offered on a later request.`
}

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

async function read(
  mcp: Pick<MCPService, 'getTools'>,
  waitMs: number
): Promise<LiveMcp> {
  const enabled = enabledMcpServers()
  const started = mcp.getTools({ start: true }).then((tools) => ({
    tools: Array.isArray(tools) ? tools : [],
    timedOut: false,
  }))
  // A start that outlives the wait keeps going; its `mcp-update` moves the
  // counter and the next request picks the server up.
  const raced = await Promise.race([
    started,
    timeout(waitMs, { tools: [] as MCPTool[], timedOut: true }),
  ])
  if (!raced.timedOut) return { tools: raced.tools, starting: [] }
  started.catch(() => undefined)
  let known: MCPTool[] = []
  try {
    known = (await mcp.getTools()) ?? []
  } catch {
    known = []
  }
  const have = new Set(known.map((t) => t.server))
  return { tools: known, starting: enabled.filter((s) => !have.has(s)) }
}

/**
 * The tools of every enabled, connected server as of now, starting servers
 * that are enabled but not running. Bounded: after `waitMs` the servers still
 * starting are reported in `starting` instead of blocking the request.
 */
export async function loadLiveMcpTools(
  mcp: Pick<MCPService, 'getTools'>,
  opts: { waitMs?: number } = {}
): Promise<LiveMcp> {
  const gen = generation
  if (
    cached &&
    cached.gen === gen &&
    cached.result.starting.length === 0 &&
    Date.now() - cached.at < CACHE_TTL_MS
  ) {
    return cached.result
  }
  if (inflight && inflight.gen === gen) return inflight.promise
  const promise = read(mcp, opts.waitMs ?? MCP_START_WAIT_MS)
    .then((result) => {
      if (gen === generation && inflight?.promise === promise) {
        cached = { gen, at: Date.now(), result }
      }
      return result
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
  inflight = { gen, promise }
  return promise
}

/** Keep the tool lists the UI and the call dispatcher read in step with a request. */
export function syncMcpStore(tools: readonly MCPTool[]): void {
  const state = useAppState.getState?.()
  if (!state) return
  const names = tools.map((t) => t.name)
  const same =
    state.mcpToolNames.size === names.length &&
    names.every((n) => state.mcpToolNames.has(n)) &&
    state.tools.length === tools.length
  if (same) return
  state.updateTools([...tools])
  state.updateMcpToolNames(names)
}

/** Tell the person when a server shows up mid-chat. */
export function announceMcpChange(change: McpChange): void {
  for (const added of change.added) {
    toast.info(`${added.server} is now available in this chat`, {
      description: count(added.tools),
    })
  }
}
