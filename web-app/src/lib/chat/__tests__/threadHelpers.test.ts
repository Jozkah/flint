import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAppState } from '@/hooks/useAppState'
import { useMessages } from '@/hooks/useMessages'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { recordRunWebTools, resetRunWebTools } from '@/lib/webSearchTool'
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

  // A Settings toggle mid-run must not change how that run's calls are gated:
  // the run's own tool set decides, not the global setting.
  describe('web tools follow the run, not the setting', () => {
    afterEach(() => {
      resetRunWebTools()
      useWebSearchConfig.setState({ webSearchEnabled: true })
    })

    it('keeps asking about an MCP web_search after web search is turned on mid-run', () => {
      recordRunWebTools('t1', { some_mcp_tool: {} })
      useWebSearchConfig.setState({ webSearchEnabled: true })
      expect(isAutoAllowedTool('web_search', 't1')).toBe(false)
    })

    it('keeps the native web tools allowed after web search is turned off mid-run', () => {
      recordRunWebTools('t1', { web_search: {}, web_fetch: {} })
      useWebSearchConfig.setState({ webSearchEnabled: false })
      expect(isAutoAllowedTool('web_fetch', 't1')).toBe(true)
    })

    it('falls back to the setting for a thread with no recorded run', () => {
      useWebSearchConfig.setState({ webSearchEnabled: false })
      expect(isAutoAllowedTool('web_search', 'other')).toBe(false)
    })
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
