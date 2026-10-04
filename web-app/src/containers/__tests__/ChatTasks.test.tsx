import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(' ')}` : key,
  }),
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))

import { ChatTasks } from '../ChatTasks'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { emptyActivityState, startTask, startWorkflow, taskIdFor } from '@/lib/coworkActivity'
import { registerSubagent } from '@/lib/coworkRunner'

const seed = (status: 'running' | 'done', sessionId = 'thread-1') => {
  const state = startTask(
    startWorkflow(emptyActivityState(), { id: 'run-1', sessionId, title: 'a chat turn', startedAt: 0, phases: [] }),
    {
      id: taskIdFor(sessionId, 'run-1', 'c1'),
      callId: 'c1',
      sessionId,
      workflowId: 'run-1',
      kind: 'agent',
      title: 'explorer',
      agentName: 'explorer',
      status,
      startedAt: Date.now() - 2000,
      ...(status === 'done' ? { endedAt: Date.now() } : {}),
    }
  )
  useCoworkActivity.setState({ workflows: state.workflows, tasks: state.tasks })
}

beforeEach(() => {
  useCoworkActivity.setState({ ...emptyActivityState() })
})

describe('ChatTasks', () => {
  it('is absent until the conversation has started something', () => {
    render(<ChatTasks threadId="thread-1" />)
    expect(screen.queryByTestId('chat-tasks')).toBeNull()
  })

  it('shows the Tasks chip with the count of running children', () => {
    seed('running')
    render(<ChatTasks threadId="thread-1" />)
    const chip = screen.getByRole('button', { name: /common:tasks.a11y/ })
    expect(chip).toHaveTextContent('1')
  })

  it('does not show another conversation’s children', () => {
    seed('running', 'other-thread')
    render(<ChatTasks threadId="thread-1" />)
    expect(screen.queryByTestId('chat-tasks')).toBeNull()
  })

  it('opens the same Tasks panel Cowork uses, with the child’s row and its Stop', async () => {
    seed('running')
    // The child is reachable, so the row offers Stop.
    registerSubagent('thread-1', taskIdFor('thread-1', 'run-1', 'c1'))
    render(<ChatTasks threadId="thread-1" />)
    await userEvent.click(screen.getByRole('button', { name: /common:tasks.a11y/ }))
    expect(await screen.findByText('a chat turn')).toBeInTheDocument()
  })
})
