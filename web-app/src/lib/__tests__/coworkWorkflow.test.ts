import { describe, expect, it } from 'vitest'
import {
  MAX_TEAM_TASKS,
  parseTeamRequest,
  runTeam,
  type TaskResult,
  type TeamTask,
} from '@/lib/coworkTeam'
import { workflowToTeamInput } from '@/lib/coworkWorkflow'

const plan = (phases: unknown) => {
  const input = workflowToTeamInput({ phases })
  if (typeof input === 'string') throw new Error(input)
  const tasks = parseTeamRequest(input)
  if (typeof tasks === 'string') throw new Error(tasks)
  return tasks
}

describe('workflow', () => {
  it('runs phases in order and feeds earlier answers forward', async () => {
    const tasks = plan([
      { name: 'Survey', agents: [{ id: 'a', description: 'look a' }, { id: 'b', description: 'look b' }] },
      { name: 'Merge', agents: [{ id: 'm', description: 'merge them' }] },
    ])
    const order: string[] = []
    const briefs: Record<string, string> = {}
    const outcome = await runTeam(tasks, {
      runTask: async (t: TeamTask): Promise<TaskResult> => {
        order.push(t.id)
        briefs[t.id] = t.description
        return { taskId: t.id, ok: true, output: `answer-${t.id}`, producedBy: t.id }
      },
    })
    expect(outcome.ok).toBe(true)
    expect(order.indexOf('m')).toBe(2)
    expect(briefs.a).toBe('look a')
    expect(briefs.m).toContain('answer-a')
    expect(briefs.m).toContain('answer-b')
    expect(briefs.m.endsWith('merge them')).toBe(true)
  })

  it('names a failed earlier answer instead of hiding it', async () => {
    const tasks = plan([
      { agents: [{ id: 'a', description: 'x' }] },
      { agents: [{ id: 'z', description: 'y' }] },
    ])
    const ran: string[] = []
    await runTeam(tasks, {
      runTask: async (t) => {
        ran.push(t.id)
        return { taskId: t.id, ok: false, output: 'boom', producedBy: t.id }
      },
    })
    expect(ran).toEqual(['a']) // dependent phase blocked, never fabricated
  })

  it.each([
    [undefined, 'phases'],
    [[], 'phases'],
    [[{ agents: [] }], 'phases[0].agents'],
    [[{ agents: [{ description: ' ' }] }], 'phases[0].agents[0].description'],
    [
      [{ agents: [{ id: 'x', description: 'a' }] }, { agents: [{ id: 'x', description: 'b' }] }],
      "phases[1].agents[0].id 'x'",
    ],
  ])('refuses bad input %#', (phases, field) => {
    const out = workflowToTeamInput({ phases })
    expect(typeof out).toBe('string')
    expect(out).toContain(field)
  })

  it('refuses more agents than a team holds', () => {
    const agents = Array.from({ length: MAX_TEAM_TASKS + 1 }, (_, i) => ({ description: `d${i}` }))
    expect(workflowToTeamInput({ phases: [{ agents }] })).toContain(`${MAX_TEAM_TASKS}`)
  })

  it('stamps each task with its phase name and order', () => {
    const tasks = plan([
      { name: 'Survey', agents: [{ id: 'a', description: 'x' }] },
      { agents: [{ id: 'm', description: 'y' }] },
    ])
    expect(tasks.find((t) => t.id === 'a')?.phase).toEqual({ name: 'Survey', index: 0 })
    expect(tasks.find((t) => t.id === 'm')?.phase).toEqual({ name: 'Phase 2', index: 1 })
  })
})
