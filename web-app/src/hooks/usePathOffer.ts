import { useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { toAssetUrl } from '@/lib/assetPath'
import { readDroppedPaths } from '@/lib/droppedPaths'
import { withoutPastedPath } from '@/lib/fileDrop'
import { isPlatformTauri } from '@/lib/platform/utils'
import { isDocumentAttachmentName } from '@/constants/attachments'
import type { RichComposerHandle } from '@/containers/RichComposerEditor'
import { useLatestCallback } from '@/hooks/useLatestCallback'
import { useTranslation } from '@/i18n/react-i18next-compat'

export type PathOffer = {
  path: string
  kind: 'file' | 'folder'
  /** Every file a pasted URI list named, when there was more than a path. */
  paths?: string[]
  /** The text that was held back, put in the composer if the offer is declined. */
  raw?: string
  /** The path was pasted into the composer as text; accepting removes it. */
  inComposer?: boolean
}

/**
 * A path pasted or dropped into the composer, offered above the editor as an
 * attachment, and file URIs read from disk and attached.
 */
export function usePathOffer({
  attachmentsKey,
  isStreaming,
  pastedFolder,
  richComposerRef,
  latestPromptRef,
  setPrompt,
  attachFiles,
  attachDroppedDocuments,
  focusComposer,
}: {
  attachmentsKey: string
  isStreaming: boolean
  pastedFolder?: {
    attached: readonly string[]
    onAttach: (path: string) => void
  }
  richComposerRef: RefObject<RichComposerHandle | null>
  latestPromptRef: RefObject<string>
  setPrompt: (value: string) => void
  attachFiles: (files: File[]) => void
  attachDroppedDocuments: (files: File[]) => Promise<void>
  focusComposer: () => void
}) {
  const { t } = useTranslation()
  // A pasted path is still pasted as text; this only notices it and offers,
  // above the editor, to attach what it points at.
  const [pathOffer, setPathOffer] = useState<PathOffer | null>(null)
  const pathOfferRef = useRef(pathOffer)
  pathOfferRef.current = pathOffer
  // The offer, like the draft, belongs to the chat it was pasted in.
  useEffect(() => {
    setPathOffer(null)
  }, [attachmentsKey])

  // Dragged or copied files can arrive as `file://` URIs with no File objects
  // (Linux file managers), which would land in the editor as raw text. Read
  // them from disk and attach them like any other file.
  const attachFileUris = async (paths: string[]) => {
    const { files, folders, failed } = await readDroppedPaths(paths)
    for (const { error } of failed) {
      toast.error(t('common:pastedPath.failed'), { description: error })
    }
    // A folder is offered as the project, never read in. Only one offer fits
    // above the editor; any folder it cannot cover is named, not dropped.
    const offered = pastedFolder ? folders.slice(0, 1) : []
    if (offered.length > 0) setPathOffer({ path: offered[0], kind: 'folder' })
    for (const folder of folders.slice(offered.length)) {
      toast.error(t('common:pastedPath.failed'), { description: folder })
    }
    const documents = files.filter((f) => isDocumentAttachmentName(f.name))
    const others = files.filter((f) => !documents.includes(f))
    if (documents.length > 0) void attachDroppedDocuments(documents)
    if (others.length > 0) attachFiles(others)
    focusComposer()
  }

  /** Decline the offer; the text it held back goes into the composer instead. */
  const declinePathOffer = () => {
    const offer = pathOfferRef.current
    setPathOffer(null)
    if (offer?.raw) {
      if (typeof richComposerRef.current?.insertText === 'function')
        richComposerRef.current.insertText(offer.raw)
      else setPrompt(latestPromptRef.current + offer.raw)
    }
  }

  const offerPastedPath = async (candidate: string) => {
    if (!isPlatformTauri()) return
    // A UNC path would make the OS connect to that host on stat.
    if (/^[\\/]{2}/.test(candidate)) return
    try {
      const { fs } = await import('@janhq/core')
      const stat = await fs.fileStat(candidate)
      if (!stat) return
      if (stat.isDirectory) {
        if (!pastedFolder) return
        const same = (a: string) =>
          a.replace(/[\\/]+$/, '').toLowerCase() ===
          candidate.replace(/[\\/]+$/, '').toLowerCase()
        if (pastedFolder.attached.some(same)) return
        setPathOffer({ path: candidate, kind: 'folder', inComposer: true })
      } else {
        setPathOffer({ path: candidate, kind: 'file', inComposer: true })
      }
    } catch {
      // Not a path that exists: it was only text.
    }
  }

  const acceptPathOffer = async () => {
    const offer = pathOffer
    setPathOffer(null)
    if (!offer) return
    // The path was pasted as text too; once it is attached it is not part of
    // the message (C021).
    if (offer.inComposer) {
      const draft = latestPromptRef.current
      const cleaned = withoutPastedPath(draft, offer.path)
      if (cleaned !== draft) setPrompt(cleaned)
    }
    if (offer.kind === 'folder') {
      pastedFolder?.onAttach(offer.path)
      return
    }
    if (offer.paths) {
      await attachFileUris(offer.paths)
      return
    }
    try {
      const response = await fetch(await toAssetUrl(offer.path))
      if (!response.ok) throw new Error(response.statusText)
      const blob = await response.blob()
      const name = offer.path.split(/[\\/]/).filter(Boolean).pop() || 'file'
      const file = new File([blob], name, { type: blob.type })
      attachFiles([file])
    } catch (error) {
      toast.error(t('common:pastedPath.failed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
    focusComposer()
  }

  const declineLatest = useLatestCallback(declinePathOffer)
  // The offer belongs to the draft it was pasted into; sending ends it.
  useEffect(() => {
    // Not dropped silently: what was pasted still lands in the composer.
    if (isStreaming && pathOfferRef.current) declineLatest()
  }, [isStreaming, declineLatest])

  return {
    pathOffer,
    setPathOffer,
    attachFileUris,
    declinePathOffer,
    offerPastedPath,
    acceptPathOffer,
  }
}
