import type { FetchedPage } from '@janhq/tauri-plugin-websearch-api'
import { createDocumentAttachment, type Attachment } from '@/types/attachment'
import type { UploadResult } from '@/services/uploads/types'
import type { UrlSource } from '@/stores/project-url-sources-store'

/**
 * Add a web page to a project as a source: fetch it through the websearch
 * plugin's `web_fetch` (which refuses local and private addresses, caps the
 * body and extracts readable text, and goes through the Settings proxy),
 * save the text as a markdown file and ingest it like any project file.
 */

export type UrlSourceErrorCode =
  | 'invalidUrl'
  | 'blocked'
  | 'timeout'
  | 'notHtml'
  | 'tooLarge'
  | 'httpError'
  | 'failed'

export class UrlSourceError extends Error {
  constructor(
    readonly code: UrlSourceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'UrlSourceError'
  }
}

// Paths that name a file, not a page: the fetch reads them as text and the
// project would get noise, so they are refused before any request.
const NON_PAGE_EXTENSIONS = new Set([
  'pdf', 'zip', 'gz', 'tgz', '7z', 'rar', 'exe', 'msi', 'dmg', 'iso', 'bin',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'mp3', 'mp4',
  'wav', 'mov', 'avi', 'mkv', 'webm', 'docx', 'xlsx', 'pptx', 'woff', 'woff2',
])

/** Parse and check a typed address; only http(s) with a host is accepted. */
export function validateWebPageUrl(input: string): URL {
  const raw = input.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UrlSourceError('invalidUrl', raw)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new UrlSourceError('invalidUrl', raw)
  }
  const ext = url.pathname.split('/').pop()?.split('.').slice(1).pop()?.toLowerCase()
  if (ext && NON_PAGE_EXTENSIONS.has(ext)) {
    throw new UrlSourceError('notHtml', raw)
  }
  return url
}

function messageOf(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e)
}

/** Map a `web_fetch` rejection onto the reasons the panel explains. */
export function classifyFetchError(e: unknown): UrlSourceError {
  if (e instanceof UrlSourceError) return e
  const message = messageOf(e)
  const lower = message.toLowerCase()
  if (
    lower.includes('local or private address') ||
    lower.includes('is this machine') ||
    lower.includes('refused to fetch')
  )
    return new UrlSourceError('blocked', message)
  if (lower.includes('timed out') || lower.includes('timeout'))
    return new UrlSourceError('timeout', message)
  if (lower.includes('too large') || lower.includes('exceeds'))
    return new UrlSourceError('tooLarge', message)
  if (/http \d{3}/.test(lower)) return new UrlSourceError('httpError', message)
  return new UrlSourceError('failed', message)
}

/** A file name from the page title (or host), safe on every OS. */
export function fileNameForPage(title: string, url: URL): string {
  const base =
    Array.from(title, (c) => (c.charCodeAt(0) < 0x20 ? ' ' : c))
      .join('')
      .replace(/[<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/, '') || url.hostname
  return `${base}.md`
}

/** The saved file: a header naming the source, then the readable text. */
export function pageMarkdown(page: FetchedPage, url: string, fetchedAt: number): string {
  const title = page.title?.trim() || url
  return [
    `# ${title}`,
    '',
    `Source: ${url}`,
    `Fetched: ${new Date(fetchedAt).toISOString()}`,
    '',
    page.content.trim(),
    page.truncated ? '\n[page truncated at the size limit]' : '',
  ].join('\n')
}

export type UrlSourceDeps = {
  fetchPage: (url: string) => Promise<FetchedPage>
  saveFile: (fileName: string, text: string) => Promise<string>
  ingest: (projectId: string, attachment: Attachment) => Promise<UploadResult>
  deleteFile: (projectId: string, fileId: string) => Promise<void>
  now?: () => number
}

export type AddedWebPage = {
  source: UrlSource
  fileId: string
  name: string
  truncated: boolean
}

/** Fetch, save and ingest one page. Throws UrlSourceError. */
export async function addWebPageToProject(
  projectId: string,
  input: string,
  deps: UrlSourceDeps
): Promise<AddedWebPage> {
  const url = validateWebPageUrl(input)
  let page: FetchedPage
  try {
    page = await deps.fetchPage(url.toString())
  } catch (e) {
    throw classifyFetchError(e)
  }
  if (!page.content?.trim()) {
    throw new UrlSourceError('notHtml', url.toString())
  }
  const fetchedAt = (deps.now ?? Date.now)()
  const text = pageMarkdown(page, url.toString(), fetchedAt)
  const name = fileNameForPage(page.title ?? '', url)
  const path = await deps.saveFile(name, text)
  const attachment = createDocumentAttachment({
    name,
    path,
    fileType: 'md',
    size: new TextEncoder().encode(text).length,
  })
  const result = await deps.ingest(projectId, attachment)
  return {
    source: { url: url.toString(), fetchedAt, path },
    fileId: result.id,
    name,
    truncated: page.truncated,
  }
}

/**
 * Re-fetch a page source and re-index it: the new copy is ingested first, and
 * only then is the old file (and its chunks) removed, so a failed refresh
 * leaves the old copy in place.
 */
export async function refreshWebPageSource(
  projectId: string,
  oldFileId: string,
  source: UrlSource,
  deps: UrlSourceDeps
): Promise<AddedWebPage> {
  const added = await addWebPageToProject(projectId, source.url, deps)
  if (added.fileId !== oldFileId) await deps.deleteFile(projectId, oldFileId)
  return added
}
