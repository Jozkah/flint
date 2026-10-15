import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FilePickerPopover } from '@/components/FilePickerPopover'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const entry = {
  kind: 'file',
  path: 'src/a.ts',
  label: 'a.ts',
} as unknown as Parameters<typeof FilePickerPopover>[0]['entries'][number]

function renderMenu(position: { top: number; left: number } | null) {
  render(
    <FilePickerPopover
      entries={[entry]}
      query="a"
      open
      position={position}
      activeIndex={0}
      onActiveChange={() => {}}
      onSelect={() => {}}
      onClose={() => {}}
      listId="refs"
      aliasDraft={null}
      onAliasSave={() => {}}
      onAliasCancel={() => {}}
    />
  )
  return screen.getByTestId('reference-menu')
}

describe('FilePickerPopover', () => {
  // The composer is a rich editor: the menu used to wait for a textarea that
  // never existed and stayed at opacity 0 over the composer footer.
  it('is visible once open, with or without a computed position', () => {
    expect(renderMenu({ top: -62, left: 0 }).style.opacity).toBe('')
  })

  it('is visible before the first position arrives', () => {
    expect(renderMenu(null).style.opacity).toBe('')
  })
})
