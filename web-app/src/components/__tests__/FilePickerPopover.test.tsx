import { describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { FilePickerPopover } from '@/components/FilePickerPopover'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const entry = {
  kind: 'file',
  path: 'src/a.ts',
  label: 'a.ts',
} as unknown as Parameters<typeof FilePickerPopover>[0]['entries'][number]

function renderMenu() {
  render(
    <FilePickerPopover
      entries={[entry]}
      query="a"
      open
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
  it('is visible once open', () => {
    expect(renderMenu().style.opacity).toBe('')
  })

  // A fixed negative `top` let a menu taller than the offset grow downward
  // over the composer toolbar. It must hang from the anchor's top edge.
  it('opens upward from its anchor', () => {
    const menu = renderMenu()
    expect(menu.className).toContain('bottom-full')
    expect(menu.style.top).toBe('')
  })

  it('lays out prompt, skill and file rows alike, with a one-line preview', () => {
    const entries = [
      { kind: 'prompt', token: 'prompt:p1', name: 'greet', detail: 'Write a {{tone}} greeting' },
      { kind: 'skill', token: 'skill:s', name: 'pdf', detail: 'Make pdfs' },
      { kind: 'file', token: 'a.ts', name: 'a.ts', extension: 'ts' },
    ] as unknown as Parameters<typeof FilePickerPopover>[0]['entries']
    render(
      <FilePickerPopover
        entries={entries}
        query=""
        open
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
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.className).toContain('flex')
      expect(row.querySelector('svg')).not.toBeNull()
      expect(row.querySelector('.truncate')).not.toBeNull()
    }
    expect(rows[0].textContent?.toLowerCase()).toContain('prompt')
    expect(rows[0].querySelector('.truncate.whitespace-nowrap')).not.toBeNull()
    expect(rows[1].getAttribute('data-kind')).toBe('skill')
    // primary-foreground is near-white: on the pale active tint it hid the name.
    expect(rows[0].className).toContain('text-foreground')
    expect(rows[0].className).not.toContain('text-primary-foreground')
  })
})
