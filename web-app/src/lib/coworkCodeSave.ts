/**
 * Saving a hand edit from the Code panel.
 *
 * Deliberately the agent's own `write` tool, called through the same backend
 * command with the session's scope, read roots and live write grant. That is
 * what makes a user save exactly as confined as an agent write: the backend's
 * gate decides whether the path is inside an allowed root, and refuses it
 * otherwise. The change is journaled against its own undo run with the user
 * as its actor, so Changes and undo attribute it to the person.
 */
import { executeAgentTool } from '@/lib/agentTools'
import type { EditTarget } from '@/lib/coworkCodeEdit'

export type WritableTarget = Extract<EditTarget, { kind: 'real' | 'sandbox' }>

export type SaveOutcome =
  | { ok: true; diff?: string }
  | { ok: false; error: string }

export type SaveUserEdit = (input: {
  sessionId: string
  target: WritableTarget
  content: string
  /** The folder the session reads, as the agent's calls pass it. */
  readRoot: string | null
  extraFolders?: readonly string[]
}) => Promise<SaveOutcome>

let sequence = 0

/** A fresh undo run per save, so each save can be undone on its own. */
export const userEditRunId = (now = Date.now()): string =>
  `user-edit-${now.toString(36)}-${(sequence++).toString(36)}`

export const saveUserEdit: SaveUserEdit = async ({
  sessionId,
  target,
  content,
  readRoot,
  extraFolders,
}) => {
  const result = await executeAgentTool(
    'write',
    { path: target.path, content },
    sessionId,
    {
      scope: 'session',
      readOnlyProject: readRoot,
      extraProjects: extraFolders,
      // Only a real-tree save carries the grant. A sandbox save has none, so
      // even a path that happened to name the folder could not reach it.
      writeGrant: target.kind === 'real' ? target.grant : null,
      undoRun: userEditRunId(),
      actor: { id: 'user', label: 'You' },
    }
  )
  if (result.error !== undefined) return { ok: false, error: result.error }
  return { ok: true, diff: result.diff }
}
