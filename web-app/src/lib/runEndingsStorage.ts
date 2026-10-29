import type { RunEnding } from '@/hooks/useCoworkRun'

/**
 * How each session's last run ended, kept across a reload: a failed run's
 * notice is the only sign it failed, and it used to vanish with the page.
 */
const OUTCOMES_KEY = 'cowork-run-outcomes'

export function loadRunEndings(): Record<string, RunEnding> {
  try {
    const raw = localStorage.getItem(OUTCOMES_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, RunEnding>)
      : {}
  } catch {
    return {}
  }
}

export function saveRunEndings(outcomes: Record<string, RunEnding>) {
  try {
    localStorage.setItem(OUTCOMES_KEY, JSON.stringify(outcomes))
  } catch {
    // Best effort: the notice still shows until the page reloads.
  }
}
