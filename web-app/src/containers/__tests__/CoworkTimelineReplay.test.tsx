import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { EventEnvelope } from '@/lib/eventLog'
import type { RunRecording } from '@/lib/runReplay'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const h = vi.hoisted(() => ({
  pages: new Map<string, EventEnvelope[]>(),
  runs: new Map<string, unknown>(),
  recordings: new Map<string, unknown>(),
  gate: null as null | { promise: Promise<void> },
}))
vi.mock('@/lib/eventLog', () => ({
  listEvents: vi.fn(async (session: string, after: number) => {
    const all = h.pages.get(session) ?? []
    return { events: all.filter((e) => e.seq > after), lastSeq: all.at(-1)?.seq ?? 0, truncated: false }
  }),
}))
vi.mock('@/lib/runReplay', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/runReplay')>()
  return {
    ...real,
    listFinishedRuns: vi.fn(async (session: string) => {
      if (h.gate) await h.gate.promise
      return h.runs.get(session) ?? { ok: true, value: [] }
    }),
    loadRunRecording: vi.fn(async (session: string, run: string) => h.recordings.get(`${session}/${run}`)),
  }
})
vi.mock('@/lib/toolActivity', () => ({ loadToolDiff: vi.fn(async () => '') }))
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
import { listFinishedRuns, loadRunRecording } from '@/lib/runReplay'

let seq = 0
const env = (run: string, kind: string, payload: Record<string, unknown>): EventEnvelope => ({
  v: 1,
  id: `${kind}:${++seq}`,
  session: 's1',
  run,
  invocation: 'inv-1',
  seq,
  at: '2026-09-13T10:00:00Z',
  kind,
  payload,
  redactions: [],
})

const summary = (run: string, events: EventEnvelope[]) => ({
  run,
  startedAt: events[0].at,
  endedAt: events.at(-1)!.at,
  stoppedBy: 'done',
  steps: events.length,
  truncated: false,
})

beforeEach(() => {
  seq = 0
  h.pages.clear()
  h.runs.clear()
  h.recordings.clear()
  h.gate = null
  vi.mocked(listFinishedRuns).mockClear()
  vi.mocked(loadRunRecording).mockClear()
  const r1 = [
    env('r1', 'run.started', { model: 'm' }),
    env('r1', 'tool.requested', { call: 'c1', tool: 'read', phase: 'requested', agent: 'main' }),
    env('r1', 'tool.running', { call: 'c1', tool: 'read', phase: 'running', agent: 'main' }),
    env('r1', 'tool.succeeded', { call: 'c1', tool: 'read', phase: 'succeeded', agent: 'main' }),
    env('r1', 'run.ended', { stoppedBy: 'done' }),
  ]
  const r2 = [
    env('r2', 'run.started', { model: 'm' }),
    env('r2', 'run.ended', { stoppedBy: 'aborted' }),
  ]
  h.pages.set('s1', [...r1, ...r2])
  h.runs.set('s1', { ok: true, value: [summary('r1', r1), { ...summary('r2', r2), stoppedBy: 'aborted' }] })
  h.recordings.set('s1/r1', { ok: true, value: { ...summary('r1', r1), events: r1 } satisfies RunRecording })
  h.recordings.set('s1/r2', { ok: true, value: { ...summary('r2', r2), stoppedBy: 'aborted', events: r2 } })
})

const rows = () => screen.queryAllByTestId('timeline-row')
// The panel opens on tools alone. Replay is about the whole run, so these tests
// switch every category on first.
const showEverything = () => {
  for (const button of screen.getAllByTestId(/^timeline-filter-/)) {
    if (button.getAttribute('aria-pressed') === 'false') fireEvent.click(button)
  }
}
const position = () => screen.getByTestId('timeline-replay-position').textContent

