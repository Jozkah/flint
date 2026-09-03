import { useBlocker } from '@tanstack/react-router'
import { toast } from 'sonner'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { route } from '@/constants/routes'
import { isEmptyTemporaryChat } from '@/lib/temporaryChat'
import { useMessages } from '@/hooks/useMessages'
import { useTemporaryChat } from '@/hooks/useTemporaryChat'
import { usePromoteTemporaryChat } from '@/hooks/usePromoteTemporaryChat'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { LeaveTemporaryChatDialog } from '@/containers/dialogs/LeaveTemporaryChatDialog'

/** The route a temporary chat lives at. */
const TEMPORARY_CHAT_PATH = route.threadsDetail.replace(
  '$threadId',
  TEMPORARY_CHAT_ID
)

/**
 * The one place that stands between a temporary chat and its own disappearance.
 *
 * Mounted once, above every route, it watches for a navigation *away from* a
 * temporary chat that still has something in it and turns that navigation into
 * a question. An empty temporary chat is never worth interrupting — there is
 * nothing to lose — so the guard simply lets those through.
 *
 * The one navigation it must not fight is the one a keep performs onto the
 * thread it just saved; `useTemporaryChat.leaving` marks that so the guard
 * stands aside for it.
 *
 * Nothing here persists or discards on its own. It asks; the user decides.
 */
export function TemporaryChatGuard() {
  const { t } = useTranslation()
  const promote = usePromoteTemporaryChat()
  const busy = useTemporaryChat((state) => state.busy)

  const blocker = useBlocker({
    withResolver: true,
    shouldBlockFn: ({ current, next }) => {
      // The keep's own navigation onto the saved thread is exempt.
      if (useTemporaryChat.getState().leaving) return false
      // Only leaving the temporary chat matters...
      if (current.pathname !== TEMPORARY_CHAT_PATH) return false
      // ...and only when the destination is genuinely elsewhere (not a search
      // change on the same chat).
      if (next.pathname === current.pathname) return false
      // ...and only when there is something to lose.
      return !isEmptyTemporaryChat(
        useMessages.getState().getMessages(TEMPORARY_CHAT_ID)
      )
    },
  })

  const isBlocked = blocker.status === 'blocked'

  const handleKeep = async () => {
    // Keep persists, navigates onto the saved thread, and clears the temporary
    // state itself. Whatever navigation triggered this dialog is abandoned in
    // favour of landing on the kept thread, so the blocker is reset either way.
    await promote()
    blocker.reset?.()
  }

  const handleDiscard = async () => {
    const result = await useTemporaryChat.getState().discard()
    if (result.ok) {
      // Swept clean; the navigation the user asked for may continue.
      blocker.proceed?.()
      return
    }
    // Generation would not stop: keep the chat and stay put rather than risk a
    // sweep while a stream might still be writing.
    toast.error(t('chat:temporaryChatLeave.discardFailed'), {
      id: 'discard-temporary-chat',
    })
    blocker.reset?.()
  }

  const handleCancel = () => {
    blocker.reset?.()
  }

  return (
    <LeaveTemporaryChatDialog
      open={isBlocked}
      busy={busy}
      onKeep={handleKeep}
      onDiscard={handleDiscard}
      onCancel={handleCancel}
    />
  )
}
