import { IconClock } from '@tabler/icons-react'
import { useShallow } from 'zustand/react/shallow'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { isEmptyTemporaryChat } from '@/lib/temporaryChat'
import { useMessages } from '@/hooks/useMessages'
import { useTemporaryChat } from '@/hooks/useTemporaryChat'
import { usePromoteTemporaryChat } from '@/hooks/usePromoteTemporaryChat'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'

/**
 * A quiet, permanent reminder that this chat is not being saved, and the one
 * button that changes that.
 *
 * Shown for the temporary chat and nothing else. The keep button only appears
 * once there is something to keep — an empty temporary chat has nothing to
 * promote, and offering the action would just be a dead end.
 */
export function TemporaryChatBanner({ threadId }: { threadId: string }) {
  const { t } = useTranslation()
  const promote = usePromoteTemporaryChat()
  const busy = useTemporaryChat((state) => state.busy)
  const messages = useMessages(
    useShallow((state) => state.messages?.[TEMPORARY_CHAT_ID] ?? [])
  )

  if (threadId !== TEMPORARY_CHAT_ID) return null

  const hasSomethingToKeep = !isEmptyTemporaryChat(messages)

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <IconClock size={14} className="shrink-0" />
      <span className="truncate">{t('chat:temporaryChatBanner')}</span>
      {hasSomethingToKeep && (
        <Button
          variant="link"
          size="xs"
          disabled={busy}
          onClick={() => promote()}
          className="h-auto px-0 text-xs"
        >
          {t('chat:temporaryChatKeep')}
        </Button>
      )}
    </div>
  )
}
