import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool, UIMessage } from 'ai'

// The units CoworkChatTransport delegates to: Jev's per-message routing and
// the live MCP overlay.
const h = vi.hoisted(() => ({
  choose: vi.fn(),
  routeModel: vi.fn(),
  loadLive: vi.fn(),
  collect: vi.fn(),
}))
vi.mock('@/lib/jevRouting', async (orig) => ({
  ...(await orig<typeof import('../jevRouting')>()),
  chooseJevPromptRoute: h.choose,
}))
vi.mock('@/lib/jevModelTurn', async (orig) => ({
  ...(await orig<typeof import('../jevModelTurn')>()),
  routeModelForTurn: h.routeModel,
}))
vi.mock('@/lib/mcpLiveTools', async (orig) => ({
  ...(await orig<typeof import('../mcpLiveTools')>()),
  loadLiveMcpTools: h.loadLive,
  announceMcpWithheld: vi.fn(),
}))
vi.mock('@/lib/coworkTransportTools', async (orig) => ({
  ...(await orig<typeof import('../coworkTransportTools')>()),
  collectMcpOverlay: h.collect,
}))

import { CoworkPromptRouter } from '../coworkPromptRouting'
import { loadCoworkMcpOverlay, type CoworkMcpSink } from '../coworkMcpOverlay'
import { useAssistant } from '@/hooks/useAssistant'

const user = (id: string, text: string) =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage
const asst = (id: string) =>
  ({ id, name: id, instructions: `${id} persona`, avatar: `${id}.png` }) as unknown as Assistant

describe('CoworkPromptRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAssistant.setState({
      assistants: [asst('jan'), asst('coal')],
      currentAssistant: asst('jan'),
    } as never)
  })

  it('routes a model once per user message, after the caller drops the last one', async () => {
    const router = new CoworkPromptRouter()
    const order: string[] = []
    const current = { selectedProvider: 'p', selectedModel: null }
    h.routeModel.mockImplementation(async () => {
      order.push('route')
      return { selection: { selectedProvider: 'q', selectedModel: null } }
    })
    const begin = vi.fn(() => {
      order.push('begin')
      return current
    })
    const first = await router.routeModel([user('u1', 'hi')], begin)
    expect(first).toEqual({ selection: { selectedProvider: 'q', selectedModel: null } })
    expect(order).toEqual(['begin', 'route'])
    expect(h.routeModel).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hi', current, requireTools: true, keepContextWindow: true })
    )
    // A tool-loop step of the same message routes nothing.
    expect(await router.routeModel([user('u1', 'hi')], begin)).toBeNull()
    expect(begin).toHaveBeenCalledTimes(1)
  })

  it('applies a routed assistant and keeps it when a later message abstains', async () => {
    const router = new CoworkPromptRouter()
    h.choose.mockResolvedValueOnce({ assistantId: 'coal', mode: 'review' })
    const first = await router.routePrompt([user('u1', 'design')])
    expect(first).toEqual({ answering: { name: 'coal', avatar: 'coal.png' } })
    expect(router.routedAssistantId).toBe('coal')
    expect(router.routedAssistantInstructions).toBe('coal persona')
    expect(router.routedMode).toBe('review')

    h.choose.mockResolvedValueOnce(null)
    const second = await router.routePrompt([user('u1', 'design'), user('u2', 'more')])
    expect(second?.answering?.name).toBe('coal')
    expect(router.routedMode).toBeNull()
    // The app-wide picker is never written.
    expect(useAssistant.getState().currentAssistant?.id).toBe('jan')
  })

  it('leaves Flint without a persona and routes each message once', async () => {
    const router = new CoworkPromptRouter()
    h.choose.mockResolvedValue(null)
    const got = await router.routePrompt([user('u1', 'hi')])
    expect(got).toEqual({ answering: { name: 'jan', avatar: undefined } })
    expect(router.routedAssistantInstructions).toBeUndefined()
    expect(await router.routePrompt([user('u1', 'hi')])).toBeNull()
    expect(h.choose).toHaveBeenCalledTimes(1)
  })
})

describe('loadCoworkMcpOverlay', () => {
  const sink = (): CoworkMcpSink & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      starting: (s) => calls.push(`starting:${s.join(',')}`),
      withheldLabels: (l) => calls.push(`withheld:${l.join(',')}`),
      startingText: (t) => calls.push(`text:${t ?? ''}`),
      record: (offered) => calls.push(`record:${offered.map((o) => o.name).join(',')}`),
    }
  }
  const base = { read: {} as Tool }

  beforeEach(() => vi.clearAllMocks())

  it('offers nothing in review mode and reads nothing', async () => {
    const s = sink()
    const got = await loadCoworkMcpOverlay(base, true, s)
    expect(got.overlay).toEqual({})
    expect(got.servers.size).toBe(0)
    expect(h.loadLive).not.toHaveBeenCalled()
    expect(s.calls).toEqual([])
  })

  it('sorts the overlay and reports what it learned in order', async () => {
    h.loadLive.mockResolvedValue({ tools: [], starting: ['slow'] })
    h.collect.mockImplementation(
      (_live: unknown, _base: unknown, _dis: unknown, overlay: Record<string, Tool>, servers: Map<string, string>) => {
        overlay.zeta = {} as Tool
        overlay.alpha = {} as Tool
        servers.set('zeta', 'srv')
        servers.set('alpha', 'srv')
      }
    )
    const s = sink()
    const got = await loadCoworkMcpOverlay(base, false, s)
    expect(Object.keys(got.overlay)).toEqual(['alpha', 'zeta'])
    expect(got.servers.get('alpha')).toBe('srv')
    expect(s.calls[0]).toBe('starting:slow')
    expect(s.calls.at(-1)).toBe('record:zeta,alpha')
  })

  it('offers nothing when reading fails, keeping what it reported first', async () => {
    h.loadLive.mockResolvedValue({ tools: [], starting: ['a'] })
    h.collect.mockImplementation(() => {
      throw new Error('broken')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = sink()
    const got = await loadCoworkMcpOverlay(base, false, s)
    expect(got.overlay).toEqual({})
    expect(got.servers.size).toBe(0)
    expect(s.calls).toEqual(['starting:a'])
    warn.mockRestore()
  })
})
