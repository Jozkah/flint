import { describe, it, expect, beforeEach, vi } from 'vitest'

const { updateThread, prune } = vi.hoisted(() => ({
  updateThread: vi.fn(),
  prune: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/archive', () => ({
  archiveEnabled: async () => false,
  trackArchiveWork: (p: Promise<unknown>) => p,
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    threads: () => ({
      updateThread: (t: unknown) => updateThread(t),
      deleteThread: vi.fn(async () => {}),
    }),
    path: () => ({ sep: () => '/' }),
  }),
}))

import { useThreads } from '../useThreads'
import { useModelProvider } from '../useModelProvider'
import { useModelOverrides } from '../useModelOverrides'

describe('updateThreadModel and updateCurrentThreadAssistant guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useModelOverrides.setState({ pruneForThread: prune } as never)
    useThreads.setState({
      threads: { t1: { id: 't1', title: 'T' } as never },
      currentThreadId: 't1',
      searchIndex: null,
    })
  })

  it('updateThreadModel on an unknown id leaves threads untouched', () => {
    useThreads.getState().updateThreadModel('ghost', {
      id: 'm',
      provider: 'p',
    } as never)
    expect(useThreads.getState().threads.ghost).toBeUndefined()
    expect(updateThread).not.toHaveBeenCalled()
    expect(prune).not.toHaveBeenCalled()
  })

  it('updateThreadModel looks the model up under its own provider', () => {
    useModelProvider.setState({
      selectedProvider: 'openai',
      providers: [
        { provider: 'openai', models: [] },
        { provider: 'llamacpp', models: [{ id: 'm' }] },
      ] as never,
    })
    useThreads.getState().updateThreadModel('t1', {
      id: 'm',
      provider: 'llamacpp',
    } as never)
    expect(prune).toHaveBeenCalledTimes(1)
    expect(prune.mock.calls[0][2]).toMatchObject({ id: 'm' })
  })

  it('updateCurrentThreadAssistant with a stale currentThreadId is a no-op', () => {
    useThreads.setState({ currentThreadId: 'gone' })
    useThreads.getState().updateCurrentThreadAssistant({ id: 'a' } as never)
    expect(useThreads.getState().threads.gone).toBeUndefined()
    expect(updateThread).not.toHaveBeenCalled()
  })

  it('getModelBy with a provider name finds a model outside the selected provider', () => {
    useModelProvider.setState({
      selectedProvider: 'openai',
      providers: [
        { provider: 'openai', models: [] },
        { provider: 'llamacpp', models: [{ id: 'm' }] },
      ] as never,
    })
    const s = useModelProvider.getState()
    expect(s.getModelBy('m')).toBeUndefined()
    expect(s.getModelBy('m', 'llamacpp')).toMatchObject({ id: 'm' })
  })
})
