/**
 * What a reply cost, in US dollars. A model's own prices (set by the user on
 * the model, per million tokens) win; otherwise a short table of well-known
 * hosted models fills in; local engines are free; anything else is unpriced
 * and counts as nothing rather than a guess.
 */

export type Pricing = { input: number; output: number }

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

export function resolvePricing(
  providerId: string | undefined,
  model: Pick<Model, 'id' | 'inputCostPerMillion' | 'outputCostPerMillion'> | undefined
): Pricing | null {
  if (model && (valid(model.inputCostPerMillion) || valid(model.outputCostPerMillion))) {
    return {
      input: valid(model.inputCostPerMillion) ? model.inputCostPerMillion : 0,
      output: valid(model.outputCostPerMillion) ? model.outputCostPerMillion : 0,
    }
  }
  if (providerId && FREE_PROVIDERS.has(providerId)) return { input: 0, output: 0 }
  const id = model?.id?.toLowerCase()
  if (!id) return null
  return KNOWN.find(([m]) => id.includes(m))?.[1] ?? null
}

export function replyCost(
  pricing: Pricing | null,
  inputTokens: number | undefined,
  outputTokens: number | undefined
): number {
  if (!pricing) return 0
  return (
    ((inputTokens ?? 0) * pricing.input + (outputTokens ?? 0) * pricing.output) /
    1_000_000
  )
}
