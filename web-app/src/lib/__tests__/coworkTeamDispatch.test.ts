import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tool } from 'ai'

/**
 * A team, driven through the machinery a run actually uses.
 *
 * The coordination module has its own tests, and they prove the graph rules
 * against a table. This proves the wiring: `runTeam` dispatching through the
 * real `runSubagent`, whose tool calls go through the real
 * `dispatchCoworkTool`, with only the model itself replaced. Everything between
 * the team request and the tool gate is the code that ships.
 *
 * That distinction matters because every bug this file has caught so far lived
 * in the seams — a signal not chained, an allowlist not intersected, a failure
 * that arrived as a resolved promise. None of those are visible from either
 * side on its own.
 */

const { streamText, convertToModelMessages } = vi.hoisted(() => ({
  streamText: vi.fn(),
  convertToModelMessages: vi.fn(async (m: unknown) => m),
}))
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  streamText,
  convertToModelMessages,
}))

const { executeAgentTool } = vi.hoisted(() => ({
  executeAgentTool: vi.fn(async () => ({ content: 'file contents' })),
}))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool,
  sandboxEnforces: () => true,
}))

import { runSubagent, parentToolNames } from '@/lib/coworkSubagent'
import { dispatchCoworkTool } from '@/lib/coworkDispatch'
import {
  runTeam,
  renderTeamReport,
  parseTeamRequest,
  refuseGraph,
  type TeamTask,
} from '@/lib/coworkTeam'
import {
  planDestinations,
  describeDestinations,
  type Destination,
  type DestinationDeps,
} from '@/lib/coworkTeamDestinations'
import type { PendingToolCall, ToolOutcome } from '@/lib/coworkRunner'

const chunkStream = (chunks: unknown[]) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

const textStep = (text: string) => [
  { type: 'text-delta', delta: text },
  { type: 'finish', messageMetadata: { usage: { totalTokens: 4 } } },
]

const toolStep = (id: string, name: string, input: unknown) => [
  { type: 'tool-input-start', toolCallId: id, toolName: name },
  { type: 'tool-input-available', toolCallId: id, toolName: name, input },
  { type: 'finish', messageMetadata: { usage: { totalTokens: 4 } } },
]

/**
 * A model that answers according to which child is asking.
 *
 * Keyed on the child's brief, because the children run concurrently and a
 * queue of scripted steps would hand them each other's answers.
 */
function modelSaying(byDescription: Record<string, unknown[][]>) {
  const progress = new Map<string, number>()
  streamText.mockImplementation((opts: { messages: unknown }) => {
    const messages = opts.messages as Array<{
      parts?: Array<{ text?: string }>
    }>
    const brief = messages?.[0]?.parts?.[0]?.text ?? ''
    const steps = byDescription[brief] ?? [textStep(`answered: ${brief}`)]
    const at = progress.get(brief) ?? 0
    progress.set(brief, at + 1)
    return { toUIMessageStream: () => chunkStream(steps[at] ?? []) }
  })
}

const parentTools = (): Record<string, Tool> =>
  Object.fromEntries(
    ['read', 'grep', 'write', 'task', 'team', 'ask', 'todo'].map((n) => [
      n,
      {} as Tool,
    ])
  )

/** The run's own dispatcher, as the route builds it for a child. */
const childDispatch =
  (over: Record<string, unknown> = {}) =>
  (call: PendingToolCall): Promise<ToolOutcome> =>
    dispatchCoworkTool(call, {
      sessionId: 's1',
      readOnlyFolder: '/repo',
      writeGrant: 'grant-run',
      mode: 'auto',
      webSearch: false,
      onTodo: async () => ({
        output: 'The todo list belongs to the agent that dispatched you.',
        isError: true,
      }),
      onAsk: async () => ({ output: 'You cannot ask.', isError: true }),
      onTask: async () => ({
        output: 'A subagent cannot dispatch subagents.',
        isError: true,
      }),
      ...over,
    } as never)

/**
 * Runs one task the way the route's `dispatchChild` does.
 *
 * Including the part that decides where the child writes: a destination
 * replaces the root, the grant and the owner id together, exactly as the route
 * passes them, because passing only some of them is how a child ends up
 * writing one place while being told about another.
 */
