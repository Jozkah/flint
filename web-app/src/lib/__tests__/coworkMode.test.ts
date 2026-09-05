import { describe, expect, it } from 'vitest'
import { PLAN_DENIED_TOOLS } from '@/lib/coworkTools'
import {
  COWORK_MODES,
  defaultModeFor,
  deniedTools,
  gatesMutations,
  isReadOnly,
  modeOf,
  needsApproval,
} from '@/lib/coworkMode'

describe('what each mode permits', () => {
  it('offers exactly the three modes, least permissive first', () => {
    expect(COWORK_MODES).toEqual(['review', 'ask', 'auto'])
  })

  it('makes only review read-only', () => {
    expect(isReadOnly('review')).toBe(true)
    expect(isReadOnly('ask')).toBe(false)
    expect(isReadOnly('auto')).toBe(false)
  })

  it('gates mutations only in ask', () => {
    expect(gatesMutations('ask')).toBe(true)
    expect(gatesMutations('review')).toBe(false)
    expect(gatesMutations('auto')).toBe(false)
  })

  it('withholds in review exactly what plan mode withheld', () => {
    expect([...deniedTools('review')].sort()).toEqual(
      [...PLAN_DENIED_TOOLS].sort()
    )
  })

  it('withholds nothing in the other two', () => {
    expect(deniedTools('ask').size).toBe(0)
    expect(deniedTools('auto').size).toBe(0)
  })

  it('asks about mutations in ask, and nothing else anywhere', () => {
    expect(needsApproval('ask', 'write')).toBe(true)
    expect(needsApproval('ask', 'bash')).toBe(true)
    // A read is not a change, so it is not something to approve.
    expect(needsApproval('ask', 'read')).toBe(false)
    // Review has already refused these by name; auto is defined by not asking.
    expect(needsApproval('review', 'write')).toBe(false)
    expect(needsApproval('auto', 'write')).toBe(false)
  })

  it('asks about every tool review refuses, so the two never disagree', () => {
    for (const tool of PLAN_DENIED_TOOLS) {
      expect({ tool, asks: needsApproval('ask', tool) }).toEqual({
        tool,
        asks: true,
      })
    }
  })
})

describe('the mode a session starts in', () => {
  // The whole point: the turn that attaches a repository must not be the turn
  // that edits it.
  it('is review once a repository is attached', () => {
    expect(defaultModeFor('/home/dev/project')).toBe('review')
  })

  it('is unchanged when there is no repository to protect', () => {
    expect(defaultModeFor(null)).toBe('auto')
    expect(defaultModeFor(undefined)).toBe('auto')
    expect(defaultModeFor('')).toBe('auto')
  })
})

describe('reading a session saved before modes existed', () => {
  it('prefers an explicit mode over the legacy flag', () => {
    expect(modeOf({ mode: 'ask', planMode: true })).toBe('ask')
  })

  it('reads legacy plan mode as review', () => {
    expect(modeOf({ planMode: true })).toBe('review')
  })

  // `planMode: false` meant no gate at all. Reading it as `ask` would start
  // interrupting people who never asked to be interrupted.
  it('reads a legacy session that was not planning as autonomous', () => {
    expect(modeOf({ planMode: false })).toBe('auto')
    expect(modeOf({})).toBe('auto')
  })
})
