import { describe, expect, it } from 'vitest'
import { parseTeamRequest, runTeam, type TaskResult, type TeamTask } from '@/lib/coworkTeam'
import { workflowToTeamInput } from '@/lib/coworkWorkflow'
import { phaseSizes } from '@/lib/workflowLaunchGate'
import { checkSaysDone, wrapLoops } from '@/lib/workflowLoops'

const plan = (phases: unknown): TeamTask[] => {
  const input = workflowToTeamInput({ phases })
  if (typeof input === 'string') throw new Error(input)
  const tasks = parseTeamRequest(input)
  if (typeof tasks === 'string') throw new Error(tasks)
  return tasks
}

const loopPhases = (loop: Record<string, unknown> = { check: 'Are all errors fixed?' }) => [
  { name: 'Fix', agents: [{ id: 'f', description: 'fix errors' }], repeat_until: loop },
  { name: 'Report', agents: [{ id: 'r', description: 'report' }] },
]

/** Runs the loop; `check` answers per round, `agent` per round, in order. */
async function run(
  phases: unknown,
  answers: { agent?: (round: number) => string; check?: (round: number) => unknown } = {}
) {
  const ran: string[] = []
  const briefs: Record<string, string> = {}
  const outcome = await runTeam(plan(phases), {
    maxParallel: 1,
    runTask: wrapLoops(async (t): Promise<TaskResult> => {
      ran.push(t.id)
      briefs[t.id] = t.description
      const round = t.loop?.round ?? 1
      const output =
        t.loop?.kind === 'check'
          ? JSON.stringify(answers.check?.(round) ?? { done: false, reason: 'more' })
          : (answers.agent?.(round) ?? `fixed-${round}`)
      return { taskId: t.id, ok: true, output, producedBy: t.id }
    }),
  })
  return { ran, briefs, outcome }
}

describe('repeat_until', () => {
  it('expands into rounds with a check between them and a phase after', () => {
    const tasks = plan(loopPhases({ check: 'done?', max_rounds: 3 }))
    expect(tasks.map((t) => t.id)).toEqual(['f', 'p1~check1', 'f~r2', 'p1~check2', 'f~r3', 'r'])
    const round2 = tasks.find((t) => t.id === 'f~r2')
    expect(round2?.dependsOn).toEqual(['p1~check1'])
    expect(round2?.carry).toEqual(['f', 'p1~check1'])
    // The next phase waits on the last round only.
    expect(tasks.find((t) => t.id === 'r')?.dependsOn).toEqual(['f~r3'])
    expect(tasks.find((t) => t.id === 'p1~check1')?.schema).toMatchObject({ required: ['done', 'reason'] })
  })

  it('runs every round when the check never says done', async () => {
    const { ran, outcome } = await run(loopPhases({ check: 'done?', max_rounds: 3 }), {
      agent: (round) => `result-${round}`,
    })
    expect(ran).toEqual(['f', 'p1~check1', 'f~r2', 'p1~check2', 'f~r3', 'r'])
    expect(outcome.ok && outcome.report.allDone).toBe(true)
  })

  it('appends the previous round to the next round and stops when the check says done', async () => {
    const { ran, briefs, outcome } = await run(loopPhases({ check: 'done?', max_rounds: 4 }), {
      agent: (round) => `result-${round}`,
      check: (round) => ({ done: round === 2, reason: 'ok' }),
    })
    // Round 3 and 4 never ran; the report phase still ran.
    expect(ran).toEqual(['f', 'p1~check1', 'f~r2', 'p1~check2', 'r'])
    expect(briefs['f~r2']).toContain('result-1')
    expect(briefs['f~r2'].endsWith('fix errors')).toBe(true)
    // What follows carries the last round that really ran.
    expect(briefs.r).toContain('result-2')
    expect(briefs.r).not.toContain('result-1')
    expect(outcome.ok && outcome.report.allDone).toBe(true)
  })

  it('stops when two rounds in a row return identical results, without asking the check', async () => {
    const { ran, briefs } = await run(loopPhases({ check: 'done?', max_rounds: 5 }), {
      agent: (round) => (round >= 2 ? 'same' : 'different'),
    })
    // Round 3 matches round 2: its check is not run and rounds 4-5 are skipped.
    expect(ran).toEqual(['f', 'p1~check1', 'f~r2', 'p1~check2', 'f~r3', 'r'])
    expect(briefs.r).toContain('same')
  })

  it('keeps going on identical results when stop_when_no_progress is off', async () => {
    const { ran } = await run(loopPhases({ check: 'done?', max_rounds: 3, stop_when_no_progress: false }), {
      agent: () => 'same',
    })
    expect(ran).toEqual(['f', 'p1~check1', 'f~r2', 'p1~check2', 'f~r3', 'r'])
  })

  it('a check that returns nonsense is "not done"', () => {
    expect(checkSaysDone('{"done":true,"reason":"x"}')).toBe(true)
    expect(checkSaysDone('{"done":"yes"}')).toBe(false)
    expect(checkSaysDone('prose')).toBe(false)
  })

  it('names the field that is wrong', () => {
    const bad = (loop: unknown) => workflowToTeamInput({ phases: loopPhases(loop as never) })
    expect(bad({ check: '  ' })).toMatch(/repeat_until.check is empty/)
    expect(bad({ check: 'x', max_rounds: 6 })).toMatch(/max_rounds must be a whole number from 1 to 5/)
    expect(bad({ check: 'x', max_rounds: 1.5 })).toMatch(/max_rounds/)
    expect(bad({ check: 'x', stop_when_no_progress: 'yes' })).toMatch(/stop_when_no_progress/)
    expect(bad('again')).toMatch(/repeat_until must be an object/)
  })

  it('refuses an agent id that collides with a generated one', () => {
    const phases = [
      { agents: [{ id: 'f', description: 'a' }, { id: 'f~r2', description: 'b' }], repeat_until: { check: 'x' } },
    ]
    expect(workflowToTeamInput({ phases })).toMatch(/clashes/)
  })

  it('counts the declared agents against the team cap and the expansion against its own', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ description: `a${i}` }))
    expect(workflowToTeamInput({ phases: [{ agents: many(13) }] })).toMatch(/at most 12/)
    expect(workflowToTeamInput({ phases: [{ agents: many(12), repeat_until: { check: 'x', max_rounds: 5 } }] })).toMatch(
      /expand to 64 agent runs.*at most 40/
    )
    const ok = workflowToTeamInput({ phases: [{ agents: many(4), repeat_until: { check: 'x', max_rounds: 5 } }] })
    expect(ok).toMatchObject({ max_tasks: 40 })
    expect(plan([{ agents: many(4), repeat_until: { check: 'x', max_rounds: 5 } }])).toHaveLength(24)
  })

  it('asks for approval at the worst case', () => {
    expect(phaseSizes({ phases: loopPhases({ check: 'x', max_rounds: 5 }) })).toEqual([1 * 5 + 4, 1])
    expect(phaseSizes({ phases: loopPhases({ check: 'x' }) })).toEqual([1 * 3 + 2, 1])
  })
})
