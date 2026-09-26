import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadGitStatus,
  type GitScope,
  type GitStatus,
} from '@/lib/coworkGit'

export type CoworkGitState = {
  scope: GitScope
  setScope: (scope: GitScope) => void
  status: GitStatus | null
  loading: boolean
  error: string | undefined
  /** Bumps on every completed (re)load, so callers can key diff caches on it. */
  nonce: number
  refresh: () => void
}

/**
 * Loads the attached project's read-only git working-tree status, refetching
 * whenever the folder or the comparison scope changes.
 *
 * The fetch is guarded by a monotonically increasing request id so a slow
 * response for a folder or scope the user has already moved on from can never
 * overwrite a newer one. `nonce` advances on each settled load, giving the
 * panel a stable key to invalidate its per-file diff cache after a refresh.
 */
export function useCoworkGitStatus(
  folder: string | null,
  /**
   * Re-read the status whenever this changes. The tree moves under a running
   * agent (edits, commits, undo), and a list read before that shows counts for
   * changes that are gone.
   */
  refreshKey?: unknown
): CoworkGitState {
  const [scope, setScope] = useState<GitScope>('working')
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const reqId = useRef(0)

  const refresh = useCallback(() => {
    const id = ++reqId.current
    if (!folder) {
      setStatus(null)
      setError(undefined)
      setLoading(false)
      setNonce((n) => n + 1)
      return
    }
    setLoading(true)
    setError(undefined)
    void (async () => {
      try {
        const next = await loadGitStatus(folder, scope)
        if (id !== reqId.current) return
        setStatus(next)
      } catch (e) {
        if (id !== reqId.current) return
        setStatus(null)
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (id === reqId.current) {
          setLoading(false)
          setNonce((n) => n + 1)
        }
      }
    })()
  }, [folder, scope])

  useEffect(() => {
    refresh()
  }, [refresh])

  const lastKey = useRef(refreshKey)
  useEffect(() => {
    if (Object.is(lastKey.current, refreshKey)) return
    lastKey.current = refreshKey
    refresh()
    // Only the key triggers this; folder and scope changes reload above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  return { scope, setScope, status, loading, error, nonce, refresh }
}
