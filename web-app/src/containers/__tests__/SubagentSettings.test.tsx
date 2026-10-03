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
      ],
    }),
}))
vi.mock('@/containers/Card', () => ({
  Card: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  CardItem: ({ title, actions }: { title?: string; actions?: React.ReactNode }) => (
    <div>
      {title}
      {actions}
    </div>
  ),
}))

describe('SubagentSettings', () => {
  beforeEach(() => useSubagentSettings.getState().reset())

  it('defaults every picker to inherit and lets the model choose', () => {
    render(<SubagentSettings />)
    const global = screen.getByTestId('subagent-global')
    for (const select of within(global).getAllByRole('combobox')) expect(select).toHaveValue('')
    expect(screen.getByTestId('subagents-let-model-choose')).toBeChecked()
    expect(screen.getByTestId('subagent-precedence')).toHaveTextContent('settings:subagents.precedence')
  })

  it('offers only models that can call tools, and saves a pick', async () => {
    render(<SubagentSettings />)
    const global = screen.getByTestId('subagent-global')
    const model = within(global).getByLabelText(/modelLabel/)
    expect(within(model).queryByText(/no-tools/)).toBeNull()
    await userEvent.selectOptions(model, 'v100::fast')
    expect(currentSubagentSettings().global.model).toEqual({ provider: 'v100', id: 'fast' })
    await userEvent.selectOptions(model, '')
    expect(currentSubagentSettings().global.model).toBeUndefined()
  })

  it('saves a work profile and an assistant', async () => {
    render(<SubagentSettings />)
    const global = screen.getByTestId('subagent-global')
    await userEvent.selectOptions(within(global).getByLabelText(/profileLabel/), 'review')
    await userEvent.selectOptions(within(global).getByLabelText(/assistantLabel/), 'terse')
    expect(currentSubagentSettings().global).toEqual({ workProfile: 'review', assistantId: 'terse' })
  })

  it('keeps per-role overrides behind Advanced', async () => {
    render(<SubagentSettings />)
    expect(screen.queryByTestId('subagent-roles')).toBeNull()
    await userEvent.click(screen.getByTestId('subagent-advanced-toggle'))
    const explorer = screen.getByTestId('subagent-role-explorer')
    await userEvent.selectOptions(within(explorer).getByLabelText(/modelLabel/), 'v100::fast')
    expect(currentSubagentSettings().roles.explorer?.model?.id).toBe('fast')
    expect(screen.getByTestId('subagent-advanced-toggle')).toHaveTextContent('overridden')
    for (const name of ['explorer', 'planner', 'implementer', 'reviewer', 'tester', 'security']) {
      expect(screen.getByTestId(`subagent-role-${name}`)).toBeInTheDocument()
    }
  })

  it('toggles "Let the model choose"', async () => {
    render(<SubagentSettings />)
    await userEvent.click(screen.getByTestId('subagents-let-model-choose'))
    expect(currentSubagentSettings().letModelChoose).toBe(false)
  })
})
