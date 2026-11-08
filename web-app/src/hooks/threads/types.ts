// The threads store's shape, apart from the store so its slices can share it.

import { Fzf } from 'fzf'

/**
 * True for an assistant the sidebar list cut to {id, name, model}
 * (`list_thread_summaries`): its instructions and parameters are not loaded.
 */
export const isSummaryAssistant = (assistant: unknown): boolean =>
  Boolean((assistant as { summary?: unknown } | undefined)?.summary === true)

export type ThreadState = {
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
  /** Patch several threads in one store write; ids that no longer exist are skipped. */
  updateThreads: (updates: Record<string, Partial<Thread>>) => void
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
