import type { UIMessage } from '@ai-sdk/react'

/**
 * A server can accept images in principle and still refuse them: vLLM started
 * with `--limit-mm-per-prompt image=0` (or serving a text-only config of a
 * vision model) answers "At most 0 image(s) may be provided in one prompt."
 * The model's own capabilities say it can see, so the only way to know is the
 * refusal. It is learned per model for the session, and the next request is
 * sent without images (or with only the newest N, when the limit is above 0).
 */
const IMAGE_LIMIT_RE = /at most (\d+) image\(?s?\)? may be provided/i

const textOf = (failure: unknown): string => {
  if (failure == null) return ''
  if (typeof failure === 'string') return failure
  const parts: string[] = []
  const record = failure as { message?: unknown; data?: unknown }
  if (typeof record.message === 'string') parts.push(record.message)
  if (record.data != null) {
    try {
      parts.push(
        typeof record.data === 'string'
          ? record.data
          : JSON.stringify(record.data)
      )
    } catch {
      // Unserializable detail: the message above is what there is.
    }
  }
  return parts.join(' ')
}

/** The per-prompt image limit a refusal names, or null when it is not one. */
export function parseImageLimit(failure: unknown): number | null {
  const match = IMAGE_LIMIT_RE.exec(textOf(failure))
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}

const learned = new Map<string, number>()

export const imageLimitKey = (provider: string, modelId: string): string =>
  `${provider}/${modelId}`

export const imageLimitFor = (key: string): number | undefined =>
  learned.get(key)

export const rememberImageLimit = (key: string, limit: number): void => {
  learned.set(key, Math.max(0, Math.floor(limit)))
}

/** For tests. */
export const forgetImageLimits = (): void => learned.clear()

const isImagePart = (part: unknown): boolean => {
  const p = part as { type?: string; mediaType?: string } | null
  if (!p) return false
  if (p.type === 'image') return true
  return (
    p.type === 'file' &&
    typeof p.mediaType === 'string' &&
    p.mediaType.startsWith('image/')
  )
}

/** Keep only the newest `max` images in a conversation; older ones are dropped. */
export function limitImageParts(
  messages: UIMessage[],
  max: number
): UIMessage[] {
  let budget = Math.max(0, Math.floor(max))
  const out: UIMessage[] = new Array(messages.length)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const parts = Array.isArray(message.parts) ? message.parts : []
    if (!parts.some(isImagePart)) {
      out[i] = message
      continue
    }
    const kept: typeof parts = []
    for (let j = parts.length - 1; j >= 0; j--) {
      if (!isImagePart(parts[j])) {
        kept.unshift(parts[j])
      } else if (budget > 0) {
        budget -= 1
        kept.unshift(parts[j])
      }
    }
    out[i] = { ...message, parts: kept } as UIMessage
  }
  return out
}
