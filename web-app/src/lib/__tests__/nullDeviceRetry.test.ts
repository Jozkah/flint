import { describe, it, expect, vi, beforeEach } from 'vitest'

const { executeAgentTool, retryAgentToolUnsandboxed, withdrawAgentToolUnsandboxed } =
  vi.hoisted(() => ({
    executeAgentTool: vi.fn(),
    retryAgentToolUnsandboxed: vi.fn(),
    withdrawAgentToolUnsandboxed: vi.fn(async () => {}),
  }))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool,
  previewAgentChange: vi.fn(async () => undefined),
  retryAgentToolUnsandboxed,
  withdrawAgentToolUnsandboxed,
}))

import {
  NULL_DEVICE_RETRY_REASON,
  RAN_UNSANDBOXED_NOTE,
  RETRY_DECLINED_NOTE,
  RETRY_UNAVAILABLE_NOTE,
  offerUnsandboxedRetry,
} from '../nullDeviceRetry'
import { dispatchCoworkTool } from '../coworkDispatch'
import type { CoworkMode } from '../coworkMode'

const FAILURE = 'open NUL: Access is denied.\n[device_path_sandbox_refused: ...]'

describe('offerUnsandboxedRetry', () => {
  beforeEach(() => {
    retryAgentToolUnsandboxed.mockReset()
    withdrawAgentToolUnsandboxed.mockClear()
  })

  it('runs the call outside the sandbox when the user allows it', async () => {
    retryAgentToolUnsandboxed.mockResolvedValue({ content: 'built\n[exit 0]', ran: true })
    const out = await offerUnsandboxedRetry({
      threadId: 's1',
      retry: 'r1',
      failure: FAILURE,
      ask: async () => true,
    })
    expect(retryAgentToolUnsandboxed).toHaveBeenCalledWith('s1', 'r1')
    expect(out).toEqual({
      output: RAN_UNSANDBOXED_NOTE + 'built\n[exit 0]',
      isError: false,
      resources: undefined,
      firstAttempt: { output: FAILURE, isError: true },
    })
    expect(withdrawAgentToolUnsandboxed).not.toHaveBeenCalled()
  })

  it('reports a failed unsandboxed run as a failure of that run', async () => {
    retryAgentToolUnsandboxed.mockResolvedValue({ error: 'boom\n[exit 1]', ran: true })
    const out = await offerUnsandboxedRetry({
      threadId: 's1',
      retry: 'r1',
      failure: FAILURE,
      ask: async () => true,
    })
    expect(out.isError).toBe(true)
    expect(out.output).toBe(RAN_UNSANDBOXED_NOTE + 'boom\n[exit 1]')
    expect(out.firstAttempt).toEqual({ output: FAILURE, isError: true })
  })

  it('keeps the original failure when an allowed retry could not start', async () => {
    retryAgentToolUnsandboxed.mockResolvedValue({ error: 'no longer available', ran: false })
    const out = await offerUnsandboxedRetry({
      threadId: 's1',
      retry: 'r1',
      failure: FAILURE,
      ask: async () => true,
    })
    expect(out.isError).toBe(true)
    expect(out.output.startsWith(FAILURE)).toBe(true)
    expect(out.output).toContain('no longer available')
  })

  it('returns the original failure and withdraws the offer when declined', async () => {
    const out = await offerUnsandboxedRetry({
      threadId: 's1',
      retry: 'r1',
      failure: FAILURE,
      ask: async () => false,
    })
    expect(retryAgentToolUnsandboxed).not.toHaveBeenCalled()
    expect(withdrawAgentToolUnsandboxed).toHaveBeenCalledWith('s1', 'r1')
    expect(out).toMatchObject({ output: FAILURE + RETRY_DECLINED_NOTE, isError: true })
  })

  it('treats a prompt that throws as declined', async () => {
    const out = await offerUnsandboxedRetry({
      threadId: 's1',
      retry: 'r1',
      failure: FAILURE,
      ask: async () => {
        throw new Error('closed')
      },
    })
    expect(retryAgentToolUnsandboxed).not.toHaveBeenCalled()
    expect(out.output).toBe(FAILURE + RETRY_DECLINED_NOTE)
  })

  it('says the retry could not be offered when nothing can ask', async () => {
    const out = await offerUnsandboxedRetry({ threadId: 's1', retry: 'r1', failure: FAILURE })
    expect(out.output).toBe(FAILURE + RETRY_UNAVAILABLE_NOTE)
    expect(withdrawAgentToolUnsandboxed).toHaveBeenCalledWith('s1', 'r1')
  })

  it("names Windows' null device in the prompt", () => {
    expect(NULL_DEVICE_RETRY_REASON).toContain('outside the sandbox')
    expect(NULL_DEVICE_RETRY_REASON).toContain("Windows' null device")
  })
})

describe('dispatchCoworkTool, a bash call the null device refused', () => {
  const ctx = (over = {}) => ({
    sessionId: 's1',
    readOnlyFolder: null,
    mode: 'auto' as CoworkMode,
    webSearch: false,
    onTodo: vi.fn(async () => ({ output: 'todo ok' })),
    onAsk: vi.fn(async () => ({ output: 'ask ok' })),
    onTask: vi.fn(async () => ({ output: 'task ok' })),
    ...over,
  })

  beforeEach(() => {
    executeAgentTool.mockReset()
    retryAgentToolUnsandboxed.mockReset()
    withdrawAgentToolUnsandboxed.mockClear()
  })

  it('asks through the approval prompt, always, and returns the unsandboxed result', async () => {
    executeAgentTool.mockResolvedValue({ error: FAILURE, unsandboxedRetry: 'r1' })
    retryAgentToolUnsandboxed.mockResolvedValue({ content: 'ok', ran: true })
    const onApprove = vi.fn(async () => true)
    const out = await dispatchCoworkTool(
      { toolCallId: 'c1', toolName: 'bash', input: { command: 'go build' } },
      ctx({ onApprove })
    )
    expect(onApprove).toHaveBeenCalledWith(
      'c1',
      'bash',
      { command: 'go build' },
      undefined,
      undefined,
      { alwaysAsk: true, reason: NULL_DEVICE_RETRY_REASON }
    )
    expect(retryAgentToolUnsandboxed).toHaveBeenCalledWith('s1', 'r1')
    expect(out.isError).toBeFalsy()
    expect(out.output).toBe(RAN_UNSANDBOXED_NOTE + 'ok')
  })

  it('returns the failure with a note when the user declines', async () => {
    executeAgentTool.mockResolvedValue({ error: FAILURE, unsandboxedRetry: 'r1' })
    const out = await dispatchCoworkTool(
      { toolCallId: 'c1', toolName: 'bash', input: { command: 'go build' } },
      ctx({ onApprove: vi.fn(async () => false) })
    )
    expect(retryAgentToolUnsandboxed).not.toHaveBeenCalled()
    expect(out).toMatchObject({ output: FAILURE + RETRY_DECLINED_NOTE, isError: true })
  })

  it('leaves an ordinary bash failure alone', async () => {
    executeAgentTool.mockResolvedValue({ error: 'exit 1' })
    const onApprove = vi.fn(async () => true)
    const out = await dispatchCoworkTool(
      { toolCallId: 'c1', toolName: 'bash', input: { command: 'false' } },
      ctx({ onApprove })
    )
    expect(onApprove).not.toHaveBeenCalled()
    expect(out).toMatchObject({ output: 'exit 1', isError: true })
  })
})
