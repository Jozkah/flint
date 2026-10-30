import { forgetDeadTools } from '@/lib/deadTools'
import { clearChatImages } from '@/lib/chatImages'
import type { StoreApi } from 'zustand'
import { create } from 'zustand'
import { toast } from 'sonner'
import { i18n } from '@/i18n/react-i18next-compat'
import { ulid } from 'ulidx'
import { getServiceHub } from '@/hooks/useServiceHub'
import { Fzf } from 'fzf'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useThreadToolGrants } from '@/hooks/useThreadToolGrants'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { useChatSessions } from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useToolApproval } from '@/hooks/useToolApproval'
import { cleanupThreadWorkspace } from '@/lib/agentTools'
import { archiveEnabled, trackArchiveWork } from '@/lib/archive'
import {
  cancelPendingMessageWrites,
  flushPendingMessageWrites,
} from '@/lib/messageWriteQueue'
import { invokeCommand } from '@/lib/backend'

/**
 * True for an assistant the sidebar list cut to {id, name, model}
 * (`list_thread_summaries`): its instructions and parameters are not loaded.
 */
export const isSummaryAssistant = (assistant: unknown): boolean =>
  Boolean((assistant as { summary?: unknown } | undefined)?.summary === true)

// One fetch per thread at a time.
const hydrating = new Map<string, Promise<Thread | undefined>>()

type ThreadState = {
  threads: Record<string, Thread>
  isLoadingThreads: boolean
  setThreadsLoading: (loading: boolean) => void
  currentThreadId?: string
  getCurrentThread: () => Thread | undefined
  setThreads: (threads: Thread[]) => void
  getFavoriteThreads: () => Thread[]
  getThreadById: (threadId: string) => Thread | undefined
  toggleFavorite: (threadId: string) => void
  /** Moves the thread to the archive; `permanent` destroys it instead. */
  deleteThread: (threadId: string, permanent?: boolean) => void
  /**
   * `deleteThread`, resolving when the backend finished (and rejecting if it
   * failed). The row leaves the list at once either way.
   */
  deleteThreadAsync: (threadId: string, permanent?: boolean) => Promise<void>
  renameThread: (threadId: string, newTitle: string) => void
  deleteAllThreads: () => void
  clearAllThreads: () => void
  unstarAllThreads: () => void
  setCurrentThreadId: (threadId?: string) => void
  createThread: (
    model: ThreadModel,
    title?: string,
    assistant?: Assistant,
    projectMetadata?: { id: string; name: string; updated_at: number },
    isTemporary?: boolean
  ) => Promise<Thread>
  updateCurrentThreadModel: (model: ThreadModel) => void
  /**
   * Record a model on a named thread. `updateCurrentThreadModel` is this for
   * the current thread; a split conversation pane names its own, since the
   * current thread is whichever pane is active.
   */
  updateThreadModel: (threadId: string, model: ThreadModel) => void
  getFilteredThreads: (searchTerm: string) => Thread[]
  updateCurrentThreadAssistant: (assistant: Assistant) => void
  updateThreadTimestamp: (threadId: string) => void
  updateThread: (threadId: string, updates: Partial<Thread>) => void
  deleteAllThreadsByProject: (projectId: string) => void
  /**
   * Load the full assistant of a thread listed as a summary, replacing the
   * cut one in the store. Resolves to the thread (unchanged when it was
   * already full, or when the fetch failed). Await it before reading the
   * assistant's instructions or parameters outside React.
   */
  ensureThreadHydrated: (threadId: string) => Promise<Thread | undefined>
  searchIndex: Fzf<Thread[]> | null
}

// Drops every per-thread entry the sibling stores keep for a deleted thread,
// so none of them outlives it (a tool grant for a gone thread would otherwise
// sit in the persisted record forever).
const forgetThreadState = (threadId: string) => {
  // A message update still waiting to be written must not recreate the file.
  cancelPendingMessageWrites(threadId)
  useAgentMode.getState().removeThread(threadId)
  useChatSessions.getState().removeSession(threadId)
  useAppState.getState().clearThreadState(threadId)
  // The chat's model-setting overrides are keyed by thread id; left
  // behind they would sit in the record forever.
  useModelOverrides.getState().dropThread(threadId)
  useThreadToolGrants.getState().dropThread(threadId)
  useToolApproval.getState().revokeThread(threadId)
  forgetDeadTools(threadId)
}

// The selected thread id, or undefined when that thread was just deleted.
const stillSelected = (
  currentThreadId: string | undefined,
  deletedIds: string[]
): string | undefined =>
  currentThreadId && deletedIds.includes(currentThreadId)
    ? undefined
    : currentThreadId

