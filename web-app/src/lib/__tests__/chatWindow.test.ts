import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ label: 'x' }),
  getByLabel: vi.fn().mockResolvedValue(null),
  emitTo: vi.fn().mockResolvedValue(undefined),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  windows: [] as Array<{ label: string; isVisible: () => Promise<boolean>; close: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: vi.fn(async () => h.windows),
}))

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: h.emitTo,
  listen: vi.fn(
    async (name: string, cb: (e: { payload: unknown }) => void) => {
      h.handlers.set(name, cb)
      return () => h.handlers.delete(name)
    }
  ),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    window: () => ({
      createWebviewWindow: h.create,
      getWebviewWindowByLabel: h.getByLabel,
    }),
  }),
}))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: {
    getState: () => ({ currentId: null, selectSession: vi.fn() }),
  },
}))

import {
  SPARE_LABEL_PREFIX,
  __testing,
  chatWindowUrl,
  isAllowedSoloPath,
  openChatWindow,
  parseSoloTarget,
  planOpen,
  prewarmSoloWindow,
  soloPath,
  spareUrl,
} from '../chatWindow'

describe('solo paths', () => {
  it('maps each conversation kind to its own page', () => {
    expect(soloPath({ kind: 'chat', refId: 'a b' })).toBe('/threads/a%20b')
    expect(soloPath({ kind: 'room', refId: 'r1' })).toBe('/rooms/r1')
    expect(soloPath({ kind: 'cowork', refId: 's1' })).toBe('/cowork')
  })

  it('carries the Cowork session and the solo flag in the URL', () => {
    expect(chatWindowUrl({ kind: 'cowork', refId: 's1' })).toBe(
      '/cowork?chatWindow=1&session=s1'
    )
    expect(chatWindowUrl({ kind: 'chat', refId: 't1' })).toBe(
      '/threads/t1?chatWindow=1'
    )
  })

  it('reads the target back from a location', () => {
    expect(parseSoloTarget('/threads/t1', '?chatWindow=1')).toEqual({
      kind: 'chat',
      refId: 't1',
    })
    expect(parseSoloTarget('/rooms/r%201', '')).toEqual({
      kind: 'room',
      refId: 'r 1',
    })
    expect(parseSoloTarget('/cowork', '?chatWindow=1&session=s1')).toEqual({
      kind: 'cowork',
      refId: 's1',
    })
    expect(parseSoloTarget('/settings/general', '')).toBeNull()
    expect(parseSoloTarget('/solo', '?chatWindow=1&spare=1')).toBeNull()
  })
})

describe('closed navigation', () => {
  const chat = { kind: 'chat' as const, refId: 't1' }

  it('allows only the own conversation of the window', () => {
    expect(isAllowedSoloPath('/threads/t1', chat)).toBe(true)
    expect(isAllowedSoloPath('/threads/t1/', chat)).toBe(true)
    expect(isAllowedSoloPath('/threads/t2', chat)).toBe(false)
    expect(isAllowedSoloPath('/settings/general', chat)).toBe(false)
    expect(isAllowedSoloPath('/hub', chat)).toBe(false)
    expect(isAllowedSoloPath('/', chat)).toBe(false)
    expect(isAllowedSoloPath('/cowork', chat)).toBe(false)
  })

  it('keeps a Cowork window off its campaign and artifact pages', () => {
    const cowork = { kind: 'cowork' as const, refId: 's1' }
    expect(isAllowedSoloPath('/cowork', cowork)).toBe(true)
    expect(isAllowedSoloPath('/campaigns', cowork)).toBe(false)
    expect(isAllowedSoloPath('/artifacts', cowork)).toBe(false)
  })

  it('shows only the idle page until a spare is assigned', () => {
    expect(isAllowedSoloPath('/solo', null)).toBe(true)
    expect(isAllowedSoloPath('/threads/t1', null)).toBe(false)
  })
})

describe('warm window assignment', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_TAURI', true)
    __testing.reset()
    h.create.mockClear()
    h.emitTo.mockReset()
    h.emitTo.mockResolvedValue(undefined)
    h.handlers.clear()
  })

  it('plans warm only for a spare that reported ready', () => {
    expect(planOpen(null)).toBe('cold')
    expect(planOpen({ label: 'chat-window-spare-a', ready: false })).toBe(
      'cold'
    )
    expect(planOpen({ label: 'chat-window-spare-a', ready: true })).toBe(
      'warm'
    )
  })

  it('closes hidden spares a reload left behind before building a new one', async () => {
    const win = (label: string, visible: boolean) => ({
      label,
      isVisible: async () => visible,
      close: vi.fn(async () => {}),
    })
    const old = win(`${SPARE_LABEL_PREFIX}old`, false)
    const shown = win(`${SPARE_LABEL_PREFIX}shown`, true)
    const main = win('main', false)
    h.windows = [old, shown, main]
    await prewarmSoloWindow()
    expect(old.close).toHaveBeenCalled()
    expect(shown.close).not.toHaveBeenCalled()
    expect(main.close).not.toHaveBeenCalled()
    expect(h.create).toHaveBeenCalledTimes(1)
    h.windows = []
  })

  it('builds the spare hidden, on the idle entry, at most one', async () => {
    await prewarmSoloWindow()
    expect(h.create).toHaveBeenCalledTimes(1)
    const cfg = h.create.mock.calls[0][0]
    expect(cfg.visible).toBe(false)
    expect(cfg.label.startsWith(SPARE_LABEL_PREFIX)).toBe(true)
    expect(cfg.url).toBe(spareUrl())
    await prewarmSoloWindow()
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it('hands the conversation to a ready spare instead of creating a window', async () => {
    await prewarmSoloWindow()
    const label = h.create.mock.calls[0][0].label as string
    h.handlers.get('solo-spare-ready')?.({ payload: label })
    h.emitTo.mockImplementation(async () => {
      h.handlers.get('solo-shown')?.({ payload: { label } })
    })
    h.create.mockClear()
    await openChatWindow({ kind: 'chat', refId: 't1' })
    expect(h.emitTo).toHaveBeenCalledWith(
      label,
      'solo-assign',
      expect.objectContaining({ label, target: { kind: 'chat', refId: 't1' } })
    )
    expect(h.create).not.toHaveBeenCalled()
  })

  it('removes both listeners when the hand-off fails', async () => {
    await prewarmSoloWindow()
    const label = h.create.mock.calls[0][0].label as string
    h.handlers.get('solo-spare-ready')?.({ payload: label })
    h.emitTo.mockRejectedValue(new Error('gone'))
    await openChatWindow({ kind: 'chat', refId: 't1' })
    expect(h.handlers.has('solo-shown')).toBe(false)
    expect(h.handlers.has('solo-failed')).toBe(false)
  })

  it('opens a window the old way when no spare is ready', async () => {
    await openChatWindow({ kind: 'room', refId: 'r1' })
    expect(h.emitTo).not.toHaveBeenCalled()
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/rooms/r1?chatWindow=1' })
    )
  })
})
