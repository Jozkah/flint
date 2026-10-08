import { useRef, useState } from 'react'
import type { ArchiveItemWire, ArchiveKindWire } from '@/lib/remote/protocol'
import { formatBytes } from '@/lib/archive'
import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { Empty, Loading, Pills } from '../ui/bits'
import { ago } from '../ui/format'
import { client, openSheet, toast } from '../state/app'
import { useRpc } from '../state/rpc'
import { archiveChanged } from '../state/archive'
import { t } from '../i18n'
import { SwipeRow } from '../ui/swipe-row'

type Filter = 'all' | ArchiveKindWire

const FILTERS = [
  { id: 'all', label: t('archive.filters.all') },
  { id: 'thread', label: t('archive.filters.thread') },
  { id: 'room', label: t('archive.filters.room') },
  { id: 'cowork', label: t('archive.filters.cowork') },
  { id: 'project', label: t('archive.filters.project') },
  { id: 'assistant', label: t('archive.filters.assistant') },
  { id: 'studio', label: t('archive.filters.studio') },
] as const

const LONG_PRESS_MS = 550

/** Long-press (and the browser's context menu, which Android fires on a
 * long-press) opens the item's menu. A scroll or a lift cancels the press. */
function useLongPress(open: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return {
    onTouchStart: () => {
      fired.current = false
      cancel()
      timer.current = setTimeout(() => {
        fired.current = true
        open()
      }, LONG_PRESS_MS)
    },
    onTouchEnd: cancel,
    onTouchMove: cancel,
    onTouchCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      cancel()
      if (!fired.current) open()
    },
    onClick: () => {
      // A tap opens the same menu: there is nothing else to open.
      if (!fired.current) open()
      fired.current = false
    },
  }
}

async function runArchive(
  method: 'archive.restore' | 'archive.purge',
  item: ArchiveItemWire,
  ok: string
): Promise<boolean> {
  try {
    await client().rpc(method, { key: item.key })
    toast(ok)
    return true
  } catch (e) {
    // A refused purge says why (a Cowork session with unmerged work).
    toast(e instanceof Error ? e.message : t('common.didNotWork'))
    return false
  } finally {
    archiveChanged()
  }
}

function Row({ item }: { item: ArchiveItemWire }) {
  const press = useLongPress(() => openSheet('archivemenu', { item }))
  const kind = FILTERS.find((f) => f.id === item.kind)?.label ?? item.kind
  const name = item.title || t('archive.untitled')
  return (
    <SwipeRow
      toggleLabel={t('archive.actionsFor', { name })}
      secondary={{
        label: t('sheets.restore'),
        icon: <I n="refresh" />,
        onSelect: () => void runArchive('archive.restore', item, t('sheets.restored')),
      }}
      primary={{
        label: t('common.delete'),
        icon: <I n="trash" />,
        confirm: () =>
          window.confirm(
            t('sheets.deleteItemConfirm', {
              title: item.title || t('sheets.thisItem'),
            })
          ),
        onCommit: () =>
          runArchive('archive.purge', item, t('sheets.deletedPermanently')),
      }}
    >
      <button
        type="button"
        className="row"
        data-testid="archive-row"
        {...press}
      >
        <I n="clock" />
        <span className="tx">
          <b>{name}</b>
          <small>
            {kind} · {ago(item.archivedAt)} · {formatBytes(item.sizeBytes)}
          </small>
        </span>
      </button>
    </SwipeRow>
  )
}

/** Deleted chats, rooms, Cowork sessions and projects, kept on the computer
 * until they are restored or deleted for good. */
export default function Archive() {
  const { data, loading, error } = useRpc('archive.list', {})
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState(false)
  const items = (data?.items ?? []).filter((i) => filter === 'all' || i.kind === filter)

  const empty = async () => {
    if (!window.confirm(t('archive.confirmEmpty'))) return
    setBusy(true)
    try {
      const r = await client().rpc('archive.empty', filter === 'all' ? {} : { kind: filter })
      toast(r.blocked.length ? t('archive.deletedBlocked', { count: r.purged, title: r.blocked[0].title, reason: r.blocked[0].reason }) : t('archive.deleted', { count: r.purged }))
    } catch (e) {
      toast(e instanceof Error ? e.message : t('common.didNotWork'))
    } finally {
      setBusy(false)
      archiveChanged()
    }
  }

  const days = data?.retentionDays ?? 30
  return (
    <>
      <TopMain crumb={t('common.workspace')} title={t('archive.title')} />
      <div className="scroll">
        <div className="ph">
          <h2>Archive</h2>
          <p>
            Deleted items wait here. Swipe one left, or press and hold it, to
            restore it or delete it permanently.
          </p>
        </div>
        <Pills items={FILTERS} value={filter} onChange={setFilter} />
        {loading && !data && <Loading />}
        {error && !data && <Empty>{error.message}</Empty>}
        {data && (
          <div className="frame" data-testid="archive-list">
            {items.length === 0 ? (
              <Empty icon={<I n="clock" size={20} />}>{t('archive.empty')}</Empty>
            ) : (
              items.map((i) => <Row key={i.key} item={i} />)
            )}
          </div>
        )}
        {data && (
          <>
            <p className="sh" data-testid="archive-retention">
              {days > 0
                ? t('archive.retention', { count: days })
                : t('archive.retentionForever')}
            </p>
            <button type="button" className="btn dan big" disabled={busy || items.length === 0} onClick={() => void empty()}>
              {t('archive.emptyAction')}
            </button>
          </>
        )}
      </div>
    </>
  )
}
