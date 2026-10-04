/**
 * What a reply cost, in US dollars. A model's own prices (set by the user on
 * the model, per million tokens) win; otherwise a short table of well-known
 * hosted models fills in; local engines are free; anything else is unpriced
 * and counts as nothing rather than a guess.
 */

export type Pricing = {
  input: number
  output: number
  /** Cached (cache-read) input, per million. Absent = priced at `input`. */
  cachedInput?: number
  /** Cache-write input, per million. Absent = priced at `input`. */
  cacheWrite?: number
}

/** Providers that run on this machine, so a reply costs nothing. */
const FREE_PROVIDERS = new Set(['llamacpp', 'mlx', 'foundation-models'])

/**
 * Published list prices, USD per million tokens. Matched by substring of the
 * lowercased model id, first hit wins, so more specific names go first.
 * Prices change; the per-model fields exist so the user can correct them.
 */
const KNOWN: Array<[match: string, price: Pricing]> = [
  ['gpt-4.1-nano', { input: 0.1, output: 0.4 }],
  ['gpt-4.1-mini', { input: 0.4, output: 1.6 }],
  ['gpt-4.1', { input: 2, output: 8 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6 }],
  ['gpt-4o', { input: 2.5, output: 10 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
  ['haiku', { input: 1, output: 5 }],
  ['sonnet', { input: 3, output: 15 }],
  ['gemini-2.5-flash', { input: 0.3, output: 2.5 }],
  ['gemini-2.5-pro', { input: 1.25, output: 10 }],
  ['deepseek-chat', { input: 0.27, output: 1.1 }],
]

const valid = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0

type PricedModel = Pick<Model, 'id' | 'inputCostPerMillion' | 'outputCostPerMillion'> &
  Partial<Pick<Model, 'cachedInputCostPerMillion' | 'cacheWriteCostPerMillion'>>

export function resolvePricing(
  providerId: string | undefined,
  model: PricedModel | undefined
): Pricing | null {
  const cachedInput = valid(model?.cachedInputCostPerMillion)
    ? model.cachedInputCostPerMillion
    : undefined
  const cacheWrite = valid(model?.cacheWriteCostPerMillion)
    ? model.cacheWriteCostPerMillion
    : undefined
  const extras = {
    ...(cachedInput !== undefined ? { cachedInput } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  }
  if (model && (valid(model.inputCostPerMillion) || valid(model.outputCostPerMillion))) {
    return {
      input: valid(model.inputCostPerMillion) ? model.inputCostPerMillion : 0,
      output: valid(model.outputCostPerMillion) ? model.outputCostPerMillion : 0,
      ...extras,
    }
  }
  if (providerId && FREE_PROVIDERS.has(providerId)) return { input: 0, output: 0 }
  const id = model?.id?.toLowerCase()
  if (!id) return null
  const known = KNOWN.find(([m]) => id.includes(m))?.[1]
  return known ? { ...known, ...extras } : null
}

/** Whether a price is zero all round: a local model, which costs nothing. */
export const isFree = (p: Pricing | null | undefined): boolean =>
  !!p && p.input === 0 && p.output === 0 && !p.cachedInput && !p.cacheWrite

/** The token counts a cost is worked out from. Absent counts are zero. */
export type CostTokens = {
  inputTokens?: number
  outputTokens?: number
  /** Read from the prompt cache; a part of the input. */
  cachedInputTokens?: number
  /** Written to the prompt cache; a part of the input that was not cached. */
  cacheWriteTokens?: number
}

export type CostBreakdown = {
  cachedInput: number
  newInput: number
  cacheWrite: number
  output: number
  total: number
  /**
   * What the cached tokens would have cost at the full input price, minus what
   * they cost. Zero when there is no cached price (they were charged in full).
   */
  savings: number
  /** `savings` as a share of what the whole reply would have cost uncached. */
  savingsPercent: number
  /** Whether a cached price was set; otherwise cached input is at the input rate. */
  cachedPriced: boolean
  /** Whether a cache-write price was set; otherwise writes are at the input rate. */
  writePriced: boolean
}

const count = (n: number | undefined) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0

/**
 * A reply's cost, split by kind. Cached tokens are a part of the input, and
 * cache writes a part of what was not cached, so the three input kinds always
 * add up to the input and nothing is charged twice. A missing cached or write
 * price falls back to the input price.
 */
export function costBreakdown(pricing: Pricing, tokens: CostTokens): CostBreakdown {
  const input = count(tokens.inputTokens)
  const cached = Math.min(count(tokens.cachedInputTokens), input)
  const write = Math.min(count(tokens.cacheWriteTokens), input - cached)
  const fresh = input - cached - write
  const per = 1_000_000
  const cachedRate = pricing.cachedInput ?? pricing.input
  const writeRate = pricing.cacheWrite ?? pricing.input
  const cachedInput = (cached * cachedRate) / per
  const newInput = (fresh * pricing.input) / per
  const cacheWrite = (write * writeRate) / per
  const output = (count(tokens.outputTokens) * pricing.output) / per
  const total = cachedInput + newInput + cacheWrite + output
  const savings = (cached * (pricing.input - cachedRate)) / per
  const uncachedTotal = total + savings
  return {
    cachedInput,
    newInput,
    cacheWrite,
    output,
    total,
    savings,
    savingsPercent: uncachedTotal > 0 ? (savings / uncachedTotal) * 100 : 0,
    cachedPriced: pricing.cachedInput !== undefined,
    writePriced: pricing.cacheWrite !== undefined,
  }
}

/**
 * What a reply cost, in US dollars. With only input and output counts it is
 * what it always was; given the cache counts it prices cached input and cache
 * writes at their own rates where they are set.
 */
export function replyCost(
  pricing: Pricing | null,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cache?: Pick<CostTokens, 'cachedInputTokens' | 'cacheWriteTokens'>
): number {
  if (!pricing) return 0
  return costBreakdown(pricing, { inputTokens, outputTokens, ...cache }).total
}

/** Dollars for a small amount: four places under a dollar, two above. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 0.0001) return '<$0.0001'
  return `$${n.toFixed(n < 1 ? 4 : 2)}`
}
