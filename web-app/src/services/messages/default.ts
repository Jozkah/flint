/**
 * Default Messages Service - Web implementation
 */

import { ExtensionManager } from '@/lib/extension'
import {
  ConversationalExtension,
  ExtensionTypeEnum,
  ThreadMessage,
} from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import type { MessagesService } from './types'

export class DefaultMessagesService implements MessagesService {
  async fetchMessages(threadId: string): Promise<ThreadMessage[]> {
    // Don't fetch messages from server for temporary chat - it's local only
    if (threadId === TEMPORARY_CHAT_ID) {
      return []
    }

    // Let a backend failure reject so callers can tell "no messages" from
    // "could not load" instead of showing an empty thread.
    const res = await ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
      ?.listMessages(threadId)
    return res ?? []
  }

  async createMessage(message: ThreadMessage): Promise<ThreadMessage> {
    // Don't create messages on server for temporary chat - it's local only
    if (message.thread_id === TEMPORARY_CHAT_ID) {
      return message
    }

    // A failed write must reject so the caller can surface it; a null echo
    // (serve/web fallback) falls back to the input message.
    const res = await ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
      ?.createMessage(message)
    return res ?? message
  }

  async modifyMessage(message: ThreadMessage): Promise<ThreadMessage> {
    // Don't modify messages on server for temporary chat - it's local only
    if (message.thread_id === TEMPORARY_CHAT_ID) {
      return message
    }

    const res = await ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
      ?.modifyMessage(message)
    return res ?? message
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    // Don't delete messages on server for temporary chat - it's local only
    if (threadId === TEMPORARY_CHAT_ID) {
      return
    }

    await ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
      ?.deleteMessage(threadId, messageId)
  }
}
