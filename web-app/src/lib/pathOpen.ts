// Which file paths in a reply may become links, and what a click does.
//
// Pure and DOM-free. Two questions live here:
//
//  1. `parseInlinePath`: is this whole inline-code span a file path? Strict on
//     purpose. Prose is never scanned, and `npm install`, `v1.2.3`, `e.g.`,
//     `foo.bar()` and `Node.js` stay plain.
//  2. `classifyPath`: given the folders a session holds, what may a click do?
//     Open in the Code panel, open in the OS, reveal in the file manager, or
//     nothing (outside every folder: stays plain text).
//
// This is a client-side check. It lexically resolves `.`/`..` and compares
// folders case-insensitively on Windows/UNC paths, but it cannot see symlinks
// or junctions; the real boundary would be a Rust command that canonicalizes.

import { isSourcePath } from '@/lib/coworkCode'

/** URL-fragment prefix carrying an inline-code path through markdown. */
export const PATH_HREF_PREFIX = '#coworkpath-'

const MAX_LEN = 260

/** Opening these runs code, so a click only reveals them in the file manager. */
export const EXECUTABLE_EXTS: ReadonlySet<string> = new Set([
  'exe',
  'bat',
  'cmd',
  'ps1',
  'lnk',
  'msi',
  'sh',
  'app',
  'com',
  'scr',
])

export type InlinePath = {
  /** Normalized: forward slashes, `.`/`..` resolved, no trailing slash. */
  path: string
  absolute: boolean
  line?: number
  endLine?: number
}

type Normalized = { path: string; absolute: boolean; caseInsensitive: boolean }

/** Collapse separators and resolve `.`/`..`; null if it climbs above its root. */
export function normalizePath(raw: string): Normalized | null {
  const unified = raw.trim().replace(/\\/g, '/')
  let prefix: string
  let rest: string
  let floor = 0
  let absolute = true
  let caseInsensitive = false
  if (/^[A-Za-z]:(\/|$)/.test(unified)) {
    prefix = unified.slice(0, 2).toUpperCase()
    rest = unified.slice(2)
    caseInsensitive = true
  } else if (unified.startsWith('//')) {
    prefix = '/'
    rest = unified.slice(2)
    floor = 2 // \\server\share can never be climbed out of
    caseInsensitive = true
  } else if (unified.startsWith('/')) {
    prefix = ''
    rest = unified
  } else {
    prefix = ''
    rest = unified
    absolute = false
  }
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length <= floor) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  if (floor && out.length < floor) return null
  if (!absolute) return out.length ? { path: out.join('/'), absolute, caseInsensitive } : null
  const body = out.join('/')
  const path =
    prefix === '/' ? `//${body}` : `${prefix}/${body}`.replace(/\/$/, prefix ? '/' : '')
  return { path: path || '/', absolute, caseInsensitive }
}

// Control characters are exactly what this guard is meant to reject.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>|"?*`$'(){};,=!&^%\u0000-\u001f\u007f]/
const LINE_SUFFIX = /^(.+?):(\d+)(?::\d+)?(?:-(\d+))?$/
// Names that read as a project rather than a file when written bare.
const NOT_A_FILE = /^(node|next|nuxt|vue|react|three|chart|d3|express|alpine|ember|backbone|angular|socket|p5|deno|bun|tone|pixi|phaser|moment|day|lodash|underscore)\.(js|ts)$/i

/**
 * Parse a whole inline-code span as a file path, or null. Absolute paths
 * (drive, UNC, POSIX) may be folders; relative ones must be a source-looking
 * file, with a slash or a known file name/extension.
 */
