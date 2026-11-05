/** Pure helpers of the room engine: transcript chunking, text clipping, address parsing. */
import { rt } from './text'
import { parseAddress } from './addressing'
import {
  ROOM_LIMIT_CEILINGS,
  type Address,
  type Room,
  type RoomChangedFile,
  type RoomModelRef,
  type RoomStatus,
} from './types'

/** Whether two change listings name the same files with the same counts. */
export function sameFiles(a: readonly RoomChangedFile[], b: readonly RoomChangedFile[]): boolean {
  if (a.length !== b.length) return false
  const key = (f: RoomChangedFile) => `${f.path}\u0000${f.additions}\u0000${f.deletions}`
  const set = new Set(a.map(key))
  return b.every((f) => set.has(key(f)))
}

/** The most passes the built-in summariser makes for one summary. */
export const MAX_SUMMARY_PASSES = 6
/** Tells a retried turn which tools already ran, so it does not repeat their effects. */
export function ranToolsInstruction(
  base: string | null | undefined,
  ranTools: ReadonlyArray<{ name: string; args?: unknown }>,
  reason: string
): string {
  const ran = ranTools
    .slice(0, 12)
    .map((t) => `${t.name} ${JSON.stringify(t.args ?? {}).slice(0, 120)}`)
    .join('; ')
  return `${base ? `${base}
` : ''}${rt('ranTools', { ran, reason })}`
}

export function modelKey(model: RoomModelRef): string {
  return `${model.provider}/${model.id}`
}

/** Head and tail of `text` within `chars`, for a message too long for one pass. */
export function clipMiddle(text: string, chars: number): string {
  if (text.length <= chars) return text
  const half = Math.max(0, Math.floor((chars - 24) / 2))
  return `${text.slice(0, half)}\n... (cut) ...\n${text.slice(text.length - half)}`
}

/**
 * Split transcript blocks into passes that each fit `chars`, in order. A block
 * longer than a pass is cut to one. More than `MAX_SUMMARY_PASSES` passes keep
 * the newest and say the oldest were left out.
 */
export function chunkTranscript(
  blocks: string[],
  chars: number
): { chunks: string[]; omitted: number } {
  const chunks: string[] = []
  let current: string[] = []
  let used = 0
  for (const raw of blocks) {
    const block = clipMiddle(raw, chars)
    if (used + block.length + 2 > chars && current.length) {
      chunks.push(current.join('\n\n'))
      current = []
      used = 0
    }
    current.push(block)
    used += block.length + 2
  }
  if (current.length) chunks.push(current.join('\n\n'))
  if (chunks.length <= MAX_SUMMARY_PASSES) return { chunks, omitted: 0 }
  return {
    chunks: chunks.slice(-MAX_SUMMARY_PASSES),
    omitted: chunks.length - MAX_SUMMARY_PASSES,
  }
}

export function truncate(text: string): string {
  return text.length > ROOM_LIMIT_CEILINGS.maxTextLength
    ? text.slice(0, ROOM_LIMIT_CEILINGS.maxTextLength)
    : text
}

export function parseAddressFor(raw: string, room: Room): Address {
  return parseAddress(raw, room.participants, room.moderator.enabled ? room.moderator.name : null)
}

/** Status to settle on after a one-off command (vote, final positions). */
export function settleAfterCommand(previous: RoomStatus): RoomStatus {
  switch (previous) {
    case 'completed':
    case 'awaiting-user':
    case 'stopped':
      return previous
    default:
      return 'paused'
  }
}
