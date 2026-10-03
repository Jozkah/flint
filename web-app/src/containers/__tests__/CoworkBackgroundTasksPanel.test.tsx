import { act, render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { CoworkBackgroundTasksPanel } from '../CoworkBackgroundTasksPanel'
import { CoworkRailToolbar } from '../CoworkRailToolbar'
import { useBackgroundTabState } from '@/hooks/useBackgroundTabState'
import type { ActivityTask } from '@/lib/coworkActivity'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts
        ? `${key} ${Object.entries(opts)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`
        : key,
  }),
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const task = (over: Partial<ActivityTask> = {}): ActivityTask => ({
  id: `s::w::${over.callId ?? 'c'}`,
  callId: 'c',
  sessionId: 's',
  workflowId: 'w',
  kind: 'agent',
  title: 'Chat limits parity fix',
  status: 'running',
  startedAt: Date.now() - 5000,
  background: true,
  model: 'Sonnet 5.5',
  ...over,
})

const props = (over: Partial<React.ComponentProps<typeof CoworkBackgroundTasksPanel>> = {}) => ({
  sessionId: 's',
  running: [] as ActivityTask[],
  finished: [] as ActivityTask[],
  onCancelTask: vi.fn(),
  onDismiss: vi.fn(),
  onClearFinished: vi.fn(),
  onClose: vi.fn(),
  ...over,
})

beforeEach(() => {
  useBackgroundTabState.setState({ collapsed: {} })
  localStorage.clear()
})

