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

describe('what the card states about the run', () => {
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
      <CoworkReadinessCard manifest={manifest({ folder: null, branch: null })} />
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
        manifest={manifest({ model: { id: 'local/tiny', supportsTools: null } })}
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
          },
        })}
      />
    )

    expect(card()).toHaveTextContent('common:readiness.tokens#150')
  })
})
