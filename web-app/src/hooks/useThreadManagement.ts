import { archiveApi, archiveEnabled, trackArchiveWork } from '@/lib/archive'
import { create } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import type { ProjectModel, ThreadFolder } from '@/services/projects/types'
import { useEffect } from 'react'
import { useConversationGroups } from '@/lib/groups/store'

type ThreadManagementState = {
  folders: ThreadFolder[]
  setFolders: (folders: ThreadFolder[]) => void
  addFolder: (
    name: string,
    assistantId?: string,
    model?: ProjectModel
  ) => Promise<ThreadFolder>
  updateFolder: (
    id: string,
    name: string,
    assistantId?: string,
    model?: ProjectModel
  ) => Promise<void>
  /** `undefined` = every enabled server (the default). */
  setFolderMcpServers: (id: string, servers: string[] | undefined) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  /**
   * Delete a project and its threads. They move to the archive (the project
   * record too, so restoring it brings the threads back into it) unless
   * `permanent` is set.
   */
  deleteFolderWithThreads: (id: string, permanent?: boolean) => Promise<void>
  getFolderById: (id: string) => ThreadFolder | undefined
  getProjectById: (id: string) => Promise<ThreadFolder | undefined>
}

/**
 * Legacy projects API. Home groups are the source of truth: these actions write
 * the groups store, and `lib/groups/homeMirror` keeps `folders` and each
 * thread's `metadata.project` in step.
 */
export const useThreadManagementStore = create<ThreadManagementState>()((set, get) => ({
  folders: [],

  setFolders: (folders) => {
    set({ folders })
  },

  addFolder: async (name, assistantId, model) => {
    const projectsService = getServiceHub().projects()
    const id = await useConversationGroups.getState().createGroup('home', name)
    if (!id) throw new Error('Could not create the project')
    const group = useConversationGroups.getState().state.surfaces.home.groups.find((g) => g.id === id)!
    // One add per project instead of read-all/write-all, so a concurrent add
    // elsewhere is not overwritten.
    const folder = await projectsService.addProject(group.name, assistantId, model, id)
    set({ folders: await projectsService.getProjects() })
    return folder
  },

  updateFolder: async (id, name, assistantId, model) => {
    await useConversationGroups.getState().renameGroup('home', id, name)
    const projectsService = getServiceHub().projects()
    await projectsService.updateProject(id, name, assistantId, model)
    set({ folders: await projectsService.getProjects() })
  },

  setFolderMcpServers: async (id, servers) => {
    const projectsService = getServiceHub().projects()
    const projects = await projectsService.getProjects()
    await projectsService.setProjects(
      projects.map((p) => {
        if (p.id !== id) return p
        const rest = { ...p }
        delete rest.mcpServers
        return servers ? { ...rest, mcpServers: [...servers] } : rest
      })
    )
    set({ folders: await projectsService.getProjects() })
  },

  deleteFolder: async (id) => {
    // Members return to Recents; the mirror clears their `metadata.project`.
    await useConversationGroups.getState().deleteGroup('home', id)
    const projectsService = getServiceHub().projects()
    await projectsService.deleteProject(id)
    set({ folders: await projectsService.getProjects() })
  },

  // One tracked operation from the first thread move to the last, so the
  // Archive page waits for all of it and never lists a half-moved project.
  deleteFolderWithThreads: (id, permanent = false) =>
    trackArchiveWork(
      (async () => {
        const threadsState = useThreads.getState()
        const home = useConversationGroups.getState().state.surfaces.home
        const projectThreads = Object.values(threadsState.threads).filter(
          (thread) => home.memberships[thread.id]?.groupId === id || thread.metadata?.project?.id === id
        )

        // The project record is archived with the ids of its threads, so a
        // restore can put the threads back into a project of the same name.
        const folder = get().folders.find((f) => f.id === id)
        // One thread at a time: the store follows each backend delete, so a
        // failure part-way leaves the store, the backend and the project
        // record agreeing about which threads are gone.
        const removed: string[] = []
        // deleteThreadAsync drops the thread from the store, runs the cleanup
        // and the single backend delete, and rejects if the backend fails.
        try {
          for (const thread of projectThreads) {
            if (permanent) await threadsState.deleteThreadAsync(thread.id, true)
            else await threadsState.deleteThreadAsync(thread.id)
            removed.push(thread.id)
          }
        } catch (e) {
          console.warn('[Projects] Thread delete failed, keeping the project:', {
            removed,
            error: e,
          })
          throw e
        }
        // Reached only when every thread went; a throw above keeps the project.
        if (!permanent && folder && (await archiveEnabled())) {
          try {
            await archiveApi.put('project', id, folder.name, {
              folder,
              threadIds: removed,
            })
          } catch (e) {
            console.warn('[Projects] Failed to archive the project record:', e)
          }
        }
        await get().deleteFolder(id)
      })()
    ),

  getFolderById: (id) => {
    return get().folders.find((folder) => folder.id === id)
  },

  getProjectById: async (id) => {
    const projectsService = getServiceHub().projects()
    return await projectsService.getProjectById(id)
  },
}))

let syncing: Promise<void> | null = null

/**
 * Reads the projects from the service into the store. Every mounted consumer
 * calls this (a chat row each: hundreds in a long sidebar), so calls share one
 * read in flight, and the store is only written when the list really changed:
 * a fresh array each time re-rendered every row on every page change.
 */
export function syncProjects(): Promise<void> {
  if (syncing) return syncing
  syncing = (async () => {
    try {
      const projects = await getServiceHub().projects().getProjects()
      const current = useThreadManagementStore.getState().folders
      if (JSON.stringify(current) !== JSON.stringify(projects)) {
        useThreadManagementStore.setState({ folders: projects })
      }
    } catch (error) {
      console.error('Error syncing projects:', error)
    } finally {
      syncing = null
    }
  })()
  return syncing
}

export function useThreadManagement(): ThreadManagementState
export function useThreadManagement<T>(
  selector: (state: ThreadManagementState) => T
): T
export function useThreadManagement<T>(
  selector?: (state: ThreadManagementState) => T
) {
  // With a selector the caller re-renders only when its slice changes.
  const store = useThreadManagementStore(
    (selector ?? ((s: ThreadManagementState) => s)) as (
      state: ThreadManagementState
    ) => T | ThreadManagementState
  )

  // Load projects from service on mount
  useEffect(() => {
    void syncProjects()
  }, [])

  return store
}
