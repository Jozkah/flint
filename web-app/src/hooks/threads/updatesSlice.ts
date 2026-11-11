// The threads store's updates to one thread or several.

import { cleanTitle, isBlankTitle } from '@/lib/invisibleText'
import type { StoreApi } from 'zustand'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ThreadState } from './types'
import { persistThread } from './persist'

/** Changing a thread: its assistant, model, title, timestamp and fields. */
export const threadUpdatesSlice = (
  set: StoreApi<ThreadState>['setState'],
  get: StoreApi<ThreadState>['getState']
): Pick<
  ThreadState,
  | 'updateCurrentThreadAssistant'
  | 'updateCurrentThreadModel'
  | 'updateThreadModel'
  | 'renameThread'
  | 'updateThreadTimestamp'
  | 'updateThread'
  | 'updateThreads'
> => ({
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
      if (currentThread) persistThread(set, updatedThread, currentThread)
      return {
        threads: {
          ...state.threads,
          [state.currentThreadId as string]: updatedThread,
        },
        // Stale thread copies otherwise stay in search results (HKS-013).
        searchIndex: null,
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
      persistThread(set, updatedThread, thread)
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
      // A name with nothing visible in it keeps the current title.
      if (!thread || isBlankTitle(newTitle)) return state
      const updatedThread = {
        ...thread,
        title: cleanTitle(newTitle),
        updated: Date.now() / 1000,
        metadata: { ...thread.metadata, titleSetManually: true },
      }
      persistThread(set, updatedThread, thread)
      const newThreads = { ...state.threads, [threadId]: updatedThread }
      return {
        threads: newThreads,
        searchIndex: null,
      }
    })
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
      persistThread(set, updatedThread, thread)

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

      persistThread(set, updatedThread, thread)

      const newThreads = { ...state.threads, [threadId]: updatedThread }
      return {
        threads: newThreads,
        searchIndex: null,
      }
    })
  },
  updateThreads: (updates) => {
    set((state) => {
      const newThreads = { ...state.threads }
      let changed = false
      const now = Date.now() / 1000
      for (const [threadId, patch] of Object.entries(updates)) {
        const thread = state.threads[threadId]
        if (!thread) continue
        const updatedThread = { ...thread, ...patch, updated: now }
        persistThread(set, updatedThread, thread)
        newThreads[threadId] = updatedThread
        changed = true
      }
      return changed ? { threads: newThreads, searchIndex: null } : state
    })
  },
})
