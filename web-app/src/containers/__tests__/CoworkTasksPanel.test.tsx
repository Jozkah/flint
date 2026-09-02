/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { CoworkTasksPanel } from '../CoworkTasksPanel'
import { CoworkTasksChip } from '../CoworkTasksChip'
import {
  emptyActivityState,
  endWorkflow,
  observePhase,
  progressOf,
  sessionTotals,
  sessionWorkflows,
  startTask,
  startWorkflow,
  type ActivityState,
  type ActivityTask,
  type ActivityWorkflow,
} from '@/lib/coworkActivity'

// Interpolates, so assertions can check the numbers rather than just the key.
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
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
}))

const SESSION = 's-1'
const WORKFLOW = 'run-1'
const T0 = 1_700_000_000_000

const workflow = (over: Partial<ActivityWorkflow> = {}): ActivityWorkflow => ({
  id: WORKFLOW,
  sessionId: SESSION,
  title: 'refactor the parser',
  startedAt: T0,
  phases: [],
  ...over,
})

const task = (over: Partial<ActivityTask> = {}): ActivityTask => ({
  id: 'call-1',
  sessionId: SESSION,
  workflowId: WORKFLOW,
  kind: 'agent',
  title: 'researcher',
  status: 'done',
  startedAt: T0,
  endedAt: T0 + 4_000,
  ...over,
})

const stateWith = (
  tasks: ActivityTask[],
  over: Partial<ActivityWorkflow> = {}
): ActivityState =>
  tasks.reduce(
    (state, one) => startTask(state, one),
    startWorkflow(emptyActivityState(), workflow(over))
  )

function Panel({
  state,
  onCancelTask = vi.fn(),
  onClearFinished = vi.fn(),
  onClose = vi.fn(),
  focusTaskId,
}: {
  state: ActivityState
  onCancelTask?: (task: ActivityTask) => void
  onClearFinished?: () => void
  onClose?: () => void
  focusTaskId?: string | null
}) {
  return (
    <CoworkTasksPanel
      workflows={sessionWorkflows(state, SESSION)}
      totals={sessionTotals(state, SESSION)}
      focusTaskId={focusTaskId}
      onCancelTask={onCancelTask}
      onClearFinished={onClearFinished}
      onClose={onClose}
    />
  )
}

/** Open a workflow section so its tasks render. */
const openWorkflow = async (title = 'refactor the parser') =>
  userEvent.click(screen.getByRole('button', { name: new RegExp(title) }))

