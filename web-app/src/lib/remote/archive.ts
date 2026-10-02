// RPC handlers for the archive. A phone names an item by an opaque key
// (`<kind>:<archive name>`) it got from `archive.list`; the desktop does the
// work through the same commands its own Archive page uses, so the Cowork
// worktree guard applies to a purge from a phone exactly as it does here.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import type {
  ArchiveEmptyResult,
  ArchiveKindWire,
  ArchiveListResult,
} from './protocol'

export type RemoteArchive = {
  list(): Promise<ArchiveListResult>
  restore(kind: ArchiveKindWire, name: string): Promise<void>
  /** Throws the guard's reason when the purge is refused. */
  purge(kind: ArchiveKindWire, name: string): Promise<void>
  empty(kind?: ArchiveKindWire): Promise<ArchiveEmptyResult>
}

export type ArchiveMethods =
  | 'archive.list'
  | 'archive.restore'
  | 'archive.purge'
  | 'archive.empty'

const KINDS: readonly string[] = ['thread', 'room', 'cowork', 'project', 'assistant', 'studio']

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

export function kindOfArchive(v: unknown): ArchiveKindWire {
  if (typeof v !== 'string' || !KINDS.includes(v)) {
    throw new RemoteRpcError('bad_params', 'Not an archive kind')
  }
  return v as ArchiveKindWire
}

/** Splits a key at its first colon; the name may itself contain one. */
export function parseKey(v: unknown): { kind: ArchiveKindWire; name: string } {
  const key = typeof v === 'string' ? v : ''
  const at = key.indexOf(':')
  const name = key.slice(at + 1)
  if (at < 1 || !name || name.length > 300) {
    throw new RemoteRpcError('bad_params', 'Not an archived item')
  }
  return { kind: kindOfArchive(key.slice(0, at)), name }
}

export function createArchiveHandlers(
  a?: RemoteArchive
): Pick<RemoteHandlers, ArchiveMethods> {
  const archive = (): RemoteArchive => {
    if (!a) throw new RemoteRpcError('not_implemented', 'The archive is not available from phones yet')
    return a
  }
  // A refused purge carries its reason to the phone instead of "internal".
  const reason = (e: unknown) =>
    new RemoteRpcError('refused', e instanceof Error ? e.message : String(e))
  return {
    'archive.list': () => archive().list(),
    'archive.restore': async (params) => {
      const { kind, name } = parseKey(rec(params).key)
      await archive().restore(kind, name).catch((e) => {
        throw reason(e)
      })
      return { ok: true }
    },
    'archive.purge': async (params) => {
      const { kind, name } = parseKey(rec(params).key)
      await archive().purge(kind, name).catch((e) => {
        throw reason(e)
      })
      return { ok: true }
    },
    'archive.empty': async (params) => {
      const raw = rec(params).kind
      return archive().empty(raw === undefined || raw === null ? undefined : kindOfArchive(raw))
    },
  }
}
