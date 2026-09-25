/**
 * The detail line the chat Details panel's Activity card shows for a generic
 * tool call: the argument it acted on, whether it worked, how long it took
 * and which MCP server ran it.
 */
import { formatDuration } from '@/lib/utils'

/** Input keys that name what a call acted on, most telling first. */
const MAIN_ARG_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'query',
  'url',
  'pattern',
  'name',
  'id',
]

const MAX_ARG_LENGTH = 60

const truncate = (text: string, max = MAX_ARG_LENGTH) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** The one argument that says what a tool call was about, on one line. */
export function mainArgOf(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of MAIN_ARG_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim())
      return truncate(value.trim().replace(/\s+/g, ' '))
    if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      return truncate(value.join(' '))
  }
  return ''
}

/** Whether a settled call failed: an error state or an MCP `isError` result. */
export function toolCallFailed(state: string | undefined, output: unknown) {
  if (state === 'output-error') return true
  return Boolean(
    output &&
      typeof output === 'object' &&
      (output as { isError?: unknown }).isError === true
  )
}

/**
 * The detail line of a generic tool call in Activity: what it acted on,
 * whether it worked, how long it took and which server ran it.
 */
export function describeToolCall({
  input,
  output,
  state,
  startedAt,
  endedAt,
  server,
  labels,
}: {
  input: unknown
  output: unknown
  state?: string
  startedAt?: number
  endedAt?: number
  server?: string
  labels: { ok: string; failed: string }
}): string {
  return [
    mainArgOf(input),
    toolCallFailed(state, output) ? labels.failed : labels.ok,
    startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
      ? formatDuration(startedAt, endedAt)
      : '',
    server ?? '',
  ]
    .filter(Boolean)
    .join(' · ')
}