describe('CoworkTimelinePanel replay', () => {
  it('steps a finished run forward and back, showing the state at each step', async () => {
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showEverything()
    await waitFor(() => expect(rows()).toHaveLength(5))
    fireEvent.click(screen.getByTestId('timeline-replay'))
    // The latest finished run is chosen first.
    await waitFor(() => expect(screen.getByTestId('timeline-replay-controls').dataset.run).toBe('r2'))
    fireEvent.change(screen.getByTestId('timeline-replay-run'), { target: { value: 'r1' } })
    await waitFor(() => expect(screen.getByTestId('timeline-replay-controls').dataset.run).toBe('r1'))
    expect(loadRunRecording).toHaveBeenLastCalledWith('s1', 'r1')

    expect(position()).toBe('Step 1 of 5')
    expect(rows()).toHaveLength(1)
    expect(screen.getByTestId('timeline-live-state').textContent).toBe('Replaying a finished run')
    expect(screen.getByTestId('timeline-replay-previous')).toBeDisabled()

    fireEvent.click(screen.getByTestId('timeline-replay-next'))
    fireEvent.click(screen.getByTestId('timeline-replay-next'))
    expect(position()).toBe('Step 3 of 5')
    expect(screen.getByTestId('timeline-replay-event').textContent).toContain('tool.running')
    expect(rows()).toHaveLength(2)
    const current = rows().find((r) => r.dataset.current === 'true')!
    expect(current.dataset.status).toBe('running')
    expect(current.getAttribute('aria-current')).toBe('step')

    // The keyboard steps too.
    fireEvent.keyDown(screen.getByTestId('timeline-replay-controls'), { key: 'ArrowLeft' })
    expect(position()).toBe('Step 2 of 5')
    fireEvent.keyDown(screen.getByTestId('timeline-replay-controls'), { key: 'End' })
    expect(position()).toBe('Step 5 of 5')
    expect(rows().map((r) => r.dataset.status)).toEqual(['completed', 'completed', 'completed'])
    expect(screen.getByTestId('timeline-replay-next')).toBeDisabled()
    fireEvent.change(screen.getByTestId('timeline-replay-slider'), { target: { value: '2' } })
    expect(position()).toBe('Step 2 of 5')

    // Leaving replay brings the live timeline back whole.
    fireEvent.click(screen.getByTestId('timeline-replay-exit'))
    expect(screen.queryByTestId('timeline-replay-controls')).toBeNull()
    expect(rows()).toHaveLength(5)
    expect(screen.getByTestId('timeline-live-state').textContent).toBe('Following live')
  })

  it('shows the backend refusal by kind instead of an empty replay', async () => {
    h.runs.set('s1', { ok: true, value: [summary('r1', h.pages.get('s1')!.slice(0, 5))] })
    h.recordings.set('s1/r1', {
      ok: false,
      error: { kind: 'invalid_input', message: 'run r1 has no recorded end, so it cannot be stepped through' },
    })
    render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showEverything()
    await waitFor(() => expect(rows()).toHaveLength(5))
    fireEvent.click(screen.getByTestId('timeline-replay'))
    const alert = await screen.findByTestId('timeline-replay-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.dataset.kind).toBe('invalid_input')
    expect(alert.textContent).toContain('no recorded end')
    expect(screen.queryByTestId('timeline-replay-controls')).toBeNull()
    expect(rows()).toHaveLength(5)
  })

  it('says when there is nothing finished, and is not offered while a run is going', async () => {
    h.runs.set('s1', { ok: true, value: [] })
    const { rerender } = render(<CoworkTimelinePanel sessionId="s1" running={true} onClose={() => {}} />)
    expect(screen.getByTestId('timeline-replay')).toBeDisabled()
    rerender(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('timeline-replay'))
    expect(await screen.findByTestId('timeline-replay-none')).toBeTruthy()
    expect(loadRunRecording).not.toHaveBeenCalled()
  })

  it('drops a replay that lands after it was abandoned', async () => {
    const gate = deferred<void>()
    h.gate = gate
    const { rerender } = render(<CoworkTimelinePanel sessionId="s1" running={false} onClose={() => {}} />)
    showEverything()
    await waitFor(() => expect(rows()).toHaveLength(5))
    fireEvent.click(screen.getByTestId('timeline-replay'))
    expect(screen.getByTestId('timeline-replay-loading')).toBeTruthy()
    // Abandoned mid-flight: exit, then the answer arrives.
    fireEvent.click(screen.getByTestId('timeline-replay-exit'))
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect(screen.queryByTestId('timeline-replay-controls')).toBeNull()
    expect(screen.queryByTestId('timeline-replay-loading')).toBeNull()
    expect(loadRunRecording).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(5)

    // Same for a session change while loading.
    const second = deferred<void>()
    h.gate = second
    fireEvent.click(screen.getByTestId('timeline-replay'))
    h.pages.set('s2', [])
    rerender(<CoworkTimelinePanel sessionId="s2" running={false} onClose={() => {}} />)
    await act(async () => {
      second.resolve()
      await second.promise
    })
    expect(screen.queryByTestId('timeline-replay-controls')).toBeNull()
    expect(loadRunRecording).not.toHaveBeenCalled()
  })
})
