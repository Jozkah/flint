/**
 * Proposed changes: the renderer's side of AH-146/147/148/109.
 *
 * The renderer never carries file content to the backend. It asks for a
 * proposal to be made from a worktree, shows what the backend stored, and
 * sends back an approval made only of ids and hashes. Building the result,
 * checking the destination and writing files all happen in Rust
 * (`tauri_plugin_agent_tools::proposal`), which is why nothing here can add a
 * line to what lands.
 */
import { invoke } from '@tauri-apps/api/core'
import { errorText } from '@/lib/errorText'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'

/** Mirrors `proposal::ProposalScope`. */
export type ProposalScope = {
  session: string
  run: string
  call: string
  invocation: string
  agent: string
  subject: string
  project: string
  worktree: string
}

export type ProposedHunk = {
  id: string
  oldStart: number
  oldLen: number
  newStart: number
  newLen: number
  removed: string[]
  added: string[]
}

/** Mirrors `review_flags::ReviewFlag` (AH-154/155/156). */
export type ReviewFlag = {
  kind: 'dependency' | 'lockfile' | 'migration'
  summary: string
  details: string[]
}

export type ProposedFile = {
  path: string
  change: 'added' | 'modified' | 'deleted'
  baseBlob: string | null
  proposedBlob: string | null
  binary: boolean
  oversized: boolean
  sensitive: boolean
  additions: number
  deletions: number
  hunks: ProposedHunk[]
  /** Worked out by the backend; absent when there are none. */
  flags?: ReviewFlag[]
}

export const flagsOf = (file: ProposedFile): ReviewFlag[] => file.flags ?? []

export type ProposalState =
  | 'pending'
  | 'applied'
  | 'partially-applied'
  | 'rejected'

export type ProposalRecord = {
  schemaVersion: number
  id: string
  scope: ProposalScope
  baseCommit: string
  files: ProposedFile[]
  patchHash: string
  baseStateHash: string
  createdAt: string
  state: ProposalState
  history: { at: string; event: string; detail: string }[]
}

export type HunkChoice = { kind: 'all' } | { kind: 'only'; ids: string[] }

export type Approval = {
  proposalId: string
  patchHash: string
  baseStateHash: string
  scope: ProposalScope
  files: { path: string; hunks: HunkChoice }[]
  /** Flagged files the person marked as reviewed. */
  acknowledged: string[]
}

export type Conflict = { path: string; hunk: string; reason: string }

export type ProposalFailure = {
  message: string
  conflicts: Conflict[]
  /** Flagged files the backend refused because they were not acknowledged. */
  unacknowledged?: string[]
}

export type Outcome<T> = ({ ok: true } & T) | ({ ok: false } & ProposalFailure)

const failure = (e: unknown): ProposalFailure => {
  if (e && typeof e === 'object' && 'message' in e) {
    const f = e as Partial<ProposalFailure>
    return {
      message: String(f.message ?? ''),
      conflicts: Array.isArray(f.conflicts) ? f.conflicts : [],
      ...(Array.isArray(f.unacknowledged) && f.unacknowledged.length
        ? { unacknowledged: f.unacknowledged }
        : {}),
    }
  }
  return { message: errorText(e), conflicts: [] }
}

/**
 * What the person selected, as the backend expects it.
 *
 * `selected` maps a file path to the hunk ids chosen in it. A file whose hunks
 * are all chosen is sent as `all`; a file with none chosen is left out, which
 * the backend reads as rejected. Binary and oversized files have no hunks and
 * are decided whole: present in `selected` means approved.
 */
export function approvalFor(
  record: ProposalRecord,
  selected: Record<string, string[]>,
  acknowledged: string[] = []
): Approval {
  const files: Approval['files'] = []
  for (const file of record.files) {
    const ids = selected[file.path]
    if (!ids) continue
    if (file.hunks.length === 0) {
      files.push({ path: file.path, hunks: { kind: 'all' } })
      continue
    }
    const chosen = file.hunks.filter((h) => ids.includes(h.id)).map((h) => h.id)
    if (chosen.length === 0) continue
    files.push({
      path: file.path,
      hunks:
        chosen.length === file.hunks.length
          ? { kind: 'all' }
          : { kind: 'only', ids: chosen },
    })
  }
  return {
    proposalId: record.id,
    patchHash: record.patchHash,
    baseStateHash: record.baseStateHash,
    scope: record.scope,
    files,
    // Only files that are selected and flagged: an acknowledgement is about a
    // change being applied, not a blanket permission.
    acknowledged: files
      .map((f) => f.path)
      .filter(
        (p) =>
          acknowledged.includes(p) &&
          flagsOf(record.files.find((f) => f.path === p)!).length > 0
      ),
  }
}

/** Selected files with a flag not yet marked as reviewed. */
export function unacknowledgedSelection(
  record: ProposalRecord,
  selected: Record<string, string[]>,
  acknowledged: string[]
): string[] {
  return approvalFor(record, selected, acknowledged)
    .files.map((f) => f.path)
    .filter(
      (p) =>
        flagsOf(record.files.find((f) => f.path === p)!).length > 0 &&
        !acknowledged.includes(p)
    )
}

/** Everything selected except what can never be applied. */
export function defaultSelection(
  record: ProposalRecord
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const file of record.files) {
    if (file.sensitive) continue
    out[file.path] = file.hunks.map((h) => h.id)
  }
  return out
}

export async function proposeFromWorktree(input: {
  record: WorktreeRecord
  session: string
  run?: string
  agent?: string
}): Promise<Outcome<{ proposal: ProposalRecord }>> {
  try {
    const proposal = await invoke<ProposalRecord>(
      'agent_proposal_from_worktree',
      {
        record: input.record,
        session: input.session,
        run: input.run ?? null,
        agent: input.agent ?? null,
      }
    )
    return { ok: true, proposal }
  } catch (e) {
    return { ok: false, ...failure(e) }
  }
}

export async function listProposals(
  project: string
): Promise<ProposalRecord[]> {
  try {
    const found = await invoke<ProposalRecord[]>('agent_proposal_list', {
      project,
    })
    return Array.isArray(found) ? found : []
  } catch {
    return []
  }
}

export async function applyProposal(
  approval: Approval
): Promise<Outcome<{ state: ProposalState; filesWritten: number }>> {
  try {
    const report = await invoke<{
      proposalId: string
      state: ProposalState
      filesWritten: number
    }>('agent_proposal_apply', { approval })
    return { ok: true, state: report.state, filesWritten: report.filesWritten }
  } catch (e) {
    return { ok: false, ...failure(e) }
  }
}

export async function rejectProposal(
  record: ProposalRecord
): Promise<Outcome<Record<never, never>>> {
  try {
    await invoke('agent_proposal_reject', {
      id: record.id,
      scope: record.scope,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, ...failure(e) }
  }
}
