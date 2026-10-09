/**
 * OpenRouter request shaping driven by assistant parameters:
 * - `openrouter_web_search`: appends `:online` to the model slug (documented
 *   shorthand for the `web` plugin).
 * - `openrouter_provider`: JSON for the documented `provider` routing object
 *   (order / only / ignore / allow_fallbacks).
 * - `openrouter_image_output`: asks for `modalities: ['image','text']` so
 *   image-capable models return pictures (see openrouterImages).
 * Only applied to OpenRouter endpoints; see model-factory.
 */

type Json = Record<string, unknown>

const SLUG_LISTS = ['order', 'only', 'ignore'] as const

/** Parses the routing JSON, keeping only documented, well-typed fields. */
export function parseProviderRouting(raw: unknown): Json | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  const src = parsed as Json
  const out: Json = {}
  for (const key of SLUG_LISTS) {
    const v = src[key]
    if (Array.isArray(v)) {
      const slugs = v.filter((x): x is string => typeof x === 'string' && !!x)
      if (slugs.length) out[key] = slugs
    }
  }
  if (typeof src.allow_fallbacks === 'boolean') {
    out.allow_fallbacks = src.allow_fallbacks
  }
  return Object.keys(out).length ? out : undefined
}

export function isWebSearchOn(value: unknown): boolean {
  return value === true || value === 'true'
}

/** Mutates an OpenRouter chat-completions body; returns true if changed. */
export function applyOpenRouterOptions(
  body: Json,
  params: Record<string, unknown>
): boolean {
  let changed = false
  if (
    isWebSearchOn(params.openrouter_web_search) &&
    typeof body.model === 'string' &&
    !body.model.endsWith(':online')
  ) {
    body.model = `${body.model}:online`
    changed = true
  }
  if (isWebSearchOn(params.openrouter_image_output) && body.modalities === undefined) {
    body.modalities = ['image', 'text']
    changed = true
  }
  const routing = parseProviderRouting(params.openrouter_provider)
  if (routing && body.provider === undefined) {
    body.provider = routing
    changed = true
  }
  return changed
}

export function withOpenRouterOptions(
  inner: typeof globalThis.fetch,
  params: Record<string, unknown>
): typeof globalThis.fetch {
  return async (input, init) => {
    if (
      (init?.method === 'POST' || !init?.method) &&
      typeof init?.body === 'string'
    ) {
      try {
        const body = JSON.parse(init.body) as Json
        if (applyOpenRouterOptions(body, params)) {
          init = { ...init, body: JSON.stringify(body) }
        }
      } catch {
        // not JSON: send untouched
      }
    }
    return inner(input, init)
  }
}
