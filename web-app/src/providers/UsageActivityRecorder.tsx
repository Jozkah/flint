import { useEffect, useRef } from 'react'
import { useAppState } from '@/hooks/useAppState'
import { useUsageStats } from '@/stores/usage-stats-store'

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
      stats.pushActivity({ kind: 'model-swapped', title: 'Model swapped', detail: `${unloaded[0]} to ${loaded[0]}` })
    } else {
      for (const m of loaded) stats.pushActivity({ kind: 'model-loaded', title: 'Model loaded', detail: m })
    }
  }, [activeModels])

  return null
}
