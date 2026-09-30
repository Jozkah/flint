import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const { choose } = vi.hoisted(() => ({ choose: vi.fn() }))
vi.mock('@/lib/agentTools', () => ({ sandboxEnforces: vi.fn(() => true) }))
vi.mock('@/lib/jevRouting', async (orig) => ({
  ...(await orig<typeof import('../jevRouting')>()),
  chooseJevPromptRoute: choose,
}))

import { CustomChatTransport } from '@/lib/custom-chat-transport'
import { CoworkChatTransport } from '../coworkTransport'
import { useAssistant } from '@/hooks/useAssistant'

const asst = (id: string) => ({ id, name: id, instructions: `${id} persona` }) as unknown as Assistant
const flint = asst('jan')
const coal = asst('coal')
const quartz = asst('quartz')

const user = (id: string, text: string) =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage

const cfg = {
  planMode: false,
  webSearch: false,
  subagentNames: [],
  allowSubagents: false,
  workspacePath: '/ws/s1',
  readOnlyFolder: null,
}

const send = (t: CoworkChatTransport, messages: UIMessage[]) =>
  t.sendMessages({ messages, trigger: 'submit-message', chatId: 'c' } as never)

const instructionsOf = (t: CoworkChatTransport) =>
  (t as unknown as { routedAssistantInstructions?: string }).routedAssistantInstructions

describe('Cowork prompt routing', () => {
  let setCurrent: ReturnType<typeof vi.fn>
  beforeEach(() => {
    choose.mockReset()
    choose.mockResolvedValue(null)
    vi.spyOn(CustomChatTransport.prototype, 'sendMessages').mockResolvedValue(
      new ReadableStream() as never
    )
    setCurrent = vi.fn()
    useAssistant.setState({
      assistants: [flint, coal, quartz],
      currentAssistant: flint,
      setCurrentAssistant: setCurrent,
    } as never)
  })

  it('never writes a routed assistant into the global store', async () => {
    choose.mockResolvedValue({ assistantId: 'coal', mode: 'ask', probability: 0.9, fallback: null })
    const t = new CoworkChatTransport('s1', cfg)
    await send(t, [user('u1', 'Please refactor the parser module')])
    expect(instructionsOf(t)).toBe('coal persona')
    expect(setCurrent).not.toHaveBeenCalled()
  })

  it('keeps the routed assistant when a later turn abstains', async () => {
    const t = new CoworkChatTransport('s1', cfg)
    choose.mockResolvedValueOnce({ assistantId: 'coal', mode: null, probability: 0.9, fallback: null })
    await send(t, [user('u1', 'Please refactor the parser module')])
    choose.mockResolvedValueOnce({ assistantId: null, mode: null, probability: 0.1, fallback: 'abstained' })
    await send(t, [user('u1', 'Please refactor the parser module'), user('u2', 'Something else entirely, thanks')])
    expect(instructionsOf(t)).toBe('coal persona')
  })

  it('scopes the assistant to the session, not to later changes of the app-wide picker', async () => {
    useAssistant.setState({ currentAssistant: quartz } as never)
    const t = new CoworkChatTransport('s1', cfg)
    await send(t, [user('u1', 'Please refactor the parser module')])
    expect(instructionsOf(t)).toBe('quartz persona')
    expect(choose.mock.calls[0][0].pinned).toBe(true)

    // Another chat changes the global picker afterwards.
    useAssistant.setState({ currentAssistant: coal } as never)
    await send(t, [user('u1', 'x'), user('u2', 'Another long message for the session')])
    expect(instructionsOf(t)).toBe('quartz persona')
  })

  it('routes only a session still on Flint, and injects nothing for Flint', async () => {
    const t = new CoworkChatTransport('s1', cfg)
    await send(t, [user('u1', 'Please refactor the parser module')])
    expect(choose.mock.calls[0][0]).toMatchObject({ pinned: false, temporary: false })
    expect(instructionsOf(t)).toBeUndefined()
  })
})
