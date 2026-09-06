/**
 * Credential detection for anything the web app persists (AH-045).
 *
 * The canonical detector is Rust: `src-tauri/harness/src/secrets.rs`. That one
 * guards everything written by the agent core -- the audit event log, the display
 * journal, the compaction summary. This is its mirror, and it exists because the
 * desktop surface persists text the Rust side never sees: the activity timeline
 * and the session store are written here, from a live event stream, and
 * `localStorage` is as durable as a file.
 *
 * The two are kept from drifting by a shared corpus rather than by discipline:
 * `docs/security/secret-corpus.json` is read by both test suites, so a case added
 * there fails in both until both handle it. If you change a rule here, change it
 * there and in the Rust module, and let the corpus prove all three agree.
 *
 * Same two dispositions as the Rust side, for the same reasons:
 *
 * - `redactSecrets` for text that must stay readable, marking each match with the
 *   kind that was found.
 * - `scanSecrets` for a caller that must refuse rather than rewrite.
 *
 * And the same admission: this is a floor. A high-entropy string with no vendor
 * prefix, no secret-ish name and no credential shape is indistinguishable from a
 * commit SHA, and treating entropy as a rule would redact every hash in every
 * diff. The corpus keeps a SHA and a content address in its negative cases
 * precisely so that stays true.
 *
 * What is *not* redacted: live output as it streams to the screen. The user owns
 * the machine and asked to see the command's output; hiding it would be a
 * misfeature, and by then nothing has been persisted. Redaction happens on the
 * way into storage.
 */

export type SecretKind =
  | 'aws-access-key-id'
  | 'github-token'
  | 'openai-key'
  | 'anthropic-key'
  | 'slack-token'
  | 'google-api-key'
  | 'gitlab-token'
  | 'huggingface-token'
  | 'npm-token'
  | 'stripe-key'
  | 'sendgrid-key'
  | 'private-key'
  | 'jwt'
  | 'authorization'
  | 'url-password'
  | 'secret'

/** One detected credential, located by index in the scanned string. */
export type SecretFinding = {
  kind: SecretKind
  /** 1-based line the match starts on. */
  line: number
  start: number
  end: number
}

/**
 * Vendor prefixes: `[prefix, minimum characters after it, kind]`.
 *
 * The minimum is what stops a prose mention from reporting. More specific
 * prefixes come first, because the first match wins -- `sk-ant-` must be tried
 * before `sk-`.
 */
const PREFIXES: [string, number, SecretKind][] = [
  ['AKIA', 12, 'aws-access-key-id'],
  ['ASIA', 12, 'aws-access-key-id'],
  ['github_pat_', 20, 'github-token'],
  ['ghp_', 20, 'github-token'],
  ['gho_', 20, 'github-token'],
  ['ghs_', 20, 'github-token'],
  ['ghu_', 20, 'github-token'],
  ['ghr_', 20, 'github-token'],
  ['sk-ant-', 16, 'anthropic-key'],
  ['sk-proj-', 16, 'openai-key'],
  ['sk_live_', 16, 'stripe-key'],
  ['rk_live_', 16, 'stripe-key'],
  ['sk-', 20, 'openai-key'],
  ['xoxb-', 12, 'slack-token'],
  ['xoxp-', 12, 'slack-token'],
  ['xoxa-', 12, 'slack-token'],
  ['xoxs-', 12, 'slack-token'],
  ['xapp-', 12, 'slack-token'],
  ['AIza', 30, 'google-api-key'],
  ['glpat-', 16, 'gitlab-token'],
  ['hf_', 20, 'huggingface-token'],
  ['npm_', 30, 'npm-token'],
  ['SG.', 30, 'sendgrid-key'],
]

/** Substrings that make an assignment's name a secret name. */
const SECRET_NAMES = [
  'secret',
  'password',
  'passwd',
  'passphrase',
  'api_key',
  'apikey',
  'api-key',
  'access_key',
  'access-key',
  'private_key',
  'private-key',
  'auth_token',
  'authtoken',
  'auth-token',
  'token',
  'credential',
  'session_key',
  'client_secret',
]

