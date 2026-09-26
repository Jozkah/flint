/**
 * "Open in split view" from a row's menu and the Split shortcut: what opens
 * where, depending on the conversation on screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from 'sonner'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  PRIMARY_PANE,
  useSplitConversation,
} from '@/hooks/useSplitConversation'
import {
  currentPrimary,
  openInSplit,
  registerSplitNavigator,
  reportSplitResult,
  splitCurrent,
} from '@/lib/splitView'

const at = (path: string) => window.history.pushState({}, '', path)
const split = () => useSplitConversation.getState()

describe('split view entry points', () => {
  const navigate = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useSplitConversation.setState({
      panes: [],
      sizes: [1],
      activePane: PRIMARY_PANE,
      maxPanes: 4,
    })
    useCoworkSessions.setState({ currentId: 'session-main' })
    registerSplitNavigator(navigate)
  })

  afterEach(() => {
    registerSplitNavigator(null)
    at('/')
  })

  it('knows the conversation the route shows', () => {
    expect(currentPrimary('/threads/abc')).toEqual({
      kind: 'chat',
      refId: 'abc',
    })
    expect(currentPrimary('/cowork')).toEqual({
      kind: 'cowork',
      refId: 'session-main',
    })
    expect(currentPrimary('/settings/general')).toBeNull()
  })

  it('opens a Cowork session beside a Chat thread', () => {
    at('/threads/thread-a')
    expect(openInSplit({ kind: 'cowork', refId: 'session-2' })).toBe('added')
    expect(split().panes).toMatchObject([
      { kind: 'cowork', refId: 'session-2' },
    ])
  })

  it('opens a Cowork session beside the current one', () => {
    at('/cowork')
    expect(openInSplit({ kind: 'cowork', refId: 'session-2' })).toBe('added')
    // The one already on screen only splits: an empty pane beside it.
    expect(openInSplit({ kind: 'cowork', refId: 'session-main' })).toBe(
      'shown'
    )
    expect(split().panes).toHaveLength(1)
  })

  it('from a page with no conversation, opens it with an empty pane beside', () => {
    at('/settings/general')
    expect(openInSplit({ kind: 'chat', refId: 'thread-z' })).toBe('primary')
    expect(navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'thread-z' },
    })
    expect(split().panes).toHaveLength(1)
    expect(split().panes[0].refId).toBeUndefined()
  })

  it('says so when the panes are full', () => {
    at('/threads/thread-a')
    openInSplit({ kind: 'chat', refId: 'b' })
    openInSplit({ kind: 'chat', refId: 'c' })
    openInSplit({ kind: 'chat', refId: 'd' })
    const result = openInSplit({ kind: 'chat', refId: 'e' })
    expect(result).toBe('full')
    reportSplitResult(result, (key) => key)
    expect(toast.error).toHaveBeenCalledWith('chat:split.full')
  })

  it('the shortcut splits only where a conversation is on screen', () => {
    at('/settings/general')
    expect(splitCurrent()).toBe('unavailable')
    at('/threads/thread-a')
    expect(splitCurrent()).toBe('added')
    expect(split().panes).toHaveLength(1)
  })
})
