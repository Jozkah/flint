/**
 * Standing rules for chats (janhq/jan#8430): short instructions the user
 * wants in every chat, or in the chats of chosen groups, and that one chat
 * can switch off. They go after the assistant's own instructions in their
 * own delimited block, so an assistant keeps its persona and the rules add
 * to it.
 */
export type ChatRule = {
  id: string
  text: string
  enabled: boolean
  /** 'all' = every chat; 'groups' = only chats in `groupIds`. */
  scope: 'all' | 'groups'
  groupIds: string[]
}

/** Rough budget past which the settings page warns (about 1000 tokens). */
export const CHAT_RULES_TOKEN_BUDGET = 1000

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Rules that apply to a chat, in the order the user listed them. */
export function activeChatRules(
  rules: ChatRule[],
  chat: { groupId?: string; disabledIds?: string[] }
): ChatRule[] {
  const off = new Set(chat.disabledIds ?? [])
  return rules.filter(
    (r) =>
      r.enabled &&
      r.text.trim() !== '' &&
      !off.has(r.id) &&
      (r.scope === 'all' ||
        (!!chat.groupId && r.groupIds.includes(chat.groupId)))
  )
}

/** The delimited block, or '' when no rule applies. */
export function buildChatRulesBlock(rules: ChatRule[]): string {
  if (rules.length === 0) return ''
  const lines = rules.map(
    (r) => `- ${r.text.trim().replace(/<(\/?)chat_rules/gi, '<​$1chat_rules')}`
  )
  return [
    '<chat_rules>',
    'Standing rules the user set for their chats. Follow them unless the user says otherwise in this chat:',
    ...lines,
    '</chat_rules>',
  ].join('\n')
}

/** Assistant instructions first, then the rules block. */
export function composeSystemMessage(
  assistantInstructions: string | undefined,
  rulesBlock: string
): string | undefined {
  const parts = [assistantInstructions?.trim(), rulesBlock].filter(
    (p): p is string => !!p
  )
  return parts.length ? parts.join('\n\n') : undefined
}
