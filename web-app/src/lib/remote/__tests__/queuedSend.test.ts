import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerComposer, resetComposers } from '../composer'
import { resetStagedDocs, sendQueuedViaComposer } from '../queuedSend'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useMessageQueue } from '@/stores/message-queue-store'
import { nextChatTurn } from '@/lib/chatSteering'
import type { Attachment } from '@/types/attachment'

const file = { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA' }
const doc = { type: 'document', name: 'a.pdf', path: '/p/a.pdf' } as Attachment

afterEach(() => {
  resetComposers()
  resetStagedDocs()
  useChatAttachments.getState().clearAttachments('s1')
  useMessageQueue.setState({ queues: {} })
})

describe('sendQueuedViaComposer', () => {
  it('sends the text and media through the conversation composer', async () => {
    const send = vi.fn()
    registerComposer('chat', 'c1', { send })
    const sent = await sendQueuedViaComposer('chat', 'c1', 'look', {
      files: [file],
      docs: [],
    })
    expect(sent).toBe(true)
    expect(send).toHaveBeenCalledWith('look', [file])
  })

  it('stages documents for the send and takes them back for Cowork', async () => {
    let seen: string[] = []
    const send = vi.fn(() => {
      seen = useChatAttachments
        .getState()
        .getAttachments('s1')
        .map((a) => a.path ?? '')
    })
    registerComposer('cowork', 's1', { send })
    await sendQueuedViaComposer('cowork', 's1', 'read it', {
      files: [],
      docs: [doc],
    })
    expect(send).toHaveBeenCalledWith('read it')
    expect(seen).toEqual(['/p/a.pdf'])
    expect(useChatAttachments.getState().getAttachments('s1')).toEqual([])
  })

  it('is false when the conversation has no composer, sending nothing', async () => {
    expect(
      await sendQueuedViaComposer('chat', 'gone', 'x', { files: [file], docs: [] })
    ).toBe(false)
  })
})

describe('queued attachments', () => {
  it('the chat drain hands a queued message its attachments', () => {
    const attachments = { files: [file], docs: [] }
    useMessageQueue
      .getState()
      .enqueue('c1', { id: 'm1', text: 'look', createdAt: 1, attachments })
    expect(nextChatTurn('c1')).toEqual({
      text: 'look',
      steered: false,
      attachments,
    })
  })

  it('a message with attachments is never made steering', () => {
    const q = useMessageQueue.getState()
    q.enqueue('c1', {
      id: 'm1',
      text: 'look',
      createdAt: 1,
      attachments: { files: [file], docs: [] },
    })
    q.steerNow('c1', 'm1')
    expect(useMessageQueue.getState().getQueue('c1')[0].steer).toBeUndefined()
    expect(useMessageQueue.getState().takeSteering('c1')).toEqual([])
  })

  it('a text-only message drains as before, without an attachments key', () => {
    useMessageQueue
      .getState()
      .enqueue('c1', { id: 'm1', text: 'hi', createdAt: 1 })
    expect(nextChatTurn('c1')).toEqual({ text: 'hi', steered: false })
  })
})
