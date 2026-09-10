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

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  memoryProposalsList,
  type MemoryLocation,
  type PendingProposal,
} from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * @param sessionId Show only the proposals raised in this chat. Omit to show
 *   every proposal awaiting an answer, which is what the settings page wants.
 * @param enabled Skip the work entirely -- a temporary chat records nothing, so
 *   there is nothing for it to ask about.
 */
export function useMemoryProposals({
  sessionId,
  enabled = true,
}: {
  sessionId?: string
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

  const location: MemoryLocation | null = useMemo(
    () =>
      dataFolder == null
        ? null
        : {
            dataFolder,
            projectRoot: window.core?.api?.projectRoot ?? undefined,
            sessionId: sessionId ?? window.core?.api?.activeSessionId ?? undefined,
          },
    [dataFolder, sessionId]
  )

  const reload = useCallback(async () => {
    if (!location || !enabled) {
      setProposals([])
      return
    }
    try {
      const all = await memoryProposalsList(location)
      setProposals(
        sessionId ? all.filter((p) => p.sourceSessionId === sessionId) : all
      )
    } catch {
      // Outside a chat or project the backend refuses rather than returning an
      // empty list. Either way there is nothing to answer, and a toast about a
      // background poll would be noise.
      setProposals([])
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
