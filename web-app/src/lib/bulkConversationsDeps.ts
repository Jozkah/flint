/**
 * The real stores and commands behind a bulk archive / delete. Every item goes
 * through the same path its single-item delete uses; nothing here reaches the
 * disk another way.
 */
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useThreads } from '@/hooks/useThreads'
import { archiveApi, archiveEnabled, purgeArchived } from '@/lib/archive'
import { restoreArchived } from '@/lib/archiveRestore'
import {
  BulkKept,
  BulkSkipped,
  emptySnapshot,
  type BulkAction,
  type BulkItem,
  type BulkKind,
  type BulkSnapshot,
} from '@/lib/bulkConversations'
import { campaignApi } from '@/lib/campaignApi'
import type { CampaignStatus } from '@/lib/campaignModel'
import { isRunning as coworkRunActive } from '@/lib/coworkRunner'
import { deleteCoworkSession, archiveCoworkSession } from '@/lib/coworkSessionLifecycle'
import { removeSessionWorktree } from '@/lib/coworkParallel'
import { errorText } from '@/lib/errorText'
import { roomController } from '@/lib/rooms/controller'
import { useRoomsStore } from '@/lib/rooms/store'
import { useCampaignStore } from '@/hooks/useCampaigns'

/** Campaigns the backend would refuse to delete: anything that has started and not finished. */
const IDLE_CAMPAIGN: ReadonlySet<CampaignStatus> = new Set([
  'draft',
  'planned',
  'done',
  'failed',
  'cancelled',
])

/** Read every kind's current list. Cheap; call it whenever a store changes. */
export function collectBulkSnapshot(): BulkSnapshot {
  const snap = emptySnapshot()

  const streaming = useAppState.getState().streamingContents
  for (const t of Object.values(useThreads.getState().threads)) {
    if (t.id === TEMPORARY_CHAT_ID) continue
    snap.thread.push({
      kind: 'thread',
      id: t.id,
      title: t.title ?? '',
      pinned: !!t.isFavorite,
      active: !!streaming[t.id],
    })
  }

  const campaigns = useCampaignStore.getState().campaigns
  const liveCampaigns = new Set(
    campaigns.filter((c) => !IDLE_CAMPAIGN.has(c.status)).map((c) => c.id)
  )
  for (const c of campaigns) {
    snap.campaign.push({
      kind: 'campaign',
      id: c.id,
      title: c.title ?? '',
      active: liveCampaigns.has(c.id),
    })
  }

  const runs = useCoworkRun.getState().runs
  for (const s of useCoworkSessions.getState().sessions) {
    snap.cowork.push({
      kind: 'cowork',
      id: s.id,
      title: s.title,
      // A session of a campaign that is still going belongs to its run.
      active:
        !!runs[s.id] ||
        coworkRunActive(s.id) ||
        (!!s.campaign && liveCampaigns.has(s.campaign.id)),
    })
  }

  const { summaries, runningRoomIds } = useRoomsStore.getState()
  for (const r of summaries) {
    snap.room.push({
      kind: 'room',
      id: r.id,
      title: r.title,
      active: runningRoomIds.includes(r.id) || r.status === 'running',
    })
  }
  return snap
}

/**
 * Whether bulk archive is offered: the Archive setting is on and the archive
 * can be read from here. The second half matters because an archive that
 * cannot be listed cannot be restored either (a browser on a server that only
 * answers the settings), and an archive nobody can undo is not offered.
 */
export async function bulkArchiveAvailable(): Promise<boolean> {
  if (!(await archiveEnabled())) return false
  try {
    await archiveApi.list()
    return true
  } catch {
    return false
  }
}

/**
 * Whether the item is running right now, read at the moment of acting: the
 * plan's `active` flag is from when the dialog opened, and a chat or session
 * can start streaming while a long run is still working through the list.
 */
export function isItemActiveNow(item: BulkItem): boolean {
  return collectBulkSnapshot()[item.kind].some((i) => i.id === item.id && i.active)
}

