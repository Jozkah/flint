import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ActivityTimeline } from './ActivityTimeline'
import {
  appendActivityEvents,
  emptyActivityLog,
  type IncomingActivityEvent,
} from '@/lib/activityEvents'

const SESSION = 's1'

function event(
  over: Partial<IncomingActivityEvent> & Pick<IncomingActivityEvent, 'id' | 'at'>
): IncomingActivityEvent {
  return {
    sessionId: SESSION,
    kind: 'command',
    status: 'ok',
    title: 'Ran a command',
    detail: { kind: 'command', command: { command: 'ls' } },
    ...over,
  }
}

const sample = () =>
  appendActivityEvents(emptyActivityLog(SESSION), [
    event({
      id: 'read',
      at: 1,
      kind: 'file.read',
      title: 'Read src/main.rs',
      detail: { kind: 'read', read: { path: 'src/main.rs', fromLine: 10, toLine: 40 } },
    }),
    event({
      id: 'edit',
      at: 2,
      kind: 'file.edited',
      title: 'Edited src/main.rs',
      detail: {
        kind: 'change',
        change: { path: 'src/main.rs', diff: '-    1 | old\n+    1 | new', added: 1, removed: 1 },
      },
    }),
    event({
      id: 'build',
      at: 3,
      kind: 'verification',
      status: 'error',
      title: 'Ran build',
      detail: {
        kind: 'verification',
        verification: {
          tool: 'build',
          command: 'cargo build',
          cwd: '/repo',
          exitCode: 101,
          durationMs: 4200,
          stderr: 'error: could not compile',
        },
      },
    }),
    event({
      id: 'perm',
      at: 4,
      kind: 'permission.decided',
      title: 'Permission denied for bash',
      status: 'error',
      detail: {
        kind: 'permission',
        permission: {
          requestId: 'r1',
          tool: 'bash',
          promptKind: 'destructive_git',
          resource: 'git reset --hard',
          decision: 'deny',
        },
      },
    }),
    event({
      id: 'git',
      at: 5,
      kind: 'git',
      title: 'git push',
      detail: { kind: 'git', git: { operation: 'push', destructive: true } },
    }),
    event({ id: 'running', at: 6, status: 'pending', title: 'Running tests' }),
  ])

