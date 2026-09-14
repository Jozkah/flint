import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { asJournal, makeMessage, makeRoom } from './roomsTestUtils'
import { RoomTranscript } from '../RoomTranscript'
import type { LiveTurn } from '@/lib/rooms/types'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})

/**
 * jsdom does no layout, so scrollHeight/clientHeight are always 0 and the
 * follow logic could never tell "at bottom" from "scrolled up". These helpers
 * give the scroll port a real, mutable geometry so the component's own
 * arithmetic (scrollHeight - scrollTop - clientHeight) is exercised for real.
 */
const SCROLL_HEIGHT = 1000
const CLIENT_HEIGHT = 100

function riggedScroller() {
  const el = screen.getByTestId('room-transcript-scroll')
  let scrollTop = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
    },
  })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => CLIENT_HEIGHT })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => SCROLL_HEIGHT })
  return el
}

const atBottom = (el: HTMLElement) => {
  el.scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT // fully at the bottom
  fireEvent.scroll(el)
}
const scrolledUp = (el: HTMLElement) => {
  el.scrollTop = 100 // far from the bottom (800px away)
  fireEvent.scroll(el)
}

const live = (text: string): LiveTurn => ({
  roomId: 'r1',
  turnId: 't1',
  author: { kind: 'participant', participantId: 'p2', name: 'Bob' },
  text,
  startedAt: 1,
})

describe('RoomTranscript scrolling', () => {
  it('auto-follows new messages while the reader is at the bottom', () => {
    const room = makeRoom()
    const { rerender } = render(
      <RoomTranscript room={room} journal={asJournal([makeMessage({ text: 'one' })])} liveTurn={null} />
    )
    const el = riggedScroller()
    atBottom(el)

    rerender(
      <RoomTranscript
        room={room}
        journal={asJournal([makeMessage({ text: 'one' }), makeMessage({ text: 'two' })])}
        liveTurn={null}
      />
    )
    expect(el.scrollTop).toBe(SCROLL_HEIGHT)
    expect(screen.queryByTestId('room-jump-latest')).not.toBeInTheDocument()
  })

  it('never pulls the reader down when they have scrolled up (streaming tokens)', () => {
    const room = makeRoom()
    const { rerender } = render(
      <RoomTranscript room={room} journal={asJournal([makeMessage({ text: 'one' })])} liveTurn={live('a')} />
    )
    const el = riggedScroller()
    scrolledUp(el)
    expect(screen.getByTestId('room-jump-latest')).toBeInTheDocument()

    // Several streamed tokens arrive; position must not move.
    for (const tok of ['ab', 'abc', 'abcd']) {
      rerender(
        <RoomTranscript
          room={room}
          journal={asJournal([makeMessage({ text: 'one' })])}
          liveTurn={live(tok)}
        />
      )
      expect(el.scrollTop).toBe(100)
    }

    // A brand-new completed message also must not yank them down.
    rerender(
      <RoomTranscript
        room={room}
        journal={asJournal([makeMessage({ text: 'one' }), makeMessage({ text: 'two' })])}
        liveTurn={null}
      />
    )
    expect(el.scrollTop).toBe(100)
  })

  it('"Jump to latest" returns to the bottom and re-arms auto-follow', () => {
    const room = makeRoom()
    const { rerender } = render(
      <RoomTranscript room={room} journal={asJournal([makeMessage({ text: 'one' })])} liveTurn={null} />
    )
    const el = riggedScroller()
    scrolledUp(el)
    const jump = screen.getByTestId('room-jump-latest')

    fireEvent.click(jump)
    expect(el.scrollTop).toBe(SCROLL_HEIGHT)
    expect(screen.queryByTestId('room-jump-latest')).not.toBeInTheDocument()

    // Auto-follow is armed again: a new message keeps us pinned to the bottom.
    el.scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT
    rerender(
      <RoomTranscript
        room={room}
        journal={asJournal([makeMessage({ text: 'one' }), makeMessage({ text: 'two' })])}
        liveTurn={null}
      />
    )
    expect(el.scrollTop).toBe(SCROLL_HEIGHT)
  })

  it('exposes a focusable scroll region for keyboard scrolling', () => {
    render(
      <RoomTranscript room={makeRoom()} journal={asJournal([makeMessage({ text: 'one' })])} liveTurn={null} />
    )
    const el = screen.getByTestId('room-transcript-scroll')
    expect(el).toHaveAttribute('tabindex', '0')
    expect(el.className).toContain('overflow-y-auto')
  })
})
