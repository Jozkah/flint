import { beforeEach, describe, expect, it } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

/** janhq/jan#8905: a Cowork session owns its model choice. */

const session = (id: string) =>
  ({
    id,
    title: id,
    folder: null,
    turns: [],
    messages: [],
    subagents: [],
    created: 1,
    updated: 1,
  }) as never

describe('a session’s model', () => {
  beforeEach(() => {
    useCoworkSessions.setState({
      sessions: [session('A'), session('B')],
      currentId: 'A',
    })
  })

  it('is set on that session only', () => {
    useCoworkSessions
      .getState()
      .setModel('A', { provider: 'llamacpp', id: 'model-a' })
    const [a, b] = useCoworkSessions.getState().sessions
    expect(a.model).toEqual({ provider: 'llamacpp', id: 'model-a' })
    expect(b.model).toBeUndefined()
  })

  it('is kept when another session changes its own', () => {
    const store = useCoworkSessions.getState()
    store.setModel('A', { provider: 'llamacpp', id: 'model-a' })
    store.setModel('B', { provider: 'openai', id: 'model-b' })
    const [a, b] = useCoworkSessions.getState().sessions
    expect(a.model?.id).toBe('model-a')
    expect(b.model?.id).toBe('model-b')
  })

  it('is part of what survives a restart', () => {
    useCoworkSessions
      .getState()
      .setModel('A', { provider: 'llamacpp', id: 'model-a' })
    const options = (
      useCoworkSessions as unknown as {
        persist: { getOptions: () => { partialize?: (s: unknown) => unknown } }
      }
    ).persist.getOptions()
    const saved = (options.partialize?.(useCoworkSessions.getState()) ??
      useCoworkSessions.getState()) as { sessions: { model?: unknown }[] }
    expect(saved.sessions[0].model).toEqual({
      provider: 'llamacpp',
      id: 'model-a',
    })
  })
})
