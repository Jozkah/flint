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
  schemaIssues,
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

  /// janhq/jan#8905, found by the real-app two-session Stop scenario. The run
  /// read the model stream without watching its signal, so Stop only ended a
  /// run whose transport closed the stream in response. The desktop transport
  /// does not always: a provider still streaming kept the session running
  /// after Stop, however long it was waited on.
  it('ends a run on Stop even when the stream itself never ends', async () => {
    const controller = new AbortController()
    let sent = 0
    const endless = (): ReadableStream<UIMessageChunk> =>
      new ReadableStream({
        start(c) {
          c.enqueue({ type: 'text-delta', id: 't', delta: 'thinking ' } as UIMessageChunk)
          // Never closed, never errored: only the run's own signal can end it.
        },
      })
    const d = {
      ...deps([]),
      sendStep: vi.fn(async () => {
        sent += 1
        return endless()
      }),
    }
    d.sink.onText.mockImplementation(() => controller.abort('cancelled'))
    const out = await Promise.race([
      runTurn({
        messages: [user('go')],
        signal: controller.signal,
        deps: d,
      } as never),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ])
    expect(out).not.toBe('hung')
    expect((out as { stoppedBy: string }).stoppedBy).toBe('aborted')
    expect(sent).toBe(1)
  })

  /// The same, one step earlier, found by the same scenario: the request was
  /// still waiting for its response to start -- a busy server, a queue -- and
  /// the transport only gave up on it 40 s after Stop.
  it('ends a run on Stop while the request has not started streaming', async () => {
    const controller = new AbortController()
    const cancelled = vi.fn()
    let answer: (s: ReadableStream<UIMessageChunk>) => void = () => {}
    const d = {
      ...deps([]),
      sendStep: vi.fn(
        () =>
          new Promise<ReadableStream<UIMessageChunk>>((resolve) => {
            answer = resolve
          })
      ),
    }
    const run = runTurn({
      messages: [user('go')],
      signal: controller.signal,
      deps: d,
    } as never)
    await Promise.resolve()
    controller.abort('cancelled')
    const out = await Promise.race([
      run,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ])
    expect(out).not.toBe('hung')
    expect((out as { stoppedBy: string }).stoppedBy).toBe('aborted')
    // A stream that turns up after Stop is released, not left streaming.
    answer(new ReadableStream({ cancel: cancelled }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toHaveBeenCalled()
  })

  it('surfaces an error chunk without throwing', async () => {
    const r = await consumeStep(
      streamOf([{ type: 'error', errorText: 'boom' } as UIMessageChunk]),
      noopSink()
    )
    expect(r.errorText).toBe('boom')
  })
})

