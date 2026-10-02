import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const { choose, ask } = vi.hoisted(() => ({ choose: vi.fn(), ask: vi.fn() }))
vi.mock('@/lib/jevModelRouting', async (orig) => ({
  ...(await orig<typeof import('../jevModelRouting')>()),
  chooseJevModel: choose,
}))
vi.mock('@/lib/jevModelPrompt', () => ({ askToSwitchModel: ask }))

import { CustomChatTransport } from '@/lib/custom-chat-transport'
import { RoutedChatTransport } from '../routed-chat-transport'
import { useThreads } from '@/hooks/useThreads'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelRouting } from '@/hooks/useModelRouting'
import { useAssistant } from '@/hooks/useAssistant'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

const user = (id: string, text: string) =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage

const send = (t: RoutedChatTransport, messages: UIMessage[]) =>
  t.sendMessages({ messages, trigger: 'submit-message', chatId: 'c' } as never)

const turnModel = (t: RoutedChatTransport) =>
  (t as unknown as { turnModel?: { selectedProvider: string; selectedModel: { id: string } } }).turnModel

const gemma = { id: 'gemma-4', capabilities: ['tools'] }
const sonnet = { id: 'sonnet', capabilities: ['tools', 'vision'] }
const target = { provider: 'anthropic', model: 'sonnet', label: 'Anthropic / sonnet', local: false, capabilities: ['tools', 'vision'] }
const message = [user('u1', 'Please refactor the parser module and add tests')]

describe('RoutedChatTransport model routing', () => {
  let updateThread: ReturnType<typeof vi.fn>

  beforeEach(() => {
    choose.mockReset()
    ask.mockReset()
    choose.mockResolvedValue({ target, probability: 0.9, fallback: null })
    vi.spyOn(CustomChatTransport.prototype, 'sendMessages').mockResolvedValue(new ReadableStream() as never)
    updateThread = vi.fn()
    useThreads.setState({
      updateThread,
      threads: { t1: { id: 't1', model: { id: 'gemma-4', provider: 'llamacpp' }, assistants: [], metadata: {} } } as never,
    } as never)
    useAssistant.setState({ assistants: [], currentAssistant: undefined } as never)
    useModelProvider.setState({
      selectedProvider: 'llamacpp',
      selectedModel: gemma,
      providers: [
        { provider: 'llamacpp', active: true, models: [gemma] },
        { provider: 'anthropic', active: true, api_key: 'k', models: [sonnet] },
      ],
    } as never)
    useJevSettings.setState({ skillMode: 'on' })
    useModelRouting.setState({ mode: 'auto', pool: [{ provider: 'anthropic', model: 'sonnet' }] })
  })

  it('uses the routed model for the message in Always mode, and leaves the picker alone', async () => {
    const t = new RoutedChatTransport('sys', 't1')
    await send(t, message)
    expect(turnModel(t)?.selectedProvider).toBe('anthropic')
    expect(turnModel(t)?.selectedModel.id).toBe('sonnet')
    expect(useModelProvider.getState().selectedProvider).toBe('llamacpp')
    expect(ask).not.toHaveBeenCalled()
    expect(updateThread).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ metadata: expect.objectContaining({ jevRoutedModel: { messageId: 'u1', provider: 'anthropic', model: 'sonnet' } }) })
    )
  })

  it('asks first in Ask mode and switches only when the person agrees', async () => {
    useModelRouting.setState({ mode: 'ask' })
    ask.mockResolvedValueOnce(true)
    const yes = new RoutedChatTransport('sys', 't1')
    await send(yes, message)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ targetLabel: 'Anthropic / sonnet' }))
    expect(turnModel(yes)?.selectedModel.id).toBe('sonnet')

    ask.mockResolvedValueOnce(false)
    const no = new RoutedChatTransport('sys', 't1')
    await send(no, message)
    expect(turnModel(no)).toBeUndefined()
  })

  it('keeps the current model when Jev finds nothing clearly better', async () => {
    choose.mockResolvedValue({ target: null, probability: 0.3, fallback: 'abstained' })
    const t = new RoutedChatTransport('sys', 't1')
    await send(t, message)
    expect(turnModel(t)).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks Jev nothing when off, with no models listed, in a temporary chat or when Jev itself is off', async () => {
    const cases: Array<() => void> = [
      () => useModelRouting.setState({ mode: 'off' }),
      () => useModelRouting.setState({ pool: [] }),
      () => useJevSettings.setState({ skillMode: 'off' }),
    ]
    for (const arrange of cases) {
      choose.mockClear()
      useModelRouting.setState({ mode: 'auto', pool: [{ provider: 'anthropic', model: 'sonnet' }] })
      useJevSettings.setState({ skillMode: 'on' })
      arrange()
      const t = new RoutedChatTransport('sys', 't1')
      await send(t, message)
      expect(choose).not.toHaveBeenCalled()
      expect(turnModel(t)).toBeUndefined()
    }
    choose.mockClear()
    const temp = new RoutedChatTransport('sys', TEMPORARY_CHAT_ID)
    await send(temp, message)
    expect(choose).not.toHaveBeenCalled()
  })

  it('does not ask again for the same message (tool follow-ups) and drops the choice for the next one', async () => {
    const t = new RoutedChatTransport('sys', 't1')
    await send(t, message)
    await send(t, message)
    expect(choose).toHaveBeenCalledTimes(1)
    expect(turnModel(t)?.selectedModel.id).toBe('sonnet')
    choose.mockResolvedValue({ target: null, probability: 0.2, fallback: 'abstained' })
    await send(t, [...message, user('u2', 'Now a quick question about naming things')])
    expect(turnModel(t)).toBeUndefined()
  })

  it('keeps what a message was routed to when it is regenerated after a restart', async () => {
    useThreads.setState({
      threads: {
        t1: { id: 't1', model: { id: 'gemma-4', provider: 'llamacpp' }, assistants: [], metadata: { jevRoutedModel: { messageId: 'u1', provider: 'anthropic', model: 'sonnet' } } },
      } as never,
    } as never)
    const t = new RoutedChatTransport('sys', 't1')
    await send(t, message)
    expect(choose).not.toHaveBeenCalled()
    expect(turnModel(t)?.selectedModel.id).toBe('sonnet')
  })
})
