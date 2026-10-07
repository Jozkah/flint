import { browserApi, jsonRequest } from '@/services/browserApi'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import type { ThreadsService } from './types'

const threadUrl = (id: string) => `/api/v1/threads/${encodeURIComponent(id)}`

function persistedThread(thread: Thread): object {
  const model = { id: thread.model?.id ?? '*', engine: thread.model?.provider ?? 'llamacpp' }
  return {
    ...thread,
    assistants: thread.assistants?.length
      ? thread.assistants.map((assistant) => ({ ...assistant, model }))
      : [{ id: 'model-only', name: 'Model', model }],
    metadata: {
      ...thread.metadata,
      order: thread.order,
      is_favorite: thread.isFavorite,
    },
  }
}

export class BrowserThreadsService implements ThreadsService {
  async fetchThreads(): Promise<Thread[]> {
    const threads = await browserApi<Thread[]>('/api/v1/threads')
    return threads.filter((thread) => thread.id !== TEMPORARY_CHAT_ID).map((thread) => ({
      ...thread,
      updated: typeof thread.updated === 'number' && thread.updated > 1e12
        ? Math.floor(thread.updated / 1000) : thread.updated,
      order: typeof thread.metadata?.order === 'number' ? thread.metadata.order : thread.order,
      isFavorite: typeof thread.metadata?.is_favorite === 'boolean'
        ? thread.metadata.is_favorite : thread.isFavorite,
      model: thread.assistants?.[0]?.model
        ? { id: thread.assistants[0].model.id, provider: thread.assistants[0].model.engine ?? 'llamacpp' }
        : thread.model,
    }))
  }

  async createThread(thread: Thread): Promise<Thread> {
    if (thread.id === TEMPORARY_CHAT_ID) return thread
    return browserApi<Thread>('/api/v1/threads', jsonRequest('POST', persistedThread(thread)))
  }

  async updateThread(thread: Thread): Promise<void> {
    if (thread.id === TEMPORARY_CHAT_ID) return
    await browserApi<void>(threadUrl(thread.id), jsonRequest('PUT', persistedThread(thread)))
  }

  async deleteThread(threadId: string, permanent = false): Promise<void> {
    if (threadId === TEMPORARY_CHAT_ID) return
    await browserApi<void>(`${threadUrl(threadId)}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' })
  }
}
