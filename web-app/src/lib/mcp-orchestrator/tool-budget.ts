/**
 * Keeps the MCP tools a request advertises inside a share of the model's
 * context window.
 *
 * Server routing (`mcp-orchestrator.ts`) picks whole servers, so one large
 * server (130+ tools) could still push a request past the window, and Cowork
 * and Rooms never routed at all. Here every MCP tool is ranked against the
 * conversation; the best ones that fit the budget are offered and the rest are
 * held back behind `mcp_find_tools`, which the model calls to have more of them
 * offered from its next step on. When everything fits, nothing changes.
 */
import { jsonSchema, type Tool } from 'ai'
import { estimateToolTokens } from '@/lib/context-manager'
import { mentionedServers, tokenize } from './intent-classifier'

export const MCP_FIND_TOOLS_NAME = 'mcp_find_tools'

/** Share of the context window MCP tool definitions may take. */
export const MCP_TOOL_BUDGET_SHARE = 0.25
/** Budget when the window is unknown. */
export const MCP_TOOL_BUDGET_UNKNOWN_WINDOW = 24_000
/** Never squeeze the budget below this, so a small window still gets a few tools. */
export const MCP_TOOL_BUDGET_FLOOR = 2_000
/** How many held tools one `mcp_find_tools` call offers at most. */
export const MCP_FIND_LIMIT = 8

export type McpToolInfo = {
  name: string
  server: string
  description: string
  tokens: number
}

export type McpRankContext = {
  /** Recent user text, newest last; the newest counts most. */
  queries: string[]
  /** Servers whose tools the conversation already called, newest first. */
  recentServers?: string[]
  /** Tool names `mcp_find_tools` already offered in this conversation. */
  unlocked?: ReadonlySet<string>
  /** Tools the previous request offered: kept unless something fits better, so the set does not flip between steps. */
  previous?: ReadonlySet<string>
}

export function mcpToolBudget(windowTokens: number): number {
  if (!(windowTokens > 0)) return MCP_TOOL_BUDGET_UNKNOWN_WINDOW
  return Math.max(MCP_TOOL_BUDGET_FLOOR, Math.floor(windowTokens * MCP_TOOL_BUDGET_SHARE))
}

