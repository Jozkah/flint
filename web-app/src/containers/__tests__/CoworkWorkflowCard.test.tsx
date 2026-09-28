import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { CoworkWorkflowCard } from '../CoworkWorkflowCard'
import {
  emptyActivityState,
  startTask,
  startWorkflow,
  taskIdFor,
  updateTask,
  workflowView,
  type ActivityState,
  type ActivityTask,
} from '@/lib/coworkActivity'

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

const SESSION = 's-1'
const WORKFLOW = 'run-1'
const T0 = 1_700_000_000_000

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
  status: 'running',
  startedAt: T0,
})

/** The canonical id a call gets inside the default workflow. */
const idOf = (callId: string, sessionId = SESSION, workflowId = WORKFLOW) =>
  taskIdFor(sessionId, workflowId, callId)

const stateWith = (...tasks: ActivityTask[]): ActivityState =>
  tasks.reduce(
    (state, one) => startTask(state, one),
    startWorkflow(emptyActivityState(), {
      id: WORKFLOW,
      sessionId: SESSION,
      title: 'refactor the parser',
      startedAt: T0,
      phases: [],
    })
  )

function Card({
  state,
  now = T0 + 5_000,
  onOpenTask = vi.fn(),
  onOpenPanel = vi.fn(),
}: {
  state: ActivityState
  now?: number
  onOpenTask?: (task: ActivityTask) => void
  onOpenPanel?: (workflowId: string) => void
}) {
  return (
    <CoworkWorkflowCard
      view={workflowView(state, WORKFLOW)!}
      now={now}
      onOpenTask={onOpenTask}
      onOpenPanel={onOpenPanel}
    />
  )
}

describe('CoworkWorkflowCard', () => {
  it('names background activity without repeating the prompt', () => {
    render(
      <Card
        state={stateWith(
          task({ id: 'a', status: 'done', endedAt: T0 + 1 }),
          task({ id: 'b' })
        )}
      />
    )
    expect(screen.getByText('common:tasks.activityTitle')).toBeInTheDocument()
    expect(screen.queryByText('refactor the parser')).not.toBeInTheDocument()
    // While work is running the summary says how much is running; the
    // finished count returns once nothing is.
    expect(screen.getByText(/common:tasks.runningTasks count=1/)).toBeInTheDocument()
  })

  it('summarises time, tokens, running work and running tools on one line', () => {
    render(
      <Card
        state={stateWith(
          task({ id: 'a', status: 'done', endedAt: T0 + 1 }),
          task({ id: 'b', title: 'pnpm build', kind: 'shell' })
        )}
      />
    )
    const summary = screen.getByTestId('workflow-summary')
    expect(summary).toHaveTextContent(/common:tasks.runningTasks count=1/)
    expect(summary).toHaveTextContent('common:tasks.runningTools')
    expect(summary).toHaveTextContent('·')
  })

  it('lists each unit of work with its own status', () => {
    render(
      <Card
        state={stateWith(
          task({ id: 'a', title: 'explorer', status: 'done', endedAt: T0 + 1 }),
          task({ id: 'b', title: 'pnpm build', kind: 'shell' })
        )}
      />
    )
    expect(screen.getByText('explorer')).toBeInTheDocument()
    expect(screen.getByText('pnpm build')).toBeInTheDocument()
    expect(
      screen.getAllByLabelText('common:tasks.statusRunning').length
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByLabelText('common:tasks.statusDone').length
    ).toBeGreaterThan(0)
  })

  it('reflects a change in the shared state without a copy of its own', () => {
    // The card takes the view the store produced. Re-render with the next
    // state and the card is simply correct — which is what "live from the same
    // canonical state" has to mean.
    const before = stateWith(task({ id: 'a' }))
    const { rerender } = render(<Card state={before} />)
    expect(screen.getByText(/common:tasks.runningTasks count=1/)).toBeInTheDocument()

    const after = updateTask(before, idOf('a'), {
      status: 'done',
      endedAt: T0 + 2,
    })
    rerender(<Card state={after} />)
    expect(
      screen.getByText(/common:tasks.progress finished=1 total=1/)
    ).toBeInTheDocument()
  })

  it('reports progress on a bar screen readers can read', () => {
    render(
      <Card
        state={stateWith(
          task({ id: 'a', status: 'done', endedAt: T0 + 1 }),
          task({ id: 'b' })
        )}
      />
    )
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '1')
    expect(bar).toHaveAttribute('aria-valuemax', '2')
  })

  it('asks to reveal the task that was clicked', async () => {
    const onOpenTask = vi.fn()
    render(
      <Card
        state={stateWith(task({ id: 'call-9', title: 'explorer' }))}
        onOpenTask={onOpenTask}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /explorer/ }))
    expect(onOpenTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: idOf('call-9'), callId: 'call-9' })
    )
  })

  it('asks to open the panel on this workflow', async () => {
    const onOpenPanel = vi.fn()
    render(<Card state={stateWith(task())} onOpenPanel={onOpenPanel} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'common:tasks.openPanel' })
    )
    expect(onOpenPanel).toHaveBeenCalledWith(WORKFLOW)
  })

  it('stays intelligible before any child has been recorded', () => {
    // The workflow exists because a dispatch happened; its children land a
    // moment later, and an empty box would look broken.
    render(<Card state={stateWith()} />)
    expect(screen.getByTestId('workflow-card')).toBeInTheDocument()
    expect(screen.getByText('common:tasks.noOutput')).toBeInTheDocument()
  })

  it('counts a failure as finished, and says the workflow failed', () => {
    render(
      <Card
        state={stateWith(
          task({ id: 'a', status: 'error', endedAt: T0 + 1 }),
          task({ id: 'b', status: 'done', endedAt: T0 + 2 })
        )}
      />
    )
    expect(
      screen.getByText(/common:tasks.progress finished=2 total=2/)
    ).toBeInTheDocument()
    expect(
      screen.getAllByLabelText('common:tasks.statusError').length
    ).toBeGreaterThan(0)
  })

  it('shows a command that exited non-zero as an amber check failure', () => {
    render(
      <Card
        state={stateWith(
          task({
            id: 'a',
            kind: 'shell',
            title: 'pytest',
            status: 'error',
            exitCode: 1,
            output: 'FAILED test_rows\n[exit 1]',
            endedAt: T0 + 1,
          }),
          task({
            id: 'b',
            kind: 'shell',
            title: 'sleep 999',
            status: 'error',
            output: 'ERROR: command timed out after 60s and was terminated.',
            endedAt: T0 + 2,
          })
        )}
      />
    )
    // The check failure: amber, with its exit code.
    expect(
      screen.getByLabelText('common:tasks.statusCheckFailed code=1')
    ).toHaveClass('text-warning')
    expect(screen.getByText('common:tasks.exitCode code=1')).toBeInTheDocument()
    // The timeout stays a red error.
    expect(
      screen.getAllByLabelText('common:tasks.statusError').length
    ).toBeGreaterThan(0)
  })
})
