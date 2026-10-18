import { beforeEach, describe, expect, it } from 'vitest'
import { closeFindForThread, useConversationFind } from '../useConversationFind'

const find = () => useConversationFind.getState()

describe('closeFindForThread', () => {
  beforeEach(() => useConversationFind.setState({ open: false, seed: null }))

  it('closes the bar when another chat is shown', () => {
    find().setOpen(true)
    closeFindForThread('b')
    expect(find().open).toBe(false)
  })

  it('keeps the bar and its seed for the chat a search hit navigated to (A -> B)', () => {
    // A cross-chat hit in B is clicked from A: the bar is asked to open, then B mounts.
    find().openWith({ threadId: 'b', query: 'cache', messageId: 'm1' })
    closeFindForThread('b')
    expect(find().open).toBe(true)
    expect(find().seed).toEqual({ threadId: 'b', query: 'cache', messageId: 'm1' })
  })

  it('still closes for a chat the seed is not for', () => {
    find().openWith({ threadId: 'b', query: 'cache' })
    closeFindForThread('c')
    expect(find().open).toBe(false)
    expect(find().seed).toBeNull()
  })
})
