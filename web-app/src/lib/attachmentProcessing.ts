import { ServiceHub } from '@/services'
import { Attachment } from '@/types/attachment'
import type { UploadResult } from '@/services/uploads/types'
import { toast } from 'sonner'
import { embedImageDescriptions } from '@/lib/imageDescription'
import { estimateTokens } from '@/lib/context-manager'
import { knownContextWindow } from '@/lib/knownContextWindow'
import { useAttachmentIngestionPrompt } from '@/hooks/useAttachmentIngestionPrompt'
import { i18n } from '@/i18n/react-i18next-compat'
import {
  isPdfAttachment,
  isScannedPdfError,
  renderPdfPages as renderPdfPagesDefault,
  type PdfPageRender,
} from '@/lib/pdfPageImages'

type AttachmentProcessingStatus = 'processing' | 'done' | 'error' | 'clear_all'

export type AttachmentIngestProgress = {
  completed: number
  total: number
}

type AttachmentProcessingOptions = {
  attachments: Attachment[]
  threadId: string
  projectId?: string
  serviceHub: ServiceHub
  selectedProvider?: string
  /**
   * Whether the selected model can call tools. An embedded document is read
   * back through the retrieval tool, so a model that cannot call it gets every
   * document in its prompt instead (janhq/jan#9388).
   */
  modelSupportsTools?: boolean
  /**
   * Whether the selected model can see images. A PDF can then go as page
   * images: when the user asks for it, or when it has no text to extract.
   */
  modelSupportsVision?: boolean
  /** Test seam for the PDF page renderer. */
  renderPdfPages?: (doc: Attachment) => Promise<PdfPageRender>
  contextThreshold?: number
  estimateTokens?: (text: string) => Promise<number | undefined>
  parsePreference: 'auto' | 'inline' | 'embeddings' | 'prompt'
  autoFallbackMode?: 'inline' | 'embeddings'
  perFileChoices?: Map<string, 'inline' | 'embeddings'>
  updateAttachmentProcessing?: (
    name: string,
    status: AttachmentProcessingStatus,
    updatedAttachment?: Partial<Attachment>
  ) => void
  /** Fired when attachment ingestion advances (multi-file uploads). */
  onIngestProgress?: (state: AttachmentIngestProgress) => void
}

export type AttachmentProcessingResult = {
  processedAttachments: Attachment[]
  hasEmbeddedDocuments: boolean
}

const formatAttachmentError = (err: unknown): string => {
  if (!err) return 'Unknown error'
  if (err instanceof Error) return err.message || err.toString()
  if (typeof err === 'string') return err
  if (Array.isArray(err)) {
    const parts = err.map((e) => formatAttachmentError(e)).filter(Boolean)
    return parts.length
      ? Array.from(new Set(parts)).join('; ')
      : 'Unknown error'
  }
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>
    const candidates = [obj.message, obj.reason, obj.detail]
    for (const val of candidates) {
      if (typeof val === 'string' && val.trim().length > 0) {
        return val
      }
    }
    const nestedSources = [obj.error, obj.cause]
    for (const nested of nestedSources) {
      if (nested && typeof nested === 'object') {
        const nestedMsg = formatAttachmentError(nested)
        if (nestedMsg && nestedMsg !== 'Unknown error') {
          return nestedMsg
        }
      } else if (typeof nested === 'string' && nested.trim().length > 0) {
        return nested
      }
    }
    if (typeof obj.code === 'string' && obj.code.trim().length > 0) {
      return obj.code
    }
    try {
      return JSON.stringify(obj)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

/** The attachment has no file on disk and no text of its own to send. */
export class MissingAttachmentError extends Error {
  constructor(public readonly attachmentName: string) {
    super(`${attachmentName} is no longer available`)
    this.name = 'MissingAttachmentError'
  }
}

/** A bare file name (no folder part), as a composer-read file is named. */
const isBareName = (path: string): boolean => !path.includes('/') && !path.includes('\\')

/**
 * Whether an attachment failure came from a file that is gone (the backend's
 * "not found" / os error 2), so the toast can say so instead of printing JSON.
 */
export const isMissingFileError = (err: unknown): boolean =>
  err instanceof MissingAttachmentError ||
  // Only wording that names a file or path. A bare "not found" also matches an
  // embedding model, thread or provider that is missing, which is not a gone file.
  /os error (2|3)\b|no such file|cannot find the (file|path)|file not found/i.test(
    formatAttachmentError(err)
  )

/** A readable line for a failure: the message, never a raw JSON object. */
export const describeAttachmentFailure = (err: unknown): string => {
  const text = formatAttachmentError(err).trim()
  return text.startsWith('{') || text.startsWith('[') ? 'Unknown error' : text
}

type ParsePreference = AttachmentProcessingOptions['parsePreference']
export type IngestionChoice = 'inline' | 'embeddings'

/** Async token estimator in the shape processAttachmentsForSend expects. */
export const estimateAttachmentTokens = async (
  text: string
): Promise<number | undefined> => estimateTokens(text)

/**
 * Token budget an 'auto' document may use to be inlined: the model's known
 * context window times the user's auto-inline ratio, minus what the
 * conversation already occupies. Undefined when the window is unknown, so the
 * caller asks the user instead of guessing.
 */
export const resolveAutoInlineBudget = (
  model: unknown,
  provider: unknown,
  ratio: number | undefined,
  usedTokens = 0
): number | undefined => {
  if (!model || typeof ratio !== 'number' || !(ratio > 0)) return undefined
  const window = knownContextWindow(
    model as Parameters<typeof knownContextWindow>[0],
    provider as Parameters<typeof knownContextWindow>[1]
  )
  if (!window) return undefined
  const budget = Math.floor(window * ratio) - usedTokens
  return budget > 0 ? budget : undefined
}

/**
 * Whether the user must pick inline vs embeddings for a document. 'auto' only
 * asks when there is no budget to decide by size.
 */
export const needsIngestionChoice = (
  doc: Attachment,
  parsePreference: ParsePreference,
  hasInlineBudget: boolean
): boolean => {
  if (doc.type !== 'document' || doc.processed || doc.injectionMode) return false
  const preference = doc.parseMode ?? parsePreference
  return preference === 'prompt' || (preference === 'auto' && !hasInlineBudget)
}

/**
 * Asks the user, one document at a time, whether to inline or embed it.
 * Resolves to each choice keyed by document path, or undefined as soon as the
 * user cancels.
 */
export const promptIngestionChoices = async (
  docs: Attachment[]
): Promise<Map<string, IngestionChoice> | undefined> => {
  const choices = new Map<string, IngestionChoice>()
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]
    const choice = await useAttachmentIngestionPrompt
      .getState()
      .showPrompt(doc, 0, i, docs.length)
    if (!choice) return undefined
    if (doc.path) choices.set(doc.path, choice)
  }
  return choices
}

