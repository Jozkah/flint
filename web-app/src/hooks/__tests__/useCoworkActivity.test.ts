import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkActivity } from '../useCoworkActivity'
import {
  emptyActivityState,
  sessionWorkflows,
  taskIdFor,
  type ActivityTask,
  type ActivityWorkflow,
} from '@/lib/coworkActivity'

const SESSION = 's-1'
const WORKFLOW = 'run-1'

const workflow = (over: Partial<ActivityWorkflow> = {}): ActivityWorkflow => ({
  id: WORKFLOW,
  sessionId: SESSION,
  title: 'refactor the parser',
  startedAt: Date.now(),
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
  status: 'running',
  startedAt: Date.now(),
})

const store = () => useCoworkActivity.getState()

/** The canonical id a call gets inside the default workflow. */
const idOf = (callId: string, sessionId = SESSION, workflowId = WORKFLOW) =>
  taskIdFor(sessionId, workflowId, callId)

describe('useCoworkActivity', () => {
  beforeEach(() => {
    useCoworkActivity.setState(emptyActivityState())
  })

  it('records a workflow, a phase and a task from the run driver', () => {
    store().beginWorkflow(workflow())
    const phaseId = store().notePhase(WORKFLOW, { name: 'Scan', index: 0 })
    expect(phaseId).toBeTruthy()
    store().beginTask(task({ phaseId }))

    const view = sessionWorkflows(store(), SESSION)[0]
    expect(view.workflow.title).toBe('refactor the parser')
    expect(view.phases[0].tasks.map((t) => t.callId)).toEqual(['call-1'])
  })

  it('returns the same phase id for a phase already recorded', () => {
    store().beginWorkflow(workflow())
    const first = store().notePhase(WORKFLOW, { name: 'Scan', index: 0 })
    const second = store().notePhase(WORKFLOW, { name: 'Scan', index: 0 })
    expect(second).toBe(first)
  })

  it('advances a task through its lifecycle', () => {
    store().beginWorkflow(workflow())
    store().beginTask(task({ status: 'queued', waiting: 2 }))
    store().patchTask(idOf('call-1'), { status: 'running', waiting: undefined })
    store().patchTask(idOf('call-1'), {
      status: 'done',
      endedAt: Date.now(),
      usage: { total_tokens: 900 },
    })

    const view = sessionWorkflows(store(), SESSION)[0]
    expect(view.status).toBe('done')
    expect(view.progress.tokens).toBe(900)
  })

  describe('recovery', () => {
    it('settles work the previous app run left in flight', () => {
      // The subagent's stream and the shell's process both died with the
      // process that owned them; reporting them running would be a lie nothing
      // could ever resolve.
      store().beginWorkflow(workflow())
      store().beginTask(task({ status: 'running' }))

      store().recoverOnLoad('interrupted:restart')

      expect(store().tasks[idOf('call-1')]).toMatchObject({
        status: 'cancelled',
        detail: 'interrupted:restart',
      })
    })

    it('leaves finished work exactly as the record had it', () => {
      store().beginWorkflow(workflow())
      store().beginTask(
        task({ status: 'done', endedAt: 42, output: 'the answer' })
      )
      store().recoverOnLoad('interrupted:restart')
      expect(store().tasks[idOf('call-1')]).toMatchObject({
        status: 'done',
        endedAt: 42,
        output: 'the answer',
      })
    })

    it('settles only the run asked for when a turn ends', () => {
      store().beginWorkflow(workflow())
      store().beginTask(task({ status: 'running' }))
      store().beginWorkflow(workflow({ id: 'run-2', sessionId: 's-2' }))
      store().beginTask(
        task({ id: 'call-2', sessionId: 's-2', workflowId: 'run-2' })
      )

      store().settleRun(WORKFLOW, 'interrupted:runEnd')

      expect(store().tasks[idOf('call-1')].status).toBe('cancelled')
      expect(store().tasks[idOf('call-2', 's-2', 'run-2')].status).toBe('running')
    })
  })

  describe('clearing and forgetting', () => {
    it('hides finished workflows but keeps the record', () => {
      store().beginWorkflow(workflow())
      store().beginTask(task({ status: 'done', endedAt: 1 }))
      store().finishWorkflow(WORKFLOW)

      store().clearFinished(SESSION)

      expect(sessionWorkflows(store(), SESSION)).toEqual([])
      expect(store().workflows[WORKFLOW]).toBeDefined()
    })

    it('drops everything belonging to a deleted session', () => {
      store().beginWorkflow(workflow())
      store().beginTask(task())
      store().dropSession(SESSION)
      expect(store().workflows).toEqual({})
      expect(store().tasks).toEqual({})
    })
  })

  describe('what is written to disk', () => {
    it('persists the record and none of the actions', () => {
      const options = useCoworkActivity.persist.getOptions()
      const partialize = options.partialize as (
        state: unknown
      ) => Record<string, unknown>

      store().beginWorkflow(workflow())
      store().beginTask(task())
      const persisted = partialize(store())

      expect(Object.keys(persisted).sort()).toEqual(['tasks', 'workflows'])
      expect(Object.values(persisted).every((v) => typeof v === 'object')).toBe(
        true
      )
    })

    it('waits to be hydrated explicitly, like the sessions store', () => {
      // `backendStorage` reaches the ServiceHub, which throws before init.
      expect(useCoworkActivity.persist.getOptions().skipHydration).toBe(true)
    })
  })

  describe('migrating a persisted record', () => {
    const migrate = (persisted: unknown, version: number) =>
      (
        useCoworkActivity.persist.getOptions().migrate as unknown as (
          p: unknown,
          v: number
        ) => { tasks: Record<string, ActivityTask> }
      )(persisted, version)

    /** A v1 blob: tasks keyed by the provider's raw call id, no `callId`. */
    const v1 = () => ({
      workflows: {
        'run-1': {
          id: 'run-1',
          sessionId: SESSION,
          title: 'a run',
          startedAt: 1,
          phases: [],
        },
      },
      tasks: {
        'call-1': {
          id: 'call-1',
          sessionId: SESSION,
          workflowId: 'run-1',
          kind: 'agent',
          title: 'explorer',
          status: 'done',
          startedAt: 1,
          endedAt: 2,
        },
        'call-2': {
          id: 'call-2',
          sessionId: SESSION,
          workflowId: 'run-1',
          parentTaskId: 'call-1',
          kind: 'agent',
          title: 'child',
          status: 'done',
          startedAt: 1,
          endedAt: 2,
        },
      },
    })

    it('re-keys tasks onto the canonical identity, keeping the call id', () => {
      const out = migrate(v1(), 1)
      expect(Object.keys(out.tasks).sort()).toEqual([
        idOf('call-1', SESSION, 'run-1'),
        idOf('call-2', SESSION, 'run-1'),
      ])
      expect(out.tasks[idOf('call-1', SESSION, 'run-1')].callId).toBe('call-1')
    })

    it('re-points a parent link that named the old key', () => {
      // The link would otherwise dangle, and the child would look top-level.
      const out = migrate(v1(), 1)
      expect(out.tasks[idOf('call-2', SESSION, 'run-1')].parentTaskId).toBe(
        idOf('call-1', SESSION, 'run-1')
      )
    })

    it('loses nothing else about a task', () => {
      const out = migrate(v1(), 1)
      expect(out.tasks[idOf('call-1', SESSION, 'run-1')]).toMatchObject({
        title: 'explorer',
        status: 'done',
        startedAt: 1,
        endedAt: 2,
      })
    })

    it('leaves an already-migrated record alone', () => {
      const already = {
        workflows: {},
        tasks: {
          [idOf('call-1')]: {
            id: idOf('call-1'),
            callId: 'call-1',
            sessionId: SESSION,
            workflowId: WORKFLOW,
            kind: 'agent',
            title: 'explorer',
            status: 'done',
            startedAt: 1,
          },
        },
      }
      expect(migrate(already, 2)).toBe(already)
    })

    it('survives a blob with no tasks at all', () => {
      expect(() => migrate({ workflows: {} }, 1)).not.toThrow()
      expect(() => migrate(undefined, 1)).not.toThrow()
    })
  })
})
