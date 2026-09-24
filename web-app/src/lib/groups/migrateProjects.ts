/**
 * One-time import of legacy Home "projects" (ThreadFolder + a thread's
 * `metadata.project`) into Home groups. Group ids reuse project ids so the
 * `/project/$projectId` route and `metadata.project` mirrors stay valid.
 * Members keep their current recent-activity order.
 */
import type { SurfaceGroups } from './types'

type LegacyFolder = { id: string; name: string; updated_at?: number }
type LegacyThread = { id: string; updated?: number; metadata?: { project?: { id?: string } } }

export function migrateProjects(
  folders: readonly LegacyFolder[],
  threads: readonly LegacyThread[],
  now: number
): SurfaceGroups {
  const valid = folders.filter((f) => f && typeof f.id === 'string' && f.id)
  const ids = new Set<string>()
  const groups = valid
    .filter((f) => (ids.has(f.id) ? false : (ids.add(f.id), true)))
    .map((f, position) => ({
      id: f.id,
      surface: 'home' as const,
      name: (typeof f.name === 'string' && f.name.trim()) || 'Untitled group',
      position,
      collapsed: false,
      folderBindings: [],
      createdAt: f.updated_at ?? now,
      updatedAt: f.updated_at ?? now,
    }))

  const memberships: SurfaceGroups['memberships'] = {}
  const byGroup = new Map<string, LegacyThread[]>()
  for (const t of threads) {
    const gid = t.metadata?.project?.id
    if (!gid || !ids.has(gid)) continue
    const list = byGroup.get(gid) ?? []
    list.push(t)
    byGroup.set(gid, list)
  }
  for (const [gid, list] of byGroup) {
    list
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .forEach((t, position) => {
        memberships[t.id] = { groupId: gid, itemId: t.id, position }
      })
  }
  return { groups, memberships, contexts: {} }
}
