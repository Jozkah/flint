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
import { SwipeRow } from '../ui/swipe-row'

type Filter = 'all' | ArchiveKindWire

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'thread', label: 'Chats' },
  { id: 'room', label: 'Rooms' },
  { id: 'cowork', label: 'Cowork' },
  { id: 'project', label: 'Projects' },
  { id: 'assistant', label: 'Assistants' },
  { id: 'studio', label: 'Studio' },
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
    toast(e instanceof Error ? e.message : 'That did not work')
    return false
  } finally {
    archiveChanged()
  }
}

function Row({ item }: { item: ArchiveItemWire }) {
  const press = useLongPress(() => openSheet('archivemenu', { item }))
  const kind = FILTERS.find((f) => f.id === item.kind)?.label ?? item.kind
  const name = item.title || 'Untitled'
  return (
    <SwipeRow
      toggleLabel={`Actions for ${name}`}
      secondary={{
        label: 'Restore',
        icon: <I n="refresh" />,
        onSelect: () => void runArchive('archive.restore', item, 'Restored'),
      }}
      primary={{
        label: 'Delete',
        icon: <I n="trash" />,
        confirm: () =>
          window.confirm(
            `Delete “${item.title || 'this item'}” permanently? This can’t be undone.`
          ),
        onCommit: () =>
          runArchive('archive.purge', item, 'Deleted permanently'),
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
    if (!window.confirm('Delete everything in the archive permanently? This can’t be undone.')) return
    setBusy(true)
    try {
      const r = await client().rpc('archive.empty', filter === 'all' ? {} : { kind: filter })
      toast(r.blocked.length ? `Deleted ${r.purged}. ${r.blocked[0].title}: ${r.blocked[0].reason}` : `Deleted ${r.purged}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work')
    } finally {
      setBusy(false)
      archiveChanged()
    }
  }

  const days = data?.retentionDays ?? 30
  return (
    <>
      <TopMain crumb="Workspace" title="Archive" />
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
              <Empty icon={<I n="clock" size={20} />}>Nothing in the archive.</Empty>
            ) : (
              items.map((i) => <Row key={i.key} item={i} />)
            )}
          </div>
        )}
        {data && (
          <>
            <p className="sh" data-testid="archive-retention">
              {days > 0
                ? `Archived items are deleted for good after ${days} days.`
                : 'Archived items stay until you delete them.'}
            </p>
            <button type="button" className="btn dan big" disabled={busy || items.length === 0} onClick={() => void empty()}>
              Empty archive
            </button>
          </>
        )}
      </div>
    </>
  )
}
