/**
 * OpenRouter carries a reasoning model's encrypted state (Gemini 3 thought
 * signatures among it) in `reasoning_details`, and rejects the follow-up
 * request of a tool loop with a 400 unless the assistant tool-call message
 * is sent back with them unmodified. @ai-sdk/openai-compatible neither reads
 * nor replays that field, so this fetch wrapper does: it records the details
 * from each response against the tool call ids, and re-attaches them to the
 * matching assistant message in the next request. janhq/jan#283.
 */

type Json = Record<string, unknown>

const MAX_ENTRIES = 200
const store = new Map<string, unknown[]>()

function remember(toolCallIds: string[], details: unknown[]): void {
  if (!details.length) return
  for (const id of toolCallIds) {
    store.delete(id)
    store.set(id, details)
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

/** Test hook. */
export function clearReasoningDetails(): void {
  store.clear()
}

function mergeDetail(into: unknown[], item: unknown): void {
  const last = into[into.length - 1] as Json | undefined
  const cur = item as Json
  if (
    last &&
    cur &&
    typeof cur === 'object' &&
    last.type === cur.type &&
    last.index !== undefined &&
    last.index === cur.index
  ) {
    for (const key of ['text', 'summary'] as const) {
      if (typeof last[key] === 'string' && typeof cur[key] === 'string') {
        last[key] = (last[key] as string) + (cur[key] as string)
        if (cur.signature !== undefined) last.signature = cur.signature
        return
      }
    }
  }
  into.push(item && typeof item === 'object' ? { ...(item as Json) } : item)
}

/** Collects details and tool call ids from parsed chunks / a full response. */
class Collector {
  details: unknown[] = []
  ids: string[] = []

  add(choice: Json | undefined): void {
    if (!choice) return
    const holder = (choice.delta ?? choice.message) as Json | undefined
    if (!holder) return
    if (Array.isArray(holder.reasoning_details)) {
      for (const d of holder.reasoning_details) mergeDetail(this.details, d)
    }
    if (Array.isArray(holder.tool_calls)) {
      for (const tc of holder.tool_calls as Json[]) {
        if (typeof tc?.id === 'string' && tc.id && !this.ids.includes(tc.id))
          this.ids.push(tc.id)
      }
    }
  }

  commit(): void {
    if (this.ids.length) remember(this.ids, this.details)
  }
}

function feedSseLine(c: Collector, line: string): void {
  if (!line.startsWith('data:')) return
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return
  try {
    const json = JSON.parse(payload) as Json
    c.add((json.choices as Json[] | undefined)?.[0])
  } catch {
    // partial or non-JSON event: ignore
  }
}

/** Re-attaches stored details to assistant tool-call messages. */
export function injectReasoningDetails(body: Json): boolean {
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const msg of messages as Json[]) {
    if (!msg || msg.role !== 'assistant' || msg.reasoning_details) continue
    const calls = msg.tool_calls
    if (!Array.isArray(calls)) continue
    for (const tc of calls as Json[]) {
      const details = typeof tc?.id === 'string' ? store.get(tc.id) : undefined
      if (details) {
        msg.reasoning_details = details
        changed = true
        break
      }
    }
  }
  return changed
}

export function withOpenRouterReasoningDetails(
  inner: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    if (
      (init?.method === 'POST' || !init?.method) &&
      typeof init?.body === 'string'
    ) {
      try {
        const body = JSON.parse(init.body)
        if (injectReasoningDetails(body)) {
          init = { ...init, body: JSON.stringify(body) }
        }
      } catch {
        // non-JSON body; send as is
      }
    }
    const res = await inner(input, init)
    if (!res.ok || !res.body) return res
    const type = res.headers.get('content-type') ?? ''
    const c = new Collector()
    if (type.includes('text/event-stream')) {
      const decoder = new TextDecoder()
      let buf = ''
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          buf += decoder.decode(chunk, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const l of lines) feedSseLine(c, l.trim())
        },
        flush() {
          if (buf) feedSseLine(c, buf.trim())
          c.commit()
        },
      })
      return new Response(res.body.pipeThrough(tap), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    }
    if (type.includes('json')) {
      try {
        const json = (await res.clone().json()) as Json
        c.add((json.choices as Json[] | undefined)?.[0])
        c.commit()
      } catch {
        // unreadable body: nothing to record
      }
    }
    return res
  }
}
