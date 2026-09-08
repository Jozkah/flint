import { describe, it, expect, vi, afterEach } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import {
  runTurn,
  consumeStep,
  assistantMessageFor,
  turnsFor,
  abortRun,
  answerAsk,
  isAbortLike,
  isRunning,
  __testing,
  beginRun,
  endRun,
  registerSubagent,
  unregisterSubagent,
  abortSubagent,
  type PendingToolCall,
  type StepResult,
  type ToolOutcome,
} from '../coworkRunner'
import { MAX_SESSION_TOKENS } from '../coworkBudget'

const streamOf = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk)
      c.close()
    },
  })

const textStep = (text: string, usageTotal?: number): UIMessageChunk[] => [
  { type: 'text-delta', id: 't', delta: text } as UIMessageChunk,
  ...(usageTotal !== undefined
    ? ([
        {
          type: 'finish',
          messageMetadata: { usage: { totalTokens: usageTotal } },
        },
      ] as unknown as UIMessageChunk[])
    : []),
]

const toolStep = (name: string, id = 'c1'): UIMessageChunk[] => [
  {
    type: 'tool-input-start',
    toolCallId: id,
    toolName: name,
  } as UIMessageChunk,
  {
    type: 'tool-input-available',
    toolCallId: id,
    toolName: name,
    input: { path: 'a.txt' },
  } as UIMessageChunk,
]

const noopSink = () => ({
  onText: vi.fn(),
  onToolStart: vi.fn(),
  onToolArgsDelta: vi.fn(),
  onToolCall: vi.fn(),
})

const deps = (
  steps: UIMessageChunk[][],
  dispatch = vi.fn(async (): Promise<ToolOutcome> => ({ output: 'ok' }))
) => {
  let i = 0
  return {
    sendStep: vi.fn(async () =>
      streamOf(steps[Math.min(i++, steps.length - 1)])
    ),
    dispatch,
    sink: noopSink(),
    onStep: vi.fn(),
    nextMessageId: (() => {
      let n = 0
      return () => `m${n++}`
    })(),
  }
}

const user = (text: string): UIMessage =>
  ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }) as UIMessage

describe('consumeStep', () => {
  it('folds text, tool calls and usage out of the chunk stream', async () => {
    const sink = noopSink()
    const r = await consumeStep(
      streamOf([...textStep('hi'), ...toolStep('read'), ...textStep('', 120)]),
      sink
    )
    expect(r.text).toBe('hi')
    expect(r.toolCalls).toEqual([
      { toolCallId: 'c1', toolName: 'read', input: { path: 'a.txt' } },
    ])
    expect(r.usage?.total_tokens).toBe(120)
    expect(sink.onToolStart).toHaveBeenCalledWith('c1', 'read')
  })

  it('surfaces an error chunk without throwing', async () => {
    const r = await consumeStep(
      streamOf([{ type: 'error', errorText: 'boom' } as UIMessageChunk]),
      noopSink()
    )
    expect(r.errorText).toBe('boom')
  })
})

