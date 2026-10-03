import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isLive, LIVE_WINDOW_MS, useBrowserToolMirror } from '../useBrowserToolMirror'
import { BROWSER_TOOL_EVENT } from '@/lib/browserTool'

const shot = 'data:image/jpeg;base64,AAAA'

const note = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  runId: 'r1',
  kind: 'action',
  action: 'click e12 button "Save"',
  url: 'http://127.0.0.1:5173/',
  title: 'Demo',
  screenshot: shot,
  ...over,
})

describe('useBrowserToolMirror', () => {
  beforeEach(() => useBrowserToolMirror.setState({ byId: {} }))

  it('shows the address, title, last action and picture the backend reports', () => {
    useBrowserToolMirror.getState().apply(note(), 100)
    expect(useBrowserToolMirror.getState().byId.s1).toEqual({
      url: 'http://127.0.0.1:5173/',
      title: 'Demo',
      action: 'click e12 button "Save"',
      screenshot: shot,
      tabs: [],
      updatedAt: 100,
      frameAt: 0,
    })
  })

  it('a live frame replaces only the picture, and needs a view to land on', () => {
    const s = useBrowserToolMirror.getState()
    s.apply(note({ kind: 'frame', screenshot: shot }), 50)
    expect(useBrowserToolMirror.getState().byId.s1).toBeUndefined()
    s.apply(note(), 100)
    const next = 'data:image/jpeg;base64,BBBB'
    s.apply(note({ kind: 'frame', action: '', url: '', title: '', screenshot: next }), 200)
    const v = useBrowserToolMirror.getState().byId.s1
    expect(v.screenshot).toBe(next)
    expect(v.frameAt).toBe(200)
    expect(v.url).toBe('http://127.0.0.1:5173/')
    expect(v.action).toBe('click e12 button "Save"')
    expect(v.updatedAt).toBe(100)
  })

  it('a frame that is not a bounded JPEG is dropped', () => {
    const s = useBrowserToolMirror.getState()
    s.apply(note(), 100)
    s.apply(note({ kind: 'frame', screenshot: 'https://evil.example/x.png' }), 200)
    s.apply(note({ kind: 'frame', screenshot: `data:image/jpeg;base64,${'A'.repeat(500_000)}` }), 300)
    expect(useBrowserToolMirror.getState().byId.s1.screenshot).toBe(shot)
    expect(useBrowserToolMirror.getState().byId.s1.frameAt).toBe(0)
  })

  it('keeps the tab list until a notice replaces it, and drops it for a fresh open', () => {
    const s = useBrowserToolMirror.getState()
    const tabs = [{ id: 't1', title: 'A', active: true }, { id: 't2', title: 'B', active: false }]
    s.apply(note({ tabs }), 100)
    expect(useBrowserToolMirror.getState().byId.s1.tabs).toHaveLength(2)
    s.apply(note({ action: 'snapshot' }), 200)
    expect(useBrowserToolMirror.getState().byId.s1.tabs).toHaveLength(2)
    s.apply(note({ kind: 'open', tabs: [] }), 300)
    expect(useBrowserToolMirror.getState().byId.s1.tabs).toEqual([])
  })

  it('reads as live shortly after a frame or an action and idle after', () => {
    const s = useBrowserToolMirror.getState()
    s.apply(note(), 1000)
    const v = useBrowserToolMirror.getState().byId.s1
    expect(isLive(v, 1000 + LIVE_WINDOW_MS - 1)).toBe(true)
    expect(isLive(v, 1000 + LIVE_WINDOW_MS)).toBe(false)
    s.apply(note({ kind: 'frame' }), 9000)
    expect(isLive(useBrowserToolMirror.getState().byId.s1, 9000 + 1000)).toBe(true)
  })

  it('keeps the last picture when a looking action sends none', () => {
    const s = useBrowserToolMirror.getState()
    s.apply(note())
    s.apply(note({ action: 'snapshot', screenshot: null }))
    const v = useBrowserToolMirror.getState().byId.s1
    expect(v.action).toBe('snapshot')
    expect(v.screenshot).toBe(shot)
  })

  it('clears on a closed notice (also what an idle timeout sends)', () => {
    const s = useBrowserToolMirror.getState()
    s.apply(note())
    s.apply(note({ kind: 'closed', action: 'closed: it was idle too long', screenshot: null }))
    expect(useBrowserToolMirror.getState().byId.s1).toBeUndefined()
  })

  it('keeps conversations apart', () => {
    const s = useBrowserToolMirror.getState()
    s.apply(note())
    s.apply(note({ sessionId: 's2', url: 'http://localhost:3000/' }))
    s.apply(note({ sessionId: 's2', kind: 'closed' }))
    expect(Object.keys(useBrowserToolMirror.getState().byId)).toEqual(['s1'])
  })

  it('refuses a picture that is not a bounded JPEG data URL, and bounds text', () => {
    const s = useBrowserToolMirror.getState()
    s.apply(note({ screenshot: 'https://evil.example/x.png' }))
    expect(useBrowserToolMirror.getState().byId.s1.screenshot).toBeNull()
    s.apply(note({ screenshot: `data:image/jpeg;base64,${'A'.repeat(500_000)}` }))
    expect(useBrowserToolMirror.getState().byId.s1.screenshot).toBeNull()
    s.apply(note({ screenshot: 'data:text/html;base64,PHNjcmlwdD4=' }))
    expect(useBrowserToolMirror.getState().byId.s1.screenshot).toBeNull()
    s.apply(note({ title: 'T'.repeat(5000), url: 'u'.repeat(5000) }))
    const v = useBrowserToolMirror.getState().byId.s1
    expect(v.title.length).toBeLessThanOrEqual(200)
    expect(v.url.length).toBeLessThanOrEqual(300)
  })

  it('ignores garbage and notices with no session', () => {
    const s = useBrowserToolMirror.getState()
    s.apply(null)
    s.apply('x')
    s.apply(note({ sessionId: '' }))
    expect(useBrowserToolMirror.getState().byId).toEqual({})
  })

  it('listens for notices, and stops when detached', async () => {
    const unlisten = vi.fn()
    const listen = vi.fn(async () => unlisten)
    const detach = await useBrowserToolMirror.getState().attach({ listen, enabled: () => true })
    expect(listen).toHaveBeenCalledWith(BROWSER_TOOL_EVENT, expect.any(Function))
    detach()
    expect(unlisten).toHaveBeenCalled()
  })

  it('tells the backend a panel is showing the browser, counted across panels', async () => {
    const watch = vi.fn(async () => undefined)
    const flush = () => new Promise((r) => setTimeout(r, 0))
    const a = useBrowserToolMirror.getState().watch({ watch, enabled: () => true })
    const b = useBrowserToolMirror.getState().watch({ watch, enabled: () => true })
    await flush()
    expect(watch.mock.calls).toEqual([[true]])
    a()
    a() // letting go twice counts once
    await flush()
    expect(watch.mock.calls).toEqual([[true]])
    b()
    await flush()
    expect(watch.mock.calls).toEqual([[true], [false]])
  })

  it('asks nothing of the backend when the preview is off or the backend is absent', async () => {
    const watch = vi.fn(async () => {
      throw new Error('no tauri')
    })
    const flush = () => new Promise((r) => setTimeout(r, 0))
    useBrowserToolMirror.getState().watch({ watch, enabled: () => false })()
    await flush()
    expect(watch).not.toHaveBeenCalled()
    const release = useBrowserToolMirror.getState().watch({ watch, enabled: () => true })
    await flush()
    expect(() => release()).not.toThrow()
  })

  it('routes the listener payload into the store', async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined
    const listen = vi.fn(async (_e: string, h: (e: { payload: unknown }) => void) => {
      handler = h
      return () => undefined
    })
    await useBrowserToolMirror.getState().attach({ listen, enabled: () => true, now: () => 7 })
    handler?.({ payload: note() })
    expect(useBrowserToolMirror.getState().byId.s1.updatedAt).toBe(7)
  })

  it('does nothing at all when the user turned the in-app preview off', async () => {
    const listen = vi.fn(async () => () => undefined)
    const detach = await useBrowserToolMirror.getState().attach({ listen, enabled: () => false })
    detach()
    expect(listen).not.toHaveBeenCalled()
  })

  it('is quiet when the desktop backend is not there', async () => {
    const listen = vi.fn(async () => {
      throw new Error('no tauri')
    })
    const detach = await useBrowserToolMirror.getState().attach({ listen, enabled: () => true })
    expect(() => detach()).not.toThrow()
  })
})
