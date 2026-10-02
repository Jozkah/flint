import { jevSuggestModel } from '@/lib/jev'
import { raceAbort } from '@/lib/jevRouting'
import { getProviderTitle } from '@/lib/utils'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { shouldAskForSkill } from '@/lib/jev'
import type { RoutedModelRef } from '@/hooks/useModelRouting'

/**
 * Jev choosing the AI model for a message, from a list the person made.
 *
 * Pure pieces first (what may be offered, how a model is described to Jev, how
 * the answer is read), then `chooseJevModel`, which asks. Jev only ever compares
 * the model in use with models the person ticked in settings, and a model that
 * cannot do what the message needs (use tools, see an image) is never offered.
 */

type ProviderLike = {
  provider: string
  active?: boolean
  api_key?: string
  api_key_fallbacks?: string[]
  displayName?: string
  models?: Array<{ id: string; displayName?: string; name?: string; capabilities?: string[] }>
}

export type ModelTarget = {
  provider: string
  model: string
  /** `Provider / model`, as shown to the person. */
  label: string
  local: boolean
  capabilities: string[]
  note?: string
}

export type ModelNeeds = { tools: boolean; vision: boolean }

const LOCAL_PROVIDERS = new Set(['llamacpp', 'mlx'])

export const modelKey = (provider: string, model: string) => `${provider}/${model}`

/**
 * The listed models that can actually be used now: the provider is active, a
 * hosted one has its API key, and the model still exists there.
 */
export function resolvePool(pool: readonly RoutedModelRef[], providers: readonly ProviderLike[]): ModelTarget[] {
  const out: ModelTarget[] = []
  for (const ref of pool) {
    const provider = providers.find((p) => p.provider === ref.provider)
    if (!provider || provider.active === false) continue
    const local = LOCAL_PROVIDERS.has(provider.provider)
    if (!local && !providerHasRemoteApiKeys(provider)) continue
    const model = provider.models?.find((m) => m.id === ref.model)
    if (!model) continue
    out.push({
      provider: ref.provider,
      model: ref.model,
      label: `${provider.displayName || getProviderTitle(ref.provider)} / ${model.displayName || model.name || model.id}`,
      local,
      capabilities: model.capabilities ?? [],
      note: ref.note,
    })
  }
  return out
}

/**
 * What may be offered for this message: not the model already in use, and,
 * when the message needs it, only models that can use tools or see an image.
 * A model that cannot use tools is not offered to replace one that can.
 */
export function eligibleTargets(
  pool: readonly ModelTarget[],
  current: { provider: string; model: string } | null,
  needs: ModelNeeds
): ModelTarget[] {
  return pool.filter((m) => {
    if (current && m.provider === current.provider && m.model === current.model) return false
    if (needs.tools && !m.capabilities.includes('tools')) return false
    if (needs.vision && !m.capabilities.includes('vision')) return false
    return true
  })
}

/** What Jev is told about a model: where it runs, what it can do, and the person's note. */
export function describeModel(m: Pick<ModelTarget, 'local' | 'capabilities' | 'note' | 'provider'>): string {
  const where = m.local ? 'Runs on this computer' : `Hosted by ${getProviderTitle(m.provider)}`
  const can = ['tools', 'vision', 'reasoning'].filter((c) => m.capabilities.includes(c))
  return [where + (can.length ? ` (${can.join(', ')})` : '') + '.', m.note?.trim()].filter(Boolean).join(' ')
}

export type ModelRouteDecision = {
  /** The model Jev found clearly better, or null to keep the current one. */
  target: ModelTarget | null
  probability: number | null
  fallback: string | null
}

/**
 * Ask Jev whether another listed model would handle `message` clearly better
 * than the current one. Resolves to `null` when nothing was asked (too short, no
 * candidates, Jev off) and to a decision with no target when Jev kept the
 * current model. Never throws: routing is help, not a reason to fail a prompt.
 */
export async function chooseJevModel(args: {
  message: string
  current: { provider: string; model: string; label: string; local: boolean; capabilities: string[] }
  pool: readonly ModelTarget[]
  needs: ModelNeeds
  signal?: AbortSignal
  suggest?: typeof jevSuggestModel
}): Promise<ModelRouteDecision | null> {
  const message = args.message.trim()
  if (args.signal?.aborted || !shouldAskForSkill(message)) return null
  const candidates = eligibleTargets(args.pool, args.current, args.needs)
  if (candidates.length === 0) return null
  const options = candidates.map((m) => ({ name: modelKey(m.provider, m.model), description: describeModel(m) }))
  try {
    const decision = await raceAbort(
      (args.suggest ?? jevSuggestModel)(
        message,
        { name: args.current.label, description: describeModel(args.current) },
        options
      ),
      args.signal
    )
    if (!decision) return null
    const target = candidates.find((m) => modelKey(m.provider, m.model) === decision.skill) ?? null
    return { target, probability: decision.probability, fallback: decision.fallback }
  } catch (error) {
    console.debug('[Jev] model routing unavailable:', error)
    return null
  }
}

/** Whether a message carries an image, so only models that can see one are offered. */
export function messageNeeds(
  parts: ReadonlyArray<{ type: string; mediaType?: string }>,
  currentCapabilities: readonly string[]
): ModelNeeds {
  return {
    tools: currentCapabilities.includes('tools'),
    vision: parts.some((p) => p.type === 'file' && (p.mediaType ?? '').startsWith('image/')),
  }
}
