import { describe, it, expect, vi, beforeEach } from 'vitest'

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  i18n: {
    t: (key: string, o?: Record<string, unknown>) => `${key} ${JSON.stringify(o ?? {})}`,
  },
}))

import {
  canSendPdfAsImages,
  isScannedPdfError,
  renderPdfDocument,
  type PdfDocumentLike,
} from '../pdfPageImages'
import { processAttachmentsForSend } from '../attachmentProcessing'
import { createImageAttachment, type Attachment } from '@/types/attachment'

const pdf = (o: Partial<Attachment> = {}): Attachment => ({
  name: 'scan.pdf',
  type: 'document',
  path: '/tmp/scan.pdf',
  fileType: 'pdf',
  ...o,
})

const fakePdf = (numPages: number, w = 612, h = 792): PdfDocumentLike => ({
  numPages,
  getPage: async () => ({
    getViewport: ({ scale }) => ({ width: w * scale, height: h * scale }),
    render: () => ({ promise: Promise.resolve() }),
  }),
})
const draw = vi.fn(async () => 'data:image/png;base64,QUJD')

const pageImages = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    createImageAttachment({
      name: `scan-page-${i + 1}.png`,
      dataUrl: 'data:image/png;base64,QUJD',
      mimeType: 'image/png',
      size: 3,
    })
  )

const hub = (over: Record<string, unknown> = {}) => {
  const uploads = {
    ingestImage: vi.fn().mockResolvedValue({ id: 'img' }),
    ingestFileAttachment: vi.fn().mockResolvedValue({ id: 'doc-1' }),
    ingestFileAttachmentForProject: vi.fn(),
    ...over,
  }
  return {
    uploads: () => uploads,
    rag: () => ({ parseDocument: vi.fn().mockResolvedValue('text') }),
    _uploads: uploads,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('canSendPdfAsImages', () => {
  it('is offered for a PDF only when the model has vision', () => {
    expect(canSendPdfAsImages(pdf(), true)).toBe(true)
    expect(canSendPdfAsImages(pdf(), false)).toBe(false)
    expect(canSendPdfAsImages(pdf({ name: 'a.docx', path: '/a.docx', fileType: 'docx' }), true)).toBe(false)
  })
})

describe('isScannedPdfError', () => {
  it('matches the indexer error for an image-only PDF', () => {
    expect(
      isScannedPdfError(new Error('PDF appears to be image-based or scanned. OCR is not supported yet.'))
    ).toBe(true)
    expect(isScannedPdfError(new Error('os error 2'))).toBe(false)
  })
})

describe('renderPdfDocument', () => {
  it('stops at the page cap and reports the real page count', async () => {
    const out = await renderPdfDocument(fakePdf(30), 'scan.pdf', draw)
    expect(out.images).toHaveLength(20)
    expect(out.totalPages).toBe(30)
    expect(out.images[0].name).toBe('scan-page-1.png')
    expect(out.images[0].type).toBe('image')
  })

  it('stops when the pixel budget runs out, keeping the first page', async () => {
    const out = await renderPdfDocument(fakePdf(5), 'scan.pdf', draw, {
      pages: 20,
      pixels: 1,
      maxEdge: 100,
    })
    expect(out.images).toHaveLength(1)
  })

  it('fits the long edge to the cap', async () => {
    await renderPdfDocument(fakePdf(1, 1000, 2000), 'x.pdf', draw, {
      pages: 1,
      pixels: 1e9,
      maxEdge: 1000,
    })
    expect(draw).toHaveBeenCalledWith(expect.anything(), 500, 1000, 0.5)
  })
})

describe('processAttachmentsForSend with PDF pages', () => {
  const base = { threadId: 't', parsePreference: 'auto' as const }

  it('routes a toggled PDF to the image ingest for a vision model', async () => {
    const h = hub()
    const render = vi.fn().mockResolvedValue({ images: pageImages(2), totalPages: 2 })
    const res = await processAttachmentsForSend({
      ...base,
      attachments: [pdf({ sendAsImages: true })],
      serviceHub: h as never,
      modelSupportsVision: true,
      renderPdfPages: render,
    })
    expect(h._uploads.ingestImage).toHaveBeenCalledTimes(2)
    expect(h._uploads.ingestFileAttachment).not.toHaveBeenCalled()
    expect(res.processedAttachments.map((a) => a.type)).toEqual(['image', 'image'])
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('reports pages that were cut', async () => {
    const render = vi.fn().mockResolvedValue({ images: pageImages(20), totalPages: 45 })
    await processAttachmentsForSend({
      ...base,
      attachments: [pdf({ sendAsImages: true })],
      serviceHub: hub() as never,
      modelSupportsVision: true,
      renderPdfPages: render,
    })
    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringContaining('"sent":20,"total":45')
    )
  })

  it('keeps text mode when the model cannot see images, even if toggled', async () => {
    const h = hub()
    const render = vi.fn()
    await processAttachmentsForSend({
      ...base,
      attachments: [pdf({ sendAsImages: true })],
      serviceHub: h as never,
      modelSupportsVision: false,
      renderPdfPages: render,
    })
    expect(render).not.toHaveBeenCalled()
    expect(h._uploads.ingestImage).not.toHaveBeenCalled()
  })

  it('keeps text mode by default for a normal PDF', async () => {
    const render = vi.fn()
    await processAttachmentsForSend({
      ...base,
      attachments: [pdf()],
      serviceHub: hub() as never,
      modelSupportsVision: true,
      renderPdfPages: render,
    })
    expect(render).not.toHaveBeenCalled()
  })

  it('sends a scanned PDF as pages and says why', async () => {
    const h = hub({
      ingestFileAttachment: vi
        .fn()
        .mockRejectedValue(new Error('PDF appears to be image-based or scanned.')),
    })
    const render = vi.fn().mockResolvedValue({ images: pageImages(1), totalPages: 1 })
    const res = await processAttachmentsForSend({
      ...base,
      parsePreference: 'embeddings',
      attachments: [pdf()],
      serviceHub: h as never,
      modelSupportsVision: true,
      renderPdfPages: render,
    })
    expect(render).toHaveBeenCalled()
    expect(res.processedAttachments[0].type).toBe('image')
    expect(res.hasEmbeddedDocuments).toBe(false)
    expect(toastMock.info).toHaveBeenCalledWith(
      expect.stringContaining('composerChip.pdfScannedAsImages')
    )
  })

  it('still fails a scanned PDF for a model without vision', async () => {
    const h = hub({
      ingestFileAttachment: vi
        .fn()
        .mockRejectedValue(new Error('PDF appears to be image-based or scanned.')),
    })
    await expect(
      processAttachmentsForSend({
        ...base,
        parsePreference: 'embeddings',
        attachments: [pdf()],
        serviceHub: h as never,
        modelSupportsVision: false,
        renderPdfPages: vi.fn(),
      })
    ).rejects.toThrow(/scanned/)
  })
})