/** Records each choice as its document's parseMode, which send time honours. */
export const applyIngestionChoices = (
  attachments: Attachment[],
  choices: Map<string, IngestionChoice>
): Attachment[] =>
  attachments.map((att) => {
    const mode = att.path ? choices.get(att.path) : undefined
    return mode ? { ...att, parseMode: mode } : att
  })

/**
 * Whether a document goes into the prompt or into the retrieval index. Pure:
 * everything it needs (a parse that happened, a token count) is passed in.
 * A model that cannot call the retrieval tool always gets the document inline;
 * project files are always embedded; `auto` and `prompt` take the user's
 * per-file choice, then the fallback, and `auto` alone compares the document's
 * size with the context threshold when there was no choice.
 */
export const resolveDocumentMode = (input: {
  preference: ParsePreference | undefined
  projectId?: string
  needsInline: boolean
  userChoice?: IngestionChoice
  autoFallbackMode?: IngestionChoice
  tokenCount?: number
  contextThreshold?: number
}): IngestionChoice => {
  if (input.needsInline) return 'inline'
  if (input.projectId) return 'embeddings'
  if (input.preference === 'auto' || input.preference === 'prompt') {
    const base = input.userChoice ?? input.autoFallbackMode ?? 'embeddings'
    if (
      input.preference === 'auto' &&
      !input.userChoice &&
      typeof input.tokenCount === 'number' &&
      input.contextThreshold
    ) {
      return input.tokenCount <= input.contextThreshold ? 'inline' : 'embeddings'
    }
    return base
  }
  return input.preference === 'inline' ? 'inline' : 'embeddings'
}

/**
 * Audio and video go as they are: nothing to ingest, only marked ready, in
 * the order they were attached (audio first, then video).
 */
export const passThroughMedia = (attachments: Attachment[]): Attachment[] => [
  ...attachments.filter((a) => a.type === 'audio'),
  ...attachments.filter((a) => a.type === 'video'),
].map((a) => ({ ...a, processed: true, processing: false }))

