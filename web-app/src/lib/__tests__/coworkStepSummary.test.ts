import { describe, it, expect } from 'vitest'
import {
  describeStep,
  formatStepDuration,
  middleSplit,
  stepDurationMs,
  stepState,
  transcriptItems,
} from '../coworkStepSummary'
import type { CoworkTurn } from '@/types/coworkSession'

const tool = (name: string, args: Record<string, unknown> = {}, over: Partial<CoworkTurn> = {}): CoworkTurn =>
  ({ role: 'tool', name, content: '', args, ...over }) as CoworkTurn

describe('describeStep', () => {
  it('reads a file with its line range', () => {
    expect(describeStep(tool('read', { path: 'a.go', offset: 0, limit: 120 }))).toMatchObject({
      kind: 'read',
      verb: 'read',
      subject: 'a.go',
      pathLike: true,
      range: '1-120',
    })
  })
  it('searches with a scope', () => {
    expect(describeStep(tool('grep', { pattern: 'cowork', path: 'core/' }))).toMatchObject({
      kind: 'search',
      subject: 'cowork',
      scope: 'core/',
    })
  })
  it('lists and runs', () => {
    expect(describeStep(tool('ls', { path: 'web-app/src/lib' })).verb).toBe('listed')
    expect(describeStep(tool('bash', { command: 'npm test' }))).toMatchObject({ verb: 'ran', subject: 'npm test' })
  })
  it('falls back to the tool name', () => {
    expect(describeStep(tool('mystery', { query: 'q' }))).toMatchObject({ kind: 'other', subject: 'mystery q' })
  })
})

describe('transcriptItems', () => {
  it('groups two or more consecutive reads, not a lone one or a different kind', () => {
    const items = transcriptItems([
      tool('read', { path: 'a' }),
      tool('read', { path: 'b' }),
      tool('read', { path: 'c' }),
      tool('bash', { command: 'x' }),
      tool('read', { path: 'd' }),
    ])
    expect(items.map((i) => i.type)).toEqual(['group', 'step', 'step'])
    const g = items[0]
    expect(g.type === 'group' && g.steps).toHaveLength(3)
  })
  it('keeps assistant prose in order and drops empty text', () => {
    const items = transcriptItems([
      { role: 'assistant', content: 'hi' } as CoworkTurn,
      { role: 'assistant', content: '  ' } as CoworkTurn,
      tool('ls'),
    ])
    expect(items.map((i) => i.type)).toEqual(['text', 'step'])
  })
  it('copes with no turns', () => {
    expect(transcriptItems(undefined)).toEqual([])
  })
})

describe('middleSplit', () => {
  it('leaves a short path whole', () => {
    expect(middleSplit('a/b.ts')).toEqual({ head: '', tail: 'a/b.ts' })
  })
  it('keeps the filename in the tail and rejoins losslessly', () => {
    const p = 'internal/radar/some/very/deep/folder/structure/client.go'
    const { head, tail } = middleSplit(p)
    expect(head + tail).toBe(p)
    expect(tail.endsWith('client.go')).toBe(true)
    expect(head.length).toBeGreaterThan(0)
  })
})

describe('durations and state', () => {
  it('formats', () => {
    expect(formatStepDuration(420)).toBe('420ms')
    expect(formatStepDuration(1400)).toBe('1.4s')
    expect(formatStepDuration(125_000)).toBe('2m 05s')
  })
  it('needs both ends for a duration', () => {
    expect(stepDurationMs({ startedAt: 1 })).toBeUndefined()
    expect(stepDurationMs({ startedAt: 1, endedAt: 501 })).toBe(500)
  })
  it('maps tool states', () => {
    expect(stepState(tool('x', {}, { toolState: 'running' }))).toBe('active')
    expect(stepState(tool('x', {}, { toolState: 'failed' }))).toBe('failed')
    expect(stepState(tool('x', {}, { toolState: 'succeeded' }))).toBe('ok')
  })
})
