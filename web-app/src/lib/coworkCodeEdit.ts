/**
 * Hand edits in the Cowork Code panel: where a save goes, and what the editor
 * holds between saves.
 *
 * A save never picks its own destination or checks its own authority. It is a
 * `write` tool call made through the same backend command the agent's `write`
 * uses, under the session's live write grant, so the backend applies exactly
 * the confinement it applies to the agent: a path outside every allowed root
 * is refused there, whatever this module computed. The plan below only
 * decides which of the two legal places the session writes to -- the real
 * tree (Edit this folder / managed worktree) or the session sandbox (Review
 * only) -- and refuses up front what no mode could write.
 */
import type { WriteDestination } from '@/lib/coworkReadiness'
import { tabId, type CodeTab } from '@/lib/coworkCode'

/** Why a file cannot be edited here. Each has its own sentence in the UI. */
export type ReadOnlyReason =
  /** Opened from outside every root: there is no path to write back to. */
  | 'external'
  /** The project it came from is no longer attached. */
  | 'detached'
  /** A sandbox tab from another session. */
  | 'other-session'
  /** The session's roots have not resolved yet. */
  | 'pending'
  /** The mode writes the real tree but no live grant backs it. */
  | 'no-grant'

export type EditTarget =
  | {
      kind: 'real'
      /** Absolute path in the tree the session writes. */
      path: string
      /** The opaque grant the backend resolves against the session. */
      grant: string
    }
  | {
      kind: 'sandbox'
      /** Relative to the session sandbox, the way the agent's writes are. */
      path: string
    }
  | { kind: 'read-only'; reason: ReadOnlyReason }

export type EditAccess = {
  /** Where this session's mutations land. */
  destination: WriteDestination
  /** The live grant, when the session holds one. Never shown anywhere. */
  writeGrant: string | null
}

const joinPath = (root: string, rel: string): string => {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const trimmed = root.replace(/[\\/]+$/, '')
  const parts = rel.replace(/^[\\/]+/, '').split('/').join(sep)
  return `${trimmed}${sep}${parts}`
}

/**
 * Where saving `tab` writes, or why it cannot.
 *
 * `treeRoot` is the tree project tabs are read from (the worktree in a
 * managed session, the attached folder otherwise), so a save lands in the
 * same file the tab shows.
 */
export function planUserWrite(input: {
  tab: CodeTab
  projectKey: string | null
  treeRoot: string | null
  sessionKey: string | null
  access: EditAccess | null | undefined
}): EditTarget {
  const { tab, projectKey, treeRoot, sessionKey, access } = input
  switch (tab.origin.kind) {
    case 'external':
      return { kind: 'read-only', reason: 'external' }
    case 'sandbox':
    case 'artifact':
      if (tab.origin.sessionKey !== sessionKey) {
        return { kind: 'read-only', reason: 'other-session' }
      }
      // The sandbox is always the session's own to write, in every mode.
      return { kind: 'sandbox', path: tab.path }
    case 'project': {
      if (!treeRoot || tab.origin.projectKey !== projectKey) {
        return { kind: 'read-only', reason: 'detached' }
      }
      if (!access) return { kind: 'read-only', reason: 'pending' }
      if (access.destination === 'sandbox') {
        // Review only: the change goes where the agent's would, a copy under
        // the same relative path in the sandbox, which Changes offers to
        // apply to the folder.
        return { kind: 'sandbox', path: tab.path }
      }
      if (!access.writeGrant) return { kind: 'read-only', reason: 'no-grant' }
      return {
        kind: 'real',
        path: joinPath(treeRoot, tab.path),
        grant: access.writeGrant,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/**
 * One tab's editor state.
 *
 * `base` is what the file held when it was last read or saved; `text` is what
 * the editor holds. The tab is dirty exactly when they differ, so typing a
 * change and typing it back is clean again, the way VS Code treats it.
 */
export type EditBuffer = {
  base: string
  text: string
}

export type Buffers = Record<string, EditBuffer>

export const isDirty = (buffer: EditBuffer | undefined): boolean =>
  !!buffer && buffer.text !== buffer.base

export function editBuffer(
  buffers: Buffers,
  tab: CodeTab,
  base: string,
  text: string
): Buffers {
  return { ...buffers, [tabId(tab)]: { base, text } }
}

/** Throw the edits away: the buffer goes back to what was read. */
export function discardBuffer(buffers: Buffers, id: string): Buffers {
  const buffer = buffers[id]
  if (!buffer) return buffers
  return { ...buffers, [id]: { base: buffer.base, text: buffer.base } }
}

/** After a save: what was written is now the base. */
export function markSaved(buffers: Buffers, id: string, saved: string): Buffers {
  const buffer = buffers[id]
  return {
    ...buffers,
    [id]: { base: saved, text: buffer && buffer.text !== saved ? buffer.text : saved },
  }
}

export function dropBuffer(buffers: Buffers, id: string): Buffers {
  if (!(id in buffers)) return buffers
  const next = { ...buffers }
  delete next[id]
  return next
}

/**
 * What to do when the file on disk is read again.
 *
 * - `unchanged`: disk still holds the base.
 * - `refresh`: it changed and nothing is unsaved; take the new bytes.
 * - `conflict`: it changed under unsaved edits; the user decides.
 */
export type DiskCheck = 'unchanged' | 'refresh' | 'conflict'

export function checkDisk(
  buffer: EditBuffer | undefined,
  disk: string
): DiskCheck {
  if (!buffer || buffer.base === disk) return 'unchanged'
  return isDirty(buffer) ? 'conflict' : 'refresh'
}

// ---------------------------------------------------------------------------
// Telling the agent
// ---------------------------------------------------------------------------

/**
 * The line added to the model's copy of the next message after the user has
 * edited files by hand, so the agent re-reads them instead of trusting what it
 * last saw. Paths only: the content is on disk for it to read.
 */
export function userEditNotice(
  edits: readonly { path: string; where: 'real' | 'sandbox' }[]
): string {
  if (edits.length === 0) return ''
  const seen = new Set<string>()
  const lines: string[] = []
  for (const edit of edits) {
    const key = `${edit.where}:${edit.path}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(
      `- ${edit.path}${edit.where === 'sandbox' ? ' (the copy in your session workspace)' : ''}`
    )
  }
  return [
    'Since your last turn the user edited these files by hand. Re-read them before relying on what you saw earlier:',
    ...lines,
  ].join('\n')
}

/** The model's copy of a prompt with the notice appended, when there is one. */
export function withUserEditNotice(
  text: string,
  edits: readonly { path: string; where: 'real' | 'sandbox' }[]
): string {
  const notice = userEditNotice(edits)
  if (!notice) return text
  return text ? `${text}\n\n${notice}` : notice
}
