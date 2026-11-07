// Query parameters whose values are secrets (matched case-insensitively).
const SENSITIVE_PARAMS = [
  'api_key',
  'apikey',
  'key',
  'token',
  'secret',
  'password',
  'pwd',
  'auth',
  'authorization',
  'bearer',
  'access_token',
  'refresh_token',
  'client_secret',
  'private_key',
  'signature',
  'hash',
  'x-api-key',
  'sig',
  'code',
  'session',
  'session_id',
  'sessionid',
]

// A path segment that looks like a token rather than a word: long, and made
// of letters mixed with digits (or a long hex / base64 run).
const looksLikeToken = (segment: string) =>
  segment.length >= 20 && /\d/.test(segment) && /[a-z]/i.test(segment)

/** A server URL for display, with secret query values and credentials masked. */
export const maskSensitiveUrl = (url: string) => {
  if (!url) return url

  try {
    const urlObj = new URL(url)
    const params = urlObj.searchParams

    SENSITIVE_PARAMS.forEach((paramName) => {
      for (const [key] of params.entries()) {
        if (key.toLowerCase() === paramName.toLowerCase()) {
          params.set(key, '******')
        }
      }
    })

    // Credentials embedded as user:pass@host are secrets too.
    if (urlObj.username) urlObj.username = '******'
    if (urlObj.password) urlObj.password = '******'

    urlObj.pathname = urlObj.pathname
      .split('/')
      .map((s) => (looksLikeToken(s) ? '******' : s))
      .join('/')

    urlObj.search = params.toString()
    return urlObj.toString()
  } catch {
    // If URL parsing fails, just mask the entire query string after '?'
    const queryIndex = url.indexOf('?')
    if (queryIndex === -1) return url

    const baseUrl = url.substring(0, queryIndex + 1)
    return baseUrl + '******'
  }
}
