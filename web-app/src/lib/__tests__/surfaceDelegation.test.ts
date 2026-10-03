import { describe, it, expect, vi, beforeEach } from 'vitest'

const { runSubagent, getAgentToolSchemas, executeAgentTool } = vi.hoisted(() => ({
  runSubagent: vi.fn(),
  getAgentToolSchemas: vi.fn(),
  executeAgentTool: vi.fn(),
}))
vi.mock('@/lib/agentTools', () => ({
  getAgentToolSchemas,
  executeAgentTool,
  previewAgentChange: vi.fn(async () => undefined),
  sandboxEnforces: () => true,
}))
vi.mock('@/lib/coworkSubagent', async (orig) => ({
  ...(await orig<typeof import('../coworkSubagent')>()),
  runSubagent,
}))
vi.mock('@/lib/coworkSubagentRegistry', () => ({
  listSubagents: vi.fn(async () => [
    { name: 'explorer', description: 'reads', system_prompt: 'You explore.', allowed_tools: ['read', 'grep'], model: null, scope: 'builtin' },
    { name: 'my-agent', description: 'mine', system_prompt: 'Mine.', allowed_tools: null, model: null, scope: 'user' },
  ]),
}))
vi.mock('@/lib/eventLog', () => ({ recordEvents: vi.fn() }))
vi.mock('@/lib/toolActivity', async (orig) => ({
  ...(await orig<typeof import('../toolActivity')>()),
  recordToolActivity: vi.fn(async () => {}),
  withToolActivity: async (_c: unknown, _x: unknown, _s: unknown, run: () => Promise<unknown>) => run(),
}))
vi.mock('@/hooks/useWebSearchConfig', () => ({
  useWebSearchConfig: { getState: () => ({ webSearchEnabled: false }) },
}))

import { createSurfaceDelegation, SURFACE_CHILD_MAX_STEPS, SURFACE_CHILD_TOOLS, SURFACE_DELEGATION_TOOL_NAMES } from '../surfaceDelegation'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { emptyActivityState, taskIdFor } from '../coworkActivity'
import { abortRun } from '../coworkRunner'
import type { SubagentEvents } from '../coworkSubagent'

const schema = (name: string) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object' } },
})

const spec = (over = {}) => ({
  id: 'thread-1',
  runId: () => 'chat:thread-1:7',
  title: 'My chat',
  folders: ['C:/repo'],
  model: () => ({}) as never,
  modelId: 'qwen',
  providerOptions: () => undefined,
  signal: new AbortController().signal,
  background: true,
  scope: 'thread' as const,
  ...over,
})

const call = (toolName: string, input: unknown, toolCallId = 'c1') => ({ toolCallId, toolName, input })
const task = (id: string) =>
  useCoworkActivity.getState().tasks[taskIdFor('thread-1', 'chat:thread-1:7', id)]

beforeEach(() => {
  runSubagent.mockReset()
  executeAgentTool.mockReset()
  getAgentToolSchemas.mockReset()
  getAgentToolSchemas.mockResolvedValue(
    ['read', 'ls', 'grep', 'write', 'bash', 'memory_write', 'git', 'request_access'].map(schema)
  )
  useCoworkActivity.setState({ ...emptyActivityState() })
  // No run is begun here: a chat has none, and the delegation must make its
  // own place for a child's Stop (a child cancelled at birth was the live bug).
  abortRun('thread-1')
})

