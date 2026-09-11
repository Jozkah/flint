/**
 * Credential redaction for text the app keeps: a background command's line and
 * output, a task's metadata.
 *
 * The same rules as the backend's `audit::redact` (agent-tools `audit.rs`), so
 * a command reads identically in the audit log and in the Background Tasks
 * panel: `KEY=value` where the key names a secret, and bare tokens that look
 * like keys (known prefixes, or long and high-entropy). Applied before a value
 * is stored, so a secret is never persisted and cleaned up afterwards.
 *
 * Deliberately conservative about what counts as a token: redacting an
 * ordinary word or a path would make the record less useful without making it
 * safer. It is a filter for the common shapes, not a guarantee.
 */

export const REDACTED = '[redacted]'

const SECRET_KEY_PARTS = [
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'auth',
  'authorization',
  'credential',
  'private_key',
  'access_key',
  'session_key',
]

const TOKEN_PREFIXES = [
  'sk-',
  'sk_live_',
  'pk_live_',
  'ghp_',
  'gho_',
  'xoxb-',
  'AKIA',
]

function namesASecret(key: string): boolean {
  const k = key.replace(/^-+/, '').toLowerCase()
  return SECRET_KEY_PARTS.some((needle) => k.includes(needle))
}

function looksLikeAToken(word: string): boolean {
  const bare = word.replace(/^["'(]+|["'),;]+$/g, '')
  if (TOKEN_PREFIXES.some((p) => bare.startsWith(p) && bare.length > p.length + 7)) {
    return true
  }
  // Long, no separators a path or sentence would have, and a mix of
  // character classes a word would not.
  if (bare.length < 32 || /[\\/.:@]/.test(bare)) return false
  if (!/^[A-Za-z0-9_\-+=]+$/.test(bare)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(bare))
  return classes.length >= 3
}

function redactWord(word: string): string {
  const eq = word.indexOf('=')
  if (eq > 0) {
    const key = word.slice(0, eq)
    const value = word.slice(eq + 1)
    if (value.length > 0 && namesASecret(key)) return `${key}=${REDACTED}`
  }
  if (looksLikeAToken(word)) return REDACTED
  return word
}

/** Redact every credential-shaped word, keeping the whitespace between them. */
export function redactSecrets(text: string): string {
  if (!text) return text
  // `Authorization: Bearer <token>` and `Bearer <token>` carry the secret in the
  // word after the scheme, which on its own need not look like a token.
  const schemes = text.replace(
    /\b(Bearer|Basic|Token)\s+([^\s"']+)/gi,
    (_m, scheme: string) => `${scheme} ${REDACTED}`
  )
  return schemes
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : redactWord(part)))
    .join('')
}

/**
 * Keep the end of a long output, where a command says how it ended.
 *
 * Bounded by characters and by lines; when anything is dropped the caller is
 * told, so the record can say the output is partial rather than imply it is
 * whole.
 */
export function boundTail(
  text: string,
  maxChars: number,
  maxLines: number
): { text: string; truncated: boolean } {
  let out = text
  let truncated = false
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars)
    truncated = true
  }
  const lines = out.split('\n')
  if (lines.length > maxLines) {
    out = lines.slice(lines.length - maxLines).join('\n')
    truncated = true
  }
  return { text: out, truncated }
}

/** The exit code a `bash` result reports on its final `[exit N]` line. */
export function bashExitCode(output: string | undefined): number | undefined {
  if (!output) return undefined
  const matches = [...output.matchAll(/^\[exit (-?\d+)\]\s*$/gm)]
  const last = matches[matches.length - 1]
  return last ? Number(last[1]) : undefined
}

/** Whether a `bash` result says its command was killed by a signal. */
export function bashSignalled(output: string | undefined): boolean {
  return !!output && /^\[terminated by signal\]\s*$/m.test(output)
}
