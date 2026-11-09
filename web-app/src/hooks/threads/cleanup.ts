// What deleting a thread leaves to clean: sibling stores, the vector DB,
// caches, artifacts and the backend record.

import { forgetDeadTools } from '@/lib/deadTools'
import { forgetChatLoopGuard } from '@/lib/chatLoopGuard'
import { forgetThreadStats } from '@/lib/chatMentionSources'
import { clearChatImages } from '@/lib/chatImages'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useThreadToolGrants } from '@/hooks/useThreadToolGrants'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { useWebSearchChoice } from '@/hooks/useWebSearchChoice'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { useChatSessions } from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useToolApproval } from '@/hooks/useToolApproval'
import { cleanupThreadWorkspace } from '@/lib/agentTools'
import { archiveEnabled, trackArchiveWork } from '@/lib/archive'
import { cancelPendingMessageWrites } from '@/lib/messageWriteQueue'

// Drops every per-thread entry the sibling stores keep for a deleted thread,
// so none of them outlives it (a tool grant for a gone thread would otherwise
// sit in the persisted record forever).
export const forgetThreadState = (threadId: string) => {
  // A message update still waiting to be written must not recreate the file.
  cancelPendingMessageWrites(threadId)
  useAgentMode.getState().removeThread(threadId)
  useChatSessions.getState().removeSession(threadId)
  useAppState.getState().clearThreadState(threadId)
  // The chat's model-setting overrides are keyed by thread id; left
  // behind they would sit in the record forever.
  useModelOverrides.getState().dropThread(threadId)
  useThreadToolGrants.getState().dropThread(threadId)
  // Persisted per-thread maps that otherwise grow by one entry per chat.
  useWorkProfiles.getState().dropScope(threadId)
  useWebSearchChoice.getState().dropScope(threadId)
  useToolApproval.getState().revokeThread(threadId)
  forgetDeadTools(threadId)
  forgetChatLoopGuard(threadId)
  forgetThreadStats(threadId)
}

// The selected thread id, or undefined when that thread was just deleted.
export const stillSelected = (
  currentThreadId: string | undefined,
  deletedIds: string[]
): string | undefined =>
  currentThreadId && deletedIds.includes(currentThreadId)
    ? undefined
    : currentThreadId

// Helper function to clean up vector DB collection for a thread
export const cleanupVectorDB = async (threadId: string) => {
  try {
    const vec = ExtensionManager.getInstance().get<VectorDBExtension>(
      ExtensionTypeEnum.VectorDB
    )
    if (vec?.deleteCollection) {
      // The extension adds the `attachments_` prefix itself.
      await vec.deleteCollection(threadId)
    }
  } catch (e) {
    console.warn(
      `[Threads] Failed to delete vector DB collection for thread ${threadId}:`,
      e
    )
  }
}

/**
 * Drops the thread's saved prompt cache in the local engine.
 *
 * Best-effort and fire-and-forget, like the vector DB cleanup above: the cache
 * is bounded by its own disk budget, so failing to reclaim one thread's share
 * is not worth failing the delete over.
 */
export const cleanupThreadCache = async (threadId: string) => {
  try {
    const { EngineManager } = await import('@janhq/core')
    const engine = EngineManager.instance().get('llamacpp') as
      | { forgetThreadCache?: (id: string) => Promise<number> }
      | undefined
    await engine?.forgetThreadCache?.(threadId)
  } catch (e) {
    console.warn(
      `[Threads] Failed to drop the saved prompt cache for thread ${threadId}:`,
      e
    )
  }
}

// Everything belonging to a thread that lives outside the thread store: its
// vector DB collection, its saved prompt cache, and its ephemeral agent
// sandbox. Fire-and-forget, since every caller runs inside a `set` reducer;
// each logs its own failures. An archived thread can be restored, so its
// attachments index and sandbox are kept unless the delete is permanent or
// the archive is off.
export const cleanupThreadArtifacts = (threadId: string, permanent?: boolean) => {
  void (async () => {
    if (!permanent && (await archiveEnabled())) return
    cleanupVectorDB(threadId)
    cleanupThreadWorkspace(threadId)
    // The chat's picture names (img_1 -> gallery id); the pictures stay in
    // the gallery.
    clearChatImages(threadId)
  })()
  cleanupThreadCache(threadId)
  // "Allow all temporarily" lasts only as long as its conversation.
  useToolApprovalRequests.getState().forgetTemporaryGit(threadId)
}

// The backend delete. It moves the thread to the archive (or destroys it when
// the archive is off or `permanent` is set), and removes the request records
// and scratch dir only when the thread is finally purged. Fire-and-forget from
// inside a reducer, so a failure is logged rather than thrown.
export const deleteThreadBackend = (
  threadId: string,
  permanent?: boolean
): Promise<void> => {
  const threads = getServiceHub().threads()
  const done = permanent
    ? threads.deleteThread(threadId, true)
    : threads.deleteThread(threadId)
  const tracked = trackArchiveWork(Promise.resolve(done))
  tracked.catch((e) =>
    console.warn(`[Threads] Failed to delete thread ${threadId}:`, e)
  )
  // The caller that wants the outcome (bulk delete) awaits this; the rest
  // ignore it, and the log above already covers them.
  return tracked
}
