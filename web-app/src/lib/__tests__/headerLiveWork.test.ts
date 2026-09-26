import { describe, it, expect } from 'vitest'
import {
  currentRunStep,
  formatWait,
  runningRows,
  waitingApprovalRows,
} from '../headerLiveWork'
import type { CoworkTurn } from '@/types/coworkSession'

const titles: Record<string, string> = {
  'cw-1': 'Build the release',
  't-1': 'Chat about logs',
  'room-1': 'Design room',
}
const titleOf = (id: string) => titles[id]

describe('approval pill rows', () => {
  it('lists every waiting prompt oldest first, with title, tool and wait', () => {
    const rows = waitingApprovalRows(
      [
        { requestId: 'r-new', threadId: 't-1', toolName: 'write', requestedAt: 90_000 },
        { requestId: 'r-old', threadId: 'cw-1', toolName: 'bash', requestedAt: 40_000 },
        { requestId: 'r-room', threadId: 'room-1', toolName: 'fetch' },
      ],
      titleOf,
      100_000
    )
    expect(rows.map((r) => r.requestId)).toEqual(['r-old', 'r-new', 'r-room'])
    // The pill opens rows[0]: the conversation that has waited longest.
    expect(rows[0]).toEqual({
      requestId: 'r-old',
      threadId: 'cw-1',
      title: 'Build the release',
      tool: 'bash',
      waitingMs: 60_000,
    })
    expect(rows[2].waitingMs).toBeUndefined()
    expect(rows[2].title).toBe('Design room')
  })
})

describe('runs pill rows', () => {
  const turns: CoworkTurn[] = [
    { role: 'tool', content: '', name: 'read', status: 'done' },
    { role: 'tool', content: '', name: 'bash', status: 'running' },
  ]

  it('names the step a run is on', () => {
    expect(currentRunStep(turns)).toBe('bash')
    expect(currentRunStep([turns[0]])).toBe('read')
    expect(currentRunStep(undefined)).toBeUndefined()
  })

  it('lists each run longest-running first, with title and elapsed', () => {
    const rows = runningRows(
      {
        'cw-2': { startedAt: 95_000 },
        'cw-1': { startedAt: 10_000 },
      },
      titleOf,
      { 'cw-1': turns },
      100_000
    )
    expect(rows).toEqual([
      { sessionId: 'cw-1', title: 'Build the release', elapsedMs: 90_000, step: 'bash' },
      { sessionId: 'cw-2', title: undefined, elapsedMs: 5_000, step: undefined },
    ])
  })

  it('formats waits briefly', () => {
    expect(formatWait(44_000)).toBe('44 s')
    expect(formatWait(180_000)).toBe('3 min')
    expect(formatWait(7_500_000)).toBe('2 h 5 min')
  })
})
