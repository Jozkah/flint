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
  deleteFolderWithThreads: (id: string) => Promise<void>
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

  deleteFolderWithThreads: async (id) => {
    const threadsState = useThreads.getState()
    const home = useConversationGroups.getState().state.surfaces.home
    const projectThreads = Object.values(threadsState.threads).filter(
      (thread) => home.memberships[thread.id]?.groupId === id || thread.metadata?.project?.id === id
    )

    // Delete threads from backend first
    const serviceHub = getServiceHub()
    for (const thread of projectThreads) {
      await serviceHub.threads().deleteThread(thread.id)
    }
    for (const thread of projectThreads) {
      threadsState.deleteThread(thread.id)
    }
    await get().deleteFolder(id)
  },

  getFolderById: (id) => {
    return get().folders.find((folder) => folder.id === id)
  },

  getProjectById: async (id) => {
    const projectsService = getServiceHub().projects()
    return await projectsService.getProjectById(id)
  },
}))

export const useThreadManagement = () => {
  const store = useThreadManagementStore()

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
