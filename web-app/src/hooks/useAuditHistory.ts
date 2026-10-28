import { isServedByFlint } from '@/lib/platform/utils'
import { useEffect, useState } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import { errorText } from '@/lib/errorText'
import { permissionAuditRecent, type PermissionAuditRecord } from '@/lib/permissionAudit'

/** How many recorded decisions the page shows. */
export const HISTORY_LIMIT = 50
/** Decisions shown before "Show all": the log is reference, not the page. */
export const HISTORY_PREVIEW = 10

/** The audit log's recent decisions. The log is the desktop app's. */
export function useAuditHistory() {
  const [history, setHistory] = useState<PermissionAuditRecord[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyExpanded, setHistoryExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    // The audit log is the desktop app's; a browser shows that instead.
    if (isServedByFlint()) return
    void (async () => {
      try {
        const folder = await getServiceHub().app().getJanDataFolder()
        if (!folder) throw new Error('no data folder')
        const records = await permissionAuditRecent(folder, HISTORY_LIMIT)
        if (!cancelled) setHistory(records)
      } catch (error) {
        if (!cancelled) setHistoryError(errorText(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { history, historyError, historyExpanded, setHistoryExpanded }
}
