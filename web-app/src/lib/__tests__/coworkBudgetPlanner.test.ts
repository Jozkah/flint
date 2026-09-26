/** AH-088: the window is checked before dispatch, not after a rejection. */
import { describe, expect, it } from 'vitest'
import {
  ContextOverflowError,
  coworkWindow,
  isContextOverflow,
  planTurn,
  replyReserveFor,
} from '../coworkBudget'

it('keeps room for the reply, within sane bounds', () => {
  expect(replyReserveFor(32768)).toBe(4915)
  // A tiny window still keeps a floor, or the model has nowhere to answer.
  expect(replyReserveFor(1024)).toBe(512)
  // A huge one does not reserve a quarter of a million tokens.
  expect(replyReserveFor(1_000_000)).toBe(8192)
})

it('lets a comfortable turn through', () => {
  const plan = planTurn({ projected: 4000, window: 32768 })
  expect(plan.status).toBe('fits')
  expect(plan.overBy).toBe(0)
})

it('warns while there is still room to act', () => {
  const plan = planTurn({ projected: 25000, window: 32768 })
  expect(plan.status).toBe('tight')
  expect(plan.overBy).toBe(0)
})

it('refuses a request that leaves the model nowhere to answer', () => {
  const plan = planTurn({ projected: 32000, window: 32768 })
  expect(plan.status).toBe('over')
  // What has to go, reply space included -- not merely the overshoot.
  expect(plan.overBy).toBe(32000 - (32768 - 4915))
})

it('does not refuse a server whose window it could not discover', () => {
  for (const window of [null, undefined, 0]) {
    const plan = planTurn({ projected: 999_999, window })
    expect(plan.status).toBe('unknown')
    expect(plan.overBy).toBe(0)
  }
})

it('fails with a typed error that says both numbers', () => {
  const plan = planTurn({ projected: 40000, window: 32768 })
  const error = new ContextOverflowError(plan)
  expect(isContextOverflow(error)).toBe(true)
  expect(isContextOverflow(new Error('nope'))).toBe(false)
  // Grouped in the reader's locale, so the expectation is derived rather
  // than spelled with en-US separators.
  expect(error.message).toContain((40000).toLocaleString())
  expect(error.message).toContain((32768).toLocaleString())
  expect(error.plan.status).toBe('over')
})

describe('coworkWindow', () => {
  const bundled = { contextTokens: 32768, source: 'bundled' }

  it('uses the user’s Max Context Tokens over a bundled guess', () => {
    expect(coworkWindow({ userSet: 200000, capabilities: bundled })).toBe(200000)
    expect(coworkWindow({ userSet: '200000', capabilities: bundled })).toBe(200000)
  })

  it('drops a bundled guess the provider has already disproved', () => {
    // qwen3 guessed at 32,768 after the endpoint served a 78,814-token prompt.
    expect(coworkWindow({ capabilities: bundled, acceptedPrompt: 78814 })).toBeNull()
    expect(coworkWindow({ capabilities: bundled, acceptedPrompt: 1000 })).toBe(32768)
  })

  it('keeps a discovered window whatever was accepted before', () => {
    expect(
      coworkWindow({
        userSet: 0,
        capabilities: { contextTokens: 32768, source: 'local-runtime' },
        acceptedPrompt: 78814,
      })
    ).toBe(32768)
    expect(coworkWindow({ capabilities: null })).toBeNull()
  })
})
