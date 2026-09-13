/**
 * What changed in the model's context between two requests. AH-086.
 *
 * Both sides are prompt snapshots (AH-078): the exact payloads that were
 * dispatched, redacted before they were stored. Nothing here re-derives a
 * payload; it compares what was sent. Each change says why, as far as the
 * payloads themselves can tell:
 *
 * - a message that was not there before: the new question, the model's
 *   answer or tool call from the previous step, a tool result, steering;
 * - a message that is no longer there: it left the window -- trimmed or
 *   compacted to make room;
 * - a system block that appeared or went: memory recalled or withheld,
 *   instructions added or changed;
 * - a tool offered or no longer offered.
 */

export type ContextItem = {
  /** `message` or `system` or `tool`. */
  part: 'message' | 'system' | 'tool'
  /** For a message, its role; for a tool, its name; for system, a label. */
  label: string
  /** A short preview of the text, bounded. */
  preview: string
  /** Why it entered or left. */
  reason: string
}

export type ContextDiff = {
  entered: ContextItem[]
  left: ContextItem[]
  /** Messages present in both, in the same order. */
  keptMessages: number
  /** Tools present in both. */
  keptTools: number
  systemChanged: boolean
}

type Msg = { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown; name?: unknown }

const PREVIEW = 160

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join(' ')
  }
  return content == null ? '' : JSON.stringify(content)
}

const preview = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > PREVIEW ? `${one.slice(0, PREVIEW)}…` : one
}

/** A stable identity for a message: role, the call it answers, and its text. */
function keyOf(m: Msg): string {
  const calls = Array.isArray(m.tool_calls)
    ? (m.tool_calls as { id?: unknown; function?: { name?: unknown } }[])
        .map((c) => `${String(c.id ?? '')}:${String(c.function?.name ?? '')}`)
        .join(',')
    : ''
  return `${String(m.role ?? '')}|${String(m.tool_call_id ?? '')}|${calls}|${textOf(m.content)}`
}

function messagesOf(payload: unknown): Msg[] {
  const p = payload as { messages?: unknown } | null
  return Array.isArray(p?.messages) ? (p!.messages as Msg[]) : []
}

function toolsOf(payload: unknown): string[] {
  const p = payload as { tools?: unknown } | null
  if (!Array.isArray(p?.tools)) return []
  return (p!.tools as { function?: { name?: unknown }; name?: unknown }[])
    .map((t) => String(t.function?.name ?? t.name ?? ''))
    .filter(Boolean)
}

/** A system prompt split into its blocks (paragraphs separated by a blank line). */
function systemBlocks(messages: Msg[]): string[] {
  return messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => textOf(m.content).split(/\n{2,}/))
    .map((b) => b.trim())
    .filter(Boolean)
}

function whyEntered(m: Msg, isLast: boolean): string {
  const role = String(m.role ?? '')
  const text = textOf(m.content)
  if (role === 'user' && /^\s*\[steering\]/i.test(text)) return 'steering typed during the run'
  if (role === 'user') return isLast ? 'the new request' : 'a user message'
  if (role === 'assistant') {
    return Array.isArray(m.tool_calls) && m.tool_calls.length > 0
      ? "the model's tool call from the previous step"
      : "the model's previous answer"
  }
  if (role === 'tool') return 'a tool result'
  return `a ${role || 'new'} message`
}

function whySystem(block: string, entered: boolean): string {
  if (/<\/?remembered_facts>|\[mem-[\w-]+\]/.test(block) || /remember/i.test(block)) {
    return entered ? 'memory recalled for this request' : 'memory no longer recalled'
  }
  if (/JAN\.md|CLAUDE\.md|AGENTS\.md|instructions/i.test(block)) {
    return entered ? 'project instructions added or changed' : 'project instructions removed or changed'
  }
  return entered ? 'system prompt text added or changed' : 'system prompt text removed or changed'
}

/** Compare two dispatched payloads: `before` sent first, `after` next. */
export function diffContext(before: unknown, after: unknown): ContextDiff {
  const a = messagesOf(before).filter((m) => m.role !== 'system')
  const b = messagesOf(after).filter((m) => m.role !== 'system')
  const aKeys = a.map(keyOf)
  const bKeys = b.map(keyOf)

  // Messages kept are the longest common subsequence: a window that drops its
  // oldest turns and appends new ones keeps the middle in order.
  const n = aKeys.length
  const m = bKeys.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = aKeys[i] === bKeys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const keptA = new Set<number>()
  const keptB = new Set<number>()
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (aKeys[i] === bKeys[j]) {
      keptA.add(i)
      keptB.add(j)
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++
    else j++
  }

  const entered: ContextItem[] = []
  const left: ContextItem[] = []
  const lastUser = b.map((x) => x.role).lastIndexOf('user')
  b.forEach((msg, j) => {
    if (keptB.has(j)) return
    entered.push({
      part: 'message',
      label: String(msg.role ?? 'message'),
      preview: preview(textOf(msg.content) || keyOf(msg)),
      reason: whyEntered(msg, j === lastUser),
    })
  })
  a.forEach((msg, i) => {
    if (keptA.has(i)) return
    left.push({
      part: 'message',
      label: String(msg.role ?? 'message'),
      preview: preview(textOf(msg.content) || keyOf(msg)),
      reason: 'left the window: trimmed or compacted to make room',
    })
  })

  const sysA = systemBlocks(messagesOf(before))
  const sysB = systemBlocks(messagesOf(after))
  const setA = new Set(sysA)
  const setB = new Set(sysB)
  for (const block of sysB) {
    if (!setA.has(block)) {
      entered.push({ part: 'system', label: 'system', preview: preview(block), reason: whySystem(block, true) })
    }
  }
  for (const block of sysA) {
    if (!setB.has(block)) {
      left.push({ part: 'system', label: 'system', preview: preview(block), reason: whySystem(block, false) })
    }
  }

  const toolsA = new Set(toolsOf(before))
  const toolsB = new Set(toolsOf(after))
  for (const t of toolsB) {
    if (!toolsA.has(t)) entered.push({ part: 'tool', label: t, preview: t, reason: 'offered to the model' })
  }
  for (const t of toolsA) {
    if (!toolsB.has(t)) left.push({ part: 'tool', label: t, preview: t, reason: 'no longer offered' })
  }

  return {
    entered,
    left,
    keptMessages: keptB.size,
    keptTools: [...toolsB].filter((t) => toolsA.has(t)).length,
    systemChanged: sysA.join('\n\n') !== sysB.join('\n\n'),
  }
}

/** The snapshot sent just before `id` in the same session, from a session's list. */
export function previousSnapshot<T extends { id: string; at: string }>(
  list: T[],
  id: string
): T | undefined {
  const sorted = list.slice().sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))
  const at = sorted.findIndex((s) => s.id === id)
  return at > 0 ? sorted[at - 1] : undefined
}
