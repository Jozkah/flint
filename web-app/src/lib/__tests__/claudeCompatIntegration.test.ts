import { describe, expect, it } from 'vitest'
import {
  compatInstructionBlocks,
  emptyManifest,
  manifestMatches,
  mergeSkillRegistry,
  resolveCompatibility,
  NO_LOCAL_CONFINEMENT,
  type CompatProbes,
  type ResolveOptions,
} from '@/lib/claudeCompat'
import {
  buildCoworkSystemPrompt,
  buildSubagentSystemPrompt,
} from '@/lib/coworkPrompt'
import {
  parseSkillRequests,
  resolveSkills,
  unresolvedSkills,
} from '@/lib/coworkReadiness'

const ROOT = '/home/dev/obs-forwarder'
const SIBLING = '/home/dev/note-py'
const binding = { sessionId: 'session-a', folder: ROOT }

const options = (over: Partial<ResolveOptions> = {}): ResolveOptions => ({
  binding,
  enabled: true,
  enabledSkills: new Set<string>(),
  availableTools: ['read', 'write'],
  consentedMcp: new Set<string>(),
  initializedMcp: new Set<string>(),
  failedMcp: new Map<string, string>(),
  confinement: NO_LOCAL_CONFINEMENT,
  ...over,
})

const probes = (over: Partial<CompatProbes> = {}): CompatProbes => ({
  instructions: [],
  skills: [],
  agents: [],
  mcp: [],
  inert: [],
  ...over,
})

const withInstructions = (content: string, enabled = true) =>
  resolveCompatibility(
    probes({
      instructions: [
        { name: 'CLAUDE.md', path: `${ROOT}/CLAUDE.md`, content },
      ],
    }),
    options({ enabled })
  )

const prompt = (over: Parameters<typeof buildCoworkSystemPrompt>[0]) =>
  buildCoworkSystemPrompt({
    workspacePath: '/jan/sessions/a',
    readOnlyFolder: ROOT,
    planMode: false,
    bashAvailable: true,
    subagentNames: [],
    webSearch: false,
    ...over,
  })

describe('what reaches the model', () => {
  // Detection is not activation, all the way through to the prompt.
  it('contains nothing from a folder where compatibility is off', () => {
    const manifest = withInstructions('Prefer small commits.', false)
    const text = prompt({
      compatInstructions: compatInstructionBlocks(manifest),
    })

    expect(text).not.toContain('Prefer small commits.')
    expect(text).not.toContain('CLAUDE.md')
  })

  it('contains the instructions once the user switches it on', () => {
    const manifest = withInstructions('Prefer small commits.')
    const text = prompt({
      compatInstructions: compatInstructionBlocks(manifest),
    })

    expect(text).toContain('Prefer small commits.')
    expect(text).toContain('path="CLAUDE.md"')
  })

  /**
   * Precedence has to be visible in the text itself, not only in the card. The
   * model is the one following both files, and where they disagree it needs to
   * know which one wins.
   */
  it('marks the compatibility file as ranking below FLINT.md', () => {
    const text = prompt({
      projectInstructions: 'Jan rules.',
      compatInstructions: compatInstructionBlocks(
        withInstructions('Claude rules.')
      ),
    })

    expect(text.indexOf('Jan rules.')).toBeLessThan(text.indexOf('Claude rules.'))
    expect(text).toContain('precedence="below FLINT.md"')
  })

  it('still works when the folder has only the compatibility file', () => {
    const text = prompt({
      compatInstructions: compatInstructionBlocks(
        withInstructions('Claude rules.')
      ),
    })

    expect(text).toContain('Claude rules.')
    expect(text).not.toContain('path="FLINT.md"')
  })

  // An oversized or escaping file contributes nothing, whatever it holds.
  it('contains nothing from a file the resolver refused', () => {
    const manifest = resolveCompatibility(
      probes({
        instructions: [
          {
            name: 'CLAUDE.md',
            path: `${SIBLING}/CLAUDE.md`,
            content: 'Read the other repository.',
          },
        ],
      }),
      options()
    )

    expect(compatInstructionBlocks(manifest)).toEqual([])
    expect(
      prompt({ compatInstructions: compatInstructionBlocks(manifest) })
    ).not.toContain('Read the other repository.')
  })

  /**
   * A subagent follows the same instructions its parent does. Resolving its
   * own would mean two agents in one run, in one repository, following
   * different rules — and the user seeing only one of them in readiness.
   */
  it('gives a subagent the same instructions as its parent', () => {
    const blocks = compatInstructionBlocks(withInstructions('Claude rules.'))
    const child = buildSubagentSystemPrompt('You review code.', {
      workspacePath: '/jan/sessions/a',
      readOnlyFolder: ROOT,
      bashAvailable: true,
      webSearch: false,
      compatInstructions: blocks,
    })

    expect(child).toContain('Claude rules.')
  })

  it('tells a subagent the same thing about the folder as the parent', () => {
    const forParent = prompt({ folderAccess: 'read-only' })
    const forChild = buildSubagentSystemPrompt('x', {
      workspacePath: '/jan/sessions/a',
      readOnlyFolder: ROOT,
      bashAvailable: true,
      webSearch: false,
      folderAccess: 'read-only',
    })

    // The same wording from the same builder, so neither can drift.
    const claim = /read-only|cannot (be )?modif/i
    expect(claim.test(forParent)).toBe(claim.test(forChild))
  })
})