export function parseInlinePath(value: string): InlinePath | null {
  const text = value.trim()
  if (!text || text.length > MAX_LEN || FORBIDDEN.test(text)) return null
  if (text.includes('://')) return null

  let body = text
  let line: number | undefined
  let endLine: number | undefined
  const m = LINE_SUFFIX.exec(text)
  if (m) {
    body = m[1]
    line = Number(m[2])
    if (m[3] !== undefined && Number(m[3]) >= line) endLine = Number(m[3])
    if (line < 1) return null
  }

  const driveOrUnc = /^([A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s])/.test(body)
  if (/\s/.test(body) && !driveOrUnc) return null // spaces only in Windows paths
  if (/\s{2,}|\s$/.test(body)) return null

  const norm = normalizePath(body)
  if (!norm) return null
  const hasSlash = /[\\/]/.test(body)

  if (norm.absolute) {
    if (norm.path === '/' || /^[A-Za-z]:\/$/.test(norm.path)) return null // a filesystem root
    if (!driveOrUnc && !/^\/[^/\s]/.test(norm.path)) return null
    return { path: norm.path, absolute: true, line, endLine }
  }

  // Relative: must be a source file. Bare names also need to look like a file.
  if (body.startsWith('~') || /^\.\.?$/.test(body)) return null
  if (!isSourcePath(norm.path)) return null
  if (!hasSlash) {
    if (NOT_A_FILE.test(norm.path)) return null
    const name = norm.path
    const dotted = /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(name)
    if (!dotted && /\./.test(name)) return null
  }
  return { path: norm.path, absolute: false, line, endLine }
}

/** Fragment href for an inline-code path (the original text, line included). */
export const pathHref = (text: string): string =>
  PATH_HREF_PREFIX + encodeURIComponent(text)

/** Decode and re-validate a `#coworkpath-` href; null if not ours or invalid. */
export function parsePathHref(href: unknown): InlinePath | null {
  if (typeof href !== 'string' || !href.startsWith(PATH_HREF_PREFIX)) return null
  try {
    return parseInlinePath(decodeURIComponent(href.slice(PATH_HREF_PREFIX.length)))
  } catch {
    return null
  }
}

/** Is normalized `path` inside (or equal to) any of `roots`? Roots that are a
 * filesystem root, or not absolute, never match. */
export function isInsideRoots(roots: readonly string[], path: string): boolean {
  const p = normalizePath(path)
  if (!p || !p.absolute) return false
  for (const root of roots) {
    const r = normalizePath(root)
    if (!r || !r.absolute || r.path === '/' || /^[A-Za-z]:\/$/.test(r.path)) continue
    if (r.caseInsensitive !== p.caseInsensitive) continue
    const a = r.caseInsensitive ? r.path.toLowerCase() : r.path
    const b = p.caseInsensitive ? p.path.toLowerCase() : p.path
    if (b === a || b.startsWith(`${a}/`)) return true // not `/work/proj2`
  }
  return false
}

export const isExecutablePath = (path: string): boolean => {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && EXECUTABLE_EXTS.has(name.slice(dot + 1).toLowerCase())
}

export type PathAction =
  | { kind: 'code'; path: string }
  | { kind: 'open'; path: string }
  | { kind: 'reveal'; path: string }
  | { kind: 'none' }

/**
 * What a click on `parsed` does. `roots` are the session's folders;
 * `canOpenInCode` is true where a Code panel exists and accepts this path.
 */
export function classifyPath(
  parsed: InlinePath,
  ctx: { roots: readonly string[]; canOpenInCode: boolean }
): PathAction {
  if (!parsed.absolute) {
    // Resolved by the Code panel against the project/sandbox when clicked.
    return ctx.canOpenInCode && isSourcePath(parsed.path)
      ? { kind: 'code', path: parsed.path }
      : { kind: 'none' }
  }
  if (!isInsideRoots(ctx.roots, parsed.path)) return { kind: 'none' }
  if (isExecutablePath(parsed.path)) {
    return { kind: 'reveal', path: toOsPath(parsed.path) }
  }
  if (ctx.canOpenInCode && isSourcePath(parsed.path)) {
    return { kind: 'code', path: parsed.path }
  }
  return { kind: 'open', path: toOsPath(parsed.path) }
}

/** The spelling the OS shell wants: backslashes for drive and UNC paths. */
export function toOsPath(path: string): string {
  return /^([A-Za-z]:|\/\/)/.test(path) ? path.replace(/\//g, '\\') : path
}