describe('CoworkTasksPanel', () => {
  it('says so when the session has run nothing', () => {
    render(<Panel state={emptyActivityState()} />)
    expect(screen.getByText('common:tasks.empty')).toBeInTheDocument()
  })

  it('summarises a workflow before it is opened', () => {
    render(
      <Panel
        state={stateWith([
          task({ id: 'a', status: 'done', usage: { total_tokens: 1200 } }),
          task({ id: 'b', status: 'running', endedAt: undefined }),
        ])}
      />
    )
    expect(
      screen.getByText(/common:tasks.progress finished=1 total=2/)
    ).toBeInTheDocument()
    // Not finished: a child is still running.
    expect(screen.getByTestId('task-status-running')).toBeInTheDocument()
  })

  it('reports progress on a bar screen readers can read', () => {
    render(
      <Panel
        state={stateWith([
          task({ id: 'a', status: 'done' }),
          task({ id: 'b', status: 'error' }),
          task({ id: 'c', status: 'running', endedAt: undefined }),
        ])}
      />
    )
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar).toHaveAttribute('aria-valuemax', '3')
  })

  it('lists a subagent with the metadata captured when it was dispatched', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            model: 'jan-nano-4b',
            usage: { total_tokens: 1234 },
            toolCount: 3,
          }),
        ])}
      />
    )
    await openWorkflow()
    // The row, not the workflow header above it, which totals the same tokens.
    const row = screen.getByRole('button', { name: /researcher/ })
    expect(within(row).getByText('researcher')).toBeInTheDocument()
    expect(within(row).getByText(/tokens=1.2k/)).toBeInTheDocument()
    expect(within(row).getByText(/toolCalls.*count=3/)).toBeInTheDocument()
    expect(within(row).getByText(/model=jan-nano-4b/)).toBeInTheDocument()
  })

  it('shows a queued subagent with its place in the queue', async () => {
    render(
      <Panel
        state={stateWith([
          task({ status: 'queued', waiting: 2, endedAt: undefined }),
        ])}
      />
    )
    await openWorkflow()
    expect(screen.getByText(/queuePosition position=2/)).toBeInTheDocument()
  })

  it('groups tasks under the phase they were dispatched in', async () => {
    let state = startWorkflow(emptyActivityState(), workflow())
    const scan = observePhase(state, WORKFLOW, { name: 'Scan', index: 0 })
    state = startTask(scan.state, task({ id: 'a', phaseId: scan.phaseId }))
    state = startTask(state, task({ id: 'b', title: 'loose' }))

    render(<Panel state={state} />)
    await openWorkflow()
    expect(screen.getByText(/common:tasks.phase name=Scan/)).toBeInTheDocument()
    expect(screen.getByText('common:tasks.unphased')).toBeInTheDocument()
  })

  it('flags a command still running in the background with its job', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            kind: 'shell',
            title: 'pnpm build',
            status: 'running',
            endedAt: undefined,
            jobId: 'bash-3',
          }),
        ])}
      />
    )
    await openWorkflow()
    expect(screen.getByText(/background jobId=bash-3/)).toBeInTheDocument()
  })

  it('expands a task to reveal its description, transcript and output', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            description: 'map the lexer',
            transcript: [
              { role: 'assistant', content: 'looking' },
              {
                role: 'tool',
                name: 'grep',
                content: '',
                args: { pattern: 'token' },
              },
            ],
            output: 'found 3 matches',
          }),
        ])}
      />
    )
    await openWorkflow()
    await userEvent.click(screen.getByRole('button', { name: /researcher/ }))
    expect(screen.getByText('map the lexer')).toBeInTheDocument()
    expect(screen.getByText('looking')).toBeInTheDocument()
    expect(screen.getByText('token')).toBeInTheDocument()
    expect(screen.getByText('found 3 matches')).toBeInTheDocument()
  })

  it('shows only the tail of a very long output, and says so', async () => {
    const output = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    render(<Panel state={stateWith([task({ output })])} />)
    await openWorkflow()
    await userEvent.click(screen.getByRole('button', { name: /researcher/ }))

    expect(screen.getByText(/outputTruncated lines=200/)).toBeInTheDocument()
    const pre = document.querySelector('pre')!
    expect(pre.textContent).toContain('line 499')
    expect(pre.textContent).not.toContain('line 0\n')
  })

  it('renders output as text, never as markup', async () => {
    // Whatever a shell command printed must not become elements on the page.
    render(
      <Panel
        state={stateWith([
          task({ kind: 'shell', output: '<img src=x onerror="boom()">' }),
        ])}
      />
    )
    await openWorkflow()
    await userEvent.click(screen.getByRole('button', { name: /researcher/ }))
    expect(document.querySelector('pre img')).toBeNull()
    expect(screen.getByText('<img src=x onerror="boom()">')).toBeInTheDocument()
  })

  it('says when a finished task kept no details', async () => {
    render(<Panel state={stateWith([task({ output: undefined })])} />)
    await openWorkflow()
    await userEvent.click(screen.getByRole('button', { name: /researcher/ }))
    expect(
      screen.getByText('common:tasks.detailsUnavailable')
    ).toBeInTheDocument()
  })

  it('explains why a cancelled task stopped', async () => {
    render(
      <Panel
        state={stateWith([
          task({ status: 'cancelled', detail: 'cancelled:user' }),
        ])}
      />
    )
    await openWorkflow()
    await userEvent.click(screen.getByRole('button', { name: /researcher/ }))
    expect(screen.getByText('common:tasks.cancelledByUser')).toBeInTheDocument()
  })

  describe('stopping work', () => {
    it('offers to stop only what is still going', async () => {
      render(
        <Panel
          state={stateWith([
            task({
              id: 'a',
              title: 'live',
              status: 'running',
              endedAt: undefined,
            }),
            task({ id: 'b', title: 'over', status: 'done' }),
          ])}
        />
      )
      await openWorkflow()
      expect(
        screen.getByRole('button', { name: /stopTask name=live/ })
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /stopTask name=over/ })
      ).toBeNull()
    })

    it('asks to stop the task the button belongs to', async () => {
      const onCancelTask = vi.fn()
      render(
        <Panel
          state={stateWith([
            task({
              id: 'a',
              title: 'live',
              status: 'running',
              endedAt: undefined,
            }),
          ])}
          onCancelTask={onCancelTask}
        />
      )
      await openWorkflow()
      await userEvent.click(
        screen.getByRole('button', { name: /stopTask name=live/ })
      )
      expect(onCancelTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a' })
      )
    })
  })

  describe('clearing finished work', () => {
    it('offers to clear once something has finished', () => {
      render(<Panel state={stateWith([task({ status: 'done' })])} />)
      expect(
        screen.getByRole('button', { name: 'common:tasks.clearFinished' })
      ).toBeInTheDocument()
    })

    it('does not offer to clear while everything is still going', () => {
      render(
        <Panel
          state={stateWith([task({ status: 'running', endedAt: undefined })])}
        />
      )
      expect(
        screen.queryByRole('button', { name: 'common:tasks.clearFinished' })
      ).toBeNull()
    })
  })

  describe('revealing a task the card pointed at', () => {
    it('opens its workflow and expands it', async () => {
      const onFocusHandled = vi.fn()
      render(
        <CoworkTasksPanel
          workflows={sessionWorkflows(
            stateWith([task({ id: 'call-9', output: 'the answer' })]),
            SESSION
          )}
          totals={progressOf([])}
          focusTaskId="call-9"
          onFocusHandled={onFocusHandled}
          onCancelTask={vi.fn()}
          onClearFinished={vi.fn()}
          onClose={vi.fn()}
        />
      )
      // Expanded without a click: the workflow section and the task both open.
      expect(await screen.findByText('the answer')).toBeInTheDocument()
      expect(onFocusHandled).toHaveBeenCalled()
    })

    it('reports the request handled even when the task is gone', () => {
      // Cleared between the click and the render; the panel must not keep
      // asking to focus something that no longer exists.
      const onFocusHandled = vi.fn()
      render(
        <CoworkTasksPanel
          workflows={[]}
          totals={progressOf([])}
          focusTaskId="call-missing"
          onFocusHandled={onFocusHandled}
          onCancelTask={vi.fn()}
          onClearFinished={vi.fn()}
          onClose={vi.fn()}
        />
      )
      expect(onFocusHandled).toHaveBeenCalled()
    })
  })

  it('closes from the panel chrome', async () => {
    const onClose = vi.fn()
    render(<Panel state={stateWith([task()])} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  describe('elapsed time', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('advances while a task is running', async () => {
      const startedAt = Date.now()
      render(
        <Panel
          state={stateWith([
            task({ status: 'running', startedAt, endedAt: undefined }),
          ])}
        />
      )
      await userEvent.click(
        screen.getByRole('button', { name: /refactor the parser/ })
      )
      await act(async () => {
        vi.advanceTimersByTime(3_000)
      })
      expect(screen.getByText(/count=3/)).toBeInTheDocument()
    })
  })
})

