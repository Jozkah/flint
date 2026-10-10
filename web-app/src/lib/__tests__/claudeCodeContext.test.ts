import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CODE_MIN_CONTEXT,
  planClaudeCodeContext,
} from '../claudeCodeContext'

const always = () => true
const upTo = (max: number) => (c: number) => c <= max

describe('planClaudeCodeContext', () => {
  it('raises the seeded 8192 default to the target when it fits', () => {
    const plan = planClaudeCodeContext({
      configured: 8192,
      trainedContext: 131072,
      fitEnabled: false,
      fitsAt: always,
    })
    expect(plan).toMatchObject({
      raiseTo: CLAUDE_CODE_MIN_CONTEXT,
      context: CLAUDE_CODE_MIN_CONTEXT,
      shortfall: null,
    })
  })

  it('raises an empty value when auto-fit is off', () => {
    const plan = planClaudeCodeContext({
      configured: '',
      fitEnabled: false,
      fitsAt: always,
    })
    expect(plan.raiseTo).toBe(CLAUDE_CODE_MIN_CONTEXT)
  })

  it('leaves an unset context to auto-fit', () => {
    const plan = planClaudeCodeContext({
      configured: '',
      fitEnabled: true,
      fitsAt: upTo(8192),
    })
    expect(plan).toEqual({
      target: CLAUDE_CODE_MIN_CONTEXT,
      context: null,
      raiseTo: null,
      shortfall: null,
    })
  })

  it('caps at the trained maximum and says so', () => {
    const plan = planClaudeCodeContext({
      configured: 8192,
      trainedContext: 16384,
      fitEnabled: false,
      fitsAt: always,
    })
    expect(plan.raiseTo).toBe(16384)
    expect(plan.shortfall).toEqual({ context: 16384, reason: 'trained' })
  })

  it('steps down to what fits in memory and says so', () => {
    const plan = planClaudeCodeContext({
      configured: 8192,
      trainedContext: 131072,
      fitEnabled: false,
      fitsAt: upTo(16384),
    })
    expect(plan.raiseTo).toBe(16384)
    expect(plan.shortfall).toEqual({ context: 16384, reason: 'memory' })
  })

  it('keeps the default when nothing larger fits', () => {
    const plan = planClaudeCodeContext({
      configured: 8192,
      fitEnabled: false,
      fitsAt: upTo(8192),
    })
    expect(plan.raiseTo).toBeNull()
    expect(plan.shortfall).toEqual({ context: 8192, reason: 'memory' })
  })

  it('never overrides a value the user chose, but warns', () => {
    const plan = planClaudeCodeContext({
      configured: 12000,
      trainedContext: 131072,
      fitEnabled: false,
      fitsAt: always,
    })
    expect(plan.raiseTo).toBeNull()
    expect(plan.context).toBe(12000)
    expect(plan.shortfall).toEqual({ context: 12000, reason: 'user-setting' })
  })

  it('a chosen value at the memory ceiling is a memory shortfall', () => {
    const plan = planClaudeCodeContext({
      configured: 16384,
      fitEnabled: false,
      fitsAt: upTo(16384),
    })
    expect(plan.shortfall).toEqual({ context: 16384, reason: 'memory' })
  })

  it('a chosen value at or above the target is fine', () => {
    const plan = planClaudeCodeContext({
      configured: 65536,
      fitEnabled: true,
      fitsAt: always,
    })
    expect(plan.raiseTo).toBeNull()
    expect(plan.shortfall).toBeNull()
  })
})
