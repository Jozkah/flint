import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { listen } from '@tauri-apps/api/event'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { errorText } from '@/lib/errorText'
import {
  SCHEDULE_EVENT,
  scheduleDelete,
  scheduleRunNow,
  scheduleSave,
  scheduleSetEnabled,
  schedulesList,
  type ScheduleEvent,
  type ScheduledTask,
  type ScheduledTaskView,
} from '@/lib/schedules'

/** How often the list re-reads while the page is open, for next-run times. */
const REFRESH_MS = 30_000

const inTauri = () => typeof IS_TAURI !== 'undefined' && IS_TAURI

export function useSchedules() {
  const { t } = useTranslation()
  const [views, setViews] = useState<ScheduledTaskView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!inTauri()) {
      setLoading(false)
      setError(t('schedules:unavailable'))
      return
    }
    try {
      setViews(await schedulesList())
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // The driver says when a run starts or ends; the page re-reads on each.
  useEffect(() => {
    if (!inTauri()) return
    let off: (() => void) | undefined
    let cancelled = false
    void listen<ScheduleEvent>(SCHEDULE_EVENT, (event) => {
      const e = event.payload
      if (e.kind === 'ended') {
        const status = t(`schedules:status.${e.status}`)
        const message = t('schedules:list.ended', { name: e.taskName, status })
        if (e.status === 'succeeded') toast.success(message)
        else toast.warning(message)
      }
      void refresh()
    }).then((fn) => {
      if (cancelled) fn()
      else off = fn
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [refresh, t])

  const save = useCallback(
    async (task: ScheduledTask): Promise<boolean> => {
      try {
        await scheduleSave(task)
        await refresh()
        return true
      } catch (e) {
        toast.error(t('schedules:saveFailed'), { description: errorText(e) })
        return false
      }
    },
    [refresh, t]
  )

  const remove = useCallback(
    async (id: string) => {
      try {
        await scheduleDelete(id)
        await refresh()
      } catch (e) {
        toast.error(t('schedules:deleteFailed'), { description: errorText(e) })
      }
    },
    [refresh, t]
  )

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await scheduleSetEnabled(id, enabled)
        await refresh()
      } catch (e) {
        toast.error(t('schedules:saveFailed'), { description: errorText(e) })
      }
    },
    [refresh, t]
  )

  const runNow = useCallback(
    async (id: string) => {
      try {
        const run = await scheduleRunNow(id)
        if (run.status === 'failed' || run.status === 'skipped') {
          toast.warning(t('schedules:runFailed'), { description: run.error ?? undefined })
        }
        await refresh()
      } catch (e) {
        toast.error(t('schedules:runFailed'), { description: errorText(e) })
      }
    },
    [refresh, t]
  )

  return { views, loading, error, refresh, save, remove, setEnabled, runNow }
}
