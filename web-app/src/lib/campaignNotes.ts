import { create } from 'zustand'

/**
 * Delivery state of the notes the board sent to task sessions
 * (docs/CAMPAIGNS.md, "Steering").
 *
 * A note is a mailbox message from the coordinator to the task session. It is
 * `sent` while it is still unread in the recipient's inbox, and `delivered`
 * once the run has claimed it (the mailbox marks a message read at the moment
 * it is put in front of the model). In memory only: it describes this launch.
 */
export type NoteState = 'sent' | 'delivered'

export type CampaignNote = {
  messageId: string
  sessionId: string
  state: NoteState
  at: number
}

export const noteKey = (campaignId: string, taskId: string) =>
  `${campaignId}/${taskId}`

/** The message id out of `send_message`'s JSON result, or null. */
export function messageIdOf(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { message_id?: unknown }
    return typeof parsed.message_id === 'string' ? parsed.message_id : null
  } catch {
    return null
  }
}

/**
 * Notes still `sent` that are no longer unread in their recipient's inbox
 * become `delivered`. A failed read leaves the note as it was.
 */
export async function settleNotes(
  notes: Record<string, CampaignNote>,
  pending: (sessionId: string) => Promise<{ id: string }[]>
): Promise<Record<string, CampaignNote>> {
  const out = { ...notes }
  const sessions = new Set(
    Object.values(notes)
      .filter((n) => n.state === 'sent')
      .map((n) => n.sessionId)
  )
  for (const sid of sessions) {
    let unread: Set<string>
    try {
      unread = new Set((await pending(sid)).map((e) => e.id))
    } catch {
      continue
    }
    for (const [key, n] of Object.entries(notes)) {
      if (n.sessionId === sid && n.state === 'sent' && !unread.has(n.messageId)) {
        out[key] = { ...n, state: 'delivered' }
      }
    }
  }
  return out
}

type NotesState = {
  notes: Record<string, CampaignNote>
  record: (
    campaignId: string,
    taskId: string,
    sessionId: string,
    messageId: string
  ) => void
  settle: (
    pending: (sessionId: string) => Promise<{ id: string }[]>
  ) => Promise<void>
}

export const useCampaignNotes = create<NotesState>()((set, get) => ({
  notes: {},
  record: (campaignId, taskId, sessionId, messageId) =>
    set((s) => ({
      notes: {
        ...s.notes,
        [noteKey(campaignId, taskId)]: {
          messageId,
          sessionId,
          state: 'sent',
          at: Date.now(),
        },
      },
    })),
  settle: async (pending) => {
    const next = await settleNotes(get().notes, pending)
    set({ notes: next })
  },
}))
