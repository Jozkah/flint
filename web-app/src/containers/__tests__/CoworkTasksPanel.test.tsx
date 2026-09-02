/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { CoworkTasksPanel } from '../CoworkTasksPanel'
import { CoworkTasksChip } from '../CoworkTasksChip'
import { taskTotals, buildTaskList } from '@/lib/coworkTasks'
import type { CoworkTurn, SubagentRun } from '@/types/coworkSession'

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

const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
  runId: 'r1',
  name: 'researcher',
  status: 'done',
  startedAt: 1_000,
  endedAt: 4_000,
  turns: [],
  ...over,
})

const bashTurn = (over: Partial<CoworkTurn> = {}): CoworkTurn => ({
  role: 'tool',
  content: '',
  name: 'bash',
  callId: 'cmd-1',
  status: 'done',
  ...over,
})

describe('CoworkTasksPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says so when the session has run nothing', () => {
    render(<CoworkTasksPanel onClose={vi.fn()} />)
    expect(screen.getByText('common:tasks.empty')).toBeInTheDocument()
  })

  it('lists a running subagent with its tokens and tool count', () => {
    render(
      <CoworkTasksPanel
        liveSubagents={[
          run({
            runId: 'live',
            name: 'reviewer',
            status: 'running',
            endedAt: undefined,
            usage: { total_tokens: 2500 },
            turns: [bashTurn(), bashTurn({ callId: 'c2' })],
          }),
        ]}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('reviewer')).toBeInTheDocument()
    expect(screen.getByTestId('task-status-running')).toBeInTheDocument()
    expect(screen.getByText(/toolCalls.*count=2/)).toBeInTheDocument()
    // Twice on purpose: once on the row, once in the panel header's total.
    expect(screen.getAllByText(/tokens=2\.5k/)).toHaveLength(2)
  })

  it('shows a queued subagent with its place in the queue', () => {
    render(
      <CoworkTasksPanel
        liveSubagents={[
          run({ status: 'queued', waiting: 2, endedAt: undefined }),
        ]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('task-status-queued')).toBeInTheDocument()
    expect(screen.getByText(/queuePosition position=2/)).toBeInTheDocument()
  })

  it('separates finished work into its own collapsible section', async () => {
    const user = userEvent.setup()
    render(
      <CoworkTasksPanel
        sessionSubagents={[run({ runId: 'old', name: 'archivist' })]}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('archivist')).toBeInTheDocument()
    const header = screen.getByRole('button', { name: /tasks\.finished/ })
    expect(header).toHaveAttribute('aria-expanded', 'true')

    await user.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('archivist')).not.toBeInTheDocument()
  })

  it('lists shell commands, and flags one still running in the background', () => {
    render(
      <CoworkTasksPanel
        turns={[
          bashTurn({
            callId: 'a',
            args: { command: 'yarn test' },
            result: 'ok',
          }),
          bashTurn({
            callId: 'b',
            args: { command: 'cargo build' },
            result:
              'Command exceeded 30s and is continuing in the background (job_id=bash-3).',
          }),
        ]}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('yarn test')).toBeInTheDocument()
    expect(screen.getByText('cargo build')).toBeInTheDocument()
    // The backgrounded one is still running, and names its job.
    expect(screen.getByTestId('task-status-running')).toBeInTheDocument()
    expect(screen.getByText(/background jobId=bash-3/)).toBeInTheDocument()
  })

  it('expands a row to reveal its transcript and output', async () => {
    const user = userEvent.setup()
    render(
      <CoworkTasksPanel
        sessionSubagents={[
          run({
            name: 'digger',
            turns: [
              bashTurn({ args: { command: 'rg TODO' } }),
              { role: 'assistant', content: 'found three' },
            ],
            finalOutput: 'Three TODOs remain.',
          }),
        ]}
        onClose={vi.fn()}
      />
    )

    const row = screen.getByRole('button', { name: /digger/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Three TODOs remain.')).not.toBeInTheDocument()

    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Three TODOs remain.')).toBeInTheDocument()
    // Transcript lines are summarized, not dumped.
    expect(screen.getByText('rg TODO')).toBeInTheDocument()
    expect(screen.getByText('found three')).toBeInTheDocument()

    await user.click(row)
    expect(screen.queryByText('Three TODOs remain.')).not.toBeInTheDocument()
  })

  it('says when a finished task recorded no output', async () => {
    const user = userEvent.setup()
    render(
      <CoworkTasksPanel
        sessionSubagents={[run({ name: 'quiet', finalOutput: undefined })]}
        onClose={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /quiet/ }))
    expect(screen.getByText('common:tasks.noOutput')).toBeInTheDocument()
  })

  it('prefers the live copy of a run that is also committed', () => {
    render(
      <CoworkTasksPanel
        liveSubagents={[
          run({ runId: 'r1', status: 'running', endedAt: undefined }),
        ]}
        sessionSubagents={[run({ runId: 'r1', status: 'done' })]}
        onClose={vi.fn()}
      />
    )
    // One row, and it is the running one.
    expect(screen.getAllByText('researcher')).toHaveLength(1)
    expect(screen.getByTestId('task-status-running')).toBeInTheDocument()
  })

  it('shows one row for a command both the backend and the transcript know', async () => {
    render(
      <CoworkTasksPanel
        liveJobs={[
          {
            jobId: 'bash-4',
            command: 'cargo build',
            elapsedMs: 42_000,
            finished: false,
            callId: null,
          },
        ]}
        turns={[
          bashTurn({
            callId: 'c1',
            args: { command: 'cargo build' },
            result:
              'Command exceeded 30s and is continuing in the background (job_id=bash-4).',
          }),
        ]}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findAllByText('cargo build')).toHaveLength(1)
    expect(screen.getByTestId('task-status-running')).toBeInTheDocument()
  })

  it('lists a background job this session never dispatched', async () => {
    render(
      <CoworkTasksPanel
        liveJobs={[
          {
            jobId: 'bash-9',
            command: 'rustup update',
            elapsedMs: 1_000,
            finished: false,
            callId: null,
          },
        ]}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByText('rustup update')).toBeInTheDocument()
  })

  it('closes from the panel chrome', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<CoworkTasksPanel onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'common:close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('advances the elapsed time of a running task', () => {
    render(
      <CoworkTasksPanel
        liveSubagents={[
          run({
            status: 'running',
            startedAt: Date.now() - 5_000,
            endedAt: undefined,
          }),
        ]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(/duration\.seconds count=5/)).toBeInTheDocument()

    // The tick is a state update, so it has to be flushed inside act().
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByText(/duration\.seconds count=8/)).toBeInTheDocument()
  })
})

