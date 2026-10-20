import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useChatMentionConfig } from '@/hooks/useChatMentionConfig'

/**
 * Whether `chat_read` may open any conversation by id. Off by default: a
 * mention in the prompt is the grant (docs/CHAT_MENTIONS.md).
 */
export function ChatMentionSettings() {
  const { t } = useTranslation()
  const readAny = useChatMentionConfig((s) => s.readAnyConversation)
  const setReadAny = useChatMentionConfig((s) => s.setReadAnyConversation)
  return (
    <Card
      title={t('settings:chatMentions.title')}
      data-testid="chat-mention-settings"
    >
      <CardItem
        anchor="settings-permissions-chat-mentions"
        title={t('settings:chatMentions.readAny')}
        description={t('settings:chatMentions.readAnyDesc')}
        align="start"
        actions={
          <Switch
            data-testid="chat-mention-read-any"
            checked={readAny}
            onCheckedChange={setReadAny}
          />
        }
      />
    </Card>
  )
}
