/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { CoworkTasksPanel, FINISHED_PAGE } from '../CoworkTasksPanel'
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
  taskIdFor,
  type ActivityState,
  type ActivityTask,
  type ActivityWorkflow,
  type WorkflowView,
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

const task = (over: Partial<ActivityTask> = {}): ActivityTask => {
  const callId = over.callId ?? over.id ?? 'call-1'
  const sessionId = over.sessionId ?? SESSION
  const workflowId = over.workflowId ?? WORKFLOW
  return {
    ...shape(callId, sessionId, workflowId),
    ...over,
    callId,
    sessionId,
    workflowId,
    id: taskIdFor(sessionId, workflowId, callId),
  }
}

const shape = (
  callId: string,
  sessionId: string,
  workflowId: string
): ActivityTask => ({
  id: taskIdFor(sessionId, workflowId, callId),
  callId,
  sessionId,
  workflowId,
  kind: 'agent',
  title: 'researcher',
  status: 'done',
  startedAt: T0,
  endedAt: T0 + 4_000,
})

/** The canonical id a call gets inside the default workflow. */
const idOf = (callId: string, sessionId = SESSION, workflowId = WORKFLOW) =>
  taskIdFor(sessionId, workflowId, callId)

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
  onCancelWorkflow = vi.fn(),
  onClearFinished = vi.fn(),
  onClose = vi.fn(),
  agentReachable,
  focusTaskId,
  focusWorkflowId,
}: {
  state: ActivityState
  onCancelTask?: (task: ActivityTask) => Promise<void> | void
  onCancelWorkflow?: (view: WorkflowView) => Promise<void> | void
  onClearFinished?: () => void
  onClose?: () => void
  agentReachable?: (task: ActivityTask) => boolean
  focusTaskId?: string | null
  focusWorkflowId?: string | null
}) {
  return (
    <CoworkTasksPanel
      workflows={sessionWorkflows(state, SESSION)}
      totals={sessionTotals(state, SESSION)}
      focusTaskId={focusTaskId}
      focusWorkflowId={focusWorkflowId}
      agentReachable={agentReachable}
      onCancelTask={onCancelTask}
      onCancelWorkflow={onCancelWorkflow}
      onClearFinished={onClearFinished}
      onClose={onClose}
    />
  )
}

/** The header button of a workflow section — the one that expands it, not the
 * stop control beside it, which carries the same title. */
const workflowHeader = (title = 'refactor the parser') =>
  screen
    .getAllByRole('button', { name: new RegExp(title) })
    .find((button) => button.hasAttribute('aria-expanded'))!

/** Open a workflow section so its tasks render. Running work already opens
 * with its tasks showing, so it is only clicked when closed. */
