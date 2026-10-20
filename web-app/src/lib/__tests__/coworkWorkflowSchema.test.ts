import { describe, expect, it } from 'vitest'
import {
  extractJson,
  runTyped,
  schemaProblem,
  validateAgainst,
} from '@/lib/coworkWorkflowSchema'
import { workflowToTeamInput } from '@/lib/coworkWorkflow'
import { parseTeamRequest } from '@/lib/coworkTeam'

const schema = {
  type: 'object',
  properties: { n: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
  required: ['n'],
  additionalProperties: false,
}

describe('schemaProblem', () => {
  it('refuses a required key that additionalProperties:false rules out', () => {
    expect(
      schemaProblem({ type: 'object', properties: { a: {} }, required: ['b'], additionalProperties: false })
    ).toContain("'b' is required")
  })
  it('accepts a consistent schema and refuses a non-object', () => {
    expect(schemaProblem(schema)).toBeNull()
    expect(schemaProblem('x')).toContain('JSON schema object')
    expect(schemaProblem({ type: 'blob' })).toContain('type')
  })
})

describe('validateAgainst / extractJson', () => {
  it('names the first violation', () => {
    expect(validateAgainst(schema, { n: 1 })).toBeNull()
    expect(validateAgainst(schema, {})).toBe('$.n is required')
    expect(validateAgainst(schema, { n: 1.5 })).toContain('integer')
    expect(validateAgainst(schema, { n: 1, x: 1 })).toBe('$.x is not allowed')
    expect(validateAgainst(schema, { n: 1, tags: [1] })).toContain('$.tags[0]')
  })
  it('finds JSON in prose and fences', () => {
    expect(extractJson('{"n":1}')?.value).toEqual({ n: 1 })
    expect(extractJson('Here:\n```json\n{"n":2}\n```')?.value).toEqual({ n: 2 })
    expect(extractJson('result is {"n":3} ok')?.value).toEqual({ n: 3 })
    expect(extractJson('no json')).toBeNull()
  })
})

describe('runTyped', () => {
  it('retries with the problem, then returns the parsed value', async () => {
    const briefs: string[] = []
    const answers = ['not json', '{"n":"x"}', 'sure: {"n": 7}']
    const out = await runTyped('do it', schema, async (brief, attempt) => {
      briefs.push(brief)
      return { output: answers[attempt - 1] }
    })
    expect(out).toMatchObject({ ok: true, output: '{"n":7}', attempts: 3 })
    expect(briefs[1]).toContain('rejected: the answer contained no JSON')
    expect(briefs[2]).toContain('$.n must be integer')
  })
  it('gives up after the bound, as a failure', async () => {
    const out = await runTyped('d', schema, async () => ({ output: 'nope' }), 2)
    expect(out).toMatchObject({ ok: false, isError: true, attempts: 2 })
    expect(out.output).toContain('after 2 attempts')
  })
  it('does not retry an agent that itself failed', async () => {
    let calls = 0
    const out = await runTyped('d', schema, async () => (calls++, { output: 'boom', isError: true }))
    expect(calls).toBe(1)
    expect(out.ok).toBe(false)
  })
})

describe('workflow schema field', () => {
  it('carries a valid schema onto the team task and refuses a contradictory one', () => {
    const input = workflowToTeamInput({
      phases: [{ agents: [{ id: 'a', description: 'd', schema }] }],
    })
    const tasks = parseTeamRequest(input)
    expect(typeof tasks).not.toBe('string')
    expect((tasks as { schema?: unknown }[])[0].schema).toEqual(schema)
    const bad = workflowToTeamInput({
      phases: [
        {
          agents: [
            {
              description: 'd',
              schema: { type: 'object', properties: {}, required: ['k'], additionalProperties: false },
            },
          ],
        },
      ],
    })
    expect(bad).toContain('phases[0].agents[0].schema contradicts itself')
  })
})
