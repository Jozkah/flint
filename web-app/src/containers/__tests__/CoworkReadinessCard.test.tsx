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
  UNKNOWN_SHAPING,
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
    shaping: UNKNOWN_SHAPING,
  },
  ...over,
})

const card = () =>
  screen.getByRole('region', { name: 'common:readiness.title' })

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
    render(<CoworkReadinessCard manifest={manifest()} />)

    expect(card()).toHaveTextContent('common:readiness.tokensPartial')
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
            shaping: UNKNOWN_SHAPING,
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
            shaping: UNKNOWN_SHAPING,
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
            shaping: UNKNOWN_SHAPING,
          },
        })}
      />
    )

    // Missing and approximate are different failures; the card owes the reader
    // both rather than collapsing them into one hedge.
    expect(card()).toHaveTextContent('common:readiness.tokensEstimatedPartial')
  })

  it('says when its total describes a payload the manager cut down', () => {
    // The card's own rule, applied to a third admission: a total measured from
    // a trimmed payload, presented bare, reads as an exact count of the whole
    // conversation on screen.
    render(
      <CoworkReadinessCard
        manifest={manifest({
          context: {
            ...manifest().context,
            shaping: {
              kind: 'trimmed',
              removed: 4,
              retained: 8,
              removedTokens: { known: 'estimated', tokens: 900, method: 't' },
              reason: null,
            },
          },
        })}
      />
    )

    expect(screen.getByText(/readiness.shaping.trimmed/)).toBeInTheDocument()
  })

  it('adds nothing when the whole payload went out', () => {
    render(<CoworkReadinessCard manifest={manifest()} />)

    expect(screen.queryByText(/readiness.shaping\./)).toBeNull()
  })
})
