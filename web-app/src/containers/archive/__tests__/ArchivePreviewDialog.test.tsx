import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o ? `${k}:${Object.values(o).join('/')}` : k,
  }),
}))

const h = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('@/lib/archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/archive')>('@/lib/archive')
  return { ...actual, archiveApi: { preview: h.preview } }
})

import { ArchivePreviewDialog } from '../ArchivePreviewDialog'

const item = (over: Record<string, unknown> = {}) =>
  ({
    archiveId: 'a1',
    kind: 'thread',
    id: 'a1',
    title: 'A thread',
    archivedAt: 1_700_000_000_000,
    origin: 'threads/a1',
    storage: 'dir',
    sizeBytes: 1536,
    ...over,
  }) as never

const base = {
  participants: [],
  messages: [],
  threads: [],
  fields: [],
}

describe('ArchivePreviewDialog contents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps the metadata block and shows the first messages', async () => {
    h.preview.mockResolvedValue({
      ...base,
      kind: 'thread',
      title: 'A thread',
      messages: [
        { role: 'user', text: 'hello there' },
        { role: 'assistant', text: 'hi' },
      ],
    })
    render(<ArchivePreviewDialog item={item()} onClose={() => {}} />)
    expect(screen.getByText('threads/a1')).toBeTruthy()
    expect(await screen.findByText('hello there')).toBeTruthy()
    expect(h.preview).toHaveBeenCalledWith('thread', 'a1')
    expect(screen.getByTestId('archive-preview-messages').children).toHaveLength(2)
    expect(screen.getByText('threads/a1')).toBeTruthy()
  })

  it('says when the list is cut', async () => {
    h.preview.mockResolvedValue({
      ...base,
      kind: 'cowork',
      title: 'S',
      folder: 'C:/code',
      totalMessages: 9,
      messages: [{ role: 'user', text: 'last' }],
    })
    render(<ArchivePreviewDialog item={item({ kind: 'cowork' })} onClose={() => {}} />)
    expect(await screen.findByText('C:/code')).toBeTruthy()
    expect(screen.getByText(/archive:previewShown:1\/9/)).toBeTruthy()
  })

  it('shows an assistant its instructions, a project its threads and a studio item its picture', async () => {
    h.preview.mockResolvedValue({
      ...base,
      kind: 'assistant',
      title: 'H',
      instructions: 'be brief',
    })
    const { rerender } = render(
      <ArchivePreviewDialog item={item({ kind: 'assistant' })} onClose={() => {}} />
    )
    expect(await screen.findByText('be brief')).toBeTruthy()

    h.preview.mockResolvedValue({ ...base, kind: 'project', title: 'P', threads: ['Alpha', 'Beta'] })
    rerender(<ArchivePreviewDialog item={item({ kind: 'project', archiveId: 'p1' })} onClose={() => {}} />)
    expect(await screen.findByText('Beta')).toBeTruthy()

    h.preview.mockResolvedValue({
      ...base,
      kind: 'studio',
      title: 'cat',
      fields: [{ label: 'prompt', value: 'a red cat' }],
      thumbnail: 'data:image/png;base64,AAAA',
    })
    rerender(<ArchivePreviewDialog item={item({ kind: 'studio', archiveId: 's1' })} onClose={() => {}} />)
    expect(await screen.findByText('a red cat')).toBeTruthy()
    expect(screen.getByAltText('archive:previewThumbnail').getAttribute('src')).toBe(
      'data:image/png;base64,AAAA'
    )
  })

  it('falls back to the metadata when the contents cannot be read', async () => {
    h.preview.mockRejectedValue(new Error('gone'))
    render(<ArchivePreviewDialog item={item()} onClose={() => {}} />)
    expect(await screen.findByTestId('archive-preview-failed')).toBeTruthy()
    expect(screen.getByText('threads/a1')).toBeTruthy()
  })

  it('reads nothing while closed', () => {
    render(<ArchivePreviewDialog item={null} onClose={() => {}} />)
    expect(h.preview).not.toHaveBeenCalled()
  })
})
