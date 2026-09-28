import { getProviderLogo } from '@/lib/providerLogos'

/**
 * Brand marks for providers and model families.
 *
 * The LobeHub set (public/images/logos, MIT, see LICENSE-lobehub.txt) is
 * preferred; it is drawn on a 24px grid, so every mark sits at the same
 * optical size inside a tile. Providers it does not cover fall back to the
 * older per-provider images, and anything else to a letter tile.
 *
 * `mono` marks are drawn in `currentColor`. Loaded through <img> they render
 * black, so the tile inverts them in dark mode.
 */
export type BrandLogo = { src: string; mono: boolean }

// Vite's base: `/` on the desktop, `/m/` in the phone app.
const LOGOS = `${import.meta.env.BASE_URL}images/logos`

const logo = (file: string, mono = false): BrandLogo => ({
  src: `${LOGOS}/${file}.svg`,
  mono,
})

const PROVIDER_LOGOS: Record<string, BrandLogo> = {
  anthropic: logo('anthropic', true),
  openai: logo('openai', true),
  openrouter: logo('openrouter', true),
  gemini: logo('gemini-color'),
  google: logo('google-color'),
  mistral: logo('mistral-color'),
  xai: logo('grok', true),
  huggingface: logo('huggingface-color'),
  ollama: logo('ollama', true),
  deepseek: logo('deepseek-color'),
  qwen: logo('qwen-color'),
}

export function providerLogo(provider: string): BrandLogo | undefined {
  const known = PROVIDER_LOGOS[provider.toLowerCase()]
  if (known) return known
  const legacy = getProviderLogo(provider)
  return legacy ? { src: legacy, mono: false } : undefined
}

/**
 * Model families by the words their ids carry. Order matters: a fine-tune
 * named after two families ("deepseek-r1-distill-qwen") belongs to the one
 * that made it, which comes first in the id.
 */
const MODEL_FAMILIES: Array<[RegExp, BrandLogo]> = [
  [/claude/i, logo('claude-color')],
  [/deepseek/i, logo('deepseek-color')],
  [/qwen|qwq/i, logo('qwen-color')],
  [/gemma/i, logo('gemma-color')],
  [/gemini/i, logo('gemini-color')],
  [/llama|meta/i, logo('meta-color')],
  [/mistral|mixtral|devstral|magistral|codestral|ministral/i, logo('mistral-color')],
  [/grok/i, logo('grok', true)],
  [/gpt|o[134](-|$)|openai|chatgpt/i, logo('openai', true)],
]

/** The mark for a model: its family first, else the provider serving it. */
export function modelLogo(
  modelId: string,
  provider?: string
): BrandLogo | undefined {
  // Match on the last path segment: "org/Qwen3-14B" is a Qwen, whoever hosts it.
  const name = modelId.split('/').pop() ?? modelId
  for (const [pattern, mark] of MODEL_FAMILIES) {
    if (pattern.test(name)) return mark
  }
  return provider && provider !== 'llamacpp' && provider !== 'mlx'
    ? providerLogo(provider)
    : undefined
}
