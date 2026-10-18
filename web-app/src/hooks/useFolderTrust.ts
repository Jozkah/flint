import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  folderTrustStatus,
  needsTrustDecision,
  trustFolder,
  type FolderTrust,
} from '@/lib/folderTrust'
import { errorText } from '@/lib/errorText'

/** Folders the person chose "Not now" for, until the app is restarted. */
const postponed = new Set<string>()

/**
 * The trust question for one folder: whether to ask, and the two answers. The
 * question is asked only for a folder that carries hooks or agent definitions
 * and is not trusted yet; "Not now" leaves them off and does not ask again
 * until the app restarts, and "Trust" is for good.
 */
export function useFolderTrust(folder: string | null) {
  const [status, setStatus] = useState<FolderTrust | null>(null)
  const [, bump] = useState(0)

  useEffect(() => {
    setStatus(null)
    if (!folder) return
    let alive = true
    void folderTrustStatus(folder).then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [folder])

  const trust = useCallback(async () => {
    if (!folder) return
    try {
      setStatus(await trustFolder(folder))
    } catch (error) {
      toast.error(errorText(error))
    }
  }, [folder])

  const later = useCallback(() => {
    if (!folder) return
    postponed.add(folder)
    bump((n) => n + 1)
  }, [folder])

  const ask = needsTrustDecision(status) && !!folder && !postponed.has(folder)
  return { status, ask, trust, later }
}
