import { localStorageKey } from '@/constants/localStorage'

/**
 * Start and end of every finished tool call, kept across conversation
 * switches, reloads and restarts. The live runtime store is wiped when a
 * conversation is left, so a reopened chat lost every "Ran 1 command 13.6s"
 * and "Worked for 5s": they were derived from timings that no longer existed.
 */
export type LoggedTiming = { startedAt: number; endedAt: number }

const KEY = `${localStorageKey.messages}-tool-timings`
const MAX_ENTRIES = 4000

let cache: Record<string, [number, number]> | null = null

function load(): Record<string, [number, number]> {
  if (cache) return cache
  cache = {}
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (
          Array.isArray(v) &&
          typeof v[0] === 'number' &&
          typeof v[1] === 'number'
        )
          cache[id] = [v[0], v[1]]
      }
    }
  } catch {
    // Unreadable storage: timings simply start over.
  }
  return cache
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(load()))
    } catch {
      // Quota or blocked storage: the in-memory copy still serves this session.
    }
  }, 500)
}

/** Remembers a finished call. Calls that never started have no duration. */
export function logToolTiming(
  toolCallId: string,
  startedAt: number | undefined,
  endedAt: number | undefined
): void {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt)
    return
  const log = load()
  delete log[toolCallId] // re-insert last so the oldest are dropped first
  log[toolCallId] = [startedAt, endedAt]
  const ids = Object.keys(log)
  if (ids.length > MAX_ENTRIES) {
    for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete log[id]
  }
  scheduleSave()
}

export function loggedToolTiming(toolCallId: string): LoggedTiming | undefined {
  const v = load()[toolCallId]
  return v ? { startedAt: v[0], endedAt: v[1] } : undefined
}

/**
 * The timing to show for a call: the live one while it is in the runtime
 * store, the logged one once that store has been cleared.
 */
export function timingFor(
  timings: Record<string, { startedAt?: number; endedAt?: number }>,
  toolCallId: string | undefined
): { startedAt?: number; endedAt?: number } | undefined {
  if (!toolCallId) return undefined
  const live = timings[toolCallId]
  if (live?.startedAt !== undefined) return live
  return loggedToolTiming(toolCallId) ?? live
}

/** Test seam: forgets the in-memory copy and the stored one. */
export function resetToolTimingLog(): void {
  cache = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    // ignore
  }
}
