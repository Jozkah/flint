import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { EmptyState } from '@/components/ui/empty-state'
import { Icon } from '@/components/ui/icon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  archiveApi,
  DEFAULT_ARCHIVE_SETTINGS,
  formatBytes,
  setArchiveEnabled,
  type ArchiveKind,
  type ArchivedItem,
  type ArchiveSettings,
} from '@/lib/archive'
import { restoreArchived } from '@/lib/archiveRestore'
import { errorText } from '@/lib/errorText'

type Filter = 'all' | ArchiveKind

const KINDS: ArchiveKind[] = ['thread', 'room', 'cowork', 'project']

type Confirm = { type: 'one'; item: ArchivedItem } | { type: 'all' } | null

/** A whole number of days from a text field; empty or invalid is 0 (off). */
function days(raw: string): number {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 0
}

/**
 * The archive: what deleting a thread, room, Cowork session or project moves
 * aside instead of destroying. Restore puts it back; delete forever is the
 * only thing here that destroys anything.
 */
export function ArchivePanel() {
  const { t } = useTranslation()
  const [items, setItems] = useState<ArchivedItem[] | null>(null)
  const [usage, setUsage] = useState(0)
  const [settings, setSettings] = useState<ArchiveSettings>(
    DEFAULT_ARCHIVE_SETTINGS
  )
  const [filter, setFilter] = useState<Filter>('all')
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [list, bytes] = await Promise.all([
        archiveApi.list(),
        archiveApi.diskUsage(),
      ])
      setItems(list)
      setUsage(bytes)
    } catch (e) {
      setItems([])
      toast.error(t('archive:loadFailed'), { description: errorText(e) })
    }
  }, [t])

  useEffect(() => {
    void refresh()
    archiveApi
      .getSettings()
      .then(setSettings)
      .catch(() => undefined)
  }, [refresh])

  const save = async (next: ArchiveSettings) => {
    const previous = settings
    setSettings(next)
    try {
      const saved = await archiveApi.setSettings(next)
      setSettings(saved)
      setArchiveEnabled(saved.enabled)
    } catch (e) {
      setSettings(previous)
      toast.error(t('archive:saveFailed'), { description: errorText(e) })
    }
  }

  const visible = useMemo(
    () => (items ?? []).filter((i) => filter === 'all' || i.kind === filter),
    [items, filter]
  )

  const restore = async (item: ArchivedItem) => {
    setBusy(true)
    try {
      await restoreArchived(item)
      toast.success(t('archive:restored', { title: item.title }))
    } catch (e) {
      toast.error(t('archive:restoreFailed'), { description: errorText(e) })
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const runConfirmed = async () => {
    if (!confirm) return
    const action = confirm
    setConfirm(null)
    setBusy(true)
    try {
      if (action.type === 'one') {
        await archiveApi.purge(action.item.kind, action.item.archiveId)
      } else {
        const report = await archiveApi.empty(
          filter === 'all' ? undefined : filter
        )
        // Anything a guard refused stays archived, and the user is told why.
        for (const b of report.blocked) {
          toast.error(t('archive:blocked', { title: b.title }), {
            description: b.reason,
          })
        }
      }
    } catch (e) {
      // A refused purge (unmerged work) names what would have been lost.
      toast.error(t('archive:deleteFailed'), { description: errorText(e) })
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const kindLabel = (k: ArchiveKind) => t(`archive:kind.${k}`)

  return (
    <div className="flex flex-col gap-4" data-testid="archive-panel">
      <Card title={t('archive:settingsTitle')}>
        <CardItem
          title={t('archive:enabled')}
          description={t('archive:enabledDesc')}
          actions={
            <Switch
              checked={settings.enabled}
              aria-label={t('archive:enabled')}
              onCheckedChange={(enabled) => void save({ ...settings, enabled })}
            />
          }
        />
        <CardItem
          title={t('archive:autoDelete')}
          description={t('archive:autoDeleteDesc')}
          actions={
            <Input
              type="number"
              min={0}
              className="w-24"
              aria-label={t('archive:autoDelete')}
              defaultValue={settings.autoDeleteDays}
              key={`d-${settings.autoDeleteDays}`}
              onBlur={(e) => {
                const autoDeleteDays = days(e.target.value)
                if (autoDeleteDays !== settings.autoDeleteDays)
                  void save({ ...settings, autoDeleteDays })
              }}
            />
          }
        />
        <CardItem
          title={t('archive:autoArchive')}
          description={t('archive:autoArchiveDesc')}
          actions={
            <Input
              type="number"
              min={0}
              className="w-24"
              aria-label={t('archive:autoArchive')}
              defaultValue={settings.autoArchiveThreadDays}
              key={`a-${settings.autoArchiveThreadDays}`}
              onBlur={(e) => {
                const autoArchiveThreadDays = days(e.target.value)
                if (autoArchiveThreadDays !== settings.autoArchiveThreadDays)
                  void save({ ...settings, autoArchiveThreadDays })
              }}
            />
          }
        />
      </Card>

      <Card
        title={t('archive:itemsTitle')}
        aside={
          <span className="text-xs text-muted-foreground" data-testid="archive-usage">
            {t('archive:usage', { size: formatBytes(usage) })}
          </span>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
          <Segmented<Filter>
            aria-label={t('archive:filter')}
            value={filter}
            onValueChange={setFilter}
            size="sm"
            options={[
              { value: 'all', label: t('archive:kind.all') },
              ...KINDS.map((k) => ({
                value: k as Filter,
                label: kindLabel(k),
              })),
            ]}
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || visible.length === 0}
            onClick={() => setConfirm({ type: 'all' })}
          >
            {t('archive:empty')}
          </Button>
        </div>
        {items !== null && visible.length === 0 ? (
          <EmptyState
            icon={<Icon name="x-disk" />}
            title={t('archive:none')}
            description={t('archive:noneDesc')}
          />
        ) : (
          <ul className="flex flex-col" data-testid="archive-list">
            {visible.map((item) => (
              <li
                key={`${item.kind}/${item.archiveId}`}
                className="flex flex-wrap items-center gap-3 border-t border-dashed border-border px-3 py-2.5"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {item.title || t('archive:untitled')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('archive:archivedOn', {
                      date: new Date(item.archivedAt).toLocaleString(),
                    })}
                    {' · '}
                    {formatBytes(item.sizeBytes)}
                  </span>
                </div>
                <Chip>{kindLabel(item.kind)}</Chip>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void restore(item)}
                >
                  {t('archive:restore')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirm({ type: 'one', item })}
                >
                  {t('archive:deleteForever')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.type === 'all'
                ? t('archive:emptyTitle')
                : t('archive:deleteTitle')}
            </DialogTitle>
            <DialogDescription>
              {confirm?.type === 'all'
                ? t('archive:emptyBody', { count: visible.length })
                : t('archive:deleteBody', { title: confirm?.item.title })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void runConfirmed()}
            >
              {t('archive:deleteForever')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
