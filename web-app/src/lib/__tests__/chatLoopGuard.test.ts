import { beforeEach, describe, expect, it } from 'vitest'
import { __testing, chatLoopStop, chatTurnId, noteChatToolCall } from '../chatLoopGuard'
import {
  canonicalKey,
  detectLoop,
  REPEAT_LIMIT,
  TOOL_FAILURE_STREAK_LIMIT,
} from '../runLoopGuard'

// The live case: a third-party MCP shell refused one command after another
// with different errors, and Chat kept calling it for 50+ turns.
const failing = (i: number) => ({
  tool: 'execute_command',
  input: { command: `gh repo view attempt-${i}` },
  failed: true,
  error: i % 2 ? 'Command not whitelisted' : `exit status ${i}`,
})

describe('failing-tool streak', () => {
  it('stops one tool failing in a row with different arguments and errors', () => {
    const calls = Array.from({ length: TOOL_FAILURE_STREAK_LIMIT }, (_, i) => failing(i))
    expect(detectLoop(calls.slice(0, -1)).tripped).toBe(false)
    expect(detectLoop(calls)).toMatchObject({
      tripped: true,
      reason: 'failing-tool',
      detail: `execute_command failed ${TOOL_FAILURE_STREAK_LIMIT} times in a row`,
    })
  })

  it('a success of that tool ends the streak', () => {
    const calls = [
      failing(0),
      failing(1),
      failing(2),
      { tool: 'execute_command', input: { command: 'ls' }, failed: false },
      failing(3),
      failing(4),
    ]
    expect(detectLoop(calls).tripped).toBe(false)
  })
})

describe('Chat loop guard', () => {
  beforeEach(() => __testing.reset())

  it('refuses the next call once the streak trips, then ends the turn', () => {
    for (let i = 0; i < TOOL_FAILURE_STREAK_LIMIT; i++) {
      expect(chatLoopStop('t1', 'm1')).toBeNull()
      noteChatToolCall('t1', 'm1', failing(i))
    }
    const first = chatLoopStop('t1', 'm1')
    expect(first?.end).toBe(false)
    expect(first?.errorText).toMatch(/^Stopped: execute_command failed 5 times in a row/)
    expect(first?.errorText).toMatch(/Do not call any tools/)
    // The model was told and called a tool again: the turn ends.
    expect(chatLoopStop('t1', 'm1')?.end).toBe(true)
  })

  it('starts over with a new assistant message', () => {
    for (let i = 0; i < TOOL_FAILURE_STREAK_LIMIT; i++) noteChatToolCall('t1', 'm1', failing(i))
    expect(chatLoopStop('t1', 'm1')).not.toBeNull()
    expect(chatLoopStop('t1', 'm2')).toBeNull()
  })
})

// The live case: qwen over an OpenAI-compatible provider with super-shell,
// approving a fresh command id and running the same `git status` over and
// over, every call succeeding.
let uuidSeq = 0
const freshUuid = () =>
  `0000000${uuidSeq++ % 10}-1234-4abc-8def-${String(uuidSeq).padStart(12, '0')}`
const approve = () => ({
  tool: 'approve_command',
  input: { commandId: freshUuid() },
  failed: false,
})
const gitStatus = () => ({
  tool: 'execute_command',
  input: {
    command: 'cmd',
    args: ['/c', 'cd', '/d', 'C:\tmp\proj\gh-x', '&&', 'git', 'status'],
  },
  failed: false,
})

describe('approve/execute loop', () => {
  beforeEach(() => __testing.reset())

  it('fresh command ids do not make a call new', () => {
    expect(canonicalKey(approve())).toBe(canonicalKey(approve()))
    expect(
      canonicalKey({ tool: 'x', input: { note: `run ${freshUuid()}` } })
    ).toBe(canonicalKey({ tool: 'x', input: { note: `run ${freshUuid()}` } }))
    // Ordinary ids are progress, not noise.
    expect(canonicalKey({ tool: 'x', input: { issueId: 1 } })).not.toBe(
      canonicalKey({ tool: 'x', input: { issueId: 2 } })
    )
  })

  it('trips on alternating successful calls', () => {
    const calls = []
    for (let i = 0; i < REPEAT_LIMIT; i++) calls.push(approve(), gitStatus())
    expect(detectLoop(calls.slice(0, -2)).tripped).toBe(false)
    expect(detectLoop(calls)).toMatchObject({ tripped: true })
  })

  it('does not stop a few identical status checks', () => {
    const calls = Array.from({ length: REPEAT_LIMIT - 1 }, gitStatus)
    expect(detectLoop(calls).tripped).toBe(false)
  })

  it('keeps the history when every step gets a new assistant message id', () => {
    const messages = [
      { id: 'u1', role: 'user' },
      { id: 'a-step', role: 'assistant' },
    ]
    let stopped = null
    for (let step = 0; step < REPEAT_LIMIT + 1 && !stopped; step++) {
      const turn = chatTurnId(messages, `a-${step}`)
      for (const call of [approve(), gitStatus()]) {
        stopped = chatLoopStop('t1', turn)
        if (stopped) break
        noteChatToolCall('t1', turn, call)
      }
    }
    expect(stopped).not.toBeNull()
    expect(stopped?.errorText).toMatch(/called 5 times with the same arguments/)
  })

  it('a new user message starts a new turn', () => {
    const turn1 = chatTurnId([{ id: 'u1', role: 'user' }], 'a1')
    for (let i = 0; i < REPEAT_LIMIT; i++) noteChatToolCall('t1', turn1, gitStatus())
    expect(chatLoopStop('t1', turn1)).not.toBeNull()
    const turn2 = chatTurnId(
      [
        { id: 'u1', role: 'user' },
        { id: 'a1', role: 'assistant' },
        { id: 'u2', role: 'user' },
      ],
      'a2'
    )
    expect(chatLoopStop('t1', turn2)).toBeNull()
  })
})
