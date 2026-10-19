/**
 * Typed client for shared-folder coordination: several sessions working in one
 * folder (docs/superpowers/specs/2026-10-19-shared-folder-coordination-design.md).
 *
 * The backend registry is the source of truth. Everything here mirrors the
 * serde(rename_all = "camelCase") structs in
 * src-tauri/plugins/tauri-plugin-agent-tools/src/shared_folder/view.rs.
 */
import { invoke } from '@tauri-apps/api/core'
import { dataFolder } from '@/lib/sessionMailbox'

/** Emitted after a session joins or leaves a folder, a claim or hold changes, or a branch moves. */
export const SHARED_FOLDER_UPDATED_EVENT = 'agent-shared-folder-updated'

export type SharedFolderUpdatedPayload = {
  folderKey: string | null
  sessionId: string
  reason:
    | 'registered'
    | 'left'
    | 'state'
    | 'claim'
    | 'held'
    | 'branch'
    | 'allow'
}

export type SharedRecentFile = {
  /** Relative to the folder when inside it. */
  path: string
  at: number
}

export type SharedPeer = {
  sessionId: string
  displayName: string
  status: 'running' | 'idle' | 'unavailable'
  waitingApproval: boolean
  access: string | null
  /** In its own worktree or copy: awareness only, never held. */
  isolated: boolean
  /** The branch the shared tree is on; null for an isolated session. */
  branch: string | null
  startBranch: string | null
  startHead: string | null
  lastActivity: number
  recentFiles: SharedRecentFile[]
  /** Files it holds a claim on right now. */
  claims: string[]
}

export type SharedHeld = {
  kind: 'edit' | 'git'
  /** The relative file for an edit, the git operation for git. */
  target: string
  ownerId: string
  ownerName: string
  at: number
}

export type SharedAllowScope = 'edit' | 'git' | 'all'

export type SharedFolderView = {
  folderKey: string
  folder: string | null
  git: boolean
  branch: string | null
  you: SharedPeer
  others: SharedPeer[]
  holds: SharedHeld[]
  allowances: { scope: SharedAllowScope; until: number }[]
}

export type SharedFolderGroup = {
  folderKey: string
  folder: string | null
  git: boolean
  sessions: SharedPeer[]
}

export type IsolationReason =
  | 'fork'
  | 'secondSession'
  | 'notGit'
  | 'alone'
  | 'alreadyIsolated'
  | 'userChoseShared'

export type IsolationDecision = { isolate: boolean; reason: IsolationReason }

const PLUGIN = 'plugin:agent-tools|'

async function call<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  return invoke<T>(`${PLUGIN}${command}`, {
    dataFolder: await dataFolder(),
    ...args,
  })
}

export const sharedFolder = {
  /** Who else is in this session's folder; null when it has no folder. */
  peers: (sessionId: string) =>
    call<SharedFolderView | null>('shared_folder_peers', { sessionId }),

  /** Folders with two or more live sessions (the sidebar mark). */
  overview: () => call<SharedFolderGroup[]>('shared_folder_overview', {}),

  /** Files a session changed lately, newest first. */
  recentEdits: (sessionId: string, windowSecs?: number) =>
    call<SharedRecentFile[]>('shared_folder_recent_edits', {
      sessionId,
      windowSecs: windowSecs ?? null,
    }),

  /**
   * "Allow this session to edit anyway". `minutes` defaults to 30 (at most
   * 240); 0 withdraws. Resolves to the expiry in epoch ms, or null.
   */
  allow: (sessionId: string, scope: SharedAllowScope, minutes?: number) =>
    call<number | null>('shared_folder_allow', {
      sessionId,
      scope,
      minutes: minutes ?? null,
    }),

  /** Should a session in `folder` start in its own worktree? */
  defaultIsolation: (input: {
    folder: string
    sessionId?: string | null
    isFork?: boolean
    userChoseShared?: boolean
  }) =>
    call<IsolationDecision>('shared_folder_default_isolation', {
      folder: input.folder,
      sessionId: input.sessionId ?? null,
      isFork: input.isFork ?? false,
      userChoseShared: input.userChoseShared ?? false,
    }),
}
