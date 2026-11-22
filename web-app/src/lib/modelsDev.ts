/**
 * Token limits from models.dev, the open model database
 * (https://models.dev/api.json: `{ [providerId]: { models: { [modelId]:
 * { limit: { context, output } } } } }`).
 *
 * The only request made is a plain GET of that public file; nothing about the
 * user, their providers or their models is sent. The 7 MB download is reduced
 * to a small `provider -> model -> [context, output]` index that is cached for a
 * week, so a lookup is a one-off and works offline afterwards.
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** `[context window, max output]`; 0 where the entry has no such number. */
export type LimitPair = [number, number]
export type ModelsDevIndex = Record<string, Record<string, LimitPair>>

export type ModelsDevMatch = {
  contextWindow: number | null
  maxOutputTokens: number | null
  /** The models.dev provider and model id the numbers came from. */
  provider: string
  modelId: string
}

/** Flint provider names that differ from the models.dev provider id. */
const PROVIDER_ALIASES: Record<string, string> = {
  gemini: 'google',
  vertex: 'google-vertex',
  bedrock: 'amazon-bedrock',
  together: 'togetherai',
  'x-ai': 'xai',
  grok: 'xai',
  fireworks: 'fireworks-ai',
}

/**
 * Drop variant-tier suffixes (`gpt-5:flex`, `gpt-5:priority`, `model:free`,
 * Bedrock's `:0`). Variants share a model's limits and differ only in speed or
 * price, and models.dev (like OpenCode's auto-discovery) has no entry for them.
 */
export function stripVariantSuffix(id: string): string {
  let out = id.trim()
  while (true) {
    const i = out.lastIndexOf(':')
    // Keep a leading colon or an id that is only a suffix.
    if (i <= 0) return out
    out = out.slice(0, i)
  }
}

/**
 * Every id worth trying for a model, most specific first: the id as given,
 * then without its variant suffix, each also without a leading provider prefix
 * (`openai/gpt-5` -> `gpt-5`, `a/b/model` -> `b/model` -> `model`). Compared
 * case-insensitively, so the result is lower-cased and de-duplicated.
 */
export function idCandidates(raw: string): string[] {
  const forms: string[] = []
  const add = (v: string) => {
    const k = v.trim().toLowerCase()
    if (k && !forms.includes(k)) forms.push(k)
  }
  for (const base of [raw, stripVariantSuffix(raw)]) {
    add(base)
    const parts = base.split('/').filter(Boolean)
    // Dropping segments from the left: a/b/c -> b/c -> c.
    for (let i = 1; i < parts.length; i++) add(parts.slice(i).join('/'))
  }
  return forms
}

/** The leading `provider/` segment of a model id, if it has one. */
function prefixProvider(raw: string): string | null {
  const i = raw.indexOf('/')
  return i > 0 ? raw.slice(0, i).trim().toLowerCase() : null
}

function toMatch(
  provider: string,
  modelId: string,
  pair: LimitPair
): ModelsDevMatch | null {
  const [context, output] = pair
  if (context <= 0 && output <= 0) return null
  return {
    provider,
    modelId,
    contextWindow: context > 0 ? context : null,
    maxOutputTokens: output > 0 ? output : null,
  }
}

/**
 * Find a model's limits.
 *
 * 1. Under the model's own provider (and the prefix of its id, for
 *    `provider/model` ids), trying each normalised id in turn.
 * 2. Failing that, by id alone across every provider, but only when it is
 *    unambiguous: one provider has it, or every provider that does agrees.
 *    Disagreeing providers produce no answer rather than a guess.
 */
