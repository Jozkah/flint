import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  useSplitConversation,
  type SplitTarget,
} from '@/hooks/useSplitConversation'
import { useThreads } from '@/hooks/useThreads'
import { useRoomsStore } from '@/lib/rooms/store'

/** Thread titles can carry search-highlight markup. */
export const plainTitle = (title: string | undefined, fallback: string) =>
  (title || fallback).replace(/<span[^>]*>|<\/span>/g, '')

/** The stored title of a pane's conversation, or undefined when it has none. */
function useStoredTitle(kind: SplitTarget['kind'], refId?: string) {
  const chatTitle = useThreads((s) =>
    kind === 'chat' && refId ? s.threads?.[refId]?.title : undefined
  )
  const coworkTitle = useCoworkSessions((s) =>
    kind === 'cowork' && refId
      ? s.sessions.find((x) => x.id === refId)?.title
      : undefined
  )
  const roomTitle = useRoomsStore((s) =>
    kind === 'room' && refId
      ? s.summaries.find((x) => x.id === refId)?.title
      : undefined
  )
  if (kind === 'chat') return chatTitle ? plainTitle(chatTitle, '') : undefined
  if (kind === 'room') return roomTitle || undefined
  return coworkTitle || undefined
}

/** The title a pane shows for its conversation. */
export function usePaneTitle(kind: SplitTarget['kind'], refId?: string) {
  const { t } = useTranslation()
  const stored = useStoredTitle(kind, refId)
  if (!refId) return t('chat:split.newPane')
  if (stored) return stored
  if (kind === 'chat') return t('common:newThread')
  if (kind === 'room') return t('chat:split.room')
  return t('chat:split.cowork')
}

/**
 * Whether the conversation view is split. Each pane then has its own header
 * with its title, so the top breadcrumb names only the section.
 */
export function useSplitViewOpen(): boolean {
  return useSplitConversation((s) => s.panes.length > 0)
}
