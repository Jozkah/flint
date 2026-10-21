import { describe, it, expect } from 'vitest'
import { applyTaskDefaults, resolveSubagent } from '../coworkSubagent'
import { MAX_SUBAGENT_STEPS } from '../coworkBudget'
import { COWORK_MODES, capMode } from '../coworkMode'

const definition = (over = {}) => ({
  name: 'researcher',
  description: 'reads things',
  system_prompt: 'You research.',
  allowed_tools: null as string[] | null,
  model: null as string | null,
  ...over,
})

describe('resolveSubagent per-agent options', () => {
  const parent = ['read', 'grep', 'bash', 'skill_list', 'skill_read']
  const req = { subagent_name: 'researcher', description: 'go' }

  it('removes disallowed tools after the allowlist, from an inheriting definition too', () => {
    const inherit = resolveSubagent(req, [definition({ disallowed_tools: ['bash'] })], parent)
    expect(inherit).toMatchObject({
      allowedTools: ['read', 'grep', 'skill_list', 'skill_read'],
    })
    const listed = resolveSubagent(
      req,
      [definition({ allowed_tools: ['read', 'bash'], disallowed_tools: ['bash'] })],
      parent
    )
    expect((listed as { allowedTools: string[] }).allowedTools).toEqual([
      'read',
      'skill_list',
      'skill_read',
    ])
  })

  it('refuses to launch when nothing but skill tools is left', () => {
    const out = resolveSubagent(
      req,
      [definition({ allowed_tools: ['bash'], disallowed_tools: ['bash'] })],
      parent
    )
    expect(out).toMatchObject({ error: expect.stringContaining('no tools left') })
  })

  it('names a disallowed tool the call asked for instead of dropping it', () => {
    const out = resolveSubagent(
      { ...req, allowed_tools: ['bash'] },
      [definition({ disallowed_tools: ['bash'] })],
      parent
    )
    expect(out).toMatchObject({ error: expect.stringContaining('disallowed_tools') })
  })

  it('changes nothing for a definition without the options', () => {
    const out = resolveSubagent(req, [definition()], parent) as Record<string, unknown>
    expect(out.allowedTools).toBeNull()
    for (const key of ['maxTurns', 'permissionMode', 'initialPrompt', 'omitInstructions']) {
      expect(out).not.toHaveProperty(key)
    }
  })

  it('clamps max_turns to [1, MAX_SUBAGENT_STEPS] and drops a non-number', () => {
    const turns = (max_turns: unknown) =>
      (resolveSubagent(req, [definition({ max_turns })], parent) as { maxTurns?: number })
        .maxTurns
    expect(turns(0)).toBe(1)
    expect(turns(-5)).toBe(1)
    expect(turns(3.9)).toBe(3)
    expect(turns(Number.MAX_SAFE_INTEGER * 2)).toBe(MAX_SUBAGENT_STEPS)
    expect(turns('7')).toBeUndefined()
    expect(turns(Number.NaN)).toBeUndefined()
  })

  it('keeps only a real cowork mode, trimmed prompts and a literal true', () => {
    const out = resolveSubagent(
      req,
      [
        definition({
          permission_mode: 'review',
          initial_prompt: '  start here  ',
          omit_instructions: true,
        }),
      ],
      parent
    )
    expect(out).toMatchObject({
      permissionMode: 'review',
      initialPrompt: 'start here',
      omitInstructions: true,
    })
    const bad = resolveSubagent(
      req,
      [definition({ permission_mode: 'root', omit_instructions: 'yes' })],
      parent
    ) as Record<string, unknown>
    expect(bad).not.toHaveProperty('permissionMode')
    expect(bad).not.toHaveProperty('omitInstructions')
  })
})

describe('applyTaskDefaults', () => {
  const both = { canBackground: true, canIsolate: true }
  const input = { subagent_name: 'a', description: 'go' }

  it('leaves a call alone when the definition sets neither', () => {
    expect(applyTaskDefaults(input, {}, both)).toEqual({ input })
    expect(applyTaskDefaults(input, undefined, both)).toEqual({ input })
  })

  it("fills in the definition's defaults", () => {
    expect(applyTaskDefaults(input, { background: true }, both)).toEqual({
      input: { ...input, background: true },
    })
    expect(applyTaskDefaults(input, { isolation: 'worktree' }, both)).toEqual({
      input: { ...input, isolate: true },
    })
  })

  it('lets an explicit call-site value win, false included', () => {
    expect(
      applyTaskDefaults({ ...input, background: false }, { background: true }, both)
    ).toEqual({ input: { ...input, background: false } })
    expect(
      applyTaskDefaults({ ...input, isolate: false }, { isolation: 'worktree' }, both)
    ).toEqual({ input: { ...input, isolate: false } })
  })

  it('ignores a default the surface cannot honour', () => {
    expect(
      applyTaskDefaults(
        input,
        { background: true, isolation: 'worktree' },
        { canBackground: false, canIsolate: false }
      )
    ).toEqual({ input })
  })

  it('still refuses isolate with background or allowed_tools, naming the field', () => {
    const clash = applyTaskDefaults(input, { background: true, isolation: 'worktree' }, both)
    expect(clash).toMatchObject({ error: expect.stringContaining('isolation: worktree') })
    const tools = applyTaskDefaults(
      { ...input, allowed_tools: ['read'] },
      { isolation: 'worktree' },
      both
    )
    expect(tools).toMatchObject({ error: expect.stringContaining('allowed_tools') })
    // The call picking one side resolves it.
    expect(
      applyTaskDefaults(
        { ...input, background: false },
        { background: true, isolation: 'worktree' },
        both
      )
    ).toEqual({ input: { ...input, background: false, isolate: true } })
  })
})

describe('capMode', () => {
  it('lets a child be stricter than the parent', () => {
    expect(capMode('auto', 'review')).toBe('review')
    expect(capMode('bypass', 'ask')).toBe('ask')
  })

  it('never lets a child be looser than the parent', () => {
    expect(capMode('review', 'bypass')).toBe('review')
    expect(capMode('ask', 'auto')).toBe('ask')
    for (const parent of COWORK_MODES) {
      for (const asked of COWORK_MODES) {
        const out = capMode(parent, asked)
        expect(COWORK_MODES.indexOf(out)).toBeLessThanOrEqual(COWORK_MODES.indexOf(parent))
      }
    }
  })

  it('keeps the parent mode for an absent or unknown request', () => {
    expect(capMode('ask', undefined)).toBe('ask')
    expect(capMode('ask', 'plan')).toBe('ask')
  })
})

describe('skills preload', () => {
  const base = { subagent_name: 'researcher', description: 'go' }
  const def = (skills: unknown) => ({
    name: 'researcher',
    description: 'd',
    system_prompt: 'p',
    allowed_tools: null as string[] | null,
    model: null as string | null,
    skills: skills as string[],
  })
  it('keeps a cleaned, deduped list and refuses one over the cap', () => {
    expect(resolveSubagent(base, [def([' a ', 'a', 'b', 3, ''])], [])).toMatchObject({ skills: ['a', 'b'] })
    expect(resolveSubagent(base, [def([])], [])).not.toHaveProperty('skills')
    const many = Array.from({ length: 33 }, (_, i) => `s${i}`)
    expect(resolveSubagent(base, [def(many)], [])).toMatchObject({ error: expect.stringContaining('limit is 32') })
    expect(resolveSubagent(base, [def(many.slice(0, 32))], [])).toMatchObject({ skills: many.slice(0, 32) })
  })
})
