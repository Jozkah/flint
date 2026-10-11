import { useEffect, useState } from 'react'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { isGitRepo } from '@/lib/coworkParallel'

/**
 * The folder "New campaign" would work on: the open session's folder, else the
 * folder of the most recently used session. `null` when there is none.
 */
export function folderForCampaign(
  sessions: readonly { id: string; folder: string | null; updated: number }[],
  currentId: string | null
): string | null {
  const current = sessions.find((s) => s.id === currentId)
  if (current?.folder) return current.folder
  const recent = [...sessions]
    .filter((s) => s.folder)
    .sort((a, b) => b.updated - a.updated)[0]
  return recent?.folder ?? null
}

const CACHE_KEY = 'flint:campaign-repo-cache'
const memory = new Map<string, boolean>()
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')
    for (const [folder, ok] of Object.entries(raw)) {
      if (typeof ok === 'boolean') memory.set(folder, ok)
    }
  } catch {
    /* no cache: every folder starts unknown */
  }
}

/** The last known answer for a folder, or undefined when never asked. */
export function cachedRepoAnswer(folder: string): boolean | undefined {
  load()
  return memory.get(folder)
}

function remember(folder: string, ok: boolean) {
  load()
  memory.delete(folder)
  memory.set(folder, ok)
  try {
    // Bounded: the most recent folders only.
    const entries = [...memory.entries()].slice(-30)
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* storage unavailable: the answer lives for this session only */
  }
}

/** Test seam: forget what was learned. */
export function resetRepoCache() {
  memory.clear()
  loaded = true
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* ignore */
  }
}

export type CampaignFolderState = {
  /** The folder a campaign would work on; null when no session has one. */
  folder: string | null
  /**
   * Whether it is a git repository: true or false once known (a cached answer
   * counts at once, then the check refreshes it in the background), null
   * while it has never been asked.
   */
  isRepo: boolean | null
}

/**
 * The folder for a new campaign and what is known about it. Nothing waits on
 * the git check: the cached answer is read synchronously, so the UI can show
 * the right state on first paint and only changes if the answer changed.
 */
export function useCampaignFolderState(): CampaignFolderState {
  const folder = useCoworkSessions((s) =>
    folderForCampaign(s.sessions, s.currentId)
  )
  const [checked, setChecked] = useState<{ folder: string; ok: boolean } | null>(
    null
  )
  useEffect(() => {
    if (!folder) return
    let alive = true
    void isGitRepo(folder).then((ok) => {
      remember(folder, ok)
      if (alive) setChecked({ folder, ok })
    })
    return () => {
      alive = false
    }
  }, [folder])
  if (!folder) return { folder: null, isRepo: null }
  const fresh = checked?.folder === folder ? checked.ok : undefined
  return { folder, isRepo: fresh ?? cachedRepoAnswer(folder) ?? null }
}

/**
 * The folder to start a campaign in: null when there is none or it is known
 * not to be a repository. While unknown the folder is offered, so starting is
 * never held up by the check.
 */
export function useCampaignFolder(): string | null {
  const { folder, isRepo } = useCampaignFolderState()
  return folder && isRepo !== false ? folder : null
}
