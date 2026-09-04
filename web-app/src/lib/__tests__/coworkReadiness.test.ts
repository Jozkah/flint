import { describe, expect, it } from 'vitest'
import {
  CONTEXT_CATEGORIES,
  MAX_INSTRUCTION_BYTES,
  accountedTotal,
  activeInstructions,
  classifyInstruction,
  manifestMatches,
  measured,
  mutationBlockers,
  parseSkillRequests,
  resolveSkills,
  sameBinding,
  unresolvedSkills,
  type ContextAccounting,
  type ReadinessManifest,
  type SkillRegistry,
} from '@/lib/coworkReadiness'

const registry = (over: Partial<SkillRegistry> = {}): SkillRegistry => ({
  available: [{ name: 'superpowers' }, { name: 'brainstorming' }],
  enabled: new Set(['superpowers']),
  ...over,
})

function emptyContext(): ContextAccounting {
  return {
    categories: {
      instructions: { known: false },
      skills: { known: false },
      repositoryMap: { known: false },
      conversation: { known: false },
      tools: { known: false },
    },
    budget: { known: false },
  }
}

describe('reading JAN.md', () => {
  it('is loaded, and active, when it has content', () => {
    const file = classifyInstruction({
      name: 'JAN.md',
      role: 'native',
      content: '# Rules\n\nBe careful.',
    })

    expect(file.active).toBe(true)
    expect(file.state.kind).toBe('loaded')
  })

  // Each of these is its own answer. Collapsing them into "no instructions" is
  // what lets a broken file look like a repository that simply has none.
  it('says it is missing when there is no file', () => {
    const file = classifyInstruction({ name: 'JAN.md', role: 'native' })

    expect(file).toMatchObject({ active: false, state: { kind: 'missing' } })
  })

  it('says it could not be read, and why', () => {
    const file = classifyInstruction({
      name: 'JAN.md',
      role: 'native',
      error: 'permission denied',
    })

    expect(file.active).toBe(false)
    expect(file.state).toEqual({
      kind: 'unreadable',
      reason: 'permission denied',
    })
  })

  it('refuses one too large to be instructions, rather than spending the run on it', () => {
    const file = classifyInstruction({
      name: 'JAN.md',
      role: 'native',
      content: 'x'.repeat(MAX_INSTRUCTION_BYTES + 1),
    })

    expect(file.active).toBe(false)
    expect(file.state).toMatchObject({
      kind: 'oversized',
      limit: MAX_INSTRUCTION_BYTES,
    })
  })

  it('distinguishes a file that says nothing from one that is not there', () => {
    const file = classifyInstruction({
      name: 'JAN.md',
      role: 'native',
      content: '   \n\n',
    })

    expect(file.state.kind).toBe('empty')
    expect(file.active).toBe(false)
  })

  it('counts bytes, not characters, so a limit means what it says', () => {
    const file = classifyInstruction({
      name: 'JAN.md',
      role: 'native',
      content: 'é',
    })

    expect(file.state).toEqual({ kind: 'loaded', bytes: 2 })
  })
})

describe('another harness’s instruction file', () => {
  // Detection is not consent. This is the whole compatibility contract.
  it.each(['AGENTS.md', 'CLAUDE.md'])(
    'is detected but never active: %s',
    (name) => {
      const file = classifyInstruction({
        name,
        role: 'compatibility',
        content: '# Do this instead',
      })

      expect(file.state.kind).toBe('loaded')
      expect(file.active).toBe(false)
    }
  )

  it('is not among the instructions the model was given', () => {
    const files = [
      classifyInstruction({ name: 'JAN.md', role: 'native', content: 'ours' }),
      classifyInstruction({
        name: 'AGENTS.md',
        role: 'compatibility',
        content: 'theirs',
      }),
    ]

    expect(activeInstructions(files).map((one) => one.name)).toEqual(['JAN.md'])
  })
})

describe('finding a skill request in a message', () => {
  const known = ['superpowers', 'brainstorming']

  it.each([
    ['/superpowers please', 'superpowers'],
    ['@superpowers please', 'superpowers'],
    ['use the superpowers skill', 'superpowers'],
    ['use superpowers skill', 'superpowers'],
    ['use superpowers', 'superpowers'],
    ['Use Superpowers', 'Superpowers'],
    ['please use superpowers', 'superpowers'],
    ['Read the project, then use superpowers', 'superpowers'],
  ])('reads %s as a request', (text, expected) => {
    expect(parseSkillRequests(text, known)).toEqual([expected])
  })

  // The failure this guards against is the opposite one: a run that silently
  // switches something on because a word appeared in a sentence.
  it.each([
    'I used to use superpowers in another harness but stopped',
    'we refused to use superpowers on that project',
    'superpowers would have been handy here',
    'read this project and learn it',
    'use whatever you think is best',
  ])('does not read prose as a request: %s', (text) => {
    expect(parseSkillRequests(text, known)).toEqual([])
  })

  it('does not invent a skill from a bare word the registry never heard of', () => {
    expect(parseSkillRequests('use telekinesis', known)).toEqual([])
    // Named explicitly, it is a request — and will resolve to `missing`.
    expect(parseSkillRequests('use the telekinesis skill', known)).toEqual([
      'telekinesis',
    ])
  })

  it('reports each request once, however many ways it was asked for', () => {
    expect(
      parseSkillRequests('/superpowers and use the superpowers skill', known)
    ).toEqual(['superpowers'])
  })
})

