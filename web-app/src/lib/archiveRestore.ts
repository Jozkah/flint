import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagementStore } from '@/hooks/useThreadManagement'
import { useRoomsStore } from '@/lib/rooms/store'
import { useConversationGroups } from '@/lib/groups/store'
import { restoreCoworkSession } from '@/lib/coworkSessionLifecycle'
import { archiveApi, type ArchivedItem } from '@/lib/archive'
import { useAssistant } from '@/hooks/useAssistant'
import { useStudio } from '@/hooks/useStudio'

/** Re-read the thread list after threads came back from the archive. */
async function reloadThreads(): Promise<void> {
  const threads = await getServiceHub().threads().fetchThreads()
  useThreads.getState().setThreads(threads)
}

type ProjectPayload = {
  folder?: { name?: string; assistantId?: string }
  threadIds?: string[]
}

/**
 * Put an archived item back and make the running app see it. The backend
 * moves the files; what each kind needs on top of that is here: the thread
 * list is re-read, rooms are re-listed, a Cowork session is re-added to its
 * store, and a project is recreated and its archived threads put back in it.
 */
export async function restoreArchived(item: ArchivedItem): Promise<void> {
  const restored = await archiveApi.restore(item.kind, item.archiveId)
  switch (item.kind) {
    case 'thread':
      await reloadThreads()
      return
    case 'room':
      await useRoomsStore.getState().loadSummaries()
      return
    case 'cowork': {
      if (!restoreCoworkSession(restored.payload, restored.extra)) {
        // The backend already released it; put it back so nothing is lost.
        await archiveApi.put(
          'cowork',
          item.id,
          item.title,
          restored.payload,
          restored.extra
        )
        throw new Error('A session with this id already exists')
      }
      return
    }
    case 'assistant': {
      const assistant = restored.payload as Assistant | undefined
      const live = useAssistant.getState().assistants.some((a) => a.id === assistant?.id)
      if (!assistant || live) {
        // The backend already released it; put it back so nothing is lost.
        await archiveApi.put('assistant', item.id, item.title, restored.payload, restored.extra)
        throw new Error('An assistant with this id already exists')
      }
      useAssistant.getState().addAssistant(assistant)
      return
    }
    case 'studio': {
      await Promise.all([
        useStudio.getState().refreshGallery('image'),
        useStudio.getState().refreshGallery('video'),
      ])
      return
    }
    case 'project': {
      const payload = (restored.payload ?? {}) as ProjectPayload
      const wanted = new Set(payload.threadIds ?? [])
      const archived = (await archiveApi.list()).filter(
        (i) => i.kind === 'thread' && wanted.has(i.id)
      )
      const back: string[] = []
      for (const t of archived) {
        try {
          await archiveApi.restore('thread', t.archiveId)
          back.push(t.id)
        } catch {
          // A thread that cannot come back (its id is live again) stays
          // archived; the project is restored without it.
        }
      }
      if (back.length) await reloadThreads()
      const folder = await useThreadManagementStore
        .getState()
        .addFolder(payload.folder?.name || item.title, payload.folder?.assistantId)
      const groups = useConversationGroups.getState()
      for (const [i, id] of back.entries()) {
        await groups.moveItem('home', id, folder.id, i)
      }
      return
    }
  }
}
