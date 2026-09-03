import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReasoningEffortSlider } from '../ReasoningEffortSlider'
import { EFFORT_LEVELS, type EffortLevel } from '@/lib/modelEffort'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const Slider = ({
  value = null,
  levels = EFFORT_LEVELS,
  onChange = vi.fn(),
  overridden,
  onReset,
}: {
  value?: EffortLevel | null
  levels?: EffortLevel[]
  onChange?: (level: EffortLevel) => void
  overridden?: boolean
  onReset?: () => void
}) => (
  <ReasoningEffortSlider
    levels={levels}
    value={value}
    onChange={onChange}
    overridden={overridden}
    onReset={onReset}
  />
)

const slider = () => screen.getByRole('slider')

describe('ReasoningEffortSlider', () => {
  it('shows the current level above the bar', () => {
    render(<Slider value="high" />)
    expect(screen.getByText('High')).toBeInTheDocument()
  })

  it('says when the model’s own default is in force', () => {
    // Not level zero — a real state of its own, and the bar shows no fill.
    render(<Slider value={null} />)
    expect(
      screen.getByText('common:reasoningEffort.modelDefault')
    ).toBeInTheDocument()
    expect(slider()).not.toHaveAttribute('aria-valuenow')
  })

  it('renders one stop per supported level, and no more', () => {
    render(<Slider levels={['low', 'medium']} />)
    expect(screen.getByLabelText('Low')).toBeInTheDocument()
    expect(screen.getByLabelText('Medium')).toBeInTheDocument()
    expect(screen.queryByLabelText('High')).toBeNull()
    expect(slider()).toHaveAttribute('aria-valuemax', '2')
  })

  it('reports its position the way a slider should', () => {
    render(<Slider value="medium" />)
    expect(slider()).toHaveAttribute('aria-valuenow', '2')
    expect(slider()).toHaveAttribute('aria-valuemin', '1')
    expect(slider()).toHaveAttribute('aria-valuemax', '4')
    expect(slider()).toHaveAttribute('aria-valuetext', 'Medium')
  })

  it('chooses the level that was clicked', async () => {
    const onChange = vi.fn()
    render(<Slider value="low" onChange={onChange} />)
    await userEvent.click(screen.getByLabelText('High'))
    expect(onChange).toHaveBeenCalledWith('high')
  })

  describe('from the keyboard', () => {
    it('steps up and down with the arrows', async () => {
      const onChange = vi.fn()
      render(<Slider value="medium" onChange={onChange} />)
      slider().focus()

      await userEvent.keyboard('{ArrowRight}')
      expect(onChange).toHaveBeenLastCalledWith('high')
      await userEvent.keyboard('{ArrowLeft}')
      expect(onChange).toHaveBeenLastCalledWith('low')
      await userEvent.keyboard('{ArrowUp}')
      expect(onChange).toHaveBeenLastCalledWith('high')
      await userEvent.keyboard('{ArrowDown}')
      expect(onChange).toHaveBeenLastCalledWith('low')
    })

    it('jumps to either end with Home and End', async () => {
      const onChange = vi.fn()
      render(<Slider value="medium" onChange={onChange} />)
      slider().focus()

      await userEvent.keyboard('{Home}')
      expect(onChange).toHaveBeenLastCalledWith('low')
      await userEvent.keyboard('{End}')
      expect(onChange).toHaveBeenLastCalledWith('xhigh')
    })

    it('stops at the ends rather than wrapping round', async () => {
      const onChange = vi.fn()
      render(<Slider value="xhigh" onChange={onChange} />)
      slider().focus()
      await userEvent.keyboard('{ArrowRight}')
      // Already at the top: nothing to change.
      expect(onChange).not.toHaveBeenCalled()
    })

    it('enters the range at the bottom from the model default', async () => {
      // Stepping up from "no explicit effort" should start at the lowest
      // level, not land in the middle of the range.
      const onChange = vi.fn()
      render(<Slider value={null} onChange={onChange} />)
      slider().focus()
      await userEvent.keyboard('{ArrowRight}')
      expect(onChange).toHaveBeenCalledWith('low')
    })

    it('is reachable by tabbing, as one control rather than four', async () => {
      render(<Slider value="low" />)
      await userEvent.tab()
      expect(slider()).toHaveFocus()
      // The stops are not separate tab stops.
      await userEvent.tab()
      expect(slider()).not.toHaveFocus()
    })
  })

  describe('reset to the global default', () => {
    it('offers a reset only while this chat has overridden the setting', () => {
      const { rerender } = render(<Slider value="high" onReset={vi.fn()} />)
      expect(screen.queryByText('common:reasoningEffort.reset')).toBeNull()

      rerender(<Slider value="high" overridden onReset={vi.fn()} />)
      expect(
        screen.getByText('common:reasoningEffort.reset')
      ).toBeInTheDocument()
    })

    it('asks to reset when it is used', async () => {
      const onReset = vi.fn()
      render(<Slider value="high" overridden onReset={onReset} />)
      await userEvent.click(screen.getByText('common:reasoningEffort.reset'))
      expect(onReset).toHaveBeenCalled()
    })

    it('offers nothing to press when no reset is possible', () => {
      render(<Slider value="high" overridden />)
      expect(screen.queryByText('common:reasoningEffort.reset')).toBeNull()
    })
  })
})
