/**
 * `@` references that can only name something inside the attached folder.
 * AH-204 (containment half).
 *
 * The picker used to search the user's home directory and a typed reference
 * was read with the unconfined filesystem API, so `@../x`, `@/etc/passwd` or
 * `@C:\Users\me\.ssh\id_rsa` inlined whatever it named into the prompt.
 *
 * Now a reference is a path *relative to the attached folder*, checked twice:
 * lexically here (no absolute path, drive, UNC or `~`, no `..` segment) and
 * then by the backend (`project_browse`), which canonicalizes against the
 * folder -- so a symlink that leads out of it is refused too -- and refuses
 * credential-shaped files. With no folder attached, nothing is offered and
 * nothing resolves.
 */
import {
  projectListDir,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import type { FilePickerEntry } from '@/types/path-reference'
import { errorText } from '@/lib/errorText'

export type ReferenceRefusal =
  | 'no-folder'
  | 'absolute'
  | 'escapes'
  | 'empty'
  | 'refused'

export type NormalizedReference =
  | { ok: true; rel: string }
  | { ok: false; reason: ReferenceRefusal }

/** The lexical check: a relative path with no way out of its root. */
export function normalizeReference(raw: string): NormalizedReference {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    trimmed.startsWith('~') ||
    /^[a-zA-Z]:/.test(trimmed) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  ) {
    return { ok: false, reason: 'absolute' }
  }
  const parts: string[] = []
  for (const part of trimmed.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') return { ok: false, reason: 'escapes' }
    parts.push(part)
  }
  if (parts.length === 0) return { ok: false, reason: 'empty' }
  return { ok: true, rel: parts.join('/') }
}

const MAX_DEPTH = 4
const MAX_VISITED = 400

/**
 * Entries under `root` matching `query`, relative to it. Walks through the
 * backend's confined listing, which already drops ignored, hidden-state and
 * escaping entries, so nothing outside the folder can be suggested.
 */
export async function searchReferences(
  dataFolder: string,
  root: string | null | undefined,
  query: string,
  limit = 50
): Promise<FilePickerEntry[]> {
  if (!root) return []
  const q = query.trim().toLowerCase()
  const out: { entry: FilePickerEntry; score: number }[] = []
  const queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }]
  let visited = 0
  while (queue.length && visited < MAX_VISITED) {
    const { rel, depth } = queue.shift()!
    let listing
    try {
      listing = await projectListDir(dataFolder, root, rel)
    } catch {
      continue
    }
    for (const e of listing.entries) {
      visited += 1
      const name = e.name
      const lower = name.toLowerCase()
      const score = !q
        ? 1
        : lower === q
          ? 100
          : lower.startsWith(q)
            ? 80
            : e.relPath.toLowerCase().includes(q)
              ? 60
              : 0
      if (score > 0) {
        out.push({
          score,
          entry: {
            path: e.relPath,
            name,
            kind: e.isDir ? 'directory' : 'file',
            extension: e.isDir
              ? undefined
              : name.split('.').pop()?.toLowerCase(),
          },
        })
      }
      // Without a query only the top level is offered, as before.
      if (e.isDir && q && depth + 1 < MAX_DEPTH) {
        queue.push({ rel: e.relPath, depth: depth + 1 })
      }
    }
  }
  out.sort(
    (a, b) =>
      (a.entry.kind === b.entry.kind
        ? 0
        : a.entry.kind === 'directory'
          ? -1
          : 1) ||
      b.score - a.score ||
      a.entry.path.length - b.entry.path.length
  )
  return out.slice(0, limit).map((x) => x.entry)
}

export type ResolvedReference =
  | { ok: true; rel: string; kind: 'file' | 'directory'; content: string }
  | { ok: false; raw: string; reason: ReferenceRefusal; message: string }

const REFUSAL_TEXT: Record<ReferenceRefusal, string> = {
  'no-folder':
    'no folder is attached, so there is nothing a reference can name',
  'absolute':
    'a reference is a path inside the attached folder, not an absolute path',
  'escapes': 'it leads outside the attached folder',
  'empty': 'it names nothing',
  'refused': 'it could not be read inside the attached folder',
}

/** Read one reference through the backend's confined reader. */
export async function resolveReference(
  dataFolder: string,
  root: string | null | undefined,
  raw: string
): Promise<ResolvedReference> {
  if (!root) {
    return {
      ok: false,
      raw,
      reason: 'no-folder',
      message: REFUSAL_TEXT['no-folder'],
    }
  }
  const normalized = normalizeReference(raw)
  if (!normalized.ok) {
    return {
      ok: false,
      raw,
      reason: normalized.reason,
      message: REFUSAL_TEXT[normalized.reason],
    }
  }
  const { rel } = normalized
  try {
    const file = await projectReadFile(dataFolder, root, rel, false)
    if (file.binary || file.oversized) {
      return {
        ok: false,
        raw,
        reason: 'refused',
        message: file.binary
          ? 'it is a binary file'
          : 'it is too large to include',
      }
    }
    return {
      ok: true,
      rel,
      kind: 'file',
      content: `--- File: ${rel} ---\n${file.content}\n--- End: ${rel} ---`,
    }
  } catch (fileError) {
    // Not a readable file: perhaps a folder, which is listed instead.
    try {
      const listing = await projectListDir(dataFolder, root, rel)
      const lines = listing.entries.map(
        (e) => `  ${e.name}${e.isDir ? '/' : ''}`
      )
      if (listing.truncated) lines.push('  ... (truncated)')
      return {
        ok: true,
        rel,
        kind: 'directory',
        content: `--- Directory: ${rel} ---\n${lines.join('\n')}`,
      }
    } catch {
      return {
        ok: false,
        raw,
        reason: 'refused',
        message: errorText(fileError),
      }
    }
  }
}
