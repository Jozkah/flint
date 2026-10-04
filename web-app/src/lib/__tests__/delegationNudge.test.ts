import { describe, it, expect, vi, beforeEach } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool,
  previewAgentChange: vi.fn(async () => undefined),
}))
vi.mock('@/lib/webSearchTool', () => ({ WEB_TOOL_NAMES: new Set(), executeWebTool: vi.fn() }))

import { DelegationNudge, NUDGE_AFTER, NUDGE_TEXT, SWEEP_HINT, sweepHint } from '../delegationNudge'
import { dispatchCoworkTool } from '../coworkDispatch'
import type { CoworkMode } from '../coworkMode'

describe('DelegationNudge', () => {
  it('fires once, on the call that reaches the streak of read-only exploration', () => {
    const n = new DelegationNudge(() => true)
    const out = ['read', 'grep', 'ls', 'glob', 'read', 'read'].map((t) => n.observe(t))
    expect(out.findIndex(Boolean)).toBe(NUDGE_AFTER - 1)
    expect(out.filter(Boolean)).toEqual([NUDGE_TEXT])
  })

  it('never fires for a short lookup, or when anything else breaks the streak', () => {
    const n = new DelegationNudge(() => true)
    expect(['read', 'grep', 'bash', 'read', 'grep', 'edit', 'ls'].map((t) => n.observe(t)).filter(Boolean)).toEqual([])
  })

  it('stays quiet once the run has delegated, and when delegation is not offered', () => {
    const delegated = new DelegationNudge(() => true)
    delegated.observe('task')
    expect(Array.from({ length: 8 }, () => delegated.observe('read')).filter(Boolean)).toEqual([])
    let on = false
    const off = new DelegationNudge(() => on)
    expect(Array.from({ length: 8 }, () => off.observe('read')).filter(Boolean)).toEqual([])
    on = true
    // The streak only counts calls made while delegation was on.
    expect(Array.from({ length: NUDGE_AFTER - 1 }, () => off.observe('read')).filter(Boolean)).toEqual([])
    expect(off.observe('read')).toBe(NUDGE_TEXT)
  })
})

describe('dispatchCoworkTool with a nudge', () => {
  beforeEach(() => {
    executeAgentTool.mockReset()
    executeAgentTool.mockResolvedValue({ content: 'file body' })
  })
  const ctx = (over = {}) => ({
    sessionId: 's1',
    readOnlyFolder: null,
    mode: 'auto' as CoworkMode,
    webSearch: false,
    onTodo: vi.fn(async () => ({ output: '' })),
    onAsk: vi.fn(async () => ({ output: '' })),
    onTask: vi.fn(async () => ({ output: 'task ok' })),
    ...over,
  })
  const read = (id: string) => ({ toolCallId: id, toolName: 'read', input: { path: 'a' } })

  it('appends the hint to the result of the call that reaches the streak, once', async () => {
    const c = ctx({ nudge: new DelegationNudge(() => true) })
    const outs = []
    for (let i = 0; i < NUDGE_AFTER + 2; i += 1) outs.push((await dispatchCoworkTool(read(`c${i}`), c)).output)
    expect(outs.filter((o) => o.includes(NUDGE_TEXT))).toHaveLength(1)
    expect(outs[NUDGE_AFTER - 1]).toBe(`file body\n\n[${NUDGE_TEXT}]`)
    expect(outs[0]).toBe('file body')
  })

  it('adds nothing for a dispatcher with no nudge (a subagent)', async () => {
    const outs = []
    for (let i = 0; i < 8; i += 1) outs.push((await dispatchCoworkTool(read(`c${i}`), ctx())).output)
    expect(outs.every((o) => o === 'file body')).toBe(true)
  })
})

describe('sweepHint', () => {
  it('fires for survey-shaped requests', () => {
    for (const q of [
      'Survey the whole repo: for each of the packages find how errors are logged.',
      'Go through all the test files and tell me which areas have no tests at all.',
      'Audit the auth, billing and notifications modules separately.',
    ]) expect(sweepHint(q)).toBe(SWEEP_HINT)
  })

  it('stays quiet for lookups and chatter', () => {
    for (const q of [
      'What is the version in package.json?',
      'Read src/main.tsx and tell me what it renders.',
      'Rename the variable foo to bar in utils.ts.',
      'Say hello.',
      undefined,
    ]) expect(sweepHint(q)).toBeUndefined()
  })
})
