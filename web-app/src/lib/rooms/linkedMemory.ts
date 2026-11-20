/**
 * Memories a Room reads from the Chat group its own group is linked to.
 *
 * A Room has no project memory of its own, and its tools never include the
 * memory tools, so this is the only way memory reaches one. The block goes
 * into every speaker's system prompt, which means every model in the room
 * (including cloud providers) sees it; that is why it only happens when the
 * user has linked the room's group to a Chat group.
 */
import { memoryRetrieve } from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useConversationGroups } from '@/lib/groups/store'
import { linkedHomeGroupOfRoom } from '@/lib/groups/links'
import { memoryLocation } from '@/lib/memoryBinding'

/** The linked group's memory block for a room, or null when none applies. */
export async function linkedMemoryBlock(roomId: string): Promise<string | null> {
  const home = linkedHomeGroupOfRoom(useConversationGroups.getState().state, roomId)
  if (!home) return null
  try {
    const dataFolder = (await getServiceHub().app().getJanDataFolder()) ?? null
    if (!dataFolder) return null
    const retrieved = await memoryRetrieve(
      memoryLocation(dataFolder, { janProjectId: home.id }, roomId),
      { temporary: false }
    )
    return retrieved.block?.trim() ? retrieved.block : null
  } catch (e) {
    // Not remembering is a degraded answer; refusing to answer is not.
    console.warn('[rooms] linked memory unavailable:', e)
    return null
  }
}
