import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilePreviewPopover } from '../FilePreviewPopover'
import { ComposerAttachmentChips } from '../ComposerAttachmentChips'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o?.name ? `${k}:${o.name}` : k,
  }),
}))

describe('FilePreviewPopover', () => {
  it('opens with the display name as title, loads lazily, closes on Escape', async () => {
    const load = vi.fn(async () => ({
      kind: 'text' as const,
      lines: ['first line', 'second'],
    }))
    render(
      <FilePreviewPopover
        name="C:\Users\x\notes.md"
        meta="1 KB"
        load={load}
      >
        <span>chip</span>
      </FilePreviewPopover>
    )
    expect(load).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button'))
    const pop = await screen.findByTestId('file-preview-popover')
    expect(pop).toHaveTextContent('notes.md')
    expect(pop).not.toHaveTextContent('Users')
    expect(pop).toHaveTextContent('MD · 1 KB')
    await waitFor(() =>
      expect(screen.getByTestId('file-preview-text')).toHaveTextContent(
        'first line'
      )
    )
    expect(load).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(pop, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('file-preview-popover')).toBeNull()
    )
  })

  it('shows the no-preview note when nothing can be read', async () => {
    render(
      <FilePreviewPopover name="a.bin">
        <span>chip</span>
      </FilePreviewPopover>
    )
    await userEvent.click(screen.getByRole('button'))
    expect(
      await screen.findByText('common:composerChip.previewNone')
    ).toBeInTheDocument()
  })
})

describe('ComposerAttachmentChips display', () => {
  it('shows the file name only, the full path in the tooltip', () => {
    render(
      <ComposerAttachmentChips
        attachments={[
          {
            type: 'document',
            name: 'file:///C:/Users/x/a%20b.docx',
            fileType: 'docx',
            size: 100,
          },
        ]}
        canSeeImages
        onRemove={() => {}}
        onOpenImage={() => {}}
      />
    )
    expect(screen.getByTestId('chip-name')).toHaveTextContent('a b.docx')
    expect(screen.getByTestId('composer-attachment-chip')).toHaveAttribute(
      'title',
      'file:///C:/Users/x/a%20b.docx'
    )
  })
})
