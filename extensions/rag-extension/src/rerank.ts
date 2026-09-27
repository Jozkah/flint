/**
 * Optional Jev reranking of a retrieval shortlist.
 *
 * Retrieval stays Flint's: the vector search decides which passages are
 * candidates, and every citation object -- id, text, score, file id, chunk
 * order -- is passed through untouched. Jev (in the backend, `core::jev`)
 * may only reorder a bounded shortlist. With the opt-in off, retrieval runs
 * exactly as before: one search for `top_k`, no extra call. On any failure,
 * abstention, or an order that is not a permutation of the shortlist, the
 * search's own top `k` is used.
 */

export type Citation = {
  id: string | number
  text: string
  score: number
  file_id: string
  chunk_file_order?: number
}

export type RerankMode = 'off' | 'shadow' | 'on'

export type JevBridge = {
  status: () => Promise<{ rerank_mode: RerankMode }>
  rerank: (args: {
    query: string
    candidates: { id: string; text: string }[]
    k: number
  }) => Promise<{ order: string[] | null; fallback: string | null; model: string | null }>
}

/** The most candidates Jev is shown, matching the backend's cap. */
export const MAX_SHORTLIST = 20

/** How many candidates to fetch for Jev to choose `topK` from. */
export function shortlistSize(topK: number): number {
  return Math.min(MAX_SHORTLIST, Math.max(topK * 3, topK + 5))
}

/**
 * The first `k` citations in `order`, as the very same objects, or null when
 * `order` is not exactly the shortlist's ids.
 */
export function applyOrder(shortlist: Citation[], order: string[], k: number): Citation[] | null {
  if (order.length !== shortlist.length) return null
  const byId = new Map(shortlist.map((c) => [String(c.id), c]))
  if (byId.size !== shortlist.length) return null
  const out: Citation[] = []
  const used = new Set<string>()
  for (const id of order) {
    const c = byId.get(id)
    if (!c || used.has(id)) return null
    used.add(id)
    out.push(c)
  }
  return out.slice(0, k)
}

export type RerankResult = {
  citations: Citation[]
  /** Whether Jev's order was used. */
  reranked: boolean
  mode: RerankMode
}

/**
 * Retrieve through `search(limit)`, reranking when the opt-in says so.
 * `bridge` is absent outside the desktop app.
 */
export async function retrieveWithRerank(
  query: string,
  topK: number,
  search: (limit: number) => Promise<Citation[]>,
  bridge?: JevBridge
): Promise<RerankResult> {
  let mode: RerankMode = 'off'
  if (bridge) {
    try {
      mode = (await bridge.status()).rerank_mode ?? 'off'
    } catch {
      mode = 'off'
    }
  }
  if (mode !== 'shadow' && mode !== 'on') {
    return { citations: await search(topK), reranked: false, mode: 'off' }
  }
  const shortlist = await search(shortlistSize(topK))
  const baseline = shortlist.slice(0, topK)
  if (shortlist.length < 2) return { citations: baseline, reranked: false, mode }
  try {
    const decision = await bridge!.rerank({
      query,
      candidates: shortlist.map((c) => ({ id: String(c.id), text: c.text ?? '' })),
      k: topK,
    })
    if (mode !== 'on' || !decision.order) return { citations: baseline, reranked: false, mode }
    const ordered = applyOrder(shortlist, decision.order, topK)
    return ordered
      ? { citations: ordered, reranked: true, mode }
      : { citations: baseline, reranked: false, mode }
  } catch {
    return { citations: baseline, reranked: false, mode }
  }
}

/** The desktop app's bridge, when there is one. */
export function jevBridge(): JevBridge | undefined {
  const api = (globalThis as { core?: { api?: Record<string, (a?: unknown) => Promise<unknown>> } })
    .core?.api
  if (!api?.jevStatus || !api?.jevRerank) return undefined
  return {
    status: () => api.jevStatus() as ReturnType<JevBridge['status']>,
    rerank: (args) => api.jevRerank(args) as ReturnType<JevBridge['rerank']>,
  }
}