const runOne =
  (
    opts: {
      dispatch?: ReturnType<typeof childDispatch>
      byTask?: Map<string, Destination>
    } = {}
  ) =>
  async (task: TeamTask, signal: AbortSignal) => {
    const destination = opts.byTask?.get(task.id)
    const childFolder = destination?.path ?? '/repo'
    const dispatch =
      opts.dispatch ??
      childDispatch(
        destination
          ? {
              sessionId: destination.ownerId,
              readOnlyFolder: destination.path,
              writeGrant: destination.grantId,
            }
          : {}
      )
    const child = await runSubagent({
      resolved: {
        name: task.subagentName || 'worker',
        systemPrompt: 'You work.',
        allowedTools: null,
        model: null,
      },
      description: task.description,
      model: 'model-instance' as never,
      parentTools: parentTools(),
      system: {
        workspacePath: '/ws/s1',
        readOnlyFolder: childFolder,
        bashAvailable: true,
      },
      dispatch,
      signal,
      events: {
        onQueued: vi.fn(),
        onStart: vi.fn(),
        onInner: vi.fn(),
        onEnd: vi.fn(),
      },
    })
    return {
      taskId: task.id,
      ok: !child.isError,
      output: child.output,
      producedBy: task.id,
      ...(destination ? { destination: destination.path } : {}),
    }
  }

const task = (id: string, over: Partial<TeamTask> = {}): TeamTask => ({
  id,
  description: `brief for ${id}`,
  dependsOn: [],
  writes: [],
  ...over,
})

/**
 * The provisioning the route performs, with the backend replaced.
 *
 * Only the two calls that cross into Rust are faked — creating a worktree and
 * issuing its grant. Everything that decides *which* task gets *which* root,
 * and what happens when one cannot be made, is the code that ships.
 */
const planDeps = (over: Partial<DestinationDeps> = {}): DestinationDeps => ({
  parentSessionId: 's1',
  project: '/repo',
  dataFolder: '/data',
  canIsolate: true,
  ensure: async (owner: string) => ({
    ok: true as const,
    record: {
      path: `/data/worktrees/${owner}`,
      branch: `jan/cowork/${owner}`,
      baseSha: 'a'.repeat(40),
      uncommittedAtCreation: [],
    },
  }),
  authorize: async (owner: string) => ({
    ok: true as const,
    grant: { grantId: `grant-${owner}` },
  }),
  revoke: async () => true,
  ...over,
})

