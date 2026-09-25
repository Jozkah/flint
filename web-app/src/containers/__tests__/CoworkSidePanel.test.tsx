import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import {
  CoworkInspectorFrame,
  CoworkInspectorProvider,
  CoworkSidePanel,
  PANEL_DEFAULT_W,
  PANEL_MAX_W,
  PANEL_MIN_W,
  type InspectorLayout,
} from '../CoworkSidePanel'

function framed(
  layout: InspectorLayout,
  handlers: { onBack?: () => void; onDismiss?: () => void; onClose?: () => void } = {}
) {
  const onDismiss = handlers.onDismiss ?? vi.fn()
  const onClose = handlers.onClose ?? vi.fn()
  render(
    <CoworkInspectorProvider layout={layout}>
      <CoworkInspectorFrame
        tabs={<button type="button">tab</button>}
        onBack={handlers.onBack}
        onDismiss={onDismiss}
      >
        <CoworkSidePanel title="Panel" onClose={onClose} data-testid="panel">
          <input aria-label="inside" />
        </CoworkSidePanel>
      </CoworkInspectorFrame>
    </CoworkInspectorProvider>
  )
  return { onDismiss, onClose }
}

describe('CoworkSidePanel on its own', () => {
  it('opens at the default width and resizes from the keyboard', () => {
    render(
      <CoworkSidePanel title="Panel" onClose={vi.fn()} data-testid="panel">
        body
      </CoworkSidePanel>
    )
    const panel = screen.getByTestId('panel')
    expect(panel.style.width).toBe(`${PANEL_DEFAULT_W}px`)

    const handle = screen.getByRole('separator', { name: 'common:rail.resize' })
    expect(handle).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(panel.style.width).toBe(`${PANEL_DEFAULT_W + 24}px`)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(panel.style.width).toBe(`${PANEL_MIN_W}px`)
    fireEvent.keyDown(handle, { key: 'End' })
    expect(panel.style.width).toBe(`${PANEL_MAX_W}px`)
    expect(handle).toHaveAttribute('aria-valuenow', String(PANEL_MAX_W))
  })
})

describe('CoworkInspectorFrame', () => {
  it('docks at 360px with the tabs above the panel', () => {
    framed('docked')
    const frame = screen.getByTestId('cowork-inspector')
    expect(frame).toHaveAttribute('data-layout', 'docked')
    expect(frame.style.width).toBe(`${PANEL_DEFAULT_W}px`)
    expect(screen.getByRole('button', { name: 'tab' })).toBeInTheDocument()
    // The frame owns width and resizing, so there is one handle, not two.
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })

  it('keeps the chosen width when the frame is resized from the keyboard', () => {
    framed('docked')
    const frame = screen.getByTestId('cowork-inspector')
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' })
    expect(frame.style.width).toBe(`${PANEL_DEFAULT_W - 24}px`)
  })

  it('closes a drawer with Escape and from its scrim', () => {
    const { onDismiss } = framed('drawer')
    fireEvent.keyDown(screen.getByLabelText('inside'), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'common:rail.closeOverlay' }))
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  it('does not treat Escape as dismiss when docked', () => {
    const { onDismiss } = framed('docked')
    fireEvent.keyDown(screen.getByLabelText('inside'), { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('fills the view on a phone, with Back and without resizing', () => {
    const onBack = vi.fn()
    framed('full', { onBack })
    const frame = screen.getByTestId('cowork-inspector')
    expect(frame.style.width).toBe('')
    expect(screen.queryByRole('separator')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'common:expand' })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'common:coworkLayout.back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('the drawer and the composer', () => {
  function withComposer(layout: InspectorLayout) {
    render(
      <div data-testid="pane" style={{ position: 'relative' }}>
        <div data-composer data-testid="composer" />
        <CoworkInspectorProvider layout={layout}>
          <CoworkInspectorFrame tabs={null} onDismiss={vi.fn()}>
            body
          </CoworkInspectorFrame>
        </CoworkInspectorProvider>
      </div>
    )
  }
  const rect = (top: number, bottom: number) =>
    ({ top, bottom, left: 0, right: 1000, width: 1000, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect

  it('ends the drawer and its scrim above the composer', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.composer !== undefined ? rect(600, 700) : rect(0, 700)
      })
    try {
      withComposer('drawer')
      // 700 - 600 plus the 8px gap.
      expect(screen.getByTestId('cowork-inspector').style.bottom).toBe('108px')
      expect(screen.getByRole('button', { name: 'common:rail.closeOverlay' }).style.bottom).toBe('108px')
    } finally {
      spy.mockRestore()
    }
  })

  it('leaves a docked panel alone', () => {
    withComposer('docked')
    expect(screen.getByTestId('cowork-inspector').style.bottom).toBe('')
  })
})
