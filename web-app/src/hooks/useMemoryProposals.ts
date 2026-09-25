/**
 * Memories an agent proposed and nobody has answered yet.
 *
 * The backend stores a proposal as a record with `Status::Proposed`, so a
 * question asked during one turn is still there on the next one and after a
 * restart. That is the point of reading them from disk here rather than
 * remembering the tool result in renderer state: a card shown once, in a chat
 * the user had already scrolled away from, is a question that never got asked.
 *
 * Proposals are never memories. `is_usable` admits `Active` only, so an
 * unanswered guess is not injected into any prompt while it waits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  memoryProposalsList,
  type MemoryLocation,
  type PendingProposal,
} from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'
import { memoryLocation } from '@/lib/memoryBinding'

/**
 * @param sessionId Show only the proposals raised in this chat. Omit to show
 *   every proposal awaiting an answer, which is what the settings page wants.
 * @param enabled Skip the work entirely -- a temporary chat records nothing, so
 *   there is nothing for it to ask about.
 */
export function useMemoryProposals({
  sessionId,
  janProjectId,
  projectRoot,
  enabled = true,
}: {
  sessionId?: string
  /**
   * The Flint project the chat (or the Settings page's project picker) is in, so
   * project-scoped proposals are listed and can be answered. Without it the
   * backend has no project and refuses project scope.
   */
  janProjectId?: string
  /** A project folder, for a surface bound to one. Wins over `janProjectId`. */
  projectRoot?: string
  enabled?: boolean
} = {}) {
  // `null` until fetched, so "not loaded yet" is distinguishable from "loaded
  // and there is no data folder" instead of sending a call that cannot succeed.
  const [dataFolder, setDataFolder] = useState<string | null>(null)
  const [proposals, setProposals] = useState<PendingProposal[]>([])

  useEffect(() => {
    let cancelled = false
    getServiceHub()
      .app()
      .getJanDataFolder()
      .then((folder) => {
        if (!cancelled) setDataFolder(folder ?? '')
      })
      .catch(() => {
        if (!cancelled) setDataFolder('')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Named by the caller. This used to read `window.core.api.projectRoot`,
  // which nothing defines, so no project was ever in scope here.
  const location: MemoryLocation | null = useMemo(
    () =>
      dataFolder == null
        ? null
        : memoryLocation(
            dataFolder,
            { projectRoot, janProjectId },
            sessionId ?? window.core?.api?.activeSessionId ?? undefined
          ),
    [dataFolder, sessionId, janProjectId, projectRoot]
  )

  // The primary thread pane keeps this hook mounted across a thread switch, so
  // a list requested for the previous thread can answer after the current
  // one's. Only the most recently issued reload may write the list.
  const reloadSeq = useRef(0)
  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current
    // Development preview (dev/previewSeed.ts): the browser has no backend.
    if (import.meta.env.DEV && enabled) {
      const preview = (
        window as unknown as { __flintPreview?: { memoryProposals?: PendingProposal[] } }
      ).__flintPreview?.memoryProposals
      if (preview) {
        setProposals(
          sessionId ? preview.filter((p) => p.sourceSessionId === sessionId) : preview
        )
        return
      }
    }
    if (!location || !enabled) {
      setProposals([])
      return
    }
    try {
      const all = await memoryProposalsList(location)
      if (seq !== reloadSeq.current) return
      setProposals(
        sessionId ? all.filter((p) => p.sourceSessionId === sessionId) : all
      )
    } catch {
      // Outside a chat or project the backend refuses rather than returning an
      // empty list. Either way there is nothing to answer, and a toast about a
      // background poll would be noise.
      if (seq === reloadSeq.current) setProposals([])
    }
  }, [location, enabled, sessionId])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * Drop a proposal the backend has already answered. The card round-trips
   * first; this only stops it being drawn again before the next reload.
   */
  const onResolved = useCallback((id: string) => {
    setProposals((current) => current.filter((p) => p.id !== id))
  }, [])

  return { proposals, location, reload, onResolved }
}
