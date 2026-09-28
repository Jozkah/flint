import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { EventEnvelope } from '@/lib/eventLog'

const h = vi.hoisted(() => ({
  pages: new Map<string, EventEnvelope[]>(),
  fail: new Set<string>(),
  diff: '--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-# Old\n+# New\n',
}))
vi.mock('@/lib/eventLog', () => ({
  listEvents: vi.fn(async (session: string, after: number) => {
    if (h.fail.has(session)) throw new Error('corrupt log')
    const all = h.pages.get(session) ?? []
    const events = all.filter((e) => e.seq > after)
    return { events, lastSeq: all.at(-1)?.seq ?? 0, truncated: false }
  }),
}))
const loadToolDiff = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<string | null> => h.diff))
vi.mock('@/lib/toolActivity', () => ({ loadToolDiff }))
// The app's own translator, so labels are asserted as a person reads them.
vi.mock('@/i18n/react-i18next-compat', async () => {
  const i18n = (await import('@/i18n/setup')).default
  return { useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => i18n.t(k, o) }) }
})
vi.mock('@/containers/CoworkSidePanel', () => ({
  CoworkSidePanel: ({ children, summary, 'data-testid': id }: any) => (
    <section data-testid={id}>
      {summary}
      {children}
    </section>
  ),
}))

import { CoworkTimelinePanel } from '@/containers/CoworkTimelinePanel'

let seq = 0
const env = (session: string, kind: string, payload: Record<string, unknown>, invocation = ''): EventEnvelope => ({
  v: 1,
  id: `${kind}:${++seq}`,
  session,
  run: 'r1',
  invocation,
  seq,
  at: '2026-09-11T10:00:00Z',
  kind,
  payload,
  redactions: [],
})

beforeEach(() => {
  seq = 0
  h.pages.clear()
  h.fail.clear()
  h.pages.set('s1', [
    env('s1', 'run.started', { model: 'm' }),
    env('s1', 'tool.requested', { call: 'c1', tool: 'read', phase: 'requested', agent: 'main', summary: 'a.txt' }, 'inv-1'),
    env('s1', 'tool.succeeded', { call: 'c1', tool: 'read', phase: 'succeeded', agent: 'main' }, 'inv-1'),
    env('s1', 'tool.awaiting-permission', { call: 'e1', tool: 'edit', phase: 'awaiting-permission', agent: 'main' }, 'inv-1'),
    env('s1', 'tool.succeeded', {
      call: 'e1', tool: 'edit', phase: 'succeeded', agent: 'main',
      change: { path: 'README.md', kind: 'edited', added: 1, removed: 1, diffStored: true, oversized: false },
    }, 'inv-1'),
    env('s1', 'usage.reported', { inputTokens: 100, cachedTokens: 0, outputTokens: 3 }, 'inv-1'),
    env('s1', 'tool.refused', { call: 'w1', tool: 'write', phase: 'refused', agent: 'reviewer', refusal: 'tool-not-offered' }, 'inv-2'),
    env('s1', 'run.ended', { stoppedBy: 'done' }),
  ])
  h.pages.set('s2', [env('s2', 'tool.requested', { call: 'x9', tool: 'ls', phase: 'requested', agent: 'main' })])
})

const rows = () => screen.queryAllByTestId('timeline-row')
const showAll = () => {
  for (const category of ['messages', 'reasoning', 'edits', 'usage', 'steering', 'approvals', 'background', 'subagents', 'run']) {
    fireEvent.click(screen.getByTestId(`timeline-filter-${category}`))
  }
}

