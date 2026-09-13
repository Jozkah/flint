import { useEffect, useMemo } from 'react'
import { useLocation } from '@tanstack/react-router'
import { isCoworkRoute } from '@/constants/routes'
import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { composeWindowTitle, type WindowTitleInput } from '@/lib/windowTitle'

/**
 * Keep the main window's native title naming what it shows.
 *
 * Mounted once, in the main window's layout, so a secondary window (logs,
 * system monitor) keeps the title it was opened with.
 */
export function useWindowTitle(): string {
  const pathname = useLocation({ select: (l) => l.pathname })
  const threadTitle = useThreads((s) =>
    s.currentThreadId ? s.threads[s.currentThreadId]?.title : undefined
  )
  const session = useCoworkSessions((s) =>
    s.currentId ? s.sessions.find((x) => x.id === s.currentId) : undefined
  )
  const sessionTitle = session?.title
  const projectFolder = session?.folder

  const input: WindowTitleInput = useMemo(() => {
    if (isCoworkRoute(pathname)) {
      return { section: 'cowork', sessionTitle, projectFolder }
    }
    if (pathname.startsWith('/threads/')) {
      return { section: 'chat', threadTitle }
    }
    if (pathname.startsWith('/settings')) return { section: 'settings' }
    return { section: 'other' }
  }, [pathname, threadTitle, sessionTitle, projectFolder])

  const title = composeWindowTitle(input)

  useEffect(() => {
    document.title = title
    if (!IS_TAURI) return
    let cancelled = false
    import('@tauri-apps/api/webviewWindow')
      .then(({ getCurrentWebviewWindow }) => {
        if (cancelled) return
        const win = getCurrentWebviewWindow()
        if (win.label !== 'main') return
        return win.setTitle(title)
      })
      .catch((e) => console.warn('Could not set the window title:', e))
    return () => {
      cancelled = true
    }
  }, [title])

  return title
}
