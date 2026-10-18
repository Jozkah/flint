import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const { useSkills } = vi.hoisted(() => ({ useSkills: vi.fn() }))
vi.mock('@/hooks/useSkills', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useSkills')>(
    '@/hooks/useSkills'
  )
  return { ...actual, useSkills }
})

import SkillSelector from '../SkillSelector'

const skill = (name: string) => ({ name, description: `${name} desc` })

describe('SkillSelector', () => {
  beforeEach(() => useSkills.mockReset())

  it('renders nothing when there are no skills', () => {
    useSkills.mockReturnValue({ skills: [], enabled: [], setEnabled: vi.fn() })
    const { container } = render(<SkillSelector folder={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  // #8878: global skills are available to the agent with no working directory,
  // so the picker must surface them instead of hiding until a folder is picked.
  it('shows global skills when no folder is attached', async () => {
    useSkills.mockReturnValue({
      skills: [skill('git'), skill('pdf')],
      enabled: [],
      setEnabled: vi.fn(),
    })
    render(<SkillSelector folder={null} />)
    await userEvent.click(await screen.findByRole('button'))
    expect(screen.getByText('git')).toBeInTheDocument()
    expect(screen.getByText('pdf')).toBeInTheDocument()
    expect(screen.getByText('common:skillsScopeGlobal')).toBeInTheDocument()
  })

  // The `[skills].enabled` whitelist lives in a project's agent.toml; with no
  // folder it has nowhere to persist, so the toggle is informational, not live.
  it('disables the per-skill toggle with no folder and never persists', async () => {
    const setEnabled = vi.fn()
    useSkills.mockReturnValue({
      skills: [skill('git')],
      enabled: [],
      setEnabled,
    })
    render(<SkillSelector folder={null} />)
    await userEvent.click(await screen.findByRole('button'))
    const toggle = screen.getByRole('switch')
    expect(toggle).toBeDisabled()
    await userEvent.click(toggle)
    expect(setEnabled).not.toHaveBeenCalled()
  })

  // No count text on the button: a dot marks "some skill is on", and the
  // numbers live in the accessible name; same size as the plus / options.
  it('shows no count on the button, a dot and the numbers in its name', () => {
    useSkills.mockReturnValue({
      skills: [skill('git')],
      enabled: [],
      setEnabled: vi.fn(),
    })
    render(<SkillSelector folder="/home/u/repo" />)
    const btn = screen.getByRole('button')
    expect(btn.textContent).toBe('')
    expect(btn).toHaveAccessibleName(
      'common:skillsInContext: connections:skills.summary'
    )
    expect(btn.className).toContain('size-7')
    expect(btn.className).toContain('rounded-[7px]')
    expect(btn.querySelector('[data-testid="skill-selector-dot"]')).not.toBeNull()
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('keeps the toggle live when a folder is attached', async () => {
    const setEnabled = vi.fn()
    useSkills.mockReturnValue({
      skills: [skill('git')],
      enabled: [],
      setEnabled,
    })
    render(<SkillSelector folder="/home/u/repo" />)
    await userEvent.click(await screen.findByRole('button'))
    const toggle = screen.getByRole('switch')
    expect(toggle).not.toBeDisabled()
    await userEvent.click(toggle)
    expect(setEnabled).toHaveBeenCalled()
    expect(screen.queryByText('common:skillsScopeGlobal')).toBeNull()
  })
})
