import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  FilePreviewPopover,
  previewLoader,
  sentAttachment,
  viewerSpec,
} from '../FilePreviewPopover'
import { LinesView } from '../FileViewerDialog'
import { stringSource } from '@/lib/fileChunks'
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
  it('shows the file name only, with no native tooltip', () => {
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
    const chip = screen.getByTestId('composer-attachment-chip')
    expect(chip).not.toHaveAttribute('title')
    expect(chip.querySelector('[title]')).toBeNull()
  })
})

describe('sentAttachment', () => {
  it('finds inline text in the message metadata by name', async () => {
    const att = sentAttachment(
      { id: 'pasted-text-1.txt', name: 'pasted-text-1.txt' },
      { inline_file_contents: [{ name: 'pasted-text-1.txt', content: 'hello\nworld' }] }
    )
    expect(att.inlineContent).toBe('hello\nworld')
    expect(att.path).toBeUndefined()
    const p = await previewLoader(att)!(new AbortController().signal)
    expect(p).toEqual({ kind: 'text', lines: ['hello', 'world'] })
    expect(viewerSpec(att)?.mode).toBe('lines')
  })

  it('uses an absolute id as the path; images get no full viewer', () => {
    expect(sentAttachment({ id: 'C:/a/b.log', name: 'b.log' }).path).toBe('C:/a/b.log')
    expect(viewerSpec({ name: 'x.png', path: 'C:/x.png' })).toBeNull()
  })
})

describe('full viewer', () => {
  it('opens from the popover and shows the first chunk with a notice', async () => {
    const big = 'row\n'.repeat(1_000_000) // 4 MB > one chunk
    render(
      <FilePreviewPopover
        name="big.log"
        load={async () => ({ kind: 'text', lines: ['row'] })}
        viewer={{ mode: 'lines', open: async () => stringSource(big) }}
      >
        <span>chip</span>
      </FilePreviewPopover>
    )
    await userEvent.click(screen.getByRole('button'))
    await userEvent.click(await screen.findByTestId('file-preview-open-full'))
    const dlg = await screen.findByTestId('file-viewer-dialog')
    expect(await within(dlg).findByTestId('viewer-partial')).toBeInTheDocument()
    expect(within(dlg).getAllByTestId('viewer-line').length).toBeLessThan(200)
    await userEvent.click(within(dlg).getByText('common:fileViewer.loadMore'))
    await waitFor(() => expect(within(dlg).queryByTestId('viewer-partial')).toBeNull())
    fireEvent.keyDown(dlg, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('file-viewer-dialog')).toBeNull())
  })

  it('LinesView windows 200k lines and caps a huge single line', () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `l${i}`)
    lines[0] = 'x'.repeat(50_000)
    render(<LinesView lines={lines} version={0} wrap={false} initialHeight={400} />)
    const rows = screen.getAllByTestId('viewer-line')
    expect(rows.length).toBeLessThan(100)
    expect(rows[0].textContent!.length).toBeLessThan(2100)
    fireEvent.click(screen.getByText('common:fileViewer.expandLine'))
    expect(screen.getAllByTestId('viewer-line')[0].textContent!.length).toBeGreaterThan(50_000)
  })

  it('reports a binary file instead of garbage', async () => {
    const bin = { size: 4, read: async () => new Uint8Array([0, 1, 2, 3]) }
    render(
      <FilePreviewPopover name="blob.dat" viewer={{ mode: 'lines', open: async () => bin }}>
        <span>chip</span>
      </FilePreviewPopover>
    )
    await userEvent.click(screen.getByRole('button'))
    await userEvent.click(await screen.findByTestId('file-preview-open-full'))
    expect(await screen.findByText('common:fileViewer.binary')).toBeInTheDocument()
  })
})
