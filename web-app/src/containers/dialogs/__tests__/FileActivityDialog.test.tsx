import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { FileActivityDialog } from '../FileActivityDialog'
import type { FileActivityEvent } from '@/lib/fileActivity'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// jsdom has neither ResizeObserver nor laid-out boxes, so a virtualized list
// measures to zero and renders nothing. Both shims below are about the test
// environment, not the component.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= StubResizeObserver as never

// jsdom reports zero-height scroll containers, which would virtualize to
// nothing; a fixed rect makes the list measurable.
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({ height: 400, width: 600, top: 0, left: 0, bottom: 400, right: 600, x: 0, y: 0, toJSON: () => ({}) }),
})

const event = (over: Partial<FileActivityEvent> = {}): FileActivityEvent => ({
  id: Math.random().toString(),
  path: 'src/a.ts',
  operation: 'read',
  seq: 0,
  at: 0,
  ok: true,
  origin: 'project',
  ...over,
})

const show = (events: FileActivityEvent[], over: Partial<Parameters<typeof FileActivityDialog>[0]> = {}) =>
  render(
    <FileActivityDialog
      open
      onOpenChange={vi.fn()}
      events={events}
      title="A session"
      {...over}
    />
  )

describe('long lists', () => {
  it('virtualizes past the threshold instead of rendering thousands of rows', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      event({ path: `src/file-${i}.ts` })
    )
    show(many)
    // All 400 are grouped, but only a window of them is in the DOM.
    const rendered = screen.getAllByRole('listitem').length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(100)
  })
})

describe('the file activity view', () => {
  it('says so when nothing has happened', () => {
    show([])
    expect(screen.getByText('common:fileActivity.empty')).toBeInTheDocument()
  })

  it('groups a file’s events into one row', () => {
    show([
      event({ path: 'src/a.ts', operation: 'read', at: 1 }),
      event({ path: 'src/a.ts', operation: 'write', at: 2 }),
      event({ path: 'src/b.ts', at: 3 }),
    ])
    // Two files, not three events.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('opens a read file in the code panel', () => {
    const onOpenFile = vi.fn()
    show([event({ path: 'src/a.ts', operation: 'read' })], { onOpenFile })
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('opens a changed file’s diff instead', () => {
    const onOpenFile = vi.fn()
    const onOpenDiff = vi.fn()
    show([event({ path: 'src/a.ts', operation: 'write' })], {
      onOpenFile,
      onOpenDiff,
    })
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts')
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('filters, and each filter says how much it would show', () => {
    show([
      event({ path: 'a.ts', operation: 'read' }),
      event({ path: 'b.ts', operation: 'write' }),
    ])
    const changed = screen.getByRole('button', {
      name: /common:fileActivity\.filter\.changed/,
    })
    expect(changed).toHaveTextContent('1')

    fireEvent.click(changed)
    expect(changed).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('searches by path', () => {
    show([event({ path: 'src/alpha.ts' }), event({ path: 'src/beta.ts' })])
    fireEvent.change(
      screen.getByLabelText('common:fileActivity.searchPlaceholder'),
      { target: { value: 'beta' } }
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('states a failure in words, not only in colour', () => {
    show([event({ path: 'gone.ts', ok: false })])
    expect(
      screen.getByText(/common:fileActivity\.failed/)
    ).toBeInTheDocument()
  })

  it('names the origin so project and sandbox are told apart', () => {
    show([event({ path: 'a.ts', origin: 'sandbox' })])
    expect(
      screen.getByText(/common:fileActivity\.origin\.sandbox/)
    ).toBeInTheDocument()
  })

  it('does not offer to open anything when there is nowhere to open it', () => {
    show([event({ path: 'a.ts' })])
    expect(screen.getByRole('button', { name: /a\.ts/ })).toBeDisabled()
  })
})
