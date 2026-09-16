import {
  workspacePath,
  memoryList,
  memoryRead,
  memoryWrite,
  memoryDelete,
} from '@janhq/tauri-plugin-agent-tools-api'
import { invoke } from '@tauri-apps/api/core'
import { getServiceHub } from '@/hooks/useServiceHub'
import * as skillStore from '@/lib/skillStore'
import type { SkillMeta } from '@/lib/skillStore'

export type { SkillMeta }

/**
 * The management surface over the agent's permanent store, for the settings UI.
 * Separate from `agentTools.ts`, which is the chat-loop surface: this one edits
 * what the agent remembers, that one executes what the model calls.
 *
 * Errors are thrown rather than swallowed. Unlike a tool call, a failed edit has
 * a user waiting on it, so the page surfaces it.
 */

const dataFolder = async (): Promise<string> => {
  const folder = await getServiceHub().app().getJanDataFolder()
  if (!folder) throw new Error('Flint data folder is unavailable')
  return folder
}

/** Path of the permanent store, created if absent. */
export async function storePath(): Promise<string> {
  return await workspacePath(await dataFolder())
}

// Skill CRUD is shared with the code screen's per-project skills; only the root
// differs. These bind this page to the permanent store.
export const listSkills = () => skillStore.listSkills(skillStore.storeScope)
export const readSkill = (name: string) =>
  skillStore.readSkill(skillStore.storeScope, name)
export const writeSkill = (name: string, content: string) =>
  skillStore.writeSkill(skillStore.storeScope, name, content)
export const deleteSkill = (name: string) =>
  skillStore.deleteSkill(skillStore.storeScope, name)

export async function listMemories(): Promise<string[]> {
  return await memoryList(await dataFolder())
}

export async function readMemory(name: string): Promise<string> {
  return await memoryRead(await dataFolder(), name)
}

export async function writeMemory(name: string, content: string): Promise<void> {
  await memoryWrite(await dataFolder(), name, content)
}

export async function deleteMemory(name: string): Promise<void> {
  await memoryDelete(await dataFolder(), name)
}

/** Open the store in the OS file manager. */
export async function revealStore(): Promise<void> {
  await getServiceHub().opener().openPath(await storePath())
}

/**
 * The summary the `consolidate_memory` command returns. Mirrors the Rust
 * `ConsolidationOutcome` (serde `camelCase`).
 */
export interface ConsolidationOutcome {
  /** Whether a consolidation actually ran and wrote output. */
  ran: boolean
  /** "ok" when it ran, otherwise the skip reason (disabled / not idle /
   * nothing new / busy). */
  reason: string
  notesRead: number
  factsIn: number
  factsOut: number
  conflictsResolved: number
  secretsFiltered: number
  bytesWritten: number
}

/**
 * Idle-time memory consolidation ("autoDream").
 *
 * The backend is the real gate: it is off unless the store's config enabled it,
 * and it enforces the cross-process lock, path safety and atomic write whatever
 * the caller passes. `manual = true` (the user pressing "run now") bypasses the
 * enabled/idle gates only; `manual = false` is the idle poller's auto path.
 * `idleSecs` is the inactivity threshold the caller has been observing.
 */
export async function consolidateMemory(
  idleSecs: number,
  manual: boolean
): Promise<ConsolidationOutcome> {
  return await invoke<ConsolidationOutcome>('consolidate_memory', {
    idleSecs,
    manual,
  })
}
