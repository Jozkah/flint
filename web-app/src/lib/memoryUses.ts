import { memoryRecordUses } from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'
import type { TurnMemory } from '@/types/coworkSession'

/**
 * Record, on each memory a request carried, that this turn used it (AH-083).
 *
 * Best effort and after the fact: the reply has already been shown, and a
 * failure to write where a memory was used must never fail the turn. The
 * backend only touches records this session and project may see, so naming
 * ids here cannot mark another chat's memories.
 */
export async function recordMemoryUses(opts: {
  sessionId: string | undefined
  projectRoot?: string
  memory: TurnMemory | undefined
  turnId?: string
  snapshotId?: string
}): Promise<void> {
  const ids = opts.memory?.injectedIds ?? []
  if (!opts.sessionId || ids.length === 0) return
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (!dataFolder) return
    const reasons = new Map((opts.memory?.recall ?? []).map((r) => [r.id, r.reason]))
    await memoryRecordUses(
      { dataFolder, projectRoot: opts.projectRoot, sessionId: opts.sessionId },
      ids.map((id) => ({ id, reason: reasons.get(id) })),
      { turnId: opts.turnId, snapshotId: opts.snapshotId }
    )
  } catch (error) {
    console.warn('[memory] could not record where memories were used:', error)
  }
}
