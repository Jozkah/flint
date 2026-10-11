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

/**
 * The folder for a new campaign, once it is known to be a git repository:
 * campaigns branch from the repository, so there is nothing to offer without
 * one. `null` while unknown or when it is not a repository.
 */
export function useCampaignFolder(): string | null {
  const folder = useCoworkSessions((s) =>
    folderForCampaign(s.sessions, s.currentId)
  )
  const [repo, setRepo] = useState<{ folder: string; ok: boolean } | null>(null)
  useEffect(() => {
    if (!folder) return
    let alive = true
    void isGitRepo(folder).then((ok) => alive && setRepo({ folder, ok }))
    return () => {
      alive = false
    }
  }, [folder])
  return folder && repo?.folder === folder && repo.ok ? folder : null
}
