import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const getJanDataFolder = vi.fn(async () => DATA_FOLDER)
const hub = { app: () => ({ getJanDataFolder }) }
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => hub,
  getServiceHub: () => hub,
}))

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  sessionWorkspacePath: vi.fn(),
}))

import { sessionWorkspacePath } from '@janhq/tauri-plugin-agent-tools-api'
import { useSessionWorkspacePath } from '../useSessionWorkspacePath'

const lookup = vi.mocked(sessionWorkspacePath)
const DATA_FOLDER = '/mock/jan/data'
const WS_A = '/mock/jan/data/agent-workspace/sessions/session-a'
const WS_B = '/mock/jan/data/agent-workspace/sessions/session-b'

/** A lookup whose resolution this test controls. */
const deferred = () => {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function Probe({ sessionId }: { sessionId: string | null }) {
  const workspacePath = useSessionWorkspacePath(sessionId)
  return <span data-testid="path">{workspacePath ?? 'pending'}</span>
}

const shown = () => screen.getByTestId('path').textContent
/** Let the hook's awaits run to completion without advancing wall-clock. */
const drain = () =>
  act(async () => void (await new Promise((r) => setTimeout(r, 0))))

describe('useSessionWorkspacePath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getJanDataFolder.mockResolvedValue(DATA_FOLDER)
  })

  it('reports no path while the lookup for this session is in flight', async () => {
    lookup.mockReturnValue(deferred().promise)
    render(<Probe sessionId="session-a" />)
    await drain()
    expect(shown()).toBe('pending')
  })

  it('clears the previous session’s path the moment the session changes', async () => {
    lookup.mockResolvedValueOnce(WS_A)
    const { rerender } = render(<Probe sessionId="session-a" />)
    await waitFor(() => expect(shown()).toBe(WS_A))

    // B's lookup never settles here: the point is that A's path is gone
    // immediately, not once B answers.
    lookup.mockReturnValue(deferred().promise)
    rerender(<Probe sessionId="session-b" />)
    expect(shown()).toBe('pending')
  })

  it('ignores a lookup for A that resolves after the lookup for B', async () => {
    const a = deferred()
    lookup.mockReturnValueOnce(a.promise)
    const { rerender } = render(<Probe sessionId="session-a" />)
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
    a.resolve(WS_A)
    await waitFor(() => expect(shown()).toBe(WS_A))

    // A second lookup, slow to answer. Through the whole round trip B must
    // report no path — reporting A's is what let B read A's files.
    const b = deferred()
    lookup.mockReturnValueOnce(b.promise)
    rerender(<Probe sessionId="session-b" />)
    expect(shown()).toBe('pending')
    await drain()
    expect(shown()).toBe('pending')
    b.resolve(WS_B)
    await waitFor(() => expect(shown()).toBe(WS_B))

    // A third lookup for A, started before the switch, answers last. Taking
    // it would point session B at session A's directory, with nothing to
    // correct it.
    const late = deferred()
    lookup.mockReturnValueOnce(late.promise)
    rerender(<Probe sessionId="session-a" />)
    rerender(<Probe sessionId="session-b" />)
    late.resolve(WS_A)
    await drain()
    expect(shown()).not.toBe(WS_A)
  })

  it('ignores a stale lookup even when the session is switched back', async () => {
    // A flag scoped to one effect run cannot catch this: the second run for
    // A is live, so the first run's answer would look current.
    const first = deferred()
    lookup.mockReturnValueOnce(first.promise)
    const { rerender } = render(<Probe sessionId="session-a" />)
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))

    lookup.mockReturnValueOnce(deferred().promise)
    rerender(<Probe sessionId="session-b" />)

    const second = deferred()
    lookup.mockReturnValueOnce(second.promise)
    rerender(<Probe sessionId="session-a" />)

    first.resolve('/stale/path')
    await drain()
    expect(shown()).toBe('pending')

    second.resolve(WS_A)
    await waitFor(() => expect(shown()).toBe(WS_A))
  })

  it('reports no path and asks for nothing without a session', async () => {
    render(<Probe sessionId={null} />)
    await drain()
    expect(shown()).toBe('pending')
    expect(lookup).not.toHaveBeenCalled()
  })
})
