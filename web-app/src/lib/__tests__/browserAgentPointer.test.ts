/**
 * The assistant's visible pointer (src-tauri/.../agent.js): a cursor in a closed
 * shadow root that glides, pulses on a click and fades. These run the real
 * script against jsdom.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SRC = readFileSync(
  resolve(__dirname, '../../../../src-tauri/src/core/browser_agent/agent.js'),
  'utf8'
).trim()
const KEY = '__flint_pointer_test'

type R = Record<string, unknown> & { ok: boolean; code?: string; wait?: number }

const SHOW = { show: true, reduce: false }

function run(op: string, args: Record<string, unknown> = {}): R {
  const call = `${SRC}(${JSON.stringify(KEY)},${JSON.stringify(op)},${JSON.stringify(args)})`
  return (0, eval)(call) as R
}

const idOf = (snapshot: string, needle: string): string => {
  const line = snapshot.split('\n').find((l) => l.includes(needle))
  const m = line && /\[(\d+\.\d+)\]/.exec(line)
  if (!m) throw new Error(`no node for ${needle} in:\n${snapshot}`)
  return m[1]
}

/** The closed shadow roots the script creates, captured as they are made. */
let roots: ShadowRoot[] = []
let realAttach: typeof Element.prototype.attachShadow

const hosts = () =>
  Array.from(document.documentElement.children).filter((e) =>
    e.tagName.startsWith('X-')
  )

const cursorEl = () => roots[roots.length - 1]?.querySelector('.c') as HTMLElement

const rect = (left: number, top: number, w: number, h: number) =>
  ({
    left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top,
    toJSON: () => ({}),
  }) as DOMRect

function page(html: string) {
  document.body.innerHTML = html
  delete (window as unknown as Record<string, unknown>)[KEY]
  for (const h of hosts()) h.remove()
  roots = []
}

beforeEach(() => {
  vi.useFakeTimers()
  roots = []
  realAttach = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = realAttach.call(this, init)
    roots.push(root)
    return root
  }
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
  document.title = 'Pointer test'
})

