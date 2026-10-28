/**
 * The review step before a participant's isolated-workspace change is written
 * into the user's folder: the patch split per file, counts, the dry-run result
 * and the user's own uncommitted edits to the same files.
 *
 * Display and selection only. The patch that is applied is built by the
 * backend from the selected paths; `buildPatch` exists for "Copy patch".
 */
import { parseUnifiedDiff, type ParsedDiff } from '@/lib/unifiedDiff'

export type PatchFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export type PatchFile = {
  /** The path after the change; the old path for a deleted file. */
  path: string
  /** The path before a rename. */
  oldPath?: string
  status: PatchFileStatus
  binary: boolean
  additions: number
  deletions: number
  /** This file's part of the patch, byte for byte. */
  raw: string
  /** Parsed for display (CRLF folded to LF). */
  diff: ParsedDiff
}

/** What the backend's dry run reports (`room_workspace_apply_preview`). */
export type ApplyPreview = {
  patch: string
  target: string
  clean: boolean
  files: { path: string; ok: boolean; reason?: string }[]
  dirty: string[]
}

/** Undo git's C-style quoting of an unusual path (`"a\tb"`, octal UTF-8). */
export function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p
  const bytes: number[] = []
  const body = p.slice(1, -1)
  const enc = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...enc.encode(c))
      continue
    }
    const n = body[++i]
    if (n === undefined) {
      bytes.push(0x5c)
      break
    }
    if (/^[0-7]{3}$/.test(body.slice(i, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' }
      bytes.push(...enc.encode(map[n] ?? n))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

const stripSide = (p: string, side: 'a/' | 'b/'): string => {
  const u = unquotePath(p.trim())
  return u.startsWith(side) ? u.slice(2) : u
}

/** Paths from `diff --git a/X b/Y`, used only when nothing better is present. */
function headerPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+(.+)$/.exec(rest)
    return m ? [stripSide(m[1], 'a/'), stripSide(m[2], 'b/')] : null
  }
  // Unquoted: a/X b/X has the same path twice; split in the middle.
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest[half] === ' ') {
    return [stripSide(rest.slice(0, half), 'a/'), stripSide(rest.slice(half + 1), 'b/')]
  }
  const i = rest.indexOf(' b/')
  return i > 0 ? [stripSide(rest.slice(0, i), 'a/'), stripSide(rest.slice(i + 1), 'b/')] : null
}

/** Split a git patch into one entry per file. */
export function splitPatch(patch: string): PatchFile[] {
  const groups: string[][] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) groups.push([line])
    else groups[groups.length - 1]?.push(line)
  }
  return groups.map((lines, i) => {
    // Every chunk but the last ends with the newline that preceded the next header.
    const raw = lines.join('\n') + (i < groups.length - 1 ? '\n' : '')
    return fileOf(lines, raw)
  })
}

function fileOf(lines: string[], raw: string): PatchFile {
  let oldPath: string | undefined
  let newPath: string | undefined
  let renameFrom: string | undefined
  let renameTo: string | undefined
  let status: PatchFileStatus = 'modified'
  let binary = false
  for (const l0 of lines) {
    const l = l0.replace(/\r$/, '')
    if (l.startsWith('@@')) break
    if (l.startsWith('new file mode')) status = 'added'
    else if (l.startsWith('deleted file mode')) status = 'deleted'
    else if (l.startsWith('rename from ')) renameFrom = unquotePath(l.slice(12))
    else if (l.startsWith('rename to ')) renameTo = unquotePath(l.slice(10))
    else if (l.startsWith('--- ') && l !== '--- /dev/null') oldPath = stripSide(l.slice(4), 'a/')
    else if (l.startsWith('+++ ') && l !== '+++ /dev/null') newPath = stripSide(l.slice(4), 'b/')
    else if (l === 'GIT binary patch' || /^Binary files .* differ$/.test(l)) binary = true
  }
  if (renameTo) status = 'renamed'
  const header = headerPaths(lines[0].replace(/\r$/, ''))
  const before = renameFrom ?? oldPath ?? header?.[0] ?? ''
  const after = renameTo ?? newPath ?? header?.[1] ?? before
  const path = status === 'deleted' ? before : after
  const diff = binary
    ? { hunks: [], additions: 0, deletions: 0, unstructured: false }
    : parseUnifiedDiff(raw.replace(/\r\n/g, '\n').replace(/\n+$/, ''))
  return {
    path,
    ...(status === 'renamed' ? { oldPath: before } : {}),
    status,
    binary,
    additions: diff.additions,
    deletions: diff.deletions,
    raw,
    diff: diff.unstructured ? { hunks: [], additions: 0, deletions: 0, unstructured: false } : diff,
  }
}

