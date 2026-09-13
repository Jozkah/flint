import { describe, it, expect } from 'vitest'
import {
  coworkTurnsToUIMessages,
  isHideableToolTurn,
} from '@/lib/coworkTurns'
import { applyInnerToTurns, toolOutcome } from '@/hooks/useCoworkRun'
import type { CoworkTurn } from '@/types/coworkSession'

const started = (id: string, name: string) =>
  ({ type: 'tool_call_started', id, name }) as const
const result = (id: string, content: string, is_error = false) =>
  ({ type: 'tool_result', id, content, is_error }) as const

const toolParts = (turns: CoworkTurn[], hide = false) =>
  coworkTurnsToUIMessages(turns, 'x', { hideCompletedTools: hide })
    .flatMap((m) => m.parts as { type: string; data?: unknown }[])
    .filter((p) => p.type.startsWith('tool-'))

describe('durable tool activity', () => {
  it('keeps one item through requested, running and succeeded', () => {
    let turns = applyInnerToTurns([], started('c1', 'read'))
    expect(turns).toHaveLength(1)
    expect(turns[0].toolState).toBe('requested')
    expect(turns[0].startedAt).toBeTypeOf('number')

    turns = applyInnerToTurns(turns, {
      type: 'tool_call',
      id: 'c1',
      name: 'read',
      args: { path: 'a.ts' },
    })
    // Advanced, not duplicated: the invocation is one item.
    expect(turns).toHaveLength(1)
    expect(turns[0].toolState).toBe('running')
    expect(turns[0].args).toEqual({ path: 'a.ts' })

    turns = applyInnerToTurns(turns, result('c1', 'contents'))
    expect(turns).toHaveLength(1)
    expect(turns[0].toolState).toBe('succeeded')
    expect(turns[0].result).toBe('contents')
    expect(turns[0].endedAt).toBeTypeOf('number')
  })

  it('does not replace the invocation with a separate result item', () => {
    let turns = applyInnerToTurns([], started('c1', 'bash'))
    turns = applyInnerToTurns(turns, result('c1', 'ok'))
    expect(turns.filter((t) => t.role === 'tool')).toHaveLength(1)
    expect(toolParts(turns)).toHaveLength(1)
  })

  it('keeps several calls in the order they were made', () => {
    let turns = applyInnerToTurns([], started('c1', 'read'))
    turns = applyInnerToTurns(turns, started('c2', 'bash'))
    turns = applyInnerToTurns(turns, started('c3', 'edit'))
    // Results arrive out of order; the items do not move.
    turns = applyInnerToTurns(turns, result('c2', 'ran'))
    turns = applyInnerToTurns(turns, result('c1', 'read it'))
    turns = applyInnerToTurns(turns, result('c3', 'edited'))
    expect(turns.map((t) => t.callId)).toEqual(['c1', 'c2', 'c3'])
    expect(turns.every((t) => t.toolState === 'succeeded')).toBe(true)
  })

  it('tells a failure, a refusal and a cancellation apart', () => {
    expect(toolOutcome(false, 'fine')).toBe('succeeded')
    expect(toolOutcome(true, 'ENOENT: no such file')).toBe('failed')
    expect(toolOutcome(true, 'Refused: permission not granted')).toBe('refused')
    expect(toolOutcome(true, 'The run was cancelled')).toBe('cancelled')
  })

  it('reconstructs the same items from persisted turns, without duplicates', () => {
    let turns = applyInnerToTurns([], started('c1', 'read'))
    turns = applyInnerToTurns(turns, result('c1', 'contents'))
    // What a reload gets back: the same array, off disk.
    const restored: CoworkTurn[] = JSON.parse(JSON.stringify(turns))
    const parts = toolParts(restored)
    expect(parts).toHaveLength(1)
    expect(restored[0].toolState).toBe('succeeded')
    expect(toolParts(restored).map((p) => p.type)).toEqual(['tool-read'])
  })

  it('shows completed activity by default', () => {
    let turns = applyInnerToTurns([], started('c1', 'read'))
    turns = applyInnerToTurns(turns, result('c1', 'contents'))
    expect(toolParts(turns, false)).toHaveLength(1)
  })

  it('hides only cleanly successful activity when asked to', () => {
    let turns: CoworkTurn[] = []
    for (const [id, name] of [
      ['c1', 'read'],
      ['c2', 'bash'],
      ['c3', 'edit'],
      ['c4', 'grep'],
    ] as const) {
      turns = applyInnerToTurns(turns, started(id, name))
    }
    turns = applyInnerToTurns(turns, result('c1', 'contents'))
    turns = applyInnerToTurns(turns, result('c2', 'ENOENT', true))
    turns = applyInnerToTurns(turns, result('c3', 'Refused: not permitted', true))
    // c4 is still running.

    const shown = toolParts(turns, true)
    expect(shown.map((p) => p.type).sort()).toEqual([
      'tool-bash',
      'tool-edit',
      'tool-grep',
    ])
  })

  it('counts what it hid rather than dropping it silently', () => {
    let turns = applyInnerToTurns([], started('c1', 'read'))
    turns = applyInnerToTurns(turns, result('c1', 'a'))
    turns = applyInnerToTurns(turns, started('c2', 'grep'))
    turns = applyInnerToTurns(turns, result('c2', 'b'))

    const parts = coworkTurnsToUIMessages(turns, 'x', {
      hideCompletedTools: true,
    }).flatMap((m) => m.parts as { type: string; data?: { count: number } }[])
    const hidden = parts.find((p) => p.type === 'data-hidden-tools')
    expect(hidden?.data?.count).toBe(2)
  })

  it('does not delete anything to hide it', () => {
    let turns = applyInnerToTurns([], started('c1', 'read'))
    turns = applyInnerToTurns(turns, result('c1', 'contents'))
    const before = JSON.stringify(turns)
    coworkTurnsToUIMessages(turns, 'x', { hideCompletedTools: true })
    // The same turns are still there for export and search.
    expect(JSON.stringify(turns)).toBe(before)
    expect(toolParts(turns, false)).toHaveLength(1)
  })

  it('never hides a stale item left behind by a dead run', () => {
    const stale: CoworkTurn = {
      role: 'tool',
      content: '',
      callId: 'c1',
      name: 'bash',
      status: 'done',
      isError: true,
      result: '(interrupted)',
      toolState: 'stale',
    }
    expect(isHideableToolTurn(stale)).toBe(false)
    expect(toolParts([stale], true)).toHaveLength(1)
  })

  it('treats a finished pre-state turn from disk as a success', () => {
    // Written before the state field existed.
    const legacy: CoworkTurn = {
      role: 'tool',
      content: '',
      callId: 'c1',
      name: 'read',
      status: 'done',
      result: 'contents',
    }
    expect(isHideableToolTurn(legacy)).toBe(true)
    expect(toolParts([legacy], true)).toHaveLength(0)
    expect(toolParts([legacy], false)).toHaveLength(1)
  })
})
