import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Card } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useChatRules } from '@/hooks/useChatRules'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import {
  CHAT_RULES_TOKEN_BUDGET,
  buildChatRulesBlock,
  estimateTokens,
} from '@/lib/chatRules'

/**
 * Settings > Chat: standing rules added to every chat (or the chats of
 * chosen groups) after the assistant's instructions.
 */
export function ChatRulesCard() {
  const { t } = useTranslation()
  const rules = useChatRules((s) => s.rules)
  const addRule = useChatRules((s) => s.addRule)
  const updateRule = useChatRules((s) => s.updateRule)
  const removeRule = useChatRules((s) => s.removeRule)
  const groups = useThreadManagement((s) => s.folders)
  const [draft, setDraft] = useState('')

  const tokens = estimateTokens(
    buildChatRulesBlock(rules.filter((r) => r.enabled && r.text.trim()))
  )
  const add = () => {
    const text = draft.trim()
    if (!text) return
    addRule(text)
    setDraft('')
  }

  return (
    <Card
      anchor="settings-chat-rules"
      data-testid="chat-rules-card"
      title={t('settings:chat.rulesGroup')}
      description={t('settings:chat.rulesDesc')}
    >
      <div className="flex flex-col gap-2 px-4 py-3">
        {rules.map((rule) => (
          <div
            key={rule.id}
            data-testid="chat-rule-row"
            className="flex flex-col gap-1.5 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <Switch
                checked={rule.enabled}
                onCheckedChange={(enabled) => updateRule(rule.id, { enabled })}
                aria-label={t('settings:chat.rulesEnabled')}
              />
              <Input
                value={rule.text}
                onChange={(e) => updateRule(rule.id, { text: e.target.value })}
                className="h-8 flex-1 text-sm"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => removeRule(rule.id)}
                aria-label={t('settings:chat.rulesRemove')}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <label className="flex items-center gap-1.5">
                <Checkbox
                  checked={rule.scope === 'all'}
                  onChange={(e) =>
                    updateRule(rule.id, {
                      scope: e.target.checked ? 'all' : 'groups',
                    })
                  }
                />
                {t('settings:chat.rulesAllChats')}
              </label>
              {rule.scope === 'groups' &&
                (groups.length === 0 ? (
                  <span>{t('settings:chat.rulesNoGroups')}</span>
                ) : (
                  groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-1.5">
                      <Checkbox
                        checked={rule.groupIds.includes(g.id)}
                        onChange={(e) =>
                          updateRule(rule.id, {
                            groupIds: e.target.checked
                              ? [...rule.groupIds, g.id]
                              : rule.groupIds.filter((x) => x !== g.id),
                          })
                        }
                      />
                      {g.name}
                    </label>
                  ))
                ))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
            placeholder={t('settings:chat.rulesPlaceholder')}
            className="h-8 flex-1 text-sm"
          />
          <Button size="sm" onClick={add} disabled={!draft.trim()}>
            {t('settings:chat.rulesAdd')}
          </Button>
        </div>
        {tokens > CHAT_RULES_TOKEN_BUDGET && (
          <p role="alert" className="text-xs text-destructive">
            {t('settings:chat.rulesTooLong', {
              tokens,
              budget: CHAT_RULES_TOKEN_BUDGET,
            })}
          </p>
        )}
      </div>
    </Card>
  )
}
