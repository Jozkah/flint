/**
 * The loop guard's stop, the closing text-only turn it gives the model, and the
 * stricter counting of failed shell commands.
 */
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import { runTurn, type ToolOutcome } from '../coworkRunner'
import {
  classifyShellFailure,
  detectLoop,
  SHELL_FAILURE_BUDGET,
  type ObservedCall,
} from '../runLoopGuard'

const streamOf = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk)
      c.close()
    },
  })

let callN = 0
const bashStep = (): UIMessageChunk[] => {
  const id = `c${callN++}`
  return [
    { type: 'tool-input-start', toolCallId: id, toolName: 'bash' } as UIMessageChunk,
    {
      type: 'tool-input-available',
      toolCallId: id,
      toolName: 'bash',
      input: { command: `python probe${id}.py` },
    } as UIMessageChunk,
  ]
}

const user = (text: string): UIMessage =>
  ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }) as UIMessage

const notFound = async (): Promise<ToolOutcome> => ({
  output:
    "python : The term 'python' is not recognized as the name of a cmdlet, function, script file, or operable program.",
  isError: true,
})

const sink = () => ({
  onText: vi.fn(),
  onToolStart: vi.fn(),
  onToolArgsDelta: vi.fn(),
  onToolCall: vi.fn(),
})

describe('closing turn after the loop guard', () => {
  it('gives the model one text-only turn carrying the guard note', async () => {
    const sendStep = vi.fn(
      async (
        _msgs: UIMessage[],
        _signal: AbortSignal,
        opts?: { textOnly?: boolean }
      ) =>
        streamOf(
          opts?.textOnly
            ? [
                {
                  type: 'text-delta',
                  id: 't',
                  delta: 'Python is not available here.',
                } as UIMessageChunk,
              ]
            : bashStep()
        )
    )
    let n = 0
    const out = await runTurn({
      messages: [user('run the script')],
      signal: new AbortController().signal,
      maxSteps: 50,
      deps: {
        sendStep,
        dispatch: vi.fn(notFound),
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: () => `m${n++}`,
      },
    })

    expect(out.stoppedBy).toBe('loop')
    expect(out.errorText).toContain(
      'for the same reason (program not available)'
    )
    expect(out.errorText).not.toContain('the same way')
    // Three failing steps, then exactly one text-only step.
    const textOnly = sendStep.mock.calls.filter((c) => c[2]?.textOnly)
    expect(textOnly).toHaveLength(1)
    expect(sendStep).toHaveBeenCalledTimes(4)
    // The model saw the note on the last tool result.
    expect(JSON.stringify(textOnly[0][0])).toContain('Flint stopped tool use')
    // Its explanation is the run's last message.
    const last = out.messages[out.messages.length - 1] as any
    expect(last.role).toBe('assistant')
    expect(
      last.parts.some((p: any) => p.text === 'Python is not available here.')
    ).toBe(true)
  })

  it('never runs tool calls the model makes on the closing turn', async () => {
    const dispatch = vi.fn(notFound)
    let n = 0
    const out = await runTurn({
      messages: [user('go')],
      signal: new AbortController().signal,
      maxSteps: 50,
      deps: {
        sendStep: vi.fn(async () => streamOf(bashStep())),
        dispatch,
        sink: sink(),
        onStep: vi.fn(),
        nextMessageId: () => `m${n++}`,
      },
    })
    expect(out.stoppedBy).toBe('loop')
    expect(dispatch).toHaveBeenCalledTimes(3)
  })
})

describe('failed shell commands', () => {
  const failing = (error: string, command = 'x'): ObservedCall => ({
    tool: 'bash',
    input: { command },
    failed: true,
    error,
  })

  it('classifies the reasons that repeat', () => {
    expect(
      classifyShellFailure(
        "The term 'cargo' is not recognized as the name of a cmdlet"
      )
    ).toBe('program not available')
    expect(classifyShellFailure('Access is denied.')).toBe('access denied')
    expect(
      classifyShellFailure('this command needs a POSIX shell -- it uses ...')
    ).toBe('needs a POSIX shell')
    expect(
      classifyShellFailure(
        'boom\n[sandbox: `x` is installed at y but this sandbox cannot run it]'
      )
    ).toBe('blocked by the sandbox')
    expect(classifyShellFailure('test failed: 2 of 10')).toBeNull()
  })

  it('stops three different commands failing for the same reason', () => {
    const verdict = detectLoop([
      failing(
        "The term 'python' is not recognized as the name of a cmdlet",
        'python a.py'
      ),
      { tool: 'read', input: { path: 'a.py' } },
      failing(
        "The term 'py' is not recognized as the name of a cmdlet",
        'py a.py'
      ),
      failing(
        "'python3' is not recognized as an internal or external command",
        'python3 a.py'
      ),
    ])
    expect(verdict).toMatchObject({
      tripped: true,
      reason: 'failing-shell',
      detail:
        'bash failed 3 times in a row for the same reason (program not available)',
    })
  })

  it('lets a successful command end a streak', () => {
    expect(
      detectLoop([
        failing('Access is denied.', 'a'),
        failing('Access is denied (2).', 'b'),
        { tool: 'bash', input: { command: 'dir' }, failed: false },
        failing('Access is denied (3).', 'c'),
      ])
    ).toEqual({ tripped: false })
  })

  it('caps failed shell commands per run whatever the reasons', () => {
    const calls = Array.from({ length: SHELL_FAILURE_BUDGET }, (_, i) =>
      failing(`error number ${i}`, `cmd ${i}`)
    )
    expect(detectLoop(calls.slice(0, -1))).toEqual({ tripped: false })
    expect(detectLoop(calls)).toMatchObject({
      tripped: true,
      reason: 'shell-failure-budget',
    })
  })

  it('says "the same error", not "the same way", when the commands differed', () => {
    const verdict = detectLoop([
      failing('exit 2', 'a'),
      failing('exit 2', 'b'),
      failing('exit 2', 'c'),
    ])
    expect(verdict).toMatchObject({
      detail: 'bash failed 3 times with the same error',
    })
  })
})
