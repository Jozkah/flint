import { Clock } from 'lucide-react'
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
    <div className="flex h-[30px] min-w-0 items-center gap-2 rounded-lg border-[0.8px] border-warning/30 bg-warning-tint px-2 text-xs text-fg-2">
      <Clock className="size-3.5 shrink-0" aria-hidden />
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