export function summarize(files: readonly PatchFile[]): { fileCount: number; additions: number; deletions: number } {
  return files.reduce(
    (s, f) => ({ fileCount: s.fileCount + 1, additions: s.additions + f.additions, deletions: s.deletions + f.deletions }),
    { fileCount: 0, additions: 0, deletions: 0 }
  )
}

/** The patch for only the selected files, in the original order. */
export const buildPatch = (files: readonly PatchFile[], selected: ReadonlySet<string>): string => {
  const chosen = files.filter((f) => selected.has(f.path))
  return chosen.map((f, i) => (i === chosen.length - 1 && !f.raw.endsWith('\n') ? f.raw + '\n' : f.raw)).join('')
}

export type Preflight =
  | { state: 'checking' }
  | { state: 'failed'; message: string }
  | { state: 'nothing' }
  | { state: 'clean' }
  | { state: 'conflict'; conflicts: { path: string; reason?: string }[] }

/** Whether the selected files would apply, from the dry run done on open. */
export function preflight(
  preview: ApplyPreview | null,
  selected: ReadonlySet<string>,
  error?: string | null
): Preflight {
  if (error) return { state: 'failed', message: error }
  if (!preview) return { state: 'checking' }
  if (selected.size === 0) return { state: 'nothing' }
  if (preview.clean) return { state: 'clean' }
  const conflicts = preview.files
    .filter((f) => selected.has(f.path) && !f.ok)
    .map((f) => ({ path: f.path, ...(f.reason ? { reason: f.reason } : {}) }))
  return conflicts.length ? { state: 'conflict', conflicts } : { state: 'clean' }
}

export const canApply = (p: Preflight): boolean => p.state === 'clean'

/** The user's uncommitted edits among the selected files. */
export const dirtyOverlap = (preview: ApplyPreview | null, files: readonly PatchFile[], selected: ReadonlySet<string>): string[] => {
  if (!preview?.dirty.length) return []
  const touched = new Set(files.filter((f) => selected.has(f.path)).flatMap((f) => [f.path, f.oldPath ?? f.path]))
  return preview.dirty.filter((p) => touched.has(p))
}

/** One rendered row of a file's diff: a hunk heading or a line. */
export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'remove' | 'context' | 'meta'; text: string; oldNumber?: number; newNumber?: number }

export function diffRows(diff: ParsedDiff): DiffRow[] {
  const rows: DiffRow[] = []
  for (const h of diff.hunks) {
    if (h.header) rows.push({ kind: 'hunk', text: h.heading ? `${h.header} ${h.heading}` : h.header })
    for (const l of h.lines) rows.push({ kind: l.kind, text: l.content, oldNumber: l.oldNumber, newNumber: l.newNumber })
  }
  return rows
}

/** The one gutter number of a row: old line for a removal, new line otherwise, none for hunks/notes. */
export const gutterNumber = (r: DiffRow): number | undefined =>
  r.kind === 'hunk' || r.kind === 'meta' ? undefined : r.kind === 'remove' ? r.oldNumber : r.newNumber

/** Rows shown per file before "Show more"; each click adds as many again. */
export const ROWS_PAGE = 400

/** The rows to render now, and how many stay hidden. */
export const capRows = (rows: readonly DiffRow[], limit: number): { shown: readonly DiffRow[]; hidden: number } =>
  rows.length <= limit ? { shown: rows, hidden: 0 } : { shown: rows.slice(0, limit), hidden: rows.length - limit }
