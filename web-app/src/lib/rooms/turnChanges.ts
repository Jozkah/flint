/**
 * What a participant turn changed, for the transcript's change card. In an
 * isolated workspace the backend diffs the checkout; in the room's own folder
 * the turn's successful write/edit calls are the record (the folder may hold
 * other people's edits, which are not the participant's to report).
 */
import type { ChangeCounts } from '@/lib/coworkChangeSummary'
import type { RoomChangedFile, RoomToolActivity } from './types'

const EXCERPT_CHARS = 4_000

const lines = (text: unknown): string[] => {
  if (typeof text !== 'string' || text === '') return []
  const all = text.split('\n')
  return text.endsWith('\n') ? all.slice(0, -1) : all
}

export function changesFromToolCalls(calls: readonly RoomToolActivity[] | undefined): RoomChangedFile[] {
  const byPath = new Map<string, RoomChangedFile>()
  for (const c of calls ?? []) {
    if (!c.ok || (c.name !== 'write' && c.name !== 'edit')) continue
    const args = (c.args ?? {}) as Record<string, unknown>
    const path =
      (typeof args.path === 'string' && args.path) || (typeof args.file_path === 'string' && args.file_path)
    if (!path) continue
    const f = byPath.get(path) ?? { path, additions: 0, deletions: 0, excerpt: '' }
    const hunks: string[] = []
    if (c.name === 'write') {
      const added = lines(args.content)
      f.additions += added.length
      hunks.push(added.map((l) => `+${l}`).join('\n'))
    } else {
      for (const e of (Array.isArray(args.edits) ? args.edits : [args]) as Record<string, unknown>[]) {
        const oldL = lines(e?.old_string)
        const newL = lines(e?.new_string)
        f.deletions += oldL.length
        f.additions += newL.length
        hunks.push([...oldL.map((l) => `-${l}`), ...newL.map((l) => `+${l}`)].join('\n'))
      }
    }
    const excerpt = [f.excerpt, ...hunks].filter(Boolean).join('\n@@\n')
    f.excerpt = excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}\n… (truncated)` : excerpt
    byPath.set(path, f)
  }
  return [...byPath.values()].map((f) => (f.excerpt ? f : { ...f, excerpt: undefined }))
}

export function changeCounts(files: readonly RoomChangedFile[]): ChangeCounts {
  return {
    fileCount: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}
