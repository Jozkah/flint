import { useEffect, useRef } from 'react'
import { useAppState } from '@/hooks/useAppState'
import { useUsageStats } from '@/stores/usage-stats-store'
import { i18n } from '@/i18n/react-i18next-compat'

/**
 * Notes models loading and unloading in the Overview activity feed. The
 * first list seen is the state at start-up, not a change, so it is skipped.
 */
export function UsageActivityRecorder() {
  const activeModels = useAppState((s) => s.activeModels)
  const previous = useRef<string[] | null>(null)

  useEffect(() => {
    const before = previous.current
    previous.current = activeModels
    if (before === null) return
    const loaded = activeModels.filter((m) => !before.includes(m))
    const unloaded = before.filter((m) => !activeModels.includes(m))
    const stats = useUsageStats.getState()
    if (loaded.length && unloaded.length) {
      // Translated as recorded (F9x1-011).
      stats.pushActivity({
        kind: 'model-swapped',
        title: i18n.t('overview:activityModelSwapped'),
        detail: i18n.t('overview:activitySwapDetail', { from: unloaded[0], to: loaded[0] }),
      })
    } else {
      for (const m of loaded) {
        stats.pushActivity({ kind: 'model-loaded', title: i18n.t('overview:activityModelLoaded'), detail: m })
      }
    }
  }, [activeModels])

  return null
}
