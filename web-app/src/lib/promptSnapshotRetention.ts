import { invoke } from '@tauri-apps/api/core'

/**
 * Delete what the model was sent in one conversation. AH-078.
 *
 * Called when a Chat thread or a Cowork session is deleted, so a prompt
 * snapshot never outlives the conversation it records. Best effort and never
 * thrown: a failed cleanup must not stop the deletion the user asked for.
 * Outside Tauri there is nothing stored and this is a no-op.
 */
export async function deletePromptSnapshots(sessionId: string): Promise<void> {
  if (!sessionId) return
  try {
    await invoke('agent_prompt_snapshots_delete', { session: sessionId })
  } catch {
    // Reported by the backend; the conversation is still deleted.
  }
}
