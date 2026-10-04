/**
 * The window auto-compact plans against when the model's own settings name
 * none (a custom OpenAI-compatible model has no `ctx_len`).
 *
 * Best first, each step only when the one before it knows nothing:
 *   1. configured / live    the user's Max Context Tokens, or a loaded engine's
 *   2. provider             what the provider describes for the model
 *                           (`max_model_len` and friends, a window a server
 *                           named when it refused a request, the bundled table)
 *   3. listed               what the endpoint's `/models` list said
 *   4. remembered           the last window this chat showed for this model
 *   5. server               a local server's `/props` or `/models`, asked now
 *
 * No answer is `source: 'none'` with zero tokens: the caller says so instead
 * of compacting at a percentage of a number nobody has.
 */
import { usableContextValue } from '@/lib/modelCapabilities'

export type CompactionWindowSource =
  | 'configured'
  | 'provider'
  | 'listed'
  | 'remembered'
  | 'server'
  | 'none'

export type CompactionWindow = {
  tokens: number
  source: CompactionWindowSource
}

export type CompactionWindowInput = {
  /** Window from the model's settings or a loaded engine; 0 when unknown. */
  known: number
  /** What the provider describes for the model (`knownContextWindow`). */
  provider?: number | null
  /** What the endpoint's model list named (`listedWindow`). */
  listed?: number | null
  /** The last window this chat showed for this model. */
  remembered?: number | null
  /** Asked of the server now; only called when nothing earlier answered. */
  fetchServer?: () => Promise<number | null>
}

export async function resolveCompactionWindow(
  input: CompactionWindowInput
): Promise<CompactionWindow> {
  if (input.known > 0) return { tokens: input.known, source: 'configured' }
  const steps: Array<[CompactionWindowSource, number | null | undefined]> = [
    ['provider', input.provider],
    ['listed', input.listed],
    ['remembered', input.remembered],
  ]
  for (const [source, value] of steps) {
    const tokens = usableContextValue(value)
    if (tokens != null) return { tokens, source }
  }
  if (input.fetchServer) {
    let fetched: number | null = null
    try {
      fetched = usableContextValue(await input.fetchServer())
    } catch {
      // An unreachable server is the same as one that names no window.
    }
    if (fetched != null) return { tokens: fetched, source: 'server' }
  }
  return { tokens: 0, source: 'none' }
}

type RememberedState = {
  windowById: Record<string, number>
  windowModelById: Record<string, string>
  lastById: Record<string, { window?: number; model?: string }>
}

/**
 * The window this chat last showed, while it is still the model's: a model
 * change recomputes from the new model rather than inheriting the old size.
 */
export function rememberedWindowFor(
  state: RememberedState,
  threadId: string | null | undefined,
  modelId: string | null | undefined
): number | null {
  if (!threadId) return null
  const sameModel = (m?: string) => !m || !modelId || m === modelId
  const learned = state.windowById[threadId]
  if (learned && sameModel(state.windowModelById[threadId])) {
    return usableContextValue(learned)
  }
  const last = state.lastById[threadId]
  if (last && sameModel(last.model)) return usableContextValue(last.window)
  return null
}
