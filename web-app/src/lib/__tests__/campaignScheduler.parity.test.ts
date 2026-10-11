import { describe, it, expect } from 'vitest'
import fixtures from '../campaignScheduler.fixtures.json'
import {
  nextActions,
  type Campaign,
  type CampaignTaskStatus,
} from '../campaignModel'

type Case = {
  name: string
  status: Campaign['status']
  tokenBudget: number | null
  maxParallel: number
  live: {
    liveTasks: string[]
    freePanes: number | null
    liveTokens: Record<string, number>
  }
  tasks: {
    id: string
    status: CampaignTaskStatus
    dependsOn: string[]
    tokensUsed: number
    verifyTokens: number
  }[]
  expect: unknown[]
}

const build = (c: Case): Campaign => ({
  schemaVersion: 1,
  id: 'c',
  title: 't',
  coordinatorSession: 's',
  sourceRoot: '/r',
  baseBranch: 'main',
  baseSha: 'a',
  integrationBranch: 'flint/c',
  integrationWorktree: '/w',
  modeCeiling: 'ask',
  model: '',
  limits: { maxParallel: 4, maxTasks: 12, tokenBudget: c.tokenBudget },
  status: c.status,
  processEpoch: 'e',
  createdAt: '',
  updatedAt: '',
  tasks: c.tasks.map((t) => ({
    id: t.id,
    title: t.id,
    brief: t.id,
    acceptance: [],
    paths: [],
    dependsOn: t.dependsOn,
    status: t.status,
    attempt: 0,
    tokensUsed: t.tokensUsed,
    verifyTokens: t.verifyTokens,
    detail: '',
  })),
})

// The Rust scheduler runs the same file
// (campaign_scheduler::tests::the_shared_fixtures_decide_the_same_way).
describe('scheduler fallback parity with the Rust scheduler', () => {
  for (const c of fixtures as unknown as Case[]) {
    it(c.name, () => {
      const got = nextActions(
        build(c),
        {
          liveTasks: c.live.liveTasks,
          freePanes: c.live.freePanes ?? undefined,
          liveTokens: c.live.liveTokens,
        },
        c.maxParallel
      )
      expect(got).toEqual(c.expect)
    })
  }
})
