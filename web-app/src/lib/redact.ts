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
  'authorization',
  'auth',
  'credential',
  'private_key',
  'access_key',
  'session_key',
  'cookie',
]

const TOKEN_PREFIXES = [
  'sk-',
  'sk_live_',
  'pk_live_',
  'ghp_',
  'gho_',
  'github_pat_',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'xoxs-',
  'glpat-',
  'AIza',
  'hf_',
  'npm_',
  'AKIA',
]

/** Whether a key, flag or field name marks its value as a credential. */
export function namesASecret(key: string): boolean {
  const k = key
    .replace(/^-+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  return SECRET_KEY_PARTS.some((needle) => k.includes(needle))
}

function looksLikeAToken(word: string): boolean {
  const bare = word.replace(/^["'(]+|["'),;]+$/g, '')
  if (
    TOKEN_PREFIXES.some((p) => bare.startsWith(p) && bare.length >= p.length + 8)
  ) {
    return true
  }
  // Long, no separators a path or sentence would have, and a mix of
  // character classes a word would not.
  if (bare.length < 32 || /[\/.:@]/.test(bare)) return false
  if (!/^[A-Za-z0-9_\-+=]+$/.test(bare)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(bare))
  return classes.length >= 3
}

function redactWord(word: string): string {
  const eq = word.indexOf('=')
  if (eq > 0 && !word.includes('://')) {
    const key = word.slice(0, eq).replace(/^["']/, '')
    const value = word.slice(eq + 1)
    if (value.length > 0 && !value.startsWith(REDACTED) && namesASecret(key)) {
      return `${word.slice(0, eq)}=${REDACTED}`
    }
  }
  if (looksLikeAToken(word)) return REDACTED
  // A token inside a URL or `a:b@c` shape: test each separator-split piece.
  return word.replace(/[^:/@?=&]+/g, (piece) =>
    looksLikeAToken(piece) ? REDACTED : piece
  )
}

const FLAG_VALUE = String.raw`("[^"]*"|'[^']*'|[^\s"'][^\s]*)`

/**
 * Redact every credential-shaped piece of text, keeping the whitespace
 * between words. Synchronous on purpose: callers use it inline. The corpus in
 * `__tests__/fixtures/secretCorpus.json` pins its behaviour so the Rust
 * redactor can be compared against the same cases.
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  let out = text
    // user:password@ and token@ in a URL
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
      (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)@/gi,
      (m, scheme: string, user: string) =>
        looksLikeAToken(user) ? `${scheme}${REDACTED}@` : m
    )
    // secret-named query parameters
    .replace(
      /([?&][^=&\s#]*(?:token|key|secret|password|auth|sig|signature)[^=&\s#]*=)[^&\s#]+/gi,
      `$1${REDACTED}`
    )
    // `Authorization: Bearer <token>`: the secret is the word after the scheme.
    .replace(/\b(Bearer|Basic|Token)\s+([^\s"']+)/gi, (_m, scheme: string) => {
      return `${scheme} ${REDACTED}`
    })
    // JWTs
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, REDACTED)
    // JSON-style `"accessToken": "value"`
    .replace(
      /("[\w.-]+"\s*:\s*)("(?:[^"\\]|\\.)*")/g,
      (m, head: string) => {
        const key = head.slice(1, head.indexOf('"', 1))
        return namesASecret(key) ? `${head}"${REDACTED}"` : m
      }
    )
    // KEY="a quoted value" / KEY='a quoted value'
    .replace(
      /(?<![\w.-])([\w.-]+)=("[^"]*"|'[^']*')/g,
      (m, key: string) => (namesASecret(key) ? `${key}=${REDACTED}` : m)
    )
    // --password hunter2 / --token "a b": the flag's value is the next token
    .replace(
      new RegExp(String.raw`(--[\w-]+)(\s+)` + FLAG_VALUE, 'g'),
      (m, flag: string, ws: string, value: string) =>
        namesASecret(flag) && value !== REDACTED ? `${flag}${ws}${REDACTED}` : m
    )
  // `-p` is only a password for these tools (psql's is a port).
  if (/\b(mysql|mysqldump|sshpass)\b/.test(out)) {
    out = out.replace(
      new RegExp(String.raw`(\s-p)(\s+)` + FLAG_VALUE, 'g'),
      (m, flag: string, ws: string, value: string) =>
        value === REDACTED ? m : `${flag}${ws}${REDACTED}`
    )
  }
  return out
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
