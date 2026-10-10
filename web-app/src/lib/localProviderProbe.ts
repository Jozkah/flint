/**
 * Find local OpenAI-compatible servers the user already runs, so the
 * add-provider dialog can offer them (janhq/jan#6893).
 *
 * Flint is local-first and makes no unrequested network calls, so this is a
 * one-shot probe that only the add-provider dialog starts, when it opens:
 * loopback addresses only, two fixed ports, a short timeout, no retries and
 * nothing kept running afterwards.
 */

export type LocalProviderCandidate = {
  /** Suggested provider name. */
  name: string
  /** Base URL to prefill, as the provider settings expect it (with `/v1`). */
  baseUrl: string
}

/** The servers worth looking for, and where they listen by default. */
const KNOWN: readonly LocalProviderCandidate[] = [
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
]

/** Long enough for a local server, short enough not to stall the dialog. */
export const PROBE_TIMEOUT_MS = 1500

const trimUrl = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase()

/**
 * Probe each known address once. A server counts as found when `/models`
 * answers with a success status; anything else (refused, timed out, an error
 * page) is "not there". Candidates whose base URL is in `exclude` -- providers
 * already configured -- are not probed at all.
 */
export async function probeLocalProviders(
  fetchImpl: typeof fetch,
  exclude: readonly string[] = [],
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<LocalProviderCandidate[]> {
  const skip = new Set(exclude.map(trimUrl))
  const targets = KNOWN.filter((c) => !skip.has(trimUrl(c.baseUrl)))
  const results = await Promise.all(
    targets.map(async (candidate) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(`${candidate.baseUrl}/models`, {
          method: 'GET',
          signal: controller.signal,
        })
        // Not read: an answer is all the probe needs, and a stream left open
        // would hold the connection.
        try {
          await response.body?.cancel()
        } catch {
          // Already closed.
        }
        return response.ok ? candidate : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    })
  )
  return results.filter((c): c is LocalProviderCandidate => c !== null)
}