describe('runTurn', () => {
  it('stops when the model answers without asking for tools', async () => {
    const d = deps([textStep('done')])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.stoppedBy).toBe('done')
    expect(out.steps).toBe(1)
    expect(d.sendStep).toHaveBeenCalledTimes(1)
  })

  it('keeps stepping while the model asks for tools', async () => {
    const d = deps([toolStep('read'), toolStep('read', 'c2'), textStep('done')])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.stoppedBy).toBe('done')
    expect(out.steps).toBe(3)
  })

  // Routine, not an error: the caller offers "Keep going" rather than a
  // failure banner, so this must return cleanly instead of throwing.
  it('stops cleanly at the step cap', async () => {
    const d = deps([toolStep('read')])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
      maxSteps: 3,
    })
    expect(out.stoppedBy).toBe('steps')
    expect(out.steps).toBe(3)
  })

  it('stops on the session token budget, counting tokens spent earlier', async () => {
    const d = deps([toolStep('read'), ...[textStep('x')]])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
      sessionTokens: MAX_SESSION_TOKENS,
    })
    expect(out.stoppedBy).toBe('tokens')
    expect(d.sendStep).not.toHaveBeenCalled()
  })

  // Each step's reported total includes the whole replayed prompt, so the spend
  // is the growth between steps, not the sum of the totals (which would be 300
  // here and would trip the cap on a run nowhere near it).
  it('charges only the growth in usage across steps', async () => {
    const d = deps([
      [...toolStep('read'), ...textStep('', 100)],
      textStep('done', 200),
    ])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.sessionTokens).toBe(200)
  })

  it('does not charge a step whose reported total shrank', async () => {
    const d = deps([
      [...toolStep('read'), ...textStep('', 100)],
      textStep('done', 60),
    ])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.sessionTokens).toBe(100)
  })

  it('marks outstanding calls interrupted when aborted mid-dispatch', async () => {
    const ac = new AbortController()
    const dispatch = vi.fn(async (): Promise<ToolOutcome> => {
      ac.abort()
      return { output: 'ok' }
    })
    const d = deps(
      [
        [
          ...toolStep('read', 'c1'),
          {
            type: 'tool-input-available',
            toolCallId: 'c2',
            toolName: 'read',
            input: {},
          } as UIMessageChunk,
        ],
      ],
      dispatch
    )
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: ac.signal,
    })
    expect(out.stoppedBy).toBe('aborted')
    const parts = (out.messages.at(-1) as { parts: any[] }).parts
    expect(parts.find((p) => p.toolCallId === 'c2').errorText).toBe(
      '(interrupted)'
    )
  })

  it('ends the run on an error chunk instead of looping', async () => {
    const d = deps([[{ type: 'error', errorText: 'boom' } as UIMessageChunk]])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.stoppedBy).toBe('error')
    expect(out.errorText).toBe('boom')
    expect(d.sendStep).toHaveBeenCalledTimes(1)
  })

  it('feeds each step tool results before the next one', async () => {
    const d = deps([toolStep('read'), textStep('done')])
    await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    const secondCall = d.sendStep.mock.calls[1][0] as UIMessage[]
    const parts = (secondCall.at(-1) as { parts: any[] }).parts
    expect(parts[0].state).toBe('output-available')
    expect(parts[0].output).toBe('ok')
  })
})

describe('diff sidecar', () => {
  // A diff is a rendering aid. Sending it to the model doubles the cost of
  // every edit and corrupts the output the tool widget parses.
  it('never reaches the model-facing message', () => {
    const step: StepResult = {
      text: '',
      toolCalls: [
        { toolCallId: 'c1', toolName: 'edit', input: {} } as PendingToolCall,
      ],
      usage: null,
      aborted: false,
    }
    const outcomes = new Map<string, ToolOutcome>([
      ['c1', { output: 'Wrote a.txt', diff: '- old\n+ new' }],
    ])
    const msg = assistantMessageFor('m0', step, outcomes)
    expect(JSON.stringify(msg)).not.toContain('+ new')
    // …but it does reach the transcript row the UI renders.
    expect(turnsFor(step, outcomes)[0].diff).toBe('- old\n+ new')
  })
})