describe('steering a running turn (janhq/jan#8864)', () => {
  const userText = (m: UIMessage) =>
    (m.parts as { type: string; text?: string }[])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')

  it('delivers input after every tool result of the step and before the next model call, in order', async () => {
    const pending: UIMessage[][] = [
      [],
      [
        { id: 's1', role: 'user', parts: [{ type: 'text', text: 'use pnpm' }] } as UIMessage,
        { id: 's2', role: 'user', parts: [{ type: 'text', text: 'then test' }] } as UIMessage,
      ],
    ]
    const d = {
      ...deps([toolStep('read'), textStep('done')]),
      takeSteering: vi.fn(() => pending.shift() ?? []),
    }
    const out = await runTurn({
      messages: [user('go')],
      signal: new AbortController().signal,
      deps: d,
    } as never)
    expect(out.stoppedBy).toBe('done')
    // The second model call is the first to see it: after the tool round.
    const second = (d.sendStep.mock.calls[1] as unknown as [UIMessage[]])[0]
    const roles = second.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'user'])
    expect(userText(second[2])).toBe('use pnpm')
    expect(userText(second[3])).toBe('then test')
    const first = (d.sendStep.mock.calls[0] as unknown as [UIMessage[]])[0]
    expect(first).toHaveLength(1)
  })

  it('skips remaining tool calls when steering arrives during a tool batch', async () => {
    let waiting = false
    const dispatch = vi.fn(async () => {
      waiting = true
      return { output: 'first complete' }
    })
    const d = {
      ...deps([[...toolStep('first', 'c1'), ...toolStep('second', 'c2')], textStep('redirected')], dispatch),
      hasSteering: () => waiting,
      takeSteering: vi.fn(() => {
        if (!waiting) return []
        waiting = false
        return [{ id: 's1', role: 'user', parts: [{ type: 'text', text: 'change direction' }] } as UIMessage]
      }),
    }
    const out = await runTurn({
      messages: [user('go')],
      signal: new AbortController().signal,
      deps: d,
    } as never)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const second = (d.sendStep.mock.calls[1] as unknown as [UIMessage[]])[0]
    expect(second.at(-1)?.role).toBe('user')
    expect(out.errorText).toBeUndefined()
    expect(out.stoppedBy).toBe('done')
  })

  it('continues the same run when input arrives with the final answer', async () => {
    let offered = 0
    const d = {
      ...deps([textStep('first answer'), textStep('revised answer')]),
      takeSteering: vi.fn(() => {
        offered += 1
        // Nothing at the first boundary; the correction arrives while the
        // first answer is being written.
        return offered === 2
          ? [{ id: 's1', role: 'user', parts: [{ type: 'text', text: 'correction' }] } as UIMessage]
          : []
      }),
    }
    const out = await runTurn({
      messages: [user('go')],
      signal: new AbortController().signal,
      deps: d,
    } as never)
    expect(d.sendStep).toHaveBeenCalledTimes(2)
    const second = (d.sendStep.mock.calls[1] as unknown as [UIMessage[]])[0]
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(userText(second[2])).toBe('correction')
    expect(out.stoppedBy).toBe('done')
    // Never dressed up as the model's own words.
    expect(out.messages.filter((m) => m.role === 'assistant').map(userText)).toEqual([
      'first answer',
      'revised answer',
    ])
  })

  it('takes nothing after a stop', async () => {
    const controller = new AbortController()
    const takeSteering = vi.fn(() => [])
    const d = { ...deps([toolStep('read')]), takeSteering }
    d.dispatch.mockImplementation(async () => {
      controller.abort('cancelled')
      return { output: 'ok' }
    })
    const out = await runTurn({
      messages: [user('go')],
      signal: controller.signal,
      deps: d,
    } as never)
    expect(out.stoppedBy).toBe('aborted')
    // Offered once, before the first call; never after the stop.
    expect(takeSteering).toHaveBeenCalledTimes(1)
  })
})

