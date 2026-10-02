import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const { choose, ask, windows } = vi.hoisted(() => ({
  choose: vi.fn(),
  ask: vi.fn(),
  windows: new Map<string, number | null>(),
}))
vi.mock('@/lib/knownContextWindow', () => ({
  knownContextWindow: (model: { id?: string } | null | undefined) => windows.get(model?.id ?? '') ?? null,
}))
vi.mock('@/lib/agentTools', () => ({ sandboxEnforces: vi.fn(() => true) }))
vi.mock('@/lib/jevModelRouting', async (orig) => ({
  ...(await orig<typeof import('../jevModelRouting')>()),
  chooseJevModel: choose,
}))
vi.mock('@/lib/jevModelPrompt', () => ({ askToSwitchModel: ask }))

import { CustomChatTransport } from '@/lib/custom-chat-transport'
import { CoworkChatTransport } from '../coworkTransport'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelRouting } from '@/hooks/useModelRouting'
import { useAssistant } from '@/hooks/useAssistant'

const user = (id: string, text: string) =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage

const cfg = {
  planMode: false,
  webSearch: false,
  subagentNames: [],
  allowSubagents: false,
  workspacePath: '/ws/s1',
  readOnlyFolder: null,
  model: { provider: 'llamacpp', id: 'gemma-4' },
}

const send = (t: CoworkChatTransport, messages: UIMessage[]) =>
  t.sendMessages({ messages, trigger: 'submit-message', chatId: 'c' } as never)

const selectionOf = (t: CoworkChatTransport) =>
  (t as unknown as { getModelSelection: () => { selectedProvider: string; selectedModel: { id: string } | null } }).getModelSelection()

const gemma = { id: 'gemma-4', capabilities: ['tools'] }
const sonnet = { id: 'sonnet', capabilities: ['tools', 'vision'] }
const target = { provider: 'anthropic', model: 'sonnet', label: 'Anthropic / sonnet', local: false, capabilities: ['tools', 'vision'] }
const first = [user('u1', 'Please refactor the parser module and add tests')]

describe('Cowork model routing', () => {
  beforeEach(() => {
    choose.mockReset()
    ask.mockReset()
    windows.clear()
    choose.mockResolvedValue({ target, probability: 0.9, fallback: null })
    vi.spyOn(CustomChatTransport.prototype, 'sendMessages').mockResolvedValue(new ReadableStream() as never)
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

  it('sends the turn to the routed model and keeps the session model as the default', async () => {
    const t = new CoworkChatTransport('s1', cfg)
    expect(selectionOf(t).selectedModel?.id).toBe('gemma-4')
    await send(t, first)
    expect(selectionOf(t).selectedProvider).toBe('anthropic')
    expect(selectionOf(t).selectedModel?.id).toBe('sonnet')
    expect(useModelProvider.getState().selectedProvider).toBe('llamacpp')
  })

  it('always requires tools: a Cowork turn is tool use', async () => {
    await send(new CoworkChatTransport('s1', cfg), first)
    expect(choose.mock.calls[0][0].needs.tools).toBe(true)
    // Even when the session's own model cannot use tools.
    choose.mockClear()
    useModelProvider.setState({ providers: [{ provider: 'llamacpp', active: true, models: [{ id: 'gemma-4', capabilities: [] }] }, { provider: 'anthropic', active: true, api_key: 'k', models: [sonnet] }] } as never)
    await send(new CoworkChatTransport('s1', cfg), first)
    expect(choose.mock.calls[0][0].needs.tools).toBe(true)
  })

  it('decides once per user message, so a tool loop keeps one model, and again for the next message', async () => {
    const t = new CoworkChatTransport('s1', cfg)
    await send(t, first)
    await send(t, first)
    await send(t, first)
    expect(choose).toHaveBeenCalledTimes(1)
    expect(selectionOf(t).selectedModel?.id).toBe('sonnet')
    choose.mockResolvedValue({ target: null, probability: 0.2, fallback: 'abstained' })
    await send(t, [...first, user('u2', 'Now a short follow-up question please')])
    expect(selectionOf(t).selectedModel?.id).toBe('gemma-4')
    expect(choose).toHaveBeenCalledTimes(2)
  })

  it('asks first in Ask mode and keeps the session model when declined', async () => {
    useModelRouting.setState({ mode: 'ask' })
    ask.mockResolvedValueOnce(false)
    const no = new CoworkChatTransport('s1', cfg)
    await send(no, first)
    expect(selectionOf(no).selectedModel?.id).toBe('gemma-4')
    ask.mockResolvedValueOnce(true)
    const yes = new CoworkChatTransport('s1', cfg)
    await send(yes, first)
    expect(selectionOf(yes).selectedModel?.id).toBe('sonnet')
  })

  it('asks Jev nothing when off, with no models listed, or when Jev itself is off', async () => {
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
      const t = new CoworkChatTransport('s1', cfg)
      await send(t, first)
      expect(choose).not.toHaveBeenCalled()
      expect(selectionOf(t).selectedModel?.id).toBe('gemma-4')
    }
  })

  it('keeps the session model when its own model is no longer offered by the provider', async () => {
    useModelProvider.setState({ providers: [{ provider: 'llamacpp', active: true, models: [] }, { provider: 'anthropic', active: true, api_key: 'k', models: [sonnet] }] } as never)
    const t = new CoworkChatTransport('s1', cfg)
    await send(t, first)
    expect(choose).not.toHaveBeenCalled()
    expect(selectionOf(t).selectedModel).toBeNull()
  })

  it('never offers a model whose known context window is smaller than the session model', async () => {
    windows.set('gemma-4', 128_000)
    windows.set('sonnet', 32_000)
    await send(new CoworkChatTransport('s1', cfg), first)
    // The only listed model has a smaller window, so there is nothing to offer.
    expect(choose.mock.calls[0][0].pool).toEqual([])
    choose.mockClear()
    windows.set('sonnet', 200_000)
    await send(new CoworkChatTransport('s1', cfg), first)
    expect(choose.mock.calls[0][0].pool.map((m: { model: string }) => m.model)).toEqual(['sonnet'])
    // A window nobody knows is not treated as smaller.
    choose.mockClear()
    windows.delete('sonnet')
    await send(new CoworkChatTransport('s1', cfg), first)
    expect(choose.mock.calls[0][0].pool).toHaveLength(1)
  })
})
