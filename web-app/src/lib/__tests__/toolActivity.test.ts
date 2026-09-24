/**
 * The lifecycle events a tool call emits. AH-050.
 *
 * These assert what the record must contain, not how it is stored: the store
 * itself is covered in `activity.rs`, where the fold and the restart behaviour
 * live.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const invoke = vi.fn(async () => undefined)
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }))

import {
  capabilityOf,
  isHideablePhase,
  kindOf,
  loadToolDiff,
  recordToolActivity,
  resourceOf,
  withToolActivity,
  type ToolActivityPhase,
} from '../toolActivity'

type Recorded = { phase: ToolActivityPhase; tool: string; call: string } & Record<
  string,
  unknown
>

const events = (): Recorded[] =>
  invoke.mock.calls
    .filter((c) => c[0] === 'tool_activity_record')
    .map((c) => (c[1] as { event: Recorded }).event)

const call = (toolName: string, input: unknown = {}) => ({
  toolCallId: `c-${toolName}`,
  toolName,
  input,
})

beforeEach(() => {
  invoke.mockClear()
})

describe('classification', () => {
  it('names what each tool is allowed to do', () => {
    expect(capabilityOf('read')).toBe('read')
    expect(capabilityOf('write')).toBe('write')
    expect(capabilityOf('bash')).toBe('exec')
    expect(capabilityOf('web_fetch')).toBe('net')
  })

  it('treats an MCP tool as exec rather than guessing from its name', () => {
    expect(capabilityOf('github__create_issue')).toBe('exec')
    expect(kindOf('github__create_issue')).toBe('mcp')
  })

  it('records the resource a call acted on, and nothing when there is none', () => {
    expect(resourceOf({ path: 'src/app.ts' })).toBe('src/app.ts')
    expect(resourceOf('{"command":"ls -la"}')).toBe('ls -la')
    expect(resourceOf({ url: 'http://llm-host:8080/v1' })).toBe('http://llm-host:8080/v1')
    expect(resourceOf({ thinking: 'about it' })).toBe('')
  })
})

describe('what may be hidden', () => {
  it('hides only a clean success', () => {
    expect(isHideablePhase('succeeded')).toBe(true)
    for (const phase of [
      'requested',
      'awaiting-permission',
      'allowed',
      'refused',
      'running',
      'failed',
      'cancelled',
      'stale',
      'timed-out',
    ] as ToolActivityPhase[]) {
      expect(isHideablePhase(phase)).toBe(false)
    }
  })
})

describe('withToolActivity', () => {
  const ctx = { session: 's1', run: 'r1', agent: 'main' }

  it('records a successful call from request to result', async () => {
    const out = await withToolActivity(
      call('read', { path: 'a.ts' }),
      ctx,
      undefined,
      async () => ({ output: 'ok' })
    )
    expect(out).toEqual({ output: 'ok' })
    expect(events().map((e) => e.phase)).toEqual([
      'requested',
      'running',
      'succeeded',
    ])
    expect(events()[0]).toMatchObject({
      session: 's1',
      run: 'r1',
      agent: 'main',
      tool: 'read',
      capability: 'read',
      resource: 'a.ts',
    })
  })

  it('separates a failure from a cancellation', async () => {
    await withToolActivity(call('bash'), ctx, undefined, async () => ({
      output: 'boom',
      isError: true,
    }))
    expect(events().at(-1)?.phase).toBe('failed')

    invoke.mockClear()
    const aborted = new AbortController()
    aborted.abort()
    await withToolActivity(call('bash'), ctx, aborted.signal, async () => ({
      output: '(interrupted)',
      isError: true,
    }))
    expect(events().at(-1)?.phase).toBe('cancelled')
  })

  it('records a call that threw, and lets the throw through', async () => {
    await expect(
      withToolActivity(call('bash'), ctx, undefined, async () => {
        throw new Error('unforeseen')
      })
    ).rejects.toThrow('unforeseen')
    expect(events().at(-1)).toMatchObject({
      phase: 'failed',
      detail: 'unforeseen',
    })
  })

  it('does not make the tool wait for its own audit line', async () => {
    let routed = false
    const slow = vi.fn(async () => {
      // One tick, standing in for the IPC round trip.
      await Promise.resolve()
      return undefined
    })
    invoke.mockImplementation(slow as never)
    await withToolActivity(call('read'), ctx, undefined, async () => {
      routed = true
      return { output: 'ok' }
    })
    expect(routed).toBe(true)
    invoke.mockImplementation(async () => undefined)
  })

  it('never fails a tool call because recording failed', async () => {
    invoke.mockRejectedValue(new Error('no backend'))
    const out = await withToolActivity(
      call('read'),
      ctx,
      undefined,
      async () => ({ output: 'ok' })
    )
    expect(out).toEqual({ output: 'ok' })
    invoke.mockImplementation(async () => undefined)
  })

  it('keeps events in the order they were reported across concurrent calls', async () => {
    await Promise.all([
      withToolActivity(call('read'), ctx, undefined, async () => ({
        output: 'a',
      })),
      withToolActivity(call('grep'), ctx, undefined, async () => ({
        output: 'b',
      })),
    ])
    const byCall = (id: string) =>
      events()
        .filter((e) => e.call === id)
        .map((e) => e.phase)
    expect(byCall('c-read')).toEqual(['requested', 'running', 'succeeded'])
    expect(byCall('c-grep')).toEqual(['requested', 'running', 'succeeded'])
  })
})

describe('recordToolActivity', () => {
  it('fills the fields a caller did not name', async () => {
    await recordToolActivity({ call: 'c1', tool: 'bash', phase: 'refused' })
    expect(events()[0]).toMatchObject({
      // Version 2: sequence, input/output, lifecycle and change fields.
      v: 2,
      call: 'c1',
      tool: 'bash',
      capability: 'exec',
      kind: 'command',
      phase: 'refused',
    })
    expect(typeof events()[0].at).toBe('string')
  })
})

// #244: the invocation reaches tool_activity_diff, and an unknown one is sent
// as null so the backend falls back to the flat layout.
describe('loadToolDiff', () => {
  it('passes the invocation through, or null when there is none', async () => {
    invoke.mockClear()
    invoke.mockImplementation((async () => 'diff') as never)
    expect(await loadToolDiff('s', 'c', 'inv-7')).toBe('diff')
    expect(invoke).toHaveBeenLastCalledWith('tool_activity_diff', { session: 's', call: 'c', invocation: 'inv-7' })
    await loadToolDiff('s', 'c', '')
    expect(invoke).toHaveBeenLastCalledWith('tool_activity_diff', { session: 's', call: 'c', invocation: null })
    await loadToolDiff('s', 'c')
    expect(invoke).toHaveBeenLastCalledWith('tool_activity_diff', { session: 's', call: 'c', invocation: null })
    invoke.mockImplementation(async () => undefined)
  })
})
