// The threads store's list: loading, searching, starring and selecting.

import type { StoreApi } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import { Fzf } from 'fzf'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { flushPendingMessageWrites } from '@/lib/messageWriteQueue'
import { type ThreadState, isSummaryAssistant } from './types'
import { persistThread } from './persist'

/** Loading, searching, starring and selecting threads. */
export const threadListSlice = (
  set: StoreApi<ThreadState>['setState'],
  get: StoreApi<ThreadState>['getState']
): Pick<
  ThreadState,
  | 'setThreads'
  | 'getFilteredThreads'
  | 'toggleFavorite'
  | 'getFavoriteThreads'
  | 'getThreadById'
  | 'setCurrentThreadId'
  | 'getCurrentThread'
> => ({
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
      persistThread(set, next, thread)
      const newThreads = { ...state.threads, [threadId]: next }
      // The search index holds thread objects; without a rebuild a search
      // result keeps the old favourite flag and timestamp.
      return {
        threads: newThreads,
        searchIndex: null,
      }
    })
  },
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
  getCurrentThread: () => {
    const { currentThreadId, threads } = get()
    return currentThreadId ? threads[currentThreadId] : undefined
  },
})