describe('a team, through the real dispatch path', () => {
  beforeEach(() => {
    streamText.mockReset()
    convertToModelMessages.mockClear()
    executeAgentTool.mockClear()
    executeAgentTool.mockResolvedValue({ content: 'file contents' })
  })

  it('runs every task and reports each child’s own answer', async () => {
    modelSaying({
      'brief for a': [textStep('a found the parser')],
      'brief for b': [textStep('b found the config')],
    })

    const outcome = await runTeam([task('a'), task('b')], {
      runTask: runOne(),
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.report.allDone).toBe(true)
    const rendered = renderTeamReport(outcome.report)
    expect(rendered).toContain('a found the parser')
    expect(rendered).toContain('b found the config')
  })

  it('gives each child only its own brief', async () => {
    // A child sees none of the conversation and none of its siblings' work.
    // If it did, the ordering guarantees would be doing nothing.
    modelSaying({})
    await runTeam([task('a'), task('b')], { runTask: runOne() })

    const briefs = streamText.mock.calls.map((call) => {
      const messages = call[0].messages as Array<{
        parts?: Array<{ text?: string }>
      }>
      return messages[0]?.parts?.[0]?.text
    })
    expect(briefs).toContain('brief for a')
    expect(briefs).toContain('brief for b')
    for (const brief of briefs) {
      expect(brief).not.toContain('brief for a\nbrief for b')
    }
  })

  it('starts a dependent only after its dependency has answered', async () => {
    const started: string[] = []
    modelSaying({})
    await runTeam([task('b', { dependsOn: ['a'] }), task('a')], {
      runTask: async (one, signal) => {
        started.push(one.id)
        return runOne()(one, signal)
      },
    })

    expect(started).toEqual(['a', 'b'])
  })

  it('lets a child use the run’s tools, through the run’s dispatcher', async () => {
    // The seam the whole wiring exists for: a team's children are this run's
    // children, so their tool calls go through the same gate.
    modelSaying({
      'brief for a': [
        toolStep('c1', 'read', { path: 'src/index.ts' }),
        textStep('read it'),
      ],
    })

    const outcome = await runTeam([task('a')], { runTask: runOne() })

    expect(executeAgentTool).toHaveBeenCalledWith(
      'read',
      { path: 'src/index.ts' },
      's1',
      expect.objectContaining({ readOnlyProject: '/repo', scope: 'session' })
    )
    expect(outcome.ok && outcome.report.allDone).toBe(true)
  })

  it('refuses a child that tries to dispatch a team of its own', async () => {
    // Depth is bounded by refusing the call by name, not only by withholding
    // the tool: a model can emit a call to something never advertised.
    modelSaying({
      'brief for a': [
        toolStep('c1', 'team', { tasks: [{ id: 'x', description: 'more' }] }),
        textStep('gave up on nesting'),
      ],
    })

    await runTeam([task('a')], { runTask: runOne() })

    const second = streamText.mock.calls[1][0].messages as Array<{
      parts?: Array<{ output?: unknown; type?: string }>
    }>
    const serialized = JSON.stringify(second)
    expect(serialized).toContain('cannot dispatch a team')
  })

  it('never advertises the parent-only tools to a child', async () => {
    modelSaying({})
    await runTeam([task('a')], { runTask: runOne() })

    const advertised = Object.keys(
      streamText.mock.calls[0][0].tools as Record<string, Tool>
    )
    expect(advertised).not.toContain('team')
    expect(advertised).not.toContain('task')
    expect(advertised).not.toContain('ask')
    expect(advertised).toContain('read')
  })

  it('does not let a child inherit the team tool', () => {
    // The depth cap. Resolution is shared with `task`, so a team cannot become
    // a way around the narrowing a saved definition performs — and `team`
    // itself is withheld like `task` is.
    const inherited = parentToolNames(parentTools())
    expect(inherited).not.toContain('team')
    expect(inherited).not.toContain('task')
    expect(inherited).toContain('read')
  })

  it('keeps a failed child failed, and does not run what waited on it', async () => {
    // A child fails the way a real one does: its stream reports an error.
    streamText.mockImplementation((opts: { messages: unknown }) => {
      const messages = opts.messages as Array<{
        parts?: Array<{ text?: string }>
      }>
      const brief = messages?.[0]?.parts?.[0]?.text ?? ''
      if (brief === 'brief for a') {
        return {
          toUIMessageStream: () =>
            chunkStream([{ type: 'error', errorText: 'the model refused' }]),
        }
      }
      return { toUIMessageStream: () => chunkStream(textStep(`did ${brief}`)) }
    })
    const outcome = await runTeam(
      [task('a'), task('b', { dependsOn: ['a'] }), task('c')],
      { runTask: runOne() }
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.report.failed.map((r) => r.taskId)).toEqual(['a'])
    expect(outcome.report.unfinished).toEqual(['b'])
    expect(outcome.report.completed.map((r) => r.taskId)).toEqual(['c'])
    expect(outcome.report.allDone).toBe(false)
    expect(renderTeamReport(outcome.report)).toContain('did not run: b')
  })

  it('stops its children when the team is cancelled', async () => {
    const control = new AbortController()
    modelSaying({})

    const outcome = await runTeam(
      [task('a'), task('b', { dependsOn: ['a'] })],
      {
        signal: control.signal,
        maxParallel: 1,
        runTask: async (one, signal) => {
          // The child's signal is the team's, chained: aborting here must reach
          // the run that is already in flight.
          control.abort()
          expect(signal.aborted).toBe(true)
          return runOne()(one, signal)
        },
      }
    )

    expect(outcome.ok && outcome.report.unfinished).toContain('b')
  })

  it('refuses a colliding graph before any child is started', async () => {
    modelSaying({})
    const outcome = await runTeam(
      [
        task('a', { writes: ['src/x.ts'] }),
        task('b', { writes: ['src/x.ts'] }),
      ],
      { runTask: runOne() }
    )

    expect(outcome.ok).toBe(false)
    // Nothing reached a model at all.
    expect(streamText).not.toHaveBeenCalled()
  })

  it('sends two isolated children to two different checkouts', async () => {
    // The claim this whole increment makes, proven where it matters: not that
    // the planner returns two paths, but that the two children's writes leave
    // through the real gate carrying two different roots, two different grants
    // and two different owners.
    modelSaying({
      'brief for a': [
        toolStep('c1', 'write', { path: 'out.ts', content: 'a' }),
        textStep('a wrote'),
      ],
      'brief for b': [
        toolStep('c2', 'write', { path: 'out.ts', content: 'b' }),
        textStep('b wrote'),
      ],
    })

    const plan = await planDestinations(
      [task('a', { isolate: true }), task('b', { isolate: true })],
      planDeps()
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const outcome = await runTeam(
      [task('a', { isolate: true }), task('b', { isolate: true })],
      { runTask: runOne({ byTask: plan.byTask }) }
    )
    expect(outcome.ok && outcome.report.allDone).toBe(true)

    const writes = executeAgentTool.mock.calls.filter(
      (call) => call[0] === 'write'
    )
    expect(writes).toHaveLength(2)
    const roots = writes.map(
      (call) => (call[3] as { readOnlyProject: string }).readOnlyProject
    )
    const grants = writes.map(
      (call) => (call[3] as { writeGrant: string }).writeGrant
    )
    const owners = writes.map((call) => call[2])
    expect(new Set(roots).size).toBe(2)
    expect(new Set(grants).size).toBe(2)
    expect(new Set(owners).size).toBe(2)
    // And neither of them is the run's own destination or its grant: two
    // children declaring the same file only stops colliding because they are
    // not writing the same tree.
    expect(roots).not.toContain('/repo')
    expect(grants).not.toContain('grant-run')
    expect(owners).not.toContain('s1')
  })

  it('leaves a task that did not ask for isolation in the run’s destination', async () => {
    modelSaying({
      'brief for a': [
        toolStep('c1', 'write', { path: 'a.ts', content: 'a' }),
        textStep('a wrote'),
      ],
      'brief for b': [
        toolStep('c2', 'write', { path: 'b.ts', content: 'b' }),
        textStep('b wrote'),
      ],
    })
    const tasks = [task('a', { isolate: true }), task('b')]
    const plan = await planDestinations(tasks, planDeps())
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const outcome = await runTeam(tasks, {
      runTask: runOne({ byTask: plan.byTask }),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const byRoot = new Map(
      executeAgentTool.mock.calls
        .filter((call) => call[0] === 'write')
        .map((call) => [
          (call[1] as { path: string }).path,
          (call[3] as { readOnlyProject: string }).readOnlyProject,
        ])
    )
    expect(byRoot.get('b.ts')).toBe('/repo')
    expect(byRoot.get('a.ts')).not.toBe('/repo')

    // And the report says which is which, so "completed" cannot be read as
    // "changed your folder" for the one that did not.
    const rendered = renderTeamReport(outcome.report)
    expect(rendered).toContain('own checkout')
    expect(describeDestinations(plan.byTask)).toContain(
      plan.byTask.get('a')!.path
    )
  })

  it('refuses the team before any child starts when isolation is impossible', async () => {
    modelSaying({})
    const tasks = [task('a', { isolate: true }), task('b')]
    const plan = await planDestinations(tasks, planDeps({ canIsolate: false }))

    expect(plan.ok).toBe(false)
    // The route returns the refusal without calling `runTeam`, so nothing
    // reached a model — including the task that could have run.
    expect(streamText).not.toHaveBeenCalled()
  })

  it('refuses a dependency on isolated work nothing downstream could see', async () => {
    // Not a scheduling problem: `b` would run, succeed, and be wrong, because
    // the changes it was told to build on are in a checkout it cannot reach.
    const refusal = refuseGraph([
      task('a', { isolate: true, writes: ['src/parser.ts'] }),
      task('b', { dependsOn: ['a'] }),
    ])
    expect(refusal).toContain('b waits on a')

    // Isolated but changing nothing is a perfectly good dependency.
    expect(
      refuseGraph([
        task('a', { isolate: true }),
        task('b', { dependsOn: ['a'] }),
      ])
    ).toBeNull()
  })

  it('hands back every child grant when the team is over', async () => {
    const revoke = vi.fn(async () => true)
    const tasks = [task('a', { isolate: true }), task('b', { isolate: true })]
    const plan = await planDestinations(tasks, planDeps({ revoke }))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    modelSaying({})
    const owners = [...plan.byTask.values()].map((one) => one.ownerId).sort()
    await runTeam(tasks, { runTask: runOne({ byTask: plan.byTask }) })
    await plan.release()

    // Authority does not outlive the work it was issued for.
    expect(revoke.mock.calls.map((call) => call[0]).sort()).toEqual(owners)
  })

  it('accepts the shape the tool actually advertises', async () => {
    // The bridge from what a model emits to what the orchestrator runs, so the
    // schema and the parser cannot drift apart unnoticed.
    const parsed = parseTeamRequest({
      tasks: [
        { id: 'a', description: 'read the parser', writes: ['a.ts'] },
        { id: 'b', description: 'update docs', depends_on: ['a'] },
      ],
    })
    expect(Array.isArray(parsed)).toBe(true)

    modelSaying({})
    const outcome = await runTeam(parsed as TeamTask[], {
      runTask: runOne(),
    })
    expect(outcome.ok && outcome.report.allDone).toBe(true)
  })
})
