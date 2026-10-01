import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider'
import {
  findMarker,
  parseTextToolCalls,
  partialMarkerLength,
  type ArgTypes,
  type TextToolCall,
} from '@/lib/textToolCalls'

/**
 * Turns tool calls a model wrote as text into real tool calls.
 *
 * Only acts when the request carries tools, only converts calls that name one
 * of them, and stands down for a response that already has a structured tool
 * call. Anything it cannot parse is passed through unchanged.
 */

interface Context {
  names: Set<string>
  types: ArgTypes
}

function contextFor(params: LanguageModelV3CallOptions): Context | null {
  const names = new Set<string>()
  const types: ArgTypes = {}
  for (const tool of params.tools ?? []) {
    if (tool.type !== 'function') continue
    names.add(tool.name)
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> })
      ?.properties
    if (!properties) continue
    types[tool.name] = {}
    for (const [key, schema] of Object.entries(properties)) {
      const type = (schema as { type?: unknown } | null)?.type
      if (typeof type === 'string') types[tool.name][key] = type
    }
  }
  return names.size > 0 ? { names, types } : null
}

let counter = 0
function callId(): string {
  counter += 1
  return `call_text_${Date.now().toString(36)}_${counter}`
}

function toToolCallPart(call: TextToolCall) {
  return {
    type: 'tool-call' as const,
    toolCallId: callId(),
    toolName: call.name,
    input: JSON.stringify(call.args),
  }
}

/** Parse `text` from its first marker onward; null leaves the text alone. */
function convert(
  text: string,
  context: Context
): { before: string; calls: TextToolCall[]; rest: string } | null {
  const at = findMarker(text)
  if (at === -1) return null
  const parsed = parseTextToolCalls(text.slice(at), context.types)
  if (!parsed || !parsed.calls.every((c) => context.names.has(c.name))) {
    return null
  }
  return { before: text.slice(0, at), calls: parsed.calls, rest: parsed.rest }
}

function asToolCalls(reason: LanguageModelV3FinishReason): LanguageModelV3FinishReason {
  return reason.unified === 'stop' ? { ...reason, unified: 'tool-calls' } : reason
}

interface BlockState {
  /** Text held back because it may be the start of a marker. */
  pending: string
  /** Everything from the marker onward, once one was seen. */
  captured: string | null
}

export function textToolCallMiddleware(): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',

    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate()
      const context = contextFor(params)
      if (!context || result.content.some((part) => part.type === 'tool-call')) {
        return result
      }
      const content: LanguageModelV3Content[] = []
      let converted = false
      for (const part of result.content) {
        const found = part.type === 'text' ? convert(part.text, context) : null
        if (!found) {
          content.push(part)
          continue
        }
        converted = true
        const text = `${found.before}${found.before && found.rest ? '\n' : ''}${found.rest}`.trim()
        if (text) content.push({ type: 'text', text })
        for (const call of found.calls) content.push(toToolCallPart(call))
      }
      return converted
        ? { ...result, content, finishReason: asToolCalls(result.finishReason) }
        : result
    },

    wrapStream: async ({ doStream, params }) => {
      const result = await doStream()
      const context = contextFor(params)
      if (!context) return result

      const blocks = new Map<string, BlockState>()
      let nativeToolCall = false
      // Held until the end: a structured call from the server wins over one
      // recovered from text, so the two can never both run.
      const deferred: TextToolCall[] = []

      const emitText = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        id: string,
        delta: string
      ) => {
        if (delta) controller.enqueue({ type: 'text-delta', id, delta })
      }

      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
          transform(part, controller) {
            if (part.type === 'tool-call' || part.type === 'tool-input-start') {
              nativeToolCall = true
            }

            if (nativeToolCall && part.type !== 'finish') {
              // Release anything held; a structured call means text is just text.
              for (const [id, block] of blocks) {
                emitText(controller, id, block.pending + (block.captured ?? ''))
                block.pending = ''
                block.captured = null
              }
              controller.enqueue(part)
              return
            }

            switch (part.type) {
              case 'text-start':
                blocks.set(part.id, { pending: '', captured: null })
                controller.enqueue(part)
                return

              case 'text-delta': {
                const block = blocks.get(part.id)
                if (!block) {
                  controller.enqueue(part)
                  return
                }
                if (block.captured !== null) {
                  block.captured += part.delta
                  return
                }
                const text = block.pending + part.delta
                const at = findMarker(text)
                if (at !== -1) {
                  emitText(controller, part.id, text.slice(0, at))
                  block.pending = ''
                  block.captured = text.slice(at)
                  return
                }
                const keep = partialMarkerLength(text)
                emitText(controller, part.id, text.slice(0, text.length - keep))
                block.pending = text.slice(text.length - keep)
                return
              }

              case 'text-end': {
                const block = blocks.get(part.id)
                blocks.delete(part.id)
                if (!block) {
                  controller.enqueue(part)
                  return
                }
                const held = block.captured ?? ''
                const found = held ? convert(held, context) : null
                if (found) {
                  emitText(controller, part.id, found.rest)
                  controller.enqueue(part)
                  deferred.push(...found.calls)
                } else {
                  emitText(controller, part.id, block.pending + held)
                  controller.enqueue(part)
                }
                return
              }

              case 'finish': {
                const recovered = nativeToolCall ? [] : deferred
                for (const call of recovered) {
                  controller.enqueue(toToolCallPart(call))
                }
                controller.enqueue(
                  recovered.length > 0
                    ? { ...part, finishReason: asToolCalls(part.finishReason) }
                    : part
                )
                return
              }

              default:
                controller.enqueue(part)
            }
          },
        })
      )

      return { ...result, stream }
    },
  }
}
