import { archiveApi } from '@/lib/archive'
import { restoreArchived } from '@/lib/archiveRestore'
import type { RemoteArchive } from './archive'

/** The archive as phones see it: the desktop's own archive, by key. */
export const appArchive: RemoteArchive = {
  async list() {
    const [items, settings] = await Promise.all([
      archiveApi.list(),
      archiveApi.getSettings().catch(() => null),
    ])
    return {
      items: items.map((i) => ({
        key: `${i.kind}:${i.archiveId}`,
        kind: i.kind,
        title: i.title,
        archivedAt: i.archivedAt,
        sizeBytes: i.sizeBytes,
      })),
      retentionDays: settings?.autoDeleteDays ?? 30,
    }
  },
  async restore(kind, name) {
    const item = (await archiveApi.list()).find((i) => i.kind === kind && i.archiveId === name)
    if (!item) throw new Error('That item is no longer in the archive')
    await restoreArchived(item)
  },
  async purge(kind, name) {
    await archiveApi.purge(kind, name)
  },
  async empty(kind) {
    const report = await archiveApi.empty(kind)
    return {
      purged: report.purged,
      blocked: report.blocked.map((b) => ({ title: b.title, reason: b.reason })),
    }
  },
}
