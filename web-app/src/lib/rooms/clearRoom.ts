import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * What to forget when a room is cleared. Each option includes the one above it.
 * None of them touches the room's settings, participants, limits or the folders
 * attached to it.
 */
export type ClearScope =
  /** Every message: the transcript, votes and syntheses. */
  | 'chat'
  /** Also what the room built up from that chat: its run counters, the round it was in and any suspended participant, so it starts over from the objective. */
  | 'knowledge'
  /** Also the room's scratch files, its command sandbox and prompts still waiting for an answer. */
  | 'everything'

export const CLEAR_SCOPES: readonly ClearScope[] = ['chat', 'knowledge', 'everything']

export const clearsKnowledge = (scope: ClearScope): boolean => scope !== 'chat'
export const clearsScratch = (scope: ClearScope): boolean => scope === 'everything'

/**
 * Delete a room's scratch workspaces (its command sandbox) and withdraw any
 * approval prompt still open for it. Failures are swallowed: there may be no
 * workspace to delete, and the transcript is already gone by now.
 */
export async function clearRoomScratch(roomId: string): Promise<void> {
  useToolApprovalRequests.getState().clearPendingForThread(roomId, { notify: false })
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (!dataFolder) return
    const { threadWorkspaceDelete, sessionWorkspaceDelete } = await import(
      '@janhq/tauri-plugin-agent-tools-api'
    )
    await Promise.allSettled([
      threadWorkspaceDelete(dataFolder, roomId),
      sessionWorkspaceDelete(dataFolder, roomId),
    ])
  } catch {
    // Nothing to remove.
  }
}
