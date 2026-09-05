/**
 * Client-side gates for files that never reach the backend.
 *
 * The backend is, and stays, authoritative: `project_browse` enforces root
 * containment, symlink safety and the sensitive-name refusal for anything read
 * through it. But a file dropped onto the window or chosen from an `<input>`
 * arrives as bytes the browser already holds — no path, no backend call, no
 * containment question to ask. That path had no gate at all, so a dropped
 * `.env` opened and rendered like any other file.
 *
 * These mirror the backend's rules for exactly that case. The name list is
 * copied rather than imported — it guards a different door — and a test keeps
 * the two in step.
 */

/** Extensions that are secret-bearing whatever the file is called. */
const SECRET_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.keystore',
  '.jks',
  '.asc',
  '.gpg',
  '.kdbx',
]

/** Exact names that are credentials. */
const SECRET_NAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pgpass',
  'credentials',
  'credentials.json',
  'service-account.json',
])

/** Private-key file prefixes. */
const KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa']

/**
 * Does this name look like credentials?
 *
 * Mirrors `is_sensitive_name` in `project_browse.rs`. Name-based and
 * deliberately conservative: refusing one ordinary file is a far smaller harm
 * than rendering somebody's private key into a panel.
 */
export function isSensitiveName(name: string): boolean {
  const lower = (name.split(/[\\/]/).pop() ?? name).toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.')) return true
  if (SECRET_NAMES.has(lower)) return true
  if (KEY_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  return SECRET_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** A byte-order mark is encoding metadata, not part of the file's text. */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

const NUL = '\u0000'
const REPLACEMENT = '\uFFFD'

/**
 * Does this decoded text look like it was never text?
 *
 * `File.text()` decodes as UTF-8 and never throws: undecodable bytes become
 * U+FFFD. So "did the read fail" has to be asked of the result rather than
 * caught. A NUL settles it outright — text files do not contain them — and a
 * high density of replacement characters means the decode was mostly guesswork.
 *
 * This is what stops "extension beats MIME" from becoming a way to push
 * arbitrary binary through the text path by renaming a file `.txt`.
 */
export function looksBinary(text: string): boolean {
  if (text.length === 0) return false
  if (text.includes(NUL)) return true

  // Sample the head rather than the whole file: enough to judge, bounded.
  const sample = text.slice(0, 4096)
  let replacements = 0
  for (const char of sample) if (char === REPLACEMENT) replacements++
  return replacements / sample.length > 0.1
}

export type TextReadFailure = 'sensitive' | 'binary'

export type TextReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: TextReadFailure }

/**
 * Read a dropped or picked file as text, refusing what should not be read.
 *
 * Returns the reason rather than the text when it refuses, so the caller can
 * say which rule stopped it instead of reporting a generic failure.
 */
export async function readFileAsText(file: File): Promise<TextReadResult> {
  if (isSensitiveName(file.name)) return { ok: false, reason: 'sensitive' }
  const text = stripBom(await file.text())
  if (looksBinary(text)) return { ok: false, reason: 'binary' }
  return { ok: true, text }
}
