import type { CoworkTurn } from '@/types/coworkSession'

/** When the user last left each session view (this app run only). */
const leftAt = new Map<string, number>()

export function markLeft(sessionId: string, now = Date.now()): void {
  leftAt.set(sessionId, now)
}

/** True when the session changed after the user last left it. */
export function recapDue(sessionId: string, updated: number | undefined): boolean {
  const left = leftAt.get(sessionId)
  return left !== undefined && typeof updated === 'number' && updated > left
}

const MAX_CHARS = 4000

/** The visible conversation as plain text, newest end kept, tool rows left out. */
export function recapTranscript(turns: readonly CoworkTurn[]): string {
  const lines = turns
    .filter((t) => t.role !== 'tool' && !t.hidden && t.content.trim())
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.trim()}`)
  const text = lines.join('\n')
  return text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text
}
