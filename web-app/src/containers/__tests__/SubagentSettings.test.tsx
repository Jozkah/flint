import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubagentSettings } from '../SubagentSettings'
import { useSubagentSettings, currentSubagentSettings } from '@/hooks/useSubagentSettings'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(' ')}` : key,
  }),
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: (sel: (s: unknown) => unknown) =>
    sel({ assistants: [{ id: 'jan', name: 'Flint' }, { id: 'terse', name: 'Terse' }] }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: unknown) => unknown) =>
    sel({
      providers: [
        {
          provider: 'v100',
          models: [
            { id: 'fast', capabilities: ['tools'] },
            { id: 'no-tools', capabilities: [] },
          ],
        },
        { provider: 'empty', models: [{ id: 'x', capabilities: [] }] },
      ],
    }),
}))

const open = (testId: string) => userEvent.click(screen.getByTestId(testId))

describe('SubagentSettings', () => {
  beforeEach(() => useSubagentSettings.getState().reset())

  it('shows Inherit on every menu and lets the model choose by default', () => {
    render(<SubagentSettings />)
    for (const field of ['assistant', 'profile', 'model']) {
      expect(screen.getByTestId(`subagent-global-${field}`)).toHaveTextContent('settings:subagents.inherit')
    }
    expect(screen.getByTestId('subagents-let-model-choose')).toBeChecked()
    expect(screen.getByTestId('subagent-precedence')).toHaveTextContent('settings:subagents.precedence')
    expect(screen.getByTestId('subagent-headless-note')).toBeInTheDocument()
    // The app's menus, not native selects.
    expect(document.querySelector('select')).toBeNull()
  })

  it('opens the app menu with Inherit first, a check on the current choice, and groups', async () => {
    render(<SubagentSettings />)
    await open('subagent-global-profile')
    const items = screen.getAllByRole('menuitemradio')
    expect(items[0]).toHaveTextContent('settings:subagents.inherit')
    expect(items[0]).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('settings:subagents.groupProfiles')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-global-profile-review')).toHaveTextContent('Review')
  })

  it('offers only tool-capable models, grouped by provider, and saves a pick', async () => {
    render(<SubagentSettings />)
    await open('subagent-global-model')
    expect(screen.queryByText('no-tools')).toBeNull()
    expect(screen.queryByText('empty')).toBeNull()
    expect(screen.getByText('v100')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('subagent-global-model-v100::fast'))
    expect(currentSubagentSettings().global.model).toEqual({ provider: 'v100', id: 'fast' })
    expect(screen.getByTestId('subagent-global-model')).toHaveTextContent('fast')
    await open('subagent-global-model')
    await userEvent.click(screen.getByTestId('subagent-global-model-inherit'))
    expect(currentSubagentSettings().global.model).toBeUndefined()
  })

  it('saves a work profile and an assistant', async () => {
    render(<SubagentSettings />)
    await open('subagent-global-profile')
    await userEvent.click(screen.getByTestId('subagent-global-profile-review'))
    await open('subagent-global-assistant')
    await userEvent.click(screen.getByTestId('subagent-global-assistant-terse'))
    expect(currentSubagentSettings().global).toEqual({ workProfile: 'review', assistantId: 'terse' })
  })

  it('keeps per-role overrides behind Advanced, in a compact menu', async () => {
    render(<SubagentSettings />)
    expect(screen.queryByTestId('subagent-roles')).toBeNull()
    await userEvent.click(screen.getByTestId('subagent-advanced-toggle'))
    const explorer = screen.getByTestId('subagent-role-explorer')
    await userEvent.click(within(explorer).getByTestId('subagent-role-explorer-model'))
    await userEvent.click(screen.getByTestId('subagent-role-explorer-model-v100::fast'))
    expect(currentSubagentSettings().roles.explorer?.model?.id).toBe('fast')
    expect(screen.getByTestId('subagent-advanced-toggle')).toHaveTextContent('overridden')
    for (const name of ['explorer', 'planner', 'implementer', 'reviewer', 'tester', 'security']) {
      expect(screen.getByTestId(`subagent-role-${name}`)).toBeInTheDocument()
    }
  })

  it('keeps a saved choice that no longer exists visible', () => {
    useSubagentSettings.getState().setGlobal('assistantId', 'deleted-one')
    render(<SubagentSettings />)
    expect(screen.getByTestId('subagent-global-assistant')).toHaveTextContent('deleted-one')
  })

  it('toggles "Let the model choose"', async () => {
    render(<SubagentSettings />)
    await userEvent.click(screen.getByTestId('subagents-let-model-choose'))
    expect(currentSubagentSettings().letModelChoose).toBe(false)
  })
})
