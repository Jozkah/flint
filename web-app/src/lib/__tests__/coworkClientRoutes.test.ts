import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const { CLIENT_ROUTES } = await import('@/lib/coworkDispatch')

type Route = (typeof CLIENT_ROUTES)[string]
type Ctx = Parameters<Route>[1]
const call = (toolName: string, input: unknown = {}) =>
  ({ toolCallId: 'c1', toolName, input }) as Parameters<Route>[0]
const ctx = (over: Partial<Ctx> = {}) =>
  ({
    sessionId: 's',
    mode: 'review',
    onTodo: vi.fn(async () => ({ output: 'todo' })),
    onAsk: vi.fn(async () => ({ output: 'asked' })),
    ...over,
  }) as unknown as Ctx

describe('CLIENT_ROUTES', () => {
  it('names every tool the client answers itself', () => {
    expect(Object.keys(CLIENT_ROUTES).sort()).toMatchSnapshot()
  })

  it('todo and ask go to the session handlers', async () => {
    const c = ctx()
    expect(await CLIENT_ROUTES.todo(call('todo', { a: 1 }), c)).toEqual({ output: 'todo' })
    expect(c.onTodo).toHaveBeenCalledWith({ a: 1 })
    expect(await CLIENT_ROUTES.ask(call('ask', { q: 1 }), c)).toEqual({ output: 'asked' })
    expect(c.onAsk).toHaveBeenCalledWith('c1', { q: 1 })
  })

  it('a child dispatcher (no team) is refused the parent-only tools', async () => {
    const c = ctx()
    for (const name of Object.keys(CLIENT_ROUTES)) {
      if (/todo|ask|enable|task|background|output|kill/i.test(name)) continue
      const out = await CLIENT_ROUTES[name](call(name), c)
      expect(out.isError, name).toBe(true)
      expect(out.output, name).toMatch(/^You cannot/)
    }
  })

  it('enable_tools with nothing to enable says so', async () => {
    const name = Object.keys(CLIENT_ROUTES).find((k) => /enable/i.test(k))!
    expect(await CLIENT_ROUTES[name](call(name), ctx())).toEqual({
      output: 'There is nothing to enable here.',
      isError: true,
    })
  })
})