// Helper function to clean up vector DB collection for a thread
const cleanupVectorDB = async (threadId: string) => {
  try {
    const vec = ExtensionManager.getInstance().get<VectorDBExtension>(
      ExtensionTypeEnum.VectorDB
    )
    if (vec?.deleteCollection) {
      // The extension adds the `attachments_` prefix itself.
      await vec.deleteCollection(threadId)
    }
  } catch (e) {
    console.warn(
      `[Threads] Failed to delete vector DB collection for thread ${threadId}:`,
      e
    )
  }
}

/**
 * Drops the thread's saved prompt cache in the local engine.
 *
 * Best-effort and fire-and-forget, like the vector DB cleanup above: the cache
 * is bounded by its own disk budget, so failing to reclaim one thread's share
 * is not worth failing the delete over.
 */
const cleanupThreadCache = async (threadId: string) => {
  try {
    const { EngineManager } = await import('@janhq/core')
    const engine = EngineManager.instance().get('llamacpp') as
      | { forgetThreadCache?: (id: string) => Promise<number> }
      | undefined
    await engine?.forgetThreadCache?.(threadId)
  } catch (e) {
    console.warn(
      `[Threads] Failed to drop the saved prompt cache for thread ${threadId}:`,
      e
    )
  }
}

// Everything belonging to a thread that lives outside the thread store: its
// vector DB collection, its saved prompt cache, and its ephemeral agent
// sandbox. Fire-and-forget, since every caller runs inside a `set` reducer;
// each logs its own failures. An archived thread can be restored, so its
// attachments index and sandbox are kept unless the delete is permanent or
// the archive is off.
const cleanupThreadArtifacts = (threadId: string, permanent?: boolean) => {
  void (async () => {
    if (!permanent && (await archiveEnabled())) return
    cleanupVectorDB(threadId)
    cleanupThreadWorkspace(threadId)
    // The chat's picture names (img_1 -> gallery id); the pictures stay in
    // the gallery.
    clearChatImages(threadId)
  })()
  cleanupThreadCache(threadId)
  // "Allow all temporarily" lasts only as long as its conversation.
  useToolApprovalRequests.getState().forgetTemporaryGit(threadId)
}

// The backend delete. It moves the thread to the archive (or destroys it when
// the archive is off or `permanent` is set), and removes the request records
// and scratch dir only when the thread is finally purged. Fire-and-forget from
// inside a reducer, so a failure is logged rather than thrown.
const deleteThreadBackend = (
  threadId: string,
  permanent?: boolean
): Promise<void> => {
  const threads = getServiceHub().threads()
  const done = permanent
    ? threads.deleteThread(threadId, true)
    : threads.deleteThread(threadId)
  const tracked = trackArchiveWork(Promise.resolve(done))
  tracked.catch((e) =>
    console.warn(`[Threads] Failed to delete thread ${threadId}:`, e)
  )
  // The caller that wants the outcome (bulk delete) awaits this; the rest
  // ignore it, and the log above already covers them.
  return tracked
}

/** Deleting and unstarring threads (Q2-054: the store in slices). */
const threadDeletion = (
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
          persistThread(thread, state.threads[thread.id])
        }
      })
      return { threads: updatedThreads }
    })
  },
})

