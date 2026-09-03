import { IconClock } from '@tabler/icons-react'
import { useNavigate } from '@tanstack/react-router'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { route } from '@/constants/routes'
import { defaultModel } from '@/lib/models'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * Start a temporary chat, using whatever model is currently selected.
 *
 * The thread is created in memory only — the services short-circuit every
 * write for `TEMPORARY_CHAT_ID`, so nothing here touches disk — and the rest of
 * its lifecycle (the banner, keeping, discarding) takes over from the thread
 * view. This is the one deliberate way in; there is no accidental one.
 */
export function NewTemporaryChatButton() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const start = () => {
    const { selectedModel, selectedProvider } = useModelProvider.getState()
    useThreads.getState().createThread(
      {
        id: selectedModel?.id ?? defaultModel(selectedProvider),
        provider: selectedProvider,
      },
      undefined,
      undefined,
      undefined,
      true
    )
    navigate({ to: route.threadsDetail, params: { threadId: TEMPORARY_CHAT_ID } })
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={start}
          aria-label={t('common:temporaryChat')}
        >
          <IconClock size={18} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('common:temporaryChatTooltip')}</TooltipContent>
    </Tooltip>
  )
}
