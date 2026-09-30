import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const { choose } = vi.hoisted(() => ({ choose: vi.fn() }))
vi.mock('@/lib/jevRouting', async (orig) => ({
  ...(await orig<typeof import('../jevRouting')>()),
  chooseJevPromptRoute: choose,
}))

import { CustomChatTransport } from '@/lib/custom-chat-transport'
import { RoutedChatTransport } from '../routed-chat-transport'
import { useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import { useJevSettings } from '@/hooks/useJevSettings'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

const asst = (id: string, instructions = `${id} instructions`) =>
  ({ id, name: id, instructions }) as unknown as Assistant

const flint = asst('jan')
const coal = asst('coal')
const custom = asst('mine')

const user = (id: string, text: string) =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage

const send = (t: RoutedChatTransport, messages: UIMessage[], abortSignal?: AbortSignal) =>
  t.sendMessages({
    messages,
    trigger: 'submit-message',
    chatId: 'c',
    abortSignal,
  } as never)

const setThread = (over: Record<string, unknown> = {}) =>
  useThreads.setState({
    threads: {
      t1: { id: 't1', model: { id: 'm', provider: 'p' }, assistants: [flint], ...over },
    } as never,
  })

describe('RoutedChatTransport', () => {
  let updateThread: ReturnType<typeof vi.fn>
  let setCurrent: ReturnType<typeof vi.fn>

  beforeEach(() => {
    choose.mockReset()
    choose.mockResolvedValue(null)
    vi.spyOn(CustomChatTransport.prototype, 'sendMessages').mockResolvedValue(
      new ReadableStream() as never
    )
    updateThread = vi.fn()
    setCurrent = vi.fn()
    useThreads.setState({ updateThread } as never)
    useAssistant.setState({
      assistants: [flint, coal, custom],
      currentAssistant: flint,
      setCurrentAssistant: setCurrent,
    } as never)
    useJevSettings.setState({ skillMode: 'on' })
    setThread()
  })

  it('routes once per user message id', async () => {
    const t = new RoutedChatTransport('sys', 't1')
    const m = [user('u1', 'Please refactor the parser module')]
    await send(t, m)
    await send(t, m)
    expect(choose).toHaveBeenCalledTimes(1)
    await send(t, [...m, user('u2', 'And now add some tests too')])
    expect(choose).toHaveBeenCalledTimes(2)
  })

  it('does not route a thread the user pinned (a built-in pick, a custom one, or None)', async () => {
    for (const assistants of [[coal], [custom], []]) {
      choose.mockClear()
      setThread({ assistants })
      await send(new RoutedChatTransport('sys', 't1'), [user('u1', 'Please refactor the parser module')])
      expect(choose.mock.calls[0][0].pinned).toBe(true)
    }
  })

  it('routes a thread still on Flint, or on the assistant Jev applied itself', async () => {
    await send(new RoutedChatTransport('sys', 't1'), [user('u1', 'Please refactor the parser module')])
    expect(choose.mock.calls[0][0].pinned).toBe(false)

    choose.mockClear()
    setThread({ assistants: [coal], metadata: { jevRoutedAssistantId: 'coal' } })
    await send(new RoutedChatTransport('sys', 't1'), [user('u9', 'Please refactor the parser module')])
    expect(choose.mock.calls[0][0].pinned).toBe(false)
  })

  it('applies a route to the thread only, never to the global assistant store', async () => {
    choose.mockResolvedValue({ assistantId: 'coal', mode: 'review', probability: 0.9, fallback: null })
    const t = new RoutedChatTransport('sys', 't1')
    await send(t, [user('u1', 'Please refactor the parser module')])
    expect(updateThread).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        assistants: [expect.objectContaining({ id: 'coal' })],
        metadata: expect.objectContaining({
          jevRoutedMessageId: 'u1',
          jevRoutedAssistantId: 'coal',
        }),
      })
    )
    expect(setCurrent).not.toHaveBeenCalled()
  })

  it('keeps the current assistant when Jev abstains, and clears last turn\'s mode', async () => {
    const t = new RoutedChatTransport('sys', 't1')
    choose.mockResolvedValueOnce({ assistantId: 'coal', mode: 'auto', probability: 0.9, fallback: null })
    await send(t, [user('u1', 'Please refactor the parser module')])
    expect((t as unknown as { routedMode: string | null }).routedMode).toBe('auto')

    updateThread.mockClear()
    choose.mockResolvedValueOnce({ assistantId: null, mode: null, probability: 0.2, fallback: 'abstained' })
    await send(t, [user('u2', 'Something completely different now')])
    expect((t as unknown as { routedMode: string | null }).routedMode).toBeNull()
    expect(updateThread.mock.calls[0]?.[1]).not.toHaveProperty('assistants')
  })

  it('does not route again for a message already routed before a restart', async () => {
    setThread({ metadata: { jevRoutedMessageId: 'u1' } })
    await send(new RoutedChatTransport('sys', 't1'), [user('u1', 'Please refactor the parser module')])
    expect(choose).not.toHaveBeenCalled()
  })

  it('tells Jev when the chat is temporary and passes the turn\'s abort signal', async () => {
    const controller = new AbortController()
    await send(
      new RoutedChatTransport('sys', TEMPORARY_CHAT_ID),
      [user('u1', 'Please refactor the parser module')],
      controller.signal
    )
    expect(choose.mock.calls[0][0]).toMatchObject({ temporary: true, signal: controller.signal })
  })

  it('writes nothing to the thread when Jev is off', async () => {
    useJevSettings.setState({ skillMode: 'off' })
    await send(new RoutedChatTransport('sys', 't1'), [user('u1', 'Please refactor the parser module')])
    expect(updateThread).not.toHaveBeenCalled()
  })
})
