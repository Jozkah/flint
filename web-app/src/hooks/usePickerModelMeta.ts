import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppState } from '@/hooks/useAppState'
import { useModelOrder } from '@/hooks/useModelOrder'
import { modelUsageKey } from '@/lib/modelSort'
import type { PickerMeta } from '@/lib/pickerFilters'

const LOCAL_PROVIDERS = ['llamacpp', 'mlx']

/**
 * What the shared picker's filters need to know about a model, drawn from the
 * same records the composer's model list reads: the model's own capability
 * list, whether its provider runs on this machine, whether it is in memory,
 * and when it was last picked.
 */
export function modelPickerMeta(
  model: Model,
  provider: string,
  loadedIds: readonly string[],
  lastUsed: Readonly<Record<string, number>>
): PickerMeta {
  const local = LOCAL_PROVIDERS.includes(provider)
  const caps = [...(model.capabilities ?? [])]
  if (model.embedding && !caps.includes('embeddings')) caps.push('embeddings')
  return {
    kind: local ? 'local' : 'cloud',
    capabilities: caps,
    loaded: local ? loadedIds.includes(model.id) : undefined,
    lastUsedAt: lastUsed[modelUsageKey(provider, model.id)] || undefined,
  }
}

/** A function giving the picker metadata of a model; it changes when what it reads does. */
export function usePickerModelMeta() {
  const loadedIds = useAppState(useShallow((s) => s.activeModels))
  const lastUsed = useModelOrder((s) => s.lastUsed)
  return useCallback(
    (model: Model, provider: string) => modelPickerMeta(model, provider, loadedIds, lastUsed),
    [loadedIds, lastUsed]
  )
}
