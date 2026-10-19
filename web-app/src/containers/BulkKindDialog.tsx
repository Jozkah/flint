import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { BulkConversationsDialog } from '@/containers/BulkConversationsDialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useRoomsStore } from '@/lib/rooms/store'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  ARCHIVABLE,
  countKinds,
  planBulk,
  type BulkAction,
  type BulkKind,
} from '@/lib/bulkConversations'
import {
  actOnItem,
  bulkArchiveAvailable,
  collectBulkSnapshot,
  resyncAfterBulk,
  undoBulkArchive,
} from '@/lib/bulkConversationsDeps'

/**
 * The bulk delete / archive dialog for ONE kind, opened from a list's own
 * menu. It always covers the whole kind, whatever filter the list shows, and
 * says so. Mount it only while open: a fresh mount starts at the delete
 * confirmation, which still wants the typed word.
 */
export function BulkKindDialog({
  kind,
  onClose,
  onDone,
}: {
  kind: BulkKind
  onClose: () => void
  /** After a run ended (also when stopped), once the lists were re-read. */
  onDone?: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [action, setAction] = useState<BulkAction>('delete')
  const [keepPinned, setKeepPinned] = useState(true)
  const [archiveOn, setArchiveOn] = useState(false)

  // Subscribed only so the plan follows the lists as they change.
  const threads = useThreads((s) => s.threads)
  const streaming = useAppState((s) => s.streamingContents)
  const sessions = useCoworkSessions((s) => s.sessions)
  const runs = useCoworkRun((s) => s.runs)
  const summaries = useRoomsStore((s) => s.summaries)
  const runningRooms = useRoomsStore((s) => s.runningRoomIds)

  useEffect(() => {
    void bulkArchiveAvailable().then(setArchiveOn, () => setArchiveOn(false))
  }, [])

  const snapshot = useMemo(
    () => collectBulkSnapshot(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threads, streaming, sessions, runs, summaries, runningRooms]
  )
  const kinds = useMemo(() => new Set<BulkKind>([kind]), [kind])
  const plan = planBulk({ snapshot, kinds, action, keepPinned })
  const pinned = countKinds(snapshot)[kind].pinned

  return (
    <BulkConversationsDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      plan={plan}
      act={actOnItem}
      undo={undoBulkArchive}
      canStart={action === 'archive' ? bulkArchiveAvailable : undefined}
      onFinished={() => {
        void resyncAfterBulk(kinds)
        onDone?.()
      }}
      onOpenArchive={
        isPlatformTauri() ? () => void navigate({ to: route.archive }) : undefined
      }
      keepPinned={
        kind === 'thread'
          ? { value: keepPinned, onChange: setKeepPinned, count: pinned }
          : undefined
      }
      scopeNote={t('settings:bulk.scopeAll')}
      onSwitchToArchive={
        archiveOn && ARCHIVABLE[kind] && action === 'delete'
          ? () => setAction('archive')
          : undefined
      }
    />
  )
}