describe('run handles', () => {
  it('aborts the stream, tools, children and pending asks together', () => {
    const h = beginRun('s1', 'r1', new AbortController())
    const child = new AbortController()
    h.subagents.set('sub1', child)
    const ask = vi.fn()
    h.pendingAsks.set('q1', ask)

    expect(isRunning('s1')).toBe(true)
    abortRun('s1')

    expect(h.outer.signal.aborted).toBe(true)
    expect(h.tools.signal.aborted).toBe(true)
    expect(child.signal.aborted).toBe(true)
    // Resolved as cancelled, not left hanging: the dispatch loop is awaiting it.
    expect(ask).toHaveBeenCalledWith(null)
    expect(isRunning('s1')).toBe(false)
  })

  it('answers a pending ask once and reports an unknown one', () => {
    const h = beginRun('s2', 'r2', new AbortController())
    const resolve = vi.fn()
    h.pendingAsks.set('q1', resolve)
    expect(answerAsk('s2', 'q1', [{ id: 'q1', selected: ['a'] }])).toBe(true)
    expect(resolve).toHaveBeenCalledOnce()
    expect(answerAsk('s2', 'q1', [])).toBe(false)
    abortRun('s2')
  })

  it('is a no-op for a session that is not running', () => {
    expect(() => abortRun('nope')).not.toThrow()
  })
})

describe('isAbortLike', () => {
  it('recognises the stop the tauri http plugin actually reports', () => {
    expect(isAbortLike(new Error('Request cancelled'))).toBe(true)
    const err = new Error('nope')
    err.name = 'AbortError'
    expect(isAbortLike(err)).toBe(true)
  })

  // A dropped socket says "connection aborted"; reporting that as a user stop
  // would hide a real failure behind a notice that says nothing went wrong.
  it('does not mistake a network failure for a stop', () => {
    expect(isAbortLike(new Error('connection aborted by peer'))).toBe(false)
  })

  it('trusts the signal over the message', () => {
    const c = new AbortController()
    c.abort()
    expect(isAbortLike(new Error('error sending request'), c.signal)).toBe(true)
  })
})

describe('runTurn failure paths', () => {
  const throwingDeps = (error: unknown) => ({
    ...deps([[]]),
    sendStep: vi.fn(async () => {
      throw error
    }),
  })

  it('reports a stop as an outcome instead of throwing', async () => {
    const c = new AbortController()
    const d = throwingDeps(new Error('Request cancelled'))
    c.abort()
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: c.signal,
    })
    expect(out.stoppedBy).toBe('aborted')
    expect(out.errorText).toBeUndefined()
  })

  it('reports a transport failure as an outcome, message intact', async () => {
    const d = throwingDeps(new Error('error sending request for url (…)'))
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.stoppedBy).toBe('error')
    expect(out.errorText).toContain('error sending request')
    // Nothing to replay: the model never answered, so no assistant turn exists.
    expect(out.messages).toHaveLength(1)
  })

  // An assistant message with no parts is a turn the model never took, and the
  // next request would replay it as one.
  it('appends no assistant message for a step that produced nothing', async () => {
    const d = deps([[{ type: 'error', errorText: 'boom' } as UIMessageChunk]])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.stoppedBy).toBe('error')
    expect(out.messages).toHaveLength(1)
  })
})

describe('cancelling one child without stopping the run', () => {
  afterEach(() => {
    __testing.handles.clear()
  })

  it('aborts only the child asked for', () => {
    // Every child used to share the run's controller, so the only way to stop
    // one was to stop the whole run.
    const outer = new AbortController()
    beginRun('s-one', 'r1', outer)
    const a = registerSubagent('s-one', 'task-a')
    const b = registerSubagent('s-one', 'task-b')

    expect(abortSubagent('s-one', 'task-a')).toBe(true)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(outer.signal.aborted).toBe(false)
  })

  it('reports that there was nothing to stop', () => {
    beginRun('s-two', 'r1', new AbortController())
    expect(abortSubagent('s-two', 'never-dispatched')).toBe(false)
    // Already stopped once: the controller is gone, so the second call is
    // honest about having done nothing.
    registerSubagent('s-two', 'task-a')
    expect(abortSubagent('s-two', 'task-a')).toBe(true)
    expect(abortSubagent('s-two', 'task-a')).toBe(false)
  })

  it('hands back an already-aborted controller when the run is gone', () => {
    // Dispatching into a run that has ended must not start work that nothing
    // can stop.
    const controller = registerSubagent('s-missing', 'task-a')
    expect(controller.signal.aborted).toBe(true)
  })

  it('stops every child when the run itself is aborted', () => {
    beginRun('s-three', 'r1', new AbortController())
    const child = registerSubagent('s-three', 'task-a')
    abortRun('s-three')
    expect(child.signal.aborted).toBe(true)
  })

  it('forgets a finished child so a later cancel reports nothing to stop', () => {
    beginRun('s-four', 'r1', new AbortController())
    registerSubagent('s-four', 'task-a')
    unregisterSubagent('s-four', 'task-a')
    expect(abortSubagent('s-four', 'task-a')).toBe(false)
  })

  it('will not let a finished turn unregister the run that replaced it', () => {
    const outer = new AbortController()
    beginRun('s-five', 'r1', new AbortController())
    beginRun('s-five', 'r2', outer)
    endRun('s-five', 'r1')
    expect(isRunning('s-five')).toBe(true)
    endRun('s-five', 'r2')
    expect(isRunning('s-five')).toBe(false)
  })
})

