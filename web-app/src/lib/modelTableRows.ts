import { isEngineProviderName } from '@/lib/engineModels'
import { getProviderTitle } from '@/lib/utils'

export type ModelFilter = 'all' | 'local' | 'remote'

export type ModelTableRow<P, M> = { provider: P; model: M; local: boolean }

/** Every model of an enabled provider, with where it runs. */
export function buildModelRows<
  P extends { provider: string; active?: boolean; models: unknown[] },
>(providers: P[]): ModelTableRow<P, P['models'][number]>[] {
  return providers
    .filter((p) => p.active)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        provider,
        model,
        local: isEngineProviderName(provider.provider),
      }))
    )
}

/** The rows that pass the local/remote filter and match `query` by id, name or provider title. */
export function filterModelRows<
  P extends { provider: string },
  M extends { id: string; name?: string },
>(
  rows: ModelTableRow<P, M>[],
  filter: ModelFilter,
  query: string
): ModelTableRow<P, M>[] {
  const q = query.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'local') === r.local) &&
      (!q ||
        r.model.id.toLowerCase().includes(q) ||
        (r.model.name ?? '').toLowerCase().includes(q) ||
        getProviderTitle(r.provider.provider).toLowerCase().includes(q))
  )
}
