/**
 * The renderer's side of a team's isolated children. AH-109.
 *
 * Each child that ran in a checkout of its own is recorded by the backend
 * (`core::agent::team_children`) when it starts and when it ends, and listed
 * from there -- after the run, and after a restart. The renderer names a
 * child by its parent session and task id and nothing else: where it worked,
 * its branch, its base commit and what it changed are all read back from Git.
 * Reviewing one makes an ordinary proposal, so applying it goes through the
 * same approval, hashes and conflict checks as any other.
 */
import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { errorText } from '@/lib/errorText'
import type { Outcome, ProposalRecord } from '@/lib/proposals'

export type ChildStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** As the review list shows it: `interrupted` is a `running` record from before a restart. */
export type ChildState = ChildStatus | 'interrupted'

export type ChildErrorKind =
  | 'unknown-child'
  | 'not-managed'
  | 'deleted'
  | 'corrupt'
  | 'branch-moved'
  | 'identity-changed'
  | 'link-escape'
  | 'modified-after-finish'
  | 'incomplete'
  | 'no-changes'
  | 'io'

export type ChildProblem = { kind: ChildErrorKind; message: string }

export type ParallelOverride = {
  tasks: string[]
  paths: string[]
  decidedAt: string
}

export type ChildFile = {
  path: string
  change: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  binary: boolean
}

export type ChildView = {
  ownerId: string
  parentSession: string
  run: string
  call: string
  taskId: string
  description: string
  agent: string
  worktreePath: string
  branch: string
  baseSha: string
  sourceRoot: string
  status: ChildStatus
  detail: string
  startedAt: string
  endedAt: string | null
  declaredWrites: string[]
  overrides: ParallelOverride[]
  state: ChildState
  files: ChildFile[]
  problem: ChildProblem | null
}

/**
 * Problems that leave nothing trustworthy to review. The rest -- an
 * unfinished child, a worktree changed since -- can be reviewed, but only
 * after the person has seen the warning and said so.
 */
export const UNREVIEWABLE: readonly ChildErrorKind[] = [
  'unknown-child',
  'not-managed',
  'deleted',
  'corrupt',
  'branch-moved',
  'identity-changed',
  'link-escape',
  'no-changes',
  'io',
]

export const needsAcknowledgement = (view: ChildView): boolean =>
  view.problem != null && !UNREVIEWABLE.includes(view.problem.kind)

export const reviewable = (view: ChildView): boolean =>
  view.state !== 'running' &&
  view.files.length > 0 &&
  (view.problem == null || !UNREVIEWABLE.includes(view.problem.kind))

export async function beginTeamChild(input: {
  parentSession: string
  taskId: string
  run: string
  call: string
  description: string
  agent: string
  project: string
  declaredWrites: string[]
  overrides: ParallelOverride[]
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await invoke('agent_team_child_begin', { input })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: messageOf(e) }
  }
}

export async function settleTeamChild(
  parentSession: string,
  taskId: string,
  status: Exclude<ChildStatus, 'running'>,
  detail: string
): Promise<void> {
  await invoke('agent_team_child_settle', {
    parentSession,
    taskId,
    status,
    detail,
  })
}

export async function listTeamChildren(
  project: string,
  session: string | null
): Promise<ChildView[]> {
  try {
    const found = await invoke<ChildView[]>('agent_team_children_list', {
      project,
      session,
    })
    return Array.isArray(found) ? found : []
  } catch {
    return []
  }
}

export async function proposeTeamChild(
  parentSession: string,
  taskId: string,
  acknowledge: boolean
): Promise<Outcome<{ proposal: ProposalRecord }> & { kind?: ChildErrorKind }> {
  try {
    const proposal = await invoke<ProposalRecord>('agent_team_child_propose', {
      parentSession,
      taskId,
      acknowledge,
    })
    return { ok: true, proposal }
  } catch (e) {
    const f = (e ?? {}) as { message?: unknown; kind?: ChildErrorKind }
    return {
      ok: false,
      message: typeof f.message === 'string' ? f.message : errorText(e),
      conflicts: [],
      ...(f.kind ? { kind: f.kind } : {}),
    }
  }
}

function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message)
  }
  return errorText(e)
}

/**
 * Bumped whenever a child starts or settles, so the review list re-reads
 * without polling. Not persisted: the list itself comes from disk.
 */
export const useTeamChildrenVersion = create<{
  version: number
  bump: () => void
}>()((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))
