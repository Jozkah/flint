import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { UIMessage } from '@ai-sdk/react'

const toast = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

import { useEngineRecovery } from '../useEngineRecovery'
import { resetAutoRetries } from '@/lib/chat/turnRecovery'
import { LLAMACPP_CRASH_MESSAGE } from '@/lib/model/transportErrors'
import { useAppState } from '@/hooks/useAppState'

const RESET_MID_STREAM =
  'localhost:3141 failed: error decoding response body: connection reset (os error 10054)'

const user = (id: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text: 'run it' }],
})

type Status = 'submitted' | 'streaming' | 'ready' | 'error'

function setup({
  provider = 'llamacpp',
  messages = [user('u1')],
  reloadModel = vi.fn().mockResolvedValue(undefined),
}: {
  provider?: string
  messages?: UIMessage[]
  reloadModel?: ReturnType<typeof vi.fn>
} = {}) {
  const chatMessagesRef = { current: messages }
  const setChatMessages = vi.fn()
  const sendMessage = vi.fn().mockResolvedValue(undefined)
  const handleRegenerate = vi.fn()
  const providerObject = { provider, models: [{ id: 'qwen' }] }
  const props = (status: Status, error: Error | undefined) => ({
    threadId: 't1',
    status,
    error,
    selectedProvider: provider,
    selectedModelId: 'qwen',
    getProviderByName: () => providerObject as never,
    serviceHub: { models: () => ({ reloadModel }) } as never,
    chatMessagesRef,
    setChatMessages: setChatMessages as never,
    sendMessage: sendMessage as never,
    handleRegenerate,
    t: ((key: string) => key) as never,
  })
  const hook = renderHook(
    ({ status, error }: { status: Status; error: Error | undefined }) =>
      useEngineRecovery(props(status, error)),
    { initialProps: { status: 'streaming' as Status, error: undefined as Error | undefined } }
  )
  return {
    ...hook,
    chatMessagesRef,
    setChatMessages,
    sendMessage,
    handleRegenerate,
    reloadModel,
    providerObject,
  }
}

describe('useEngineRecovery', () => {
  beforeEach(() => {
    resetAutoRetries()
    vi.clearAllMocks()
    useAppState.setState({ busyThreads: {} } as never)
  })

  it('reloads the model and retries the turn once when the engine dies mid-stream', async () => {
    const s = setup()
    s.rerender({ status: 'error', error: new Error(RESET_MID_STREAM) })

    await waitFor(() => expect(s.handleRegenerate).toHaveBeenCalledTimes(1))
    expect(s.reloadModel).toHaveBeenCalledWith(s.providerObject, 'qwen')
    expect(s.handleRegenerate).toHaveBeenCalledWith(undefined)
    expect(toast.loading).toHaveBeenCalledWith('chat:turnRecovery.restarting', {
      id: 'engine-recovery-t1',
    })

    // The retried turn answers: the recovered note is shown.
    s.rerender({ status: 'submitted', error: undefined })
    s.rerender({ status: 'ready', error: undefined })
    expect(toast.success).toHaveBeenCalledWith('chat:turnRecovery.recovered', {
      id: 'engine-recovery-t1',
    })
  })

  it('shows the error when the engine dies again on the retry', async () => {
    const s = setup()
    s.rerender({ status: 'error', error: new Error(LLAMACPP_CRASH_MESSAGE) })
    await waitFor(() => expect(s.handleRegenerate).toHaveBeenCalledTimes(1))

    s.rerender({ status: 'submitted', error: undefined })
    s.rerender({ status: 'error', error: new Error(LLAMACPP_CRASH_MESSAGE) })
    // Give a second recovery every chance to start; it must not.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(s.reloadModel).toHaveBeenCalledTimes(1)
    expect(s.handleRegenerate).toHaveBeenCalledTimes(1)
    expect(s.sendMessage).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('chat:turnRecovery.retryFailed', {
      id: 'engine-recovery-t1',
    })
  })

  it('never runs a finished tool call again: the turn resumes after it', async () => {
    const failed: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'run_command',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { command: 'rm -rf build' },
          output: 'done',
        } as never,
        { type: 'text', text: 'Build removed. Next I wi' },
      ],
    }
    const s = setup({ messages: [user('u1'), failed] })
    s.rerender({ status: 'error', error: new Error(RESET_MID_STREAM) })

    await waitFor(() => expect(s.sendMessage).toHaveBeenCalledTimes(1))
    // Continued, not regenerated: a regenerate would drop the result and the
    // model would ask for the command again.
    expect(s.handleRegenerate).not.toHaveBeenCalled()
    expect(s.sendMessage).toHaveBeenCalledWith()
    const resumed = s.setChatMessages.mock.calls[0][0] as UIMessage[]
    expect(resumed.at(-1)!.parts).toEqual([failed.parts[0]])
    expect(s.chatMessagesRef.current).toBe(resumed)
  })

  it('waits for tool calls still running before planning the retry', async () => {
    useAppState.setState({ busyThreads: { t1: true } } as never)
    const s = setup()
    s.rerender({ status: 'error', error: new Error(RESET_MID_STREAM) })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(s.reloadModel).not.toHaveBeenCalled()

    act(() => useAppState.setState({ busyThreads: {} } as never))
    await waitFor(() => expect(s.handleRegenerate).toHaveBeenCalledTimes(1))
  })

  it('leaves non-local providers alone', async () => {
    const s = setup({ provider: 'openai' })
    s.rerender({ status: 'error', error: new Error(RESET_MID_STREAM) })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(s.reloadModel).not.toHaveBeenCalled()
    expect(s.handleRegenerate).not.toHaveBeenCalled()
    expect(toast.loading).not.toHaveBeenCalled()
  })

  it('does not retry errors that are not a gone engine', async () => {
    const s = setup()
    s.rerender({ status: 'error', error: new Error('request cancelled') })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(s.reloadModel).not.toHaveBeenCalled()
  })

  it('says so when the model cannot be loaded again', async () => {
    const s = setup({
      reloadModel: vi.fn().mockRejectedValue(new Error('out of memory')),
    })
    s.rerender({ status: 'error', error: new Error(RESET_MID_STREAM) })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('chat:turnRecovery.restartFailed', {
        id: 'engine-recovery-t1',
      })
    )
    expect(s.handleRegenerate).not.toHaveBeenCalled()
  })

  it('does nothing when the turn was answered while the model loaded', async () => {
    let finish: () => void = () => {}
    const s = setup({
      reloadModel: vi.fn(() => new Promise<void>((r) => (finish = r))),
    })
    s.rerender({ status: 'error', error: new Error(RESET_MID_STREAM) })
    await waitFor(() => expect(s.reloadModel).toHaveBeenCalled())
    // The user sent the message again by hand.
    s.rerender({ status: 'streaming', error: undefined })
    await act(async () => finish())
    expect(s.handleRegenerate).not.toHaveBeenCalled()
    expect(toast.dismiss).toHaveBeenCalledWith('engine-recovery-t1')
  })

  it('cancels a pending recovery when the thread is left', async () => {
    let finish: () => void = () => {}
    const s = setup({
      reloadModel: vi.fn(() => new Promise<void>((r) => (finish = r))),
    })
    s.rerender({ status: 'error', error: new Error(RESET_MID_STREAM) })
    await waitFor(() => expect(s.reloadModel).toHaveBeenCalled())
    s.unmount()
    await act(async () => finish())
    expect(s.handleRegenerate).not.toHaveBeenCalled()
  })
})
