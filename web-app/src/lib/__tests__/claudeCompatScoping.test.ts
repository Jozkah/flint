import { describe, expect, it, vi } from 'vitest'
import {
  compatInstructionBlocks,
  nestedChainFor,
  resolveCompatibility,
  scopedInstructionChain,
  NO_LOCAL_CONFINEMENT,
  type CompatProbes,
} from '@/lib/claudeCompat'

const ROOT = '/home/dev/obs-forwarder'
const binding = { sessionId: 'session-a', folder: ROOT }

/**
 * A nested `CLAUDE.md` governs its own subtree and nothing else.
 *
 * Jan builds one system prompt per run, so the nested files cannot all be
 * poured into it: that would apply each subtree's rules to every file, which
 * is the opposite of what the file means. They are resolved per path instead,
 * at the moment a path is actually touched.
 */
const instruction = (scope: string | undefined, content: string) => ({
  name: 'CLAUDE.md',
  path: scope ? `${ROOT}/${scope}/CLAUDE.md` : `${ROOT}/CLAUDE.md`,
  content,
  ...(scope ? { scope } : {}),
})

const manifest = (
  instructions: CompatProbes['instructions'],
  enabled = true
) =>
  resolveCompatibility(
    { instructions, skills: [], agents: [], mcp: [], inert: [] },
    {
      binding,
      enabled,
      enabledSkills: new Set<string>(),
      availableTools: [],
      consentedMcp: new Set<string>(),
      initializedMcp: new Set<string>(),
      failedMcp: new Map<string, string>(),
      confinement: NO_LOCAL_CONFINEMENT,
    }
  )

const full = manifest([
  instruction(undefined, 'Root rules.'),
  instruction('packages/api', 'API rules.'),
  instruction('packages/api/internal', 'Internal rules.'),
  instruction('packages/web', 'Web rules.'),
  instruction('packages/api-legacy', 'Legacy rules.'),
])

const contents = (chain: { content: string }[]) =>
  chain.map((one) => one.content)

describe('which instructions govern a path', () => {
  it('is the repository-wide file for a path with no nested file above it', () => {
    expect(contents(scopedInstructionChain(full, 'src/a.ts'))).toEqual([
      'Root rules.',
    ])
  })

  it('adds the subtree’s file for a path inside it', () => {
    expect(contents(scopedInstructionChain(full, 'packages/api/server.ts'))).toEqual(
      ['Root rules.', 'API rules.']
    )
  })

  // Shallowest first, so the deeper file is read last and therefore wins.
  it('orders deeper files after shallower ones', () => {
    expect(
      contents(scopedInstructionChain(full, 'packages/api/internal/db.ts'))
    ).toEqual(['Root rules.', 'API rules.', 'Internal rules.'])
  })

  it('never brings in a sibling subtree’s file', () => {
    const chain = contents(scopedInstructionChain(full, 'packages/api/server.ts'))

    expect(chain).not.toContain('Web rules.')
    expect(chain).not.toContain('Internal rules.')
  })

  /**
   * The prefix sibling. `packages/api-legacy` starts with `packages/api`, and
   * a scope compared as a string prefix would govern it.
   */
  it('does not let a scope govern a directory that merely starts the same way', () => {
    expect(contents(scopedInstructionChain(full, 'packages/api-legacy/old.ts'))).toEqual(
      ['Root rules.', 'Legacy rules.']
    )
  })

  it('governs the scope directory itself, not only what is under it', () => {
    expect(contents(scopedInstructionChain(full, 'packages/api'))).toEqual([
      'Root rules.',
      'API rules.',
    ])
  })

  it('claims nothing while compatibility is switched off', () => {
    const off = manifest([instruction(undefined, 'Root rules.')], false)

    expect(scopedInstructionChain(off, 'src/a.ts')).toEqual([])
  })
})

describe('what the system prompt carries', () => {
  // The failure this prevents: every subtree's rules applied to every file.
  it('is the repository-wide file only', () => {
    expect(compatInstructionBlocks(full)).toEqual([
      { name: 'CLAUDE.md', content: 'Root rules.' },
    ])
  })

  it('leaves the nested files to be delivered when work reaches them', () => {
    expect(contents(nestedChainFor(full, 'packages/api/server.ts'))).toEqual([
      'API rules.',
    ])
    expect(nestedChainFor(full, 'src/a.ts')).toEqual([])
  })
})
