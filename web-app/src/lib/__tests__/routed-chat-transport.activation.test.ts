import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const bodies: Record<string, string> = {}
const DELAY = 300

vi.mock('@/lib/skillStore', () => ({
  storeScope: { kind: 'store' },
  readSkill: vi.fn(async (_s: unknown, name: string) => {
    if (!(name in bodies)) throw new Error('not found')
    return bodies[name]
  }),
  listSkills: vi.fn(async () => [
    { name: 'caveman', description: 'Terse replies', model_invocable: true, always: true },
    {
      name: 'debugging',
      description: 'Systematic debugging',
      model_invocable: true,
      triggers: ['stack trace'],
    },
    { name: 'idle', description: 'Never matches', model_invocable: true },
  ]),
}))

const slow = <T>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), DELAY))
const { jevSuggest, chooseRoute } = vi.hoisted(() => ({
  jevSuggest: vi.fn(),
  chooseRoute: vi.fn(),
}))
vi.mock('@/lib/jev', async (orig) => ({
  ...(await orig<typeof import('../jev')>()),
  jevSuggestSkill: jevSuggest,
  shouldAskForSkill: (t: string) => t.trim().length >= 20,
  // The work-profile chooser: another slow Jev call.
  workProfileAsker: () => async () => slow('debug'),
}))
vi.mock('@/lib/jevRouting', async (orig) => ({
  ...(await orig<typeof import('../jevRouting')>()),
  chooseJevPromptRoute: chooseRoute,
}))

