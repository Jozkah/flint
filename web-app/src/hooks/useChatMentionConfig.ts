import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

type ChatMentionConfigState = {
  /**
   * Let `chat_read` open any local conversation by id. Off by default: a
   * mention in the prompt is the only grant (docs/CHAT_MENTIONS.md).
   */
  readAnyConversation: boolean
  setReadAnyConversation: (value: boolean) => void
}

export const useChatMentionConfig = create<ChatMentionConfigState>()(
  persist(
    (set) => ({
      readAnyConversation: false,
      setReadAnyConversation: (readAnyConversation) =>
        set({ readAnyConversation }),
    }),
    {
      name: localStorageKey.settingChatMentions,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