export const processAttachmentsForSend = async (
  options: AttachmentProcessingOptions
): Promise<AttachmentProcessingResult> => {
  const {
    attachments,
    threadId,
    projectId,
    serviceHub,
    contextThreshold,
    estimateTokens,
    parsePreference,
    autoFallbackMode,
    perFileChoices,
    updateAttachmentProcessing,
    onIngestProgress,
  } = options

  const processedAttachments: Attachment[] = []
  let hasEmbeddedDocuments = false

  const imagesToProcess = attachments.filter(
    (img) => img.type === 'image' && !(img.processed && img.id)
  )
  const documentsToProcess = attachments.filter(
    (doc) =>
      doc.type === 'document' &&
      !(doc.processed && (doc.id || doc.injectionMode === 'inline'))
  )
  const ingestTotal = imagesToProcess.length + documentsToProcess.length
  let ingestCompleted = 0
  const bumpIngest = () => {
    if (!onIngestProgress || ingestTotal <= 0) return
    ingestCompleted += 1
    onIngestProgress({
      completed: Math.min(ingestCompleted, ingestTotal),
      total: ingestTotal,
    })
  }
  if (onIngestProgress && ingestTotal > 0) {
    onIngestProgress({ completed: 0, total: ingestTotal })
  }
  const effectiveContextThreshold =
    typeof contextThreshold === 'number' &&
    Number.isFinite(contextThreshold) &&
    contextThreshold > 0
      ? contextThreshold
      : undefined
  const notifyUpdate = (
    ...args: Parameters<
      NonNullable<AttachmentProcessingOptions['updateAttachmentProcessing']>
    >
  ) => updateAttachmentProcessing?.(...args)
  /**
   * The updated attachment is built once: the same patch is what the send
   * carries and what the UI is told, so the two cannot drift apart.
   */
  const completeAttachment = (att: Attachment, patch: Partial<Attachment>) => {
    processedAttachments.push({ ...att, ...patch })
    notifyUpdate(att.name, 'done', patch)
  }

  const visionModel = options.modelSupportsVision === true
  const renderPages = options.renderPdfPages ?? renderPdfPagesDefault
  /** Whether a PDF that has no text to extract can go as page images instead. */
  const canFallBackToImages = (doc: Attachment) => visionModel && isPdfAttachment(doc)
  /**
   * Sends a PDF as page images through the image ingest, in place of the
   * document. Says so when pages were left out, or when it happened because
   * the PDF had no text.
   */
  const sendPdfAsImages = async (doc: Attachment, scanned: boolean) => {
    const { images, totalPages } = await renderPages(doc)
    if (images.length === 0) throw new Error(`Couldn't render the pages of ${doc.name}`)
    for (const img of images) {
      const res = await serviceHub.uploads().ingestImage(threadId, img)
      processedAttachments.push({ ...img, id: res.id, processed: true, processing: false })
    }
    notifyUpdate(doc.name, 'done', { processing: false, processed: true })
    if (scanned) {
      toast.info(i18n.t('common:composerChip.pdfScannedAsImages', { name: doc.name }))
    }
    if (images.length < totalPages) {
      toast.warning(
        i18n.t('common:composerChip.pdfPagesCut', {
          name: doc.name,
          sent: images.length,
          total: totalPages,
        })
      )
    }
    bumpIngest()
  }

  // Images: ingest before sending
  const images = attachments.filter((a) => a.type === 'image')
  if (images.length > 0) {
    for (const img of images) {
      try {
        if (img.processed && img.id) {
          processedAttachments.push(img)
          continue
        }

        notifyUpdate(img.name, 'processing')

        const res = await serviceHub.uploads().ingestImage(threadId, img)
        completeAttachment(img, {
          id: res.id,
          processed: true,
          processing: false,
        })
        bumpIngest()
      } catch (err) {
        console.error(`Failed to ingest image ${img.name}:`, err)
        notifyUpdate(img.name, 'error')
        const desc = formatAttachmentError(err)
        toast.error('Failed to ingest image attachment', { description: desc })
        throw err instanceof Error ? err : new Error(desc)
      }
    }
  }

  // Descriptions of the images, stored as documents so the conversation can
  // search them (off unless the user turned it on).
  if (images.length > 0) {
    const described = await embedImageDescriptions({ images, threadId, projectId, serviceHub })
    if (described.length > 0) {
      processedAttachments.push(...described)
      hasEmbeddedDocuments = true
    }
  }

  processedAttachments.push(...passThroughMedia(attachments))

  const documents = attachments.filter((a) => a.type === 'document')
  for (const doc of documents) {
    try {
      // Text read in the composer (a large paste, a dropped .txt) already
      // carries its content and has no file on disk to parse or index.
      // The content wins over the flags: a copy that lost `processed` on its
      // way here must not send a name that is not a file to the indexer.
      // A document already indexed for retrieval stays embedded even when it
      // also carries text: the text must not turn it into an inline one.
      const alreadyEmbedded =
        !!doc.processed && !!doc.id && doc.injectionMode === 'embeddings'
      if (
        alreadyEmbedded ||
        doc.inlineContent ||
        (doc.processed && (doc.id || doc.injectionMode === 'inline'))
      ) {
        hasEmbeddedDocuments =
          hasEmbeddedDocuments ||
          alreadyEmbedded ||
          (!doc.inlineContent && doc.injectionMode !== 'inline')
        processedAttachments.push(
          !alreadyEmbedded && doc.inlineContent && !doc.injectionMode
            ? { ...doc, injectionMode: 'inline' }
            : doc
        )
        // Counted in the total, so it counts as done too, or the progress
        // never reaches the end (LIBA-011).
        if (documentsToProcess.includes(doc)) bumpIngest()
        continue
      }

      if (!doc.path || isBareName(doc.path)) {
        // A name, not a file: only text read in the composer is named this way,
        // and it carries its content. Without it there is nothing to read.
        throw new MissingAttachmentError(doc.name)
      }

      notifyUpdate(doc.name, 'processing')

      if (doc.sendAsImages && canFallBackToImages(doc)) {
        await sendPdfAsImages(doc, false)
        continue
      }

      const targetPreference = doc.parseMode ?? parsePreference
      let parsedContent: string | undefined

      // A model that cannot call the retrieval tool can only use a document
      // that is in its prompt, whatever the preference or the document's size.
      const needsInline = options.modelSupportsTools === false

      const canInline =
        (needsInline || (!projectId && targetPreference !== 'embeddings')) && !!doc.path

      if (canInline) {
        try {
          parsedContent = await serviceHub
            .rag()
            .parseDocument?.(doc.path!, doc.fileType)
        } catch (err) {
          console.warn(`Failed to parse ${doc.name} for inline use`, err)
        }
      }

      if (needsInline && !parsedContent && canFallBackToImages(doc)) {
        // A scanned PDF: no text, but a vision model can read its pages.
        await sendPdfAsImages(doc, true)
        continue
      }

      if (needsInline && !parsedContent) {
        // An embedded copy would be unreachable, so a document that could not
        // be read as text fails the send rather than going without its content.
        throw new Error(
          `Couldn't read ${doc.name} as text. This model can't search files, so the document can't be added.`
        )
      }

      // Check if user made a per-file choice for this document
      const userChoice = perFileChoices?.get(doc.path || '')
      let tokenCount: number | undefined
      // Only estimate when nothing else decides it (auto, no choice, not a project file).
      if (!needsInline && targetPreference === 'auto' && !projectId && !userChoice) {
        if (parsedContent && estimateTokens) {
          const estimatedTokens = await estimateTokens(parsedContent)
          tokenCount =
            typeof estimatedTokens === 'number' &&
            Number.isFinite(estimatedTokens) &&
            estimatedTokens > 0
              ? estimatedTokens
              : undefined
          if (!effectiveContextThreshold) {
            console.debug(
              `Attachment ${doc.name}: no context threshold available; using the default mode`
            )
          } else if (tokenCount === undefined) {
            console.debug(
              `Attachment ${doc.name}: token estimate unavailable or non-positive; using the default mode`
            )
          }
        } else if (!parsedContent) {
          console.debug(
            `Attachment ${doc.name}: parsed content unavailable for token estimation; using the default mode`
          )
        } else {
          console.debug(
            `Attachment ${doc.name}: token estimator unavailable; using the default mode`
          )
        }
      }

      const targetMode = resolveDocumentMode({
        preference: targetPreference,
        projectId,
        needsInline,
        userChoice,
        autoFallbackMode,
        tokenCount,
        contextThreshold: effectiveContextThreshold,
      })

      if (targetMode === 'inline' && parsedContent) {
        completeAttachment(doc, {
          processing: false,
          processed: true,
          inlineContent: parsedContent,
          injectionMode: 'inline',
        })
        bumpIngest()
        continue
      }

      // Default: ingest as embeddings.
      // Also reached when targetMode is 'inline' but parsedContent is absent
      // (i.e. parsing failed above) — intentional: embeddings is the safe fallback.
      notifyUpdate(doc.name, 'processing')

      let res: UploadResult
      try {
        res = projectId
          ? await serviceHub.uploads().ingestFileAttachmentForProject(projectId, doc)
          : await serviceHub.uploads().ingestFileAttachment(threadId, doc)
      } catch (err) {
        if (!isScannedPdfError(err) || !canFallBackToImages(doc)) throw err
        await sendPdfAsImages(doc, true)
        continue
      }

      completeAttachment(doc, {
        id: res.id,
        size: res.size ?? doc.size,
        chunkCount: res.chunkCount ?? doc.chunkCount,
        processing: false,
        processed: true,
        injectionMode: 'embeddings',
      })
      hasEmbeddedDocuments = true
      bumpIngest()
    } catch (err) {
      console.error(`Failed to ingest ${doc.name}:`, err)
      notifyUpdate(doc.name, 'error')
      const desc = formatAttachmentError(err)
      if (!(err instanceof MissingAttachmentError)) {
        toast.error('Failed to index attachments', { description: desc })
      }
      throw err instanceof Error ? err : new Error(desc)
    }
  }

  return { processedAttachments, hasEmbeddedDocuments }
}
