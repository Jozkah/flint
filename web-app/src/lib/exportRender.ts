/**
 * Render an export for the two formats that are pictures of a page: PDF (a
 * hidden iframe and the system print dialog, where "Save as PDF" is a
 * destination) and PNG (an SVG `foreignObject` drawn onto a canvas).
 *
 * Nothing here is sent to a server and no dependency is added: the Markdown is
 * turned into HTML with react-markdown, which is already part of the app and
 * does not pass raw HTML through, so message text cannot inject markup into the
 * print frame.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderMarkdown, type ExportDoc, type RenderOptions } from '@/lib/exportMarkdown'

/** Browsers refuse canvases past about 16k pixels on a side. */
export const MAX_CANVAS_PX = 16000
/** Width of the page, in CSS pixels, for the PNG. */
export const IMAGE_WIDTH = 820

const CSS = `
*{box-sizing:border-box}
body,.flint-export{margin:0;font:14px/1.6 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1c1c1e;background:#fff}
.flint-export{padding:28px 32px}
h1{font-size:22px;margin:0 0 8px}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b6b70;margin:22px 0 6px}
h3,h4{margin:14px 0 6px}
blockquote{margin:0 0 14px;padding:0 0 0 12px;border-left:3px solid #d4d4d8;color:#6b6b70}
p{margin:0 0 10px;overflow-wrap:anywhere}
hr{border:0;border-top:1px solid #e4e4e7;margin:18px 0}
pre{background:#f4f4f5;border-radius:6px;padding:10px 12px;overflow-wrap:anywhere;white-space:pre-wrap;font:12px/1.5 Consolas,Menlo,monospace}
code{font:12px Consolas,Menlo,monospace;background:#f4f4f5;border-radius:3px;padding:1px 4px}
pre code{background:none;padding:0}
table{border-collapse:collapse;margin:0 0 12px}
th,td{border:1px solid #d4d4d8;padding:4px 8px}
ul,ol{margin:0 0 10px;padding-left:22px}
em{color:#6b6b70}
@media print{@page{margin:16mm}.flint-export{padding:0}h2{break-after:avoid}pre,blockquote,table{break-inside:avoid}}
`

/** The document as an HTML fragment (no scripts, no raw HTML from the text). */
export function renderHtmlBody(doc: ExportDoc, options: RenderOptions = {}): string {
  const markdown = renderMarkdown(doc, options)
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown)
  )
}

/** A complete HTML page for the print frame. */
export function renderHtmlPage(doc: ExportDoc, options: RenderOptions = {}): string {
  const title = doc.title.replace(/[<>&"]/g, ' ')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body><div class="flint-export">${renderHtmlBody(doc, options)}</div></body></html>`
}

/**
 * Open the system print dialog on a hidden frame holding the document. The
 * user prints it or picks "Save as PDF". Resolves once the dialog has been
 * handed over, not once something was saved: the app cannot see the outcome.
 */
export function printDocument(doc: ExportDoc, options: RenderOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    let done = false
    const cleanup = () => {
      if (done) return
      done = true
      window.setTimeout(() => frame.remove(), 1000)
    }
    frame.onload = () => {
      const win = frame.contentWindow
      if (!win) {
        cleanup()
        reject(new Error('the print frame did not open'))
        return
      }
      win.addEventListener('afterprint', cleanup)
      try {
        win.focus()
        win.print()
        resolve()
      } catch (e) {
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      // Some webviews never fire `afterprint`; do not leak the frame.
      window.setTimeout(cleanup, 120_000)
    }
    frame.srcdoc = renderHtmlPage(doc, options)
    document.body.appendChild(frame)
  })
}

export type ImageResult =
  | { ok: true; base64: string; width: number; height: number }
  | { ok: false; message: string }

/** Scale to draw at: sharp when the page is short, 1x when it is long. */
export function imageScale(height: number): number | null {
  if (height * 2 <= MAX_CANVAS_PX) return 2
  if (height <= MAX_CANVAS_PX) return 1
  return null
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Draw the document to a PNG. Refuses a page too tall for one canvas. */
export async function renderPng(
  doc: ExportDoc,
  options: RenderOptions = {}
): Promise<ImageResult> {
  // Lay the page out off screen first, to learn how tall it is.
  const probe = document.createElement('div')
  probe.className = 'flint-export'
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = `position:fixed;left:-99999px;top:0;width:${IMAGE_WIDTH}px;visibility:hidden`
  const style = document.createElement('style')
  style.textContent = CSS
  probe.innerHTML = renderHtmlBody(doc, options)
  probe.prepend(style)
  document.body.appendChild(probe)
  let height = 0
  let xhtml = ''
  try {
    height = Math.ceil(probe.scrollHeight)
    probe.removeChild(style)
    xhtml = new XMLSerializer().serializeToString(probe)
  } finally {
    probe.remove()
  }

  const scale = imageScale(height)
  if (scale === null) {
    return {
      ok: false,
      message: `the conversation is too long for one image (${height}px, the limit is ${MAX_CANVAS_PX}px); export it as PDF or Markdown`,
    }
  }
  const inner = xhtml
    .replace(/^<div[^>]*>/, '<div xmlns="http://www.w3.org/1999/xhtml" class="flint-export" style="width:' + IMAGE_WIDTH + 'px;background:#fff">')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${height}">` +
    `<foreignObject width="100%" height="100%"><style xmlns="http://www.w3.org/1999/xhtml">${CSS}</style>${inner}</foreignObject></svg>`

  try {
    const img = new Image()
    img.decoding = 'sync'
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('the page could not be drawn'))
    })
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    await loaded
    const canvas = document.createElement('canvas')
    canvas.width = IMAGE_WIDTH * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return { ok: false, message: 'no canvas is available to draw the image' }
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png')
    )
    if (!blob) return { ok: false, message: 'the image could not be encoded' }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return { ok: true, base64: toBase64(bytes), width: canvas.width, height: canvas.height }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
