import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/containers/FilePreviewPopover', () => ({
  FilePreviewPopover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  previewLoader: () => undefined,
  viewerSpec: () => undefined,
}))

import { ComposerAttachmentChips } from '../ComposerAttachmentChips'
import type { Attachment } from '@/types/attachment'

const pdf: Attachment = { name: 'scan.pdf', type: 'document', path: '/s/scan.pdf', fileType: 'pdf' }

const renderChips = (canSeeImages: boolean, att: Attachment = pdf) => {
  const onToggle = vi.fn()
  render(
    <ComposerAttachmentChips
      attachments={[att]}
      canSeeImages={canSeeImages}
      onRemove={vi.fn()}
      onOpenImage={vi.fn()}
      onTogglePdfImages={onToggle}
    />
  )
  return onToggle
}

describe('ComposerAttachmentChips pages-as-images toggle', () => {
  it('offers the toggle on a PDF for a vision model', () => {
    const onToggle = renderChips(true)
    const btn = screen.getByTestId('chip-pdf-images')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledWith(0)
  })

  it('shows the toggle pressed once chosen', () => {
    renderChips(true, { ...pdf, sendAsImages: true })
    expect(screen.getByTestId('chip-pdf-images').getAttribute('aria-pressed')).toBe('true')
  })

  it('never offers it to a model without vision', () => {
    renderChips(false)
    expect(screen.queryByTestId('chip-pdf-images')).toBeNull()
  })
})
