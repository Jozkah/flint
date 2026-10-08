/**
 * A reply for a run that ended without one.
 *
 * When the model's last step after tool calls produces no text (a tool
 * failed, the sandbox could not start, the model gave up), the chat used to
 * show only the tool trace and no answer. This builds a short fallback line
 * naming the last tool failure so the user is not left with nothing.
 *
 * A turn with no tool calls and no text at all (the model streamed nothing,
 * or only reasoning) gets a fallback too: otherwise the chat shows an empty
 * bubble and the user cannot tell the turn ended.
 */
import type { MessagePartLike } from '@/containers/message/types'

const MAX_ERROR_CHARS = 300

/** Shown for a finished turn with no text and no tool calls. */
export const EMPTY_REPLY_FALLBACK =
  'The model returned an empty reply. Try again or switch model.'

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (Array.isArray(value)) {
    const joined = value
      .map((v) =>
        typeof v === 'string'
          ? v
          : v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string'
            ? (v as { text: string }).text
            : ''
      )
      .join(' ')
      .trim()
    return joined || undefined
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return textOf(o.message) ?? textOf(o.error) ?? textOf(o.content)
  }
  return undefined
}

/** The error a finished tool part reports, if it failed. */
export function toolPartError(part: MessagePartLike): string | undefined {
  if (!part.type.startsWith('tool-')) return undefined
  if (part.state === 'output-error') {
    return textOf(part.errorText) ?? textOf(part.error) ?? 'unknown error'
  }
  if (part.state === 'output-available') {
    const out = part.output as Record<string, unknown> | undefined
    if (!out || typeof out !== 'object') return undefined
    if (out.isError === true) return textOf(out.content) ?? 'unknown error'
    if (out.error !== undefined && out.error !== null && out.error !== false) {
      return textOf(out.error) ?? 'unknown error'
    }
  }
  return undefined
}

/**
 * Whether a tool call failed because the tool was not offered to the model --
 * what a model does when it expects tools and its tool calls are switched off.
 */
export function calledUnavailableTool(parts: readonly MessagePartLike[]): boolean {
  return parts.some((part) => {
    const error = toolPartError(part)
    return (
      !!error &&
      /unavailable tool|no tools are available|does not exist here/i.test(error)
    )
  })
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_ERROR_CHARS ? `${one.slice(0, MAX_ERROR_CHARS)}…` : one
}

/**
 * The fallback reply for a finished assistant message that has no answer:
 * tool calls not followed by any text, or no text and no tool calls at all.
 * Null when it has an answer, or a tool is still running. The caller only
 * asks once the message has stopped streaming.
 */
export function emptyRunFallback(parts: readonly MessagePartLike[]): string | null {
  let lastTool = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type.startsWith('tool-')) {
      lastTool = i
      break
    }
  }
  if (lastTool === -1) {
    const answered = parts.some(
      (p) => (p.type === 'text' && !!p.text?.trim()) || p.type === 'file'
    )
    return answered ? null : EMPTY_REPLY_FALLBACK
  }
  const answered = parts
    .slice(lastTool + 1)
    .some((p) => (p.type === 'text' && !!p.text?.trim()) || p.type === 'file')
  if (answered) return null
  // A tool still waiting or running: the run has not ended.
  const unsettled = parts.some(
    (p) =>
      p.type.startsWith('tool-') &&
      p.state !== undefined &&
      p.state !== 'output-available' &&
      p.state !== 'output-error'
  )
  if (unsettled) return null
  let lastError: string | undefined
  let toolName = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const err = toolPartError(parts[i])
    if (err) {
      lastError = err
      toolName = parts[i].type.slice('tool-'.length)
      break
    }
  }
  if (!lastError) return 'The run ended without a reply.'
  return `The run ended without a reply. Last tool error (${toolName}): ${clip(lastError)}`
}
