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

/** Plain text from a provider error body: HTML pages lose their tags, long bodies are cut. */
export function summarizeProviderBody(body: unknown, max = 160): string {
  if (typeof body !== 'string') return ''
  let text = body
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1]
  if (/<\s*(html|body|head|!doctype)/i.test(text)) text = title || h1 || text
  text = text
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export type FailureInfo = { message: string; status?: number; reason: string }

/**
 * What a provider failure carries: its message, the HTTP status (AI SDK
 * `APICallError.statusCode`, or a plain `status`) and a short reason taken from
 * the response body. Any of them may be empty (a 502 HTML page, an empty body).
 */
export function failureInfo(e: unknown, depth = 0): FailureInfo {
  const empty: FailureInfo = { message: '', reason: '' }
  if (typeof e === 'string') return { ...empty, message: e.trim() }
  if (!e || typeof e !== 'object' || depth > 3) return empty
  const o = e as {
    message?: unknown
    error?: unknown
    statusCode?: unknown
    status?: unknown
    responseBody?: unknown
  }
  const message = typeof o.message === 'string' ? o.message.trim() : ''
  const rawStatus = typeof o.statusCode === 'number' ? o.statusCode : o.status
  const status = typeof rawStatus === 'number' ? rawStatus : undefined
  const reason = summarizeProviderBody(o.responseBody)
  if (message || status !== undefined || reason) {
    return { message, status, reason }
  }
  return o.error !== undefined ? failureInfo(o.error, depth + 1) : empty
}

/** One line for the error box, or '' when the failure says nothing. */
export function describeFailure(e: unknown): string {
  const { message, status, reason } = failureInfo(e)
  const clean = /^\s*</.test(message) ? summarizeProviderBody(message) : message
  const why = clean || reason
  if (status === undefined) return why
  if (!why) return `HTTP ${status}`
  return why.includes(String(status)) ? why : `HTTP ${status}: ${why}`
}

/**
 * The text to show for a translation: reasoning blocks (closed, or still open
 * while streaming) and the blank lines models put before the answer are gone;
 * formatting inside the answer is kept.
 */
export function cleanTranslation(raw: string, final = false): string {
  const text = raw
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '')
    .replace(/^\s+/, '')
  return final ? text.trimEnd() : text
}