/** `ida_decompile_function`, `getFileInfo` -> ["ida", "decompile", "function"], ["get", "file", "info"]. */
function nameTokens(name: string): string[] {
  return tokenize(name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
}

function stem(token: string): string {
  return token.length > 4 ? token.replace(/(ing|ed|es|s)$/, '') : token
}

function tokenScore(queryTokens: string[], name: string[], desc: Set<string>): number {
  let score = 0
  for (const q of queryTokens) {
    const qs = stem(q)
    for (const n of name) {
      const ns = stem(n)
      if (ns === qs) score += 3
      else if (qs.length >= 4 && ns.length >= 4 && (ns.startsWith(qs) || qs.startsWith(ns))) score += 1.5
    }
    if (desc.has(qs)) score += 1
  }
  return score
}

/**
 * Score of each tool against the conversation. Positive means relevant; the
 * newest message weighs most, a server the user names or used recently lifts
 * all of its tools, and an unlocked tool always ranks first.
 */
export function rankMcpTools(tools: McpToolInfo[], ctx: McpRankContext): Map<string, number> {
  const scores = new Map<string, number>()
  const queries = ctx.queries.filter((q) => q.trim())
  const weighted = queries.map((q, i) => ({
    tokens: tokenize(q),
    weight: i === queries.length - 1 ? 1 : 0.4,
  }))
  const servers = [...new Set(tools.map((t) => t.server))]
  const summaries = servers.map((name) => ({ name, description: '', capabilities: [] }))
  const named = new Set(queries.flatMap((q) => mentionedServers(q, summaries)))
  const recent = ctx.recentServers ?? []
  for (const tool of tools) {
    if (ctx.unlocked?.has(tool.name)) {
      scores.set(tool.name, Number.MAX_SAFE_INTEGER)
      continue
    }
    const name = nameTokens(tool.name)
    const desc = new Set(tokenize(tool.description).map(stem))
    let score = 0
    for (const q of weighted) score += q.weight * tokenScore(q.tokens, name, desc)
    if (score > 0 && ctx.previous?.has(tool.name)) score += 4
    if (named.has(tool.server)) score += 6
    const r = recent.indexOf(tool.server)
    if (r >= 0) score += Math.max(1, 4 - r)
    scores.set(tool.name, score)
  }
  return scores
}

/**
 * The MCP tools to offer and the ones to hold back. Everything is offered when
 * it fits the budget. Otherwise the relevant tools are taken best first while
 * they fit; a tool nothing points to is held (asking for it costs one call,
 * sending all of them can make the request impossible).
 */
export function fitMcpTools(
  tools: McpToolInfo[],
  budget: number,
  ctx: McpRankContext
): { offered: string[]; held: string[] } {
  const total = tools.reduce((n, t) => n + t.tokens, 0)
  if (total <= budget) return { offered: tools.map((t) => t.name), held: [] }
  const scores = rankMcpTools(tools, ctx)
  const order = [...tools].sort((a, b) => {
    const d = (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0)
    if (d !== 0) return d
    return a.server < b.server ? -1 : a.server > b.server ? 1 : a.name < b.name ? -1 : 1
  })
  // Room for the meta-tool itself.
  let left = budget - 200
  const offered: string[] = []
  const held: string[] = []
  for (const tool of order) {
    const score = scores.get(tool.name) ?? 0
    if (score > 0 && tool.tokens <= left) {
      offered.push(tool.name)
      left -= tool.tokens
    } else {
      held.push(tool.name)
    }
  }
  return { offered, held }
}

/** Held tools that best match a `mcp_find_tools` query, best first. */
export function findHeldTools(held: McpToolInfo[], query: string, server?: string): McpToolInfo[] {
  const pool = server ? held.filter((t) => t.server.toLowerCase() === server.toLowerCase()) : held
  if (!query.trim()) return pool.slice(0, MCP_FIND_LIMIT)
  const scores = rankMcpTools(pool, { queries: [query] })
  return pool
    .filter((t) => (scores.get(t.name) ?? 0) > 0)
    .sort((a, b) => (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0))
    .slice(0, MCP_FIND_LIMIT)
}

/** The meta-tool's definition. Dispatched by each surface, never executed here. */
export function mcpFindToolsDefinition(heldServers: Record<string, number>): Tool {
  const list = Object.entries(heldServers)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([s, n]) => `${s} (${n})`)
    .join(', ')
  return {
    description:
      'More MCP tools are connected than fit in this request. Search them by what you need ' +
      '(e.g. "decompile function", "list github issues"); the matching tools are added to ' +
      `your tools from your next step, then call them directly. Held back: ${list}.`,
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the tool should do, in a few words.' },
        server: { type: 'string', description: 'Optional: only search this server.' },
      },
      required: ['query'],
      additionalProperties: false,
    }),
  } as Tool
}

/** Info for budgeting, read from an advertised tool. */
export function mcpToolInfo(name: string, server: string, tool: unknown): McpToolInfo {
  const t = (tool ?? {}) as { description?: unknown; inputSchema?: unknown }
  return {
    name,
    server,
    description: typeof t.description === 'string' ? t.description : '',
    tokens: estimateToolTokens(name, { description: t.description, inputSchema: t.inputSchema }),
  }
}

// ---------------------------------------------------------------------------
// Per-conversation state: what is held and what `mcp_find_tools` unlocked.

type Deck = { held: McpToolInfo[]; unlocked: Set<string>; offered: Set<string> }
const decks = new Map<string, Deck>()

function deck(key: string): Deck {
  let d = decks.get(key)
  if (!d) {
    d = { held: [], unlocked: new Set(), offered: new Set() }
    decks.set(key, d)
  }
  return d
}

export function mcpUnlocked(key: string): ReadonlySet<string> {
  return decks.get(key)?.unlocked ?? new Set()
}

export function setMcpHeld(key: string, held: McpToolInfo[]): void {
  deck(key).held = held
}

export function resetMcpDeck(key: string): void {
  decks.delete(key)
}

