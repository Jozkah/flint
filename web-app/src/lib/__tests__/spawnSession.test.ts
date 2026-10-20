import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useMessageQueue } from '@/stores/message-queue-store'
import {
  MAX_NESTED_CHILDREN,
  isSpawnedSession,
  runSpawnSession,
} from '../spawnSession'

const ensure = vi.fn()
const discard = vi.fn()
const authorize = vi.fn()

vi.mock('@/hooks/useCoworkWorktrees', () => ({
  useCoworkWorktrees: { getState: () => ({ ensure, discard, forget: vi.fn() }) },
}))
vi.mock('@/hooks/useDirectEditGrants', () => ({
  useDirectEditGrants: { getState: () => ({ authorize }) },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => '/data' }) }),
}))

const turn = (text: string) =>
  ({ id: text, prompt: text, parts: [], reply: text }) as never

const seedParent = (extra: Record<string, unknown> = {}) =>
  useCoworkSessions.setState({
    currentId: 'p1',
    sessions: [
      {
        id: 'p1',
        title: 'Parent',
        folder: '/proj',
        turns: [],
        messages: [],
        updated: 1,
        createdAt: 1,
        ...extra,
      },
    ] as never,
  })

const children = () => useCoworkSessions.getState().sessions.filter((s) => s.id !== 'p1')

describe('spawn_session', () => {
  beforeEach(() => {
    seedParent()
    useMessageQueue.setState({ queues: {} })
    ensure.mockReset()
    discard.mockReset().mockResolvedValue({ ok: true })
    authorize.mockReset().mockResolvedValue({ ok: true })
  })

  it('creates an unbound session nested under the parent and queues its prompt', async () => {
    const out = await runSpawnSession('p1', { title: 'Side job', prompt: 'do the thing' })
    expect(out.isError).toBeFalsy()
    const child = children()[0]
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
    const out = await runSpawnSession(children()[0].id, { title: 'B', prompt: 'y' })
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

  it('still recognises an older spawn marked only by turns === 0', () => {
    expect(isSpawnedSession({ forkedFrom: { sessionId: 'p', turns: 0, at: 1 } })).toBe(true)
    expect(isSpawnedSession({ forkedFrom: { sessionId: 'p', turns: 2, at: 1 } })).toBe(false)
  })

  describe("context: 'fork'", () => {
    beforeEach(() => {
      seedParent({
        turns: [turn('one'), turn('two')],
        todos: [{ id: 't', text: 'x', status: 'pending' }],
        mode: 'auto',
        access: 'managed-worktree',
      })
    })

    it('copies the conversation, stays unbound and is marked as spawned', async () => {
      const out = await runSpawnSession('p1', { title: 'Forked', prompt: 'continue', context: 'fork' })
      expect(out.isError).toBeFalsy()
      const child = children()[0]
      expect(child.turns).toHaveLength(2)
      expect(child.title).toBe('Forked')
      expect(child.todos).toEqual(useCoworkSessions.getState().sessions.find((s) => s.id === 'p1')!.todos)
      expect(child.folder).toBeNull()
      expect(child.access).toBeUndefined()
      expect(child.forkedFrom).toMatchObject({ sessionId: 'p1', turns: 2, spawned: true })
      expect(isSpawnedSession(child)).toBe(true)
      expect(useMessageQueue.getState().getQueue(child.id)[0].text).toBe('continue')
      expect(useCoworkSessions.getState().currentId).toBe('p1')
      expect(ensure).not.toHaveBeenCalled()
    })

    it('counts toward the cap, and a fork child cannot spawn', async () => {
      for (let i = 0; i < MAX_NESTED_CHILDREN; i++) {
        expect(
          (await runSpawnSession('p1', { title: `f${i}`, prompt: 'x', context: 'fork' })).isError
        ).toBeFalsy()
      }
      const over = await runSpawnSession('p1', { title: 'more', prompt: 'x', context: 'fork' })
      expect(over.isError).toBe(true)
      const out = await runSpawnSession(children()[0].id, { title: 'B', prompt: 'y' })
      expect(out.output).toContain('cannot start another')
    })

    it('rejects an unknown context', async () => {
      const out = await runSpawnSession('p1', { title: 'a', prompt: 'b', context: 'share' })
      expect(out.isError).toBe(true)
      expect(children()).toHaveLength(0)
    })
  })

  describe('worktree: true', () => {
    const record = { path: '/wt/a', branch: 'flint/side-job', baseSha: 'abc' }
    const approve = vi.fn()
    const input = { title: 'Side job', prompt: 'go', worktree: true }

    beforeEach(() => {
      approve.mockReset().mockResolvedValue(true)
      ensure.mockResolvedValue({ ok: true, record })
    })

    it('refuses when the parent has no folder', async () => {
      seedParent({ folder: null })
      const out = await runSpawnSession('p1', input, { mode: 'ask', onApprove: approve })
      expect(out.isError).toBe(true)
      expect(out.output).toContain('folder')
      expect(children()).toHaveLength(0)
      expect(ensure).not.toHaveBeenCalled()
    })

    it('refuses in review mode', async () => {
      const out = await runSpawnSession('p1', input, { mode: 'review', onApprove: approve })
      expect(out.isError).toBe(true)
      expect(children()).toHaveLength(0)
      expect(ensure).not.toHaveBeenCalled()
    })

    it('refuses when nothing can ask the user', async () => {
      const out = await runSpawnSession('p1', input, { mode: 'ask' })
      expect(out.isError).toBe(true)
      expect(children()).toHaveLength(0)
    })

    it('cleans up the session when the worktree cannot be made', async () => {
      ensure.mockResolvedValue({ ok: false, reason: 'branch exists' })
      const out = await runSpawnSession('p1', input, { mode: 'ask', onApprove: approve })
      expect(out.isError).toBe(true)
      expect(out.output).toContain('branch exists')
      expect(children()).toHaveLength(0)
      expect(approve).not.toHaveBeenCalled()
    })

    it('asks naming folder and branch, and removes everything when declined', async () => {
      approve.mockResolvedValue(false)
      const out = await runSpawnSession('p1', input, { mode: 'ask', onApprove: approve })
      expect(out.isError).toBe(true)
      expect(approve).toHaveBeenCalledWith(
        expect.any(String),
        'spawn_session',
        expect.objectContaining({ folder: '/proj', branch: 'flint/side-job' }),
        undefined,
        undefined
      )
      expect(discard).toHaveBeenCalled()
      expect(authorize).not.toHaveBeenCalled()
      expect(children()).toHaveLength(0)
    })

    it('grants the worktree, not the folder, once approved', async () => {
      const out = await runSpawnSession('p1', input, { mode: 'ask', onApprove: approve })
      expect(out.isError).toBeFalsy()
      expect(out.output).toContain('flint/side-job')
      const child = children()[0]
      expect(authorize).toHaveBeenCalledWith(child.id, '/wt/a', '/data', [])
      expect(child.access).toBe('managed-worktree')
      expect(isSpawnedSession(child)).toBe(true)
      expect(useMessageQueue.getState().getQueue(child.id)[0].text).toBe('go')
    })

    it('removes the worktree and session when the grant fails', async () => {
      authorize.mockResolvedValue({ ok: false, reason: 'denied' })
      const out = await runSpawnSession('p1', input, { mode: 'ask', onApprove: approve })
      expect(out.isError).toBe(true)
      expect(discard).toHaveBeenCalled()
      expect(children()).toHaveLength(0)
    })
  })
})
