import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useBrowserToolMirror } from '../useBrowserToolMirror'
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
      updatedAt: 100,
    })
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

  it('listens and tells the backend it is watched, then undoes both', async () => {
    const unlisten = vi.fn()
    const listen = vi.fn(async () => unlisten)
    const watch = vi.fn(async () => undefined)
    const detach = await useBrowserToolMirror.getState().attach({ listen, watch, enabled: () => true })
    expect(listen).toHaveBeenCalledWith(BROWSER_TOOL_EVENT, expect.any(Function))
    expect(watch).toHaveBeenCalledWith(true)
    detach()
    expect(unlisten).toHaveBeenCalled()
    expect(watch).toHaveBeenLastCalledWith(false)
  })

  it('routes the listener payload into the store', async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined
    const listen = vi.fn(async (_e: string, h: (e: { payload: unknown }) => void) => {
      handler = h
      return () => undefined
    })
    await useBrowserToolMirror.getState().attach({ listen, watch: async () => undefined, enabled: () => true, now: () => 7 })
    handler?.({ payload: note() })
    expect(useBrowserToolMirror.getState().byId.s1.updatedAt).toBe(7)
  })

  it('does nothing at all when the user turned the in-app preview off', async () => {
    const listen = vi.fn(async () => () => undefined)
    const watch = vi.fn(async () => undefined)
    const detach = await useBrowserToolMirror.getState().attach({ listen, watch, enabled: () => false })
    detach()
    expect(listen).not.toHaveBeenCalled()
    expect(watch).not.toHaveBeenCalled()
  })

  it('is quiet when the desktop backend is not there', async () => {
    const listen = vi.fn(async () => {
      throw new Error('no tauri')
    })
    const detach = await useBrowserToolMirror.getState().attach({ listen, watch: async () => undefined, enabled: () => true })
    expect(() => detach()).not.toThrow()
  })
})
