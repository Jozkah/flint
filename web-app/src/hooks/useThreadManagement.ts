import { archiveApi, archiveEnabled, trackArchiveWork } from '@/lib/archive'
import { create } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import type { ThreadFolder } from '@/services/projects/types'
import { useEffect } from 'react'
import { useConversationGroups } from '@/lib/groups/store'

type ThreadManagementState = {
  folders: ThreadFolder[]
  setFolders: (folders: ThreadFolder[]) => void
  addFolder: (name: string, assistantId?: string) => Promise<ThreadFolder>
  updateFolder: (id: string, name: string, assistantId?: string) => Promise<void>
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

  addFolder: async (name, assistantId) => {
    const projectsService = getServiceHub().projects()
    const id = await useConversationGroups.getState().createGroup('home', name)
    if (!id) throw new Error('Could not create the project')
    const group = useConversationGroups.getState().state.surfaces.home.groups.find((g) => g.id === id)!
    const folder: ThreadFolder = { id, name: group.name, updated_at: group.updatedAt, assistantId }
    const others = (await projectsService.getProjects()).filter((f) => f.id !== id)
    await projectsService.setProjects([...others, folder])
    set({ folders: await projectsService.getProjects() })
    return folder
  },

  updateFolder: async (id, name, assistantId) => {
    await useConversationGroups.getState().renameGroup('home', id, name)
    const projectsService = getServiceHub().projects()
    await projectsService.updateProject(id, name, assistantId)
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

        const serviceHub = getServiceHub()
        // The project record is archived with the ids of its threads, so a
        // restore can put the threads back into a project of the same name.
        const folder = get().folders.find((f) => f.id === id)
        // One thread at a time: the store follows each backend delete, so a
        // failure part-way leaves the store, the backend and the project
        // record agreeing about which threads are gone.
        const removed: string[] = []
        for (const thread of projectThreads) {
          if (permanent) await serviceHub.threads().deleteThread(thread.id, true)
          else await serviceHub.threads().deleteThread(thread.id)
          if (permanent) threadsState.deleteThread(thread.id, true)
          else threadsState.deleteThread(thread.id)
          removed.push(thread.id)
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
    const syncProjects = async () => {
      try {
        const projectsService = getServiceHub().projects()
        const projects = await projectsService.getProjects()
        useThreadManagementStore.setState({ folders: projects })
      } catch (error) {
        console.error('Error syncing projects:', error)
      }
    }
    syncProjects()
  }, [])

  return store
}
