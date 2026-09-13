import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ActivityTask } from '@/lib/coworkActivity'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const i18n = (await import('@/i18n/setup')).default
  return { useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => i18n.t(k, o) }) }
})

import { TeamMemberControls, teamControlFor } from '@/containers/CoworkTasksPanel'
import { TeamControl } from '@/lib/coworkTeamControl'
import { useTeamControls } from '@/hooks/useTeamControls'

const member = (over: Partial<ActivityTask> = {}): ActivityTask =>
  ({
    id: 's1:run1:call-team:review',
    callId: 'call-team:review',
    sessionId: 's1',
    workflowId: 'run1',
    parentTaskId: 'call-team',
    kind: 'agent',
    title: 'review',
    status: 'error',
    startedAt: 1,
    agentName: 'worker',
    description: 'review the change',
    ...over,
  }) as ActivityTask

beforeEach(() => {
  useTeamControls.setState({ controls: {} })
})

describe('team member controls (AH-111)', () => {
  it('reaches the running team of a failed member, and only that', () => {
    const control = new TeamControl()
    useTeamControls.getState().register('s1:run1:call-team', control)
    const byCall = new Map([['call-team', 's1:run1:call-team']])
    expect(teamControlFor(member(), byCall)).toBe(control)
    expect(teamControlFor(member({ status: 'running' }), byCall)).toBeUndefined()
    expect(teamControlFor(member({ parentTaskId: undefined }), byCall)).toBeUndefined()
    control.finished = true
    expect(teamControlFor(member(), byCall)).toBeUndefined()
  })

  it('restarts, replaces and finishes through the control', () => {
    const control = new TeamControl()
    render(<TeamMemberControls task={member()} control={control} />)

    fireEvent.click(screen.getByTestId('team-member-restart'))
    fireEvent.click(screen.getByTestId('team-member-replace-open'))
    fireEvent.change(screen.getByTestId('team-member-replace-brief'), { target: { value: 'review it against the spec' } })
    fireEvent.change(screen.getByTestId('team-member-replace-agent'), { target: { value: 'reviewer' } })
    fireEvent.click(screen.getByTestId('team-member-replace-submit'))
    fireEvent.click(screen.getByTestId('team-finish'))

    expect(control.take()).toEqual([
      { kind: 'restart', taskId: 'review' },
      { kind: 'replace', taskId: 'review', with: { description: 'review it against the spec', subagentName: 'reviewer' } },
      { kind: 'finish' },
    ])
    expect(screen.queryByTestId('team-member-replace-form')).toBeNull()
  })

  it('sends only what the replacement changed', () => {
    const control = new TeamControl()
    render(<TeamMemberControls task={member()} control={control} />)
    fireEvent.click(screen.getByTestId('team-member-replace-open'))
    fireEvent.change(screen.getByTestId('team-member-replace-agent'), { target: { value: 'reviewer' } })
    fireEvent.click(screen.getByTestId('team-member-replace-submit'))
    expect(control.take()).toEqual([{ kind: 'replace', taskId: 'review', with: { subagentName: 'reviewer' } }])
  })
})