/**
 * Names that contain a secret-ish word but never a secret value. Without these,
 * every `max_tokens` and `total_tokens` in a usage record reports.
 */
const NAME_EXCEPTIONS = [
  'max_tokens',
  'max-tokens',
  'maxtokens',
  'token_count',
  'tokencount',
  'num_tokens',
  'n_tokens',
  'tokens_used',
  'token_limit',
  'token_budget',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'prompt_tokens',
  'completion_tokens',
  'cached_tokens',
  'tokenizer',
  'token_type',
  'secret_name',
  'password_field',
]

const isTokenChar = (c: string) => /[A-Za-z0-9_.+/=~-]/.test(c)
/**
 * Narrower than `isTokenChar` on purpose: `=` is a token character because it is
 * base64 padding at the end of a value, but it is also the commonest thing to sit
 * immediately before one, and treating it as a word character there would hide
 * every assigned vendor token behind the generic assignment rule.
 */
const isWordCharBefore = (c: string) => /[A-Za-z0-9_.+/~-]/.test(c)
const isNameChar = (c: string) => /[A-Za-z0-9_.-]/.test(c)

/** A placeholder, a variable reference or an already-masked value. */
function isPlaceholder(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 6) return true
  if (/^[*xX.]+$/.test(trimmed)) return true
  if (/^[$%<{]/.test(trimmed)) return true
  if (trimmed.startsWith('env(') || trimmed.startsWith('REDACTED')) return true
  if (trimmed.includes('[redacted')) return true
  return !/[A-Za-z0-9]/.test(trimmed)
}

/** Every credential in `text`, in order, with overlaps merged. */
export function scanSecrets(text: string): SecretFinding[] {
  const raw: SecretFinding[] = []
  scanPrivateKeys(text, raw)
  scanPrefixes(text, raw)
  scanJwts(text, raw)
  scanAuthorization(text, raw)
  scanUrlPasswords(text, raw)
  scanAssignments(text, raw)

  // Position, then widest first, so a containing span survives the overlap pass.
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: SecretFinding[] = []
  for (const finding of raw) {
    const last = merged[merged.length - 1]
    if (last && finding.start < last.end) continue
    merged.push(finding)
  }
  // Line numbers once, at the end: doing it per rule would be six passes.
  let line = 1
  let cursor = 0
  for (const finding of merged) {
    line += countNewlines(text, cursor, finding.start)
    cursor = finding.start
    finding.line = line
  }
  return merged
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i += 1) if (text[i] === '\n') n += 1
  return n
}

/** True when `text` holds at least one credential. */
export function containsSecret(text: string): boolean {
  return scanSecrets(text).length > 0
}

/**
 * `text` with every credential replaced by `[redacted: <kind>]`.
 *
 * Length is not preserved: a redaction that kept the shape of the value would
 * leak the shape of the value. Everything outside a match is returned unchanged.
 */
export function redactSecrets(text: string): string {
  const findings = scanSecrets(text)
  if (findings.length === 0) return text
  let out = ''
  let cursor = 0
  for (const finding of findings) {
    out += text.slice(cursor, finding.start)
    out += `[redacted: ${finding.kind}]`
    cursor = finding.end
  }
  return out + text.slice(cursor)
}

/**
 * `redactSecrets` applied to every string in a JSON-ish value, keys untouched.
 *
 * Keys are field names a tool schema defines, not content; redacting them would
 * produce an object nothing could render.
 *
 * A field named `command` gets the wider command-line rules, because that is the
 * one place `--token value` appears -- a bare space separating a secret-named
 * flag from its value. Without this a stored command keeps the credential that
 * the same detector would have taken out of a `KEY=value` form, which is how the
 * activity timeline's own test caught it.
 */
export function redactSecretsDeep<T>(value: T, key?: string): T {
  if (typeof value === 'string') {
    return (key === 'command' ? redactCommandLine(value) : redactSecrets(value)) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, key)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [field, val] of Object.entries(value as Record<string, unknown>)) {
      out[field] = redactSecretsDeep(val, field)
    }
    return out as unknown as T
  }
  return value
}