const openWorkflow = async (title = 'refactor the parser') => {
  const header = workflowHeader(title)
  if (header.getAttribute('aria-expanded') !== 'true') {
    await userEvent.click(header)
  }
}

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
    // Not finished: a child is still running. The running section opens
    // with its tasks showing, so the child's own row says so too.
    expect(screen.getAllByTestId('task-status-running')[0]).toBeInTheDocument()
  })

  it('says a status in words, with running never in the accent', () => {
    render(
      <Panel
        state={stateWith([task({ id: 'b', status: 'running', endedAt: undefined })])}
      />
    )
    const status = screen.getAllByTestId('task-status-running')[0]
    expect(status).toHaveTextContent('common:tasks.statusRunning')
    expect(status).toHaveAttribute('data-state', 'running')
    expect(status.className).not.toMatch(/brand/)
  })

  it('says how many agents and commands a workflow has', () => {
    render(
      <Panel
        state={stateWith([
          task({ id: 'a' }),
          task({ id: 'b', kind: 'shell', title: 'pnpm test' }),
        ])}
      />
    )
    expect(screen.getByText('common:tasks.agentCount count=1')).toBeInTheDocument()
    expect(screen.getByText('common:tasks.shellCount count=1')).toBeInTheDocument()
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

  it('shows a subagent’s own stats and tool breakdown when opened', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
            transcript: [
              { role: 'assistant', content: 'on it' },
              { role: 'tool', name: 'read', content: '', toolState: 'succeeded' },
              { role: 'tool', name: 'read', content: '', toolState: 'succeeded' },
            ],
          }),
        ])}
      />
    )
    await openWorkflow()
    await userEvent.click(screen.getByRole('button', { name: /researcher/ }))
    const stats = screen.getByTestId('subagent-stats')
    expect(stats).toHaveTextContent('statInput tokens=')
    expect(stats).toHaveTextContent('statTurns count=1')
    expect(stats).toHaveTextContent('statTools count=2')
    expect(stats).not.toHaveTextContent('statApprox')
    expect(screen.getByTestId('transcript-tool-breakdown')).toHaveTextContent('read ×2')
  })

  it('marks tokens estimated when the provider reported none', async () => {
    render(
      <Panel
        state={stateWith([
          task({ transcript: [{ role: 'assistant', content: 'a'.repeat(400) }] }),
        ])}
      />
    )
    await openWorkflow()
    await userEvent.click(screen.getByRole('button', { name: /researcher/ }))
    expect(screen.getByTestId('subagent-stats')).toHaveTextContent('statApprox')
  })

  it('labels a child that ran out of steps distinctly, and a shortened result', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            status: 'error',
            stoppedAtLimit: true,
            resultCapped: true,
            output: 'partial',
          }),
        ])}
      />
    )
    await openWorkflow()
    expect(screen.getByTestId('task-limit-badge')).toHaveTextContent('common:tasks.limitBadge')
    await userEvent.click(screen.getByRole('button', { name: /researcher/ }))
    expect(screen.getByTestId('subagent-stopped-at-limit')).toBeInTheDocument()
    expect(screen.getByTestId('task-result-capped')).toBeInTheDocument()
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
        expect.objectContaining({ callId: 'a' })
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
    it('scrolls and focuses the revealed row before releasing the request', async () => {
      // The request used to be released synchronously, batching with the
      // expansion: the render that first created the target row already had
      // no focus target, so the ref was never attached and the frame found
      // nothing to scroll to.
      const scrollIntoView = vi.fn()
      Element.prototype.scrollIntoView = scrollIntoView
      const onFocusHandled = vi.fn()
      render(
        <CoworkTasksPanel
          workflows={sessionWorkflows(
            stateWith([task({ id: 'call-9', output: 'the answer' })]),
            SESSION
          )}
          totals={progressOf([])}
          focusTaskId={idOf('call-9')}
          onFocusHandled={onFocusHandled}
          onCancelTask={vi.fn()}
          onCancelWorkflow={vi.fn()}
          onClearFinished={vi.fn()}
          onClose={vi.fn()}
        />
      )
      await waitFor(() => expect(onFocusHandled).toHaveBeenCalled())
      expect(scrollIntoView).toHaveBeenCalled()
      expect(document.querySelector('[tabindex="-1"]')).not.toBeNull()
    })

    it('opens its workflow and expands it', async () => {
      const onFocusHandled = vi.fn()
      render(
        <CoworkTasksPanel
          workflows={sessionWorkflows(
            stateWith([task({ id: 'call-9', output: 'the answer' })]),
            SESSION
          )}
          totals={progressOf([])}
          focusTaskId={idOf('call-9')}
          onFocusHandled={onFocusHandled}
          onCancelTask={vi.fn()}
          onCancelWorkflow={vi.fn()}
          onClearFinished={vi.fn()}
          onClose={vi.fn()}
        />
      )
      // Expanded without a click: the workflow section and the task both open.
      expect(await screen.findByText('the answer')).toBeInTheDocument()
      // Released from inside the animation frame, once the row exists.
      await waitFor(() => expect(onFocusHandled).toHaveBeenCalled())
    })

    it('reports the request handled even when the task is gone', async () => {
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
          onCancelWorkflow={vi.fn()}
          onClearFinished={vi.fn()}
          onClose={vi.fn()}
        />
      )
      await waitFor(() => expect(onFocusHandled).toHaveBeenCalled())
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
      await openWorkflow()
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
          task({ id: 'f', title: 'cut off', status: 'interrupted' }),
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
      'statusInterrupted',
    ]) {
      expect(
        screen.getAllByLabelText(`common:tasks.${key}`).length
      ).toBeGreaterThan(0)
    }
  })

  it('says whether a section is open', async () => {
    render(<Panel state={stateWith([task()])} />)
    const header = workflowHeader()
    expect(header).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(header)
    expect(workflowHeader()).toHaveAttribute('aria-expanded', 'true')
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

describe('offering to stop only what can be stopped', () => {
  it('offers no control for a command still inside its tool call', () => {
    // No job id means the backend registered nothing to signal, and
    // `execute_tool` takes no cancellation token. A button here could only
    // ever report that it did nothing.
    render(
      <Panel
        state={stateWith([
          task({
            id: 'a',
            kind: 'shell',
            title: 'pnpm build',
            status: 'running',
            endedAt: undefined,
          }),
        ])}
      />
    )
    expect(
      screen.queryByRole('button', { name: /stopTask/ })
    ).toBeNull()
  })

  it('offers one once the command has a backend job', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            id: 'a',
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
    expect(
      screen.getByRole('button', { name: /stopTask name=pnpm build/ })
    ).toBeInTheDocument()
  })

  it('offers none for an agent the run can no longer reach', async () => {
    render(
      <Panel
        state={stateWith([
          task({ id: 'a', title: 'explorer', status: 'running', endedAt: undefined }),
        ])}
        agentReachable={() => false}
      />
    )
    await openWorkflow()
    expect(screen.queryByRole('button', { name: /stopTask/ })).toBeNull()
  })

  it('disables the control while a stop is in flight, and restores it if it failed', async () => {
    // A second click would signal a pid the first may already have reaped.
    let settle: () => void = () => {}
    const onCancelTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    render(
      <Panel
        state={stateWith([
          task({
            id: 'a',
            kind: 'shell',
            title: 'pnpm build',
            status: 'running',
            endedAt: undefined,
            jobId: 'bash-3',
          }),
        ])}
        onCancelTask={onCancelTask}
      />
    )
    await openWorkflow()
    const stop = screen.getByRole('button', { name: /stopTask/ })
    await userEvent.click(stop)
    expect(screen.getByRole('button', { name: /stopTask/ })).toBeDisabled()

    // The attempt failed, so the task is still there to stop.
    await act(async () => {
      settle()
    })
    expect(screen.getByRole('button', { name: /stopTask/ })).toBeEnabled()
    expect(onCancelTask).toHaveBeenCalledTimes(1)
  })
})

describe('stopping a whole workflow', () => {
  const live = (over: Partial<ActivityTask> = {}) =>
    task({ status: 'running', endedAt: undefined, ...over })

  it('offers a control while it has children that can be stopped', () => {
    render(<Panel state={stateWith([live({ id: 'a' })])} />)
    expect(
      screen.getByRole('button', {
        name: 'common:tasks.stopWorkflow name=refactor the parser',
      })
    ).toBeInTheDocument()
  })

  it('offers none once nothing is left to stop', () => {
    render(<Panel state={stateWith([task({ id: 'a', status: 'done' })])} />)
    expect(
      screen.queryByRole('button', { name: /stopWorkflow/ })
    ).toBeNull()
  })

  it('offers none when every remaining child is unreachable', () => {
    // A foreground command has nothing to signal; a control here would only
    // report that it did nothing.
    render(
      <Panel
        state={stateWith([live({ id: 'a', kind: 'shell', title: 'pnpm build' })])}
      />
    )
    expect(screen.queryByRole('button', { name: /stopWorkflow/ })).toBeNull()
  })

  it('asks to stop that workflow, and no other', async () => {
    const onCancelWorkflow = vi.fn()
    render(
      <Panel state={stateWith([live({ id: 'a' })])} onCancelWorkflow={onCancelWorkflow} />
    )
    await userEvent.click(
      screen.getByRole('button', { name: /stopWorkflow/ })
    )
    expect(onCancelWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: expect.objectContaining({ id: WORKFLOW }),
      })
    )
  })

  it('disables the control while the stop is in flight', async () => {
    let settle: () => void = () => {}
    const onCancelWorkflow = vi.fn(
      () => new Promise<void>((resolve) => { settle = resolve })
    )
    render(
      <Panel state={stateWith([live({ id: 'a' })])} onCancelWorkflow={onCancelWorkflow} />
    )
    await userEvent.click(screen.getByRole('button', { name: /stopWorkflow/ }))
    expect(screen.getByRole('button', { name: /stopWorkflow/ })).toBeDisabled()
    await act(async () => { settle() })
    expect(screen.getByRole('button', { name: /stopWorkflow/ })).toBeEnabled()
    expect(onCancelWorkflow).toHaveBeenCalledTimes(1)
  })
})