async function archiveOne(item: BulkItem): Promise<void> {
  // A thread or room "archive" is a delete that the Archive intercepts; with
  // the Archive turned off since the dialog opened it would destroy the item.
  if (!(await archiveEnabled())) throw new Error('archive is off')
  switch (item.kind) {
    case 'thread':
      await useThreads.getState().deleteThreadAsync(item.id)
      return
    case 'room':
      await roomController.deleteRoom(item.id)
      return
    case 'cowork': {
      // The worktree is kept, exactly as the single archive keeps it.
      const archived = await archiveCoworkSession(item.id, false)
      if (!archived) throw new Error('session no longer exists')
      useCoworkParallel.getState().forgetSession(item.id)
      return
    }
    case 'campaign':
      throw new Error('campaigns cannot be archived')
  }
}

async function deleteOne(item: BulkItem): Promise<void> {
  switch (item.kind) {
    case 'thread':
      await useThreads.getState().deleteThreadAsync(item.id, true)
      return
    case 'room':
      // Skips the archive: `room_delete_permanently`, which also works on a
      // server where the archive commands are not reachable.
      await roomController.deleteRoom(item.id, { permanent: true })
      return
    case 'cowork': {
      if (await archiveEnabled()) {
        // Archive with the worktree marked for removal, then purge: the purge
        // refuses while the worktree holds unmerged work, and the session then
        // stays safe in the Archive.
        const archived = await archiveCoworkSession(item.id, true)
        if (archived) {
          useCoworkParallel.getState().forgetSession(item.id)
          try {
            await purgeArchived('cowork', item.id)
          } catch (e) {
            throw new BulkKept(errorText(e))
          }
          return
        }
      }
      // Archive off: the single delete with "remove worktree" ticked, but not
      // forced, so a worktree holding unfinished work is refused and keeps
      // its session.
      if (useCoworkWorktrees.getState().bySession[item.id]) {
        const removed = await removeSessionWorktree(item.id, false)
        if (!removed.ok) throw new Error(removed.reason)
      }
      useCoworkParallel.getState().forgetSession(item.id)
      deleteCoworkSession(item.id)
      return
    }
    case 'campaign':
      await campaignApi.delete(item.id)
      unlinkCampaignSessions(item.id)
      return
  }
}

/**
 * Sessions keep a `campaign` pointer to the plan they ran under. The record is
 * gone now, so the pointer would lead nowhere (a campaign chip, a "coordinator"
 * mode with nothing behind it). The sessions themselves stay as ordinary ones.
 */
function unlinkCampaignSessions(campaignId: string): void {
  const store = useCoworkSessions.getState()
  for (const s of store.sessions) {
    if (s.campaign?.id === campaignId) store.setCampaign(s.id, null)
  }
}

export async function actOnItem(item: BulkItem, action: BulkAction): Promise<void> {
  if (isItemActiveNow(item)) throw new BulkSkipped('running')
  return action === 'archive' ? archiveOne(item) : deleteOne(item)
}

/** After a run: re-read what the stores may have drifted on. */
export async function resyncAfterBulk(kinds: ReadonlySet<BulkKind>): Promise<void> {
  const jobs: Promise<unknown>[] = []
  if (kinds.has('thread')) {
    jobs.push(
      import('@/hooks/useServiceHub').then(async ({ getServiceHub }) => {
        useThreads.getState().setThreads(await getServiceHub().threads().fetchThreads())
      })
    )
  }
  if (kinds.has('room')) jobs.push(useRoomsStore.getState().loadSummaries())
  if (kinds.has('campaign')) jobs.push(useCampaignStore.getState().refresh())
  await Promise.allSettled(jobs)
}

/**
 * Put back what a bulk archive moved: the newest archived copy of each item.
 * Returns how many came back and the ones that did not.
 */
export async function undoBulkArchive(
  items: BulkItem[]
): Promise<{ restored: number; failed: { item: BulkItem; error: string }[] }> {
  const archived = await archiveApi.list()
  let restored = 0
  const failed: { item: BulkItem; error: string }[] = []
  for (const item of items) {
    const hit = archived
      .filter((a) => a.kind === item.kind && a.id === item.id)
      .sort((a, b) => b.archivedAt - a.archivedAt)[0]
    if (!hit) {
      failed.push({ item, error: 'not in the Archive' })
      continue
    }
    try {
      await restoreArchived(hit)
      restored++
    } catch (e) {
      failed.push({ item, error: errorText(e) })
    }
    await new Promise<void>((r) => setTimeout(r, 0))
  }
  return { restored, failed }
}
