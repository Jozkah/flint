import { useEffect, useRef, useState } from 'react'
import { sessionWorkspacePath } from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * Resolve a session's writable sandbox directory.
 *
 * Returns `null` while the lookup for the current session is in flight, so a
 * caller never reads one session's files against another's directory. Two
 * rules make that hold:
 *
 * - the path is cleared the moment `sessionId` changes, before the lookup
 *   starts, rather than being left at the previous session's value; and
 * - a lookup that resolves after the session moved on is dropped, so slow
 *   round trips cannot arrive out of order and win.
 */
export function useSessionWorkspacePath(
  sessionId: string | null | undefined
): string | null {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  // Which lookup is current. A counter, not the session id: switching away
  // from A and back starts a second lookup for A, and the first one's answer
  // must still lose — it was issued before the switch and may name a directory
  // that has since been recreated.
  const currentRun = useRef(0)

  useEffect(() => {
    const run = ++currentRun.current
    setWorkspacePath(null)
    if (!sessionId) return
    void (async () => {
      try {
        const dataFolder = await getServiceHub().app().getJanDataFolder()
        if (!dataFolder) return
        const path = await sessionWorkspacePath(dataFolder, sessionId)
        if (currentRun.current === run) setWorkspacePath(path)
      } catch {
        // A missing path only costs the workspace pill its subtitle.
      }
    })()
  }, [sessionId])

  return workspacePath
}