/** Handles a `mcp_find_tools` call for conversation `key`; returns the model-facing text. */
export function runMcpFindTools(key: string, input: unknown): { output: string; isError?: boolean } {
  const { query = '', server } = (input ?? {}) as { query?: unknown; server?: unknown }
  const d = deck(key)
  if (d.held.length === 0) {
    return { output: 'No MCP tools are held back: every connected tool is already offered.' }
  }
  const found = findHeldTools(
    d.held,
    typeof query === 'string' ? query : '',
    typeof server === 'string' && server.trim() ? server.trim() : undefined
  )
  if (found.length === 0) {
    const servers = [...new Set(d.held.map((t) => t.server))].sort().join(', ')
    return {
      output: `No held MCP tool matched. Try other words, or name a server: ${servers}.`,
      isError: true,
    }
  }
  for (const t of found) d.unlocked.add(t.name)
  d.held = d.held.filter((t) => !d.unlocked.has(t.name))
  const lines = found.map((t) => `- ${t.name} (${t.server}): ${t.description.split('\n')[0].slice(0, 160)}`)
  return {
    output: `These tools are now available from your next step; call them directly:\n${lines.join('\n')}`,
  }
}

type RankMessage = { role: string; parts?: ReadonlyArray<unknown>; content?: unknown }

/** Recent user text and the servers of recently called tools, from a UI message list. */
export function mcpRankContextFrom(
  messages: ReadonlyArray<RankMessage>,
  serverOf: (toolName: string) => string | undefined,
  unlocked?: ReadonlySet<string>
): McpRankContext {
  const queries: string[] = []
  const recentServers: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    // UI messages carry `parts`; model messages (Rooms) carry `content`.
    const parts: ReadonlyArray<unknown> = Array.isArray(m.parts)
      ? m.parts
      : typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : Array.isArray(m.content)
          ? m.content
          : []
    if (m.role === 'user' && queries.length < 3) {
      const text = parts
        .map((p) => {
          const q = p as { type?: string; text?: unknown }
          return q.type === 'text' && typeof q.text === 'string' ? q.text : ''
        })
        .join(' ')
        .trim()
      if (text) queries.unshift(text)
    }
    if (m.role === 'assistant' && recentServers.length < 4) {
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j] as { type?: string; toolName?: unknown }
        const name =
          (p.type === 'dynamic-tool' || p.type === 'tool-call') && typeof p.toolName === 'string'
            ? p.toolName
            : typeof p.type === 'string' && p.type.startsWith('tool-')
              ? p.type.slice(5)
              : undefined
        const server = name ? serverOf(name) : undefined
        if (server && !recentServers.includes(server)) recentServers.push(server)
      }
    }
  }
  return { queries, recentServers, unlocked }
}

/**
 * Applies the budget to an advertised tool record in place of the caller's
 * own bookkeeping: returns the record to send and records what was held for
 * conversation `key`. Tools `serverOf` does not know are never touched.
 */
export function budgetMcpTools<T>(
  tools: Record<string, T>,
  serverOf: (toolName: string) => string | undefined,
  key: string,
  windowTokens: number,
  messages: ReadonlyArray<RankMessage>
): Record<string, T | Tool> {
  const infos: McpToolInfo[] = []
  for (const [name, tool] of Object.entries(tools)) {
    if (name === MCP_FIND_TOOLS_NAME) continue
    const server = serverOf(name)
    if (server) infos.push(mcpToolInfo(name, server, tool))
  }
  const withoutMeta = Object.fromEntries(
    Object.entries(tools).filter(([n]) => n !== MCP_FIND_TOOLS_NAME)
  ) as Record<string, T | Tool>
  if (infos.length === 0) {
    setMcpHeld(key, [])
    return withoutMeta
  }
  const ctx = {
    ...mcpRankContextFrom(messages, serverOf, mcpUnlocked(key)),
    previous: deck(key).offered,
  }
  const { offered, held } = fitMcpTools(infos, mcpToolBudget(windowTokens), ctx)
  deck(key).offered = new Set(offered)
  const heldSet = new Set(held)
  setMcpHeld(key, infos.filter((t) => heldSet.has(t.name)))
  if (held.length === 0) return withoutMeta
  const out: Record<string, T | Tool> = {}
  for (const [name, tool] of Object.entries(withoutMeta)) {
    if (!heldSet.has(name)) out[name] = tool
  }
  const perServer: Record<string, number> = {}
  for (const t of infos) if (heldSet.has(t.name)) perServer[t.server] = (perServer[t.server] ?? 0) + 1
  out[MCP_FIND_TOOLS_NAME] = mcpFindToolsDefinition(perServer)
  return out
}
