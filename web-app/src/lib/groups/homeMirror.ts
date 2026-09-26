/**
 * Home groups replaced legacy "projects". The groups store is the source of
 * truth; this keeps the legacy shapes other features still read in step:
 * - `thread.metadata.project` (assistant/memory binding, project page), and
 * - the projects list (`ThreadFolder[]`, same ids as Home groups).
 *
 * Changes flow one way, groups to legacy, except for one adoption rule: a
 * thread created with `metadata.project` (e.g. from the project page) joins
 * that group, since it has no membership yet.
 */
import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagementStore } from '@/hooks/useThreadManagement'
import type { ThreadFolder } from '@/services/projects/types'
import { chatFolderAdapter } from '@/lib/chatFolders'
import { inheritGroupFolders } from './inherit'
import { migrateProjects } from './migrateProjects'
import { useConversationGroups } from './store'
import type { ConversationGroup, SurfaceGroups } from './types'

type MirrorThread = Pick<Thread, 'id' | 'metadata'>
type ProjectMeta = { id: string; name: string; updated_at: number }

/** Threads whose `metadata.project` no longer matches their Home group. */
export function planThreadMirror(
  home: SurfaceGroups,
  threads: readonly MirrorThread[]
): { id: string; project: ProjectMeta | undefined }[] {
  const groups = new Map(home.groups.map((g) => [g.id, g]))
  const out: { id: string; project: ProjectMeta | undefined }[] = []
  for (const t of threads) {
    const gid = home.memberships[t.id]?.groupId
    const g = gid ? groups.get(gid) : undefined
    const current = t.metadata?.project as ProjectMeta | undefined
    if (!g) {
      if (current) out.push({ id: t.id, project: undefined })
    } else if (!current || current.id !== g.id || current.name !== g.name) {
      out.push({ id: t.id, project: { id: g.id, name: g.name, updated_at: g.updatedAt } })
    }
  }
  return out
}

export function projectsFromGroups(
  groups: readonly ConversationGroup[],
  existing: readonly ThreadFolder[]
): ThreadFolder[] {
  const assistants = new Map(existing.map((f) => [f.id, f.assistantId]))
  return [...groups]
    .sort((a, b) => a.position - b.position)
    .map((g) => ({
      id: g.id,
      name: g.name,
      updated_at: g.updatedAt,
      ...(assistants.get(g.id) ? { assistantId: assistants.get(g.id) } : {}),
    }))
}

let started = false

export function startHomeProjectsMirror(): () => void {
  if (started) return () => {}
  started = true
  let stopped = false
  const unsubs: (() => void)[] = []

  const mirror = async () => {
    const home = useConversationGroups.getState().state.surfaces.home
    const threadsState = useThreads.getState()
    for (const u of planThreadMirror(home, Object.values(threadsState.threads))) {
      const t = threadsState.threads[u.id]
      if (t) threadsState.updateThread(u.id, { metadata: { ...t.metadata, project: u.project } })
    }
    try {
      const service = getServiceHub().projects()
      const next = projectsFromGroups(home.groups, await service.getProjects())
      await service.setProjects(next)
      useThreadManagementStore.setState({ folders: next })
    } catch (error) {
      console.error('Syncing legacy projects failed:', error)
    }
  }

  const ready = () =>
    useConversationGroups.getState().loaded.home && !useThreads.getState().isLoadingThreads

  const start = async () => {
    const groups = useConversationGroups.getState()
    if (!groups.migratedProjects) {
      try {
        const folders = await getServiceHub().projects().getProjects()
        const data = migrateProjects(folders, Object.values(useThreads.getState().threads), Date.now())
        const current = groups.state.surfaces.home
        // Groups created before the import (none on a first run) are kept.
        const merged = {
          groups: [...data.groups, ...current.groups.filter((g) => !data.groups.some((d) => d.id === g.id))],
          memberships: { ...data.memberships, ...current.memberships },
          contexts: current.contexts,
        }
        await groups.importSurface('home', merged, true)
      } catch (error) {
        // Never block the sidebar; projects stay untouched and are retried next start.
        console.error('Importing projects into Home groups failed:', error)
        return
      }
    }
    if (stopped) return
    await mirror()

    let prevHome = useConversationGroups.getState().state.surfaces.home
    unsubs.push(
      useConversationGroups.subscribe((s) => {
        if (s.state.surfaces.home === prevHome) return
        prevHome = s.state.surfaces.home
        void mirror()
      })
    )

    let known = new Set(Object.keys(useThreads.getState().threads))
    unsubs.push(
      useThreads.subscribe((s) => {
        const ids = Object.keys(s.threads)
        if (ids.length === known.size && ids.every((id) => known.has(id))) return
        const home = useConversationGroups.getState().state.surfaces.home
        for (const id of ids) {
          if (known.has(id)) continue
          const pid = (s.threads[id]?.metadata?.project as ProjectMeta | undefined)?.id
          if (pid && !home.memberships[id] && home.groups.some((g) => g.id === pid)) {
            // A chat started in a group gets the group's folders.
            void useConversationGroups
              .getState()
              .moveItem('home', id, pid, 0)
              .then((ok) =>
                ok ? inheritGroupFolders('home', id, pid, chatFolderAdapter) : undefined
              )
          }
        }
        known = new Set(ids)
      })
    )
  }

  if (ready()) void start()
  else {
    const check = () => {
      if (stopped || !ready()) return
      unsubA()
      unsubB()
      void start()
    }
    const unsubA = useConversationGroups.subscribe(check)
    const unsubB = useThreads.subscribe(check)
    unsubs.push(unsubA, unsubB)
  }

  return () => {
    stopped = true
    started = false
    unsubs.forEach((u) => u())
  }
}
