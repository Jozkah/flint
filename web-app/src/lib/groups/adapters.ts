/**
 * Folder adapters for grouped items: how a Cowork session and a Room attach
 * and detach the folders they inherit from a group. Both go through the
 * surface's normal attach path, never around it.
 */
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { extraFoldersOf } from '@/lib/coworkFolders'
import type { RoomsUiApi } from '@/containers/rooms/roomsBindings'
import { canonicalKey } from './domain'
import type { FolderAdapter } from './inherit'

/**
 * A session's first inherited folder becomes its primary folder when it has
 * none; the rest are attached beside it. Attaching changes the session's
 * folders, which puts it back in review-only access until the user agrees
 * again.
 */
export const coworkFolderAdapter: FolderAdapter = {
  attached: async (id) => {
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)
    if (!s) return []
    return [...(s.folder ? [s.folder] : []), ...extraFoldersOf(s)]
  },
  attach: async (id, paths) => {
    const store = useCoworkSessions.getState()
    const s = store.sessions.find((x) => x.id === id)
    if (!s || paths.length === 0) return []
    let rest = paths
    if (!s.folder) {
      store.setFolder(id, paths[0])
      rest = paths.slice(1)
    }
    for (const p of rest) useCoworkSessions.getState().addExtraFolder(id, p)
    return paths
  },
  detach: async (id, paths) => {
    const keys = new Set(paths.map(canonicalKey))
    const s = useCoworkSessions.getState().sessions.find((x) => x.id === id)
    if (!s) return
    for (const extra of extraFoldersOf(s)) {
      if (keys.has(canonicalKey(extra)))
        useCoworkSessions.getState().removeExtraFolder(id, extra)
    }
    if (s.folder && keys.has(canonicalKey(s.folder)))
      useCoworkSessions.getState().setFolder(id, null)
  },
}

/**
 * A room has one folder for its tools: it inherits the group's first folder
 * when it has none, and keeps its own otherwise.
 */
export function roomFolderAdapter(api: RoomsUiApi): FolderAdapter {
  const load = async (id: string) => {
    // Read without opening: loading would switch the room in view.
    if (!api.peekRoom) return null
    return (await api.peekRoom(id)).room
  }
  return {
    attached: async (id) => {
      const room = await load(id)
      return room?.folder ? [room.folder] : []
    },
    attach: async (id, paths) => {
      const room = await load(id)
      if (!room || room.folder || paths.length === 0) return []
      await api.updateRoomSettings(room, { folder: paths[0] })
      return [paths[0]]
    },
    detach: async (id, paths) => {
      const room = await load(id)
      if (!room?.folder) return
      if (paths.some((p) => canonicalKey(p) === canonicalKey(room.folder!)))
        await api.updateRoomSettings(room, { folder: null })
    },
  }
}
