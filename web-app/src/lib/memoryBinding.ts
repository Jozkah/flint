/**
 * Which memories a conversation may use: its project, and whether it is
 * temporary.
 *
 * Jan's sidebar projects have no folder, so their memory identity is the
 * project id itself, which the backend namespaces as `jan-project:<id>` and
 * accepts only from renderer memory commands (never from a model's tool
 * arguments). A Cowork session attached to a folder uses the folder instead;
 * when both are known the folder wins, in the backend.
 *
 * The binding is read at send time. A chat moved to another project, or whose
 * project was deleted, uses the new scope for its next request; a request
 * already under way keeps the selection it retrieved.
 */
import type {
  MemoryLocation,
  MemoryRetrieved,
} from '@janhq/tauri-plugin-agent-tools-api'
import { invoke } from '@tauri-apps/api/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

/** Mirrors the backend's `JAN_PROJECT_PREFIX`. */
export const JAN_PROJECT_PREFIX = 'jan-project:'

export type MemoryBinding = {
  /** A project folder (Cowork). Takes precedence in the backend. */
  projectRoot?: string
  /** A Jan workspace project, for a conversation with no folder. */
  janProjectId?: string
  /** For display only; never sent as identity. */
  janProjectName?: string
  temporary: boolean
}

/**
 * `MemoryLocation` with the workspace project.
 *
 * Declared here as well as in the plugin's guest bindings so this module does
 * not depend on the plugin's built declaration files being current.
 */
export type ScopedMemoryLocation = MemoryLocation & { janProjectId?: string }

/** What `memory_retrieve` returns, including the fields the panel reads. */
export type ScopedMemoryRetrieved = MemoryRetrieved & {
  candidateIds?: string[]
  projectId?: string | null
  disabled?: boolean
}

type ThreadLike = {
  metadata?: { project?: { id?: string; name?: string } | undefined } | null
}

/** The binding for an ordinary chat thread. */
export function chatMemoryBinding(
  threadId: string | undefined,
  thread: ThreadLike | undefined
): MemoryBinding {
  const temporary = threadId === TEMPORARY_CHAT_ID
  const project = thread?.metadata?.project
  // A temporary chat reads nothing, so it is not bound to a project even if
  // one is set: there is nothing a project scope could add to "nothing".
  if (temporary || !project?.id) return { temporary }
  return {
    temporary,
    janProjectId: project.id,
    janProjectName: project.name,
  }
}

/** The backend identity a binding resolves to, when it is a workspace project. */
export function workspaceProjectIdentity(
  binding: Pick<MemoryBinding, 'janProjectId' | 'projectRoot'>
): string | null {
  if (binding.projectRoot) return null
  return binding.janProjectId ? `${JAN_PROJECT_PREFIX}${binding.janProjectId}` : null
}

/** The raw Jan project id inside a namespaced identity, if it is one. */
export function janProjectIdOf(identity: string | null | undefined): string | undefined {
  return identity?.startsWith(JAN_PROJECT_PREFIX)
    ? identity.slice(JAN_PROJECT_PREFIX.length)
    : undefined
}

export function memoryLocation(
  dataFolder: string,
  binding: Omit<MemoryBinding, 'temporary'>,
  sessionId?: string
): ScopedMemoryLocation {
  return {
    dataFolder,
    ...(binding.projectRoot ? { projectRoot: binding.projectRoot } : {}),
    ...(binding.janProjectId ? { janProjectId: binding.janProjectId } : {}),
    ...(sessionId ? { sessionId } : {}),
  }
}

/**
 * Turn memory in requests on or off. The backend changes only this switch and
 * leaves automatic saving as it was.
 */
export async function setMemoryEnabled(
  location: ScopedMemoryLocation,
  memoryEnabled: boolean
): Promise<{ automaticallySave: boolean; memoryEnabled: boolean }> {
  return await invoke('plugin:agent-tools|memory_settings_update', {
    location,
    memoryEnabled,
  })
}
