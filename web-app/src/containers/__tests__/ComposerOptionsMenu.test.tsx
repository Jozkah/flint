import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ComposerOptionsMenu } from '../ComposerOptionsMenu'

const renderMenu = () =>
  render(
    <TooltipProvider>
      <div data-composer-box>
        <div data-composer-footer>
          <ComposerOptionsMenu label="Options" active={[]}>
            <button type="button">First control</button>
            <button type="button">Second control</button>
          </ComposerOptionsMenu>
        </div>
      </div>
    </TooltipProvider>
  )

describe('ComposerOptionsMenu focus', () => {
  it('opens the panel without focusing its first control', async () => {
    renderMenu()
    fireEvent.click(screen.getByTestId('composer-options'))
    const panel = await screen.findByTestId('composer-options-panel')
    // A focused first control opens its tooltip, which then swallows the
    // first Escape. Focus stays on the panel; Tab reaches the controls.
    await waitFor(() =>
      expect(screen.getByText('First control')).not.toHaveFocus()
    )
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('closes on the first Escape', async () => {
    renderMenu()
    fireEvent.click(screen.getByTestId('composer-options'))
    const panel = await screen.findByTestId('composer-options-panel')
    fireEvent.keyDown(panel, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('composer-options-panel')).toBeNull()
    )
  })
})
