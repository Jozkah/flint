import type { ThreadMessage } from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { browserApi, jsonRequest } from '@/services/browserApi'
import type { MessagesService } from './types'

const messagesUrl = (threadId: string) =>
  `/api/v1/threads/${encodeURIComponent(threadId)}/messages`

export class BrowserMessagesService implements MessagesService {
  async fetchMessages(threadId: string): Promise<ThreadMessage[]> {
    if (threadId === TEMPORARY_CHAT_ID) return []
    return browserApi<ThreadMessage[]>(messagesUrl(threadId))
  }

  async createMessage(message: ThreadMessage): Promise<ThreadMessage> {
    if (message.thread_id === TEMPORARY_CHAT_ID) return message
    return browserApi<ThreadMessage>(messagesUrl(message.thread_id), jsonRequest('POST', message))
  }

  async modifyMessage(message: ThreadMessage): Promise<ThreadMessage> {
    if (message.thread_id === TEMPORARY_CHAT_ID) return message
    return browserApi<ThreadMessage>(
      `${messagesUrl(message.thread_id)}/${encodeURIComponent(message.id)}`,
      jsonRequest('PUT', message)
    )
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    if (threadId === TEMPORARY_CHAT_ID) return
    await browserApi<void>(`${messagesUrl(threadId)}/${encodeURIComponent(messageId)}`, { method: 'DELETE' })
  }
}
