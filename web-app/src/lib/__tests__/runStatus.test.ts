import { describe, expect, it } from 'vitest'
import type { CoworkTurn } from '@/types/coworkSession'
import { formatElapsed, inThinkBlock, modelWaitStatus, runStatus, toolLabel } from '../runStatus'

const user: CoworkTurn = { role: 'user', content: 'hi' }
const at = (turns: CoworkTurn[], ms = 0) => runStatus(true, turns)?.label(ms)

describe('runStatus', () => {
  it('is null when nothing runs', () => {
    expect(runStatus(false, [user])).toBeNull()
  })

  it('waits for the model, then says it is slow', () => {
    expect(at([user])).toBe('Waiting for the model…')
    expect(at([user], 20_000)).toBe('Still waiting for the model…')
  })

  it('names the running tool', () => {
    const tool: CoworkTurn = { role: 'tool', content: '', name: 'mcp__fs__read_file', status: 'running', callId: 'c1' }
    expect(at([user, tool])).toBe('Running read file…')
    expect(runStatus(true, [user, tool])?.key).toBe('tool:c1')
  })

  it('builds the tool line through the translator, not a template literal', () => {
    const tool: CoworkTurn = { role: 'tool', content: '', name: 'bash', status: 'running', callId: 'c1' }
    const t = (key: string, o: { tool: string }) => `[${key}|${o.tool}]`
    const status = runStatus(true, [user, tool], t)
    expect(status?.label(0)).toBe('[tools:toolCall.runningStatus|bash]')
    expect(status?.label(40_000)).toBe('[tools:toolCall.stillRunning|bash]')
  })

  it('names the call a running tool is waiting on, so it can be stopped alone', () => {
    const tool: CoworkTurn = { role: 'tool', content: '', name: 'bash', status: 'running', callId: 'c9' }
    expect(runStatus(true, [user, tool])?.callId).toBe('c9')
    const done: CoworkTurn = { role: 'tool', content: 'ok', name: 'bash', status: 'done', callId: 'c9' }
    expect(runStatus(true, [user, done])?.callId).toBeUndefined()
  })

  it('reads results after a tool finishes', () => {
    const tool: CoworkTurn = { role: 'tool', content: 'ok', name: 'bash', status: 'done', callId: 'c1' }
    expect(at([user, tool])).toBe('Reading tool results…')
    expect(at([user, tool], 12_000)).toBe('Deciding what to do next…')
  })

  it('thinks inside an open think block, and escalates', () => {
    const a: CoworkTurn = { role: 'assistant', content: '<think>hmm' }
    expect(at([user, a])).toBe('Thinking…')
    expect(at([user, a], 130_000)).toBe('Almost done thinking…')
  })

  it('writes once the answer text streams', () => {
    const a: CoworkTurn = { role: 'assistant', content: '<think>x</think>Here is' }
    expect(at([user, a])).toBe('Writing…')
  })
})

describe('helpers', () => {
  it('detects open think blocks', () => {
    expect(inThinkBlock('<think>a')).toBe(true)
    expect(inThinkBlock('<think>a</think>b')).toBe(false)
  })
  it('labels tools and time', () => {
    expect(toolLabel('web_fetch')).toBe('web fetch')
    expect(toolLabel(undefined)).toBe('a tool')
    expect(formatElapsed(9_400)).toBe('9s')
    expect(formatElapsed(65_000)).toBe('1m 05s')
  })
})

describe('modelWaitStatus', () => {
  it('escalates like the Cowork wait before the first token', () => {
    const s = modelWaitStatus()
    expect(s.label(0)).toBe('Waiting for the model…')
    expect(s.label(16_000)).toBe('Still waiting for the model…')
    expect(s.label(61_000)).toBe('The model is taking a while…')
  })

  it('opens at "Still waiting" for a stream that went quiet mid-reply', () => {
    expect(modelWaitStatus(true).label(10_000)).toBe('Still waiting for the model…')
  })
})
