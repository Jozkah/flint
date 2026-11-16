/**
 * Capabilities a provider put in its model list.
 *
 * OpenRouter (and gateways built on its schema) describe every model with
 * `supported_parameters` (`tools`, `tool_choice`, ...) and
 * `architecture.input_modalities` (`text`, `image`, ...). Reading the list used
 * to keep the ids only, so every fetched model started with just `completion`
 * and the user had to turn tools and vision on by hand. A provider that lists
 * no such metadata yields nothing here and the caller keeps its default.
 *
 * Kept in memory per endpoint and model: it is read right after the fetch that
 * filled it.
 */

const table = new Map<string, string[]>()

function keyOf(baseUrl: string, modelId: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}|${modelId}`
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : []
}

/** `tools` and `vision` for one `/models` entry, or null when it says nothing. */
export function listedEntryCapabilities(entry: unknown): string[] | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const params = strings(e.supported_parameters)
  const arch = e.architecture
  const modalities = strings(
    arch && typeof arch === 'object'
      ? (arch as Record<string, unknown>).input_modalities
      : undefined
  )
  // Requesty (and gateways shaped like it) put one boolean per ability on the
  // entry instead: `supports_tool_calling`, `supports_vision`,
  // `supports_image_generation`. A flag that is absent says nothing; a flag
  // that is `false` says no.
  const flags = ['supports_tool_calling', 'supports_vision', 'supports_image_generation']
  const flagged = flags.some((f) => typeof e[f] === 'boolean')
  if (params.length === 0 && modalities.length === 0 && !flagged) return null
  const out: string[] = []
  if (params.includes('tools') || params.includes('tool_choice') || e.supports_tool_calling === true) {
    out.push('tools')
  }
  if (modalities.includes('image') || e.supports_vision === true) out.push('vision')
  // A chat model that can also draw: it keeps chatting, so say so explicitly
  // (see `initialModelCapabilities`, which drops chat for picture-only models).
  if (e.supports_image_generation === true) out.push('image_generation', 'completion')
  return out
}

/** The capabilities of a model a gateway lists only as a picture model. */
export const IMAGE_ONLY_CAPABILITIES: readonly string[] = ['image_generation']

/**
 * Remember the models a gateway's picture list named (Requesty's
 * `/models/image`). They make pictures and do not chat.
 */
export function recordListedImageModels(
  baseUrl: string | null | undefined,
  payload: unknown
): string[] {
  if (!baseUrl || !payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const list = Array.isArray(payload) ? payload : record.data
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const entry of list) {
    const id =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? ((entry as Record<string, unknown>).id as unknown)
          : undefined
    if (typeof id !== 'string' || !id.trim()) continue
    ids.push(id.trim())
    // A model also in the chat list with image support already says it can chat.
    const known = table.get(keyOf(baseUrl, id.trim()))
    table.set(
      keyOf(baseUrl, id.trim()),
      known?.includes('completion') ? known : [...IMAGE_ONLY_CAPABILITIES]
    )
  }
  return [...new Set(ids)]
}

/** Remember the capabilities a `/models` payload named. */
export function recordListedCapabilities(
  baseUrl: string | null | undefined,
  payload: unknown
): void {
  if (!baseUrl || !payload || typeof payload !== 'object') return
  const record = payload as Record<string, unknown>
  const lists = [Array.isArray(payload) ? payload : record.data, record.models]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const id = item.id ?? item.model ?? item.name
      const caps = listedEntryCapabilities(entry)
      if (typeof id !== 'string' || !id.trim() || caps == null) continue
      table.set(keyOf(baseUrl, id.trim()), caps)
    }
  }
}

/** Extra capabilities (`tools`, `vision`) the endpoint listed for a model, or null. */
export function listedCapabilities(
  baseUrl: string | null | undefined,
  modelId: string | null | undefined
): string[] | null {
  if (!baseUrl || !modelId) return null
  return table.get(keyOf(baseUrl, modelId)) ?? null
}

/** Forget everything, for tests. */
export function resetListedCapabilities(): void {
  table.clear()
}
