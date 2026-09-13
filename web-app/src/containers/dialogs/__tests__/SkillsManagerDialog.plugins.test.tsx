import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
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

vi.mock('@/lib/skillStore', () => ({
  isPluginSkill: (s: { plugin?: string }) =>
    typeof s.plugin === 'string' && s.plugin.length > 0,
}))

// Mock-backed: no Tauri commands run. The list is what `agent_skill_list`
// returns for a project with one own skill and one enabled plugin's skill.
const read = vi.fn()
const write = vi.fn()
const remove = vi.fn()
vi.mock('@/hooks/useSkills', () => ({
  effectiveEnabled: (enabled: string[], all: string[]) =>
    new Set(enabled.length === 0 ? all : enabled.filter((n) => all.includes(n))),
  useSkills: () => ({
    skills: [
      { name: 'deploy', description: 'Ship it' },
      { name: 'release:prepare', description: 'Prepare a release', plugin: 'release' },
    ],
    enabled: [],
    remove,
    write,
    read,
    hubList: vi.fn(),
    hubImport: vi.fn(),
  }),
}))

import SkillsManagerDialog from '../SkillsManagerDialog'

describe('SkillsManagerDialog with plugin skills', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    read.mockImplementation(async (name: string) => `body of ${name}`)
  })

  it('marks which plugin a skill comes from', () => {
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    expect(
      screen.getByText('connections:skills.fromPlugin:{"plugin":"release"}')
    ).toBeInTheDocument()
    // One provenance line: the project's own skill carries none.
    expect(screen.getAllByText(/connections:skills\.fromPlugin/)).toHaveLength(1)
    expect(screen.getByText(/"enabled":2.*"installed":2/)).toBeInTheDocument()
  })

  it('offers no delete for a plugin skill', () => {
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: /connections:skills\.deleteSkill.*deploy/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /connections:skills\.deleteSkill.*release:prepare/,
      })
    ).toBeNull()
  })

  it('opens a plugin skill read-only and says where to edit it', async () => {
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('release:prepare'))
    })
    expect(read).toHaveBeenCalledWith('release:prepare')
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('connections:skills.pluginReadOnly')
    expect(note).toHaveTextContent('release')
    const editor = screen.getByDisplayValue('body of release:prepare')
    expect(editor).toHaveAttribute('readonly')
    expect(screen.queryByText('common:skillSave')).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps the project skill editable', async () => {
    render(<SkillsManagerDialog open onOpenChange={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('deploy'))
    })
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getByDisplayValue('body of deploy')).not.toHaveAttribute('readonly')
    expect(screen.getByText('common:skillSave')).toBeInTheDocument()
  })
})
