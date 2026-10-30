import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useAppState } from '@/hooks/useAppState'
import { useServiceHub } from '@/hooks/useServiceHub'

/** How often the loaded models are re-read while the window is in view. */
export const ACTIVE_MODELS_POLL_MS = 10_000

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

/**
 * Keeps `activeModels` (the sidebar's "N models loaded", Summary toggles,
 * offload status) in step with the engine on every page. It used to be read
 * only by the model settings screens, so a model the router autoloaded for a
 * chat, or the state after a webview reload, showed as 0 loaded (SH-001).
 * Re-read at start, when a load finishes, when the window comes back, and on
 * a slow poll while visible; unloads also arrive as their own event.
 */
export function ActiveModelsSync() {
  const serviceHub = useServiceHub()

  useEffect(() => {
    let alive = true
    // Only the newest read is applied: an older, slower answer must not
    // overwrite a newer one (a model would flick back to loaded).
    let latest = 0
    const refresh = () => {
      const seq = ++latest
      void serviceHub
        .models()
        .getActiveModels()
        .then((models) => {
          if (!alive || seq !== latest) return
          const next = models ?? []
          const { activeModels, setActiveModels } = useAppState.getState()
          if (!sameList(activeModels, next)) setActiveModels(next)
        })
        .catch(() => {})
    }
    refresh()

    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible')
        refresh()
    }, ACTIVE_MODELS_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)

    // A load the router started (a chat's first message) ends here.
    const unsubscribe = useAppState.subscribe((s, prev) => {
      const wasLoading =
        prev.loadingModel || Object.values(prev.loadingModels).some(Boolean)
      const isLoading =
        s.loadingModel || Object.values(s.loadingModels).some(Boolean)
      if (wasLoading && !isLoading) refresh()
    })
    const unlistenLoad = listen<{ value?: number }>(
      'llamacpp-model-load-progress',
      (event) => {
        if ((event.payload?.value ?? 0) >= 1) refresh()
      }
    ).catch(() => () => {})

    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
      unsubscribe()
      void unlistenLoad.then((fn) => fn?.())
    }
  }, [serviceHub])

  return null
}
