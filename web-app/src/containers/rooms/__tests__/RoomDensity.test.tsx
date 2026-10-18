/**
 * The room page at narrow widths: capped answers that scroll inside
 * themselves (linked across one compare row), the compact approval prompt,
 * the collapsible usage line, the one-line change card, and no second
 * announcement of a prompt that is already on screen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))

import {
  createScrollLink,
  linkedScrollTop,
  ScrollLinkContext,
  useRoomsViewPrefs,
} from '@/lib/rooms/answerScroll'
import { CappedAnswer } from '../CappedAnswer'
import { RoomUsageBar } from '../RoomUsageBar'
import { TurnChangeCard } from '../TurnChangeCard'
import { CoworkChildApprovals } from '@/containers/CoworkChildApprovals'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { approvalCardOnScreen } from '@/hooks/useApprovalWaitNotifier'
import { makeRoom } from './roomsTestUtils'

const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}:${JSON.stringify(o)}` : key)

/** Give a jsdom element a scroll geometry. */
function geometry(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

describe('linkedScrollTop', () => {
  it('keeps two answers of unequal length at the same fraction', () => {
    // A is halfway through 1000 px of range; B has 300 px of range.
    expect(linkedScrollTop({ scrollTop: 500, scrollHeight: 1400, clientHeight: 400 }, { scrollHeight: 700, clientHeight: 400 })).toBe(150)
    expect(linkedScrollTop({ scrollTop: 1000, scrollHeight: 1400, clientHeight: 400 }, { scrollHeight: 700, clientHeight: 400 })).toBe(300)
  })
  it('leaves a column that does not overflow alone', () => {
    expect(linkedScrollTop({ scrollTop: 100, scrollHeight: 1400, clientHeight: 400 }, { scrollHeight: 300, clientHeight: 400 })).toBeNull()
    expect(linkedScrollTop({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }, { scrollHeight: 900, clientHeight: 400 })).toBeNull()
  })
})

describe('scroll-linked compare cells', () => {
  beforeEach(() => useRoomsViewPrefs.setState({ linkScroll: true, expanded: {} }))

  function renderRow(heights: Array<[number, number]>) {
    const link = createScrollLink(() => useRoomsViewPrefs.getState().linkScroll)
    render(
      <ScrollLinkContext.Provider value={link}>
        {heights.map((_, i) => (
          <CappedAnswer key={i} messageId={`m${i}`} name={`P${i}`} t={t}>
            <p>answer {i}</p>
          </CappedAnswer>
        ))}
      </ScrollLinkContext.Provider>
    )
    const cells = screen.getAllByTestId('room-answer-body')
    cells.forEach((c, i) => geometry(c, heights[i][0], heights[i][1]))
    return cells
  }

  it('scrolling one column moves the other proportionally, once, without a loop', () => {
    const [a, b] = renderRow([[1400, 400], [700, 400]])
    a.scrollTop = 500
    fireEvent.scroll(a)
    expect(b.scrollTop).toBe(150)
    // The browser then fires B's own scroll event; it must not drive A back.
    a.scrollTop = 520
    fireEvent.scroll(b)
    expect(a.scrollTop).toBe(520)
  })

  it('a column that does not overflow stays still', () => {
    const [a, b] = renderRow([[1400, 400], [300, 400]])
    a.scrollTop = 700
    fireEvent.scroll(a)
    expect(b.scrollTop).toBe(0)
  })

  it('does nothing while Link scrolling is off', () => {
    useRoomsViewPrefs.setState({ linkScroll: false })
    const [a, b] = renderRow([[1400, 400], [700, 400]])
    a.scrollTop = 500
    fireEvent.scroll(a)
    expect(b.scrollTop).toBe(0)
  })
})

describe('CappedAnswer', () => {
  beforeEach(() => useRoomsViewPrefs.setState({ linkScroll: true, expanded: {} }))

  it('is a capped, focusable, labelled region', () => {
    render(
      <CappedAnswer messageId="m1" name="Sonnet" t={t}>
        <p>hi</p>
      </CappedAnswer>
    )
    const body = screen.getByTestId('room-answer-body')
    expect(body.getAttribute('role')).toBe('region')
    expect(body.tabIndex).toBe(0)
    expect(body.getAttribute('aria-label')).toContain('Sonnet')
    expect(body.hasAttribute('data-capped')).toBe(true)
    expect(body.style.maxHeight).not.toBe('')
  })

  it('offers Expand once it overflows, and remembers it per message', () => {
    render(
      <CappedAnswer messageId="m1" name="Sonnet" t={t}>
        <p>long</p>
      </CappedAnswer>
    )
    const body = screen.getByTestId('room-answer-body')
    expect(screen.queryByTestId('room-answer-expand')).toBeNull()
    geometry(body, 2000, 400)
    fireEvent.scroll(body)
    expect(screen.getByTestId('room-answer-expand')).toBeTruthy()
    expect(screen.getByTestId('room-answer-fade')).toBeTruthy()
    fireEvent.click(screen.getByTestId('room-answer-expand'))
    expect(useRoomsViewPrefs.getState().expanded.m1).toBe(true)
    expect(body.hasAttribute('data-capped')).toBe(false)
  })

  it('the Expand toggle persists in the view prefs', () => {
    useRoomsViewPrefs.setState({ expanded: { m1: true } })
    render(
      <CappedAnswer messageId="m1" name="Sonnet" t={t}>
        <p>long</p>
      </CappedAnswer>
    )
    expect(screen.getByTestId('room-answer-body').hasAttribute('data-capped')).toBe(false)
    const toggle = screen.getByTestId('room-answer-expand')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(useRoomsViewPrefs.getState().expanded.m1).toBeUndefined()
  })
})

describe('compact approval prompt', () => {
  beforeEach(() => useToolApprovalRequests.setState({ pending: {}, queued: {} }))

  it('is one line with the command and inline answers; details open on demand', async () => {
    render(<CoworkChildApprovals sessionId="r1" compact />)
    act(() => {
      void useToolApprovalRequests.getState().requestApproval('c1', 'bash', 'r1', undefined, {
        origin: 'Qwen',
        input: { command: 'npm test' },
      })
    })
    const card = await screen.findByTestId('child-approval')
    expect(screen.getByTestId('approval-command').textContent).toBe('npm test')
    expect(screen.queryByTestId('approval-details')).toBeNull()
    fireEvent.click(screen.getByTestId('approval-details-toggle'))
    expect(screen.getByTestId('approval-details')).toBeTruthy()
    expect(card.getAttribute('data-approval-request')).toBeTruthy()
  })

  it('a held request is a slim banner with Dismiss only', async () => {
    render(<CoworkChildApprovals sessionId="r1" compact />)
    act(() => {
      const ctrl = new AbortController()
      void useToolApprovalRequests.getState().requestApproval('c2', 'bash', 'r1', undefined, {
        origin: 'Qwen',
        signal: ctrl.signal,
        holdOnAbort: () => 'room paused',
      })
      ctrl.abort()
    })
    const card = await screen.findByTestId('child-approval')
    expect(card.getAttribute('data-held')).toBe('true')
    expect(screen.queryByTestId('approval-details-toggle')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('approval reminder', () => {
  it('counts a card in the viewport as on screen, and a missing one as not', () => {
    document.body.innerHTML = '<div data-approval-request="r-1"></div>'
    const el = document.querySelector('div')!
    el.getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 0, right: 100 }) as DOMRect
    expect(approvalCardOnScreen('r-1')).toBe(true)
    expect(approvalCardOnScreen('r-2')).toBe(false)
    el.getBoundingClientRect = () => ({ top: -200, bottom: -100, left: 0, right: 100 }) as DOMRect
    expect(approvalCardOnScreen('r-1')).toBe(false)
    document.body.innerHTML = ''
  })
})

describe('usage line', () => {
  it('collapses to one line and opens the figures on tap', () => {
    render(<RoomUsageBar room={makeRoom()} />)
    const toggle = screen.getByTestId('room-usage-toggle')
    const details = screen.getByTestId('room-usage-details')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(details.className).toContain('hidden')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(details.className).not.toMatch(/(^|\s)hidden(\s|$)/)
  })
})

describe('change card', () => {
  const changes = {
    files: [{ path: 'a.ts', additions: 4, deletions: 2 }],
    workspace: 'C:/ws',
  }
  const actions = { patch: vi.fn(async () => '+x'), discard: vi.fn(async () => {}), apply: vi.fn(async () => 1) }

  it('is one collapsed line with Apply inline; the rest open with it', () => {
    render(<TurnChangeCard changes={changes} actions={actions} t={t} />)
    expect(screen.getByTestId('turn-changes-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('turn-changes-apply')).toBeTruthy()
    expect(screen.queryByTestId('turn-changes-actions')).toBeNull()
    fireEvent.click(screen.getByTestId('turn-changes-toggle'))
    expect(screen.getByTestId('turn-changes-actions')).toBeTruthy()
  })
})