describe('an invalid tool call', () => {
  /// The regression. A call to a tool the model was not offered came back as
  /// `tool-input-error` and was ignored, so the step had no tool calls and the
  /// loop treated it as a finished answer. Nothing ran, nothing was recorded,
  /// and the model was never told.
  it('is kept as a failed call, not dropped', async () => {
    const r = await consumeStep(
      streamOf([
        { type: 'tool-input-start', toolCallId: 'c9', toolName: 'ls' } as UIMessageChunk,
        {
          type: 'tool-input-error',
          toolCallId: 'c9',
          toolName: 'ls',
          input: { path: '.' },
          errorText: "Model tried to call unavailable tool 'ls'.",
        } as unknown as UIMessageChunk,
      ]),
      noopSink()
    )
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].invalid).toContain('unavailable tool')
  })

  it('is never dispatched, and the model is told why', async () => {
    const d = deps([
      [
        {
          type: 'tool-input-error',
          toolCallId: 'c9',
          toolName: 'ls',
          input: { path: '.' },
          errorText: "Model tried to call unavailable tool 'ls'.",
        } as unknown as UIMessageChunk,
      ],
      textStep('done'),
    ])
    const out = await runTurn({
      messages: [user('go')],
      signal: new AbortController().signal,
      deadline: { at: Date.now() + 60_000, budgetMs: 60_000 },
      now: Date.now,
      sessionTokens: 0,
      deps: d,
    } as never)
    expect(d.dispatch).not.toHaveBeenCalled()
    // The run went on to another step instead of ending on the bad call.
    expect(d.sendStep).toHaveBeenCalledTimes(2)
    const told = JSON.stringify(out.messages)
    expect(told).toContain('was not run')
  })

  /// Arguments that are not JSON arrive as the raw text. Kept as the call's
  /// input, that string went into the history, and every later request in the
  /// session replayed a tool call whose input is not an object.
  it('replays with an object input when the arguments were not JSON', async () => {
    const { convertToModelMessages } = await import('ai')
    const d = deps([
      [
        {
          type: 'tool-input-error',
          toolCallId: 'c9',
          toolName: 'read',
          input: '{"path":',
          errorText: 'Invalid input for tool read: JSON parsing failed',
        } as unknown as UIMessageChunk,
      ],
      textStep('done'),
    ])
    const out = await runTurn({
      messages: [user('read with broken arguments')],
      signal: new AbortController().signal,
      deadline: { at: Date.now() + 60_000, budgetMs: 60_000 },
      now: Date.now,
      sessionTokens: 0,
      deps: d,
    } as never)
    const modelMessages = await convertToModelMessages(out.messages)
    const calls = modelMessages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p: any) => p.type === 'tool-call') as any[]
    expect(calls).toHaveLength(1)
    expect(typeof calls[0].input).toBe('object')
    expect(calls[0].input).not.toBeNull()
    // The model is still told what it sent, so it can correct itself.
    expect(JSON.stringify(out.messages)).toContain('{\\"path\\":')
  })

  /// A model that appends a stray brace after otherwise-valid JSON
  /// (`{"path":"…"}}`) failed the SDK's strict parse. Rather than refuse the
  /// whole call, salvage the first complete object and dispatch it.
  it('salvages a call whose arguments have trailing junk after valid JSON', async () => {
    const d = deps([
      [
        {
          type: 'tool-input-error',
          toolCallId: 'c9',
          toolName: 'read',
          input: '{"path":"/x/HEAD"}}',
          errorText:
            'Invalid input for tool read: JSON parsing failed: Unexpected non-whitespace character after JSON',
        } as unknown as UIMessageChunk,
      ],
      textStep('done'),
    ])
    const out = await runTurn({
      messages: [user('read HEAD')],
      signal: new AbortController().signal,
      deadline: { at: Date.now() + 60_000, budgetMs: 60_000 },
      now: Date.now,
      sessionTokens: 0,
      deps: d,
    } as never)
    // The recovered call ran instead of being refused.
    expect(d.dispatch).toHaveBeenCalledTimes(1)
    const dispatched = (d.dispatch as any).mock.calls[0][0]
    expect(dispatched.input).toEqual({ path: '/x/HEAD' })
    expect(JSON.stringify(out.messages)).not.toContain('was not run')
  })

  /// A `write` of a whole large file overran the model's output budget, so its
  /// arguments were cut off mid-content and never parsed. The refusal must say
  /// so and tell the model to split the write, not dump the giant blob back.
  it('tells the model to split a write whose arguments were cut off', async () => {
    const truncated = `{"path":"main.cpp","content":"${'x'.repeat(4000)}` // no closing quote/brace
    const d = deps([
      [
        {
          type: 'tool-input-error',
          toolCallId: 'c9',
          toolName: 'write',
          input: truncated,
          errorText: 'Invalid input for tool write: JSON parsing failed',
        } as unknown as UIMessageChunk,
      ],
      textStep('done'),
    ])
    const out = await runTurn({
      messages: [user('write the file')],
      signal: new AbortController().signal,
      deadline: { at: Date.now() + 60_000, budgetMs: 60_000 },
      now: Date.now,
      sessionTokens: 0,
      deps: d,
    } as never)
    expect(d.dispatch).not.toHaveBeenCalled()
    const told = JSON.stringify(out.messages)
    expect(told).toContain('cut off')
    expect(told).toContain('`edit`')
    // The 4000-char blob is not echoed back into the transcript/context.
    expect(told).not.toContain('x'.repeat(1000))
  })
})

