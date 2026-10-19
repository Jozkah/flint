import { useEffect, useRef, useState } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  SHARED_FOLDER_UPDATED_EVENT,
  sharedFolder,
  type SharedFolderUpdatedPayload,
  type SharedFolderView,
} from '@/lib/sharedFolder'
import { SHARED_FOLDER_DEBOUNCE_MS } from '@/stores/shared-folder-store'

/** Claims lapse on a clock the backend does not announce; read again now and then. */
const REFRESH_MS = 30_000

/**
 * Who else is in this session's folder. Read when the session changes and
 * after each update event for its folder (debounced); null while unknown, with
 * no folder, or without a backend that knows (the browser build). The view
 * object is replaced only when its content changed, so a quiet refresh does
 * not re-render the bar.
 */
export function useSharedFolderView(sessionId: string | null | undefined): {
  view: SharedFolderView | null
  refresh: () => void
} {
  const [view, setView] = useState<SharedFolderView | null>(null)
  const folderKey = useRef<string | null>(null)
  const refreshRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    setView(null)
    folderKey.current = null
    if (!sessionId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      void sharedFolder
        .peers(sessionId)
        .then((next) => {
          if (stopped) return
          folderKey.current = next?.folderKey ?? null
          setView((prev) =>
            JSON.stringify(prev) === JSON.stringify(next) ? prev : next
          )
        })
        .catch(() => {
          if (!stopped) setView(null)
        })
    }
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(read, SHARED_FOLDER_DEBOUNCE_MS)
    }
    refreshRef.current = later
    read()
    const poll = setInterval(read, REFRESH_MS)
    let unlisten: (() => void) | undefined
    void getServiceHub()
      .events()
      .listen<SharedFolderUpdatedPayload>(
        SHARED_FOLDER_UPDATED_EVENT,
        ({ payload }) => {
          // Another folder's news is none of this bar's business.
          if (
            payload.sessionId === sessionId ||
            payload.folderKey == null ||
            folderKey.current == null ||
            payload.folderKey === folderKey.current
          )
            later()
        }
      )
      .then((fn) => {
        if (stopped) fn()
        else unlisten = fn
      })
      .catch(() => undefined)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      clearInterval(poll)
      unlisten?.()
    }
  }, [sessionId])

  return { view, refresh: () => refreshRef.current() }
}
