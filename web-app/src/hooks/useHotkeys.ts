import { useEffect, useMemo, useRef } from 'react'
import { useRouter } from '@tanstack/react-router'
import { isMac } from '@/lib/shortcuts'
import { useKeybindings } from '@/hooks/useKeybindings'

interface UseKeyboardShortcutProps {
  key: string
  metaKey?: boolean // Will be used for macOS
  ctrlKey?: boolean // Will be used for Windows/Linux
  altKey?: boolean
  shiftKey?: boolean
  callback?: () => void
  excludeRoutes?: string[]
  usePlatformMetaKey?: boolean // If true, will use Command on Mac and Ctrl on Windows/Linux
}

const NO_ROUTES: string[] = []

export function useKeyboardShortcut({
  key,
  metaKey = false,
  ctrlKey = false,
  altKey = false,
  shiftKey = false,
  callback,
  excludeRoutes = NO_ROUTES,
  usePlatformMetaKey = false,
}: UseKeyboardShortcutProps) {
  // If usePlatformMetaKey is true, use Command on Mac and Ctrl on Windows/Linux
  const effectiveMetaKey = useMemo(() => {
    if (usePlatformMetaKey) {
      return isMac
    }
    return metaKey
  }, [metaKey, usePlatformMetaKey])

  const effectiveCtrlKey = useMemo(() => {
    if (usePlatformMetaKey) {
      return !isMac
    }
    return ctrlKey
  }, [ctrlKey, usePlatformMetaKey])
  const router = useRouter()
  // Read at keypress time, so a new callback or route list each render does
  // not tear the window listener down and put it back.
  const callbackRef = useRef(callback)
  const excludeRoutesRef = useRef(excludeRoutes)
  useEffect(() => {
    callbackRef.current = callback
    excludeRoutesRef.current = excludeRoutes
  })

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // A shortcut is being rebound: the chord pressed is the new binding, not
      // a command. Also stand down for an event something already handled.
      if (e.defaultPrevented || useKeybindings.getState().recording) return
      // Check if we're on an excluded route
      // The route at keypress time, not the one of the last render (P2F-012).
      if (excludeRoutesRef.current.includes(router.state.location.pathname)) {
        // console.warn('Excluded route, not executing shortcut')
        return
      }

      // Check if the key combination matches
      if (
        e.key.toLowerCase() === key.toLowerCase() &&
        e.metaKey === effectiveMetaKey &&
        e.ctrlKey === effectiveCtrlKey &&
        e.altKey === altKey &&
        e.shiftKey === shiftKey
      ) {
        e.preventDefault()

        callbackRef.current?.()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    key,
    effectiveMetaKey,
    effectiveCtrlKey,
    altKey,
    shiftKey,
    router,
  ])
}