describe('Running and Finished sections', () => {
  /** A second workflow in the same session, with its own tasks. */
  const twoWorkflows = () => {
    let state = stateWith([
      task({ id: 'a', status: 'running', endedAt: undefined }),
    ])
    state = startWorkflow(
      state,
      workflow({ id: 'run-2', title: 'a finished run', startedAt: T0 - 10 })
    )
    state = startTask(
      state,
      task({ id: 'b', workflowId: 'run-2', status: 'done' })
    )
    return endWorkflow(state, 'run-2', T0 + 1)
  }

  it('puts live work under Running and the rest under Finished', () => {
    render(<Panel state={twoWorkflows()} />)
    expect(screen.getByText(/tasks.running count=1/)).toBeInTheDocument()
    expect(screen.getByText(/tasks.finished count=1/)).toBeInTheDocument()
  })

  it('keeps a workflow whose background command is still running under Running', () => {
    // Its model turn is over; the process is not.
    const state = endWorkflow(
      stateWith([
        task({
          id: 'a',
          kind: 'shell',
          status: 'running',
          endedAt: undefined,
          jobId: 'bash-3',
        }),
      ]),
      WORKFLOW,
      T0 + 1
    )
    render(<Panel state={state} />)
    expect(screen.getByText(/tasks.running count=1/)).toBeInTheDocument()
    expect(screen.queryByText(/tasks.finished count=/)).toBeNull()
  })

  it('shows a failed workflow under Finished, with its status', () => {
    const state = endWorkflow(
      stateWith([task({ id: 'a', status: 'error' })]),
      WORKFLOW,
      T0 + 1
    )
    render(<Panel state={state} />)
    expect(screen.getByText(/tasks.finished count=1/)).toBeInTheDocument()
    expect(
      screen.getAllByLabelText('common:tasks.statusError').length
    ).toBeGreaterThan(0)
  })

  it('shows a cancelled workflow under Finished, with its status', () => {
    const state = endWorkflow(
      stateWith([task({ id: 'a', status: 'cancelled' })]),
      WORKFLOW,
      T0 + 1
    )
    render(<Panel state={state} />)
    expect(screen.getByText(/tasks.finished count=1/)).toBeInTheDocument()
    expect(
      screen.getAllByLabelText('common:tasks.statusCancelled').length
    ).toBeGreaterThan(0)
  })

  it('collapses the Finished section without touching Running', async () => {
    render(<Panel state={twoWorkflows()} />)
    const toggle = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('tasks.finished'))!
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(toggle)
    expect(screen.queryByText('a finished run')).toBeNull()
    // The running workflow is untouched.
    expect(screen.getByText('refactor the parser')).toBeInTheDocument()
  })

  it('orders each section newest first', () => {
    let state = stateWith([task({ id: 'a', status: 'running', endedAt: undefined })])
    state = startWorkflow(
      state,
      workflow({ id: 'run-3', title: 'a later run', startedAt: T0 + 500 })
    )
    state = startTask(
      state,
      task({ id: 'c', workflowId: 'run-3', status: 'running', endedAt: undefined })
    )
    render(<Panel state={state} />)
    const titles = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-expanded') && b.textContent)
      .map((b) => b.textContent)
    expect(titles[0]).toContain('a later run')
  })

  it('offers Clear only alongside the Finished section', () => {
    render(
      <Panel
        state={stateWith([task({ id: 'a', status: 'running', endedAt: undefined })])}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'common:tasks.clearFinished' })
    ).toBeNull()
  })
})