describe('a refused call names what was wrong (transcript audit #12)', () => {
  it('reads the fields out of a schema validation error', () => {
    const issues = [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['path'],
        message: 'Required',
      },
    ]
    const text = [
      'Invalid input for tool edit: Type validation failed: Value: {}.',
      `Error message: ${JSON.stringify(issues, null, 2)}`,
    ].join('\n')
    expect(schemaIssues(text)).toEqual(['`path`: Required'])
    expect(schemaIssues("missing required argument 'content'")).toEqual([
      '`content`: Required',
    ])
  })

  it('shows the expected call shape and the keys that were sent', async () => {
    const r = await consumeStep(
      streamOf([
        {
          type: 'tool-input-error',
          toolCallId: 'c9',
          toolName: 'edit',
          input: { file_path: 'a.txt', old_string: 'x', new_string: 'y' },
          errorText:
            'Invalid input for tool edit: Type validation failed: [{"path": ["path"], "message": "Required"}]',
        } as unknown as UIMessageChunk,
      ]),
      noopSink()
    )
    const invalid = r.toolCalls[0].invalid ?? ''
    expect(invalid).toContain('`path`: Required')
    expect(invalid).toContain('Expected call shape: {"path": "<file>", "edits": [')
    expect(invalid).toContain('You sent: `file_path`, `old_string`, `new_string`')
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

  // One request, one invocation: the caller binds a step's tool calls to the
  // request that asked for them, which it can only do before they run (a
  // call that dispatches a subagent sends requests of its own).
  it('reports each response before any of its tool calls run', async () => {
    const order: string[] = []
    const d = {
      ...deps(
        [toolStep('read'), textStep('done')],
        vi.fn(async (): Promise<ToolOutcome> => {
          order.push('dispatch')
          return { output: 'ok' }
        })
      ),
      onResponse: vi.fn(() => order.push('response')),
    }
    await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
    })
    expect(order).toEqual(['response', 'dispatch', 'response'])
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
    // errorText is what the user reads on the stop notice: written to them,
    // not the model's "say what you were trying to do and wait" instruction.
    expect(out.errorText).toContain('Flint stopped the run')
    expect(out.errorText).not.toContain('wait for instructions')
    // Stopped well before the step cap, which is the point of the guard.
    expect(out.steps).toBeLessThan(50)
  })

  it('lets a success end a tool’s failure streak when it reports no isError', async () => {
    // A session's gh calls failed five times with successes in between, and
    // the run was stopped for "git failed 5 times in a row": a successful
    // outcome leaves isError unset, and the streak skipped it as unknown.
    const call = (n: number): UIMessageChunk[] => [
      { type: 'tool-input-start', toolCallId: `c${n}`, toolName: 'git' } as UIMessageChunk,
      {
        type: 'tool-input-available',
        toolCallId: `c${n}`,
        toolName: 'git',
        input: { args: ['issue', 'view', String(n)] },
      } as UIMessageChunk,
    ]
    const steps = Array.from({ length: 10 }, (_, n) => call(n))
    let n = 0
    const d = deps(
      [...steps, textStep('done')],
      vi.fn(async (): Promise<ToolOutcome> =>
        // fail, ok, fail, ok, ... -- never two failures in a row.
        n++ % 2 === 0 ? { output: `ERROR ${n}`, isError: true } : { output: 'ok' }
      )
    )
    const out = await runTurn({
      messages: [user('hi')],
      deps: d,
      signal: new AbortController().signal,
      maxSteps: 50,
    })
    expect(out.stoppedBy).toBe('done')
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

describe('a call that ends the turn (#296)', () => {
  it('finishes the run without calling the model again', async () => {
    const d = deps(
      [toolStep('ask'), textStep('should never be sent')],
      vi.fn(async (): Promise<ToolOutcome> => ({
        output: 'accepted',
        endsTurn: true,
      }))
    )
    const out = await runTurn({
      messages: [user('look around')],
      signal: new AbortController().signal,
      deps: d,
    } as never)
    expect(out.stoppedBy).toBe('done')
    expect(d.sendStep).toHaveBeenCalledTimes(1)
    // The ask and its answer are still in the history the next run reads.
    expect(out.messages).toHaveLength(2)
    expect(d.onStep).toHaveBeenCalledTimes(1)
  })
})

describe('automatic recovery', () => {
  const cutOff = (text: string): UIMessageChunk[] => [
    { type: 'text-delta', id: 't', delta: text } as UIMessageChunk,
    { type: 'finish', messageMetadata: { finishReason: 'length' } } as unknown as UIMessageChunk,
  ]
  const run = (d: ReturnType<typeof deps>) =>
    runTurn({ messages: [user('go')], signal: new AbortController().signal, deps: d } as never)

  it('continues a reply cut off by the output limit, once', async () => {
    const d = deps([cutOff('The class is `BasicParent'), textStep(' and that is all.')])
    const out = await run(d)
    expect(out.stoppedBy).toBe('done')
    expect(d.sendStep).toHaveBeenCalledTimes(2)
    const second = (d.sendStep.mock.calls[1] as unknown as [UIMessage[]])[0]
    expect(JSON.stringify(second.at(-1))).toContain('cut off by the output limit')
  })

  it('does not continue a second time', async () => {
    const d = deps([cutOff('a'), cutOff('b'), textStep('c')])
    await run(d)
    expect(d.sendStep).toHaveBeenCalledTimes(2)
  })

  it('asks once more after an empty reply', async () => {
    const d = deps([textStep(''), textStep('answer')])
    const out = await run(d)
    expect(out.stoppedBy).toBe('done')
    expect(d.sendStep).toHaveBeenCalledTimes(2)
  })

  it('continues a text reply whose stream was cut off', async () => {
    const dropped: UIMessageChunk[] = [
      { type: 'text-delta', id: 't', delta: 'half an ans' } as UIMessageChunk,
      { type: 'finish', messageMetadata: { streamCutOff: true } } as unknown as UIMessageChunk,
    ]
    const d = deps([dropped, textStep('wer.')])
    const out = await run(d)
    expect(out.stoppedBy).toBe('done')
    expect(d.sendStep).toHaveBeenCalledTimes(2)
  })
})

describe('harness refusals and steering yields', () => {
  const inputError = (id: string, name: string, errorText: string, input: unknown = {}) =>
    ({
      type: 'tool-input-error',
      toolCallId: id,
      toolName: name,
      input,
      errorText,
    }) as unknown as UIMessageChunk
  const go = (d: ReturnType<typeof deps>) =>
    runTurn({
      messages: [user('go')],
      signal: new AbortController().signal,
      deps: d,
    } as never)

  it('reports web access as off only for a tool that was not offered', async () => {
    const off = deps([
      [inputError('w1', 'web_fetch', "Model tried to call unavailable tool 'web_fetch'.")],
      textStep('done'),
    ])
    expect(JSON.stringify((await go(off)).messages)).toContain('web access is turned')

    const on = deps([
      [inputError('w2', 'web_fetch', 'Invalid input for tool web_fetch: url is required')],
      textStep('done'),
    ])
    const told = JSON.stringify((await go(on)).messages)
    expect(told).not.toContain('web access is turned')
    expect(told).toContain('url is required')
  })

  it('keeps the arguments of skill_list instead of forcing an empty call', async () => {
    const d = deps([
      [
        inputError(
          's1',
          'skill_list',
          'Invalid input for tool skill_list: query must be a string',
          { query: 5 }
        ),
      ],
      textStep('done'),
    ])
    await go(d)
    expect(d.dispatch).not.toHaveBeenCalled()
    const { NO_ARG_TOOLS } = await import('../coworkRunner')
    expect(NO_ARG_TOOLS.has('skill_list')).toBe(false)
  })

  it('does not skip the rest of a batch for steering that has nothing to deliver, and says what was not run', async () => {
    const dispatch = vi.fn(async (): Promise<ToolOutcome> => ({ output: 'ok' }))
    const d = {
      ...deps([[...toolStep('first', 'c1'), ...toolStep('second', 'c2')], textStep('done')], dispatch),
      // Looks pending, but the mail was consumed by a tool: nothing to take.
      hasSteering: () => true,
      takeSteering: vi.fn(() => []),
    }
    await go(d)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const second = (d.sendStep.mock.calls[1] as unknown as [UIMessage[]])[0]
    const last = second.at(-1) as UIMessage
    expect(last.role).toBe('user')
    expect(JSON.stringify(last)).toContain('Not run; re-issue if still needed: second')
  })

  it('yields to steering during a batch of invalid calls and skips the rest', async () => {
    const d = {
      ...deps([
        [
          inputError('i1', 'ls', "Model tried to call unavailable tool 'ls'."),
          inputError('i2', 'ls', "Model tried to call unavailable tool 'ls'."),
        ],
        textStep('done'),
      ]),
      hasSteering: () => true,
      takeSteering: vi.fn(() => []),
    }
    const out = await go(d)
    const told = JSON.stringify(out.messages)
    expect(told).toContain('steered this turn before this call started')
    expect(told).toContain('Re-issue it if it is still needed')
  })
})

describe('post-tool-batch report from the run loop', () => {
  const twoCalls = [...toolStep('ls', 'c1'), ...toolStep('read', 'c2')]
  const run = (d: ReturnType<typeof deps> & { onBatchFinished?: (n: string[]) => void }) =>
    runTurn({ messages: [user('go')], signal: new AbortController().signal, deps: d } as never)

  it('reports each step once, with its tool names in call order', async () => {
    const onBatchFinished = vi.fn()
    const out = await run({ ...deps([twoCalls, toolStep('write', 'c3'), textStep('done')]), onBatchFinished })
    expect(out.stoppedBy).toBe('done')
    expect(onBatchFinished.mock.calls).toEqual([[['ls', 'read']], [['write']]])
  })

  it('says nothing for a turn with no tool calls', async () => {
    const onBatchFinished = vi.fn()
    await run({ ...deps([textStep('just text')]), onBatchFinished })
    expect(onBatchFinished).not.toHaveBeenCalled()
  })

  it('reports after every result is in, before the next model request', async () => {
    const order: string[] = []
    const d = deps([twoCalls, textStep('done')], vi.fn(async (): Promise<ToolOutcome> => {
      order.push('dispatch')
      return { output: 'ok' }
    }))
    const send = d.sendStep
    d.sendStep = vi.fn(async () => {
      order.push('send')
      return send()
    }) as never
    await run({ ...d, onBatchFinished: () => order.push('batch') })
    expect(order).toEqual(['send', 'dispatch', 'dispatch', 'batch', 'send'])
  })

  it('a throwing observer neither ends the run nor changes a result', async () => {
    const dispatch = vi.fn(async (): Promise<ToolOutcome> => ({ output: 'RESULT' }))
    const out = await run({
      ...deps([twoCalls, textStep('done')], dispatch),
      onBatchFinished: () => {
        throw new Error('hook blew up')
      },
    })
    expect(out.stoppedBy).toBe('done')
    expect(dispatch).toHaveBeenCalledTimes(2)
    const results = out.messages.flatMap((m) => m.parts).filter((p) => String(p.type).startsWith('tool-'))
    expect(results.every((p) => (p as { output?: unknown }).output === 'RESULT')).toBe(true)
  })

  it('a slow observer does not hold the run (it is never awaited)', async () => {
    const t0 = Date.now()
    const out = await run({
      ...deps([twoCalls, textStep('done')]),
      onBatchFinished: () => {
        void new Promise((r) => setTimeout(r, 5000))
      },
    })
    expect(out.stoppedBy).toBe('done')
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