describe('CoworkTasksChip', () => {
  it('stays hidden until the session has run something', () => {
    const { container } = render(
      <CoworkTasksChip totals={progressOf([])} open={false} onToggle={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('counts what is in flight, and announces the split', () => {
    render(
      <CoworkTasksChip
        totals={sessionTotals(
          stateWith([
            task({ id: 'a', status: 'running', endedAt: undefined }),
            task({ id: 'b', status: 'queued', endedAt: undefined }),
            task({ id: 'c', status: 'done' }),
          ]),
          SESSION
        )}
        open={false}
        onToggle={vi.fn()}
      />
    )
    const button = screen.getByRole('button')
    expect(within(button).getByText('2')).toBeInTheDocument()
    expect(button.getAttribute('aria-label')).toContain(
      'running=1 queued=1 finished=1'
    )
  })

  it('shows the same numbers the panel does', () => {
    // The whole point of the shared store: one count, two surfaces.
    const state = endWorkflow(
      stateWith([
        task({ id: 'a', status: 'done' }),
        task({ id: 'b', status: 'error' }),
      ]),
      WORKFLOW,
      T0 + 9
    )
    const totals = sessionTotals(state, SESSION)
    render(<CoworkTasksChip totals={totals} open onToggle={vi.fn()} />)
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain(
      'finished=2'
    )
    expect(sessionWorkflows(state, SESSION)[0].progress.finished).toBe(2)
  })
})

describe('what a screen reader hears', () => {
  it('reads every row’s status, which no other text carries', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            id: 'a',
            title: 'live',
            status: 'running',
            endedAt: undefined,
          }),
          task({ id: 'b', title: 'over', status: 'done' }),
          task({ id: 'c', title: 'broke', status: 'error' }),
          task({ id: 'd', title: 'stopped', status: 'cancelled' }),
          task({
            id: 'e',
            title: 'waiting',
            status: 'queued',
            endedAt: undefined,
          }),
        ])}
      />
    )
    await openWorkflow()
    for (const key of [
      'statusRunning',
      'statusDone',
      'statusError',
      'statusCancelled',
      'statusQueued',
    ]) {
      expect(
        screen.getAllByLabelText(`common:tasks.${key}`).length
      ).toBeGreaterThan(0)
    }
  })

  it('says whether a section is open', async () => {
    render(<Panel state={stateWith([task()])} />)
    const header = screen.getByRole('button', { name: /refactor the parser/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })

  it('gives each stop control a name that says what it stops', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            id: 'a',
            title: 'explorer',
            status: 'running',
            endedAt: undefined,
          }),
        ])}
      />
    )
    await openWorkflow()
    expect(
      screen.getByRole('button', {
        name: 'common:tasks.stopTask name=explorer',
      })
    ).toBeInTheDocument()
  })
})
