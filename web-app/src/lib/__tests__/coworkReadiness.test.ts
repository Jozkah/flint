import { describe, expect, it } from 'vitest'
import {
  CONTEXT_CATEGORIES,
  MAX_INSTRUCTION_BYTES,
  accountedTotal,
  estimated,
  activeInstructions,
  classifyInstruction,
  isMissingFileError,
  manifestMatches,
  measured,
  mutationBlockers,
  parseSkillRequests,
  parseSkillRequestTriggers,
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

describe('parseSkillRequestTriggers', () => {
  it('keeps the text each request was read from', () => {
    expect(
      parseSkillRequestTriggers('/deploy now, then ask @reviewer and use the tdd skill')
    ).toEqual([
      { name: 'deploy', trigger: '/deploy' },
      { name: 'reviewer', trigger: '@reviewer' },
      { name: 'tdd', trigger: 'use the tdd skill' },
    ])
  })

  it('carries the trigger through resolution', () => {
    const [one] = resolveSkills(parseSkillRequestTriggers('@ghost'), registry())
    expect(one).toMatchObject({ requested: 'ghost', state: 'missing', trigger: '@ghost' })
  })
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

// Found on Windows: a folder with no JAN.md was reported as having one that
// could not be read, because the error said "cannot find the file".
describe('isMissingFileError', () => {
  it.each([
    'JAN.md is unreadable: The system cannot find the file specified. (os error 2)',
    'The system cannot find the path specified. (os error 3)',
    'No such file or directory (os error 2)',
    'ENOENT: no such file',
    'file not found',
  ])('reads %s as absent', (message) => {
    expect(isMissingFileError(message)).toBe(true)
  })

  it.each([
    'Access is denied. (os error 5)',
    'SENSITIVE: looks like a credentials file',
  ])('reads %s as a real failure', (message) => {
    expect(isMissingFileError(message)).toBe(false)
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

  // AH-204: `@` also names files. Referencing one used to request a skill of
  // that name, which resolved to `missing` and stopped every change.
  it.each([
    'fix @src/index.ts please',
    'compare @README.md with the spec',
    'look at @docs\\guide.md',
    'see @src/index.ts:24-48',
  ])('does not read the file reference in %s as a skill request', (text) => {
    expect(parseSkillRequests(text, known)).toEqual([])
  })

  // A "Continue" request quoted a failed robocopy command; its switches read as
  // seven missing skills and every write in the retried run was refused.
  it.each([
    'robocopy $src $dst /E /XD .jan .git /XF KewScraper.exe /NFL /NDL /NJH /NP',
    'Continue with the previous request:\n- bash robocopy a b /E /NP (failed)',
    'list it with dir /s /b',
    'run `/fake-cmd` in the shell',
    '```\n/E /XD\n```',
  ])('does not read command switches as skill requests: %s', (text) => {
    expect(parseSkillRequests(text, known)).toEqual([])
  })

  it('reads a slash command at the start of any line, and a known one anywhere', () => {
    expect(parseSkillRequests('first this\n/telekinesis now', known)).toEqual([
      'telekinesis',
    ])
    expect(parseSkillRequests('then run /brainstorming on it', known)).toEqual([
      'brainstorming',
    ])
  })

  it('reads the typed @skill: form, and never @agent: or @alias:', () => {
    expect(
      parseSkillRequests('@skill:reviewer with @agent:bot and @alias:spec', known)
    ).toEqual(['reviewer'])
  })

  it('still reads an @mention that names a known skill, even with a dot', () => {
    expect(parseSkillRequests('@my.skill now', ['my.skill'])).toEqual([
      'my.skill',
    ])
    // An unknown plain name is still an explicit request, resolved as missing.
    expect(parseSkillRequests('@telekinesis now', known)).toEqual([
      'telekinesis',
    ])
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

    expect(accountedTotal(accounting)).toEqual({
      tokens: 150,
      complete: false,
      estimated: false,
    })
  })

  it('is complete only when every category was measured', () => {
    const accounting = emptyContext()
    for (const category of CONTEXT_CATEGORIES) {
      accounting.categories[category] = measured(10)
    }

    expect(accountedTotal(accounting)).toEqual({
      tokens: 50,
      complete: true,
      estimated: false,
    })
  })

  it('counts a derived value, and says the total contains one', () => {
    const accounting = emptyContext()
    for (const category of CONTEXT_CATEGORIES) {
      accounting.categories[category] = measured(10)
    }
    accounting.categories.instructions = estimated(100, '~4 chars per token')

    // Complete and estimated are separate admissions: nothing is missing, but
    // the number is approximate. One flag could not say both.
    expect(accountedTotal(accounting)).toEqual({
      tokens: 140,
      complete: true,
      estimated: true,
    })
  })

  it('reports a derived value with the method that produced it', () => {
    expect(estimated(12.4, 'method')).toEqual({
      known: 'estimated',
      tokens: 12,
      method: 'method',
    })
  })

  it('refuses to derive a value from a non-number', () => {
    expect(estimated(undefined, 'method')).toEqual({ known: false })
    expect(estimated(Number.NaN, 'method')).toEqual({ known: false })
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

/**
 * A request that arrives after the conversation has started.
 *
 * The gap this closes: resolution used to read whatever was in the composer
 * when a render happened, so "use the superpowers skill for this change" on
 * turn five was resolved against an empty box by the time the run read it.
 * Each submitted turn is now parsed on its own.
 */
describe('a skill requested part-way through a conversation', () => {
  const known = ['superpowers']
  const turns = [
    'Read this project and learn it',
    'now use the superpowers skill for this change',
  ]

  it('is found in the turn that asked for it', () => {
    expect(parseSkillRequests(turns[1], known)).toEqual(['superpowers'])
  })

  it('was not present in the earlier turn', () => {
    expect(parseSkillRequests(turns[0], known)).toEqual([])
  })

  // Each turn is read on its own, so an earlier sentence is not re-read as a
  // fresh request every time a later one is submitted.
  it('does not re-read an earlier mention as a new request', () => {
    const mentionedOnce = 'earlier I said use superpowers'
    expect(parseSkillRequests(mentionedOnce, known)).toEqual([])
  })

  it('keeps the negative case negative on a later turn too', () => {
    expect(
      parseSkillRequests('I used to use superpowers but stopped', known)
    ).toEqual([])
  })

  it('resolves a follow-up request against the registry like any other', () => {
    const resolved = resolveSkills(parseSkillRequests(turns[1], known), {
      available: [{ name: 'superpowers' }],
      enabled: new Set<string>(),
    })

    // Present but switched off: the run must stop before changing anything
    // rather than proceed without the instructions it was told to follow.
    expect(resolved).toEqual([
      { requested: 'superpowers', matched: 'superpowers', state: 'disabled' },
    ])
    expect(unresolvedSkills(resolved)).toHaveLength(1)
  })

describe('switches at the start of a line', () => {
  it('are not skill requests', () => {
    expect(parseSkillRequestTriggers('robocopy a b `\n/E /XD node_modules /XF *.log')).toEqual([])
    expect(parseSkillRequestTriggers('/E /XD x /XF *.log')).toEqual([])
  })
  it('still leave a typed command alone', () => {
    expect(parseSkillRequestTriggers('/review this file').map((r) => r.name)).toEqual(['review'])
  })
})

})
