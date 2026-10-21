import { afterEach, describe, expect, it } from 'vitest'
import { runWorkflowControl } from '@/lib/workflowControl'
import { useTeamControls } from '@/hooks/useTeamControls'
import { TeamControl } from '@/lib/coworkTeamControl'

afterEach(() => useTeamControls.setState({ controls: {} }))

describe('workflow control operation', () => {
  it('reaches the live run by its task_id, in its own session only', () => {
    const control = new TeamControl()
    useTeamControls.getState().register('s1|run|call-9', control)
    expect(runWorkflowControl('s2', { run_id: 'call-9', action: 'pause' }).isError).toBe(true)
    expect(runWorkflowControl('s1', { run_id: 'call-9', action: 'pause' }).isError).toBeUndefined()
    runWorkflowControl('s1', { run_id: 'call-9', action: 'restart', agent_id: 'p1a2' })
    runWorkflowControl('s1', { run_id: 'call-9', action: 'resume' })
    expect(control.take()).toEqual([
      { kind: 'pause' },
      { kind: 'restart', taskId: 'p1a2' },
      { kind: 'resume' },
    ])
  })

  it('names what is wrong', () => {
    expect(runWorkflowControl('s1', { action: 'pause' }).output).toMatch(/run_id/)
    expect(runWorkflowControl('s1', { run_id: 'x', action: 'stop' }).output).toMatch(/action/)
    expect(runWorkflowControl('s1', { run_id: 'x', action: 'restart' }).output).toMatch(/agent_id/)
    expect(runWorkflowControl('s1', { run_id: 'x', action: 'pause' }).output).toMatch(/no running workflow/)
  })

  it('does not reach a run that already ended', () => {
    const control = new TeamControl()
    control.finished = true
    useTeamControls.getState().register('s1|run|c', control)
    expect(runWorkflowControl('s1', { run_id: 'c', action: 'pause' }).isError).toBe(true)
  })
})
