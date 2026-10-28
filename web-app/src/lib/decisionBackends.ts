/**
 * Decision backends for the Jev opt-ins: TypeSafe's Jev (the default) or an
 * open model Flint can already reach -- a local llama.cpp / MLX model, or any
 * configured OpenAI-compatible provider. The backend (`core::jev::backend`)
 * reads this from `flint-jev` and is the only thing that makes a request.
 */

export type DecisionBackend =
  | { kind: 'jev' }
  | { kind: 'open_model'; provider: string; model: string; preset?: string }

export const JEV_BACKEND: DecisionBackend = { kind: 'jev' }

/**
 * Small CPU-sized typed-decision models offered as presets. Flint does not
 * know their endpoints or ids: each is added as an OpenAI-compatible provider
 * (or loaded locally) by the user, then picked below. `match` finds a model
 * already configured under a similar id.
 */
export const DECISION_PRESETS: { id: string; label: string; match: string[] }[] = [
  { id: 'von', label: 'Von', match: ['von'] },
  { id: 'laya', label: 'Laya', match: ['laya'] },
  { id: 'kev-0.8b', label: 'Kev-0.8B', match: ['kev08b'] },
  { id: 'kev-4b', label: 'Kev-4B', match: ['kev4b'] },
  { id: 'rizzo-flow-4b', label: 'Rizzo Flow 4B', match: ['rizzoflow4b'] },
  { id: 'rizzo-flow-1.7b', label: 'Rizzo Flow 1.7B', match: ['rizzoflow17b'] },
  { id: 'qwen3-4b-service', label: 'Our Qwen3-4B service', match: ['qwen34b'] },
]

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The first configured model whose id or name fits `presetId`, if any. */
export function findPresetModel(
  presetId: string,
  providers: { provider: string; active?: boolean; models: { id: string; displayName?: string }[] }[]
): { provider: string; model: string } | undefined {
  const preset = DECISION_PRESETS.find((p) => p.id === presetId)
  if (!preset) return undefined
  for (const p of providers) {
    if (p.active === false) continue
    for (const m of p.models) {
      // The id's last path segment or the display name must start with the
      // preset, so a short name like Von does not match "devon".
      const names = [squash(m.id.split('/').pop() ?? ''), squash(m.displayName ?? '')]
      if (preset.match.some((needle) => names.some((n) => n.startsWith(needle)))) {
        return { provider: p.provider, model: m.id }
      }
    }
  }
  return undefined
}

/** A persisted value back to a usable backend; anything incomplete is Jev. */
export function normalizeBackend(v: unknown): DecisionBackend {
  if (v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'open_model') {
    const o = v as { provider?: unknown; model?: unknown; preset?: unknown }
    if (typeof o.provider === 'string' && typeof o.model === 'string') {
      return {
        kind: 'open_model',
        provider: o.provider,
        model: o.model,
        ...(typeof o.preset === 'string' ? { preset: o.preset } : {}),
      }
    }
  }
  return JEV_BACKEND
}
