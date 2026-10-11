import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createBoardActions } from '../campaignBoardActions'
import { messageIdOf, settleNotes, useCampaignNotes } from '../campaignNotes'
import { createMailboxDelivery, takeClaimed } from '../mailboxDelivery'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import type { Campaign } from '../campaignModel'
import { fakeMailbox } from './mailboxFake'

const session = (id: string): CoworkSession =>
  ({ id, title: id, folder: '/proj', turns: [], messages: [], updated: 0 }) as CoworkSession

describe('a steer note from the board reaches the task session', () => {
  let fake: ReturnType<typeof fakeMailbox>
  let stop: () => void
  let delivery: ReturnType<typeof createMailboxDelivery>

  beforeEach(() => {
    useMessageQueue.setState({ queues: {} })
    useCoworkSessions.setState({
      sessions: [session('coord'), session('task-session')],
      currentId: 'coord',
    })
    useCoworkRun.setState({
      runs: { 'task-session': { runId: 'r', startedAt: 1 } },
    } as never)
    useSessionMessaging.setState({
      autoWake: {},
      optOut: {},
      pendingWake: {},
      lastRunWasWake: {},
    })
    useCampaignNotes.setState({ notes: {} })
    fake = fakeMailbox()
    delivery = createMailboxDelivery(fake.mailbox)
    stop = delivery.start()
  })
  afterEach(() => stop())

  it('is queued ready in the running task session and the card says sent', async () => {
    const c = {
      id: 'c1',
      coordinatorSession: 'coord',
      status: 'running',
      tasks: [
        {
          id: 'a',
          title: 'A',
          status: 'running',
          sessionId: 'task-session',
          dependsOn: [],
        },
      ],
    } as unknown as Campaign
    const actions = createBoardActions({
      api: { get: async () => c } as never,
      runner: {} as never,
      liveSessions: () => new Set(['task-session']),
      abortRun: vi.fn(),
      // The mailbox send: the same envelope the backend would store.
      sendMessage: async (from, to, text) => {
        fake.envelope(to, 'note-1', {
          from: { sessionId: from, displayName: 'Coordinator' },
          text,
        })
        await delivery.onEvent({ sessionId: to, messageId: 'note-1' })
        return {
          ok: true,
          output: JSON.stringify({ message_id: 'note-1', delivered_to_status: 'running' }),
        }
      },
      noteSent: (cid, tid, sid, mid) =>
        useCampaignNotes.getState().record(cid, tid, sid, mid),
    })

    const out = await actions.sendNote('c1', 'a', 'use the v2 endpoint')
    expect(out.ok).toBe(true)
    expect(messageIdOf(JSON.stringify({ message_id: 'note-1' }))).toBe('note-1')

    // Put in the running session's queue, ready, not held.
    const [queued] = useMessageQueue.getState().getQueue('task-session')
    expect(queued.held).toBe(false)
    expect(queued.text).toContain('use the v2 endpoint')
    expect(queued.from?.sessionId).toBe('coord')

    // Not yet in front of the model: the card says it was sent.
    const key = 'c1/a'
    expect(useCampaignNotes.getState().notes[key].state).toBe('sent')
    await useCampaignNotes
      .getState()
      .settle((sid) => fake.mailbox.pending(sid))
    // Taken for delivery into the queue is not yet in front of the model: the
    // card says "sent" until the run claims the note.
    expect(useCampaignNotes.getState().notes[key].state).toBe('sent')
  })

  it('goes from sent to delivered when the run claims the note at its step boundary', async () => {
    fake.envelope('task-session', 'note-2', { text: 'steer' })
    await delivery.onEvent({ sessionId: 'task-session', messageId: 'note-2' })
    const notes = {
      'c1/a': {
        messageId: 'note-2',
        sessionId: 'task-session',
        state: 'sent' as const,
        at: 0,
      },
    }
    const before = await settleNotes(notes, (sid) => fake.mailbox.pending(sid))
    expect(before['c1/a'].state).toBe('sent')
    const taken = await takeClaimed(
      'task-session',
      () => useMessageQueue.getState().takeReady('task-session'),
      fake.mailbox
    )
    expect(taken.map((m) => m.from?.messageId)).toEqual(['note-2'])
    const after = await settleNotes(notes, (sid) => fake.mailbox.pending(sid))
    expect(after['c1/a'].state).toBe('delivered')
  })
})
