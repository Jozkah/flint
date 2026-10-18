import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { showUndoToast } from '@/lib/toastUndo'
import { readFileAsText } from '@/lib/fileSafety'
import { DEFAULT_ATTACHMENT_LIMITS } from '@/lib/attachmentSupport'
import {
  LARGE_PASTE_MAX_BYTES,
  isLargePaste,
  nextPastedTextName,
} from '@/lib/largePaste'

// How long after Ctrl/Cmd+Shift+V the paste event still counts as a raw paste.
const RAW_PASTE_WINDOW_MS = 1000

// The undo toast is shown once per session, not on every large paste.
let announced = false

/** Reset the once-per-session toast. Tests only. */
export function resetLargePasteAnnouncement() {
  announced = false
}

type PasteLike = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
}

type KeyLike = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

type Options = {
  /** Attachments are switched on, so the composer can take a file. */
  enabled: boolean
  /** Names already attached to the draft. */
  attachedNames: readonly string[]
  /** Hand the file to the pipeline a picked file goes through. */
  attach: (file: File) => Promise<void> | void
  /** Put the text into the composer as if it had been pasted normally. */
  insertText: (text: string) => void
  /** Take an attachment back off the draft. */
  detach: (name: string) => void
  t: (key: string, options?: Record<string, unknown>) => string
}

/**
 * Turns a large plain-text paste into a `pasted-text-<n>.txt` attachment.
 * Everything else (short text, images, files, Ctrl/Cmd+Shift+V) is left to the
 * editor: `handlePaste` returns false and the caller carries on as before.
 */
export function useLargePaste(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const rawUntil = useRef(0)
  const toastId = useRef<string | number | undefined>(undefined)

  // The offer belongs to this composer: leaving the chat takes it away.
  useEffect(
    () => () => {
      if (toastId.current !== undefined) toast.dismiss(toastId.current)
    },
    []
  )

  /** Call from the composer's keydown: Ctrl/Cmd+Shift+V pastes raw text. */
  const noteKeyDown = useCallback((event: KeyLike) => {
    if (
      event.key.toLowerCase() === 'v' &&
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey
    ) {
      rawUntil.current = Date.now() + RAW_PASTE_WINDOW_MS
    }
  }, [])

  /** Returns true when it took the paste over (default already prevented). */
  const handlePaste = useCallback((event: PasteLike): boolean => {
    const raw = rawUntil.current > Date.now()
    rawUntil.current = 0
    const o = latest.current
    if (raw || !o.enabled) return false

    const data = event.clipboardData
    if (!data) return false
    const items = Array.from(data.items ?? [])
    if (
      (data.files?.length ?? 0) > 0 ||
      items.some((i) => i.kind === 'file' || i.type.startsWith('image/'))
    ) {
      return false
    }
    const text = data.getData('text/plain')
    if (!text || !isLargePaste(text)) return false

    const file = new File([text], nextPastedTextName(o.attachedNames), {
      type: 'text/plain',
    })
    // Text the pipeline would refuse is pasted as text rather than lost.
    if (
      file.size > LARGE_PASTE_MAX_BYTES ||
      o.attachedNames.length >= DEFAULT_ATTACHMENT_LIMITS.maxCount
    ) {
      return false
    }

    event.preventDefault()
    void (async () => {
      const read = await readFileAsText(file)
      if (!read.ok) {
        latest.current.insertText(text)
        return
      }
      await latest.current.attach(file)
      if (announced) return
      announced = true
      const { t, insertText, detach } = latest.current
      toastId.current = showUndoToast({
        message: t('common:largePaste.attached', { name: file.name }),
        description: t('common:largePaste.hint'),
        undoLabel: t('common:largePaste.undo'),
        // Not over the composer the paste went into.
        position: 'top-center',
        onUndo: () => {
          detach(file.name)
          insertText(text)
        },
      })
    })()
    return true
  }, [])

  return { handlePaste, noteKeyDown }
}
