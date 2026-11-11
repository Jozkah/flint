import { describe, expect, it } from 'vitest'
import { attachAskToTurns, settleAskInTurns } from '@/hooks/coworkRun/turns'
import { carryAsks, dropSettledRows } from '../stepHandlers'
import type { AskRecord, CoworkTurn } from '@/types/coworkSession'

const ask: AskRecord = {
  requestId: 'q1',
  request: { questions: [] } as unknown as AskRecord['request'],
  sessionId: 's1',
  at: '2026-01-01T00:00:00Z',
  state: 'pending',
}

describe('the text before a question, once the step settles', () => {
  it('is shown once, with the question still on it', () => {
    const streamedRow: CoworkTurn = { role: 'assistant', content: 'Before I start, one question.' }
    const toolRow: CoworkTurn = { role: 'tool', content: '', callId: 'c1', name: 'ask', status: 'running' }
    let live: CoworkTurn[] = [{ role: 'user', content: 'go' }, streamedRow, toolRow]
    live = attachAskToTurns(live, ask)
    live = settleAskInTurns(live, 'q1', 'answered', [])

    const { kept, carriedAsks } = dropSettledRows(
      live,
      new Set([streamedRow]),
      new Map([['c1', {}]])
    )
    expect(kept).toEqual([{ role: 'user', content: 'go' }])
    expect(carriedAsks.map((a) => [a.requestId, a.state])).toEqual([['q1', 'answered']])

    const settled: CoworkTurn[] = [
      { role: 'assistant', content: 'Before I start, one question.' },
      { role: 'tool', content: 'answered', callId: 'c1', name: 'ask' },
    ]
    carryAsks(settled, carriedAsks)
    const rows = [...kept, ...settled]
    expect(rows.filter((t) => t.content === 'Before I start, one question.')).toHaveLength(1)
    expect(rows[1].asks?.[0].requestId).toBe('q1')
  })

  it('leaves a question on an earlier, settled row alone', () => {
    const earlier: CoworkTurn = { role: 'assistant', content: 'old' }
    const live = attachAskToTurns([earlier], ask)
    const { kept, carriedAsks } = dropSettledRows(live, new Set(), new Map())
    expect(kept).toHaveLength(1)
    expect(kept[0].asks).toHaveLength(1)
    expect(carriedAsks).toEqual([])
  })
})