describe('freezing the manifest for a run', () => {
  // A scan of the previous folder resolving mid-run must not activate that
  // folder's instructions against this one.
  it('is discarded when it was resolved for another binding', () => {
    const manifest = withInstructions('Claude rules.')
    const moved = { sessionId: 'session-a', folder: SIBLING }

    const forRun = manifestMatches(manifest, moved)
      ? manifest
      : emptyManifest(moved)

    expect(compatInstructionBlocks(forRun)).toEqual([])
  })

  it('is kept when the user has not moved', () => {
    const manifest = withInstructions('Claude rules.')

    expect(manifestMatches(manifest, binding)).toBe(true)
    expect(compatInstructionBlocks(manifest)).toHaveLength(1)
  })
})

describe('skills, resolved as one registry', () => {
  const skillManifest = (name: string, enabled = true) =>
    resolveCompatibility(
      probes({
        skills: [
          {
            name,
            dir: `${ROOT}/.claude/skills/${name}`,
            source: 'project',
            frontmatter: { name },
            content: 'Review carefully.',
          },
        ],
      }),
      options({ enabledSkills: enabled ? new Set([name]) : new Set() })
    )

  const jan = { available: [{ name: 'jan-review' }], enabled: new Set(['jan-review']) }

  it('lets a request name a compatibility skill', () => {
    const registry = mergeSkillRegistry(skillManifest('reviewer'), jan)
    const names = registry.available.map((one) => one.name)
    const resolved = resolveSkills(
      parseSkillRequests('use the reviewer skill', names),
      registry
    )

    expect(resolved[0]).toMatchObject({ matched: 'reviewer', state: 'active' })
    expect(unresolvedSkills(resolved)).toEqual([])
  })

  // Asked for and not in play: inspection continues, changes stop.
  it('blocks mutation when a requested compatibility skill is switched off', () => {
    const registry = mergeSkillRegistry(skillManifest('reviewer', false), jan)
    const names = registry.available.map((one) => one.name)
    const resolved = resolveSkills(
      parseSkillRequests('use the reviewer skill', names),
      registry
    )

    expect(resolved[0].state).toBe('disabled')
    expect(unresolvedSkills(resolved)).toHaveLength(1)
  })

  /**
   * A skill Jan refused is not offered as available. A request for it has to
   * resolve to missing — which blocks the run — rather than to something that
   * then fails to load halfway through.
   */
  it('does not offer a skill it refused on containment grounds', () => {
    const escaping = resolveCompatibility(
      probes({
        skills: [
          {
            name: 'reviewer',
            dir: `${ROOT}/.claude/skills/reviewer`,
            source: 'project',
            frontmatter: {},
            content: 'x',
            resources: ['../../../note-py/.env'],
          },
        ],
      }),
      options({ enabledSkills: new Set(['reviewer']) })
    )
    const registry = mergeSkillRegistry(escaping, jan)
    const resolved = resolveSkills(['reviewer'], registry)

    expect(resolved[0].state).toBe('missing')
    expect(unresolvedSkills(resolved)).toHaveLength(1)
  })

  // Deterministic, and shown: neither silently wins.
  it('reports a name claimed by both as ambiguous', () => {
    const registry = mergeSkillRegistry(skillManifest('jan-review'), jan)
    const resolved = resolveSkills(['jan-review'], registry)

    expect(resolved[0].state).toBe('ambiguous')
    expect(unresolvedSkills(resolved)).toHaveLength(1)
  })

  it('leaves Jan’s own skills alone when the folder has none', () => {
    const registry = mergeSkillRegistry(emptyManifest(binding), jan)

    expect(registry.available).toEqual([{ name: 'jan-review' }])
    expect(resolveSkills(['jan-review'], registry)[0].state).toBe('active')
  })
})

describe('normal chat', () => {
  // Compatibility is a Cowork surface. Nothing here reaches an ordinary chat
  // turn, which builds no compatibility manifest at all.
  it('is untouched by a folder full of Claude configuration', () => {
    const text = prompt({ compatInstructions: [] })

    expect(text).not.toContain('CLAUDE.md')
    expect(text).not.toContain('precedence=')
  })
})
