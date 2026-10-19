import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  archiveOn: true,
  deleteThreadAsync: vi.fn(async () => undefined),
  deleteRoom: vi.fn(async () => undefined),
  archiveCoworkSession: vi.fn(async () => true),
  deleteCoworkSession: vi.fn(),
  purgeArchived: vi.fn(async () => undefined),
  campaignDelete: vi.fn(async () => undefined),
  removeSessionWorktree: vi.fn(async () => ({ ok: true as const })),
  forgetSession: vi.fn(),
  worktrees: {} as Record<string, unknown>,
  streaming: {} as Record<string, boolean>,
  sessions: [] as unknown[],
  setCampaign: vi.fn(),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: {
    getState: () => ({
      threads: { t: { id: 't', title: 't' }, u: { id: 'u', title: 'u' } },
      deleteThreadAsync: m.deleteThreadAsync,
    }),
  },
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: { getState: () => ({ streamingContents: m.streaming }) },
}))
vi.mock('@/hooks/useCoworkParallel', () => ({
  useCoworkParallel: { getState: () => ({ forgetSession: m.forgetSession }) },
}))
vi.mock('@/hooks/useCoworkRun', () => ({
  useCoworkRun: { getState: () => ({ runs: {} }) },
}))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: {
    getState: () => ({ sessions: m.sessions, setCampaign: m.setCampaign }),
  },
}))
vi.mock('@/hooks/useCoworkWorktrees', () => ({
  useCoworkWorktrees: { getState: () => ({ bySession: m.worktrees }) },
}))
vi.mock('@/hooks/useCampaigns', () => ({
  useCampaignStore: { getState: () => ({ campaigns: [], refresh: vi.fn() }) },
}))
vi.mock('@/lib/archive', () => ({
  archiveApi: { list: vi.fn(async () => []) },
  archiveEnabled: async () => m.archiveOn,
  purgeArchived: m.purgeArchived,
}))
vi.mock('@/lib/archiveRestore', () => ({ restoreArchived: vi.fn() }))
vi.mock('@/lib/campaignApi', () => ({ campaignApi: { delete: m.campaignDelete } }))
vi.mock('@/lib/coworkRunner', () => ({ isRunning: () => false }))
vi.mock('@/lib/coworkSessionLifecycle', () => ({
  archiveCoworkSession: m.archiveCoworkSession,
  deleteCoworkSession: m.deleteCoworkSession,
}))
vi.mock('@/lib/coworkParallel', () => ({ removeSessionWorktree: m.removeSessionWorktree }))
vi.mock('@/lib/rooms/controller', () => ({ roomController: { deleteRoom: m.deleteRoom } }))
vi.mock('@/lib/rooms/store', () => ({
  useRoomsStore: { getState: () => ({ summaries: [], runningRoomIds: [], loadSummaries: vi.fn() }) },
}))

import { BulkKept, BulkSkipped, type BulkItem } from '../bulkConversations'
import { actOnItem } from '../bulkConversationsDeps'

const mk = (kind: BulkItem['kind'], id = 'x'): BulkItem => ({ kind, id, title: id })

beforeEach(() => {
  vi.clearAllMocks()
  m.archiveOn = true
  m.worktrees = {}
  m.streaming = {}
  m.sessions = []
  m.archiveCoworkSession.mockResolvedValue(true)
})

describe('actOnItem archive', () => {
  it('moves a chat to the archive, never permanently', async () => {
    await actOnItem(mk('thread', 't'), 'archive')
    expect(m.deleteThreadAsync).toHaveBeenCalledWith('t')
  })

  it('archives a room without purging it', async () => {
    await actOnItem(mk('room', 'r'), 'archive')
    expect(m.deleteRoom).toHaveBeenCalledWith('r')
    expect(m.purgeArchived).not.toHaveBeenCalled()
  })

  it('archives a Cowork session and keeps its worktree', async () => {
    await actOnItem(mk('cowork', 'c'), 'archive')
    expect(m.archiveCoworkSession).toHaveBeenCalledWith('c', false)
    expect(m.forgetSession).toHaveBeenCalledWith('c')
    expect(m.purgeArchived).not.toHaveBeenCalled()
  })

  it('refuses when the archive is off instead of deleting', async () => {
    m.archiveCoworkSession.mockResolvedValue(false)
    await expect(actOnItem(mk('cowork', 'c'), 'archive')).rejects.toThrow()
    expect(m.deleteCoworkSession).not.toHaveBeenCalled()
  })

  it('has no archive for campaigns', async () => {
    await expect(actOnItem(mk('campaign', 'k'), 'archive')).rejects.toThrow()
    expect(m.campaignDelete).not.toHaveBeenCalled()
  })
})

