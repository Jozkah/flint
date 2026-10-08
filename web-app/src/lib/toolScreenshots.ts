/**
 * The agent `browser` tool's screenshots, as the model sees them on the desktop.
 *
 * A tool result on the desktop is text: it is stored in the thread, counted
 * against the context window by its characters, and replayed on every request.
 * A picture carried inside it would be megabytes of base64 in the stored
 * thread, and would be counted as if it were that many words. So the picture
 * is kept beside the transcript instead -- in memory, a few at a time, each
 * bounded -- and attached to the request only for a model that can see, and
 * only while its result is recent. Everything else about the result stays text,
 * so a model that cannot see (and every other tool) is unchanged.
 */
import type { UIMessage } from 'ai'

/** What a small JPEG screenshot costs a vision model, for the context budget. */
export const SCREENSHOT_TOKEN_ESTIMATE = 1500
/** Pictures kept, and attached to a request, at most. */
export const MAX_KEPT_SCREENSHOTS = 3
/** A picture larger than this (as a data URL) is not kept. */
export const MAX_SCREENSHOT_CHARS = 600_000

/** Said in every screenshot result, whoever reads it. */
export const SCREENSHOT_RESULT_NOTE =
  'The screenshot is attached to this result if you can see images; otherwise it is shown to the user in the preview panel. Use snapshot to read the page either way.'

const kept = new Map<string, string>()

/** Keep the picture of tool call `toolCallId`. Oldest dropped past the limit. */
export function putToolScreenshot(toolCallId: string, dataUrl: string): boolean {
  if (
    !toolCallId ||
    !dataUrl.startsWith('data:image/') ||
    dataUrl.length > MAX_SCREENSHOT_CHARS
  ) {
    return false
  }
  kept.delete(toolCallId)
  kept.set(toolCallId, dataUrl)
  while (kept.size > MAX_KEPT_SCREENSHOTS * 2) {
    const oldest = kept.keys().next().value
    if (oldest === undefined) break
    kept.delete(oldest)
  }
  return true
}

export const getToolScreenshot = (toolCallId: string): string | undefined =>
  kept.get(toolCallId)

export const forgetToolScreenshots = (): void => kept.clear()

const CLEARED_PREFIX = '[tool result cleared:'

type UnknownRecord = Record<string, unknown>

function isBrowserResult(part: UnknownRecord): boolean {
  const type = part.type
  if (typeof type !== 'string') return false
  if (type === 'tool-browser') return true
  return type === 'dynamic-tool' && part.toolName === 'browser'
}

/**
 * The newest tool results whose picture is still kept and still worth sending:
 * finished, not cleared by microcompaction. `[messageIndex, toolCallId]`.
 */
function recentScreenshotResults(
  messages: readonly UIMessage[]
): Array<[number, string]> {
  const found: Array<[number, string]> = []
  messages.forEach((message, mi) => {
    for (const raw of Array.isArray(message.parts) ? message.parts : []) {
      const part = raw as unknown as UnknownRecord
      if (!isBrowserResult(part) || part.state !== 'output-available') continue
      const id = part.toolCallId
      if (typeof id !== 'string' || !kept.has(id)) continue
      if (
        typeof part.output === 'string' &&
        part.output.startsWith(CLEARED_PREFIX)
      ) {
        continue
      }
      found.push([mi, id])
    }
  })
  return found.slice(-MAX_KEPT_SCREENSHOTS)
}

/** How many pictures a request built from `messages` would carry. */
export function screenshotsToAttach(messages: readonly UIMessage[]): number {
  return recentScreenshotResults(messages).length
}

/**
 * `messages` with the recent browser screenshots attached, for a model that can
 * see: a user message after the assistant turn that holds the result, in the
 * form the MCP tool-result images already use. Models that cannot see get the
 * messages back untouched. Pure; the stored messages are never changed.
 */
export function attachToolScreenshots(
  messages: UIMessage[],
  opts: { supportsVision: boolean }
): UIMessage[] {
  if (!opts.supportsVision) return messages
  const recent = recentScreenshotResults(messages)
  if (recent.length === 0) return messages
  const byMessage = new Map<number, string[]>()
  for (const [mi, id] of recent) {
    byMessage.set(mi, [...(byMessage.get(mi) ?? []), id])
  }
  const out: UIMessage[] = []
  messages.forEach((message, mi) => {
    out.push(message)
    const ids = byMessage.get(mi)
    if (!ids) return
    out.push({
      id: `${message.id ?? 'msg'}_shots`,
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'Screenshot(s) from the preceding browser tool call(s):',
        },
        ...ids.map((id) => ({
          type: 'file' as const,
          mediaType: (kept.get(id) ?? '').slice(5, (kept.get(id) ?? '').indexOf(';')) || 'image/jpeg',
          url: kept.get(id) ?? '',
        })),
      ],
    } as unknown as UIMessage)
  })
  return out
}
