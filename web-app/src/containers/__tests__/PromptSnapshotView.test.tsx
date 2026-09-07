import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  PromptSnapshotView,
  type PromptSnapshot,
} from '@/containers/PromptSnapshotView'

// The stored record is already redacted: `snapshot::capture` redacts before it
// persists, so the viewer never has an unredacted form to leak.
const snap = (over: Partial<PromptSnapshot> = {}): PromptSnapshot => ({
  v: 1,
  id: 'snap-1',
  at: '2026-09-07T12:00:00Z',
  session: 's1',
  run: 'r1',
  thread: 't1',
  agent: 'main',
  provider: 'openai',
  model: 'gpt-4o',
  reasoning: { effort: 'high' },
  payload: {
    model: 'gpt-4o',
    headers: { authorization: '[redacted]' },
    messages: [{ role: 'user', content: 'hello' }],
  },
  hash: 'fnv1a64:0123456789abcdef',
  redactions: [{ path: 'headers.authorization', why: 'auth-header' }],
  ...over,
})

const openIt = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId('prompt-snapshot-toggle'))
}

describe('PromptSnapshotView', () => {
  beforeEach(() => {
    // `navigator.clipboard` is a getter-only property in jsdom, so it has to be
    // defined rather than assigned.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('fetches nothing until it is expanded', async () => {
    const onFetch = vi.fn().mockResolvedValue([snap()])
    render(
      <PromptSnapshotView snapshotId="snap-1" sessionId="s1" onFetch={onFetch} />
    )
    // Collapsed by default: it must not read from disk on every turn.
    expect(onFetch).not.toHaveBeenCalled()
  })

  it('asks for the snapshot with the scope it belongs to', async () => {
    const onFetch = vi.fn().mockResolvedValue([snap()])
    const user = userEvent.setup()
    render(
      <PromptSnapshotView
        snapshotId="snap-1"
        sessionId="s1"
        runId="r1"
        onFetch={onFetch}
      />
    )
    await openIt(user)
    await waitFor(() => expect(onFetch).toHaveBeenCalled())
    // An id alone is not authority; the scope travels with it.
    expect(onFetch).toHaveBeenCalledWith({
      snapshotId: 'snap-1',
      session: 's1',
      run: 'r1',
    })
  })

  it('shows the identity, model, reasoning, hash and redaction summary', async () => {
    const user = userEvent.setup()
    render(
      <PromptSnapshotView
        snapshotId="snap-1"
        sessionId="s1"
        onFetch={vi.fn().mockResolvedValue([snap()])}
      />
    )
    await openIt(user)

    const meta = await screen.findByTestId('prompt-snapshot-meta')
    expect(meta).toHaveTextContent('openai')
    expect(meta).toHaveTextContent('gpt-4o')
    expect(meta).toHaveTextContent('high')
    expect(meta).toHaveTextContent('s1')
    expect(meta).toHaveTextContent('r1')
    expect(meta).toHaveTextContent('main')
    expect(meta).toHaveTextContent('2026-09-07T12:00:00Z')
    expect(meta).toHaveTextContent('fnv1a64:0123456789abcdef')

    expect(screen.getByTestId('prompt-snapshot-redactions')).toHaveTextContent(
      /headers\.authorization \(auth-header\)/
    )
  })

  it('says plainly when nothing was redacted', async () => {
    const user = userEvent.setup()
    render(
      <PromptSnapshotView
        snapshotId="snap-1"
        sessionId="s1"
        onFetch={vi.fn().mockResolvedValue([snap({ redactions: [] })])}
      />
    )
    await openIt(user)
    expect(
      await screen.findByTestId('prompt-snapshot-redactions')
    ).toHaveTextContent('nothing')
  })

  it('offers a tree and a JSON view of the same payload', async () => {
    const user = userEvent.setup()
    render(
      <PromptSnapshotView
        snapshotId="snap-1"
        sessionId="s1"
        onFetch={vi.fn().mockResolvedValue([snap()])}
      />
    )
    await openIt(user)

    // Tree by default.
    expect(await screen.findByTestId('prompt-snapshot-tree')).toHaveTextContent(
      'hello'
    )
    await user.click(screen.getByTestId('prompt-snapshot-view-json'))
    const json = await screen.findByTestId('prompt-snapshot-json')
    expect(json).toHaveTextContent(/"role": "user"/)
    expect(screen.getByTestId('prompt-snapshot-view-json')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('copies the redacted payload and nothing else', async () => {
    const user = userEvent.setup()
    // After setup(): userEvent installs its own clipboard stub and would
    // otherwise replace this one.
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <PromptSnapshotView
        snapshotId="snap-1"
        sessionId="s1"
        onFetch={vi.fn().mockResolvedValue([snap()])}
      />
    )
    await openIt(user)
    await screen.findByTestId('prompt-snapshot-copy')
    await user.click(screen.getByTestId('prompt-snapshot-copy'))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0][0] as string
    // What is copied is exactly what is shown, and the record was redacted
    // before it was ever written.
    expect(copied).toContain('[redacted]')
    expect(copied).not.toMatch(/Bearer\s/)
    expect(copied).not.toContain('sk-')
  })

  it('renders an unavailable snapshot and says why', async () => {
    const user = userEvent.setup()
    render(
      <PromptSnapshotView
        snapshotId="snap-1"
        sessionId="s1"
        onFetch={vi
          .fn()
          .mockResolvedValue([
            snap({ unavailable: 'too-large', payload: null, hash: '' }),
          ])}
      />
    )
    await openIt(user)
    const note = await screen.findByTestId('prompt-snapshot-unavailable')
    expect(note).toHaveTextContent(/too large to store/i)
    // No payload view is offered for a record that has no payload.
    expect(screen.queryByTestId('prompt-snapshot-json')).toBeNull()
    expect(screen.queryByTestId('prompt-snapshot-tree')).toBeNull()
  })

  it('reports a snapshot that is no longer on disk', async () => {
    // What a truncated or pruned JSONL tail looks like from here.
    const user = userEvent.setup()
    render(
      <PromptSnapshotView
        snapshotId="snap-gone"
        sessionId="s1"
        onFetch={vi.fn().mockResolvedValue([])}
      />
    )
    await openIt(user)
    expect(await screen.findByTestId('prompt-snapshot-error')).toHaveTextContent(
      /no longer on disk/i
    )
  })

  it('renders a refusal from the backend instead of a raw object', async () => {
    const user = userEvent.setup()
    render(
      <PromptSnapshotView
        snapshotId="snap-1"
        onFetch={vi
          .fn()
          .mockRejectedValue(
            'a snapshot must be requested with the session or run it belongs to'
          )}
      />
    )
    await openIt(user)
    const error = await screen.findByTestId('prompt-snapshot-error')
    expect(error).toHaveTextContent(/must be requested with the session/i)
    expect(error).not.toHaveTextContent(/\[object Object\]/)
  })

  it('is operable from the keyboard', async () => {
    const onFetch = vi.fn().mockResolvedValue([snap()])
    const user = userEvent.setup()
    render(
      <PromptSnapshotView snapshotId="snap-1" sessionId="s1" onFetch={onFetch} />
    )
    const toggle = screen.getByTestId('prompt-snapshot-toggle')
    // Reachable: a <summary> is focusable, so it is in the tab order without a
    // tabindex of its own.
    toggle.focus()
    expect(toggle).toHaveFocus()
    // jsdom does not implement the Enter-to-toggle behaviour real browsers give
    // <details>, so activation is asserted through the click it dispatches.
    await user.click(toggle)
    await waitFor(() => expect(onFetch).toHaveBeenCalled())
  })

  it('does not re-fetch every time it is toggled', async () => {
    const onFetch = vi.fn().mockResolvedValue([snap()])
    const user = userEvent.setup()
    render(
      <PromptSnapshotView snapshotId="snap-1" sessionId="s1" onFetch={onFetch} />
    )
    await openIt(user)
    await waitFor(() => expect(onFetch).toHaveBeenCalledTimes(1))
    await openIt(user)
    await openIt(user)
    expect(onFetch).toHaveBeenCalledTimes(1)
  })
})
