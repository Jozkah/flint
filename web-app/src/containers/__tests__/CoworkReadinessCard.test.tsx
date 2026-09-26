import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))

import { CoworkReadinessCard } from '../CoworkReadinessCard'
import {
  classifyInstruction,
  estimated,
  measured,
  resolveSkills,
  type ReadinessManifest,
} from '@/lib/coworkReadiness'

const manifest = (
  over: Partial<ReadinessManifest> = {}
): ReadinessManifest => ({
  binding: { sessionId: 's1', folder: '/home/dev/obs-forwarder' },
  folder: '/home/dev/obs-forwarder',
  branch: 'main',
  mode: 'review',
  writeDestination: 'sandbox',
  instructions: [],
  skills: [],
  tools: { builtins: 12, mcpServers: [] },
  model: { id: 'local/qwen', supportsTools: true },
  context: {
    categories: {
      instructions: measured(null),
      skills: measured(null),
      repositoryMap: measured(null),
      conversation: measured(null),
      tools: measured(null),
    },
    budget: measured(null),
  },
  ...over,
})

const card = () =>
  screen.getByRole('region', { name: 'common:readiness.title' })

describe('project tooling (AH-068 / AH-069 / AH-070)', () => {
  it('lists each detected fact with its source and certainty', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          tooling: {
            state: 'ready',
            facts: [
              {
                kind: 'test-runner',
                value: 'Vitest',
                confidence: 'high',
                source: 'web/package.json',
                scope: 'web',
                reason: 'scripts.test runs it',
                command: 'pnpm test',
                testKind: 'unit',
              },
              {
                kind: 'package-manager',
                value: 'npm',
                confidence: 'low',
                source: 'package-lock.json',
                scope: '',
                reason: 'one of several conflicting lockfiles',
                command: null,
              },
            ],
            conflicts: ['the project root has lockfiles for yarn and npm'],
            skipped: [],
            truncated: null,
          },
        })}
      />
    )
    const facts = screen.getAllByTestId('readiness-tooling-fact')
    expect(facts).toHaveLength(2)
    expect(facts[0]).toHaveTextContent('Vitest')
    expect(facts[0]).toHaveTextContent('pnpm test')
    expect(facts[0]).toHaveAttribute('title', expect.stringContaining('web/package.json'))
    expect(facts[1]).toHaveAttribute('data-confidence', 'low')
    expect(card()).toHaveTextContent('the project root has lockfiles for yarn and npm')
  })

  it('says why detection failed without blocking the rest of the card', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          tooling: { state: 'failed', error: { kind: 'unreadable', message: 'denied' } },
        })}
      />
    )
    expect(screen.getByTestId('readiness-tooling')).toHaveTextContent(
      'common:readiness.tooling.failed#unreadable'
    )
    expect(card()).toHaveTextContent('main')
  })

  it('says so when nothing was recognised, and shows nothing without a folder', () => {
    const { unmount } = render(
      <CoworkReadinessCard
        manifest={manifest({
          tooling: { state: 'ready', facts: [], conflicts: [], skipped: [], truncated: null },
        })}
      />
    )
    expect(screen.getByTestId('readiness-tooling')).toHaveTextContent(
      'common:readiness.tooling.none'
    )
    unmount()
    render(<CoworkReadinessCard manifest={manifest({ folder: null })} />)
    expect(screen.queryByTestId('readiness-tooling')).toBeNull()
  })
})

describe('what the card states about the run', () => {
  it('names which checkout a managed destination means', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          writeDestination: 'managed',
          worktree: {
            path: '/data/worktrees/abc/session1',
            branch: 'jan/cowork/session1',
            baseSha: 'abcdef1234567890',
            uncommittedAtCreation: ['src/edited.ts', 'notes.md'],
          },
        })}
      />
    )

    // "A managed worktree" is the same sentence for every one of them; the
    // path and the branch are what someone actually checks.
    expect(card()).toHaveTextContent('/data/worktrees/abc/session1')
    expect(card()).toHaveTextContent('jan/cowork/session1')
    expect(card()).toHaveTextContent('abcdef12')
    // And what the checkout could not see, before the run rather than after.
    expect(card()).toHaveTextContent('common:readiness.worktree.unseen.value#2')
  })

  it('describes no worktree when writes do not go to one', () => {
    render(<CoworkReadinessCard manifest={manifest({ worktree: null })} />)
    expect(card()).not.toHaveTextContent('common:readiness.worktree.path')
  })

  it('names the exact repository and branch', () => {
    render(<CoworkReadinessCard manifest={manifest()} />)

    expect(card()).toHaveTextContent('/home/dev/obs-forwarder')
    expect(card()).toHaveTextContent('main')
  })

  it('names the mode and where changes actually land', () => {
    render(<CoworkReadinessCard manifest={manifest()} />)

    expect(card()).toHaveTextContent('common:coworkMode.review.label')
    expect(card()).toHaveTextContent('common:readiness.destination.sandbox')
  })

  it('says so when no repository is attached', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({ folder: null, branch: null })}
      />
    )

    expect(card()).toHaveTextContent('common:readiness.noRepository')
    expect(card()).toHaveTextContent('common:readiness.unknown')
  })
})

