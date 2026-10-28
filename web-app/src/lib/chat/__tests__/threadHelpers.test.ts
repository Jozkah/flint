import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAppState } from '@/hooks/useAppState'
import { useMessages } from '@/hooks/useMessages'
import {
  DETAILS_OPEN_KEY,
  isAutoAllowedTool,
  readDetailsOpen,
  serverForTool,
  stampContextErrorOnThread,
  writeDetailsOpen,
} from '../threadHelpers'

const msg = (id: string, role: string, metadata?: Record<string, unknown>) =>
  ({ id, role, thread_id: 't1', metadata, content: [] }) as never

describe('serverForTool', () => {
  afterEach(() => useAppState.setState({ tools: [] }))

  it('names the MCP server a tool belongs to', () => {
    useAppState.setState({
      tools: [{ name: 'read_x', server: 'files' }] as never,
    })
    expect(serverForTool('read_x')).toBe('files')
    expect(serverForTool('missing')).toBeUndefined()
  })
})

describe('isAutoAllowedTool', () => {
  afterEach(() => useAppState.setState({ ragToolNames: new Set() }))

  it('allows Flint-owned RAG tools without a prompt', () => {
    useAppState.setState({ ragToolNames: new Set(['rag_search']) })
    expect(isAutoAllowedTool('rag_search')).toBe(true)
  })

  it('still asks about an unknown external tool', () => {
    expect(isAutoAllowedTool('some_mcp_tool_nobody_registered')).toBe(false)
  })
})

describe('stampContextErrorOnThread', () => {
  const store = useMessages.getState()
  let updateMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    updateMessage = vi.fn()
  })

  const withMessages = (list: unknown[]) => {
    vi.spyOn(useMessages, 'getState').mockReturnValue({
      ...store,
      getMessages: () => list as never,
      updateMessage: updateMessage as never,
    })
  }

  afterEach(() => vi.restoreAllMocks())

  it('stamps the latest user message, keeping its other metadata', () => {
    withMessages([
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('u2', 'user', { keep: 1 }),
      msg('a2', 'assistant'),
    ])
    stampContextErrorOnThread('t1', 'too long')
    expect(updateMessage).toHaveBeenCalledTimes(1)
    const arg = updateMessage.mock.calls[0][0]
    expect(arg.id).toBe('u2')
    expect(arg.metadata).toEqual({ keep: 1, contextError: 'too long' })
  })

  it('does not stamp twice', () => {
    withMessages([msg('u1', 'user', { contextError: 'earlier' })])
    stampContextErrorOnThread('t1', 'again')
    expect(updateMessage).not.toHaveBeenCalled()
  })

  it('does nothing when there is no user message', () => {
    withMessages([msg('a1', 'assistant')])
    stampContextErrorOnThread('t1', 'x')
    expect(updateMessage).not.toHaveBeenCalled()
  })
})

describe('Details open state', () => {
  beforeEach(() => localStorage.clear())

  it('is closed in a split pane whatever was saved', () => {
    localStorage.setItem(DETAILS_OPEN_KEY, 'true')
    expect(readDetailsOpen(true)).toBe(false)
  })

  it('remembers the last choice', () => {
    writeDetailsOpen(true)
    expect(readDetailsOpen(false)).toBe(true)
    writeDetailsOpen(false)
    expect(readDetailsOpen(false)).toBe(false)
  })

  it('falls back to the window size when nothing is saved', () => {
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('1280') })) as never
    expect(readDetailsOpen(false)).toBe(true)
    window.matchMedia = original
  })

  it('survives storage that throws', () => {
    const original = window.matchMedia
    window.matchMedia = (() => ({ matches: false })) as never
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readDetailsOpen(false)).toBe(false)
    spy.mockRestore()
    window.matchMedia = original
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => writeDetailsOpen(true)).not.toThrow()
    set.mockRestore()
  })
})
