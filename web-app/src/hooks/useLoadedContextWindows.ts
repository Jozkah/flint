/**
 * The context window each loaded local model actually runs with, read from the
 * engine (`/props` n_ctx). An empty Context Size lets the engine auto-fit the
 * window, so the configured value alone cannot say what was chosen.
 */
import { useEffect, useState } from 'react'
import { getLocalPropsExtension } from '@/lib/llamacppRouterProps'

export function useLoadedContextWindows(
  provider: string | undefined,
  loadedIds: string[]
): Record<string, number> {
  const [windows, setWindows] = useState<Record<string, number>>({})
  const key = [...loadedIds].sort().join('\n')
  useEffect(() => {
    const ext = getLocalPropsExtension(provider)
    const ids = key ? key.split('\n') : []
    if (!ext?.getModelProps || ids.length === 0) {
      setWindows({})
      return
    }
    let current = true
    void Promise.all(
      ids.map((id) =>
        ext.getModelProps!(id)
          .then((p) => [id, p?.nCtx] as const)
          .catch(() => [id, undefined] as const)
      )
    ).then((pairs) => {
      if (!current) return
      const out: Record<string, number> = {}
      for (const [id, n] of pairs) if (typeof n === 'number' && n > 0) out[id] = n
      setWindows(out)
    })
    return () => {
      current = false
    }
  }, [provider, key])
  return windows
}

/**
 * The Context column: the window the engine runs with when the model is
 * loaded (marked auto-fit when no size is saved), else the saved size, else
 * "auto".
 */
export function contextColumn(
  live: number | undefined,
  configured: number | undefined,
  t: (key: string) => string
): { value: string; note?: string; title?: string } {
  if (live && !configured)
    return {
      value: live.toLocaleString(),
      note: t('providers:table.contextAutoFit'),
      title: t('providers:table.contextAutoFitTitle'),
    }
  if (live) return { value: live.toLocaleString() }
  if (configured) return { value: configured.toLocaleString() }
  return {
    value: t('providers:table.contextAuto'),
    title: t('providers:table.contextAutoTitle'),
  }
}
