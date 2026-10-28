import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { dragHasFiles, looksLikeDirectory } from '@/lib/fileDrop'
import { classifyAttachment } from '@/lib/attachmentSupport'

/** The composer box's own drop zone (ChatInput). */
const COMPOSER = '[data-drop-zone]'

/**
 * Zones inside the pane that handle their own drops. A drop the composer box
 * or the code panel claims never bubbles here (both stop propagation), but a
 * drag over them must not light the pane overlay either.
 */
const OWN_ZONES = `${COMPOSER}, [data-testid="code-drop-zone"]`

/**
 * Hand `files` to the composer's existing drop handler by re-dispatching the
 * drop on its zone, so the composer's intake (documents saved to disk, images
 * re-encoded, audio and video behind a capability question) runs unchanged.
 * Scoped to this pane's composer, so a split view attaches to the right chat.
 */
function deliverToComposer(composer: Element, files: File[]) {
  let transfer: DataTransfer | { files: File[]; types: string[] }
  try {
    const dt = new DataTransfer()
    files.forEach((f) => dt.items.add(f))
    transfer = dt
  } catch {
    transfer = { files, types: ['Files'] }
  }
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  composer.dispatchEvent(event)
}

const insideOwnZone = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(OWN_ZONES) !== null

/**
 * Files no attachment path can take, whatever the model: not an image,
 * audio, video, document, text or code file. A folder is left to the
 * composer, which offers it as the project.
 */
export function unsupportedDropFiles(files: File[]): File[] {
  return files.filter(
    (f) =>
      !looksLikeDirectory(f) &&
      classifyAttachment({ name: f.name, mimeType: f.type }) === null
  )
}

/**
 * Makes the whole chat pane a drop target that attaches through the
 * composer. Spread `handlers` on the pane root; `active` drives the overlay.
 *
 * dragenter/dragleave fire for every child crossed, so a depth counter (not
 * relatedTarget, which Tauri reports as null) keeps the overlay from
 * flickering while the pointer moves over nested elements.
 */
export function useChatPaneDrop() {
  const { t } = useTranslation()
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return
    e.preventDefault()
    depth.current += 1
    setActive(!insideOwnZone(e.target))
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return
    e.preventDefault()
    setActive(!insideOwnZone(e.target))
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setActive(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      depth.current = 0
      setActive(false)
      const dt = e.dataTransfer
      const files = Array.from(dt?.files ?? [])
      if (!dt || files.length === 0 || insideOwnZone(e.target)) return
      e.preventDefault()
      e.stopPropagation()

      const unsupported = unsupportedDropFiles(files)
      if (unsupported.length > 0) {
        toast.error(
          t('common:chatPaneDrop.unsupported', {
            names: unsupported.map((f) => f.name).join(', '),
          })
        )
      }
      const rest = files.filter((f) => !unsupported.includes(f))
      if (rest.length === 0) return

      const composer = (e.currentTarget as Element).querySelector(COMPOSER)
      if (composer) deliverToComposer(composer, rest)
    },
    [t]
  )

  return {
    active,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
