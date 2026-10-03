import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { VisualizeSettings } from '../VisualizeSettings'
import { useVisualizeConfig, clampWidgetHeight } from '@/hooks/useVisualizeConfig'

beforeEach(() => {
  useVisualizeConfig.setState({ enabled: true, allowCdn: false, maxHeight: 640 })
})

describe('VisualizeSettings', () => {
  it('defaults to widgets on and libraries off', () => {
    render(<VisualizeSettings />)
    expect(screen.getByTestId('visualize-enabled')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('visualize-cdn')).toHaveAttribute('aria-checked', 'false')
  })

  it('turns the tools off and locks the dependent controls', () => {
    render(<VisualizeSettings />)
    fireEvent.click(screen.getByTestId('visualize-enabled'))
    expect(useVisualizeConfig.getState().enabled).toBe(false)
    expect(screen.getByTestId('visualize-cdn')).toBeDisabled()
    expect(screen.getByTestId('visualize-max-height')).toBeDisabled()
  })

  it('stores the CDN choice and clamps the height', () => {
    render(<VisualizeSettings />)
    fireEvent.click(screen.getByTestId('visualize-cdn'))
    expect(useVisualizeConfig.getState().allowCdn).toBe(true)
    const input = screen.getByTestId('visualize-max-height')
    fireEvent.change(input, { target: { value: '99999' } })
    fireEvent.blur(input)
    expect(useVisualizeConfig.getState().maxHeight).toBe(1600)
    expect(clampWidgetHeight(NaN)).toBe(640)
    expect(clampWidgetHeight(10)).toBe(240)
  })
})