/**
 * The run-level guards, exercised through the loop that enforces them rather
 * than through their own helpers -- a guard that is correct in isolation and
 * unwired is worth nothing. AH-018/AH-019/AH-021/AH-024/AH-025/AH-029/AH-030.
 */
describe('run guards', () => {
  const at = Date.parse('2026-09-08T10:00:00Z')

  it('stops before starting a step it has no time for', async () => {
    const d = deps([toolStep('read'), textStep('done')])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
      deadline: { at, budgetMs: 60_000 },
      now: () => at + 1,
    })
    expect(out.stoppedBy).toBe('deadline')
    // Not one more model call spent discovering the deadline had passed.
    expect(d.sendStep).not.toHaveBeenCalled()
  })

  it('runs normally while there is time left', async () => {
    const d = deps([textStep('done')])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
      deadline: { at: at + 60_000, budgetMs: 60_000 },
      now: () => at,
    })
    expect(out.stoppedBy).toBe('done')
  })

  it('retries a transient failure and carries on', async () => {
    const d = deps([textStep('done')])
    let calls = 0
    d.sendStep = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        const failure = new Error('service unavailable') as Error & {
          status: number
        }
        failure.status = 503
        throw failure
      }
      return streamOf(textStep('done'))
    })

    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.stoppedBy).toBe('done')
    expect(calls).toBe(2)
  })

  it('does not retry a rejection a second attempt would only repeat', async () => {
    const d = deps([textStep('done')])
    let calls = 0
    d.sendStep = vi.fn(async () => {
      calls += 1
      const failure = new Error('unauthorized') as Error & { status: number }
      failure.status = 401
      throw failure
    })

    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(out.stoppedBy).toBe('error')
    expect(calls).toBe(1)
  })

  it('stops a run going in circles, and says so to the model', async () => {
    // The same call, over and over, with the model never answering.
    const d = deps([toolStep('read')])
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
      maxSteps: 50,
    })
    expect(out.stoppedBy).toBe('loop')
    expect(out.errorText).toContain('not making progress')
    // Stopped well before the step cap, which is the point of the guard.
    expect(out.steps).toBeLessThan(50)
  })

  it('does not call a stop by the user a timeout', async () => {
    const controller = new AbortController()
    const d = deps([textStep('done')])
    d.sendStep = vi.fn(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: controller.signal,
    })
    expect(out.stoppedBy).toBe('aborted')
  })

  it('reports a stream that never finished as a timeout, not an error', async () => {
    const d = deps([textStep('done')])
    d.sendStep = vi.fn(
      (_messages: UIMessage[], signal: AbortSignal) =>
        new Promise<ReadableStream<UIMessageChunk>>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timed out')), {
            once: true,
          })
        })
    ) as never

    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
      operationTimeoutMs: 5,
    })
    expect(out.stoppedBy).toBe('timeout')
  })
})