export function matchModelsDev(
  index: ModelsDevIndex,
  providerName: string,
  modelId: string
): ModelsDevMatch | null {
  const candidates = idCandidates(modelId)
  if (candidates.length === 0) return null

  const lowered = new Map<string, Map<string, [string, LimitPair]>>()
  const view = (provider: string) => {
    let m = lowered.get(provider)
    if (!m) {
      m = new Map()
      for (const [id, pair] of Object.entries(index[provider] ?? {}))
        m.set(id.toLowerCase(), [id, pair])
      lowered.set(provider, m)
    }
    return m
  }

  const name = providerName.trim().toLowerCase()
  const providers = [
    PROVIDER_ALIASES[name] ?? name,
    name,
    prefixProvider(modelId),
  ].filter((p, i, all): p is string => !!p && all.indexOf(p) === i)
  const known = new Map(Object.keys(index).map((p) => [p.toLowerCase(), p]))

  for (const id of candidates) {
    for (const p of providers) {
      const real = known.get(p)
      const hit = real ? view(real).get(id) : undefined
      const found = hit && real ? toMatch(real, hit[0], hit[1]) : null
      if (found) return found
    }
  }

  for (const id of candidates) {
    const hits: ModelsDevMatch[] = []
    for (const p of Object.keys(index)) {
      const hit = view(p).get(id)
      const found = hit ? toMatch(p, hit[0], hit[1]) : null
      if (found) hits.push(found)
    }
    if (hits.length === 0) continue
    const [first] = hits
    const agree = hits.every(
      (h) =>
        h.contextWindow === first.contextWindow &&
        h.maxOutputTokens === first.maxOutputTokens
    )
    // Ambiguous at this id: stop rather than fall through to a looser id.
    return agree ? first : null
  }
  return null
}

/** Reduce models.dev's `api.json` to the index; anything malformed is skipped. */
export function buildIndex(raw: unknown): ModelsDevIndex {
  const out: ModelsDevIndex = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [providerId, provider] of Object.entries(raw)) {
    const models = (provider as { models?: unknown } | null)?.models
    if (!models || typeof models !== 'object') continue
    const entries: Record<string, LimitPair> = {}
    for (const [id, model] of Object.entries(models)) {
      const limit = (model as { limit?: { context?: unknown; output?: unknown } })
        ?.limit
      const n = (v: unknown) =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
      const pair: LimitPair = [n(limit?.context), n(limit?.output)]
      if (pair[0] > 0 || pair[1] > 0) entries[id] = pair
    }
    if (Object.keys(entries).length > 0) out[providerId] = entries
  }
  return out
}

const CACHE_KEY = 'flint.modelsDevIndex.v1'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Cached = { at: number; index: ModelsDevIndex }

let memory: Cached | null = null
let inflight: Promise<ModelsDevIndex> | null = null

function readCache(now: number): Cached | null {
  if (memory) return memory
  try {
    const text = globalThis.localStorage?.getItem(CACHE_KEY)
    if (!text) return null
    const parsed = JSON.parse(text) as Cached
    if (typeof parsed?.at !== 'number' || !parsed.index) return null
    memory = parsed
    return now - parsed.at > CACHE_TTL_MS ? null : parsed
  } catch {
    return null
  }
}

function writeCache(entry: Cached) {
  memory = entry
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // Storage full or blocked: the in-memory copy still serves this session.
  }
}

/** Forget the cached index (tests, and a manual refresh). */
export function clearModelsDevCache() {
  memory = null
  inflight = null
  try {
    globalThis.localStorage?.removeItem(CACHE_KEY)
  } catch {
    // Nothing to clear.
  }
}

/**
 * The index: from cache while it is fresh, otherwise downloaded once (calls
 * made meanwhile share the request). A failed download falls back to an older
 * cached copy, and rejects only when there is none, so offline use still works
 * after a first success.
 */
export function loadModelsDevIndex(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<ModelsDevIndex> {
  const cached = readCache(now)
  if (cached && now - cached.at <= CACHE_TTL_MS)
    return Promise.resolve(cached.index)
  if (inflight) return inflight
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  inflight = fetchImpl(MODELS_DEV_URL, {
    method: 'GET',
    signal: controller.signal,
    // No cookies, no referrer: the request carries nothing about the user.
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`models.dev answered ${res.status}`)
      const index = buildIndex(await res.json())
      if (Object.keys(index).length === 0)
        throw new Error('models.dev returned no models')
      writeCache({ at: now, index })
      return index
    })
    .catch((err) => {
      if (memory) return memory.index
      throw err
    })
    .finally(() => {
      clearTimeout(timer)
      inflight = null
    })
  return inflight
}

/** Look one model up, downloading the index if needed. Null when it has no entry. */
export async function lookupModelsDev(
  providerName: string,
  modelId: string,
  fetchImpl?: typeof fetch
): Promise<ModelsDevMatch | null> {
  const index = await loadModelsDevIndex(fetchImpl)
  return matchModelsDev(index, providerName, modelId)
}
