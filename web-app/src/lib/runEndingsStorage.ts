import type { RunEnding } from '@/hooks/useCoworkRun'
import { readJson } from '@/lib/localPrefs'

/**
 * How each session's last run ended, kept across a reload: a failed run's
 * notice is the only sign it failed, and it used to vanish with the page.
 */
const OUTCOMES_KEY = 'cowork-run-outcomes'

export function loadRunEndings(): Record<string, RunEnding> {
  const parsed = readJson(OUTCOMES_KEY)
  return parsed && typeof parsed === 'object'
    ? (parsed as Record<string, RunEnding>)
    : {}
}

export function saveRunEndings(outcomes: Record<string, RunEnding>) {
  try {
    localStorage.setItem(OUTCOMES_KEY, JSON.stringify(outcomes))
  } catch {
    // Best effort: the notice still shows until the page reloads.
  }
}
