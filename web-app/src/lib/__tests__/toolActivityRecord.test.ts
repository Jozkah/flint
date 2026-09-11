import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => h.invoke(...a),
}))

import {
  loadToolDiff,
  recordLifecycle,
  withToolActivity,
  type ToolActivityEvent,
} from '@/lib/toolActivity'

/** Every event the record was sent, in order. */
const sent = (): ToolActivityEvent[] =>
  h.invoke.mock.calls
    .filter((c) => c[0] === 'tool_activity_record')
    .map((c) => (c[1] as { event: ToolActivityEvent }).event)

beforeEach(() => {
  h.invoke.mockReset()
  h.invoke.mockImplementation(async () => undefined)
})

describe('what a recorded call carries', () => {
  it('keeps the input on the request and the outcome on the end', async () => {
    await withToolActivity(
      {
        toolCallId: 'c1',
        toolName: 'edit',
        input: { path: 'src/a.ts', old_string: 'x', new_string: 'y' },
      },
      { session: 's1', run: 'r1', source: 'cowork' },
      undefined,
      async () => ({
        output: 'Edited src/a.ts',
        isError: false,
        diff: '@@ edit 1/1 @@\n- x\n+ y',
      })
    )
    const [requested, running, done] = sent()
    expect(requested.phase).toBe('requested')
    expect(requested.input).toContain('src/a.ts')
    expect(requested.source).toBe('cowork')
    expect(running.phase).toBe('running')
    expect(done).toMatchObject({
      phase: 'succeeded',
      output: 'Edited src/a.ts',
      diff: '@@ edit 1/1 @@\n- x\n+ y',
      resource: 'src/a.ts',
    })
  })

  it('reads a chat-shaped error as a failure, and keeps the error text', async () => {
    await withToolActivity(
      { toolCallId: 'c2', toolName: 'web_fetch', input: { url: 'https://x' } },
      { session: 'thread-1', run: '', source: 'chat' },
      undefined,
      async () => ({ error: 'fetch failed: 404' })
    )
    const done = sent().at(-1)!
    expect(done.phase).toBe('failed')
    expect(done.output).toBe('fetch failed: 404')
    expect(done.session).toBe('thread-1')
  })

  it('names the background job a command started, and its exit code', async () => {
    await withToolActivity(
      { toolCallId: 'c3', toolName: 'bash', input: { command: 'pnpm build', background: true } },
      { session: 's1', run: 'r1' },
      undefined,
      async () => ({
        output:
          'Command was started as a background job and is continuing in the background (job_id=bash-ab-1).',
      })
    )
    expect(sent().at(-1)).toMatchObject({ job_id: 'bash-ab-1', phase: 'succeeded' })

    await withToolActivity(
      { toolCallId: 'c4', toolName: 'bash', input: { command: 'false' } },
      { session: 's1', run: 'r1' },
      undefined,
      async () => ({ output: 'nope\n[exit 1]', isError: true })
    )
    expect(sent().at(-1)).toMatchObject({ exit_code: 1, phase: 'failed' })
  })

  it('records a stopped run as cancelled, not failed', async () => {
    const controller = new AbortController()
    controller.abort()
    await withToolActivity(
      { toolCallId: 'c5', toolName: 'read', input: { path: 'a' } },
      { session: 's1', run: 'r1' },
      controller.signal,
      async () => ({ output: '', isError: true })
    )
    expect(sent().at(-1)?.phase).toBe('cancelled')
  })

  it('passes the outcome through untouched', async () => {
    const outcome = { output: 'as the model sees it', isError: false }
    const back = await withToolActivity(
      { toolCallId: 'c6', toolName: 'read', input: {} },
      { session: 's1', run: '' },
      undefined,
      async () => outcome
    )
    expect(back).toBe(outcome)
  })

  it('bounds a huge input before sending it', async () => {
    await withToolActivity(
      { toolCallId: 'c7', toolName: 'write', input: { path: 'a', content: 'x'.repeat(100_000) } },
      { session: 's1', run: '' },
      undefined,
      async () => ({ output: 'ok' })
    )
    expect(sent()[0].input!.length).toBeLessThanOrEqual(4097)
  })
})

describe('Chat and Cowork write one contract', () => {
  it('produce the same event shape, each under its own session', async () => {
    const run = (session: string, source: 'chat' | 'cowork') =>
      withToolActivity(
        { toolCallId: 'call_0', toolName: 'read', input: { path: 'a.md' } },
        { session, run: '', source },
        undefined,
        async () =>
          source === 'chat' ? { content: 'hello' } : { output: 'hello' }
      )
    await run('thread-1', 'chat')
    await run('cowork-1', 'cowork')
    const events = sent()
    const chat = events.filter((e) => e.session === 'thread-1')
    const cowork = events.filter((e) => e.session === 'cowork-1')
    expect(chat.map((e) => e.phase)).toEqual(['requested', 'running', 'succeeded'])
    expect(cowork.map((e) => e.phase)).toEqual(['requested', 'running', 'succeeded'])
    // Same keys on both sides: one contract, not two dialects.
    expect(Object.keys(chat[2]).sort()).toEqual(Object.keys(cowork[2]).sort())
    expect(chat[2].output).toBe('hello')
    expect(cowork[2].output).toBe('hello')
    expect(chat.every((e) => e.source === 'chat')).toBe(true)
    expect(cowork.every((e) => e.source === 'cowork')).toBe(true)
  })
})

describe('lifecycle events', () => {
  it('go into the same record, marked as lifecycle', async () => {
    await recordLifecycle(
      { session: 's1', run: 'r1', source: 'cowork', parent: 'call-9' },
      {
        id: 'stop:call-9:1',
        lifecycle: 'background-job',
        phase: 'cancelled',
        summary: 'Stopped bash-ab-1',
        jobId: 'bash-ab-1',
      }
    )
    expect(sent()[0]).toMatchObject({
      event_type: 'lifecycle',
      lifecycle: 'background-job',
      call: 'stop:call-9:1',
      phase: 'cancelled',
      parent: 'call-9',
      job_id: 'bash-ab-1',
    })
  })
})

describe('reading a stored diff', () => {
  it('asks for exactly that session and call', async () => {
    h.invoke.mockImplementation(async () => '+ a')
    expect(await loadToolDiff('s1', 'c1')).toBe('+ a')
    expect(h.invoke).toHaveBeenCalledWith('tool_activity_diff', {
      session: 's1',
      call: 'c1',
    })
  })

  it('is unavailable rather than empty when the backend has none or fails', async () => {
    h.invoke.mockImplementation(async () => null)
    expect(await loadToolDiff('s1', 'c1')).toBeNull()
    h.invoke.mockImplementation(async () => {
      throw new Error('no backend')
    })
    expect(await loadToolDiff('s1', 'c1')).toBeNull()
  })
})
