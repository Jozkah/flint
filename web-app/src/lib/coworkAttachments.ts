import type { ServiceHub } from '@/services'
import type { Attachment } from '@/types/attachment'
import { processAttachmentsForSend } from '@/lib/attachmentProcessing'
import { shrinkImageDataUrl } from '@/lib/imageResize'
import type { RunAttachment } from '@/lib/remoteRunner'
import { i18n } from '@/i18n/react-i18next-compat'

/**
 * Files attached to a Cowork message.
 *
 * The composer stages documents and media in the attachments store, and Chat's
 * send path reads them from there. Cowork's used to take only the text, so
 * whatever was attached was dropped without a word when the message was sent.
 *
 * Cowork has no document search behind it (that is a chat-side retrieval tool),
 * so documents always travel the way chat calls "inline": their text goes into
 * the message itself, within a budget. Images, audio and video go as file parts
 * of the message.
 */

/** A media file as the composer hands it to `onSubmit`. */
export type SubmittedFile = { type: string; mediaType: string; url: string }

export type CoworkAttachmentInput = {
  /** Documents staged for this session, read from the store at send time. */
  docs: Attachment[]
  /** Media the composer passed with the message. */
  files?: SubmittedFile[]
}

export type PreparedAttachments = {
  /** Appended to the text the model receives: the documents, inlined. */
  modelSuffix: string
  /** Appended to what the transcript shows, so the message says what it carried. */
  shownNote: string
  /** Media parts for the model message. */
  parts: SubmittedFile[]
  /** Copies of the images small enough to keep in the saved transcript. */
  keptImages: string[]
  /** Documents that could not be read, with why. */
  failed: { name: string; error: string }[]
  /** Documents cut to fit the budget. */
  truncated: string[]
}

/** The most one document puts in the message, in characters. */
export const MAX_INLINE_CHARS_PER_FILE = 60_000
/** All documents of one message together. */
export const MAX_INLINE_CHARS_TOTAL = 150_000

/** A code fence longer than any run of backticks inside `text`. */
function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Documents inlined as text; pure, so the budget is testable without a backend. */
export function inlineDocumentsText(
  docs: readonly { name: string; content: string }[]
): { text: string; truncated: string[] } {
  const truncated: string[] = []
  const blocks: string[] = []
  let used = 0
  for (const doc of docs) {
    const room = MAX_INLINE_CHARS_TOTAL - used
    if (room <= 0) {
      truncated.push(doc.name)
      blocks.push(`### ${doc.name}\n\n(Not included: the message already carries the most attached text it can.)`)
      continue
    }
    const cap = Math.min(MAX_INLINE_CHARS_PER_FILE, room)
    const cut = doc.content.length > cap
    const body = cut ? doc.content.slice(0, cap) : doc.content
    used += body.length
    if (cut) truncated.push(doc.name)
    const fence = fenceFor(body)
    blocks.push(
      `### ${doc.name}\n\n${fence}\n${body}\n${fence}${
        cut ? `\n\n(Cut: the first ${cap} of ${doc.content.length} characters.)` : ''
      }`
    )
  }
  return {
    text: blocks.length ? `\n\n---\nAttached files (their contents are below):\n\n${blocks.join('\n\n')}` : '',
    truncated,
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/**
 * The media of a message as the server's `agent_run_start` takes them: base64
 * with a name and a type. Only images travel; audio, video and a file that is
 * not a data URL are counted in `unsupported` so the caller can say so.
 */
export function submittedToRunAttachments(files: SubmittedFile[]): {
  attachments: RunAttachment[]
  unsupported: number
} {
  const attachments: RunAttachment[] = []
  let unsupported = 0
  files.forEach((file, index) => {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(file.url)
    if (!match || !match[1].startsWith('image/')) {
      unsupported += 1
      return
    }
    const mime = match[1].toLowerCase()
    attachments.push({
      name: `image-${index + 1}.${EXTENSIONS[mime] ?? 'img'}`,
      mime,
      data: match[2],
    })
  })
  return { attachments, unsupported }
}

export async function prepareCoworkAttachments(
  input: CoworkAttachmentInput,
  ctx: { sessionId: string; serviceHub: ServiceHub }
): Promise<PreparedAttachments> {
  const parts = input.files ?? []
  const names: string[] = []
  const failed: PreparedAttachments['failed'] = []
  let doc = { text: '', truncated: [] as string[] }

  if (input.docs.length > 0) {
    // Cowork has no retrieval tool to search embedded documents with, so every
    // document is read whole, whatever the chat-side preference says.
    const inline = input.docs.map((d) => ({ ...d, parseMode: 'inline' as const }))
    // One document at a time: a file that is gone fails only itself, and a
    // document that already carries its text is never reported as failed
    // because another one in the batch could not be read.
    const processed: Attachment[] = []
    for (const d of inline) {
      try {
        const out = await processAttachmentsForSend({
          attachments: [d],
          threadId: ctx.sessionId,
          serviceHub: ctx.serviceHub,
          parsePreference: 'inline',
          autoFallbackMode: 'inline',
        })
        processed.push(...out.processedAttachments)
      } catch (e) {
        failed.push({ name: d.name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    const readable: { name: string; content: string }[] = []
    for (const a of processed) {
      if (a.type !== 'document') continue
      if (a.inlineContent && a.inlineContent.trim()) {
        readable.push({ name: a.name, content: a.inlineContent })
        names.push(a.name)
      } else {
        failed.push({ name: a.name, error: a.error ?? 'no readable text' })
      }
    }
    doc = inlineDocumentsText(readable)
  }

  // Images are shown in the transcript as themselves; the line names documents,
  // and any media that is not an image.
  const images = parts.filter((p) => p.mediaType.startsWith('image/'))
  const otherMedia = parts.length - images.length
  if (otherMedia > 0) names.push(i18n.t('common:coworkHelpers.mediaFiles', { count: otherMedia }))
  const keptImages = await Promise.all(images.map((p) => shrinkImageDataUrl(p.url)))

  return {
    modelSuffix: doc.text,
    shownNote: names.length ? `\n\n${i18n.t('common:coworkHelpers.attached', { names: names.join(', ') })}` : '',
    parts: [...parts],
    keptImages,
    failed,
    truncated: doc.truncated,
  }
}
