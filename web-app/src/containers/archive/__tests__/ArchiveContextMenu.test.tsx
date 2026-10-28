import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ArchiveContextMenu } from '../ArchiveContextMenu'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

function setup() {
  const onClose = vi.fn()
  const opener = document.createElement('button')
  document.body.appendChild(opener)
  opener.focus()
  const view = render(
    <ArchiveContextMenu
      x={10}
      y={10}
      onPreview={vi.fn()}
      onRestore={vi.fn()}
      onDelete={vi.fn()}
      onClose={onClose}
    />
  )
  const menu = screen.getByRole('menu')
  const items = screen.getAllByRole('menuitem')
  return { onClose, opener, view, menu, items }
}

describe('ArchiveContextMenu keyboard', () => {
  it('Home and End jump to the first and last item', () => {
    const { menu, items } = setup()
    expect(items[0]).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(items[items.length - 1]).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(items[0]).toHaveFocus()
  })

  it('Tab closes the menu', () => {
    const { menu, onClose } = setup()
    fireEvent.keyDown(menu, { key: 'Tab' })
    expect(onClose).toHaveBeenCalled()
  })

  it('returns focus to the opener on unmount', () => {
    const { opener, view } = setup()
    view.unmount()
    expect(opener).toHaveFocus()
  })
})
