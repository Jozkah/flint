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
  /(^|[^A-Za-z0-9_])@((?:skill|agent|alias):[A-Za-z0-9][A-Za-z0-9_.-]*|(?:chat|session|room):(?:"[^"\r\n]{1,80}"|[A-Za-z0-9][A-Za-z0-9_.-]*)(?:#summary)?|[^\s,;:!?'"`)\]}>]+(?::\d+(?:-\d+)?)?)/g

/** The kinds of `@` reference that name something other than a path. */
export type TypedReferenceKind =
  | 'skill'
  | 'agent'
  | 'alias'
  | 'chat'
  | 'session'
  | 'room'

/**
 * A reference that names a skill, a saved agent or an alias rather than a
 * path: `@skill:name`, `@agent:name`, `@alias:name`. AH-204. The prefix is
 * what keeps the three apart from each other and from a file of the same
 * name, and what makes the inserted text a stable identifier rather than a
 * display label.
 */
export function typedReference(
  raw: string
): { kind: TypedReferenceKind; name: string; summary?: boolean } | null {
  const match =
    /^(?:(skill|agent|alias):([A-Za-z0-9][A-Za-z0-9_.-]*)|(chat|session|room):("[^"\r\n]{1,80}"|[A-Za-z0-9][A-Za-z0-9_.-]*)(#summary)?)$/.exec(
      raw
    )
  if (!match) return null
  // `@chat:`, `@session:` and `@room:` name another conversation, not a path
  // (docs/CHAT_MENTIONS.md); `#summary` asks for a summary of it.
  if (match[3])
    return {
      kind: match[3] as TypedReferenceKind,
      name: match[4],
      ...(match[5] ? { summary: true } : {}),
    }
  return { kind: match[1] as TypedReferenceKind, name: match[2] }
}

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

// ── Text an @ is never read in ───────────────────────────────────────────────

/**
 * Spans of `text` whose `@` is literal: fenced code blocks (an unclosed fence
 * runs to the end, as markdown reads it) and inline code spans. Pasted Python
 * is full of `@property` and `@app.route`, and neither backticks nor a
 * backslash used to keep them from being read as file references.
 */
function codeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const code = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g
  let m: RegExpExecArray | null
  while ((m = code.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length])
  }
  return spans
}

const inSpan = (spans: Array<[number, number]>, at: number): boolean =>
  spans.some(([from, to]) => at >= from && at < to)

/**
 * Whether the `@` of a pattern match is a literal one: inside code, or
 * escaped with a backslash (`\@property`).
 */
function isLiteralAt(
  spans: Array<[number, number]>,
  pre: string,
  index: number
): boolean {
  return pre === '\\' || inSpan(spans, index + pre.length)
}

// ── Parsing references from text ─────────────────────────────────────────────

/**
 * Parse @path references from a prompt string.
 * Returns the raw path strings (e.g. `["src/main.ts", "../README.md"]`).
 */
export function parsePromptForReferences(text: string): string[] {
  const seen = new Set<string>()
  const refs: string[] = []
  const spans = codeSpans(text)
  REFERENCE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
    const raw = match[2]
    if (isLiteralAt(spans, match[1], match.index)) continue
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
 * A reference named in `keep` stays too: `@property` in unfenced pasted code is
 * code, not a file that failed to load.
 */
export function stripPromptReferences(
  text: string,
  /** References that did not resolve: left in the text as typed. */
  keep?: ReadonlySet<string>
): string {
  const spans = codeSpans(text)
  const cleaned = text.replace(
    REFERENCE_PATTERN,
    (match, pre: string, raw: string, offset: number) => {
    // Escaped: the backslash was only there to say so, so it goes and the
    // `@` stays. Inside code nothing is touched.
    if (inSpan(spans, offset + pre.length)) return match
    if (pre === '\\') return match.slice(1)
    // A skill or agent reference is an instruction, read from the text by
    // what acts on it, so it stays. An alias is replaced by what it names.
    const typed = typedReference(raw)
    if (typed) return typed.kind === 'alias' ? pre + REMOVED_MARK : match
    // An excerpt reference stays in the text: the surface that emitted it
    // expands it downstream, and it is the only trace of what was selected.
    if (keep?.has(raw)) return match
    return !lineRangeOf(raw) && isReferenceToken(raw) ? pre + REMOVED_MARK : match
    }
  )
  // Only the gaps a removed token leaves are closed: runs of spaces the user
  // typed (aligned columns, pasted code, indentation) stay as written (LIBC-018).
  return cleaned
    .replace(REMOVED_GAP, (gap: string, offset: number, all: string) => {
      const atLineStart = offset === 0 || all[offset - 1] === '\n'
      const end = offset + gap.length
      const atLineEnd = end >= all.length || all[end] === '\n' || all[end] === '\r'
      // Keep a line's indentation; drop the gap at either end of a line.
      if (atLineStart) return atLineEnd ? '' : gap.slice(0, gap.indexOf(REMOVED_MARK))
      return atLineEnd ? '' : ' '
    })
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/** Stands in for a removed reference until the gap it left is closed. */
const REMOVED_MARK = ''
const REMOVED_GAP = /[ \t]*(?:[ \t]*)+/g

/**
 * Format a path as a @reference text for insertion into the prompt.
 */
export function formatPathReferenceText(path: string): string {
  return `@${path}`
}
