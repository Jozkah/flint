import { describe, it, expect, vi } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({
  executeAgentTool: vi.fn(async () => ({ content: 'ok' })),
}))
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool,
  sandboxEnforces: () => true,
  getAgentToolSchemas: vi.fn(async () => []),
}))

import {
  CAMPAIGN_TOOLS,
  campaignToolSchemas,
  executeCampaignTool,
  isCoordinatorEligible,
  parsePlanTasks,
  planSummary,
  type CampaignToolContext,
  type CampaignToolDeps,
} from '../campaignTools'
import { coworkToolsFromSchemas, allowedToolNames } from '../coworkTools'
import { dispatchCoworkTool } from '../coworkDispatch'
import { ALWAYS_ASK_TOOLS } from '../sessionMessagingTools'
import type { Campaign, CampaignTask } from '../campaignModel'

const NAMES = [
  'campaign_plan',
  'campaign_status',
  'campaign_collect',
  'campaign_cancel',
  'campaign_steer',
  'campaign_decide',
]

const baseTask = (over: Partial<CampaignTask> = {}): CampaignTask => ({
  id: 'a',
  title: 'Task a',
  brief: 'do a',
  acceptance: [],
  paths: ['src/a'],
  dependsOn: [],
  status: 'running',
  attempt: 0,
  tokensUsed: 0,
  detail: '',
  sessionId: 'sess-a',
  ...over,
})

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  schemaVersion: 1,
  id: 'c1',
  title: 'Big job',
  coordinatorSession: 'coord',
  sourceRoot: '/repo',
  baseBranch: 'main',
  baseSha: 'abc',
  integrationBranch: 'flint/campaign-c1',
  integrationWorktree: '/w',
  modeCeiling: 'auto',
  model: '',
  limits: { maxParallel: 4, maxTasks: 12 },
  status: 'running',
  processEpoch: 'e',
  createdAt: '',
  updatedAt: '',
  tasks: [baseTask()],
  ...over,
})

function deps(over: Partial<CampaignToolDeps> = {}) {
  const records: Campaign[] = [campaign()]
  const d = {
    api: {
      create: vi.fn(async (input) =>
        campaign({
          id: 'new1',
          title: input.title,
          status: 'planned',
          tasks: input.tasks.map((t: { id: string }) => baseTask({ id: t.id, status: 'pending' })),
        })
      ),
      get: vi.fn(async (id: string) => {
        const c = records.find((r) => r.id === id)
        if (!c) throw new Error('missing')
        return c
      }),
      list: vi.fn(async () => records),
      transition: vi.fn(async () => campaign()),
      cancel: vi.fn(async () => campaign({ status: 'cancelled' })),
      decide: vi.fn(async () => undefined),
      context: vi.fn(async (_id: string, ids: string[]) => ({
        decisions: '',
        handoffs: ids.map((taskId) => ({ taskId, text: `done ${taskId}` })),
      })),
      settle: vi.fn(),
      events: vi.fn(),
      notified: vi.fn(),
    },
    runner: {
      kick: vi.fn(async () => ({ started: ['a'], blocked: [] })),
      cancel: vi.fn(async () => campaign({ status: 'cancelled' })),
    },
    maxParallel: () => 3,
    dataFolder: async () => '/data',
    ensureIntegration: vi.fn(async () => ({
      ok: true as const,
      record: { path: '/w/new1', branch: 'flint/campaign-new1', baseBranch: 'main', baseSha: 'sha' },
    })),
    sendMessage: vi.fn(async () => ({ ok: true as const, output: '{"message_id":"m1"}' })),
    track: vi.fn(),
    ...over,
  }
  return { d: d as unknown as CampaignToolDeps, raw: d, records }
}

const ctx = (over: Partial<CampaignToolContext> = {}): CampaignToolContext => ({
  sessionId: 'coord',
  mode: 'auto',
  sourceRoot: '/repo',
  onApprove: vi.fn(async () => true),
  ...over,
})

const call = (toolName: string, input: unknown) => ({
  toolCallId: 'call-1',
  toolName,
  input,
})