describe('CoworkBackgroundTasksPanel', () => {
  it('shows Running and Finished sections with a count', () => {
    render(
      <CoworkBackgroundTasksPanel
        {...props({
          running: [task({ callId: 'a' })],
          finished: [
            task({ callId: 'b', status: 'done', endedAt: Date.now() }),
            task({ callId: 'c', status: 'error', endedAt: Date.now() }),
          ],
        })}
      />
    )
    expect(screen.getByTestId('background-running')).toBeInTheDocument()
    expect(screen.getByText('common:tasks.backgroundFinished count=2')).toBeInTheDocument()
    expect(screen.getAllByTestId('background-row')).toHaveLength(3)
  })

  it('shows model, tokens and tool uses for a subagent, with a live status line', () => {
    render(
      <CoworkBackgroundTasksPanel
        {...props({
          running: [
            task({
              usage: { prompt_tokens: 200_000, completion_tokens: 76_400, total_tokens: 276_400 },
              transcript: [
                { role: 'tool', name: 'bash', content: '', toolState: 'succeeded' },
                { role: 'tool', name: 'bash', content: '', toolState: 'running' },
              ],
            }),
          ],
        })}
      />
    )
    const stats = screen.getByTestId('background-stats')
    expect(stats).toHaveTextContent('Sonnet 5.5')
    expect(stats).toHaveTextContent('276')
    expect(stats).toHaveTextContent('toolUses count=2')
    expect(screen.getByTestId('background-status-line')).toHaveTextContent(
      'common:tasks.line.command'
    )
  })

  it('marks estimated tokens with a tilde, never as a measurement', () => {
    render(
      <CoworkBackgroundTasksPanel
        {...props({
          running: [task({ transcript: [{ role: 'assistant', content: 'a'.repeat(800) }] })],
        })}
      />
    )
    expect(screen.getByTestId('background-stats').textContent).toContain('~')
  })

  it('ticks the elapsed time of a running row', () => {
    vi.useFakeTimers()
    try {
      const started = Date.now()
      render(<CoworkBackgroundTasksPanel {...props({ running: [task({ startedAt: started })] })} />)
      const before = screen.getByTestId('background-elapsed').textContent
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      // The component re-reads the clock on its interval.
      expect(screen.getByTestId('background-elapsed').textContent).not.toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a running task through the callback', async () => {
    const onCancelTask = vi.fn()
    const running = task({ callId: 'a' })
    render(<CoworkBackgroundTasksPanel {...props({ running: [running], onCancelTask })} />)
    await userEvent.click(screen.getByRole('button', { name: /stopTask/ }))
    expect(onCancelTask).toHaveBeenCalledWith(running)
  })

  it('opens a transcript for a subagent and output for a command', async () => {
    render(
      <CoworkBackgroundTasksPanel
        {...props({
          running: [
            task({
              callId: 'agent',
              description: 'find the config',
              transcript: [{ role: 'assistant', content: 'looking now' }],
            }),
            task({
              callId: 'shell',
              kind: 'shell',
              title: 'pnpm dev',
              command: 'pnpm dev',
              jobId: 'bash-1',
              output: 'ready on :3000',
            }),
          ],
        })}
      />
    )
    const links = screen.getAllByRole('button', { name: /view(Transcript|Output)/ })
    expect(links[0]).toHaveTextContent('common:tasks.viewTranscript')
    expect(links[1]).toHaveTextContent('common:tasks.viewOutput')

    await userEvent.click(links[0])
    expect(screen.getByTestId('subagent-transcript')).toBeInTheDocument()
    expect(screen.getByText('looking now')).toBeInTheDocument()

    await userEvent.click(links[1])
    expect(screen.getByTestId('background-output')).toHaveTextContent('ready on :3000')
  })

  it('closes an open row on Escape', async () => {
    render(<CoworkBackgroundTasksPanel {...props({ running: [task({})] })} />)
    await userEvent.click(screen.getByRole('button', { name: /viewTranscript/ }))
    expect(screen.getByTestId('subagent-transcript')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('subagent-transcript'), { key: 'Escape' })
    expect(screen.queryByTestId('subagent-transcript')).toBeNull()
  })

  it('bounds a command’s output to its tail', async () => {
    const output = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    render(
      <CoworkBackgroundTasksPanel
        {...props({
          running: [task({ kind: 'shell', jobId: 'j', title: 'build', output })],
        })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /viewOutput/ }))
    const pre = screen.getByTestId('background-output').querySelector('pre')!
    expect(pre.textContent).toContain('line 499')
    expect(pre.textContent).not.toContain('line 0\n')
  })

  it('collapses a section, and remembers it for this session only', async () => {
    const { unmount } = render(
      <CoworkBackgroundTasksPanel
        {...props({ running: [task({ callId: 'a' })] })}
      />
    )
    const header = within(screen.getByTestId('background-running')).getByRole('button', {
      name: /backgroundRunning/,
    })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(header)
    expect(screen.queryByTestId('background-row')).toBeNull()
    unmount()

    // Remounted: still collapsed. Another session: not.
    render(<CoworkBackgroundTasksPanel {...props({ running: [task({ callId: 'a' })] })} />)
    expect(screen.queryByTestId('background-row')).toBeNull()
    expect(JSON.parse(localStorage.getItem('cowork-background-tab')!).state.collapsed.s.running).toBe(true)
    unmount()
    render(
      <CoworkBackgroundTasksPanel {...props({ sessionId: 'other', running: [task({ callId: 'a' })] })} />
    )
    expect(screen.getByTestId('background-row')).toBeInTheDocument()
  })

  it('clears finished rows with the trash button and dismisses one with its X', async () => {
    const onClearFinished = vi.fn()
    const onDismiss = vi.fn()
    const finished = task({ callId: 'f', status: 'done', endedAt: Date.now() })
    render(
      <CoworkBackgroundTasksPanel
        {...props({ running: [task({ callId: 'r' })], finished: [finished], onClearFinished, onDismiss })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'common:tasks.backgroundClear' }))
    expect(onClearFinished).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: /backgroundDismiss/ }))
    expect(onDismiss).toHaveBeenCalledWith(finished)
    // A running row has a stop control, never a dismiss.
    const runningRow = within(screen.getByTestId('background-running')).getByTestId('background-row')
    expect(within(runningRow).queryByRole('button', { name: /backgroundDismiss/ })).toBeNull()
  })

  it('shows the empty state when nothing is listed', () => {
    render(<CoworkBackgroundTasksPanel {...props()} />)
    expect(screen.getByText('common:tasks.backgroundEmpty')).toBeInTheDocument()
  })

  it('labels a child that used all its steps', () => {
    render(
      <CoworkBackgroundTasksPanel
        {...props({
          finished: [task({ status: 'error', stoppedAtLimit: true, endedAt: Date.now() })],
        })}
      />
    )
    expect(screen.getByText('common:tasks.limitBadge')).toBeInTheDocument()
  })
})

describe('the Background tasks tab', () => {
  const toolbar = (background?: { running: number; total: number }) =>
    render(
      <CoworkRailToolbar
        presentation="tabs"
        active={null}
        onSelect={vi.fn()}
        changeCount={0}
        additions={0}
        deletions={0}
        activity={{ total: 0, running: 0, queued: 0, finished: 0, error: 0, cancelled: 0, tokens: 0, fraction: null } as never}
        background={background}
      />
    )

  it('is absent until something is listed', () => {
    toolbar(undefined)
    expect(screen.queryByRole('button', { name: 'common:rail.background' })).toBeNull()
  })

  it('is absent when the list is empty (after a clear)', () => {
    toolbar({ running: 0, total: 0 })
    expect(screen.queryByRole('button', { name: 'common:rail.background' })).toBeNull()
  })

  it('appears with a count of running tasks', () => {
    toolbar({ running: 2, total: 3 })
    expect(screen.getByRole('button', { name: 'common:rail.background' })).toBeInTheDocument()
    expect(screen.getByTestId('background-tab-count')).toHaveTextContent('2')
  })

  it('stays, without a count, while only finished rows are listed', () => {
    toolbar({ running: 0, total: 1 })
    expect(screen.getByRole('button', { name: 'common:rail.background' })).toBeInTheDocument()
    expect(screen.queryByTestId('background-tab-count')).toBeNull()
  })
})