afterEach(() => {
  Element.prototype.attachShadow = realAttach
  for (const h of hosts()) h.remove()
  vi.useRealTimers()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

/** A page with one button at a known place. */
function oneButton(at = rect(100, 200, 40, 20)) {
  page('<button id="b" type="button">Expand</button>')
  const b = document.getElementById('b') as HTMLButtonElement
  b.getBoundingClientRect = () => at
  const id = idOf(run('snapshot').snapshot as string, 'button "Expand"')
  return { b, id }
}

describe('the overlay', () => {
  it('is a closed shadow root on a hidden, inert, zero-size top-level host', () => {
    const { id } = oneButton()
    run('click', { id, pointer: SHOW })
    const [host] = hosts()
    expect(host).toBeTruthy()
    expect(host.shadowRoot).toBeNull() // closed: not reachable from the page
    expect(roots).toHaveLength(1)
    expect(host.parentElement).toBe(document.documentElement) // not under <body>
    expect(host.getAttribute('aria-hidden')).toBe('true')
    expect(host.hasAttribute('inert')).toBe(true)
    const css = (host as HTMLElement).style
    expect(css.position).toBe('fixed')
    expect(css.pointerEvents).toBe('none')
    expect(css.zIndex).toBe('2147483647')
    expect(css.width).toBe('0px')
    expect(css.height).toBe('0px')
    expect(host.id).toMatch(/^f[a-z0-9]+$/)
  })

  it('uses a different random tag and id each time it is made', () => {
    const { id } = oneButton()
    run('click', { id, pointer: SHOW })
    const first = [hosts()[0].tagName, hosts()[0].id]
    run('pointer', { mode: 'remove' })
    run('click', { id, pointer: SHOW })
    expect([hosts()[0].tagName, hosts()[0].id]).not.toEqual(first)
  })

  it('does not appear in read_text, the snapshot or the node ids', () => {
    const { id } = oneButton()
    const before = run('snapshot')
    run('click', { id, pointer: SHOW })
    const text = run('text', {})
    expect(text.text as string).not.toContain('Flint')
    const after = run('snapshot')
    expect(after.snapshot as string).not.toContain('Flint')
    // Ids restart with each snapshot; the lines themselves are unchanged.
    const bare = (t: unknown) => String(t).replace(/\[\d+\./g, '[')
    expect(bare(after.snapshot)).toBe(bare(before.snapshot))
    expect(after.nodes).toBe(before.nodes)
    expect(document.body.innerHTML).not.toContain('x-')
  })

  it('does not change what the page lays out or scrolls', () => {
    const { id } = oneButton()
    const bodyBefore = document.body.innerHTML
    run('click', { id, pointer: SHOW })
    expect(document.body.innerHTML).toBe(bodyBefore)
  })

  it('a dry run draws nothing', () => {
    const { id } = oneButton()
    run('click', { id, dry: true, pointer: SHOW })
    expect(hosts()).toHaveLength(0)
  })

  it('is not drawn when the Settings switch is off, and costs no wait', () => {
    const { id, b } = oneButton()
    const clicked = vi.fn()
    b.addEventListener('click', clicked)
    expect(run('move', { id, pointer: { show: false, reduce: false } })).toMatchObject({ ok: true, wait: 0 })
    run('click', { id, pointer: { show: false, reduce: false } })
    expect(hosts()).toHaveLength(0)
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})

describe('motion', () => {
  it('moves to the centre of the target when the action runs', () => {
    const { id } = oneButton(rect(100, 200, 40, 20))
    run('click', { id, pointer: SHOW })
    expect(cursorEl().style.transform).toBe('translate(120px,210px)')
  })

  it('glides: move returns a wait, and the path ends on the target', () => {
    const { id } = oneButton(rect(700, 600, 40, 20))
    const r = run('move', { id, pointer: SHOW })
    expect(r.ok).toBe(true)
    expect(r.wait).toBeGreaterThanOrEqual(250)
    expect(r.wait).toBeLessThanOrEqual(900)
    // Starts from the middle of the viewport, not on the target.
    expect(cursorEl().style.transform).toBe('translate(500px,400px)')
    vi.advanceTimersByTime((r.wait as number) + 60)
    expect(cursorEl().style.transform).toBe('translate(720px,610px)')
  })

  it('scales the glide with distance but never past the cap, even with a scroll', () => {
    const near = oneButton(rect(495, 395, 10, 10))
    const nearWait = run('move', { id: near.id, pointer: SHOW }).wait as number
    page('<button id="b" type="button">Far</button>')
    const b = document.getElementById('b') as HTMLButtonElement
    b.getBoundingClientRect = () => rect(950, 5000, 10, 10) // far below the fold
    b.scrollIntoView = vi.fn()
    const id = idOf(run('snapshot').snapshot as string, 'button "Far"')
    const far = run('move', { id, pointer: SHOW })
    expect(b.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth', block: 'center' }))
    expect(far.wait as number).toBeGreaterThan(nearWait)
    expect(far.wait as number).toBeLessThanOrEqual(900)
    expect(nearWait).toBeGreaterThanOrEqual(250)
  })

  it('never sleeps the host longer than 900 ms for any distance', () => {
    for (const [x, y] of [[0, 0], [999, 799], [10, 790], [990, 10]]) {
      const { id } = oneButton(rect(x, y, 6, 6))
      run('pointer', { mode: 'remove' })
      expect(run('move', { id, pointer: SHOW }).wait as number).toBeLessThanOrEqual(900)
    }
  })

  it('dispatches the pointer and mouse sequence at the target, ending in the click', () => {
    const { id, b } = oneButton(rect(100, 200, 40, 20))
    const seen: Array<[string, number, number]> = []
    for (const t of [
      'pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove',
      'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click',
    ]) {
      b.addEventListener(t, (e) =>
        seen.push([e.type, (e as MouseEvent).clientX ?? -1, (e as MouseEvent).clientY ?? -1])
      )
    }
    run('click', { id, pointer: SHOW })
    expect(seen.map((s) => s[0])).toEqual([
      'pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove',
      'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click',
    ])
    const down = seen.find((s) => s[0] === 'mousedown')!
    expect([down[1], down[2]]).toEqual([120, 210])
  })

  it('clicks exactly once, and the sequence runs even with the pointer off', () => {
    const { id, b } = oneButton()
    const order: string[] = []
    for (const t of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      b.addEventListener(t, () => order.push(t))
    }
    run('click', { id, pointer: { show: false, reduce: false } })
    expect(order).toEqual(['mouseover', 'mousedown', 'mouseup', 'click'])
  })

  it('pulses a ripple on a click and rests (no ripple) while typing', () => {
    page('<input id="i" aria-label="Name"><button id="b" type="button">Go</button>')
    const input = document.getElementById('i') as HTMLInputElement
    input.getBoundingClientRect = () => rect(10, 10, 100, 20)
    ;(document.getElementById('b') as HTMLElement).getBoundingClientRect = () => rect(300, 300, 40, 20)
    const snap = run('snapshot').snapshot as string
    run('type', { id: idOf(snap, 'textbox "Name"'), text: 'Ada', pointer: SHOW })
    expect(input.value).toBe('Ada')
    expect(cursorEl().style.transform).toBe('translate(60px,20px)')
    expect(roots[0].querySelectorAll('.r')).toHaveLength(0)
    run('click', { id: idOf(snap, 'button "Go"'), pointer: SHOW })
    expect(roots[0].querySelectorAll('.r')).toHaveLength(1)
    vi.advanceTimersByTime(700)
    expect(roots[0].querySelectorAll('.r')).toHaveLength(0)
  })
})

describe('reduced motion', () => {
  it('moves instantly with no wait, no ripple and no glow pulse', () => {
    const { id } = oneButton(rect(700, 600, 40, 20))
    const r = run('move', { id, pointer: { show: true, reduce: true } })
    expect(r.wait).toBe(0)
    expect(cursorEl().style.transform).toBe('translate(720px,610px)')
    expect(cursorEl().className).toContain('calm')
    expect(cursorEl().className).not.toContain('pulse')
    run('click', { id, pointer: { show: true, reduce: true } })
    expect(roots[0].querySelectorAll('.r')).toHaveLength(0)
  })

  it('follows the system preference when the setting says nothing', () => {
    ;(window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
      matches: q.includes('reduce'),
    })
    const { id } = oneButton(rect(700, 600, 40, 20))
    expect(run('move', { id, pointer: { show: true, reduce: null } }).wait).toBe(0)
    run('pointer', { mode: 'remove' })
    ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false })
    expect(run('move', { id, pointer: { show: true, reduce: null } }).wait as number).toBeGreaterThan(0)
  })

  it('an explicit off beats the system preference', () => {
    ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true })
    const { id } = oneButton(rect(700, 600, 40, 20))
    expect(run('move', { id, pointer: { show: true, reduce: false } }).wait as number).toBeGreaterThan(0)
  })

  it('scrolls the target into view instantly', () => {
    page('<button id="b" type="button">Far</button>')
    const b = document.getElementById('b') as HTMLButtonElement
    b.getBoundingClientRect = () => rect(10, 5000, 10, 10)
    b.scrollIntoView = vi.fn()
    const id = idOf(run('snapshot').snapshot as string, 'button "Far"')
    run('move', { id, pointer: { show: true, reduce: true } })
    expect(b.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }))
  })
})

