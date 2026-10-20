import { beforeEach, describe, expect, it } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useMessageQueue } from '@/stores/message-queue-store'
import {
  MAX_NESTED_CHILDREN,
  isSpawnedSession,
  runSpawnSession,
} from '../spawnSession'

const seedParent = (id = 'p1') =>
  useCoworkSessions.setState({
    sessions: [
      { id, title: 'Parent', folder: '/proj', turns: [], messages: [], updated: 1, createdAt: 1 },
    ] as never,
  })

describe('spawn_session', () => {
  beforeEach(() => {
    seedParent()
    useMessageQueue.setState({ queues: {} })
  })

  it('creates an unbound session nested under the parent and queues its prompt', async () => {
    const out = await runSpawnSession('p1', { title: 'Side job', prompt: 'do the thing' })
    expect(out.isError).toBeFalsy()
    const child = useCoworkSessions.getState().sessions.find((s) => s.id !== 'p1')!
    expect(child.title).toBe('Side job')
    expect(child.folder).toBeNull()
    expect(child.forkedFrom).toMatchObject({ sessionId: 'p1', turns: 0 })
    expect(isSpawnedSession(child)).toBe(true)
    expect(useMessageQueue.getState().getQueue(child.id)[0].text).toBe('do the thing')
    // The user's current chat is not switched away from.
    expect(useCoworkSessions.getState().currentId).not.toBe(child.id)
  })

  it('refuses a nested chat that tries to spawn another', async () => {
    await runSpawnSession('p1', { title: 'A', prompt: 'x' })
    const child = useCoworkSessions.getState().sessions.find((s) => s.id !== 'p1')!
    const out = await runSpawnSession(child.id, { title: 'B', prompt: 'y' })
    expect(out.isError).toBe(true)
    expect(out.output).toContain('cannot start another')
  })

  it('caps nested chats per parent and rejects empty input', async () => {
    for (let i = 0; i < MAX_NESTED_CHILDREN; i++) {
      expect((await runSpawnSession('p1', { title: `c${i}`, prompt: 'x' })).isError).toBeFalsy()
    }
    const over = await runSpawnSession('p1', { title: 'one more', prompt: 'x' })
    expect(over.isError).toBe(true)
    expect((await runSpawnSession('p1', { title: '', prompt: '' })).isError).toBe(true)
  })
})