describe('actOnItem re-checks at execution', () => {
  it('skips a chat that started streaming after the plan was made', async () => {
    m.streaming = { t: true }
    const err = await actOnItem({ ...mk('thread', 't'), active: false }, 'delete').catch((e) => e)
    expect(err).toBeInstanceOf(BulkSkipped)
    expect(m.deleteThreadAsync).not.toHaveBeenCalled()
    await actOnItem(mk('thread', 'u'), 'delete')
    expect(m.deleteThreadAsync).toHaveBeenCalledWith('u', true)
  })

  it('refuses a chat archive when the archive was turned off meanwhile', async () => {
    m.archiveOn = false
    await expect(actOnItem(mk('thread', 't'), 'archive')).rejects.toThrow('archive is off')
    expect(m.deleteThreadAsync).not.toHaveBeenCalled()
  })

  it('says the session is gone, not that the archive is off, when it no longer exists', async () => {
    m.archiveCoworkSession.mockResolvedValue(false)
    await expect(actOnItem(mk('cowork', 'c'), 'archive')).rejects.toThrow('session no longer exists')
  })
})

describe('actOnItem delete', () => {
  it('deletes a chat permanently', async () => {
    await actOnItem(mk('thread', 't'), 'delete')
    expect(m.deleteThreadAsync).toHaveBeenCalledWith('t', true)
  })

  it('deletes a room outright, skipping the archive', async () => {
    await actOnItem(mk('room', 'r'), 'delete')
    expect(m.deleteRoom).toHaveBeenCalledWith('r', { permanent: true })
    expect(m.purgeArchived).not.toHaveBeenCalled()
  })

  it('archives a Cowork session for removal, then purges it', async () => {
    await actOnItem(mk('cowork', 'c'), 'delete')
    expect(m.archiveCoworkSession).toHaveBeenCalledWith('c', true)
    expect(m.purgeArchived).toHaveBeenCalledWith('cowork', 'c')
  })

  it('keeps a Cowork session in the archive when the purge is refused', async () => {
    m.purgeArchived.mockRejectedValueOnce(new Error('unmerged work'))
    const err = await actOnItem(mk('cowork', 'c'), 'delete').catch((e) => e)
    expect(err).toBeInstanceOf(BulkKept)
    expect(err.message).toBe('unmerged work')
  })

  it('with the archive off removes a worktree first and keeps the session if that fails', async () => {
    m.archiveOn = false
    m.archiveCoworkSession.mockResolvedValue(false)
    m.worktrees = { c: { path: 'w' } }
    m.removeSessionWorktree.mockResolvedValueOnce({ ok: false, reason: 'dirty' } as never)
    await expect(actOnItem(mk('cowork', 'c'), 'delete')).rejects.toThrow('dirty')
    // Never forced: unfinished work in the worktree keeps its session.
    expect(m.removeSessionWorktree).toHaveBeenCalledWith('c', false)
    expect(m.deleteCoworkSession).not.toHaveBeenCalled()
    await actOnItem(mk('cowork', 'c'), 'delete')
    expect(m.deleteCoworkSession).toHaveBeenCalledWith('c')
  })

  it('deletes a campaign through the backend command', async () => {
    await actOnItem(mk('campaign', 'k'), 'delete')
    expect(m.campaignDelete).toHaveBeenCalledWith('k')
  })

  it('clears the campaign pointer of sessions that ran under the deleted one', async () => {
    m.sessions = [
      { id: 's1', title: 's1', campaign: { id: 'k', role: 'task' } },
      { id: 's2', title: 's2', campaign: { id: 'other', role: 'task' } },
      { id: 's3', title: 's3' },
    ]
    await actOnItem(mk('campaign', 'k'), 'delete')
    expect(m.setCampaign).toHaveBeenCalledTimes(1)
    expect(m.setCampaign).toHaveBeenCalledWith('s1', null)
  })
})
