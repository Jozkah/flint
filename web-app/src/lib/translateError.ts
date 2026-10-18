/**
 * Maps a raw provider failure to a plain-language category so the Translate
 * page can say what to do instead of dumping an SDK error. Unknown messages
 * return null and are shown raw.
 */
export type TranslateErrorKind = 'auth' | 'quota' | 'modelNotFound' | 'engineUnavailable' | 'network'

export function classifyTranslateError(raw: string): TranslateErrorKind | null {
  const m = raw.toLowerCase()
  if (!m) return null
  if (
    /x-api-key|api key|apikey|unauthori[sz]ed|forbidden|\b40[13]\b|authentication|permission denied/.test(
      m
    )
  )
    return 'auth'
  if (/quota|rate.?limit|insufficient|\b429\b|billing|credit/.test(m))
    return 'quota'
  // A local engine that is not installed or not running, e.g. "Failed to start
  // model: The llamacpp engine is not available. Restart Flint and ...".
  if (/engine.{0,40}(not available|unavailable|not installed|not running)/.test(m))
    return 'engineUnavailable'
  if (
    /model.{0,40}(not found|does not exist|not loaded|unavailable)|\b404\b/.test(
      m
    )
  )
    return 'modelNotFound'
  if (
    /failed to fetch|network|econnrefused|enotfound|fetch failed|unreachable|timed? ?out|connection (refused|reset)/.test(
      m
    )
  )
    return 'network'
  return null
}
