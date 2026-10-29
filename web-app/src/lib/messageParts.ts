/**
 * What a chat message row derives from its parts: the images, the text to
 * copy, the files a user attached, whether a tool call is still pending, and
 * the citations its tool results carry. Pure, so each is tested directly.
 */
import type { UIMessage } from 'ai'
import type { ViewerImage } from '@/components/ImageViewer'
import type { RagCitation, WebCitation } from '@/components/Citations'
import { displayNameOf } from '@/lib/displayName'
import { extractFilesFromPrompt, type FileMetadata } from '@/lib/fileMetadata'
import { parseCitationsFromToolOutput } from '@/lib/citation-parser'
import { fetchedUrlOf } from '@/lib/webSources'
import { citationsForCopy } from '@/lib/webUrl'
import { CONTENT_TYPE } from '@/containers/message/types'

type Parts = UIMessage['parts']
type Role = UIMessage['role']
type LoosePart = {
  type?: string
  url?: string
  mediaType?: string
  filename?: string
  text?: string
  state?: string
  toolCallId?: string
  output?: unknown
}

const loose = (parts: Parts) => parts as unknown as LoosePart[]

const isImageFile = (p: LoosePart) =>
  p.type === 'file' && Boolean(p.url) && Boolean(p.mediaType?.startsWith('image/'))

/** The URLs of a message's image parts (the edit dialog shows them). */
export function imageUrlsOf(parts: Parts): string[] {
  return loose(parts)
    .filter(isImageFile)
    .map((p) => p.url as string)
}

/** The images a user attached, with their names, for the gallery and viewer. */
export function userImagesOf(role: Role, parts: Parts): ViewerImage[] {
  if (role !== 'user') return []
  return loose(parts)
    .filter(isImageFile)
    .map((p) => ({
      url: p.url as string,
      name: p.filename ? displayNameOf(p.filename) : p.filename,
    }))
}

/**
 * Whether any tool part has yet to reach a terminal state. While one is
 * pending the turn is not done, even if the SDK briefly reports 'ready'.
 */
export function hasPendingToolPart(parts: Parts): boolean {
  return loose(parts).some((part) => {
    if (!part.type?.startsWith('tool-')) return false
    return (
      part.state !== 'output-available' &&
      part.state !== 'output-error' &&
      part.state !== 'output-denied'
    )
  })
}

/** Whether a part's tool call waits on one of the pending approvals. */
export function awaitsApproval(
  parts: Parts,
  pending: Readonly<Record<string, unknown>>
): boolean {
  return loose(parts).some((part) =>
    Boolean(part.toolCallId && pending[part.toolCallId])
  )
}

export type ToolCitations = {
  ragCitations: RagCitation[]
  /** Part index -> offset of its first citation in `ragCitations`. */
  citationOffsets: Map<number, number>
  webCitations: WebCitation[]
  webReads: string[]
}

/**
 * RAG citations in part order, with each rag tool part's base offset so its
 * card numbering continues the global sequence the inline markers use; web
 * citations; and the URLs `web_fetch` read. Assistant messages only.
 */
export function collectToolCitations(role: Role, parts: Parts): ToolCitations {
  const ragCitations: RagCitation[] = []
  const webCitations: WebCitation[] = []
  const webReads: string[] = []
  const citationOffsets = new Map<number, number>()
  if (role === 'assistant') {
    const list = loose(parts)
    for (let i = 0; i < list.length; i++) {
      const part = list[i]
      if (!part.type?.startsWith('tool-')) continue
      if (part.state !== 'output-available') continue
      if (part.type === 'tool-web_fetch') {
        const url = fetchedUrlOf(part.output)
        if (url) webReads.push(url)
        continue
      }
      const parsed = parseCitationsFromToolOutput(part.output)
      if (parsed?.kind === 'rag') {
        citationOffsets.set(i, ragCitations.length)
        ragCitations.push(...parsed.citations)
      } else if (parsed?.kind === 'web') {
        webCitations.push(...parsed.citations)
      }
    }
  }
  return { ragCitations, citationOffsets, webCitations, webReads }
}

/** An assistant reply's non-empty text parts, joined (grounding input). */
export function assistantTextOf(role: Role, parts: Parts): string {
  if (role !== 'assistant') return ''
  return loose(parts)
    .filter((p) => p.type === CONTENT_TYPE.TEXT && p.text)
    .map((p) => p.text)
    .join('\n')
}

/** The files listed in a user message's first text part. */
export function attachedFilesOf(role: Role, parts: Parts): FileMetadata[] {
  if (role !== 'user') return []
  const first = loose(parts).find((p) => p.type === CONTENT_TYPE.TEXT)
  if (!first) return []
  return extractFilesFromPrompt(first.text as string).files
}

/**
 * The message's text for Copy. A reply's cite markers are chips on screen;
 * copied, they are links.
 */
export function copyTextOf(role: Role, parts: Parts): string {
  const text = loose(parts)
    .filter((p) => p.type === CONTENT_TYPE.TEXT)
    .map((p) => p.text)
    .join('\n')
  return role === 'assistant' ? citationsForCopy(text) : text
}