/** PEM private-key blocks, whole: the body is the key, the armour alone is not. */
function scanPrivateKeys(text: string, out: SecretFinding[]): void {
  const OPEN = '-----BEGIN '
  let from = 0
  for (;;) {
    const start = text.indexOf(OPEN, from)
    if (start === -1) return
    const headerEnd = text.indexOf('-----\n', start)
    if (headerEnd === -1) return
    const header = text.slice(start, headerEnd + 6)
    if (!header.includes('PRIVATE KEY')) {
      from = headerEnd + 6
      continue
    }
    const closeAt = text.indexOf('-----END ', headerEnd)
    let end: number
    if (closeAt === -1) {
      end = text.length
    } else {
      const tail = text.indexOf('-----', closeAt + 9)
      end = tail === -1 ? text.length : tail + 5
    }
    out.push({ kind: 'private-key', line: 0, start, end })
    from = end
  }
}

function scanPrefixes(text: string, out: SecretFinding[]): void {
  for (const [prefix, minTail, kind] of PREFIXES) {
    let from = 0
    for (;;) {
      const start = text.indexOf(prefix, from)
      if (start === -1) break
      from = start + prefix.length
      if (start > 0 && isWordCharBefore(text[start - 1])) continue
      let end = start + prefix.length
      while (end < text.length && isTokenChar(text[end])) end += 1
      if (end - (start + prefix.length) < minTail) continue
      out.push({ kind, line: 0, start, end })
      from = end
    }
  }
}

/** Three dot-separated base64url segments whose header starts `eyJ`. */
function scanJwts(text: string, out: SecretFinding[]): void {
  const HEAD = 'eyJ'
  let from = 0
  for (;;) {
    const start = text.indexOf(HEAD, from)
    if (start === -1) return
    from = start + HEAD.length
    if (start > 0 && isWordCharBefore(text[start - 1])) continue
    let end = start
    while (end < text.length && /[A-Za-z0-9_.-]/.test(text[end])) end += 1
    let candidate = text.slice(start, end)
    candidate = candidate.replace(/\.+$/, '')
    const parts = candidate.split('.')
    if (parts.length !== 3 || parts.some((p) => p.length < 8)) continue
    out.push({ kind: 'jwt', line: 0, start, end: start + candidate.length })
    from = start + candidate.length
  }
}

/** The credential after an auth scheme; the scheme itself stays readable. */
function scanAuthorization(text: string, out: SecretFinding[]): void {
  for (const scheme of ['Bearer ', 'bearer ', 'Basic ', 'basic ', 'Token ']) {
    let from = 0
    for (;;) {
      const at = text.indexOf(scheme, from)
      if (at === -1) break
      from = at + scheme.length
      const valueStart = at + scheme.length
      let end = valueStart
      while (end < text.length && isTokenChar(text[end])) end += 1
      if (end - valueStart < 8) continue
      if (isPlaceholder(text.slice(valueStart, end))) continue
      out.push({ kind: 'authorization', line: 0, start: valueStart, end })
      from = end
    }
  }
}

