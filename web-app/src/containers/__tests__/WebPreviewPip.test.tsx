import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { WebPreviewPip } from '../WebPreviewPip'

describe('WebPreviewPip', () => {
  it('renders a fixed container with drag and resize handles and children', () => {
    render(
      <WebPreviewPip title="Preview">
        <div>body</div>
      </WebPreviewPip>
    )
    expect(screen.getByTestId('pip-drag')).toBeInTheDocument()
    expect(screen.getByTestId('pip-resize')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
    const root = screen.getByTestId('web-preview-pip')
    expect(getComputedStyle(root).position).toBe('fixed')
  })

  // A release that lands between a move and React applying it cleared the
  // drag ref before the queued update read it, crashing the whole app.
  it('survives a pointer release before the queued move is applied', () => {
    render(
      <WebPreviewPip title="Preview">
        <div>body</div>
      </WebPreviewPip>
    )
    const handle = screen.getByTestId('pip-drag')
    expect(() =>
      act(() => {
        fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 })
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 70 }))
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 60 }))
        window.dispatchEvent(new MouseEvent('pointerup'))
      })
    ).not.toThrow()
    expect(screen.getByTestId('web-preview-pip')).toBeInTheDocument()
  })
})
