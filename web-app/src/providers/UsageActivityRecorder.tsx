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
  const synced = useAppState((s) => s.activeModelsSynced)
  const previous = useRef<string[] | null>(null)

  useEffect(() => {
    const before = previous.current
    previous.current = activeModels
    // Until the engine has been read, the list is the store's empty default;
    // the first real list is start-up state, not a load (LIBC-030).
    if (!synced || before === null) {
      if (!synced) previous.current = null
      return
    }
    const loaded = activeModels.filter((m) => !before.includes(m))
    const unloaded = before.filter((m) => !activeModels.includes(m))
    const stats = useUsageStats.getState()
    if (loaded.length && unloaded.length) {
      // Keys are stored with the text so the feed follows a language switch;
      // the text stays as the fallback and for search.
      const vars = { from: unloaded[0], to: loaded[0] }
      stats.pushActivity({
        kind: 'model-swapped',
        title: i18n.t('overview:activityModelSwapped'),
        titleKey: 'overview:activityModelSwapped',
        detail: i18n.t('overview:activitySwapDetail', vars),
        detailKey: 'overview:activitySwapDetail',
        detailVars: vars,
      })
    } else {
      for (const m of loaded) {
        stats.pushActivity({
          kind: 'model-loaded',
          title: i18n.t('overview:activityModelLoaded'),
          titleKey: 'overview:activityModelLoaded',
          detail: m,
        })
      }
      for (const m of unloaded) {
        stats.pushActivity({
          kind: 'model-unloaded',
          title: i18n.t('overview:activityModelUnloaded'),
          titleKey: 'overview:activityModelUnloaded',
          detail: m,
        })
      }
    }
  }, [activeModels, synced])

  return null
}
