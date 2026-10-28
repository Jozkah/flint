import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  activeChatRules,
  buildChatRulesBlock,
  type ChatRule,
} from '@/lib/chatRules'

type ChatRulesState = {
  rules: ChatRule[]
  /** Per chat: ids of rules switched off for that chat only. */
  disabledByThread: Record<string, string[]>
  addRule: (text: string) => void
  updateRule: (id: string, patch: Partial<Omit<ChatRule, 'id'>>) => void
  removeRule: (id: string) => void
  setRuleOffForThread: (threadId: string, ruleId: string, off: boolean) => void
}

export const useChatRules = create<ChatRulesState>()(
  persist(
    (set) => ({
      rules: [],
      disabledByThread: {},
      addRule: (text) =>
        set((s) => ({
          rules: [
            ...s.rules,
            {
              id: crypto.randomUUID(),
              text,
              enabled: true,
              scope: 'all',
              groupIds: [],
            },
          ],
        })),
      updateRule: (id, patch) =>
        set((s) => ({
          rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        })),
      removeRule: (id) =>
        set((s) => ({
          rules: s.rules.filter((r) => r.id !== id),
          disabledByThread: Object.fromEntries(
            Object.entries(s.disabledByThread).map(([k, v]) => [
              k,
              v.filter((x) => x !== id),
            ])
          ),
        })),
      setRuleOffForThread: (threadId, ruleId, off) =>
        set((s) => {
          const cur = new Set(s.disabledByThread[threadId] ?? [])
          if (off) cur.add(ruleId)
          else cur.delete(ruleId)
          return {
            disabledByThread: { ...s.disabledByThread, [threadId]: [...cur] },
          }
        }),
    }),
    {
      name: localStorageKey.settingChatRules,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)

/** The rules block for one chat ('' when none applies). */
export function useChatRulesBlock(threadId?: string, groupId?: string): string {
  const rules = useChatRules((s) => s.rules)
  const disabled = useChatRules((s) =>
    threadId ? s.disabledByThread[threadId] : undefined
  )
  return buildChatRulesBlock(
    activeChatRules(rules, { groupId, disabledIds: disabled })
  )
}
