import { describe, it, expect } from 'vitest'
import { describeSpendPause } from '../spendPause'

describe('describeSpendPause', () => {
  it('formats the amounts of the backend sentence with the ceiling', () => {
    const text = describeSpendPause(
      'Continue the run up to its $5.00 ceiling (about $2.10 spent so far)'
    )
    expect(text).toContain('$5.00')
    expect(text).toContain('$2.10')
  })

  it('formats a pause without a ceiling', () => {
    const text = describeSpendPause(
      'Continue the run (about $1.50 spent so far)'
    )
    expect(text).toContain('$1.50')
    expect(text).not.toContain('ceiling')
  })

  it('gives up on a sentence it does not know, so the caller shows it as it came', () => {
    expect(describeSpendPause('something else')).toBeUndefined()
    expect(describeSpendPause(undefined)).toBeUndefined()
  })
})
