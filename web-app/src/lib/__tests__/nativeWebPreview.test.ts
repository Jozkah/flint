import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  NativeWebPreviewController,
  hasBlockingOverlay,
  sameBounds,
  toPhysicalBounds,
} from '../nativeWebPreview'

describe('toPhysicalBounds', () => {
  it('scales CSS pixels by devicePixelRatio (DPI and app zoom)', () => {
    expect(toPhysicalBounds({ left: 10, top: 20, width: 300, height: 200 }, 1.5)).toEqual({
      x: 15,
      y: 30,
      width: 450,
      height: 300,
    })
  })

  it('rounds edges so adjacent boxes do not gap', () => {
    const b = toPhysicalBounds({ left: 10.3, top: 0, width: 100.4, height: 1 }, 1.25)
    expect(b.x).toBe(13)
    expect(b.x + b.width).toBe(Math.round((10.3 + 100.4) * 1.25))
  })

  it('never returns negative sizes', () => {
    expect(toPhysicalBounds({ left: 0, top: 0, width: -5, height: -5 }, 1).width).toBe(0)
  })
})

describe('sameBounds', () => {
  it('compares all fields and treats null as different', () => {
    const a = { x: 1, y: 2, width: 3, height: 4 }
    expect(sameBounds(a, { ...a })).toBe(true)
    expect(sameBounds(a, { ...a, width: 5 })).toBe(false)
    expect(sameBounds(null, a)).toBe(false)
  })
})

describe('hasBlockingOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('is false with no overlays', () => {
    expect(hasBlockingOverlay(document)).toBe(false)
  })

  it('an open Radix dialog always blocks', () => {
    document.body.innerHTML = '<div role="dialog" data-state="open"></div>'
    expect(hasBlockingOverlay(document, null, { left: 0, top: 0, width: 1, height: 1 })).toBe(
      true
    )
  })

  it('a closed dialog does not block', () => {
    document.body.innerHTML = '<div role="dialog" data-state="closed"></div>'
    expect(hasBlockingOverlay(document)).toBe(false)
  })

  it('ignores overlays containing or inside the preview', () => {
    document.body.innerHTML =
      '<div role="dialog" data-state="open" id="pip"><div id="pv"><div role="menu" data-state="open"></div></div></div>'
    expect(hasBlockingOverlay(document, document.getElementById('pv'))).toBe(false)
  })

  it('popovers block only when they overlap the preview rect', () => {
    document.body.innerHTML = '<div data-radix-popper-content-wrapper id="p"></div>'
    const el = document.getElementById('p')!
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 50, height: 50 }) as DOMRect
    expect(hasBlockingOverlay(document, null, { left: 100, top: 0, width: 50, height: 50 })).toBe(
      false
    )
    expect(hasBlockingOverlay(document, null, { left: 40, top: 40, width: 50, height: 50 })).toBe(
      true
    )
  })
})

describe('NativeWebPreviewController', () => {
  let invoke: ReturnType<typeof vi.fn>
  let frames: Array<() => void>
  const raf = (cb: () => void) => {
    frames.push(cb)
    return frames.length
  }
  const flush = () => {
    const f = frames
    frames = []
    f.forEach((cb) => cb())
  }
  const b = (x: number) => ({ x, y: 0, width: 100, height: 100 })

  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined)
    frames = []
  })

  it('creates with id, url and bounds', async () => {
    const c = new NativeWebPreviewController('rail', invoke, raf, () => {})
    await c.create('https://github.com', b(0))
    expect(invoke).toHaveBeenCalledWith('web_preview_create', {
      id: 'rail',
      url: 'https://github.com',
      bounds: b(0),
    })
    expect(c.isCreated).toBe(true)
  })

  it('propagates create failure so the caller can fall back', async () => {
    invoke.mockRejectedValueOnce(new Error('unsupported'))
    const c = new NativeWebPreviewController('rail', invoke, raf, () => {})
    await expect(c.create('https://a.com', b(0))).rejects.toThrow('unsupported')
    expect(c.isCreated).toBe(false)
  })

  it('coalesces bounds to one call per frame and skips unchanged rects', async () => {
    const c = new NativeWebPreviewController('rail', invoke, raf, () => {})
    await c.create('https://a.com', b(0))
    invoke.mockClear()
    c.setBounds(b(1))
    c.setBounds(b(2))
    c.setBounds(b(3))
    expect(frames).toHaveLength(1)
    flush()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('web_preview_set_bounds', { id: 'rail', bounds: b(3) })
    c.setBounds(b(3))
    flush()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('ignores bounds before creation', () => {
    const c = new NativeWebPreviewController('rail', invoke, raf, () => {})
    c.setBounds(b(1))
    expect(frames).toHaveLength(0)
  })

  it('only sends show/hide on visibility changes', async () => {
    const c = new NativeWebPreviewController('rail', invoke, raf, () => {})
    await c.create('https://a.com', b(0))
    invoke.mockClear()
    c.setVisible(true)
    expect(invoke).not.toHaveBeenCalled()
    c.setVisible(false)
    c.setVisible(false)
    c.setVisible(true)
    expect(invoke.mock.calls.map((x) => x[0])).toEqual(['web_preview_hide', 'web_preview_show'])
  })

  it('dispose closes the view and cancels pending frames', async () => {
    const caf = vi.fn()
    const c = new NativeWebPreviewController('rail', invoke, raf, caf)
    await c.create('https://a.com', b(0))
    c.setBounds(b(5))
    c.dispose()
    expect(caf).toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('web_preview_close', { id: 'rail' })
    invoke.mockClear()
    c.setVisible(false)
    c.dispose()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('closes a view whose creation finished after dispose', async () => {
    let resolve!: () => void
    invoke.mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)))
    const c = new NativeWebPreviewController('rail', invoke, raf, () => {})
    const p = c.create('https://a.com', b(0))
    c.dispose()
    resolve()
    await p
    expect(invoke).toHaveBeenCalledWith('web_preview_close', { id: 'rail' })
    expect(c.isCreated).toBe(false)
  })
})
