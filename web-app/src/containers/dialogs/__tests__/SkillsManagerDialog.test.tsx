import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k}:${JSON.stringify(vars)}` : k,
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: (
    selector: (s: {
      sessions: { id: string; folder: string }[]
      currentId: string
    }) => unknown
  ) => selector({ sessions: [{ id: 's1', folder: '/project' }], currentId: 's1' }),
}))

// Mock-backed: no Tauri commands run. `hubImport` stands in for
// agent_skill_hub_import.
const hubList = vi.fn()
const hubImport = vi.fn()
vi.mock('@/hooks/useSkills', () => ({
  effectiveEnabled: (enabled: string[], all: string[]) =>
    new Set(enabled.length === 0 ? all : enabled.filter((n) => all.includes(n))),
  useSkills: () => ({
    skills: [
      { name: 'deploy', description: 'Ship it' },
      { name: 'review', description: '' },
    ],
    enabled: ['deploy'],
    remove: vi.fn(),
    write: vi.fn(),
    read: vi.fn(),
    hubList,
    hubImport,
  }),
}))

import SkillsManagerDialog from '../SkillsManagerDialog'
import { toast } from 'sonner'

describe('SkillsManagerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hubList.mockResolvedValue([{ name: 'pptx', description: 'Slides' }])
  })

  it('explains what a skill is, where it applies and that it grants no tool access', () => {
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByText('connections:skills.whatIs')).toBeInTheDocument()
    expect(screen.getByText('connections:skills.whereApplies')).toBeInTheDocument()
    expect(screen.getByText('connections:skills.toolAccess')).toBeInTheDocument()
  })

  it('distinguishes installed from enabled', () => {
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    expect(
      screen.getByText(/connections:skills\.summary.*"enabled":1.*"installed":2/)
    ).toBeInTheDocument()
    // The state line also carries the skill's scope ("<state> · Global").
    expect(screen.getByText(/^connections:skills\.state\.enabled · /)).toBeInTheDocument()
    expect(screen.getByText(/^connections:skills\.state\.disabled · /)).toBeInTheDocument()
  })

  it('announces an import only after it resolves', async () => {
    let finish: () => void = () => {}
    hubImport.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common:skillHubImport'))
    })
    await screen.findByText('pptx')
    await act(async () => {
      fireEvent.click(screen.getByText('common:skillImport'))
    })
    expect(hubImport).toHaveBeenCalledWith('pptx')
    expect(toast.success).not.toHaveBeenCalled()

    await act(async () => {
      finish()
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an import failure inline, not as a success', async () => {
    hubImport.mockRejectedValue(new Error('network unreachable'))
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common:skillHubImport'))
    })
    await screen.findByText('pptx')
    await act(async () => {
      fireEvent.click(screen.getByText('common:skillImport'))
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('connections:skills.importFailed')
    expect(alert).toHaveTextContent('network unreachable')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows a hub listing failure inline', async () => {
    hubList.mockRejectedValue('offline')
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('common:skillHubImport'))
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('connections:skills.loadHubFailed')
  })

  it('makes skill rows keyboard reachable and the delete button labelled', () => {
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    const row = screen.getByText('deploy').closest('[role="button"]')
    expect(row).toHaveAttribute('tabindex', '0')
    expect(
      screen.getByRole('button', {
        name: /connections:skills\.deleteSkill.*deploy/,
      })
    ).toBeInTheDocument()
  })
})