describe('CoworkTasksChip', () => {
  const totalsFor = (input: Parameters<typeof buildTaskList>[0]) =>
    taskTotals(buildTaskList(input))

  it('stays hidden until the session has run something', () => {
    const { container } = render(
      <CoworkTasksChip totals={totalsFor({})} open={false} onToggle={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('counts work in flight and announces the breakdown', () => {
    render(
      <CoworkTasksChip
        totals={totalsFor({
          liveSubagents: [
            run({ runId: 'a', status: 'running', endedAt: undefined }),
            run({
              runId: 'b',
              status: 'queued',
              waiting: 1,
              endedAt: undefined,
            }),
          ],
          sessionSubagents: [run({ runId: 'c', status: 'done' })],
        })}
        open={false}
        onToggle={vi.fn()}
      />
    )
    const chip = screen.getByRole('button')
    expect(within(chip).getByText('2')).toBeInTheDocument()
    expect(chip.getAttribute('aria-label')).toContain('running=1')
    expect(chip.getAttribute('aria-label')).toContain('finished=1')
  })

  it('falls back to the finished count once everything is done', () => {
    render(
      <CoworkTasksChip
        totals={totalsFor({ sessionSubagents: [run(), run({ runId: 'r2' })] })}
        open={false}
        onToggle={vi.fn()}
      />
    )
    expect(within(screen.getByRole('button')).getByText('2')).toBeInTheDocument()
  })

  it('toggles the rail', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <CoworkTasksChip
        totals={totalsFor({ sessionSubagents: [run()] })}
        open
        onToggle={onToggle}
      />
    )
    const chip = screen.getByRole('button')
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    await user.click(chip)
    expect(onToggle).toHaveBeenCalled()
  })
})
