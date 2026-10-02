import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

/**
 * The archive: deleting moves an item here first (src-tauri core/archive).
 * Thin wrappers over the Rust commands, plus the one cached flag the delete
 * paths need.
 */
export type ArchiveKind =
  | 'thread'
  | 'room'
  | 'cowork'
  | 'project'
  | 'assistant'
  | 'studio'

export type ArchivedItem = {
  archiveId: string
  kind: ArchiveKind
  /** The id the item had while it was live. */
  id: string
  title: string
  archivedAt: number
  origin: string
  storage: 'dir' | 'payload'
  extra?: unknown
  sizeBytes: number
}

export type ArchiveSettings = {
  enabled: boolean
  /** Purge archived items older than this many days; 0 keeps them forever. */
  autoDeleteDays: number
  /** Archive threads untouched for this many days; 0 is off. */
  autoArchiveThreadDays: number
}

export type Restored = {
  kind: ArchiveKind
  id: string
  title: string
  payload?: unknown
  extra?: unknown
}

export type Blocked = {
  kind: ArchiveKind
  archiveId: string
  title: string
  reason: string
}

/** A bounded, read-only look inside an archived item (`archive_preview`). */
export type ArchivePreview = {
  kind: ArchiveKind
  title: string
  createdAt?: number
  updatedAt?: number
  folder?: string
  participants: string[]
  messages: { role: string; text: string }[]
  /** How many messages or turns the item holds; above `messages.length` means cut. */
  totalMessages?: number
  threads: string[]
  instructions?: string
  fields: { label: string; value: string }[]
  /** A small picture as a data URL. */
  thumbnail?: string
}

export type PurgeReport = { purged: number; blocked: Blocked[] }

export const DEFAULT_ARCHIVE_SETTINGS: ArchiveSettings = {
  enabled: true,
  autoDeleteDays: 30,
  autoArchiveThreadDays: 0,
}

/**
 * Bumped whenever the archive's contents may have changed (an archive, restore
 * or purge finished). The Archive page refetches on it.
 */
export const useArchiveRevision = create<{ revision: number }>(() => ({
  revision: 0,
}))

const bumpArchive = () =>
  useArchiveRevision.setState((s) => ({ revision: s.revision + 1 }))

const inflight = new Set<Promise<unknown>>()

/**
 * Register archive work that runs in the background (a delete that moves a
 * thread into the archive is fire-and-forget: the UI drops the row at once).
 * Anyone listing the archive can then `settleArchiveWork()` first instead of
 * reading the folder halfway through the move, and the page refetches when it
 * ends.
 */
export function trackArchiveWork<T>(work: Promise<T>): Promise<T> {
  const tracked = work.finally(() => {
    inflight.delete(tracked)
    bumpArchive()
  })
  inflight.add(tracked)
  // The caller keeps the original rejection; this copy must not go unhandled.
  tracked.catch(() => undefined)
  return tracked
}

/** Resolves once every tracked archive operation has finished. */
export async function settleArchiveWork(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight])
  }
}

const changes = <T>(call: Promise<T>): Promise<T> => trackArchiveWork(call)

export const archiveApi = {
  list: async () => {
    await settleArchiveWork()
    return invoke<ArchivedItem[]>('archive_list')
  },
  diskUsage: () => invoke<number>('archive_disk_usage'),
  put: (
    kind: ArchiveKind,
    id: string,
    title: string,
    payload: unknown,
    extra?: unknown
  ) =>
    changes(invoke<string>('archive_put', { kind, id, title, payload, extra })),
  /** Read-only: does not restore, move or change anything. */
  preview: (kind: ArchiveKind, archiveId: string) =>
    invoke<ArchivePreview>('archive_preview', { kind, archiveId }),
  restore: (kind: ArchiveKind, archiveId: string) =>
    changes(invoke<Restored>('archive_restore', { kind, archiveId })),
  purge: (kind: ArchiveKind, archiveId: string) =>
    changes(invoke<void>('archive_purge', { kind, archiveId })),
  empty: (kind?: ArchiveKind) =>
    changes(invoke<PurgeReport>('archive_empty', { kind: kind ?? null })),
  getSettings: () => invoke<ArchiveSettings>('archive_get_settings'),
  setSettings: (settings: ArchiveSettings) =>
    invoke<ArchiveSettings>('archive_set_settings', { settings }),
}

/**
 * Destroy what was just archived. "Delete permanently" on a room or a Cowork
 * session archives it like any delete and then purges the newest archived copy
 * of that id, so those paths need no second delete route. A purge a guard
 * refuses (a Cowork session with unmerged work) throws its reason and the
 * item stays archived.
 */
export async function purgeArchived(kind: ArchiveKind, id: string): Promise<void> {
  const hit = (await archiveApi.list())
    .filter((i) => i.kind === kind && i.id === id)
    .sort((a, b) => b.archivedAt - a.archivedAt)[0]
  if (hit) await archiveApi.purge(kind, hit.archiveId)
}

let cached: boolean | null = null

/**
 * Whether delete currently archives. Read once and kept; `setArchiveEnabled`
 * keeps it in step with the setting. Outside Tauri, or if the read fails, this
 * is false so a delete behaves exactly as it did before the archive existed.
 */
export async function archiveEnabled(): Promise<boolean> {
  if (cached !== null) return cached
  try {
    cached = (await archiveApi.getSettings()).enabled
  } catch {
    return false
  }
  return cached
}

export function setArchiveEnabled(enabled: boolean): void {
  cached = enabled
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}
