import { beforeEach, describe, expect, it } from 'vitest'
import { __testing, chatLoopStop, noteChatToolCall } from '../chatLoopGuard'
import { detectLoop, TOOL_FAILURE_STREAK_LIMIT } from '../runLoopGuard'

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
