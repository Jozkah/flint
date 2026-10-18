import { sanitizeInvalidJsonEscapes, stripCodeFence } from '@/lib/toolCallRepair'

/** Explain tool markup emitted as plain text, which never executes a tool. */
export function explainRawToolCall(text: string): string {
  return text.replace(
    /<tool_call>\s*<function=[\s\S]*?(?:<\/tool_call>|$)/gi,
    'Tool call was emitted as text. No tool ran. Check this model’s tool support and try again.'
  )
}

export function hasRawToolCall(text: string): boolean {
  return /<tool_call>\s*<function=/i.test(text)
}

/** A tool call written as JSON (`{"name", "arguments"}`, or a list of them), pretty-printed; else null. */
function prettyToolCall(text: string): string | null {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  let value: unknown
  for (const candidate of [t, sanitizeInvalidJsonEscapes(t)]) {
    try {
      value = JSON.parse(candidate)
      break
    } catch {
      // try the escape-repaired spelling next
    }
  }
  const items = Array.isArray(value) ? value : [value]
  const isCall = (v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    const r = v as Record<string, unknown>
    const fn = r.function && typeof r.function === 'object' ? (r.function as Record<string, unknown>) : r
    const args = fn.arguments ?? fn.parameters
    return typeof fn.name === 'string' && fn.name.length > 0 && args !== null && (typeof args === 'object' || typeof args === 'string')
  }
  return items.length > 0 && items.every(isCall) ? JSON.stringify(value, null, 2) : null
}

const CALL_BLOCK = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi

/**
 * Show a tool call a model wrote as text (and that therefore never ran) as a
 * code block instead of a wall of JSON: `<tool_call>` blocks, closed or still
 * streaming, and a reply that is nothing but a JSON call. `found` says whether
 * the text held one, including one the model already fenced itself.
 */
export function fenceRawToolCalls(text: string): { text: string; found: boolean } {
  let found = false
  const out = text.replace(CALL_BLOCK, (_m, body: string) => {
    found = true
    const raw = body.trim()
    const pretty = prettyToolCall(raw)
    const lang = pretty || raw.startsWith('{') || raw.startsWith('[') ? 'json' : 'xml'
    return `\n\`\`\`${lang}\n${pretty ?? raw}\n\`\`\`\n`
  })
  if (found) return { text: out.replace(/\n{3,}/g, '\n\n').trim(), found }
  const trimmed = text.trim()
  const fenced = stripCodeFence(trimmed)
  if (fenced !== undefined) return { text, found: prettyToolCall(fenced) !== null }
  const pretty = prettyToolCall(trimmed)
  return pretty ? { text: '```json\n' + pretty + '\n```', found: true } : { text, found: false }
}
