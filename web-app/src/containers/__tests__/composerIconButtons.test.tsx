import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/hooks/useSkills', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useSkills')>(
    '@/hooks/useSkills'
  )
  return {
    ...actual,
    useSkills: () => ({
      skills: [{ name: 'git', description: '' }],
      enabled: [],
      setEnabled: vi.fn(),
    }),
  }
})

import { ComposerOptionsMenu } from '../ComposerOptionsMenu'
import SkillSelector from '../SkillSelector'
import { COMPOSER_ICON, COMPOSER_ICON_BUTTON } from '../composerIconButton'

const classes = (el: Element) => new Set((el.getAttribute('class') ?? '').split(/\s+/))

describe('composer toolbar icon buttons', () => {
  // The attach button (ChatInput) uses the same constants; see ChatInput.test.
  it('options and skills share one size, colour and icon size, with no border', () => {
    render(
      <>
        <ComposerOptionsMenu label="o" active={[]}>
          <span />
        </ComposerOptionsMenu>
        <SkillSelector folder="/repo" />
      </>
    )
    const options = screen.getByTestId('composer-options')
    const skills = screen.getByTestId('skill-selector')
    for (const btn of [options, skills]) {
      const c = classes(btn)
      for (const token of COMPOSER_ICON_BUTTON.split(' ')) expect(c.has(token)).toBe(true)
      expect(c.has('border-[0.8px]')).toBe(false)
      expect(c.has('text-foreground')).toBe(false)
      const icon = btn.querySelector('svg')!
      for (const token of COMPOSER_ICON.split(' ')) expect(classes(icon).has(token)).toBe(true)
    }
    // The skills dot is the only accent.
    expect(skills.querySelector('[data-testid="skill-selector-dot"]')).not.toBeNull()
    expect(skills.querySelector('svg')!.getAttribute('class')).not.toContain('text-foreground')
  })
})
