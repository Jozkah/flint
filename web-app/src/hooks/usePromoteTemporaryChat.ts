import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTemporaryChat } from '@/hooks/useTemporaryChat'
import type { PromotionResult } from '@/lib/temporaryChat'

/**
 * Keep the current temporary chat, in the order the user should experience it:
 * persist and confirm, navigate onto the saved thread, and only then let the
 * store forget the temporary one. The two callers — the banner button and the
 * leave dialog — share this so the sequence is identical whichever way a keep
 * is triggered.
 *
 * The promise resolves with the underlying `keep` result so a caller (the
 * dialog) can decide what to do with the navigation it interrupted. On failure
 * nothing has moved: the temporary chat is still here and the toast says why.
 */
export function usePromoteTemporaryChat() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  return useCallback(async (): Promise<PromotionResult> => {
    const result = await useTemporaryChat.getState().keep()
    if (!result.ok) {
      toast.error(t('chat:temporaryChatLeave.keepFailed'), {
        id: 'keep-temporary-chat',
        description: t(`chat:temporaryChatLeave.reason.${result.reason}`),
      })
      return result
    }

    // Navigate onto the persisted thread first, then clear the temporary state,
    // so the chat is never swept while it is still the one on screen.
    await navigate({
      to: route.threadsDetail,
      params: { threadId: result.threadId },
    })
    useTemporaryChat.getState().finalizeKept()
    toast.success(t('chat:temporaryChatLeave.kept'), {
      id: 'keep-temporary-chat',
    })
    return result
  }, [navigate, t])
}
