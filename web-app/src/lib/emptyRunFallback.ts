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
import { i18n } from '@/i18n/react-i18next-compat'

const MAX_ERROR_CHARS = 300

type StepEnd = { finishReason?: unknown; outputTokens?: unknown }

/** How the model's last step ended, when it said: `{ reason, tokens }`. */
export function stepEndDetail(
  stepEnd?: StepEnd
): { reason: string; tokens: number | string } | null {
  const reason =
    typeof stepEnd?.finishReason === 'string' ? stepEnd.finishReason : ''
  if (!reason) return null
  const tokens =
    typeof stepEnd?.outputTokens === 'number' ? stepEnd.outputTokens : '?'
  return { reason, tokens }
}

/** Shown for a finished turn with no text and no tool calls. */
const emptyReplyFallback = (stepEnd?: StepEnd) => {
  const detail = stepEndDetail(stepEnd)
  return detail
    ? i18n.t('chat:emptyRun.emptyReplyDetail', detail)
    : i18n.t('chat:emptyRun.emptyReply')
}

/**
 * Whether a message error is the "finished without a reply" banner the chat
 * stamps on a turn whose reply came back empty. That banner already says it,
 * so the empty-reply line under the assistant stub would repeat it.
 */
export function isEmptyReplyBanner(error: unknown): boolean {
  if (typeof error !== 'string' || !error) return false
  if (error === i18n.t('model-errors:emptyReply')) return true
  const template = i18n.t('model-errors:emptyReplyDetail', {
    reason: '\u0001',
    tokens: '\u0002',
    interpolation: { escapeValue: false },
  })
  const pattern = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace('\u0001', '.*')
    .replace('\u0002', '.*')
  return new RegExp(`^${pattern}$`, 's').test(error)
}

/** Shown when the model reasoned but produced no answer and no tool calls. */
const thinkingOnlyFallback = () => i18n.t('chat:emptyRun.thinkingOnly')

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
 *
 * Null too when the request itself failed (`failed`: a 401, a refused
 * connection): the error is shown, and "the model returned an empty reply"
 * above it would point at the wrong cause.
 */
export function emptyRunFallback(
  parts: readonly MessagePartLike[],
  {
    failed = false,
    stepEnd,
  }: { failed?: boolean; stepEnd?: StepEnd } = {}
): string | null {
  if (failed) return null
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
    if (answered) return null
    const reasoned = parts.some(
      (p) => p.type === 'reasoning' && !!(p.text ?? '').trim()
    )
    return reasoned ? thinkingOnlyFallback() : emptyReplyFallback(stepEnd)
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
  if (!lastError) {
    // No tool failed, so the model itself answered nothing: say how its last
    // step ended (finish reason, tokens) so the cause can be told from the UI.
    const detail = stepEndDetail(stepEnd)
    if (!detail) return i18n.t('chat:emptyRun.noReply')
    return i18n.t('chat:emptyRun.noReplyDetail', detail)
  }
  // The tool error says why the work stopped; how the model's last step ended
  // says whether it then answered nothing or never got to answer.
  const toolError = i18n.t('chat:emptyRun.noReplyToolError', {
    tool: toolName,
    error: clip(lastError),
  })
  const ended = stepEndDetail(stepEnd)
  return ended ? `${toolError} ${i18n.t('chat:emptyRun.stepEnded', ended)}` : toolError
}
