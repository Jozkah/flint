import { createImageAttachment, type Attachment } from '@/types/attachment'

/**
 * Turning a PDF into page images, so a vision model can see scans, charts and
 * layout that text extraction loses (janhq/jan#8851). The pages then go
 * through the ordinary image ingest, so every vision provider gets them.
 */

/** At most this many pages are sent. */
export const PDF_PAGE_LIMIT = 20
/** Longest edge of one page image, in pixels. */
export const PDF_PAGE_MAX_EDGE = 1568
/** All pages of one PDF together stay under this many pixels. */
export const PDF_TOTAL_PIXEL_BUDGET = 40_000_000

export const isPdfAttachment = (
  att: Pick<Attachment, 'type' | 'fileType' | 'name' | 'path'>
): boolean =>
  att.type === 'document' &&
  (att.fileType?.toLowerCase() === 'pdf' ||
    /\.pdf$/i.test(att.path ?? att.name ?? ''))

/** Whether a PDF chip may offer "send pages as images": only to a vision model. */
export const canSendPdfAsImages = (
  att: Pick<Attachment, 'type' | 'fileType' | 'name' | 'path'>,
  modelSupportsVision: boolean
): boolean => modelSupportsVision && isPdfAttachment(att)

/** The text-extraction failure the indexer reports for a PDF without text. */
export const isScannedPdfError = (err: unknown): boolean =>
  /image-based or scanned|no extractable text/i.test(
    err instanceof Error ? err.message : String(err ?? '')
  )

/** Scale that fits a page (in PDF points at scale 1) under the edge cap. */
export const pageScale = (width: number, height: number, maxEdge = PDF_PAGE_MAX_EDGE): number => {
  const edge = Math.max(width, height)
  return edge > 0 ? maxEdge / edge : 1
}

export type PdfPageRender = {
  images: Attachment[]
  totalPages: number
}

type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number }
  render: (o: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
  }) => { promise: Promise<unknown> }
  cleanup?: () => void
}

export type PdfDocumentLike = {
  numPages: number
  getPage: (n: number) => Promise<PdfPage>
  destroy?: () => Promise<unknown> | void
}

/** Draws one page and returns it as a PNG data URL. */
export type PageDrawer = (
  page: PdfPage,
  width: number,
  height: number,
  scale: number
) => Promise<string>

const drawToCanvas: PageDrawer = async (page, width, height, scale) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  // White under the page: a transparent PNG reads as black to some models.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale }) }).promise
  const url = canvas.toDataURL('image/png')
  canvas.width = 0
  canvas.height = 0
  return url
}

const stem = (name: string) => name.replace(/\.pdf$/i, '')

/**
 * Renders the first pages of an open PDF, stopping at the page limit or when
 * the next page would pass the pixel budget. Pure apart from `draw`, so the
 * caps are testable without a canvas.
 */
export async function renderPdfDocument(
  pdf: PdfDocumentLike,
  name: string,
  draw: PageDrawer = drawToCanvas,
  limits = { pages: PDF_PAGE_LIMIT, pixels: PDF_TOTAL_PIXEL_BUDGET, maxEdge: PDF_PAGE_MAX_EDGE }
): Promise<PdfPageRender> {
  const images: Attachment[] = []
  let pixels = 0
  const last = Math.min(pdf.numPages, limits.pages)
  for (let n = 1; n <= last; n++) {
    const page = await pdf.getPage(n)
    const base = page.getViewport({ scale: 1 })
    const scale = pageScale(base.width, base.height, limits.maxEdge)
    const width = Math.max(1, Math.round(base.width * scale))
    const height = Math.max(1, Math.round(base.height * scale))
    // Always keep the first page; later ones only while the budget holds.
    if (images.length > 0 && pixels + width * height > limits.pixels) break
    pixels += width * height
    const dataUrl = await draw(page, width, height, scale)
    page.cleanup?.()
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    images.push(
      createImageAttachment({
        name: `${stem(name)}-page-${n}.png`,
        base64,
        dataUrl,
        mimeType: 'image/png',
        size: Math.floor((base64.length * 3) / 4),
      })
    )
  }
  return { images, totalPages: pdf.numPages }
}

/** Loads pdf.js on first use: it is large and most chats never need it. */
async function openPdf(bytes: ArrayBuffer): Promise<PdfDocumentLike> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return (await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
    .promise) as unknown as PdfDocumentLike
}

/** Reads a PDF from disk and renders its first pages as image attachments. */
export async function renderPdfPages(doc: Attachment): Promise<PdfPageRender> {
  if (!doc.path) throw new Error(`${doc.name} is no longer available`)
  const { toAssetUrl } = await import('@/lib/assetPath')
  const res = await fetch(await toAssetUrl(doc.path))
  if (!res.ok) throw new Error(res.statusText || String(res.status))
  const pdf = await openPdf(await res.arrayBuffer())
  try {
    return await renderPdfDocument(pdf, doc.name)
  } finally {
    await pdf.destroy?.()
  }
}