describe('ActivityTimeline', () => {
  it('renders one row per event, in order', () => {
    render(<ActivityTimeline log={sample()} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(6)
    expect(rows[0]).toHaveTextContent('Read src/main.rs')
    expect(rows.at(-1)).toHaveTextContent('Running tests')
  })

  it('says so when nothing has run, and distinguishes that from a filter with no matches', async () => {
    const { rerender } = render(<ActivityTimeline log={emptyActivityLog(SESSION)} />)
    expect(screen.getByText('Nothing has run yet.')).toBeInTheDocument()

    rerender(<ActivityTimeline log={sample()} />)
    await userEvent.type(screen.getByRole('searchbox'), 'nothing matches this')
    expect(screen.getByText('No activity matches this filter.')).toBeInTheDocument()
  })

  it('filters by family', async () => {
    render(<ActivityTimeline log={sample()} />)
    await userEvent.click(screen.getByRole('button', { name: 'files' }))
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Read src/main.rs')
    expect(rows[1]).toHaveTextContent('Edited src/main.rs')
  })

  it('filters to problems, and counts them on the control', async () => {
    render(<ActivityTimeline log={sample()} />)
    const problems = screen.getByRole('button', { name: /problems/ })
    expect(problems).toHaveTextContent('problems (2)')
    await userEvent.click(problems)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ran build')
  })

  it('searches the detail, not only the title', async () => {
    render(<ActivityTimeline log={sample()} />)
    // "cargo build" appears only in the command, not in the title "Ran build".
    await userEvent.type(screen.getByRole('searchbox'), 'cargo')
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Ran build')
  })

  it('marks the active filter as pressed, for a screen reader and for the eye', async () => {
    render(<ActivityTimeline log={sample()} />)
    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.click(screen.getByRole('button', { name: 'git' }))
    expect(screen.getByRole('button', { name: 'git' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('expands a change into its diff and collapses it again', async () => {
    render(<ActivityTimeline log={sample()} />)
    const toggle = screen.getByRole('button', { name: 'Expand Edited src/main.rs' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(
      screen.getByRole('button', { name: 'Collapse Edited src/main.rs' })
    ).toHaveAttribute('aria-expanded', 'true')
    // The gutter's spacing is content here, so whitespace is not normalized away.
    expect(
      screen.getByText('+    1 | new', { normalizer: (text) => text })
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Collapse Edited src/main.rs' }))
    expect(
      screen.queryByText('+    1 | new', { normalizer: (text) => text })
    ).not.toBeInTheDocument()
  })

  it('expands a command into its working directory, command line and output', async () => {
    render(<ActivityTimeline log={sample()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Expand Ran build' }))
    expect(screen.getByText('/repo $ cargo build')).toBeInTheDocument()
    expect(screen.getByText('error: could not compile')).toBeInTheDocument()
  })

  it('offers no expander for a row with nothing behind it', () => {
    render(<ActivityTimeline log={sample()} />)
    expect(
      screen.queryByRole('button', { name: /Expand Running tests/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Expand git push/ })
    ).not.toBeInTheDocument()
  })

  it('shows a run failure and its exit code without expanding', () => {
    render(<ActivityTimeline log={sample()} />)
    const build = screen.getByText('Ran build').closest('div')!
    expect(within(build.parentElement!).getByText(/exit 101/)).toBeInTheDocument()
  })

  it('navigates to a file at the line it read', async () => {
    const onOpenFile = vi.fn()
    render(<ActivityTimeline log={sample()} onOpenFile={onOpenFile} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Open src/main.rs at line 10' })
    )
    expect(onOpenFile).toHaveBeenCalledWith('src/main.rs', 10)
  })

  it('renders no open affordance for a row with no location, or with no handler', () => {
    const { rerender } = render(
      <ActivityTimeline log={sample()} onOpenFile={vi.fn()} />
    )
    // git and permission rows have no file to open.
    expect(screen.queryByRole('button', { name: /^Open git/ })).not.toBeInTheDocument()

    rerender(<ActivityTimeline log={sample()} />)
    expect(screen.queryByRole('button', { name: /^Open / })).not.toBeInTheDocument()
  })

  it('copies the redacted record of one row', async () => {
    const onCopy = vi.fn()
    render(<ActivityTimeline log={sample()} onCopy={onCopy} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Copy details of Ran build' })
    )
    const [text] = onCopy.mock.calls[0]
    expect(text).toContain('cargo build')
    expect(text).toContain('exit: 101')
    expect(text).toContain('cwd: /repo')
  })

  it('scopes to one tool call when asked', () => {
    const log = appendActivityEvents(emptyActivityLog(SESSION), [
      event({ id: 'a', at: 1, callId: 'call-1', title: 'First call' }),
      event({ id: 'b', at: 2, callId: 'call-2', title: 'Second call' }),
    ])
    render(<ActivityTimeline log={log} callId="call-2" />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Second call')
  })

  it('says how many earlier events are no longer kept', () => {
    const log = { ...sample(), dropped: 12 }
    render(<ActivityTimeline log={log} />)
    expect(
      screen.getByText('12 earlier events are no longer kept.')
    ).toBeInTheDocument()
  })

  it('announces itself as a live log so additions are read out', () => {
    render(<ActivityTimeline log={sample()} />)
    const region = screen.getByRole('log')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAccessibleName('6 activity events')
  })

  it('labels each row with its outcome, not only its title', () => {
    render(<ActivityTimeline log={sample()} />)
    expect(
      screen.getByLabelText('Ran build, failed, exit code 101')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Running tests, in progress')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Edited src/main.rs, succeeded, 1 lines added, 1 removed')
    ).toBeInTheDocument()
  })

  it('virtualizes a long list rather than rendering thousands of rows', () => {
    let log = emptyActivityLog(SESSION)
    log = appendActivityEvents(
      log,
      Array.from({ length: 500 }, (_, i) => event({ id: `e${i}`, at: i + 1 }))
    )
    render(<ActivityTimeline log={log} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(500)
    // The list still reports its true length to a screen reader.
    expect(screen.getByRole('log')).toHaveAccessibleName('500 activity events')
  })
})