export const useThreads = create<ThreadState>()((set, get) => ({
  threads: {},
  isLoadingThreads: true,
  setThreadsLoading: (loading) => set({ isLoadingThreads: loading }),
  searchIndex: null,
  setThreads: (threads) => {
    const threadMap = threads.reduce(
      (acc: Record<string, Thread>, thread) => {
        // A reload of the summaries must not undo a hydration already done.
        const known = get().threads[thread.id]?.assistants?.[0]
        const listed = thread.assistants?.[0]
        const assistants =
          listed &&
          known &&
          isSummaryAssistant(listed) &&
          !isSummaryAssistant(known) &&
          known.id === listed.id
            ? [
                { ...known, name: listed.name, model: listed.model },
                ...thread.assistants!.slice(1),
              ]
            : thread.assistants
        acc[thread.id] = {
          ...thread,
          assistants,
          model: thread.model
            ? {
                provider:
                  thread.model?.provider?.replace('llama.cpp', 'llamacpp') ??
                  'llamacpp',
                // Cortex migration: take first two parts of the ID (the last is file name which is not needed)
                id:
                  thread.model?.provider === 'llama.cpp' ||
                  thread.model?.provider === 'llamacpp'
                    ? thread.model?.id
                        ?.split(':')
                        .slice(0, 2)
                        .join(getServiceHub().path().sep())
                    : thread.model?.id,
              }
            : undefined,
        }
        return acc
      },
      {} as Record<string, Thread>
    )
    // The search index is built lazily by the next search.
    set({ threads: threadMap, searchIndex: null })
  },
  getFilteredThreads: (searchTerm: string) => {
    const { threads, searchIndex } = get()

    // Filter out temporary chat from all operations
    const filteredThreadsValues = Object.values(threads).filter(
      (t) => t.id !== TEMPORARY_CHAT_ID
    )

    // If no search term, return all threads
    if (!searchTerm) {
      // return all threads
      return filteredThreadsValues
    }

    let currentIndex = searchIndex
    if (!currentIndex?.find) {
      currentIndex = new Fzf<Thread[]>(filteredThreadsValues.filter(t => t.title), {
        selector: (item: Thread) => item.title ?? '',
      })
      set({ searchIndex: currentIndex })
    }

    // Use the index to search and return matching threads
    const fzfResults = currentIndex.find(searchTerm)
    return fzfResults.map(
      (result: { item: Thread; positions: Set<number> }) => {
        // The index only matches titles; read the live thread so a model or
        // assistant change made since the index was built shows up.
        const thread = threads[result.item.id] ?? result.item

        return {
          ...thread,
          title: thread.title, // Override title with highlighted version
        }
      }
    )
  },
  toggleFavorite: (threadId) => {
    set((state) => {
      const thread = state.threads[threadId]
      // The thread may have been deleted between the click and now.
      if (!thread) return state
      const next = {
        ...thread,
        isFavorite: !thread.isFavorite,
        updated: Date.now() / 1000,
      }
      persistThread(next, thread)
      const newThreads = { ...state.threads, [threadId]: next }
      // The search index holds thread objects; without a rebuild a search
      // result keeps the old favourite flag and timestamp.
      return {
        threads: newThreads,
        searchIndex: null,
      }
    })
  },
  ...threadDeletion(set, get),

  getFavoriteThreads: () => {
    return Object.values(get().threads).filter((thread) => thread.isFavorite)
  },
  getThreadById: (threadId: string) => {
    return get().threads[threadId]
  },
  setCurrentThreadId: (threadId) => {
    if (threadId) void get().ensureThreadHydrated(threadId)
    const previous = get().currentThreadId
    if (threadId === previous) return
    // The thread being left gets its pending message writes now.
    if (previous) void flushPendingMessageWrites(previous)
    set({ currentThreadId: threadId })
  },
  ensureThreadHydrated: (threadId) => {
    const thread = get().threads[threadId]
    if (!thread || !isSummaryAssistant(thread.assistants?.[0])) {
      return Promise.resolve(thread)
    }
    const pending = hydrating.get(threadId)
    if (pending) return pending
    const run = invokeCommand<Assistant>('get_thread_assistant', { threadId })
      .then((full) => {
        const current = get().threads[threadId]
        const slim = current?.assistants?.[0]
        if (
          !current ||
          !slim ||
          !isSummaryAssistant(slim) ||
          !full ||
          full.id !== slim.id
        ) {
          return current
        }
        const hydrated: Thread = {
          ...current,
          assistants: [
            { ...full, name: slim.name, model: slim.model } as Assistant,
            ...current.assistants!.slice(1),
          ],
        }
        set((state) => ({
          threads: { ...state.threads, [threadId]: hydrated },
        }))
        return hydrated
      })
      .catch((error) => {
        console.warn('Could not load the thread assistant:', error)
        return get().threads[threadId]
      })
      .finally(() => hydrating.delete(threadId))
    hydrating.set(threadId, run)
    return run
  },
  createThread: async (
    model,
    title,
    assistant,
    projectMetadata,
    isTemporary
  ) => {
    const newThread: Thread = {
      id: isTemporary ? TEMPORARY_CHAT_ID : ulid(),
      title:
        title ??
        i18n.t(isTemporary ? 'common:temporaryChat' : 'common:newThread'),
      model,
      updated: Date.now() / 1000,
      assistants: assistant ? [assistant] : [],
      ...(projectMetadata &&
        !isTemporary && {
          metadata: {
            project: projectMetadata,
          },
        }),
      ...(isTemporary && {
        metadata: {
          isTemporary: true,
          ...(projectMetadata && { project: projectMetadata }),
        },
      }),
    }
    return await getServiceHub()
      .threads()
      .createThread(newThread)
      .then((createdThread) => {
        set((state) => {
          // Get all existing threads as an array
          const existingThreads = Object.values(state.threads)

          // Create new array with the new thread at the beginning
          const reorderedThreads = [createdThread, ...existingThreads]

          // Use setThreads to handle proper ordering (this will assign order 1, 2, 3...)
          get().setThreads(reorderedThreads)

          return {
            currentThreadId: createdThread.id,
          }
        })
        return createdThread
      })
  },
  updateCurrentThreadAssistant: (assistant) => {
    set((state) => {
      if (!state.currentThreadId) return { ...state }
      const currentThread = state.getCurrentThread()
      if (!currentThread) return state
      // A pick by the user means the assistant is no longer Jev's to change.
      const rest = { ...(currentThread?.metadata ?? {}) }
      delete rest.jevRoutedAssistantId
      // One object, persisted and stored, so a failed write can tell whether
      // the thread is still the one it wrote.
      const updatedThread = {
        ...state.threads[state.currentThreadId as string],
        assistants: assistant
          ? [{ ...assistant, model: currentThread?.model }]
          : [],
        metadata: rest,
        updated: Date.now() / 1000,
      } as Thread
      if (currentThread) persistThread(updatedThread, currentThread)
      return {
        threads: {
          ...state.threads,
          [state.currentThreadId as string]: updatedThread,
        },
      }
    })
  },
  updateCurrentThreadModel: (model) => {
    const currentThreadId = get().currentThreadId
    if (!currentThreadId) return
    get().updateThreadModel(currentThreadId, model)
  },
  updateThreadModel: (threadId, model) => {
    // An unknown id must not create a ghost thread or touch the overrides.
    if (!get().threads[threadId]) return
    // The new model may not define every setting this chat had overridden.
    // Such an override is already inert — `resolveModel` ignores a key the
    // model does not have — but leaving it in the record would let it come
    // back to life if the old model were ever selected again. Look the model
    // up under its own provider: the selected one may differ (split panes).
    useModelOverrides
      .getState()
      .pruneForThread(
        threadId,
        model.provider,
        useModelProvider.getState().getModelBy(model.id, model.provider)
      )
    set((state) => {
      const thread = state.threads[threadId]
      if (!thread) return state
      const updatedThread = { ...thread, model } as Thread
      persistThread(updatedThread, thread)
      return {
        threads: {
          ...state.threads,
          [threadId]: updatedThread,
        },
      }
    })
  },
  renameThread: (threadId, newTitle) => {
    set((state) => {
      const thread = state.threads[threadId]
      if (!thread) return state
      const updatedThread = {
        ...thread,
        title: newTitle,
        updated: Date.now() / 1000,
        metadata: { ...thread.metadata, titleSetManually: true },
      }
      persistThread(updatedThread, thread)
      const newThreads = { ...state.threads, [threadId]: updatedThread }
      return {
        threads: newThreads,
        searchIndex: null,
      }
    })
  },
  getCurrentThread: () => {
    const { currentThreadId, threads } = get()
    return currentThreadId ? threads[currentThreadId] : undefined
  },
  updateThreadTimestamp: (threadId) => {
    set((state) => {
      const thread = state.threads[threadId]
      if (!thread) return state

      // Update the thread with new timestamp and set it to order 1 (top)
      const updatedThread = {
        ...thread,
        updated: Date.now() / 1000,
      }

      // Update all other threads to increment their order by 1
      const updatedThreads = { ...state.threads }
      updatedThreads[threadId] = updatedThread

      // Update the backend for the main thread
      persistThread(updatedThread, thread)

      return {
        threads: updatedThreads,
        searchIndex: null,
      }
    })
  },
  updateThread: (threadId, updates) => {
    set((state) => {
      const thread = state.threads[threadId]
      if (!thread) return state

      const updatedThread = {
        ...thread,
        ...updates,
        updated: Date.now() / 1000,
      }

      persistThread(updatedThread, thread)

      const newThreads = { ...state.threads, [threadId]: updatedThread }
      return {
        threads: newThreads,
        searchIndex: null,
      }
    })
  },
}))

/**
 * Persist a thread write without an unhandled rejection. On failure the
 * optimistic state is rolled back to `prev`, but only while the store still
 * holds `next`: a newer edit (or a delete) made since must not be undone.
 * The caller therefore has to store the very object it persists. The user is
 * told either way.
 */
function persistThread(next: Thread, prev?: Thread) {
  Promise.resolve()
    .then(() => getServiceHub().threads().updateThread(next))
    .catch((error) => {
      console.error('Failed to persist thread update:', error)
      toast.error(i18n.t('common:threadSaveFailed'))
      if (!prev) return
      useThreads.setState((state) =>
        state.threads[prev.id] === next
          ? { threads: { ...state.threads, [prev.id]: prev } }
          : state
      )
    })
}
