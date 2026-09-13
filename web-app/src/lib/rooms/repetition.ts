/**
 * Repetition detection: normalised word 3-shingle Jaccard similarity of a new
 * turn against recent speech (docs/DISCUSSION_ROOMS.md, "Repetition").
 */
import type { RoomMessage } from './types'

export function normaliseWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

export function shingles(text: string, size = 3): Set<string> {
  const words = normaliseWords(text)
  const out = new Set<string>()
  if (words.length === 0) return out
  if (words.length < size) {
    out.add(words.join(' '))
    return out
  }
  for (let i = 0; i + size <= words.length; i++) {
    out.add(words.slice(i, i + size).join(' '))
  }
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const s of a) if (b.has(s)) inter++
  return inter / (a.size + b.size - inter)
}

export function similarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b))
}

/** The last `2 × activeCount` participant speech messages (excluding `exceptId`). */
export function recentSpeech(
  messages: RoomMessage[],
  activeCount: number,
  exceptId?: string
): RoomMessage[] {
  const window = Math.max(2, 2 * activeCount)
  const speech = messages.filter(
    (m) =>
      m.kind === 'speech' &&
      m.author.kind === 'participant' &&
      m.id !== exceptId &&
      m.text.trim() !== ''
  )
  return speech.slice(-window)
}

export function maxSimilarity(text: string, recent: RoomMessage[]): number {
  const mine = shingles(text)
  let best = 0
  for (const m of recent) best = Math.max(best, jaccard(mine, shingles(m.text)))
  return best
}

/** Whether `text` is a near-duplicate of any recent speech. */
export function isRepetitive(
  text: string,
  recent: RoomMessage[],
  threshold: number
): boolean {
  if (normaliseWords(text).length === 0) return false
  return maxSimilarity(text, recent) >= threshold
}
