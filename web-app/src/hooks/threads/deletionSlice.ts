// The threads store's deleting and unstarring actions.

import type { StoreApi } from 'zustand'
import type { ThreadState } from './types'
import { persistThread } from './persist'
import {
  forgetThreadState,
  stillSelected,
  cleanupThreadArtifacts,
  deleteThreadBackend,
} from './cleanup'

/** Deleting and unstarring threads. */
export const threadDeletion = (
  set: StoreApi<ThreadState>['setState'],
  get: StoreApi<ThreadState>['getState']
): Pick<
  ThreadState,
  'deleteThread'
  | 'deleteThreadAsync'
  | 'deleteAllThreads'
  | 'clearAllThreads'
  | 'deleteAllThreadsByProject'
  | 'unstarAllThreads'
> => ({
  deleteThread: (threadId, permanent) => {
    void get().deleteThreadAsync(threadId, permanent).catch(() => undefined)
  },
  deleteThreadAsync: (threadId, permanent) => {
    let backend: Promise<void> = Promise.resolve()
    set((state) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _, ...remainingThreads } = state.threads

      forgetThreadState(threadId)
      cleanupThreadArtifacts(threadId, permanent)
      backend = deleteThreadBackend(threadId, permanent)

      return {
        threads: remainingThreads,
        searchIndex: null,
      }
    })
    return backend
  },
  deleteAllThreads: () => {
    set((state) => {
      const allThreadIds = Object.keys(state.threads)

      // Identify threads to keep (favorites OR have project metadata)
      const threadsToKeepIds = allThreadIds.filter(
        (threadId) =>
          state.threads[threadId].isFavorite ||
          state.threads[threadId].metadata?.project
      )

      // Identify threads to delete (non-favorites AND no project metadata)
      const threadsToDeleteIds = allThreadIds.filter(
        (threadId) =>
          !state.threads[threadId].isFavorite &&
          !state.threads[threadId].metadata?.project
      )

      // Delete threads and clean up their out-of-store artifacts
      threadsToDeleteIds.forEach((threadId) => {
        forgetThreadState(threadId)
        cleanupThreadArtifacts(threadId)
        deleteThreadBackend(threadId)
      })

      // Keep favorite threads and threads with project metadata
      const remainingThreads = threadsToKeepIds.reduce(
        (acc, threadId) => {
          acc[threadId] = state.threads[threadId]
          return acc
        },
        {} as Record<string, Thread>
      )

      return {
        threads: remainingThreads,
        currentThreadId: stillSelected(state.currentThreadId, threadsToDeleteIds),
        searchIndex: null,
      }
    })
  },
  clearAllThreads: () => {
    set((state) => {
      const allThreadIds = Object.keys(state.threads)

      allThreadIds.forEach((threadId) => {
        forgetThreadState(threadId)
        cleanupThreadArtifacts(threadId)
        deleteThreadBackend(threadId)
      })

      return {
        threads: {},
        currentThreadId: undefined,
        searchIndex: null,
      }
    })
  },
  deleteAllThreadsByProject: (projectId) => {
    set((state) => {
      const allThreadIds = Object.keys(state.threads)

      // Identify threads belonging to this project
      const threadsToDeleteIds = allThreadIds.filter(
        (threadId) =>
          state.threads[threadId].metadata?.project?.id === projectId
      )

      threadsToDeleteIds.forEach((threadId) => {
        forgetThreadState(threadId)
        cleanupThreadArtifacts(threadId)
        deleteThreadBackend(threadId)
      })

      // Keep threads that don't belong to this project
      const remainingThreads = allThreadIds
        .filter((threadId) => !threadsToDeleteIds.includes(threadId))
        .reduce(
          (acc, threadId) => {
            acc[threadId] = state.threads[threadId]
            return acc
          },
          {} as Record<string, Thread>
        )

      return {
        threads: remainingThreads,
        currentThreadId: stillSelected(state.currentThreadId, threadsToDeleteIds),
        searchIndex: null,
      }
    })
  },
  unstarAllThreads: () => {
    set((state) => {
      const updatedThreads = Object.keys(state.threads).reduce(
        (acc, threadId) => {
          acc[threadId] = {
            ...state.threads[threadId],
            isFavorite: false,
          }
          return acc
        },
        {} as Record<string, Thread>
      )
      // Only threads that were starred change; rewriting every thread file
      // for an unstar is wasted IO.
      Object.values(updatedThreads).forEach((thread) => {
        if (state.threads[thread.id]?.isFavorite) {
          persistThread(set, thread, state.threads[thread.id])
        }
      })
      // The search index holds thread copies; rebuild it from the new ones (HKS-012).
      return { threads: updatedThreads, searchIndex: null }
    })
  },
})
