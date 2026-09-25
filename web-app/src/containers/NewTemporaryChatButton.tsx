import { Clock } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { route } from '@/constants/routes'
import { resolveThreadModelId } from '@/lib/models'
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
    const { selectedModel, selectedProvider, getProviderByName } =
      useModelProvider.getState()
    // A local engine has no cloud catalogue to borrow a model id from, so with
    // nothing selected there is no thread worth opening (janhq/jan#8007).
    const modelId = resolveThreadModelId(
      selectedProvider,
      selectedModel?.id,
      (getProviderByName(selectedProvider)?.models ?? []).map((m) => m.id)
    )
    if (!modelId) return
    useThreads.getState().createThread(
      {
        id: modelId,
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
          className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
          onClick={start}
          aria-label={t('common:temporaryChat')}
        >
          <Clock className="size-4.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('common:temporaryChatTooltip')}</TooltipContent>
    </Tooltip>
  )
}