describe('lifetime', () => {
  it('fades about three seconds after the last action and is then removed', () => {
    const { id } = oneButton()
    run('click', { id, pointer: SHOW })
    expect(hosts()).toHaveLength(1)
    vi.advanceTimersByTime(2900)
    expect(hosts()).toHaveLength(1)
    expect(cursorEl().style.opacity).toBe('1')
    vi.advanceTimersByTime(200)
    expect(cursorEl().style.opacity).toBe('0')
    vi.advanceTimersByTime(600)
    expect(hosts()).toHaveLength(0)
  })

  it('a new action keeps it alive', () => {
    const { id } = oneButton()
    run('click', { id, pointer: SHOW })
    vi.advanceTimersByTime(2500)
    run('click', { id, pointer: SHOW })
    vi.advanceTimersByTime(2500)
    expect(hosts()).toHaveLength(1)
  })

  it('is removed on demand, and again made when needed', () => {
    const { id } = oneButton()
    run('click', { id, pointer: SHOW })
    expect(run('pointer', { mode: 'remove' })).toMatchObject({ ok: true, present: false })
    expect(hosts()).toHaveLength(0)
    run('click', { id, pointer: SHOW })
    expect(hosts()).toHaveLength(1)
  })

  it('take-over hides it and hand-back shows it again where it was', () => {
    const { id } = oneButton(rect(100, 200, 40, 20))
    run('click', { id, pointer: SHOW })
    run('pointer', { mode: 'hide' })
    expect((hosts()[0] as HTMLElement).style.visibility).toBe('hidden')
    run('pointer', { mode: 'show' })
    expect((hosts()[0] as HTMLElement).style.visibility).toBe('visible')
    expect(cursorEl().style.transform).toBe('translate(120px,210px)')
    expect(cursorEl().style.opacity).toBe('1')
  })

  it('pointer controls on a page with no pointer do nothing', () => {
    page('<p>hi</p>')
    expect(run('pointer', { mode: 'hide' })).toMatchObject({ ok: true, present: false })
    expect(run('pointer', { mode: 'show' })).toMatchObject({ ok: true, present: false })
  })
})

