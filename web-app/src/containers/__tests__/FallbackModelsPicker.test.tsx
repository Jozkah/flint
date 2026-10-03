import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import FallbackModelsPicker from '../FallbackModelsPicker'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const refs = () => useGeneralSetting.getState().fallbackModels

describe('FallbackModelsPicker order controls', () => {
  beforeEach(() => {
    act(() => {
      useModelProvider.setState({
        providers: [
          { provider: 'p', active: true, models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
        ] as never,
      })
      useGeneralSetting.setState({ fallbackModels: ['p::a', 'p::b', 'p::c'] })
    })
  })

  it('moves an entry up and down, as real buttons a keyboard can reach', () => {
    render(<FallbackModelsPicker />)
    const up = screen.getAllByLabelText('settings:general.fallbackModelsMoveUp')
    const down = screen.getAllByLabelText('settings:general.fallbackModelsMoveDown')
    expect(up[0].tagName).toBe('BUTTON')
    fireEvent.click(down[0])
    expect(refs()).toEqual(['p::b', 'p::a', 'p::c'])
    fireEvent.click(screen.getAllByLabelText('settings:general.fallbackModelsMoveUp')[2])
    expect(refs()).toEqual(['p::b', 'p::c', 'p::a'])
  })

  it('cannot move the first entry up or the last one down', () => {
    render(<FallbackModelsPicker />)
    expect(screen.getAllByLabelText('settings:general.fallbackModelsMoveUp')[0]).toBeDisabled()
    expect(screen.getAllByLabelText('settings:general.fallbackModelsMoveDown')[2]).toBeDisabled()
  })
})
