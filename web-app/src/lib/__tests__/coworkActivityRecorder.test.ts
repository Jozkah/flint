import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  lastUserQuestion,
  recordAgentDispatch,
  recordJobCollected,
  recordShellDispatch,
  recordShellOutcome,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import { emptyActivityState, sessionWorkflows } from '@/lib/coworkActivity'
import type { TodoList, TodoStatus } from '@/types/coworkSession'

const SESSION = 's-1'
const run: RunContext = {
  sessionId: SESSION,
  runId: 'run-1',
  title: 'refactor the parser',
  model: 'jan-nano-4b',
}

const store = () => useCoworkActivity.getState()

/** Put a todo list on the session the recorder will read. */
const withTodos = (todos: TodoList | undefined) => {
  useCoworkSessions.setState({
    sessions: [
      {
        id: SESSION,
        title: 'session',
        folder: null,
        turns: [],
        messages: [],
        todos,
        updated: 0,
      },
    ],
    currentId: SESSION,
  })
}

const list = (...phases: { name: string; statuses: TodoStatus[] }[]): TodoList => ({
  phases: phases.map((phase) => ({
    name: phase.name,
    tasks: phase.statuses.map((status) => ({ content: 'x', status })),
  })),
})

describe('recording a dispatch', () => {
  beforeEach(() => {
    useCoworkActivity.setState(emptyActivityState())
    withTodos(undefined)
  })

  it('creates the workflow on the first dispatch, not before', () => {
    // A run that dispatches nothing has no background activity, and a card for
    // it in the conversation would be noise.
    expect(sessionWorkflows(store(), SESSION)).toEqual([])

    recordAgentDispatch(run, { callId: 'call-1', agentName: 'explorer' })
    expect(sessionWorkflows(store(), SESSION)).toHaveLength(1)
  })

  it('keeps the metadata the dispatch carried', () => {
    recordAgentDispatch(run, {
      callId: 'call-1',
      agentName: 'explorer',
      description: 'map the lexer',
      model: 'jan-nano-4b',
    })
    expect(store().tasks['call-1']).toMatchObject({
      kind: 'agent',
      agentName: 'explorer',
      description: 'map the lexer',
      model: 'jan-nano-4b',
      // Dispatched, not started: the child is waiting for a slot.
      status: 'queued',
    })
  })

  it('anchors the workflow to the message its first dispatch landed under', () => {
    recordAgentDispatch(run, {
      callId: 'call-1',
      agentName: 'explorer',
      anchorMessageId: 'msg-3',
    })
    // A second dispatch under a later message must not move the card.
    recordAgentDispatch(run, {
      callId: 'call-2',
      agentName: 'verifier',
      anchorMessageId: 'msg-9',
    })
    expect(store().workflows['run-1'].anchorMessageId).toBe('msg-3')
  })

  it('files work under the phase the agent says it is in', () => {
    withTodos(
      list(
        { name: 'Scan', statuses: ['completed'] },
        { name: 'Fix', statuses: ['in_progress'] }
      )
    )
    recordAgentDispatch(run, { callId: 'call-1', agentName: 'explorer' })

    const view = sessionWorkflows(store(), SESSION)[0]
    expect(view.phases.map((p) => p.phase.name)).toEqual(['Fix'])
    expect(view.phases[0].tasks.map((t) => t.id)).toEqual(['call-1'])
  })

  it('leaves work unphased when no phase is in progress', () => {
    // Filed under a guess would be worse than filed nowhere.
    withTodos(list({ name: 'Scan', statuses: ['pending'] }))
    recordAgentDispatch(run, { callId: 'call-1', agentName: 'explorer' })
    expect(store().tasks['call-1'].phaseId).toBeUndefined()
  })

  it('records a shell command as running, with its command line', () => {
    recordShellDispatch(run, { callId: 'call-1', command: 'pnpm build' })
    expect(store().tasks['call-1']).toMatchObject({
      kind: 'shell',
      title: 'pnpm build',
      command: 'pnpm build',
      status: 'running',
    })
  })
})

describe('settling a shell command', () => {
  beforeEach(() => {
    useCoworkActivity.setState(emptyActivityState())
    withTodos(undefined)
    recordShellDispatch(run, { callId: 'call-1', command: 'pnpm build' })
  })

  it('finishes a command that returned its output', () => {
    recordShellOutcome('call-1', { output: 'built in 4.2s' })
    expect(store().tasks['call-1']).toMatchObject({
      status: 'done',
      output: 'built in 4.2s',
    })
  })

  it('marks a failed command failed', () => {
    recordShellOutcome('call-1', { output: 'exit 1', isError: true })
    expect(store().tasks['call-1'].status).toBe('error')
  })

  it('keeps a backgrounded command running, and records its job', () => {
    // The tool returned early; the shell is still going. Calling that "done"
    // is exactly the lie the job id exists to prevent.
    recordShellOutcome('call-1', {
      output:
        'Command exceeded 120s and is continuing in the background (job_id=bash-3).',
    })
    expect(store().tasks['call-1']).toMatchObject({
      status: 'running',
      jobId: 'bash-3',
    })
  })

  it('settles the original row when the agent collects the job', () => {
    recordShellOutcome('call-1', {
      output: 'continuing in the background (job_id=bash-3).',
    })
    recordJobCollected('bash-3', { output: 'built in 9m' })
    expect(store().tasks['call-1']).toMatchObject({
      status: 'done',
      output: 'built in 9m',
    })
  })

  it('ignores a collection for a job nothing here started', () => {
    expect(() =>
      recordJobCollected('bash-999', { output: 'from another session' })
    ).not.toThrow()
    expect(store().tasks['call-1'].status).toBe('running')
  })
})

describe('naming the run', () => {
  it('reads the question back when a turn is taken again', () => {
    // Regeneration sends no new text; without this the workflow would be
    // unnamed.
    expect(
      lastUserQuestion([
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
        { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'second' }] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any)
    ).toBe('second')
  })

  it('finds nothing in a conversation with no question in it', () => {
    expect(lastUserQuestion(undefined)).toBeUndefined()
    expect(lastUserQuestion([])).toBeUndefined()
    expect(
      lastUserQuestion([
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: '  ' }] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any)
    ).toBeUndefined()
  })
})
