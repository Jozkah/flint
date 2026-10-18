import { describe, it, expect } from 'vitest'
import { runColumns } from '../runColumns'

describe('runColumns', () => {
  it('leaves out a column whose values are all empty', () => {
    expect(
      runColumns([
        { started: 1, speed: 0, tokens: 4100 },
        { started: 2, speed: 0, tokens: 0 },
      ])
    ).toEqual(['run', 'task', 'model', 'status', 'started', 'tokens'])
  })

  it('keeps every column when each has a value somewhere', () => {
    expect(runColumns([{ started: 1, speed: 20, tokens: 5 }])).toHaveLength(7)
  })

  it('keeps every column for an empty list', () => {
    expect(runColumns([])).toHaveLength(7)
  })
})
