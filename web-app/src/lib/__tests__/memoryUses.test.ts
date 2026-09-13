import { describe, it, expect, vi, beforeEach } from 'vitest'

const memoryRecordUses = vi.hoisted(() => vi.fn(async () => 1))
const getJanDataFolder = vi.hoisted(() => vi.fn(async () => '/data'))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({ memoryRecordUses }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))

import { recordMemoryUses } from '../memoryUses'

describe('recording where memories were used (AH-083)', () => {
  beforeEach(() => {
    memoryRecordUses.mockClear()
    getJanDataFolder.mockClear()
  })

  it('records the exact ids a turn carried, with their reasons, turn and snapshot', async () => {
    await recordMemoryUses({
      sessionId: 's1',
      projectRoot: '/repo',
      memory: {
        injectedIds: ['mem-a', 'mem-b'],
        conflictIds: ['mem-c'],
        recall: [{ id: 'mem-a', rank: 1, reason: 'applies to this user' }],
      },
      turnId: 'turn-snap-1',
      snapshotId: 'snap-1',
    })
    expect(memoryRecordUses).toHaveBeenCalledWith(
      { dataFolder: '/data', projectRoot: '/repo', sessionId: 's1' },
      [
        { id: 'mem-a', reason: 'applies to this user' },
        { id: 'mem-b', reason: undefined },
      ],
      { turnId: 'turn-snap-1', snapshotId: 'snap-1' }
    )
  })

  it('records nothing for a turn that carried no memory, or without a session', async () => {
    await recordMemoryUses({ sessionId: 's1', memory: { injectedIds: [], conflictIds: ['x'] } })
    await recordMemoryUses({ sessionId: undefined, memory: { injectedIds: ['a'], conflictIds: [] } })
    expect(memoryRecordUses).not.toHaveBeenCalled()
  })

  it('never lets a failed write reach the turn', async () => {
    memoryRecordUses.mockImplementationOnce(async () => {
      throw new Error('disk full')
    })
    await expect(
      recordMemoryUses({ sessionId: 's1', memory: { injectedIds: ['a'], conflictIds: [] } })
    ).resolves.toBeUndefined()
  })
})
