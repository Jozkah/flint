// Safe, conservative detection of explicit file references in Cowork assistant
// prose, so `@src/foo.ts` and `@src/foo.ts:24-48` become clickable links into
// the Code/Preview rail — without ever turning arbitrary prose or URLs into
// links.
//
// The design decision recorded in `codeOpen.ts` still holds: a path parsed out
// of free text is not a reliable reference. This narrows the risk to a single
// deliberate marker — a leading `@` that is not part of a word (so emails and
// `user@host` inside URLs never match) — and to paths that actually look like a
// file (a slash or an extension), reject traversal, absolute, Windows-drive,
// UNC and scheme-bearing strings, and are verified again at open time. That is
// the "restrict the first version to explicit @path references" path the
// requirement allows over unreliable generic parsing.
//
// Pure and DOM-free so the rules are testable without React or a markdown tree.

import { pathHref, parseInlinePath } from '@/lib/pathOpen'

/** One parsed reference: a repo/sandbox-relative path with an optional line. */
export type FileRef = {
  /** The reference text as written, without the leading `@` (e.g. `a/b.ts:2`). */
  raw: string
  /** The path portion, forward-slash, relative (e.g. `a/b.ts`). */
  path: string
  /** 1-based line, when the reference carried `:line`. */
  line?: number
  /** 1-based end line, when the reference carried `:line-end`. */
  endLine?: number
}

/** A run of plain text, or a detected reference, in document order. */
export type RefSegment =
  | { type: 'text'; text: string }
  | { type: 'ref'; ref: FileRef }

/** Max characters we will treat as a single path, to bound pathological input. */
const MAX_PATH_LEN = 255

/**
 * Whether `path` is a safe, source-like, repository-relative reference.
 *
 * Rejects anything that could escape containment or point off-repo: absolute
 * paths, Windows drive/UNC paths, `..` traversal, URL schemes, control
 * characters, and anything that does not look like a file (no slash and no
 * extension — so `@everyone`-style mentions never match). Backslashes are
 * rejected outright: git and the sandbox both speak forward slashes, and
 * allowing `\` would only invite Windows-path ambiguity.
 */
export function isSafeRefPath(path: string): boolean {
  if (!path || path.length > MAX_PATH_LEN) return false
  if (path.includes('\\')) return false // no backslashes at all
  if (path.startsWith('/')) return false // absolute POSIX
  if (/^[A-Za-z]:\//.test(path)) return false // Windows drive (C:/…)
  if (path.startsWith('//')) return false // UNC / protocol-relative
  if (path.includes('://')) return false // scheme / URL
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false // control chars
  // `..` as a whole segment, anywhere.
  if (/(^|\/)\.\.(\/|$)/.test(path)) return false
  // Must look like a file: contain a slash or a dotted extension.
  const hasExt = /\.[A-Za-z0-9]+$/.test(path)
  if (!path.includes('/') && !hasExt) return false
  // A trailing slash is a directory, not a file reference.
  if (path.endsWith('/')) return false
  return true
}

// `@` + a run of path chars (letters, digits, `.`, `_`, `-`, `/`) plus an
// optional `:line[-end]`. Matched greedily, then trailing sentence punctuation
// (a period, comma, closing bracket…) is stripped back off, so `see @a/b.ts.`
// keeps its period as text and `@a.ts:24` keeps its line.
const REF_RE = /@([A-Za-z0-9._\-/]+(?::\d+(?:-\d+)?)?)/g
const TRAILING_PUNCT = /[.,;:!?)\]}'"`]+$/
const BODY_RE = /^([A-Za-z0-9._\-/]+)(?::(\d+)(?:-(\d+))?)?$/

/** Whether the char before a match may precede a reference (not a word char). */
function boundaryOk(before: string | undefined): boolean {
  if (before === undefined) return true // start of string
  // A word char, `@`, or `/` before means it is part of something else (an
  // email local part, a `user@host`, a path already underway) — not a ref.
  return !/[A-Za-z0-9_@/]/.test(before)
}

/**
 * Split `text` into plain runs and detected references, in order. Text with no
 * reference returns a single text segment (or none for the empty string).
 */