describe('safety rules are untouched by the pointer', () => {
  it('a stale id is refused before the pointer moves', () => {
    const { id } = oneButton()
    run('snapshot')
    expect(run('move', { id, pointer: SHOW })).toMatchObject({ ok: false, code: 'stale' })
    expect(hosts()).toHaveLength(0)
  })

  it('a submit-like control still asks first, and the pointer stays put', () => {
    page('<form id="f"><button>Save</button></form>')
    const submit = vi.fn((e: Event) => e.preventDefault())
    document.getElementById('f')!.addEventListener('submit', submit)
    const id = idOf(run('snapshot').snapshot as string, 'button "Save"')
    expect(run('click', { id, pointer: SHOW })).toMatchObject({ needs_confirm: true })
    expect(submit).not.toHaveBeenCalled()
    expect(hosts()).toHaveLength(0)
    run('click', { id, confirmed: true, pointer: SHOW })
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('scroll', () => {
  const setPage = (maxY: number) => {
    // jsdom has no scrolling element or layout; give the page some.
    Object.defineProperty(document, 'scrollingElement', {
      value: document.documentElement, configurable: true,
    })
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 800 + maxY, configurable: true,
    })
    Object.defineProperty(document.documentElement, 'scrollWidth', {
      value: 1000, configurable: true,
    })
  }

  it('fires a wheel event at the viewport centre, then scrolls smoothly by a page', () => {
    page('<p>long</p>')
    setPage(3000)
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const wheel = vi.fn()
    document.body.addEventListener('wheel', wheel)
    const r = run('scroll', { direction: 'down', amount: { kind: 'page' }, pointer: SHOW })
    document.body.removeEventListener('wheel', wheel)
    expect(r.ok).toBe(true)
    expect(wheel).toHaveBeenCalledTimes(1)
    const ev = wheel.mock.calls[0][0] as WheelEvent
    expect([ev.clientX, ev.clientY, ev.deltaY]).toEqual([500, 400, 720])
    expect(by).toHaveBeenCalledWith({ left: 0, top: 720, behavior: 'smooth' })
    expect(r.wait as number).toBeGreaterThan(0)
    expect(r.wait as number).toBeLessThanOrEqual(900)
    // The pointer hovers at the centre while it scrolls.
    vi.advanceTimersByTime(400)
    expect(cursorEl().style.transform).toBe('translate(500px,400px)')
  })

  it('half a page, a pixel amount, and each direction', () => {
    page('<p>long</p>')
    setPage(3000)
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    run('scroll', { direction: 'down', amount: { kind: 'half' }, pointer: SHOW })
    run('scroll', { direction: 'up', amount: { kind: 'px', px: 123 }, pointer: SHOW })
    run('scroll', { direction: 'right', amount: { kind: 'px', px: 50 }, pointer: SHOW })
    run('scroll', { direction: 'left', amount: { kind: 'px', px: 50 }, pointer: SHOW })
    expect(by.mock.calls.map((c) => [c[0]!.left, c[0]!.top])).toEqual([
      [0, 400], [0, -123], [50, 0], [-50, 0],
    ])
  })

  it('does not scroll when the page handles the wheel itself', () => {
    page('<p>long</p>')
    setPage(3000)
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const stop = (e: Event) => e.preventDefault()
    document.body.addEventListener('wheel', stop)
    const r = run('scroll', { direction: 'down', pointer: SHOW })
    document.body.removeEventListener('wheel', stop)
    expect(r).toMatchObject({ ok: true, handled: true })
    expect(by).not.toHaveBeenCalled()
  })

  it('scrolls instantly with reduced motion and with the pointer off', () => {
    page('<p>long</p>')
    setPage(3000)
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const r = run('scroll', { direction: 'down', pointer: { show: false, reduce: true } })
    expect(r.wait).toBe(0)
    expect(by).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }))
    expect(hosts()).toHaveLength(0)
  })

  it('a dry run scrolls nothing', () => {
    page('<p>x</p>')
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    expect(run('scroll', { direction: 'down', dry: true })).toMatchObject({ ok: true, dry: true })
    expect(by).not.toHaveBeenCalled()
    expect(hosts()).toHaveLength(0)
  })

  it('scrolls inside a scrollable container named by node id', () => {
    page('<div id="box" tabindex="0" style="overflow-y:auto;overflow-x:auto"><p>row</p></div>')
    const box = document.getElementById('box') as HTMLElement
    box.getBoundingClientRect = () => rect(100, 100, 300, 200)
    Object.defineProperty(box, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(box, 'scrollWidth', { value: 300, configurable: true })
    Object.defineProperty(box, 'clientWidth', { value: 300, configurable: true })
    box.scrollBy = vi.fn() as never
    box.setAttribute('role', 'region')
    // Give the box an id by making it a recognised control.
    box.setAttribute('role', 'textbox')
    // jsdom does not expand the overflow shorthand or lay anything out.
    const realStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) =>
      el === box
        ? ({ overflowY: 'auto', overflowX: 'auto', display: 'block', visibility: 'visible' } as CSSStyleDeclaration)
        : realStyle(el)) as typeof window.getComputedStyle)
    const id = idOf(run('snapshot').snapshot as string, 'textbox')
    const winBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const r = run('scroll', { id, direction: 'down', amount: { kind: 'half' }, pointer: SHOW })
    expect(r.ok).toBe(true)
    expect(box.scrollBy).toHaveBeenCalledWith({ left: 0, top: 100, behavior: 'smooth' })
    expect(winBy).not.toHaveBeenCalled()
    // The pointer hovers over the container, not the viewport centre.
    vi.advanceTimersByTime(400)
    expect(cursorEl().style.transform).toBe('translate(250px,200px)')
    vi.restoreAllMocks()
  })

  it('a node id alone brings it into view', () => {
    page('<button id="b" type="button">Far</button>')
    const b = document.getElementById('b') as HTMLButtonElement
    b.getBoundingClientRect = () => rect(10, 5000, 10, 10)
    b.scrollIntoView = vi.fn()
    const id = idOf(run('snapshot').snapshot as string, 'button "Far"')
    const r = run('scroll', { id, pointer: SHOW })
    expect(b.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center', behavior: 'smooth' }))
    expect(r.wait as number).toBeGreaterThan(0)
    expect(run('scroll', { id: '9.9', pointer: SHOW })).toMatchObject({ code: 'stale' })
  })

  it('scrollinfo reports the position and whether more content exists', () => {
    page('<p>long</p>')
    setPage(1000)
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    expect(run('scrollinfo')).toMatchObject({
      ok: true, y: 0, max_y: 1000, scrolled: 'page',
      more: { up: false, down: true, left: false, right: false },
    })
    Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true })
    expect(run('scrollinfo')).toMatchObject({ y: 1000, more: { up: true, down: false } })
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
  })
})