describe('what the card states about instructions', () => {
  it('distinguishes the file it read from the ones it only noticed', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          instructions: [
            classifyInstruction({
              name: 'JAN.md',
              role: 'native',
              content: '# rules',
            }),
            classifyInstruction({
              name: 'AGENTS.md',
              role: 'compatibility',
              content: '# theirs',
            }),
          ],
        })}
      />
    )

    expect(card()).toHaveTextContent(
      'JAN.md · common:readiness.instruction.loaded'
    )
    // Present in the repository, and explicitly not used.
    expect(card()).toHaveTextContent('AGENTS.md')
    expect(card()).toHaveTextContent('common:readiness.detectedOnly')
  })

  it.each([
    ['missing', {}],
    ['unreadable', { error: 'permission denied' }],
    ['empty', { content: '  ' }],
  ])('reports a %s JAN.md as its own state', (kind, probe) => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          instructions: [
            classifyInstruction({ name: 'JAN.md', role: 'native', ...probe }),
          ],
        })}
      />
    )

    expect(card()).toHaveTextContent(`common:readiness.instruction.${kind}`)
  })
})

describe('what the card states about skills', () => {
  const registry = {
    available: [{ name: 'superpowers' }],
    enabled: new Set(['superpowers']),
  }

  it('shows a requested skill that is in use', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          skills: resolveSkills(['superpowers'], registry),
        })}
      />
    )

    expect(card()).toHaveTextContent(
      'superpowers · common:readiness.skill.active'
    )
  })

  // The complaint this answers: a skill asked for and silently not used.
  it.each(['missing', 'disabled', 'ambiguous', 'failed'] as const)(
    'shows a requested skill that is %s',
    (state) => {
      render(
        <CoworkReadinessCard
          manifest={manifest({ skills: [{ requested: 'superpowers', state }] })}
        />
      )

      expect(card()).toHaveTextContent(`common:readiness.skill.${state}`)
    }
  )

  it('says plainly when none were asked for', () => {
    render(<CoworkReadinessCard manifest={manifest()} />)

    expect(card()).toHaveTextContent('common:readiness.noSkillsRequested')
  })
})

describe('what the card states about the model and tools', () => {
  it('says when the selected model cannot call tools', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          model: { id: 'local/tiny', supportsTools: false },
        })}
      />
    )

    expect(card()).toHaveTextContent('common:readiness.toolsUnsupported')
  })

  it('does not guess when tool support is unknown', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          model: { id: 'local/tiny', supportsTools: null },
        })}
      />
    )

    expect(card()).toHaveTextContent('common:readiness.toolsUnknown')
  })

  it('says when there are no MCP servers', () => {
    render(<CoworkReadinessCard manifest={manifest()} />)

    expect(card()).toHaveTextContent('common:readiness.noMcp')
  })

  it('lists the MCP servers there are', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          tools: { builtins: 12, mcpServers: ['filesystem'] },
        })}
      />
    )

    expect(card()).toHaveTextContent('filesystem')
  })
})

describe('what the card states about context', () => {
  // A total that silently omits what it could not measure reads as complete.
  it('marks the total as partial when a category is unmeasured', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          context: {
            categories: {
              instructions: measured(120),
              skills: measured(null),
              repositoryMap: measured(null),
              conversation: measured(null),
              tools: measured(null),
            },
            budget: measured(null),
          },
        })}
      />
    )

    expect(card()).toHaveTextContent('common:readiness.tokensPartial#120')
  })

  // "at least 0 tokens" read as "this session sends nothing".
  it('says the context is measured when the first run starts, never "at least 0"', () => {
    render(<CoworkReadinessCard manifest={manifest()} />)

    expect(card()).toHaveTextContent('common:readiness.tokensPending')
    expect(card()).not.toHaveTextContent('common:readiness.tokensPartial')
  })

  it('says when the tool set is built rather than that it is not', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({ tools: { builtins: null, mcpServers: [] } })}
      />
    )

    expect(card()).toHaveTextContent('common:readiness.builtinsUnknown')
  })

  it('reports a plain total once everything was measured', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          context: {
            categories: {
              instructions: measured(10),
              skills: measured(20),
              repositoryMap: measured(30),
              conversation: measured(40),
              tools: measured(50),
            },
            budget: measured(8000),
          },
        })}
      />
    )

    expect(card()).toHaveTextContent('common:readiness.tokens#150')
  })

  it('never shows a derived total as a counted one', () => {
    // The whole point of the third state. "12,000 tokens" and "~12,000 tokens
    // (~4 chars per token)" are different claims, and only one of them is true.
    render(
      <CoworkReadinessCard
        manifest={manifest({
          context: {
            categories: {
              instructions: estimated(10, '~4 chars per token'),
              skills: measured(20),
              repositoryMap: measured(30),
              conversation: measured(40),
              tools: measured(50),
            },
            budget: measured(8000),
          },
        })}
      />
    )

    expect(card()).toHaveTextContent('common:readiness.tokensEstimated')
    expect(card()).not.toHaveTextContent('common:readiness.tokens#150')
  })

  it('says both when a total is derived and incomplete', () => {
    render(
      <CoworkReadinessCard
        manifest={manifest({
          context: {
            categories: {
              instructions: estimated(10, '~4 chars per token'),
              skills: measured(20),
              repositoryMap: measured(30),
              conversation: measured(40),
              tools: measured(null),
            },
            budget: measured(null),
          },
        })}
      />
    )

    // Missing and approximate are different failures; the card owes the reader
    // both rather than collapsing them into one hedge.
    expect(card()).toHaveTextContent('common:readiness.tokensEstimatedPartial')
  })
})

describe('MCP servers from Settings', () => {
  it('says they are not offered when some are enabled', () => {
    render(<CoworkReadinessCard manifest={manifest()} settingsMcpServers={2} />)
    expect(screen.getByTestId('readiness-mcp-not-offered')).toHaveTextContent(
      'common:readiness.mcpNotOffered'
    )
  })

  it('says nothing extra when none are enabled', () => {
    render(<CoworkReadinessCard manifest={manifest()} />)
    expect(screen.queryByTestId('readiness-mcp-not-offered')).toBeNull()
  })
})
