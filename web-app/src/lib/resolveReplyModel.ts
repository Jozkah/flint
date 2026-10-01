import { isChatCapable, isProviderUsable } from '@/lib/providerReadiness'

type ModelLike = {
  id: string
  name?: string
  embedding?: boolean
  capabilities?: string[]
}

type ProviderLike = {
  provider: string
  models?: ModelLike[]
  api_key?: string
  api_key_fallbacks?: string[]
}

export type ReplyModelPick = { provider: string; model: string }

/** Engines that run on this machine; every other provider is remote. */
const LOCAL_PROVIDERS = new Set(['llamacpp', 'mlx'])

/**
 * Parameter count, in billions, read from a model's name ("Qwen3-8B",
 * "gemma-3-27b-it", "smol-360M"). Null when the name does not say. The name is
 * all that is available before a model is loaded, and it is enough to tell a
 * small model from a large one.
 */
export function estimateParamsB(model: ModelLike): number | null {
  const text = `${model.id} ${model.name ?? ''}`
  const match = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s?([bm])(?![a-z0-9])/i.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return match[2].toLowerCase() === 'm' ? value / 1000 : value
}

function chatModels(provider: ProviderLike | undefined): ModelLike[] {
  return (provider?.models ?? []).filter(isChatCapable)
}

/** A local engine needs only a model; a remote provider needs a credential. */
function canAnswer(provider: ProviderLike): boolean {
  return LOCAL_PROVIDERS.has(provider.provider)
    ? chatModels(provider).length > 0
    : isProviderUsable(provider)
}

function holds(
  providers: ProviderLike[],
  pick: ReplyModelPick | null | undefined
): pick is ReplyModelPick {
  if (!pick) return false
  const provider = providers.find((p) => p.provider === pick.provider)
  return (
    !!provider &&
    canAnswer(provider) &&
    chatModels(provider).some((m) => m.id === pick.model)
  )
}

/**
 * The model that answers a message sent before any model was chosen, so the
 * message goes instead of stopping at "select a model".
 *
 * In order: the user's default, the model used last, a connected remote
 * provider, then local models: the only one, otherwise the lightest by its name.
 * Returns null only when nothing installed or connected can answer.
 */
export function resolveReplyModel(input: {
  providers: ProviderLike[]
  preferred?: ReplyModelPick | null
  lastUsed?: ReplyModelPick | null
}): ReplyModelPick | null {
  const { providers, preferred, lastUsed } = input
  if (holds(providers, preferred)) return preferred
  if (holds(providers, lastUsed)) return lastUsed

  const remote = providers.find(
    (p) =>
      !LOCAL_PROVIDERS.has(p.provider) &&
      canAnswer(p) &&
      chatModels(p).length > 0
  )
  if (remote) {
    return { provider: remote.provider, model: chatModels(remote)[0].id }
  }

  const local: ReplyModelPick[] = []
  let best: { pick: ReplyModelPick; size: number } | null = null
  for (const provider of providers) {
    if (!LOCAL_PROVIDERS.has(provider.provider)) {
      continue
    }
    for (const model of chatModels(provider)) {
      local.push({ provider: provider.provider, model: model.id })
      // Unknown size sorts after every known one, so a named size wins.
      const size = estimateParamsB(model) ?? Number.POSITIVE_INFINITY
      if (!best || size < best.size) {
        best = { pick: { provider: provider.provider, model: model.id }, size }
      }
    }
  }
  if (local.length === 1) return local[0]
  return best?.pick ?? null
}