describe('CoworkTimelinePanel', () => {
  it('lists the session\'s events in log order with their state in words', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(rows().map((r) => r.dataset.status)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'refused', 'completed',
    ])
    const edit = rows().find((r) => r.dataset.categories?.includes('edits'))!
    expect(edit.dataset.categories).toContain('approvals')
    expect(edit.getAttribute('aria-label')).toContain('Completed')
    expect(screen.getAllByTestId('timeline-row-counts')[0]).toHaveTextContent('+1 −1')
  })

  it('filters by category and shows everything again', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    expect(screen.getByTestId('timeline-filter-tools')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('timeline-filter-messages')).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(screen.getByTestId('timeline-filter-tools'))
    expect(rows()).toHaveLength(0)
    fireEvent.click(screen.getByTestId('timeline-filter-edits'))
    expect(rows()).toHaveLength(1)
    expect(screen.getByTestId('timeline-filter-edits').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('timeline-filter-tools'))
    expect(rows().length).toBeGreaterThan(1)
  })

  it('opens an edit to its own unified diff, with file and hunk metadata', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    const edit = rows().find((r) => r.dataset.categories?.includes('edits'))!
    fireEvent.click(edit.querySelector('[data-row-toggle]')!)
    await waitFor(() => expect(screen.getByTestId('timeline-diff').dataset.hunks).toBe('1'))
    expect(screen.getByTestId('timeline-diff').dataset.path).toBe('README.md')
    expect(screen.getByTestId('timeline-diff')).toHaveTextContent('New')
  })

  // #244: a provider can reuse a call id across requests, so the diff is
  // asked for by the edit's invocation as well as its call.
  it('loads an edit\'s diff by its invocation, not by the call id alone', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    const edit = rows().find((r) => r.dataset.categories?.includes('edits'))!
    fireEvent.click(edit.querySelector('[data-row-toggle]')!)
    await waitFor(() => expect(loadToolDiff).toHaveBeenCalled())
    expect(loadToolDiff).toHaveBeenLastCalledWith('s1', 'e1', 'inv-1')
  })

  it('shows a typed refusal in the row details', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    const refused = rows().find((r) => r.dataset.status === 'refused')!
    fireEvent.click(refused.querySelector('[data-row-toggle]')!)
    expect(screen.getByTestId('timeline-detail-refusal')).toHaveTextContent('tool-not-offered')
  })

  // #170: opening the panel on an idle session read the log twice from the
  // same point, and every phase in a row's history appeared twice.
  it('lists each phase of a call once when opened on an idle session', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    await act(async () => {})
    const read = rows().find((r) => r.textContent?.includes('a.txt'))!
    fireEvent.click(read.querySelector('[data-row-toggle]')!)
    expect(screen.getByText('requested → succeeded')).toBeInTheDocument()
  })

  it('links everything from one model request', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    fireEvent.click(screen.getAllByTestId('timeline-invocation')[0])
    const linked = rows().filter((r) => r.dataset.linked === 'true')
    expect(linked.map((r) => r.dataset.invocation)).toEqual(['inv-1', 'inv-1', 'inv-1'])
    expect(linked.some((r) => r.dataset.category === 'usage')).toBe(true)
  })

  it('moves between rows with the arrow keys, Home and End', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    const toggles = () => [...document.querySelectorAll<HTMLButtonElement>('[data-row-toggle]')]
    toggles()[0].focus()
    const list = screen.getByTestId('timeline-list')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(toggles()[1])
    fireEvent.keyDown(list, { key: 'End' })
    expect(document.activeElement).toBe(toggles().at(-1))
    fireEvent.keyDown(list, { key: 'Home' })
    expect(document.activeElement).toBe(toggles()[0])
    expect(list.getAttribute('role')).toBe('feed')
  })

  it('pauses following when scrolled up and resumes on request', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    const list = screen.getByTestId('timeline-list')
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true })
    list.scrollTop = 0
    fireEvent.scroll(list)
    expect(screen.getByTestId('timeline-live-state')).toHaveTextContent('Paused')
    fireEvent.click(screen.getByTestId('timeline-follow'))
    expect(screen.getByTestId('timeline-live-state')).toHaveTextContent('Following live')
  })

  it('shows only the session it is given, and drops the previous one on a switch', async () => {
    const { rerender } = render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showAll()
    await waitFor(() => expect(rows()).toHaveLength(6))
    rerender(<CoworkTimelinePanel sessionId="s2" running={false} onClose={() => {}} />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].dataset.status).toBe('running')
  })

  it('says when the log cannot be read, rather than looking empty', async () => {
    h.fail.add('s1')
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('timeline-error')).toHaveTextContent('corrupt log'))
  })

  it('reads new events while a run is going', async () => {
    vi.useFakeTimers()
    try {
      render(<CoworkTimelinePanel sessionId="s1" running={true} onClose={() => {}} />)
      showAll()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(rows()).toHaveLength(6)
      h.pages.get('s1')!.push(
        env('s1', 'tool.requested', { call: 'c9', tool: 'grep', phase: 'requested', agent: 'main' })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600)
      })
      expect(rows()).toHaveLength(7)
      expect(rows().at(-1)?.dataset.status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('virtualizes a long run instead of drawing every row', async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      env('s1', 'tool.succeeded', { call: `k${i}`, tool: 'read', phase: 'succeeded', agent: 'main' })
    )
    h.pages.set('s1', many)
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('timeline-list').dataset.virtual).toBe('true'))
    expect(rows().length).toBeLessThan(400)
  })
})
