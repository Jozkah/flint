import { useState, type RefObject } from 'react'
import { isPlatformTauri } from '@/lib/platform/utils'
import { dragFileCount } from '@/lib/attachmentChip'
import {
  dropFilePaths,
  pasteFilePaths,
  pastedPath,
  transferText,
} from '@/lib/fileDrop'
import {
  clipboardImageFiles,
  clipboardMayHoldImage,
  missingMediaCapabilities,
  pastedImageFiles,
  pastedMediaFiles,
  pasteIsTextFirst,
  splitDroppedFiles,
} from '@/lib/composerIntake'
import { isDocumentAttachmentName } from '@/constants/attachments'
import type { Attachment } from '@/types/attachment'
import type { EnableableCapability } from '@/lib/modelCapabilityEnable'
import type { RichComposerHandle } from '@/containers/RichComposerEditor'
import type { PathOffer } from '@/hooks/usePathOffer'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useLargePaste } from '@/hooks/useLargePaste'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Files dragged onto or pasted into the composer: the drop rim, sorting a
 * drop or a paste into documents, images, audio and video, file URIs, pasted
 * paths, and a large text paste kept as an attachment.
 */
export function useComposerDropPaste({
  attachmentsKey,
  attachmentsEnabled,
  attachments,
  audioSupported,
  videoSupported,
  richComposerRef,
  latestPromptRef,
  setPrompt,
  attachFiles,
  processImageFiles,
  processAudioFiles,
  processVideoFiles,
  attachDroppedDocuments,
  requestCapabilities,
  attachFileUris,
  setPathOffer,
  offerPastedPath,
}: {
  attachmentsKey: string
  attachmentsEnabled: boolean
  attachments: Attachment[]
  audioSupported: boolean
  videoSupported: boolean
  richComposerRef: RefObject<RichComposerHandle | null>
  latestPromptRef: RefObject<string>
  setPrompt: (value: string) => void
  attachFiles: (files: File[]) => void
  processImageFiles: (files: File[]) => Promise<void>
  processAudioFiles: (files: File[]) => Promise<void>
  processVideoFiles: (files: File[]) => Promise<void>
  attachDroppedDocuments: (files: File[]) => Promise<void>
  requestCapabilities: (
    capabilities: EnableableCapability[],
    onEnabled: () => void | Promise<void>
  ) => void
  attachFileUris: (paths: string[]) => Promise<void>
  setPathOffer: (offer: PathOffer | null) => void
  offerPastedPath: (candidate: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const setAttachmentsForThread = useChatAttachments((s) => s.setAttachments)
  const [isDragOver, setIsDragOver] = useState(false)
  const [dragCount, setDragCount] = useState(0)

  // The drop zone is always live. Gating it on the model's media capabilities
  // meant a text-only model refused every drop, a plain `.txt` included, and
  // an image now opens a question rather than being turned away at the door.
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragCount(dragFileCount(e.dataTransfer))
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set dragOver to false if we're leaving the drop zone entirely
    // In Tauri, relatedTarget can be null, so we need to handle that case
    const relatedTarget = e.relatedTarget as Node | null
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      setIsDragOver(false)
      setDragCount(0)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setDragCount(0)

    if (!e.dataTransfer) {
      console.warn('No dataTransfer available in drop event')
      return
    }

    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length === 0) return

    const {
      audio: audioOnes,
      video: videoOnes,
      // Documents take the same path as the + button once saved to disk;
      // anything else keeps going to the image path.
      documents: documentOnes,
      images: imageOnes,
    } = splitDroppedFiles(dropped, isDocumentAttachmentName)
    const missing = missingMediaCapabilities(
      { audio: audioOnes.length, video: videoOnes.length },
      { audio: audioSupported, video: videoSupported }
    )
    const attachMedia = () => {
      if (documentOnes.length > 0) void attachDroppedDocuments(documentOnes)
      if (imageOnes.length > 0) attachFiles(imageOnes)
      if (audioOnes.length > 0) void processAudioFiles(audioOnes)
      if (videoOnes.length > 0) void processVideoFiles(videoOnes)
    }
    if (missing.length > 0) requestCapabilities(missing, attachMedia)
    else attachMedia()
  }

  // Runs in the capture phase, before the editor's own drop handler, which
  // inserts text/uri-list or text/plain as text and runs before any bubbling
  // React handler. The editor leaves an already-cancelled event alone.
  const handleUriDrop = (e: React.DragEvent) => {
    const dt = e.dataTransfer
    if (!dt) return
    if ((dt.files?.length ?? 0) > 0) {
      // Real File objects: handleDrop attaches them. Only stop the editor
      // also inserting the URI text WebKitGTK sends alongside them.
      e.preventDefault()
      return
    }
    if (!isPlatformTauri()) return
    // Any web page can put a local path in the text a dragged link or image
    // carries, so only GNOME's own drag type attaches by itself; the rest is
    // asked about first, as a paste is.
    const named = dropFilePaths(dt)
    if (!named) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setDragCount(0)
    if (named.trusted) void attachFileUris(named.paths)
    else
      setPathOffer({
        path: named.paths[0],
        kind: 'file',
        paths: named.paths,
        raw: transferText(dt),
      })
  }

  const largePaste = useLargePaste({
    enabled: attachmentsEnabled,
    attachedNames: attachments.map((a) => a.name),
    attach: (file) => processImageFiles([file]),
    insertText: (text) => {
      if (richComposerRef.current) richComposerRef.current.insertText(text)
      else setPrompt(latestPromptRef.current + text)
    },
    detach: (name) =>
      setAttachmentsForThread(attachmentsKey, (prev) =>
        prev.filter((a) => a.name !== name)
      ),
    t,
  })

  const handlePaste = async (e: React.ClipboardEvent) => {
    // Files copied in a Linux file manager arrive as URIs (text/uri-list,
    // x-special/gnome-copied-files or a text/plain block), not File objects.
    // Checked first so a long list never becomes a .txt via largePaste.
    // Real File objects (macOS Finder) win; only GNOME's own clipboard type
    // attaches by itself, since a web page can forge the other two.
    const named = isPlatformTauri() ? pasteFilePaths(e.clipboardData) : null
    if (named) {
      e.preventDefault()
      if (named.trusted) void attachFileUris(named.paths)
      else
        setPathOffer({
          path: named.paths[0],
          kind: 'file',
          paths: named.paths,
          raw: transferText(e.clipboardData),
        })
      return
    }
    // A large text paste becomes a .txt attachment; default is prevented
    // before anything below can await.
    if (largePaste.handlePaste(e)) return
    const pasted = pastedPath(e.clipboardData?.getData('text/plain') ?? '')
    if (pasted) void offerPastedPath(pasted)
    const mediaItems = e.clipboardData?.items
    if (mediaItems && mediaItems.length > 0) {
      const { audio: audioFiles, video: videoFiles } =
        pastedMediaFiles(mediaItems)
      if (audioFiles.length > 0 || videoFiles.length > 0) {
        e.preventDefault()
        const missing = missingMediaCapabilities(
          { audio: audioFiles.length, video: videoFiles.length },
          { audio: audioSupported, video: videoSupported }
        )
        const attachMedia = async () => {
          if (audioFiles.length > 0) await processAudioFiles(audioFiles)
          if (videoFiles.length > 0) await processVideoFiles(videoFiles)
        }
        if (missing.length > 0) requestCapabilities(missing, attachMedia)
        else await attachMedia()
          return
      }
    }

    // Pasted images are handled whatever the model can read: one it
    // cannot see opens the question below rather than being dropped on
    // the floor, which is what gating this on vision amounted to.
    const clipboardItems = e.clipboardData?.items
    // Spreadsheet cells and Office/browser selections put a rendered picture
    // next to their text. The text is what was meant, so it wins unless the
    // clipboard holds a real file.
    if (pasteIsTextFirst(e.clipboardData)) return

    // Try clipboardData.items first (traditional method). Image items that
    // give no file fall through to the async clipboard below.
    if (clipboardItems && clipboardItems.length > 0) {
      const images = pastedImageFiles(clipboardItems)
      if (images.found) {
        e.preventDefault()
        if (images.files.length > 0) {
          attachFiles(images.files)
          return
        }
      }
    }

    // Modern Clipboard API fallback (for Linux, images copied from web, etc.)
    // Never for plain text: reading the clipboard this way makes WebView2 ask
    // the user for permission ("wants to see text and images copied...").
    const mayHoldImage = clipboardMayHoldImage(
      Array.from(e.clipboardData?.types ?? [])
    )
    if (mayHoldImage && navigator.clipboard && 'read' in navigator.clipboard) {
      try {
        const files = await clipboardImageFiles(await navigator.clipboard.read())

        if (files.length > 0) {
          e.preventDefault()
          attachFiles(files)
          return
        }
      } catch (error) {
        console.error('Clipboard API access failed:', error)
      }
    }

    // If we reach here, no image was found - allow normal text pasting to continue
    console.log('No image data found in clipboard, allowing normal text paste')
  }

  return {
    isDragOver,
    dragCount,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleUriDrop,
    handlePaste,
    largePaste,
  }
}
