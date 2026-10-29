import { describe, it, expect, beforeEach, vi } from 'vitest'

const { updateThread, invokeCommand } = vi.hoisted(() => ({
  updateThread: vi.fn(async () => {}),
  invokeCommand: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/archive', () => ({
  archiveEnabled: async () => false,
  trackArchiveWork: (p: Promise<unknown>) => p,
}))
vi.mock('@/lib/backend', () => ({ invokeCommand }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    threads: () => ({
      updateThread: (t: unknown) => updateThread(t),
      deleteThread: vi.fn(async () => {}),
    }),
    path: () => ({ sep: () => '/' }),
  }),
}))

import { useThreads, isSummaryAssistant } from '../useThreads'

const slim = { id: 'a', name: 'A', model: { id: 'm', engine: 'openai' }, summary: true }
const full = {
  id: 'a',
  name: 'A',
  model: { id: 'm', engine: 'openai' },
  instructions: 'be brief',
  parameters: { temperature: 0.2 },
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('summary threads (PERF-012)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useThreads.setState({
      threads: {
        t1: { id: 't1', title: 'One', assistants: [slim] } as unknown as Thread,
      },
      currentThreadId: undefined,
      searchIndex: null,
    })
  })

  it('hydration replaces the summary assistant with the full one', async () => {
    invokeCommand.mockResolvedValueOnce(full)
    const t = await useThreads.getState().ensureThreadHydrated('t1')
    expect(invokeCommand).toHaveBeenCalledWith('get_thread_assistant', { threadId: 't1' })
    const a = useThreads.getState().threads.t1.assistants[0]
    expect(t?.assistants[0]).toBe(a)
    expect(isSummaryAssistant(a)).toBe(false)
    expect(a.instructions).toBe('be brief')
    // Already full: no second fetch.
    await useThreads.getState().ensureThreadHydrated('t1')
    expect(invokeCommand).toHaveBeenCalledTimes(1)
  })

  it('opening a thread hydrates it', async () => {
    invokeCommand.mockResolvedValueOnce(full)
    useThreads.getState().setCurrentThreadId('t1')
    await flush()
    expect(useThreads.getState().threads.t1.assistants[0].instructions).toBe('be brief')
  })

  it('a reload of the summaries keeps a hydrated assistant', async () => {
    invokeCommand.mockResolvedValueOnce(full)
    await useThreads.getState().ensureThreadHydrated('t1')
    useThreads.getState().setThreads([
      { id: 't1', title: 'One', assistants: [{ ...slim, name: 'B' }] } as unknown as Thread,
    ])
    const a = useThreads.getState().threads.t1.assistants[0]
    expect(a.instructions).toBe('be brief')
    expect(a.name).toBe('B')
  })

  it('a failed fetch leaves the summary (the backend restores it on write)', async () => {
    invokeCommand.mockRejectedValueOnce(new Error('gone'))
    await useThreads.getState().ensureThreadHydrated('t1')
    expect(isSummaryAssistant(useThreads.getState().threads.t1.assistants[0])).toBe(true)
  })

  it('a write of an unhydrated thread keeps the summary marker for the backend guard', async () => {
    useThreads.getState().renameThread('t1', 'New')
    await flush()
    const written = updateThread.mock.calls[0][0] as Thread
    expect(written.title).toBe('New')
    expect(isSummaryAssistant(written.assistants[0])).toBe(true)
  })
})
