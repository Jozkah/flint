/**
 * Context windows an OpenAI-compatible server put in its model list.
 *
 * vLLM lists `max_model_len` on every `/models` entry; other servers use
 * `context_length` or `max_context_length`. Fetching the list used to keep the
 * ids only, so a custom model's window was lost the moment the list was read
 * and auto-compact had no size to plan against. The window is kept here, per
 * endpoint and model, for the chat transport to read when the model's own
 * settings name none.
 */
import { usableContextValue } from '@/lib/modelCapabilities'

const STORAGE_KEY = 'flint-listed-model-windows'

type Table = Record<string, number>

let memory: Table | null = null

function keyOf(baseUrl: string, modelId: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}|${modelId}`
}

function load(): Table {
  if (memory) return memory
  memory = {}
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const n = usableContextValue(v)
          if (n != null) memory[k] = n
        }
      }
    }
  } catch {
    // Storage can be blocked or hold something else; the table starts empty.
  }
  return memory
}

function save(table: Table): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(table))
  } catch {
    // Kept in memory for this session.
  }
}

/** The window of one `/models` entry, by any of the names servers use. */
export function listedEntryWindow(entry: unknown): number | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  return (
    usableContextValue(e.max_model_len) ??
    usableContextValue(e.context_length) ??
    usableContextValue(e.max_context_length)
  )
}

/** Remember the windows a `/models` payload named. Entries naming none are skipped. */
export function recordListedWindows(
  baseUrl: string | null | undefined,
  payload: unknown
): void {
  if (!baseUrl || !payload || typeof payload !== 'object') return
  const record = payload as Record<string, unknown>
  const lists = [Array.isArray(payload) ? payload : record.data, record.models]
  const table = load()
  let changed = false
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const id = item.id ?? item.model ?? item.name
      const tokens = listedEntryWindow(entry)
      if (typeof id !== 'string' || !id.trim() || tokens == null) continue
      const key = keyOf(baseUrl, id.trim())
      if (table[key] !== tokens) {
        table[key] = tokens
        changed = true
      }
    }
  }
  if (changed) save(table)
}

/** The window the endpoint listed for a model, or null. */
export function listedWindow(
  baseUrl: string | null | undefined,
  modelId: string | null | undefined
): number | null {
  if (!baseUrl || !modelId) return null
  return load()[keyOf(baseUrl, modelId)] ?? null
}

/** Forget everything, for tests. */
export function resetListedWindows(): void {
  memory = {}
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}
