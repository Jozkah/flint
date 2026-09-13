import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { CoworkCompatSection } from '../CoworkCompatSection'
import type { CompatComponent, CompatibilityManifest } from '@/lib/claudeCompat'

const ROOT = '/home/dev/obs-forwarder'
const user = userEvent.setup({ pointerEventsCheck: 0 })

const component = (over: Partial<CompatComponent>): CompatComponent => ({
  id: 'x',
  type: 'skill',
  name: 'reviewer',
  source: 'project',
  path: `${ROOT}/.claude/skills/reviewer`,
  enabled: true,
  state: 'active',
  ...over,
})

const show = (
  over: Partial<CompatibilityManifest> = {},
  handlers: { onToggle?: () => void; onMcpConsent?: () => void } = {}
) => {
  const onToggle = vi.fn(handlers.onToggle)
  const onMcpConsent = vi.fn(handlers.onMcpConsent)
  render(
    <CoworkCompatSection
      manifest={{
        binding: { sessionId: 'session-a', folder: ROOT },
        enabled: true,
        components: [],
        ...over,
      }}
      hasFolder
      onToggle={onToggle}
      onMcpConsent={onMcpConsent}
    />
  )
  return { onToggle, onMcpConsent }
}

const region = () => screen.getByTestId('cowork-compat')

describe('what the compatibility section reports', () => {
  it('says nothing was found rather than showing an empty frame', () => {
    show()

    expect(region()).toHaveTextContent('common:claudeCompat.nothingFound')
  })

  /**
   * The reason the section is a matrix and not a badge: a repository can be
   * all of these things at once, and one "compatible" light over the top of it
   * would be false.
   */
  it('reports each component’s own state side by side', () => {
    show({
      components: [
        component({ id: 'a', type: 'instructions', name: 'CLAUDE.md' }),
        component({ id: 'b', state: 'path-escape', reason: 'outside' }),
        component({
          id: 'c',
          type: 'agent',
          name: 'auditor',
          state: 'missing-dependency',
        }),
        component({
          id: 'd',
          type: 'mcp',
          name: 'files',
          state: 'unsupported-confinement',
        }),
        component({ id: 'e', type: 'hook', name: 'pre-commit', state: 'unsupported' }),
      ],
    })

    for (const state of [
      'active',
      'path-escape',
      'missing-dependency',
      'unsupported-confinement',
      'unsupported',
    ]) {
      expect(region()).toHaveTextContent(`common:claudeCompat.state.${state}`)
    }
  })

  it('shows why, where the reason is the whole content', () => {
    show({
      components: [
        component({ state: 'path-escape', reason: 'resource leaves the skill' }),
      ],
    })

    expect(region()).toHaveTextContent('resource leaves the skill')
  })

  // Which file wins is the question a user with both actually has.
  it('names the instruction precedence in force', () => {
    show({
      components: [
        component({ type: 'instructions', name: 'CLAUDE.md', state: 'active' }),
      ],
    })

    expect(region()).toHaveTextContent('system › cowork-policy › CLAUDE.md')
  })

  // Someone flipping this switch is entitled to know what it does not do.
  it('says that switching it on grants nothing', () => {
    show()

    expect(region()).toHaveTextContent('common:claudeCompat.grantsNothing')
  })
})

describe('allowing an MCP server from the section', () => {
  it('offers approval only where consent is what is missing', async () => {
    const { onMcpConsent } = show({
      components: [
        component({ type: 'mcp', name: 'docs', state: 'consent-required' }),
      ],
    })

    await user.click(screen.getByRole('button', { name: 'common:claudeCompat.mcpAllow' }))

    expect(onMcpConsent).toHaveBeenCalledWith('docs', true)
  })

  /**
   * A local server Jan cannot confine gets no button at all. Offering one
   * would imply the user could consent their way past a boundary that does not
   * exist on this platform.
   */
  it('offers nothing to approve for a server it refuses to confine', () => {
    show({
      components: [
        component({
          type: 'mcp',
          name: 'files',
          state: 'unsupported-confinement',
          reason: 'would run unconfined',
        }),
      ],
    })

    expect(screen.queryByRole('button')).toBeNull()
    expect(region()).toHaveTextContent(
      'common:claudeCompat.state.unsupported-confinement'
    )
  })

  it('lets an allowed server be withdrawn again', async () => {
    const { onMcpConsent } = show({
      components: [component({ type: 'mcp', name: 'docs', state: 'active' })],
    })

    await user.click(
      screen.getByRole('button', { name: 'common:claudeCompat.mcpWithdraw' })
    )

    expect(onMcpConsent).toHaveBeenCalledWith('docs', false)
  })

  // The names, so the user can see what the server will be handed. Never the
  // values.
  it('names the environment variables a server asks for', () => {
    show({
      components: [
        component({
          type: 'mcp',
          name: 'docs',
          state: 'consent-required',
          dependencies: ['API_TOKEN'],
        }),
      ],
    })

    expect(region()).toHaveTextContent('API_TOKEN')
  })
})

describe('switching compatibility on', () => {
  it('is a control the user operates, not a state Jan chooses', async () => {
    const { onToggle } = show({ enabled: false })

    await user.click(
      screen.getByRole('switch', { name: 'common:claudeCompat.enable' })
    )

    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('is its own labelled region, reachable on its own', () => {
    show()
    const section = screen.getByRole('region', {
      name: 'common:claudeCompat.title',
    })

    expect(
      within(section).getByRole('switch', {
        name: 'common:claudeCompat.enable',
      })
    ).toBeInTheDocument()
  })

  it('opens closed, so configuration does not fill the conversation column', () => {
    show()
    const disclosure = screen
      .getByTestId('cowork-compat')
      .querySelector('details')
    expect(disclosure).not.toBeNull()
    expect(disclosure).not.toHaveAttribute('open')
  })
})