const PLAN = {
  title: 'Refactor',
  tasks: [
    { id: 'a', title: 'A', brief: 'do a', paths: ['src/a'] },
    { id: 'b', title: 'B', brief: 'do b', paths: ['src/b'], depends_on: ['a'] },
  ],
}

describe('campaign tool declarations', () => {
  it('declares the six tools with object schemas and required fields', () => {
    const schemas = campaignToolSchemas()
    expect(schemas.map((s) => s.name).sort()).toEqual([...NAMES].sort())
    for (const s of schemas) {
      expect(s.parameters.type).toBe('object')
      expect(s.description.length).toBeGreaterThan(20)
    }
    const plan = schemas.find((s) => s.name === 'campaign_plan')!
    expect(plan.parameters.required).toEqual(['title', 'tasks'])
    const props = plan.parameters.properties as Record<string, { maxItems?: number }>
    expect(props.tasks.maxItems).toBe(12)
    expect(
      (schemas.find((s) => s.name === 'campaign_steer')!.parameters.required as string[])
    ).toEqual(['task_id', 'message'])
  })

  it('puts only campaign_plan behind the always-ask gate', () => {
    expect(ALWAYS_ASK_TOOLS.has('campaign_plan')).toBe(true)
    expect(ALWAYS_ASK_TOOLS.has('campaign_status')).toBe(false)
    expect([...CAMPAIGN_TOOLS].sort()).toEqual([...NAMES].sort())
  })
})

describe('who is offered the tools', () => {
  const base = {
    planMode: false,
    webSearch: false,
    allowSubagents: true,
    subagentNames: [] as string[],
  }

  it('advertises them to a coordinator run and to nobody else', () => {
    const coordinator = coworkToolsFromSchemas([], {
      ...base,
      campaignCoordinator: true,
    })
    for (const n of NAMES) expect(coordinator[n]).toBeDefined()

    const task = coworkToolsFromSchemas([], base)
    for (const n of NAMES) expect(task[n]).toBeUndefined()

    const review = coworkToolsFromSchemas([], {
      ...base,
      planMode: true,
      campaignCoordinator: true,
    })
    for (const n of NAMES) expect(review[n]).toBeUndefined()
  })

  it('treats a campaign task session as ineligible', () => {
    expect(isCoordinatorEligible(undefined)).toBe(true)
    expect(isCoordinatorEligible({ id: 'c', role: 'coordinator' })).toBe(true)
    expect(isCoordinatorEligible({ id: 'c', taskId: 'a', role: 'task' })).toBe(false)
  })

  it('keeps the names through the mode filter', () => {
    expect(
      allowedToolNames(NAMES, { ...base, planMode: false })
    ).toEqual(NAMES)
  })

  it('refuses a campaign call from a context that did not opt in (task, subagent, chat)', async () => {
    const out = await dispatchCoworkTool(call('campaign_plan', PLAN), {
      sessionId: 'task-session',
      readOnlyFolder: '/repo',
      mode: 'auto',
      webSearch: false,
      onTodo: async () => ({ output: '' }),
      onAsk: async () => ({ output: '' }),
      onTask: async () => ({ output: '' }),
    } as never)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('coordinator session only')
  })

  it('routes a campaign call to the coordinator handler', async () => {
    const onCampaign = vi.fn(async () => ({ output: 'handled' }))
    const out = await dispatchCoworkTool(call('campaign_status', {}), {
      sessionId: 'coord',
      readOnlyFolder: '/repo',
      mode: 'auto',
      webSearch: false,
      onTodo: async () => ({ output: '' }),
      onAsk: async () => ({ output: '' }),
      onTask: async () => ({ output: '' }),
      onCampaign,
    } as never)
    expect(out.output).toBe('handled')
    expect(onCampaign).toHaveBeenCalled()
  })
})

