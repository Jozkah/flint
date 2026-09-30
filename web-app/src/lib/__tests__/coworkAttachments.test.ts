import { beforeEach, describe, expect, it, vi } from 'vitest'

const processed = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/attachmentProcessing', () => ({
  processAttachmentsForSend: processed.fn,
}))

import {
  inlineDocumentsText,
  MAX_INLINE_CHARS_PER_FILE,
  MAX_INLINE_CHARS_TOTAL,
  prepareCoworkAttachments,
} from '../coworkAttachments'
import type { Attachment } from '@/types/attachment'

const doc = (name: string, extra: Partial<Attachment> = {}): Attachment => ({
  name,
  type: 'document',
  path: `C:/docs/${name}`,
  parseMode: 'embeddings',
  ...extra,
})
const ctx = { sessionId: 's1', serviceHub: {} as never }

beforeEach(() => {
  processed.fn.mockReset()
})

describe('inlineDocumentsText', () => {
  it('puts each document under its name in a fence', () => {
    const { text, truncated } = inlineDocumentsText([{ name: 'a.md', content: 'hello' }])
    expect(text).toContain('### a.md')
    expect(text).toContain('```\nhello\n```')
    expect(truncated).toEqual([])
  })

  it('uses a longer fence than any backticks inside the document', () => {
    const { text } = inlineDocumentsText([{ name: 'a.md', content: 'x ```js\ny\n``` z' }])
    expect(text).toContain('````\nx ```js')
  })

  it('cuts a long document and says how much it kept', () => {
    const content = 'y'.repeat(MAX_INLINE_CHARS_PER_FILE + 500)
    const { text, truncated } = inlineDocumentsText([{ name: 'big.txt', content }])
    expect(truncated).toEqual(['big.txt'])
    expect(text).toContain('(Cut: the first 60000 of 60500 characters.)')
    expect(text.length).toBeLessThan(MAX_INLINE_CHARS_PER_FILE + 600)
  })

  it('stops adding text once the message is full, and names what was left out', () => {
    const one = 'z'.repeat(MAX_INLINE_CHARS_PER_FILE)
    const docs = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}`, content: one }))
    const { text, truncated } = inlineDocumentsText(docs)
    expect(text.length).toBeLessThan(MAX_INLINE_CHARS_TOTAL + 1500)
    expect(truncated).toContain('f3')
    expect(text).toContain('Not included')
  })

  it('says nothing when there are no documents', () => {
    expect(inlineDocumentsText([]).text).toBe('')
  })
})

describe('prepareCoworkAttachments', () => {
  it('reads documents inline whatever mode they were staged in, and inlines their text', async () => {
    processed.fn.mockResolvedValue({
      processedAttachments: [doc('notes.md', { inlineContent: 'the notes', injectionMode: 'inline' })],
      hasEmbeddedDocuments: false,
    })
    const out = await prepareCoworkAttachments({ docs: [doc('notes.md')] }, ctx)
    const call = processed.fn.mock.calls[0][0]
    expect(call.parsePreference).toBe('inline')
    expect(call.attachments[0].parseMode).toBe('inline')
    expect(call.threadId).toBe('s1')
    expect(out.modelSuffix).toContain('the notes')
    expect(out.shownNote).toBe('\n\nAttached: notes.md')
    expect(out.failed).toEqual([])
  })

  it('passes media through as parts and names them in the note', async () => {
    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }]
    const out = await prepareCoworkAttachments({ docs: [], files }, ctx)
    expect(processed.fn).not.toHaveBeenCalled()
    expect(out.parts).toEqual(files)
    expect(out.shownNote).toContain('1 media file')
  })

  it('reports a document it could not read instead of dropping it silently', async () => {
    processed.fn.mockResolvedValue({
      processedAttachments: [doc('scan.pdf', { error: 'no text layer' })],
      hasEmbeddedDocuments: false,
    })
    const out = await prepareCoworkAttachments({ docs: [doc('scan.pdf')] }, ctx)
    expect(out.failed).toEqual([{ name: 'scan.pdf', error: 'no text layer' }])
    expect(out.modelSuffix).toBe('')
  })

  it('reports every document when the reader throws', async () => {
    processed.fn.mockImplementation(() => Promise.reject(new Error('backend down')))
    const out = await prepareCoworkAttachments({ docs: [doc('a.pdf'), doc('b.pdf')] }, ctx)
    expect(out.failed.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf'])
    expect(out.failed[0].error).toBe('backend down')
  })
})
