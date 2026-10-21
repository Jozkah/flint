import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkLaunch, editingToolsAsked, forgetLaunchApprovals } from '../coworkSubagentLaunchGate'

const base = {
  sessionId: 's1',
  agent: 'coder',
  tools: ['read', 'write', 'bash'],
  model: 'qwen',
  foreground: true,
}

describe('editing-subagent launch gate', () => {
  beforeEach(() => forgetLaunchApprovals())

  it('asks once in ask mode, naming the editing tools, then remembers', async () => {
    const ask = vi.fn().mockResolvedValue(true)
    expect(await checkLaunch({ ...base, mode: 'ask', ask })).toBe(true)
    expect(ask).toHaveBeenCalledWith({ agent: 'coder', tools: ['write', 'bash'], model: 'qwen' })
    expect(await checkLaunch({ ...base, mode: 'ask', ask })).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })
  it('a no is not remembered and stops the launch', async () => {
    const ask = vi.fn().mockResolvedValue(false)
    expect(await checkLaunch({ ...base, mode: 'ask', ask })).toBe(false)
    expect(await checkLaunch({ ...base, mode: 'ask', ask })).toBe(false)
    expect(ask).toHaveBeenCalledTimes(2)
  })
  it('is per session and per definition', async () => {
    const ask = vi.fn().mockResolvedValue(true)
    await checkLaunch({ ...base, mode: 'ask', ask })
    await checkLaunch({ ...base, sessionId: 's2', mode: 'ask', ask })
    await checkLaunch({ ...base, agent: 'other', mode: 'ask', ask })
    expect(ask).toHaveBeenCalledTimes(3)
  })
  it('never asks in review, auto, bypass, for read-only tools, or in the background', async () => {
    const ask = vi.fn().mockResolvedValue(false)
    for (const mode of ['review', 'auto', 'bypass'] as const) {
      expect(await checkLaunch({ ...base, mode, ask })).toBe(true)
    }
    expect(await checkLaunch({ ...base, mode: 'ask', tools: ['read', 'grep'], ask })).toBe(true)
    expect(await checkLaunch({ ...base, mode: 'ask', foreground: false, ask })).toBe(true)
    expect(await checkLaunch({ ...base, mode: undefined, ask })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })
  it('editingToolsAsked follows the mode', () => {
    expect(editingToolsAsked('ask', ['edit', 'read'])).toEqual(['edit'])
    expect(editingToolsAsked('review', ['edit'])).toEqual([])
  })
})
