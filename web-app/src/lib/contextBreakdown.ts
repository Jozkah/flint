import type { UIMessage } from 'ai'
import { conversationText, utf8Bytes } from '@/lib/coworkContext'

/**
 * Where a request's context goes, by kind: the conversation, the tools' schemas
 * (Flint's own, and each MCP server's), skills, memory, and the system prompt
 * itself.
 *
 * The figures are estimates of what is in the payload (bytes / 4, the same
 * blunt rule as `coworkContext.ts`), taken when a request is sent. The
 * provider's own count, when there is one, decides the total shown; whatever it
 * counts beyond what was measured here is reported as "Unmeasured" rather than
 * hidden or spread across the categories.
 */

const CHARS_PER_TOKEN = 4

const tokensOf = (text: string | null | undefined): number =>
  text ? Math.round(utf8Bytes(text) / CHARS_PER_TOKEN) : 0

export type ContextChild = { label: string; tokens: number }

export type ContextSegment = {
  id:
    | 'messages'
    | 'systemTools'
    | 'mcpTools'
    | 'skills'
    | 'memory'
    | 'systemPrompt'
    | 'unmeasured'
  label: string
  tokens: number
  /** A Tailwind background class: the bar and the legend swatch share it. */
  color: string
  /** What the segment is made of, for the expanded view. */
  children?: ContextChild[]
}

export type ContextBreakdown = {
  /** When the request that was measured was sent. */
  at: number
  segments: ContextSegment[]
}

export const SEGMENT_COLORS: Record<ContextSegment['id'], string> = {
  messages: 'bg-blue-500',
  systemTools: 'bg-orange-500',
  mcpTools: 'bg-emerald-500',
  skills: 'bg-amber-500',
  memory: 'bg-violet-500',
  systemPrompt: 'bg-slate-400',
  unmeasured: 'bg-fuchsia-400',
}

const LABELS: Record<ContextSegment['id'], string> = {
  messages: 'Messages',
  systemTools: 'System tools',
  mcpTools: 'MCP tools',
  skills: 'Skills',
  memory: 'Memory files',
  systemPrompt: 'System prompt',
  unmeasured: 'Unmeasured',
}

/** Children listed before the rest are folded into one "N more" line. */
const MAX_CHILDREN = 12

export type BreakdownInput = {
  /** The system prompt exactly as sent. */
  systemPrompt: string | null | undefined
  /**
   * Texts inside that prompt to count on their own. One that is not in the
   * prompt is ignored, so a block the surface did not send costs nothing.
   */
  skillTexts?: readonly string[]
  memoryTexts?: readonly string[]
  /** The tool schemas sent, with the MCP server each came from, if any. */
  tools: readonly { name: string; schema: unknown; server?: string }[]
  messages: readonly UIMessage[]
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  } catch {
    return ''
  }
}

function childrenOf(list: ContextChild[]): ContextChild[] {
  const sorted = [...list].sort((a, b) => b.tokens - a.tokens)
  if (sorted.length <= MAX_CHILDREN) return sorted
  const rest = sorted.slice(MAX_CHILDREN)
  return [
    ...sorted.slice(0, MAX_CHILDREN),
    { label: `${rest.length} more`, tokens: rest.reduce((n, c) => n + c.tokens, 0) },
  ]
}

const insidePrompt = (prompt: string, texts: readonly string[] | undefined): string[] =>
  (texts ?? []).filter((t) => t.trim().length > 0 && prompt.includes(t))

export function buildContextBreakdown(input: BreakdownInput): ContextBreakdown {
  const prompt = input.systemPrompt ?? ''
  const skillTexts = insidePrompt(prompt, input.skillTexts)
  const memoryTexts = insidePrompt(prompt, input.memoryTexts)
  const skills = skillTexts.reduce((n, t) => n + tokensOf(t), 0)
  const memory = memoryTexts.reduce((n, t) => n + tokensOf(t), 0)
  const systemPrompt = Math.max(0, tokensOf(prompt) - skills - memory)

  const builtIn: ContextChild[] = []
  const byServer = new Map<string, number>()
  for (const tool of input.tools) {
    const tokens = tokensOf(tool.name) + tokensOf(safeJson(tool.schema))
    if (tool.server) byServer.set(tool.server, (byServer.get(tool.server) ?? 0) + tokens)
    else builtIn.push({ label: tool.name, tokens })
  }
  const mcp: ContextChild[] = [...byServer].map(([label, tokens]) => ({ label, tokens }))

  const make = (
    id: ContextSegment['id'],
    tokens: number,
    children?: ContextChild[]
  ): ContextSegment => ({
    id,
    label: LABELS[id],
    tokens,
    color: SEGMENT_COLORS[id],
    ...(children && children.length > 0 ? { children: childrenOf(children) } : {}),
  })

  const segments: ContextSegment[] = [
    make('messages', tokensOf(conversationText(input.messages))),
    make('systemTools', builtIn.reduce((n, c) => n + c.tokens, 0), builtIn),
    make('mcpTools', mcp.reduce((n, c) => n + c.tokens, 0), mcp),
    make('skills', skills),
    make('memory', memory),
    make('systemPrompt', systemPrompt),
  ]
  return { at: Date.now(), segments: segments.filter((s) => s.tokens > 0) }
}

export type ReconciledBreakdown = {
  /** The total the bar and header show. */
  usedTokens: number
  segments: ContextSegment[]
}

/**
 * Line the measured segments up with the total the counter shows.
 *
 * Everything except the messages is fixed for a request, so the messages are
 * what the total leaves over: this keeps the bar current as the conversation
 * grows past the request that was measured. A total that leaves less than was
 * measured for the messages shrinks every part in proportion (the estimate is
 * blunt, the count is not). A total that leaves more than the messages can account for is shown as "Unmeasured".
 */
export function reconcileBreakdown(
  breakdown: ContextBreakdown,
  totalTokens: number | null | undefined
): ReconciledBreakdown {
  const measured = breakdown.segments
  const sum = measured.reduce((n, s) => n + s.tokens, 0)
  const total = totalTokens && totalTokens > 0 ? totalTokens : sum
  if (total === sum) return { usedTokens: sum, segments: measured }
  // The provider counts fewer tokens than the estimates add up to (the
  // estimate is blunt and runs high on some text): believe the count, and shrink
  // every part by the same factor so the bar, the rows and the ring agree.
  if (total < sum) {
    const k = total / sum
    const shrink = (n: number) => Math.round(n * k)
    return {
      usedTokens: total,
      segments: measured.map((s) => ({
        ...s,
        tokens: shrink(s.tokens),
        ...(s.children
          ? { children: s.children.map((c) => ({ ...c, tokens: shrink(c.tokens) })) }
          : {}),
      })),
    }
  }
  const extra = total - sum
  const messages = measured.find((s) => s.id === 'messages')
  // The conversation grew since the request was measured: that is where the
  // extra is. Without a measured conversation, it is unmeasured.
  if (messages) {
    return {
      usedTokens: total,
      segments: measured.map((s) => (s === messages ? { ...s, tokens: s.tokens + extra } : s)),
    }
  }
  return {
    usedTokens: total,
    segments: [...measured, make0('unmeasured', extra)],
  }
}

function make0(id: ContextSegment['id'], tokens: number): ContextSegment {
  return { id, label: LABELS[id], tokens, color: SEGMENT_COLORS[id] }
}
