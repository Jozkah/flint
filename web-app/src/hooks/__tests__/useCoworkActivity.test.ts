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

const task = (over: Partial<ActivityTask> = {}): ActivityTask => ({
  id: 'call-1',
  sessionId: SESSION,
  workflowId: WORKFLOW,
  kind: 'agent',
  title: 'researcher',
  status: 'running',
  startedAt: Date.now(),
  ...over,
})

const store = () => useCoworkActivity.getState()

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
    expect(view.phases[0].tasks.map((t) => t.id)).toEqual(['call-1'])
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
    store().patchTask('call-1', { status: 'running', waiting: undefined })
    store().patchTask('call-1', {
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

      expect(store().tasks['call-1']).toMatchObject({
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
      expect(store().tasks['call-1']).toMatchObject({
        status: 'done',
        endedAt: 42,
        output: 'the answer',
      })
    })

    it('settles only the session asked for when a turn ends', () => {
      store().beginWorkflow(workflow())
      store().beginTask(task({ status: 'running' }))
      store().beginWorkflow(workflow({ id: 'run-2', sessionId: 's-2' }))
      store().beginTask(
        task({ id: 'call-2', sessionId: 's-2', workflowId: 'run-2' })
      )

      store().settleSession(SESSION, 'interrupted:runEnd')

      expect(store().tasks['call-1'].status).toBe('cancelled')
      expect(store().tasks['call-2'].status).toBe('running')
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
})