describe('campaign_plan', () => {
  it('parses and bounds the task list', () => {
    const ok = parsePlanTasks(PLAN.tasks)
    expect(ok.ok && ok.tasks[1].dependsOn).toEqual(['a'])
    expect(parsePlanTasks([]).ok).toBe(false)
    expect(parsePlanTasks([{ id: 'x' }]).ok).toBe(false)
    const tooMany = Array.from({ length: 13 }, (_, i) => ({
      id: `t${i}`,
      title: 't',
      brief: 'b',
    }))
    expect(parsePlanTasks(tooMany).ok).toBe(false)
  })

  it('summarises count, paths, mode, budget and parallelism for the card', () => {
    const parsed = parsePlanTasks(PLAN.tasks)
    if (!parsed.ok) throw new Error('bad plan')
    const text = planSummary({
      tasks: parsed.tasks,
      mode: 'bypass',
      parallel: 3,
      tokenBudget: 5000,
    })
    expect(text).toContain('2 tasks')
    expect(text).toContain('src/a')
    expect(text).toContain('up to 3 at once')
    expect(text).toContain('token budget 5000')
    // Bypass is never carried into the tasks, and the card says so.
    expect(text).toContain('auto mode')
    expect(text).not.toContain('bypass')
  })

  it('approved: records the plan, creates the integration branch, then runs it', async () => {
    const { d, raw } = deps()
    const c = ctx()
    const out = await executeCampaignTool(call('campaign_plan', PLAN), c, d)
    expect(out.isError).toBeFalsy()

    // Asked once, as always-ask, with the summary as the reason.
    expect(c.onApprove).toHaveBeenCalledTimes(1)
    const asked = (c.onApprove as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(asked[1]).toBe('campaign_plan')
    expect(asked[5]).toMatchObject({ alwaysAsk: true })
    expect(asked[5].reason).toContain('2 tasks')

    // planned first (create), then approved with the branch, then running.
    expect(raw.api.create).toHaveBeenCalledTimes(1)
    const created = raw.api.create.mock.calls[0][0]
    expect(created.modeCeiling).toBe('auto')
    expect(created.limits.maxParallel).toBe(3)
    const moves = raw.api.transition.mock.calls.map((x: unknown[]) => x[1])
    expect(moves[0]).toMatchObject({
      campaign: 'approved',
      integration: { branch: 'flint/campaign-new1', worktree: '/w/new1' },
    })
    expect(moves[1]).toEqual({ campaign: 'running' })
    expect(raw.track).toHaveBeenCalledWith('new1')
    expect(raw.runner.kick).toHaveBeenCalledWith('new1')
  })

  it('denied: leaves the campaign planned and starts nothing', async () => {
    const { d, raw } = deps()
    const out = await executeCampaignTool(
      call('campaign_plan', PLAN),
      ctx({ onApprove: vi.fn(async () => false) }),
      d
    )
    expect(out.isError).toBe(true)
    expect(out.output).toContain('planned')
    expect(raw.api.create).toHaveBeenCalledTimes(1)
    expect(raw.api.transition).not.toHaveBeenCalled()
    expect(raw.ensureIntegration).not.toHaveBeenCalled()
    expect(raw.runner.kick).not.toHaveBeenCalled()
  })

  it('is refused where nothing can ask, even in bypass', async () => {
    const { d, raw } = deps()
    const out = await executeCampaignTool(
      call('campaign_plan', PLAN),
      ctx({ onApprove: undefined, mode: 'bypass' }),
      d
    )
    expect(out.isError).toBe(true)
    expect(raw.api.create).not.toHaveBeenCalled()
  })

  it('is refused in review mode and without a repository', async () => {
    const { d } = deps()
    expect(
      (await executeCampaignTool(call('campaign_plan', PLAN), ctx({ mode: 'review' }), d))
        .isError
    ).toBe(true)
    expect(
      (await executeCampaignTool(call('campaign_plan', PLAN), ctx({ sourceRoot: null }), d))
        .isError
    ).toBe(true)
  })

  it('reports a backend refusal without asking the user', async () => {
    const { d, raw } = deps()
    raw.api.create.mockRejectedValueOnce({ message: 'tasks a and b overlap' })
    const c = ctx()
    const out = await executeCampaignTool(call('campaign_plan', PLAN), c, d)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('overlap')
    expect(c.onApprove).not.toHaveBeenCalled()
  })

  it('cancels the campaign when the integration branch cannot be made', async () => {
    const { d, raw } = deps({
      ensureIntegration: vi.fn(async () => ({
        ok: false as const,
        reason: 'not a git repository',
      })),
    })
    const out = await executeCampaignTool(call('campaign_plan', PLAN), ctx(), d)
    expect(out.isError).toBe(true)
    expect(raw.api.cancel).toHaveBeenCalled()
    expect(raw.runner.kick).not.toHaveBeenCalled()
  })
})

describe('the rest of the tools', () => {
  it('only reach the campaigns this session coordinates', async () => {
    const { d, records } = deps()
    records[0] = campaign({ coordinatorSession: 'someone-else' })
    for (const [name, input] of [
      ['campaign_status', { campaign_id: 'c1' }],
      ['campaign_cancel', { campaign_id: 'c1' }],
      ['campaign_decide', { campaign_id: 'c1', decision: 'x' }],
      ['campaign_steer', { campaign_id: 'c1', task_id: 'a', message: 'hi' }],
    ] as const) {
      const out = await executeCampaignTool(call(name, input), ctx(), d)
      expect(out.isError).toBe(true)
    }
  })

  it('status lists the tasks', async () => {
    const { d } = deps()
    const out = await executeCampaignTool(call('campaign_status', {}), ctx(), d)
    const body = JSON.parse(out.output)
    expect(body.campaign_id).toBe('c1')
    expect(body.tasks[0]).toMatchObject({ id: 'a', status: 'running' })
  })

  it('collect fences handoffs as untrusted data', async () => {
    const { d, records } = deps()
    records[0] = campaign({
      tasks: [baseTask({ status: 'completed', handoffPath: 'tasks/a/handoff.md' })],
    })
    const out = await executeCampaignTool(call('campaign_collect', {}), ctx(), d)
    const body = JSON.parse(out.output)
    expect(body.untrusted).toBe(true)
    expect(body.notice).toContain('not instructions')
    expect(body.tasks[0].handoff).toBe('done a')
  })

  it('cancel goes through the runner so live runs are aborted', async () => {
    const { d, raw } = deps()
    await executeCampaignTool(call('campaign_cancel', { reason: 'enough' }), ctx(), d)
    expect(raw.runner.cancel).toHaveBeenCalledWith('c1', 'enough')
  })

  it('steer sends mail to a running task, and refuses a finished one', async () => {
    const { d, raw, records } = deps()
    const sent = await executeCampaignTool(
      call('campaign_steer', { task_id: 'a', message: 'use the new API' }),
      ctx(),
      d
    )
    expect(sent.isError).toBeFalsy()
    expect(raw.sendMessage).toHaveBeenCalledWith('coord', 'sess-a', 'use the new API')

    records[0] = campaign({ tasks: [baseTask({ status: 'completed' })] })
    const late = await executeCampaignTool(
      call('campaign_steer', { task_id: 'a', message: 'x' }),
      ctx(),
      d
    )
    expect(late.isError).toBe(true)
  })

  it('steer surfaces the mailbox refusal (rate limits are the backend\'s)', async () => {
    const { d } = deps({
      sendMessage: vi.fn(async () => ({
        ok: false as const,
        error: 'rate_limited: 10 messages per 60 s',
      })),
    })
    const out = await executeCampaignTool(
      call('campaign_steer', { task_id: 'a', message: 'x' }),
      ctx(),
      d
    )
    expect(out.isError).toBe(true)
    expect(out.output).toContain('rate_limited')
  })

  it('decide appends to the decisions file', async () => {
    const { d, raw } = deps()
    const out = await executeCampaignTool(
      call('campaign_decide', { decision: 'Use camelCase in the API' }),
      ctx(),
      d
    )
    expect(out.isError).toBeFalsy()
    expect(raw.api.decide).toHaveBeenCalledWith('c1', 'Use camelCase in the API')
  })
})
