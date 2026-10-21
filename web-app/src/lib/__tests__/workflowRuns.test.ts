import { describe, expect, it, vi } from 'vitest'
import {
  MAX_ENTRY_CHARS,
  MAX_RUN_AGE_MS,
  MAX_RUN_FILES,
  WorkflowRunLog,
  briefHash,
  loadRun,
  openRunLog,
  pruneRuns,
  resolveResume,
  withRunLog,
  type RunIo,
} from '@/lib/workflowRuns'
import { parseTeamRequest, runTeam, type TaskResult, type TeamTask } from '@/lib/coworkTeam'
import { workflowToTeamInput } from '@/lib/coworkWorkflow'

vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => '' }) }) }))

function memoryIo(): RunIo & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    dir: '/data/workflow-runs',
    mkdir: async () => {},
    list: async () => [...files.keys()],
    read: async (p) => {
      const f = files.get(p)
      if (f === undefined) throw new Error('missing')
      return f
    },
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  }
}

const plan = (phases: unknown): TeamTask[] => {
  const input = workflowToTeamInput({ phases })
  if (typeof input === 'string') throw new Error(input)
  const tasks = parseTeamRequest(input)
  if (typeof tasks === 'string') throw new Error(tasks)
  return tasks
}

const phases = (b = 'fan b') => [
  { name: 'One', agents: [{ id: 'a', description: 'fan a' }, { id: 'b', description: b }, { id: 'c', description: 'fan c' }] },
  { name: 'Two', agents: [{ id: 'm', description: 'merge' }] },
]

/** Runs the workflow through a log, recording which agents really ran. */
async function run(
  io: RunIo,
  runId: string,
  defn: unknown[],
  resumeRunId?: string,
  fail: string[] = []
) {
  const log = await openRunLog('s1', runId, { phases: defn, resumeRunId }, io)
  const ran: string[] = []
  const outcome = await runTeam(plan(defn), {
    maxParallel: 1,
    runTask: withRunLog(log, async (t): Promise<TaskResult> => {
      ran.push(t.id)
      const ok = !fail.includes(t.id)
      return { taskId: t.id, ok, output: ok ? `out-${t.id}` : 'boom', producedBy: t.id }
    }),
  })
  await log.settled()
  return { ran, log, outcome }
}

describe('workflow resume', () => {
  it('replays everything from cache when nothing changed', async () => {
    const io = memoryIo()
    await run(io, 'r1', phases())
    const again = await run(io, 'r2', phases(), 'r1')
    expect(again.ran).toEqual([])
    expect(again.log.replayed).toBe(4)
    expect(again.log.summary()).toMatch(/4 agents returned saved results, 0 ran again/)
    expect(again.outcome.ok && again.outcome.report.allDone).toBe(true)
  })

  it('a failed agent and everything that starts after it runs again, even completed ones', async () => {
    const io = memoryIo()
    await run(io, 'r1', phases(), undefined, ['b'])
    const again = await run(io, 'r2', phases(), 'r1')
    // a is cached; b failed (never saved); c completed before but starts after b.
    expect(again.ran).toEqual(['b', 'c', 'm'])
    expect(again.log.replayed).toBe(1)
  })

  it('an edited brief reruns from there on, and a changed answer reaches downstream', async () => {
    const io = memoryIo()
    await run(io, 'r1', phases())
    const again = await run(io, 'r2', phases('fan b, differently'), 'r1')
    expect(again.ran).toEqual(['b', 'c', 'm'])
  })

  it('a record resumes in its own chat only, and says so when there is nothing', async () => {
    const io = memoryIo()
    await run(io, 'r1', phases())
    expect(await loadRun(io, 's2', 'r1')).toBeNull()
    const none = await resolveResume('s1', { resume_run_id: 'nope' }, io)
    expect(none).toMatchObject({ error: expect.stringMatching(/^nothing to resume/) })
    const ok = await resolveResume('s1', { resume_run_id: 'r1' }, io)
    expect(ok).toMatchObject({ input: { phases: phases() } })
    // phases given with the id replace the saved ones.
    const edited = await resolveResume('s1', { resume_run_id: 'r1', phases: [] }, io)
    expect(edited).toMatchObject({ input: { phases: [] } })
  })

  it('keeps no oversize result, no failure and no isolated agent', () => {
    const io = memoryIo()
    const log = new WorkflowRunLog(io, { sessionId: 's1', runId: 'x', phases: [] })
    const task = (id: string, extra: Partial<TeamTask> = {}): TeamTask => ({
      id, description: id, dependsOn: [], writes: [], ...extra,
    })
    log.save(task('big'), { ok: true, output: 'x'.repeat(MAX_ENTRY_CHARS + 1) })
    log.save(task('bad'), { ok: false, output: 'no' })
    log.save(task('iso', { isolate: true }), { ok: true, output: 'ok' })
    log.save(task('dest'), { ok: true, output: 'ok', destination: '/wt' })
    log.save(task('fine'), { ok: true, output: 'ok' })
    expect(Object.keys((log as unknown as { record: { entries: object } }).record.entries)).toEqual(['0:fine'])
  })

  it('hashes the whole brief, not only the id', () => {
    const t: TeamTask = { id: 'a', description: 'x', dependsOn: [], writes: [] }
    expect(briefHash(t)).toBe(briefHash({ ...t }))
    expect(briefHash(t)).not.toBe(briefHash({ ...t, description: 'y' }))
    expect(briefHash(t)).not.toBe(briefHash({ ...t, subagentName: 'r' }))
    expect(briefHash(t)).not.toBe(briefHash({ ...t, schema: { type: 'object' } }))
  })

  it('prunes by age and by count, leaving unrelated files alone', async () => {
    const io = memoryIo()
    const now = Date.now()
    io.files.set(`${io.dir}/${(now - MAX_RUN_AGE_MS - 1000).toString(36)}__s__old.json`, '{}')
    for (let i = 0; i < MAX_RUN_FILES + 2; i++) {
      io.files.set(`${io.dir}/${(now - i * 1000).toString(36)}__s__r${i}.json`, '{}')
    }
    io.files.set(`${io.dir}/notes.txt`, 'keep')
    await pruneRuns(io, now)
    expect(io.files.size).toBe(MAX_RUN_FILES + 1)
    expect(io.files.has(`${io.dir}/notes.txt`)).toBe(true)
  })

  it('a store that fails costs the resume, never the run', async () => {
    const io = memoryIo()
    io.write = async () => {
      throw new Error('disk full')
    }
    const r = await run(io, 'r1', phases())
    expect(r.outcome.ok && r.outcome.report.allDone).toBe(true)
  })
})
