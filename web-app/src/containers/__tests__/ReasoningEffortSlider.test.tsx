import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReasoningEffortSlider } from '../ReasoningEffortSlider'
import {
  EFFORT_LEVELS,
  type EffortChoice,
  type EffortLevel,
} from '@/lib/modelEffort'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const Slider = ({
  value = null,
  recommended = null,
  canDisable = false,
  levels = EFFORT_LEVELS,
  onChange = vi.fn(),
  overridden,
  onReset,
}: {
  value?: EffortChoice | null
  recommended?: EffortLevel | null
  canDisable?: boolean
  levels?: EffortLevel[]
  onChange?: (choice: EffortChoice) => void
  overridden?: boolean
  onReset?: () => void
}) => (
  <ReasoningEffortSlider
    levels={levels}
    value={value}
    recommended={recommended}
    canDisable={canDisable}
    onChange={onChange}
    overridden={overridden}
    onReset={onReset}
  />
)

const slider = () => screen.getByRole('slider')

// jsdom has no PointerEvent, so a mouse event with a pointer type stands in.
const pointer = (type: string, clientX: number) =>
  new MouseEvent(type, { bubbles: true, clientX })

describe('ReasoningEffortSlider', () => {
  it('shows the current level above the bar', () => {
    render(<Slider value="high" />)
    expect(screen.getByText('High')).toBeInTheDocument()
  })

  it('shows the model’s own default until a level is chosen', () => {
    render(<Slider value={null} recommended="medium" />)
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(slider()).toHaveAttribute('aria-valuenow', '2')
    expect(screen.getByTestId('effort-thumb')).toBeInTheDocument()
  })

  it('never says "model default": a level is always named', () => {
    render(<Slider value={null} />)
    expect(screen.queryByText(/modelDefault/)).toBeNull()
    expect(slider()).toHaveAttribute('aria-valuenow')
  })

  it('renders one stop per supported level, and no more', () => {
    render(<Slider levels={['low', 'medium']} />)
    expect(screen.getByTestId('effort-stop-low')).toBeInTheDocument()
    expect(screen.getByTestId('effort-stop-medium')).toBeInTheDocument()
    expect(screen.queryByTestId('effort-stop-high')).toBeNull()
    expect(slider()).toHaveAttribute('aria-valuemax', '2')
  })

  it('is one continuous track, not a button per level', () => {
    render(<Slider value="low" />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getAllByTestId(/^effort-stop-/)).toHaveLength(4)
  })

  it('reports its position the way a slider should', () => {
    render(<Slider value="medium" />)
    expect(slider()).toHaveAttribute('aria-valuenow', '2')
    expect(slider()).toHaveAttribute('aria-valuemin', '1')
    expect(slider()).toHaveAttribute('aria-valuemax', '4')
    expect(slider()).toHaveAttribute('aria-valuetext', 'Medium')
  })

  describe('with the pointer', () => {
    // jsdom has no layout: give the track 400px, so each of 4 stops is 100px.
    const track = () => {
      const el = screen.getByTestId('effort-track')
      el.getBoundingClientRect = () =>
        ({
          left: 0,
          width: 400,
          right: 400,
          top: 0,
          bottom: 24,
          height: 24,
        }) as DOMRect
      return el
    }

    it('chooses the stop under the pointer', () => {
      const onChange = vi.fn()
      render(<Slider value="low" onChange={onChange} />)
      fireEvent(track(), pointer('pointerdown', 250))
      expect(onChange).toHaveBeenCalledWith('high')
    })

    it('follows a drag across the track, and stops following on release', () => {
      const onChange = vi.fn()
      render(<Slider value="low" onChange={onChange} />)
      const el = track()
      fireEvent(el, pointer('pointerdown', 50))
      fireEvent(el, pointer('pointermove', 150))
      fireEvent(el, pointer('pointermove', 390))
      expect(onChange).toHaveBeenLastCalledWith('xhigh')
      fireEvent(el, pointer('pointerup', 0))
      onChange.mockClear()
      fireEvent(el, pointer('pointermove', 50))
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  describe('a model that can be told not to think', () => {
    it('gets an Off stop in front of the levels, so one more stop', () => {
      render(<Slider value="medium" canDisable />)
      expect(screen.getByTestId('effort-stop-off')).toBeInTheDocument()
      expect(slider()).toHaveAttribute('aria-valuemax', '5')
      // Medium is now the third of five.
      expect(slider()).toHaveAttribute('aria-valuenow', '3')
    })

    it('has no Off stop otherwise', () => {
      render(<Slider value="medium" />)
      expect(screen.queryByTestId('effort-stop-off')).toBeNull()
      expect(slider()).toHaveAttribute('aria-valuemax', '4')
    })

    it('shows Off when thinking is off', () => {
      render(<Slider value="off" canDisable recommended="medium" />)
      expect(screen.getByText('common:reasoningEffort.off')).toBeInTheDocument()
      expect(slider()).toHaveAttribute('aria-valuenow', '1')
    })

    it('chooses Off from the first end of the bar, and keyboard Home', async () => {
      const onChange = vi.fn()
      render(<Slider value="medium" canDisable onChange={onChange} />)
      slider().focus()
      await userEvent.keyboard('{Home}')
      expect(onChange).toHaveBeenLastCalledWith('off')
    })

    it('steps from Off up to the lowest level', async () => {
      const onChange = vi.fn()
      render(<Slider value="off" canDisable onChange={onChange} />)
      slider().focus()
      await userEvent.keyboard('{ArrowRight}')
      expect(onChange).toHaveBeenLastCalledWith('low')
    })

    it('ignores a stored Off when the model cannot be turned off', () => {
      render(<Slider value="off" recommended="medium" />)
      expect(screen.queryByTestId('effort-stop-off')).toBeNull()
      expect(slider()).toHaveAttribute('aria-valuetext', 'Medium')
    })
  })

  describe('the recommended level', () => {
    it('is marked under the model’s own default', () => {
      render(<Slider value="high" recommended="medium" />)
      expect(screen.getByTestId('effort-recommended')).toHaveTextContent(
        'common:reasoningEffort.recommended'
      )
    })

    it('is where the thumb rests until a level is chosen', () => {
      render(<Slider value={null} recommended="medium" />)
      expect(slider()).toHaveAttribute('aria-valuenow', '2')
      expect(screen.getByText('Medium')).toBeInTheDocument()
    })

    it('shows a stored level the model does not take as the nearest it does', () => {
      render(<Slider value="xhigh" levels={['low', 'medium', 'high']} />)
      expect(slider()).toHaveAttribute('aria-valuetext', 'High')
    })
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
      expect(onChange).not.toHaveBeenCalled()
    })

    it('steps from the model’s own default when nothing is chosen', async () => {
      const onChange = vi.fn()
      render(<Slider value={null} recommended="medium" onChange={onChange} />)
      slider().focus()
      await userEvent.keyboard('{ArrowRight}')
      expect(onChange).toHaveBeenCalledWith('high')
    })

    it('is reachable by tabbing, as one control', async () => {
      render(<Slider value="low" />)
      await userEvent.tab()
      expect(slider()).toHaveFocus()
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