export function parseFileRefs(text: string): RefSegment[] {
  const segments: RefSegment[] = []
  let last = 0
  REF_RE.lastIndex = 0
  for (let m = REF_RE.exec(text); m; m = REF_RE.exec(text)) {
    // Strip trailing sentence punctuation the greedy class swallowed.
    const body = m[1].replace(TRAILING_PUNCT, '')
    // Re-anchor the regex so the stripped punctuation is scanned as text.
    const matchEnd = m.index + 1 + body.length
    REF_RE.lastIndex = matchEnd

    const parsed = BODY_RE.exec(body)
    if (!parsed || !boundaryOk(text[m.index - 1]) || !isSafeRefPath(parsed[1])) {
      continue // leave it as plain text
    }
    const line = parsed[2] ? Number(parsed[2]) : undefined
    const endRaw = parsed[3] ? Number(parsed[3]) : undefined
    // A backwards range (`:20-10`) is malformed; drop the range, keep the file.
    const endLine =
      endRaw !== undefined && line !== undefined && endRaw >= line
        ? endRaw
        : undefined

    if (m.index > last) {
      segments.push({ type: 'text', text: text.slice(last, m.index) })
    }
    segments.push({ type: 'ref', ref: { raw: body, path: parsed[1], line, endLine } })
    last = matchEnd
  }
  if (last < text.length) {
    segments.push({ type: 'text', text: text.slice(last) })
  }
  return segments
}

/** True when `text` carries at least one valid reference. */
export function hasFileRef(text: string): boolean {
  return parseFileRefs(text).some((s) => s.type === 'ref')
}

// ---------------------------------------------------------------------------
// Markdown (mdast) plugin — turn detected references into link nodes carrying
// the ref in data-* attributes (not the href, so URL sanitization can't strip
// it), leaving every other node untouched.
// ---------------------------------------------------------------------------

/** Node types whose text must never be linkified (code, URLs, images). */
const OPAQUE = new Set([
  'link',
  'linkReference',
  'code',
  'inlineCode',
  'image',
  'imageReference',
  'definition',
  'html',
])

type MdNode = {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/** URL-fragment prefix carrying a file reference through markdown rendering.
 * A fragment href survives rehype sanitization (the same mechanism the
 * citation links rely on), where arbitrary data-* attributes would be stripped. */
export const FILE_REF_HREF_PREFIX = '#coworkfile-'

/** Build an mdast link node whose fragment href encodes the reference; the `a`
 * override in RenderMarkdown turns it into a Code/Preview opener. */
function refNode(ref: FileRef): MdNode {
  return {
    type: 'link',
    url: FILE_REF_HREF_PREFIX + encodeURIComponent(ref.raw),
    children: [{ type: 'text', value: `@${ref.raw}` }],
  }
}

function transform(node: MdNode): void {
  if (!node.children || OPAQUE.has(node.type)) return
  const next: MdNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const segments = parseFileRefs(child.value)
      if (segments.every((s) => s.type === 'text')) {
        next.push(child)
        continue
      }
      for (const seg of segments) {
        next.push(
          seg.type === 'text'
            ? { type: 'text', value: seg.text }
            : refNode(seg.ref)
        )
      }
    } else if (
      child.type === 'inlineCode' &&
      typeof child.value === 'string' &&
      parseInlinePath(child.value)
    ) {
      // A whole inline-code span that is a path: link it, keep the code look.
      next.push({
        type: 'link',
        url: pathHref(child.value.trim()),
        children: [child],
      })
    } else {
      transform(child)
      next.push(child)
    }
  }
  node.children = next
}

/**
 * remark plugin: rewrite `@path` references in text nodes into link nodes that
 * the `a` renderer turns into clickable Code/Preview openers. Inert wherever no
 * opener is provided (e.g. the chat surface), where they render as plain text.
 */
export function remarkFileRefs() {
  return (tree: MdNode) => {
    transform(tree)
  }
}

/**
 * Decode a `#coworkfile-…` fragment href (from the `a` override) back into a
 * validated `FileRef`, or `null` when the href is not one of ours or does not
 * survive re-validation. Re-parsing and re-validating here is defense in depth:
 * the button never trusts the href to be well-formed or contained.
 */
export function parseFileRefHref(href: unknown): FileRef | null {
  if (typeof href !== 'string' || !href.startsWith(FILE_REF_HREF_PREFIX)) {
    return null
  }
  let body: string
  try {
    body = decodeURIComponent(href.slice(FILE_REF_HREF_PREFIX.length))
  } catch {
    return null
  }
  const parsed = BODY_RE.exec(body)
  if (!parsed || !isSafeRefPath(parsed[1])) return null
  const line = parsed[2] ? Number(parsed[2]) : undefined
  const endRaw = parsed[3] ? Number(parsed[3]) : undefined
  const endLine =
    endRaw !== undefined && line !== undefined && endRaw >= line
      ? endRaw
      : undefined
  return { raw: body, path: parsed[1], line, endLine }
}
