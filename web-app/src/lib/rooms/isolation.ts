/**
 * Isolated workspaces for compare rooms.
 *
 * In compare mode every participant answers the same message at the same time.
 * Two writers in one folder would overwrite each other, so without isolation
 * writers only read there (`turnToolAccess`). With it, each writer gets its own
 * checkout under the room's data directory (a detached git worktree, or a
 * scratch copy for a folder that is not a repository), made by the backend on
 * first use, refused for an untrusted folder. When it cannot be made the
 * participant keeps the read-only fallback and the editor says why.
 */
import { create } from 'zustand'
import type { Participant, Room, RoomChangedFile } from './types'

/** What the engine needs from the backend to isolate a participant. */
export type RoomWorkspaceDeps = {
  /** The participant's workspace path, made on first use. Throws with the reason. */
  ensure: (roomId: string, participantId: string, folder: string) => Promise<{ path: string }>
  /**
   * What the participant changed in its workspace: since the turn began
   * (`turn`, the default) or since the workspace was made (`all`).
   */
  changes: (roomId: string, participantId: string, scope?: 'turn' | 'all') => Promise<RoomChangedFile[]>
  /** Remember the workspace as it is now as the start of a turn. */
  markTurn?: (roomId: string, participantId: string) => Promise<void>
  /** Remove every workspace of a room (only "clear everything" does). */
  remove?: (roomId: string) => Promise<void>
}

const writes = (p: Participant) => p.toolAccess === 'edit' || p.toolAccess === 'full'

/** Whether a room's writers should each get their own workspace. */
export function isolationWanted(room: Pick<Room, 'mode' | 'folder' | 'participants'>): boolean {
  if (room.mode !== 'compare' || !room.folder) return false
  return room.participants.filter((p) => !p.removed && writes(p)).length >= 2
}

/** Whether this participant would work in a workspace in this room. */
export function participantIsolated(
  room: Pick<Room, 'mode' | 'folder' | 'participants'>,
  p: Participant
): boolean {
  return isolationWanted(room) && writes(p)
}

/**
 * Why isolation is unavailable, per room, as the last run found it. Memory
 * only: the reason is re-checked on every run.
 */
export const useIsolationNotes = create<{ notes: Record<string, string> }>(() => ({ notes: {} }))

export function noteIsolation(roomId: string, reason: string | null) {
  useIsolationNotes.setState((s) => {
    const notes = { ...s.notes }
    if (reason) notes[roomId] = reason
    else delete notes[roomId]
    return { notes }
  })
}

export function isolationNote(roomId: string): string | undefined {
  return useIsolationNotes.getState().notes[roomId]
}

/** The line a participant's prompt carries about its workspace. */
export function workspacePromptLine(path: string, source: string): string {
  return (
    `You work in your own isolated copy of the room's folder, made from ${source} as it was when the copy was made, uncommitted changes included: ${path}. ` +
    'Use full paths under it. The other assistants have their own copies, and nothing you change reaches the user\'s folder unless the user applies it.'
  )
}