describe('resolving a requested skill', () => {
  it('is active when it exists and is switched on', () => {
    expect(resolveSkills(['superpowers'], registry())).toEqual([
      { requested: 'superpowers', matched: 'superpowers', state: 'active' },
    ])
  })

  it('is disabled when it exists but is not switched on for this folder', () => {
    expect(resolveSkills(['brainstorming'], registry())).toEqual([
      {
        requested: 'brainstorming',
        matched: 'brainstorming',
        state: 'disabled',
      },
    ])
  })

  it('is missing when the registry has never heard of it', () => {
    expect(resolveSkills(['telekinesis'], registry())).toEqual([
      { requested: 'telekinesis', state: 'missing' },
    ])
  })

  it('is ambiguous when more than one entry answers to the name', () => {
    const resolved = resolveSkills(
      ['superpowers'],
      registry({
        available: [{ name: 'superpowers' }, { name: 'SuperPowers' }],
      })
    )

    expect(resolved[0].state).toBe('ambiguous')
    expect(resolved[0].detail).toContain('SuperPowers')
  })

  // With no list to check against, "missing" would be a guess told as a fact.
  it('is failed — not missing — when the registry could not be read', () => {
    const resolved = resolveSkills(
      ['superpowers'],
      registry({ error: 'skills directory unreadable' })
    )

    expect(resolved[0].state).toBe('failed')
    expect(resolved[0].detail).toBe('skills directory unreadable')
  })

  it('matches the registry’s spelling regardless of how it was typed', () => {
    expect(resolveSkills(['SUPERPOWERS'], registry())[0]).toMatchObject({
      matched: 'superpowers',
      state: 'active',
    })
  })
})

describe('what blocks a mutation', () => {
  const manifestWith = (
    skills: ReturnType<typeof resolveSkills>
  ): ReadinessManifest => ({
    binding: { sessionId: 's1', folder: '/repo' },
    folder: '/repo',
    branch: 'main',
    mode: 'ask',
    writeDestination: 'sandbox',
    instructions: [],
    skills,
    tools: { builtins: 12, mcpServers: [] },
    model: { id: 'local/model', supportsTools: true },
    context: emptyContext(),
  })

  it('is any requested skill that is not in play', () => {
    for (const state of [
      'disabled',
      'missing',
      'ambiguous',
      'failed',
    ] as const) {
      const blockers = mutationBlockers(
        manifestWith([{ requested: 'superpowers', state }])
      )
      expect({ state, blocked: blockers.length }).toEqual({ state, blocked: 1 })
    }
  })

  it('is nothing once the skill is active', () => {
    expect(
      mutationBlockers(
        manifestWith([
          { requested: 'superpowers', matched: 'superpowers', state: 'active' },
        ])
      )
    ).toEqual([])
  })

  it('is nothing when the user asked for no skills at all', () => {
    expect(unresolvedSkills([])).toEqual([])
  })
})

describe('what the context cost', () => {
  it('reports a measured value as measured', () => {
    expect(measured(120)).toEqual({ known: true, tokens: 120 })
  })

  // A plausible number is worse than a blank to someone deciding whether to
  // trust the run.
  it.each([null, undefined, NaN, Infinity])(
    'refuses to invent one: %s',
    (value) => {
      expect(measured(value as number)).toEqual({ known: false })
    }
  )

  it('adds what it knows and says the total is incomplete', () => {
    const accounting = emptyContext()
    accounting.categories.instructions = measured(100)
    accounting.categories.skills = measured(50)

    expect(accountedTotal(accounting)).toEqual({ tokens: 150, complete: false })
  })

  it('is complete only when every category was measured', () => {
    const accounting = emptyContext()
    for (const category of CONTEXT_CATEGORIES) {
      accounting.categories[category] = measured(10)
    }

    expect(accountedTotal(accounting)).toEqual({ tokens: 50, complete: true })
  })
})

describe('a manifest belonging to a binding', () => {
  const manifest = {
    binding: { sessionId: 's1', folder: '/repo/a' },
  } as ReadinessManifest

  it('matches the binding it was resolved for', () => {
    expect(
      manifestMatches(manifest, { sessionId: 's1', folder: '/repo/a' })
    ).toBe(true)
  })

  // The reason readiness is snapshotted: a slow read for the previous folder
  // resolving after the user picked another must not be shown as this run's.
  it('does not match once the folder changed', () => {
    expect(
      manifestMatches(manifest, { sessionId: 's1', folder: '/repo/b' })
    ).toBe(false)
  })

  it('does not match once the session changed', () => {
    expect(
      manifestMatches(manifest, { sessionId: 's2', folder: '/repo/a' })
    ).toBe(false)
  })

  it('never matches when there is none', () => {
    expect(manifestMatches(null, { sessionId: 's1', folder: '/repo/a' })).toBe(
      false
    )
  })

  it('tells a detached session apart from one bound to a folder', () => {
    expect(
      sameBinding(
        { sessionId: 's1', folder: null },
        { sessionId: 's1', folder: '/repo/a' }
      )
    ).toBe(false)
  })
})
