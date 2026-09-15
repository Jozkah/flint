/**
 * W3C-compliant SSE event-type filtering for OpenAI-compatible streams.
 *
 * The Vercel AI SDK's `parseJsonEventStream` destructures only the `data:`
 * field of each SSE event and discards the `event:` type, then validates every
 * payload against the `chat.completion.chunk` schema. Servers that interleave
 * custom named events (e.g. `event: hermes.tool.progress`) therefore trip a
 * fatal "Type validation failed" and the whole stream aborts.
 *
 * Per the SSE spec an event's type defaults to "message"; a client with no
 * handler for other types must ignore them. This filter drops every frame
 * whose event type is not the default before the SDK ever parses it.
 */

const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/

/** Returns the frame's SSE event type, defaulting to "message". */
function eventTypeOf(frame: string): string {
  let type = 'message'
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line.startsWith('event:')) continue
    let value = line.slice('event:'.length)
    if (value.startsWith(' ')) value = value.slice(1)
    // An empty event field dispatches as "message" per spec.
    type = value === '' ? 'message' : value
  }
  return type
}

const isDefaultEvent = (frame: string): boolean =>
  eventTypeOf(frame) === 'message'

/**
 * Stateful, chunk-boundary-safe filter over the raw SSE text. Feed decoded
 * string chunks to `process()`; call `flush()` once at stream end to emit any
 * trailing frame that never received a terminating blank line.
 */
export class SseEventTypeFilter {
  private buffer = ''

  process(chunk: string): string {
    this.buffer += chunk
    let out = ''
    for (;;) {
      const match = FRAME_SEPARATOR.exec(this.buffer)
      if (!match) break
      const end = match.index + match[0].length
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end)
      if (isDefaultEvent(frame)) out += frame
    }
    return out
  }

  flush(): string {
    if (!this.buffer) return ''
    const frame = this.buffer
    this.buffer = ''
    return isDefaultEvent(frame) ? frame : ''
  }
}

/** Wraps an SSE byte stream, dropping any non-default (named) event frames. */
export function filterDefaultSseEvents(
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const filter = new SseEventTypeFilter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const emit = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (text) controller.enqueue(encoder.encode(text))
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        emit(filter.process(decoder.decode(chunk, { stream: true })), controller)
      },
      flush(controller) {
        emit(filter.process(decoder.decode()), controller)
        emit(filter.flush(), controller)
      },
    })
  )
}

type OpenAiToolCall = {
  index?: unknown
  function?: { name?: unknown; [key: string]: unknown }
  [key: string]: unknown
}

/**
 * vLLM can emit parallel tool-call deltas with `function.name: null` before it
 * has produced a real function call. The AI SDK validates each delta as an
 * OpenAI chunk and aborts the whole response at that point. Keep legitimate
 * continuation deltas (which omit a name after an earlier named delta), but
 * drop a new tool-call index that has no usable name to associate with it.
 */
class OpenAiToolCallSseSanitizer {
  private buffer = ''
  private readonly names = new Map<number, string>()

  private sanitizeFrame(frame: string): string {
    const lines = frame.split(/\r\n|\n|\r/)
    const dataIndex = lines.findIndex((line) => line.startsWith('data:'))
    if (dataIndex < 0) return frame
    const raw = lines[dataIndex]!.slice('data:'.length).trimStart()
    if (!raw || raw === '[DONE]') return frame

    let payload: { choices?: unknown }
    try {
      payload = JSON.parse(raw) as { choices?: unknown }
    } catch {
      return frame
    }
    if (!Array.isArray(payload.choices)) return frame

    let changed = false
    const choices = payload.choices.flatMap((choice) => {
      if (!choice || typeof choice !== 'object') return [choice]
      const record = choice as { delta?: { tool_calls?: unknown; [key: string]: unknown } }
      const calls = record.delta?.tool_calls
      if (!Array.isArray(calls)) return [choice]

      const kept = calls.flatMap((call) => {
        if (!call || typeof call !== 'object') {
          changed = true
          return []
        }
        const toolCall = call as OpenAiToolCall
        const index = typeof toolCall.index === 'number' ? toolCall.index : undefined
        const name = toolCall.function?.name
        if (typeof name === 'string' && name.trim()) {
          if (index !== undefined) this.names.set(index, name)
          return [call]
        }
        const known = index === undefined ? undefined : this.names.get(index)
        if (!known) {
          changed = true
          return []
        }
        changed = true
        return [{ ...toolCall, function: { ...toolCall.function, name: known } }]
      })

      if (kept.length > 0) {
        return [{ ...record, delta: { ...record.delta, tool_calls: kept } }]
      }
      // A delta containing only invalid calls has no useful protocol content.
      if (Object.keys(record.delta ?? {}).every((key) => key === 'tool_calls')) {
        changed = true
        return []
      }
      return [{ ...record, delta: { ...record.delta, tool_calls: kept } }]
    })

    if (!changed) return frame
    if (choices.length === 0) return ''
    const next = JSON.stringify({ ...payload, choices })
    lines[dataIndex] = `data: ${next}`
    return lines.join('\n')
  }

  process(chunk: string): string {
    this.buffer += chunk
    let out = ''
    for (;;) {
      const match = FRAME_SEPARATOR.exec(this.buffer)
      if (!match) break
      const end = match.index + match[0].length
      out += this.sanitizeFrame(this.buffer.slice(0, end))
      this.buffer = this.buffer.slice(end)
    }
    return out
  }

  flush(): string {
    if (!this.buffer) return ''
    const frame = this.buffer
    this.buffer = ''
    return this.sanitizeFrame(frame)
  }
}

/** Removes malformed OpenAI-compatible tool-call deltas before AI SDK parsing. */
export function sanitizeOpenAiToolCallSseEvents(
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const sanitizer = new OpenAiToolCallSseSanitizer()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const emit = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (text) controller.enqueue(encoder.encode(text))
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        emit(sanitizer.process(decoder.decode(chunk, { stream: true })), controller)
      },
      flush(controller) {
        emit(sanitizer.process(decoder.decode()), controller)
        emit(sanitizer.flush(), controller)
      },
    })
  )
}
