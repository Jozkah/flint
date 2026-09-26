/**
 * The sandboxed first attempts an unsandboxed NUL rerun replaced, kept across
 * reloads. The runtime store holds them only for the live session; this keeps
 * the newest ones in localStorage so a reopened card still shows what the
 * sandbox did. Display-only, bounded, and never sent to the model.
 */
export type ArchivedAttempt = { output: string; isError: boolean }

const KEY = 'flint.firstAttempts'
/** Newest entries kept. */
export const FIRST_ATTEMPT_LIMIT = 200
/** Per-entry cap, so a noisy failure cannot fill storage. */
const OUTPUT_CAP = 16_000

type Entry = [toolCallId: string, attempt: ArchivedAttempt]

function load(): Entry[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as Entry[]) : []
  } catch {
    return []
  }
}

export function archiveFirstAttempt(
  toolCallId: string,
  attempt: ArchivedAttempt
): void {
  try {
    const entries = load().filter(([id]) => id !== toolCallId)
    entries.push([
      toolCallId,
      { output: attempt.output.slice(0, OUTPUT_CAP), isError: attempt.isError },
    ])
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-FIRST_ATTEMPT_LIMIT)))
  } catch {
    // Storage full or unavailable: the live session still has it.
  }
}

export function archivedFirstAttempt(
  toolCallId: string
): ArchivedAttempt | undefined {
  return load().find(([id]) => id === toolCallId)?.[1]
}
