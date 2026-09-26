import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useRef } from 'react'

let pathname = '/settings/models'
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname }),
}))

import { useSidebarGlide } from '../useSidebarGlide'

// Each element's top edge comes from data-top, so a test can move rows the
// way a collapse opening above them would.
const rect = (el: Element) => {
  const top = Number((el as HTMLElement).dataset.top ?? 0)
  const height = Number((el as HTMLElement).dataset.height ?? 32)
  return {
    top,
    left: 0,
    width: 200,
    height,
    right: 200,
    bottom: top + height,
    x: 0,
    y: top,
    toJSON() {},
  } as DOMRect
}

type Entry = { cb: ResizeObserverCallback; targets: Set<Element> }
const observers: Entry[] = []
class FakeResizeObserver {
  entry: Entry
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, targets: new Set() }
    observers.push(this.entry)
  }
  observe(el: Element) {
    this.entry.targets.add(el)
  }
  unobserve(el: Element) {
    this.entry.targets.delete(el)
  }
  disconnect() {
    this.entry.targets.clear()
  }
}
const resize = (el: Element) => {
  for (const o of observers)
    if (o.targets.has(el)) o.cb([], o as unknown as ResizeObserver)
}

function Nav({ active }: { active: string | null }) {
  const ref = useRef<HTMLElement>(null)
  useSidebarGlide(ref)
  return (
    <nav ref={ref} data-top="0" data-height="600">
      <ul data-testid="group">
        <li data-testid="cowork-tree" />
        {['models', 'tools'].map((id, i) => (
          <li key={id}>
            <button
              data-slot="nav-button"
              data-testid={id}
              data-top={String(40 + i * 32)}
              data-active={active === id ? 'true' : undefined}
            />
          </li>
        ))}
      </ul>
    </nav>
  )
}

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
}
const glide = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-slot="nav-glide"]')!

describe('useSidebarGlide', () => {
  beforeEach(() => {
    observers.length = 0
    pathname = '/settings/models'
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        return rect(this)
      }
    )
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return this.parentNode
      },
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .offsetParent
  })

  it('follows the active row when a group above it expands', async () => {
    const { container, getByTestId } = render(<Nav active="models" />)
    await flush()
    expect(glide(container).style.transform).toBe('translate(0px, 40px)')

    // The Cowork tree opens above: rows shift down with no resize of the nav
    // itself and no attribute change on the rows.
    getByTestId('models').dataset.top = '140'
    getByTestId('tools').dataset.top = '172'
    await act(async () => resize(getByTestId('group')))
    await flush()
    expect(glide(container).style.transform).toBe('translate(0px, 140px)')
    expect(glide(container).style.opacity).toBe('1')
  })

  it('places again when a collapse transition inside the nav ends', async () => {
    const { container, getByTestId } = render(<Nav active="tools" />)
    await flush()
    getByTestId('tools').dataset.top = '300'
    await act(async () => {
      getByTestId('cowork-tree').dispatchEvent(
        new Event('transitionend', { bubbles: true })
      )
    })
    await flush()
    expect(glide(container).style.transform).toBe('translate(0px, 300px)')
  })

  it('hides on a page with no sidebar row', async () => {
    const { container, rerender } = render(<Nav active="models" />)
    await flush()
    expect(glide(container).style.opacity).toBe('1')
    pathname = '/somewhere-else'
    rerender(<Nav active={null} />)
    await flush()
    expect(glide(container).style.opacity).toBe('0')
    expect(container.querySelector('nav')!.hasAttribute('data-glide')).toBe(
      false
    )
  })
})
