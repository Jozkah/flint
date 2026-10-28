import { ScrollText } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useChatRules } from '@/hooks/useChatRules'
import { activeChatRules } from '@/lib/chatRules'

/**
 * In a chat's options panel: one switch per standing rule that would apply
 * to this chat, to turn it off here without touching other chats.
 */
export function ChatRulesToggleRows({
  threadId,
  groupId,
}: {
  threadId: string
  groupId?: string
}) {
  const { t } = useTranslation()
  const rules = useChatRules((s) => s.rules)
  const disabled = useChatRules((s) => s.disabledByThread[threadId])
  const setOff = useChatRules((s) => s.setRuleOffForThread)
  const applicable = activeChatRules(rules, { groupId })
  if (applicable.length === 0) return null
  const off = new Set(disabled ?? [])
  return (
    <div data-testid="chat-rules-rows" className="border-b px-2 py-1">
      <p className="px-2 pt-1 text-[length:calc(var(--ui-font-base)*11/16)] font-medium text-muted-foreground">
        {t('common:chatRules')}
      </p>
      {applicable.map((rule) => (
        <label
          key={rule.id}
          className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs"
          title={rule.text}
        >
          <ScrollText
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate">{rule.text}</span>
          <Switch
            checked={!off.has(rule.id)}
            onCheckedChange={(on) => setOff(threadId, rule.id, !on)}
            aria-label={t('common:chatRuleForThisChat')}
          />
        </label>
      ))}
    </div>
  )
}
