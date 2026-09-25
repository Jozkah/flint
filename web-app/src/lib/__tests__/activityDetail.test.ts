import { describe, it, expect } from 'vitest'
import { describeToolCall, mainArgOf, toolCallFailed } from '@/lib/activityDetail'

const labels = { ok: 'ok', failed: 'failed' }

describe('Activity tool-call detail', () => {
  it('picks the most telling argument and truncates it', () => {
    expect(mainArgOf({ command: 'ls   -la', path: '/x' })).toBe('ls -la')
    expect(mainArgOf({ query: 'cats' })).toBe('cats')
    expect(mainArgOf({ command: ['git', 'status'] })).toBe('git status')
    expect(mainArgOf({ other: 1 })).toBe('')
    expect(mainArgOf({ command: 'x'.repeat(100) })).toHaveLength(60)
  })

  it('reads failure from the state or an MCP isError result', () => {
    expect(toolCallFailed('output-error', undefined)).toBe(true)
    expect(toolCallFailed('output-available', { isError: true })).toBe(true)
    expect(toolCallFailed('output-available', { content: [] })).toBe(false)
  })

  it('joins argument, status, duration and server', () => {
    expect(
      describeToolCall({
        input: { command: 'npm test' },
        output: {},
        state: 'output-available',
        startedAt: 1000,
        endedAt: 1500,
        server: 'desktop-commander',
        labels,
      })
    ).toBe('npm test · ok · 500ms · desktop-commander')
    expect(
      describeToolCall({ input: {}, output: undefined, state: 'output-error', labels })
    ).toBe('failed')
  })
})
