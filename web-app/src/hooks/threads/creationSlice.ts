// The threads store's hydration of summarised threads, and thread creation.

import { cleanTitle, isBlankTitle } from '@/lib/invisibleText'
import type { StoreApi } from 'zustand'
import { i18n } from '@/i18n/react-i18next-compat'
import { ulid } from 'ulidx'
import { getServiceHub } from '@/hooks/useServiceHub'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { invokeCommand } from '@/lib/backend'
import { type ThreadState, isSummaryAssistant } from './types'

// One fetch per thread at a time.
const hydrating = new Map<string, Promise<Thread | undefined>>()

/** Loading a summarised thread in full, and creating threads. */
export const threadCreationSlice = (
  set: StoreApi<ThreadState>['setState'],
  get: StoreApi<ThreadState>['getState']
): Pick<
  ThreadState,
  | 'ensureThreadHydrated'
  | 'createThread'
> => ({
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
        (title === undefined || isBlankTitle(title) ? undefined : cleanTitle(title).trim()) ??
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
})