import { CustomChatTransport } from '@/lib/custom-chat-transport'
import { RoutedChatTransport } from '../routed-chat-transport'
import { useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { useSkillActivation } from '@/hooks/useSkillActivation'
import { setCachedSkillCatalog, refreshSkillCatalog } from '../skillCatalog'
import { clearSkillBodyCache } from '../skillActivation'
import { listSkills } from '@/lib/skillStore'

const user = (id: string, text: string) =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage
const send = (t: RoutedChatTransport, messages: UIMessage[]) =>
  t.sendMessages({ messages, trigger: 'submit-message', chatId: 'c' } as never)
const promptOf = (t: RoutedChatTransport, messages: UIMessage[]) =>
  (t as unknown as { buildSystemPrompt(m: UIMessage[]): string | undefined }).buildSystemPrompt(
    messages
  ) ?? ''

const flint = { id: 'jan', name: 'Flint', instructions: 'base' } as unknown as Assistant

beforeEach(() => {
  Object.assign(bodies, {
    caveman: '---\nalways: true\n---\nTalk like caveman.',
    debugging: '---\ndescription: d\n---\nFind the root cause first.',
    idle: 'never used',
  })
  clearSkillBodyCache()
  setCachedSkillCatalog(null)
  jevSuggest.mockReset()
  jevSuggest.mockImplementation(() => slow({ skill: null, probability: 0.1, fallback: null, model: 'm' }))
  chooseRoute.mockReset()
  // As the real one: nothing to wait for when Jev's suggestions are off.
  chooseRoute.mockImplementation(() =>
    useJevSettings.getState().skillMode === 'off' ? Promise.resolve(null) : slow(null)
  )
  vi.mocked(listSkills).mockClear()
  vi.spyOn(CustomChatTransport.prototype, 'sendMessages').mockResolvedValue(
    new ReadableStream() as never
  )
  useThreads.setState({
    threads: { t1: { id: 't1', model: { id: 'm', provider: 'p' }, assistants: [flint] } } as never,
    updateThread: vi.fn(),
  } as never)
  useAssistant.setState({ assistants: [flint], currentAssistant: flint } as never)
  useJevSettings.setState({ skillMode: 'off', rerankMode: 'off' })
  useWorkProfiles.setState({ enabled: false, sessions: {}, overrides: {} })
  useSkillActivation.setState({ alwaysOn: [], alwaysOff: [] })
})

describe('what a chat message activates', () => {
  it('puts an always-on skill and a triggered skill in the prompt, and nothing else', async () => {
    const t = new RoutedChatTransport('sys', 't1')
    const m = [user('u1', 'here is the stack trace from the crash')]
    await send(t, m)
    const prompt = promptOf(t, m)
    expect(prompt).toContain('## caveman (always active)')
    expect(prompt).toContain('Talk like caveman.')
    expect(prompt).toContain('## debugging (activated by trigger: stack trace)')
    expect(prompt).not.toContain('never used')
  })

  it('does not carry a triggered skill into a later message that does not trigger it', async () => {
    const t = new RoutedChatTransport('sys', 't1')
    await send(t, [user('u1', 'here is the stack trace from the crash')])
    const m2 = [user('u1', 'x'), user('u2', 'thanks, that is all for now')]
    await send(t, m2)
    const prompt = promptOf(t, m2)
    expect(prompt).toContain('## caveman')
    expect(prompt).not.toContain('## debugging')
  })

  it('puts the work profile in the prompt when profiles are on, and not when off', async () => {
    const m = [user('u1', 'why does this segfault when I resize the window?')]
    const off = new RoutedChatTransport('sys', 't1')
    await send(off, m)
    expect(promptOf(off, m)).not.toMatch(/work profile/i)

    useWorkProfiles.setState({ enabled: true })
    const on = new RoutedChatTransport('sys', 't1')
    await send(on, m)
    expect(useWorkProfiles.getState().sessions.t1?.manual).toBe(false)
    expect(promptOf(on, m)).toMatch(/debug/i)
  })

  it('keeps a work profile the user picked by hand', async () => {
    useWorkProfiles.setState({ enabled: true })
    useWorkProfiles.getState().choose('t1', 'review', true)
    const t = new RoutedChatTransport('sys', 't1')
    await send(t, [user('u1', 'why does this segfault when I resize the window?')])
    expect(useWorkProfiles.getState().sessions.t1).toEqual({ id: 'review', manual: true })
  })
})

describe('what it costs', () => {
  it('makes no Jev call and takes a moment, with Jev off', async () => {
    const started = Date.now()
    await send(new RoutedChatTransport('sys', 't1'), [user('u1', 'here is the stack trace from the crash')])
    expect(jevSuggest).not.toHaveBeenCalled()
    expect(Date.now() - started).toBeLessThan(DELAY / 3)
  })

  it('waits for the slowest Jev call, not for all three added together', async () => {
    useJevSettings.setState({ skillMode: 'on', rerankMode: 'on' })
    useWorkProfiles.setState({ enabled: true })
    const started = Date.now()
    await send(new RoutedChatTransport('sys', 't1'), [
      user('u1', 'please look into why the build is failing on windows'),
    ])
    const took = Date.now() - started
    // Skill pick, work profile and assistant route each take DELAY.
    expect(jevSuggest).toHaveBeenCalledTimes(1)
    expect(chooseRoute).toHaveBeenCalledTimes(1)
    expect(took).toBeGreaterThanOrEqual(DELAY - 20)
    expect(took).toBeLessThan(DELAY * 2)
  })

  it('asks the backend for the skill list once for a message, and reuses it just after', async () => {
    await Promise.all([refreshSkillCatalog(), refreshSkillCatalog()])
    await refreshSkillCatalog()
    expect(listSkills).toHaveBeenCalledTimes(1)
  })

  it('a tool follow-up in the same turn does no routing work at all', async () => {
    const t = new RoutedChatTransport('sys', 't1')
    const m = [user('u1', 'here is the stack trace from the crash')]
    await send(t, m)
    vi.mocked(listSkills).mockClear()
    chooseRoute.mockClear()
    const started = Date.now()
    await send(t, m)
    expect(listSkills).not.toHaveBeenCalled()
    expect(chooseRoute).not.toHaveBeenCalled()
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('a Jev skill pick that hangs is given up on', async () => {
    useJevSettings.setState({ skillMode: 'on' })
    jevSuggest.mockImplementation(() => new Promise(() => {}))
    const started = Date.now()
    await send(new RoutedChatTransport('sys', 't1'), [
      user('u1', 'please look into why the build is failing on windows'),
    ])
    expect(Date.now() - started).toBeLessThan(3_500)
  })
})