describe('surface delegation (plain chat and Rooms)', () => {
  it('offers task and the three background tools, and only task without background', async () => {
    const full = await createSurfaceDelegation(spec())
    expect(Object.keys(full.tools).sort()).toEqual(['await_task', 'cancel_task', 'task', 'task_status'])
    const foreground = await createSurfaceDelegation(spec({ background: false }))
    expect(Object.keys(foreground.tools)).toEqual(['task'])
    expect(SURFACE_DELEGATION_TOOL_NAMES.has('task')).toBe(true)
  })

  it('does not mention team or isolate, which these surfaces cannot honour', async () => {
    const { tools } = await createSurfaceDelegation(spec())
    const description = (tools.task as { description: string }).description
    expect(description).not.toContain('`team`')
    expect(description).not.toContain('isolate')
    const props = ((tools.task as { inputSchema: { jsonSchema: { properties: object } } }).inputSchema.jsonSchema).properties
    expect(Object.keys(props)).not.toContain('isolate')
    expect(Object.keys(props)).toContain('background')
  })

  it('gives a child only the allowlisted built-ins, never memory, git or access requests', async () => {
    runSubagent.mockResolvedValue({ output: 'x', usage: null, sessionTokens: 0 })
    const d = await createSurfaceDelegation(spec())
    await d.run(call('task', { subagent_name: 'explorer', description: 'look' }))
    const given = Object.keys(runSubagent.mock.calls[0][0].parentTools)
    expect(given.sort()).toEqual(['bash', 'grep', 'ls', 'read', 'write'])
    for (const name of given) expect(SURFACE_CHILD_TOOLS).toContain(name)
  })

  it('runs a foreground task to its answer and records it on the conversation’s record', async () => {
    runSubagent.mockImplementation(async (opts: { events: SubagentEvents }) => {
      opts.events.onStart()
      opts.events.onEnd({ total_tokens: 50 })
      return { output: 'the answer', usage: null, sessionTokens: 0 }
    })
    const d = await createSurfaceDelegation(spec())
    const out = await d.run(call('task', { subagent_name: 'explorer', description: 'look' }))
    expect(out.output).toBe('the answer')
    expect(task('c1')).toMatchObject({ kind: 'agent', status: 'done', sessionId: 'thread-1', usage: { total_tokens: 50 } })
    expect(runSubagent.mock.calls[0][0].maxSteps).toBe(SURFACE_CHILD_MAX_STEPS)
  })

  it('starts a background child at once, and await_task collects it', async () => {
    let finish!: (v: unknown) => void
    runSubagent.mockImplementation(
      () => new Promise((resolve) => { finish = resolve })
    )
    const d = await createSurfaceDelegation(spec())
    const started = await d.run(call('task', { subagent_name: 'explorer', description: 'look', background: true }))
    expect(started.output).toContain('task_id=c1')
    expect(task('c1').background).toBe(true)
    expect(d.tasks.running()).toHaveLength(1)
    const waiting = d.run(call('await_task', { task_id: 'c1' }, 'c2'))
    finish({ output: 'later answer', usage: null, sessionTokens: 0 })
    expect((await waiting).output).toBe('later answer')
  })

  it('ignores background where it is not offered, running the child in the foreground', async () => {
    runSubagent.mockResolvedValue({ output: 'inline', usage: null, sessionTokens: 0 })
    const d = await createSurfaceDelegation(spec({ background: false }))
    const out = await d.run(call('task', { subagent_name: 'explorer', description: 'look', background: true }))
    expect(out.output).toBe('inline')
    const refused = await d.run(call('await_task', { task_id: 'c1' }, 'c2'))
    expect(refused.isError).toBe(true)
  })

  it('reports each finished child’s usage to a surface that keeps a budget', async () => {
    const onUsage = vi.fn()
    runSubagent.mockImplementation(async (opts: { events: SubagentEvents }) => {
      opts.events.onEnd({ total_tokens: 321 })
      return { output: 'x', usage: null, sessionTokens: 0 }
    })
    const d = await createSurfaceDelegation(spec({ onUsage }))
    await d.run(call('task', { subagent_name: 'explorer', description: 'look' }))
    expect(onUsage).toHaveBeenCalledWith({ total_tokens: 321 })
  })

  it('refuses a malformed request with a readable error', async () => {
    const d = await createSurfaceDelegation(spec())
    const out = await d.run(call('task', { description: 'no name' }))
    expect(out.isError).toBe(true)
    expect(out.output).toContain('subagent_name')
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it('gates the child’s own calls in Ask mode under the conversation, naming the child', async () => {
    // Drive the dispatcher the way the child would, through `setup().dispatch`.
    let dispatch!: (c: unknown, s: AbortSignal) => Promise<{ output: string; isError?: boolean }>
    runSubagent.mockImplementation(async (opts: { dispatch: typeof dispatch }) => {
      dispatch = opts.dispatch
      return { output: 'x', usage: null, sessionTokens: 0 }
    })
    executeAgentTool.mockResolvedValue({ content: 'file body' })
    const d = await createSurfaceDelegation(spec())
    await d.run(call('task', { subagent_name: 'explorer', description: 'look' }))
    // A read runs in the chat's own workspace namespace, with the folders read-only.
    const read = await dispatch({ toolCallId: 'k1', toolName: 'read', input: { path: 'a.ts' } }, new AbortController().signal)
    expect(read.output).toBe('file body')
    expect(executeAgentTool).toHaveBeenCalledWith(
      'read',
      { path: 'a.ts' },
      'thread-1',
      expect.objectContaining({ scope: 'thread', readOnlyProject: 'C:/repo' })
    )
    // A child never asks the user and never keeps the parent's todo list.
    for (const name of ['ask', 'todo']) {
      const refused = await dispatch({ toolCallId: `k-${name}`, toolName: name, input: {} }, new AbortController().signal)
      expect(refused.isError).toBe(true)
    }
  })

  it('stops a child through the same handle the panel uses', async () => {
    let gate!: (v: unknown) => void
    runSubagent.mockImplementation((opts: { signal: AbortSignal }) => new Promise((resolve) => {
      gate = resolve
      opts.signal.addEventListener('abort', () => resolve({ output: '(cancelled)', isError: true, usage: null, sessionTokens: 0 }))
    }))
    const d = await createSurfaceDelegation(spec())
    await d.run(call('task', { subagent_name: 'explorer', description: 'look', background: true }))
    const out = await d.run(call('cancel_task', { task_id: 'c1' }, 'c2'))
    expect(out.output).toContain('Cancelled c1')
    await d.tasks.settleAll()
    expect(task('c1').status).toBe('cancelled')
    void gate
    abortRun('thread-1')
  })

  it('does not start a child already cancelled, with no Cowork run behind it', async () => {
    runSubagent.mockImplementation(async (opts: { signal: AbortSignal }) => ({
      output: opts.signal.aborted ? '(cancelled at birth)' : 'ran',
      usage: null,
      sessionTokens: 0,
    }))
    const d = await createSurfaceDelegation(spec())
    const out = await d.run(call('task', { subagent_name: 'explorer', description: 'look' }))
    expect(out.output).toBe('ran')
    expect(task('c1').status).toBe('done')
  })
})
