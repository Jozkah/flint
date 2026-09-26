import { describe, it, expect, vi } from 'vitest'

// Nothing here may reach the backend: the estimate is pure construction.
const { getAgentToolSchemas } = vi.hoisted(() => ({
  getAgentToolSchemas: vi.fn(() => {
    throw new Error('the pre-run estimate must not fetch tool schemas')
  }),
}))
vi.mock('@/lib/agentTools', () => ({ getAgentToolSchemas }))

import { coworkPreRunContext } from '../coworkPreRun'
import { accountedTotal, type Measured } from '../coworkReadiness'
import { contextKey } from '@/containers/CoworkReadinessCard'

const schema = (name: string) => ({
  type: 'function' as const,
  function: {
    name,
    description: `${name} `.repeat(200),
    parameters: { type: 'object' },
  },
})

type Input = Parameters<typeof coworkPreRunContext>[0]

const input = (over: Partial<Input> = {}): Input => ({
  prompt: {
    workspacePath: '/ws',
    readOnlyFolder: '/repo',
    planMode: false,
    bashAvailable: true,
    subagentNames: [],
    webSearch: false,
  },
  tools: {
    planMode: false,
    webSearch: false,
    allowSubagents: true,
    subagentNames: [],
  },
  backendSchemas: null,
  messages: [],
  configuredContextTokens: 32768,
  ...over,
})

const tokens = (m: Measured): number => (m.known === false ? -1 : m.tokens)

describe('coworkPreRunContext', () => {
  it('measures the system prompt and the renderer-defined tools before a run', () => {
    const ctx = coworkPreRunContext(input())
    expect(tokens(ctx.categories.instructions)).toBeGreaterThan(100)
    // todo, ask, task and team are built without any I/O.
    expect(tokens(ctx.categories.tools)).toBeGreaterThan(0)
    expect(ctx.categories.conversation).toEqual({ known: true, tokens: 0 })
    expect(getAgentToolSchemas).not.toHaveBeenCalled()
  })

  it('counts project instructions in the instructions category', () => {
    const without = coworkPreRunContext(input())
    const withMd = coworkPreRunContext(
      input({
        prompt: {
          ...input().prompt,
          projectInstructions: 'Always run the tests. '.repeat(400),
        },
      })
    )
    expect(tokens(withMd.categories.instructions)).toBeGreaterThan(
      tokens(without.categories.instructions) + 1000
    )
  })

  it('labels the backend tool schemas as measured at first run when none are cached', () => {
    const ctx = coworkPreRunContext(input())
    expect(ctx.pending).toEqual(['tools'])
    const total = accountedTotal(ctx)
    expect(total.pending).toBe(true)
    expect(total.complete).toBe(false)
    expect(total.tokens).toBeGreaterThan(0)
    expect(contextKey(total)).toBe('common:readiness.tokensEstimatedAtFirstRun')
  })

  it('includes cached backend schemas and reports a complete estimate', () => {
    const bare = coworkPreRunContext(input())
    const ctx = coworkPreRunContext(
      input({ backendSchemas: [schema('read'), schema('write')] })
    )
    expect(ctx.pending).toBeUndefined()
    expect(tokens(ctx.categories.tools)).toBeGreaterThan(
      tokens(bare.categories.tools)
    )
    const total = accountedTotal(ctx)
    expect(total.complete).toBe(true)
    expect(contextKey(total)).toBe('common:readiness.tokensEstimated')
  })

  it('leaves the conversation unknown when the session already has history', () => {
    const ctx = coworkPreRunContext(
      input({ backendSchemas: [schema('read')], messages: null })
    )
    expect(ctx.categories.conversation).toEqual({ known: false })
    expect(contextKey(accountedTotal(ctx))).toBe(
      'common:readiness.tokensEstimatedPartial'
    )
  })
})
