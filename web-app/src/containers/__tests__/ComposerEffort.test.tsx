import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerEffort } from '../ComposerEffort'
import { EFFORT_LEVELS } from '@/lib/modelEffort'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('ComposerEffort', () => {
  it('names the current level on the button', () => {
    render(
      <ComposerEffort levels={EFFORT_LEVELS} value="medium" onChange={vi.fn()} />
    )
    expect(screen.getByTestId('composer-effort')).toHaveTextContent('Medium')
  })

  it('names the recommended level while none is chosen', () => {
    render(
      <ComposerEffort
        levels={EFFORT_LEVELS}
        value={null}
        recommended="medium"
        onChange={vi.fn()}
      />
    )
    expect(screen.getByTestId('composer-effort')).toHaveTextContent('Medium')
  })

  it('names Off when thinking is off', () => {
    render(
      <ComposerEffort
        levels={EFFORT_LEVELS}
        value="off"
        canDisable
        onChange={vi.fn()}
      />
    )
    expect(screen.getByTestId('composer-effort')).toHaveTextContent(
      'common:reasoningEffort.off'
    )
  })

  it('always names a level, never "model default"', () => {
    render(
      <ComposerEffort levels={EFFORT_LEVELS} value={null} onChange={vi.fn()} />
    )
    expect(screen.getByTestId('composer-effort')).not.toHaveTextContent(
      'modelDefault'
    )
  })

  it('opens the bar and reports a chosen level', async () => {
    const onChange = vi.fn()
    render(
      <ComposerEffort levels={EFFORT_LEVELS} value="medium" onChange={onChange} />
    )
    await userEvent.click(screen.getByTestId('composer-effort'))
    screen.getByRole('slider').focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenCalledWith('high')
  })
})
