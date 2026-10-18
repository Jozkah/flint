import { beforeEach, describe, expect, it } from 'vitest'
import {
  closeFindForThread,
  findSeedIsForOther,
  useConversationFind,
} from '../useConversationFind'

const find = () => useConversationFind.getState()

describe('closeFindForThread', () => {
  beforeEach(() => useConversationFind.setState({ open: false, seed: null, owner: null }))

  it('closes the bar when another chat is shown', () => {
    find().setOpen(true)
    closeFindForThread()
    expect(find().open).toBe(false)
  })

  it('keeps the bar and its seed for the chat a search hit navigated to (A -> B)', () => {
    // A cross-chat hit in B is clicked from A: the bar is asked to open, then B mounts.
    find().openWith({ threadId: 'b', query: 'cache', messageId: 'm1' })
    closeFindForThread()
    expect(find().open).toBe(true)
    expect(find().seed).toEqual({ threadId: 'b', query: 'cache', messageId: 'm1' })
  })

  it('keeps the seed when other conversations mount first (Home -> chat)', () => {
    // From Home, other panes or a lazily loaded thread may mount before the
    // hit's chat; none of them may drop the pending seed.
    find().openWith({ threadId: 'b', query: 'cache', messageId: 'm1' })
    closeFindForThread() // some other conversation 'c' mounts first
    expect(findSeedIsForOther(find().seed, 'c')).toBe(true)
    closeFindForThread() // then the target 'b'
    expect(find().open).toBe(true)
    expect(findSeedIsForOther(find().seed, 'b')).toBe(false)
    expect(find().seed?.query).toBe('cache')
  })

  it('closes for another chat once the seed was consumed', () => {
    find().openWith({ threadId: 'b', query: 'cache' })
    find().clearSeed() // b's find bar took it
    closeFindForThread()
    expect(find().open).toBe(false)
  })

  it('keeps the bar when its chat mounts after the bar took the seed', () => {
    // The bar is a child: its effect consumes the seed before the chat's own
    // mount effect runs (the live S-002 bug: the bar never appeared).
    find().openWith({ threadId: 'b', query: 'cache' })
    find().clearSeed()
    closeFindForThread('b')
    expect(find().open).toBe(true)
    closeFindForThread('c')
    expect(find().open).toBe(false)
  })

  it('opening by hand drops a stale seed', () => {
    find().openWith({ threadId: 'b', query: 'cache' })
    find().setOpen(true)
    expect(find().seed).toBeNull()
  })
})
