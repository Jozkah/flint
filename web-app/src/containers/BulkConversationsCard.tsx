import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { BulkConversationsDialog } from '@/containers/BulkConversationsDialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCampaigns } from '@/hooks/useCampaigns'
import { useRoomsStore } from '@/lib/rooms/store'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  ARCHIVABLE,
  BULK_KINDS,
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
 * Settings > General: archive or delete every chat, Cowork session, room or
 * campaign in one go. Nothing is ticked by default; every run is confirmed,
 * and what is running is skipped.
 */
export function BulkConversationsCard({ anchor }: { anchor?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [kinds, setKinds] = useState<ReadonlySet<BulkKind>>(new Set())
  const [keepPinned, setKeepPinned] = useState(true)
  const [archiveOn, setArchiveOn] = useState(false)
  const [action, setAction] = useState<BulkAction | null>(null)

  // Subscribed only so the counts follow the lists as they change.
  const threads = useThreads((s) => s.threads)
  const streaming = useAppState((s) => s.streamingContents)
  const sessions = useCoworkSessions((s) => s.sessions)
  const runs = useCoworkRun((s) => s.runs)
  const summaries = useRoomsStore((s) => s.summaries)
  const runningRooms = useRoomsStore((s) => s.runningRoomIds)
  const { campaigns, unavailable } = useCampaigns()

  useEffect(() => {
    void useRoomsStore.getState().loadSummaries().catch(() => undefined)
    void bulkArchiveAvailable().then(setArchiveOn, () => setArchiveOn(false))
  }, [])

  const snapshot = useMemo(
    () => collectBulkSnapshot(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threads, streaming, sessions, runs, summaries, runningRooms, campaigns]
  )
  const counts = countKinds(snapshot)

  const planFor = (a: BulkAction) =>
    planBulk({ snapshot, kinds, action: a, keepPinned })
  const archivePlan = planFor('archive')
  const deletePlan = planFor('delete')
  const dialogPlan = action === 'archive' ? archivePlan : deletePlan

  const toggle = (kind: BulkKind, on: boolean) => {
    const next = new Set(kinds)
    if (on) next.add(kind)
    else next.delete(kind)
    setKinds(next)
  }

  const noteFor = (kind: BulkKind): string | null => {
    if (kind === 'campaign' && unavailable) return t('settings:bulk.campaignsUnavailable')
    if (kind === 'campaign') return t('settings:bulk.campaignsDeleteOnly')
    if (kind === 'thread' && counts.thread.pinned > 0)
      return t('settings:bulk.pinnedCount', { n: counts.thread.pinned })
    return null
  }

  return (
    <Card title={t('settings:bulk.title')} description={t('settings:bulk.desc')}>
      <CardItem
        anchor={anchor}
        column
        align="start"
        title={t('settings:bulk.selectTitle')}
        description={t('settings:bulk.selectDesc')}
        actions={
          <div className="flex flex-col gap-1" data-testid="bulk-kinds">
            {BULK_KINDS.map((kind) => {
              const disabled = kind === 'campaign' && !!unavailable
              const note = noteFor(kind)
              return (
                <label
                  key={kind}
                  className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md py-1 sm:min-h-0"
                >
                  <input
                    type="checkbox"
                    checked={kinds.has(kind)}
                    disabled={disabled}
                    onChange={(e) => toggle(kind, e.target.checked)}
                    className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border accent-primary"
                    data-testid={`bulk-kind-${kind}`}
                  />
                  <span className="flex flex-col">
                    <span className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                      {t(`settings:bulk.kind.${kind}`)}
                      <span
                        className="ml-2 tabular-nums text-muted-foreground"
                        data-testid={`bulk-count-${kind}`}
                      >
                        {counts[kind].total}
                      </span>
                    </span>
                    {note && (
                      <span className="text-xs text-muted-foreground">{note}</span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        }
      />
      <CardItem
        title={t('settings:bulk.keepPinned')}
        description={t('settings:bulk.keepPinnedDesc')}
        actions={
          <Switch
            checked={keepPinned}
            onCheckedChange={setKeepPinned}
            data-testid="bulk-keep-pinned"
          />
        }
      />
      <CardItem
        title={t('settings:bulk.archiveRowTitle')}
        description={
          archiveOn ? t('settings:bulk.archiveRowDesc') : t('settings:bulk.archiveOff')
        }
        actions={
          <Button
            variant="outline"
            disabled={!archiveOn || archivePlan.items.length === 0}
            onClick={() => setAction('archive')}
            data-testid="bulk-archive"
          >
            {t('settings:bulk.archiveButton')}
          </Button>
        }
      />
      <CardItem
        title={t('settings:bulk.deleteRowTitle')}
        description={t('settings:bulk.deleteRowDesc')}
        actions={
          <Button
            variant="destructive"
            disabled={deletePlan.items.length === 0}
            onClick={() => setAction('delete')}
            data-testid="bulk-delete"
          >
            {t('settings:bulk.deleteButton')}
          </Button>
        }
      />
      {kinds.size > 0 &&
        [...kinds].every((k) => !ARCHIVABLE[k]) &&
        archiveOn && (
          <p className="px-0.5 pb-1 text-xs text-muted-foreground">
            {t('settings:bulk.campaignsDeleteOnly')}
          </p>
        )}
      {action && (
        <BulkConversationsDialog
          open
          onOpenChange={(open) => {
            if (!open) setAction(null)
          }}
          plan={dialogPlan}
          act={actOnItem}
          undo={undoBulkArchive}
          canStart={action === 'archive' ? bulkArchiveAvailable : undefined}
          onFinished={() => void resyncAfterBulk(kinds)}
          onOpenArchive={
            isPlatformTauri()
              ? () => void navigate({ to: route.archive })
              : undefined
          }
        />
      )}
    </Card>
  )
}
