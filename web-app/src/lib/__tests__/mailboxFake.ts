import { vi } from 'vitest'
import type { MailEnvelope } from '@/lib/sessionMailbox'

/**
 * An in-memory mailbox backend with the contract's delivery states, so tests
 * can assert what happened to each envelope rather than which calls were made.
 */
export function fakeMailbox() {
  const inbox: Record<string, MailEnvelope[]> = {}
  const state: Record<string, 'queued' | 'delivered' | 'read'> = {}
  const takenTimes: Record<string, number> = {}

  const envelope = (
    to: string,
    id: string,
    over: Partial<MailEnvelope> = {}
  ): MailEnvelope => {
    const env: MailEnvelope = {
      v: 1,
      id,
      from: { sessionId: 'OTHER', displayName: 'Other session' },
      to: { sessionId: to },
      project: 'proj',
      text: `text of ${id}`,
      createdAt: 1,
      depth: 0,
      origin: 'agent',
      ...over,
    }
    ;(inbox[to] ??= []).push(env)
    state[id] = 'queued'
    return env
  }

  const mailbox = {
    takeForDelivery: vi.fn(async (sid: string) => {
      const out = (inbox[sid] ?? []).filter((e) => state[e.id] === 'queued')
      for (const e of out) {
        state[e.id] = 'delivered'
        takenTimes[e.id] = (takenTimes[e.id] ?? 0) + 1
      }
      return out
    }),
    pending: vi.fn(async (sid: string) =>
      (inbox[sid] ?? []).filter((e) => state[e.id] !== 'read')
    ),
    markRead: vi.fn(async (_sid: string, ids: string[]) => {
      for (const id of ids) state[id] = 'read'
    }),
    /** mailbox_claim: not-yet-read ids in this inbox become read and are returned. */
    claim: vi.fn(async (sid: string, ids: string[]) => {
      const out: string[] = []
      for (const id of ids) {
        if (out.includes(id) || state[id] === 'read') continue
        if (!(inbox[sid] ?? []).some((e) => e.id === id)) continue
        state[id] = 'read'
        out.push(id)
      }
      return out
    }),
  }

  return { mailbox, envelope, state, takenTimes }
}

/** Let chained promises and store subscribers settle. */
export const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