/** `scheme://user:password@host` -- the password only. */
function scanUrlPasswords(text: string, out: SecretFinding[]): void {
  let from = 0
  for (;;) {
    const at = text.indexOf('://', from)
    if (at === -1) return
    const authorityStart = at + 3
    from = authorityStart
    let end = authorityStart
    while (end < text.length && !/[\s/?#"'`]/.test(text[end])) end += 1
    const authority = text.slice(authorityStart, end)
    const atSign = authority.lastIndexOf('@')
    if (atSign === -1) continue
    const userinfo = authority.slice(0, atSign)
    const colon = userinfo.indexOf(':')
    if (colon === -1) continue
    const start = authorityStart + colon + 1
    const passwordEnd = authorityStart + atSign
    if (passwordEnd <= start || isPlaceholder(text.slice(start, passwordEnd))) continue
    out.push({ kind: 'url-password', line: 0, start, end: passwordEnd })
    from = end
  }
}

/** Assignments whose name says the value is a secret. Scanned per line. */
function scanAssignments(text: string, out: SecretFinding[]): void {
  let offset = 0
  for (const line of text.split(/(?<=\n)/)) {
    scanAssignmentsInLine(line, offset, out)
    offset += line.length
  }
}

function scanAssignmentsInLine(
  line: string,
  offset: number,
  out: SecretFinding[]
): void {
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c !== '=' && c !== ':') {
      i += 1
      continue
    }
    // `::` is a path separator, not an assignment.
    if (c === ':' && (line[i + 1] === ':' || line[i - 1] === ':')) {
      i += 1
      continue
    }
    // Trailing quotes belong to the syntax: without trimming them the name of
    // `"password": "..."` reads as empty and the assignment is skipped.
    const beforeSeparator = line.slice(0, i).replace(/\s+$/, '').replace(/["']+$/, '')
    const nameEnd = beforeSeparator.length
    let nameStart = nameEnd
    while (nameStart > 0 && isNameChar(line[nameStart - 1])) nameStart -= 1
    const name = line.slice(nameStart, nameEnd).replace(/^["']|["']$/g, '')
    const lowered = name.toLowerCase()
    const isSecretName =
      name.length > 0 &&
      SECRET_NAMES.some((n) => lowered.includes(n)) &&
      !NAME_EXCEPTIONS.some((n) => lowered.includes(n))
    if (!isSecretName) {
      i += 1
      continue
    }

    let valueStart = i + 1
    while (valueStart < line.length && /[ \t=>"']/.test(line[valueStart])) {
      valueStart += 1
    }
    const opener = line[valueStart - 1]
    const closers =
      opener === '"' ? ['"'] : opener === "'" ? ["'"] : [' ', '\t', '\n', '\r', ',', ';', '}', ']', ')', '&', '|']
    let valueEnd = valueStart
    while (valueEnd < line.length && !closers.includes(line[valueEnd])) {
      valueEnd += 1
    }
    if (valueEnd > valueStart && !isPlaceholder(line.slice(valueStart, valueEnd))) {
      out.push({
        kind: 'secret',
        line: 0,
        start: offset + valueStart,
        end: offset + valueEnd,
      })
    }
    i = Math.max(valueEnd, i + 1)
  }
}

/**
 * `redactSecrets` with the wider rules a command line needs: `--token value`,
 * where a bare space separates the name from the value.
 *
 * Kept separate because a space is far too common a separator to treat as an
 * assignment everywhere, but on a command line it is exactly the form used.
 */
export function redactCommandLine(command: string): string {
  const findings = scanCommandLine(command)
  if (findings.length === 0) return command
  let out = ''
  let cursor = 0
  for (const finding of findings) {
    out += command.slice(cursor, finding.start)
    out += `[redacted: ${finding.kind}]`
    cursor = finding.end
  }
  return out + command.slice(cursor)
}

export function scanCommandLine(command: string): SecretFinding[] {
  const found = scanSecrets(command)
  let i = 0
  while (i < command.length) {
    if (command[i] !== '-') {
      i += 1
      continue
    }
    if (i > 0 && !/\s/.test(command[i - 1])) {
      i += 1
      continue
    }
    let flagEnd = i
    while (flagEnd < command.length && /[A-Za-z0-9_.-]/.test(command[flagEnd])) {
      flagEnd += 1
    }
    const flag = command.slice(i, flagEnd).replace(/^-+/, '').toLowerCase()
    i = flagEnd
    const isSecretFlag =
      SECRET_NAMES.some((n) => flag.includes(n)) &&
      !NAME_EXCEPTIONS.some((n) => flag.includes(n))
    if (!isSecretFlag) continue

    let valueStart = flagEnd
    while (valueStart < command.length && /[ \t"']/.test(command[valueStart])) {
      valueStart += 1
    }
    let valueEnd = valueStart
    while (valueEnd < command.length && !/[ \t\n"';&|]/.test(command[valueEnd])) {
      valueEnd += 1
    }
    if (valueEnd > valueStart && !isPlaceholder(command.slice(valueStart, valueEnd))) {
      found.push({ kind: 'secret', line: 1, start: valueStart, end: valueEnd })
    }
    i = Math.max(valueEnd, i)
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: SecretFinding[] = []
  for (const finding of found) {
    const last = merged[merged.length - 1]
    if (last && finding.start < last.end) continue
    merged.push(finding)
  }
  return merged
}
