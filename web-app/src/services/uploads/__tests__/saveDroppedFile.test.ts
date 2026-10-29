import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { DefaultUploadsService } from '../default'
import {
  DOCUMENT_ATTACHMENT_EXTENSIONS,
  isDocumentAttachmentName,
} from '@/constants/attachments'

// A dropped file has contents but no path on disk; the backend saves it so it
// can be attached from a path like a picked file.
describe('DefaultUploadsService.saveDroppedFile', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('sends the raw bytes with the encoded name and returns the saved path', async () => {
    vi.mocked(invoke).mockResolvedValue('D:/data/attachments/01J/report.pdf')
    // Bytes that are not valid UTF-8, so a text round-trip would corrupt them.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80])
    const file = new File([bytes], 'rapport été.pdf', { type: 'application/pdf' })

    const path = await new DefaultUploadsService().saveDroppedFile(file)

    expect(path).toBe('D:/data/attachments/01J/report.pdf')
    const [cmd, body, options] = vi.mocked(invoke).mock.calls[0]
    expect(cmd).toBe('save_attachment_bytes')
    expect(Array.from(body as Uint8Array)).toEqual(Array.from(bytes))
    expect(options).toEqual({
      headers: { 'x-flint-file-name': 'rapport%20%C3%A9t%C3%A9.pdf' },
    })
  })

  it('passes the thread id so the backend can remove the file with the thread', async () => {
    vi.mocked(invoke).mockResolvedValue('saved')

    await new DefaultUploadsService().saveDroppedFile(new File(['x'], 'a.txt'), 'thread-1')

    expect(vi.mocked(invoke).mock.calls[0][2]).toEqual({
      headers: { 'x-flint-file-name': 'a.txt', 'x-flint-thread-id': 'thread-1' },
    })
  })

  it('sends large files intact', async () => {
    vi.mocked(invoke).mockResolvedValue('saved')
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256)

    await new DefaultUploadsService().saveDroppedFile(new File([bytes], 'big.bin'))

    const [, body] = vi.mocked(invoke).mock.calls[0]
    expect(Array.from(body as Uint8Array)).toEqual(Array.from(bytes))
  })
})

describe('isDocumentAttachmentName', () => {
  it('accepts document and code extensions, any case', () => {
    expect(DOCUMENT_ATTACHMENT_EXTENSIONS).toContain('pdf')
    expect(isDocumentAttachmentName('Report.PDF')).toBe(true)
    expect(isDocumentAttachmentName('main.rs')).toBe(true)
  })

  it('rejects images, no-extension names and unknown types', () => {
    expect(isDocumentAttachmentName('photo.png')).toBe(false)
    expect(isDocumentAttachmentName('README')).toBe(false)
    expect(isDocumentAttachmentName('a.exe')).toBe(false)
  })
})
