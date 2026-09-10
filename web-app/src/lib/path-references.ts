/**
 * Utility for scanning, resolving, and searching @path file/folder references
 * in the chat input.
 *
 * - Searching and resolving are in `safeReferences.ts`, confined to the attached
 *   folder through the backend (AH-204). The unconfined home-directory search
 *   and reader that used to live here were removed.
 * - Selected paths are kept as text references (e.g. `@src/main.ts`) in the prompt.
 * - On submit, each @reference is resolved: files are read as text (with a 1MB cap),
 *   directories produce a listing, images produce inline data, and errors surface
 *   as inline notices.
 */
import type { FilePickerEntry } from '@/types/path-reference'

export type { FilePickerEntry }

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Regex scanning `@token` candidates in text. The `@` must not be glued to a
 * preceding word char, so `user@host` and `foo@bar.com` are not references;
 * `isReferenceToken` applies the remaining rules (URL, IPv4) on top.
 */
export const REFERENCE_PATTERN =
  /(?<![A-Za-z0-9_])@([^\s,;:!?'"`)\]}>]+(?::\d+(?:-\d+)?)?)/g

/**
 * The `:line` or `:start-end` suffix of a reference token, if it has one.
 *
 * A ranged reference names an exact excerpt rather than a file, and is
 * produced by a surface that already carries the excerpt — today the Cowork
 * code viewer, whose "Add to chat" emits `@src/example.ts:24-48` alongside
 * the lines the user selected. `parsePromptForReferences` and
 * `stripPromptReferences` therefore recognise the form and leave it alone,
 * rather than owning it.
 *
 * Recognising it is the whole point. The token class above used to stop at
 * the `:`, so `@src/example.ts:24-48` matched the bare path: the reference
 * was stripped down to a dangling `:24-48`, the selected lines were dropped
 * on the floor, and the resolver went looking for `src/example.ts` under the
 * *home directory* — reading a whole unrelated file into the prompt in place
 * of the handful of lines the user actually chose.
 */
export function lineRangeOf(
  raw: string
): { path: string; startLine: number; endLine: number } | null {
  const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(raw)
  if (!match) return null
  const startLine = Number(match[2])
  const endLine = match[3] === undefined ? startLine : Number(match[3])
  return { path: match[1], startLine, endLine }
}


/** True for tokens shaped like an IPv4 address (`1.2.3.4`), which are never
 *  file paths. A trailing period (sentence punctuation) is ignored. */
function isIpv4Like(raw: string): boolean {
  const trimmed = raw.replace(/\.+$/, '')
  const octets = trimmed.split('.')
  return (
    octets.length === 4 &&
    octets.every((o) => o.length > 0 && o.length <= 3 && /^\d+$/.test(o))
  )
}

/** True when a captured token qualifies as a file reference. */
function isReferenceToken(raw: string): boolean {
  return (
    raw.length > 0 &&
    !raw.startsWith('http://') &&
    !raw.startsWith('https://') &&
    !raw.startsWith('file://') &&
    !raw.includes('@') &&
    !isIpv4Like(raw)
  )
}

// ── Parsing references from text ─────────────────────────────────────────────

/**
 * Parse @path references from a prompt string.
 * Returns the raw path strings (e.g. `["src/main.ts", "../README.md"]`).
 */
export function parsePromptForReferences(text: string): string[] {
  const seen = new Set<string>()
  const refs: string[] = []
  let match: RegExpExecArray | null
  while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
    const raw = match[1]
    // Excerpt references belong to whoever produced them; see `lineRangeOf`.
    if (lineRangeOf(raw)) continue
    if (!isReferenceToken(raw)) continue
    if (!seen.has(raw)) {
      seen.add(raw)
      refs.push(raw)
    }
  }
  return refs
}

/**
 * Remove qualified @path references from `text`, leaving non-reference `@`
 * tokens (ssh/email addresses, bare IPs) intact, and normalise whitespace.
 */
export function stripPromptReferences(text: string): string {
  const cleaned = text.replace(REFERENCE_PATTERN, (match, raw: string) =>
    // An excerpt reference stays in the text: the surface that emitted it
    // expands it downstream, and it is the only trace of what was selected.
    !lineRangeOf(raw) && isReferenceToken(raw) ? '' : match
  )
  return cleaned.replace(/\s+/g, ' ').trim()
}

/**
 * Format a path as a @reference text for insertion into the prompt.
 */
export function formatPathReferenceText(path: string): string {
  return `@${path}`
}
