import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { WebPreviewPip } from '../WebPreviewPip'

describe('WebPreviewPip', () => {
  it('renders a fixed container with drag and resize handles and children', () => {
    render(
      <WebPreviewPip title="Preview" onClose={() => {}}>
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
      <WebPreviewPip title="Preview" onClose={() => {}}>
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

  it('moves with the arrow keys from the focusable title bar', () => {
    render(
      <WebPreviewPip title="Preview" onClose={() => {}}>
        <div>body</div>
      </WebPreviewPip>
    )
    const bar = screen.getByTestId('pip-drag')
    const root = screen.getByTestId('web-preview-pip')
    expect(bar).toHaveAttribute('tabindex', '0')
    const left0 = parseFloat(root.style.left)
    fireEvent.keyDown(bar, { key: 'ArrowLeft' })
    expect(parseFloat(root.style.left)).toBe(left0 - 16)
  })

  it('stops a drag on pointercancel', () => {
    render(
      <WebPreviewPip title="Preview" onClose={() => {}}>
        <div>body</div>
      </WebPreviewPip>
    )
    const root = screen.getByTestId('web-preview-pip')
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('pip-drag'), {
        clientX: 100,
        clientY: 100,
      })
      window.dispatchEvent(new MouseEvent('pointercancel'))
    })
    const left = root.style.left
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 10, clientY: 10 })
      )
    })
    expect(root.style.left).toBe(left)
  })

  it('removes window listeners on unmount mid-drag', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const view = render(
      <WebPreviewPip title="Preview" onClose={() => {}}>
        <div>body</div>
      </WebPreviewPip>
    )
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('pip-drag'), {
        clientX: 100,
        clientY: 100,
      })
    })
    view.unmount()
    expect(remove.mock.calls.some((c) => c[0] === 'pointermove')).toBe(true)
    remove.mockRestore()
  })
})