describe('revealing the workflow the card pointed at', () => {
  // Finished, so both start closed: running work already opens with its
  // tasks showing, and would say nothing about which one the reveal chose.
  const twoLive = () => {
    let state = stateWith([task({ id: 'a', output: 'from one' })])
    state = startWorkflow(
      state,
      workflow({ id: 'run-2', title: 'the other run', startedAt: T0 + 5 })
    )
    return startTask(state, task({ id: 'b', workflowId: 'run-2' }))
  }

  it('expands the workflow asked for, and not the other', async () => {
    render(<Panel state={twoLive()} focusWorkflowId="run-2" />)
    // Its child is visible because the section opened; the other's is not.
    expect(await screen.findByText('researcher')).toBeInTheDocument()
    expect(
      workflowHeader('the other run').getAttribute('aria-expanded')
    ).toBe('true')
    expect(
      workflowHeader('refactor the parser').getAttribute('aria-expanded')
    ).toBe('false')
  })

  it('chooses by id, never by the title on screen', async () => {
    // Two runs of the same question carry the same title.
    let state = stateWith([task({ id: 'a' })])
    state = startWorkflow(
      state,
      workflow({ id: 'run-2', startedAt: T0 + 5 })
    )
    state = startTask(state, task({ id: 'b', workflowId: 'run-2' }))
    render(<Panel state={state} focusWorkflowId="run-2" />)

    const headers = screen
      .getAllByRole('button', { name: /refactor the parser/ })
      .filter((b) => b.hasAttribute('aria-expanded'))
    expect(headers.map((b) => b.getAttribute('aria-expanded'))).toEqual([
      'true',
      'false',
    ])
  })

  it('reports the request handled when the workflow is gone', async () => {
    const onFocusHandled = vi.fn()
    render(
      <CoworkTasksPanel
        workflows={[]}
        totals={progressOf([])}
        focusWorkflowId="run-missing"
        onFocusHandled={onFocusHandled}
        onCancelTask={vi.fn()}
        onCancelWorkflow={vi.fn()}
        onClearFinished={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalled())
  })
})

describe('what a background task row says', () => {
  it('names the kind in words, and the exit code of a finished command', async () => {
    render(
      <Panel
        state={stateWith([
          task({ id: 'a', kind: 'shell', title: 'pnpm build', status: 'error', exitCode: 2 }),
          task({ id: 'b', kind: 'agent', title: 'researcher', status: 'done' }),
        ])}
      />
    )
    await openWorkflow()
    expect(screen.getAllByText('common:tasks.kindShell').length).toBeGreaterThan(0)
    expect(screen.getAllByText('common:tasks.kindAgent').length).toBeGreaterThan(0)
    expect(screen.getByText(/tasks.exitCode code=2/)).toBeInTheDocument()
  })

  it('keeps a failed stop on the row until a stop succeeds', async () => {
    render(
      <Panel
        state={stateWith([
          task({
            id: 'a',
            kind: 'shell',
            status: 'running',
            endedAt: undefined,
            jobId: 'bash-1',
            cancelError: 'access denied',
          }),
        ])}
      />
    )
    await openWorkflow()
    expect(screen.getByRole('status')).toHaveTextContent(/stopFailedOnRow/)
    expect(screen.getByRole('status')).toHaveTextContent(/access denied/)
  })

  it('shows start and end times and offers to copy the whole output', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(
      <Panel
        state={stateWith([
          task({
            id: 'a',
            kind: 'shell',
            title: 'pnpm test',
            status: 'done',
            output: 'line one\nline two\n[exit 0]',
            outputTruncated: true,
          }),
        ])}
      />
    )
    await openWorkflow()
    await userEvent.click(screen.getByRole('button', { name: /pnpm test/ }))
    expect(screen.getByText(/tasks.startedAt/)).toBeInTheDocument()
    expect(screen.getByText(/tasks.finishedAt/)).toBeInTheDocument()
    expect(screen.getByText(/tasks.outputPartial/)).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('common:tasks.copyOutput'))
    expect(writeText).toHaveBeenCalledWith('line one\nline two\n[exit 0]')
  })

  it('renders a bounded page of finished workflows and grows on request', async () => {
    let state = emptyActivityState()
    for (let i = 0; i < FINISHED_PAGE + 30; i++) {
      state = startWorkflow(
        state,
        workflow({ id: `run-${i}`, title: `finished run ${i}`, startedAt: T0 + i, endedAt: T0 + i + 1 })
      )
      state = startTask(
        state,
        task({ id: `t-${i}`, workflowId: `run-${i}`, status: 'done' })
      )
    }
    render(<Panel state={state} />)
    const shown = () => screen.getAllByText(/^finished run \d+$/).length
    expect(shown()).toBe(FINISHED_PAGE)
    await userEvent.click(screen.getByText(/tasks.showMoreFinished count=30/))
    expect(shown()).toBe(FINISHED_PAGE + 30)
  })
})
