/**
 * Importing an exported worktree bundle into the attached project. AH-169.
 *
 * The backend (`core::agent::bundle_import`) reads the bundle as hostile
 * input, rebuilds its changes against the project's own copy of the base
 * commit and stores them as an ordinary proposal. This side names the bundle
 * folder and the destination, shows what came back, and sends an approval
 * bound to that import: its bundle and manifest hashes and the destination,
 * all of which the backend checks again before anything is written.
 */
import { invoke } from '@tauri-apps/api/core'
import { errorText } from '@/lib/errorText'
import type {
  Approval,
  Conflict,
  Outcome,
  ProposalRecord,
  ProposalState,
} from '@/lib/proposals'

export type ImportErrorKind =
  | 'unsupported-container'
  | 'unsupported-version'
  | 'manifest-invalid'
  | 'entry-missing'
  | 'entry-extra'
  | 'entry-link'
  | 'hash-mismatch'
  | 'too-large'
  | 'path-refused'
  | 'path-collision'
  | 'patch-invalid'
  | 'destination-invalid'
  | 'base-missing'
  | 'destination-changed'
  | 'already-applied'
  | 'approval-mismatch'
  | 'not-found'
  | 'cancelled'
  | 'io'
  | 'refused'

export type ImportState =
  | 'pending'
  | 'applied'
  | 'partially-applied'
  | 'rejected'
  | 'abandoned'

export type ImportView = {
  schemaVersion: number
  id: string
  bundleSchema: number
  bundleSha256: string
  manifestSha256: string
  patchSha256: string
  originRepository: string
  branch: string
  baseSha: string
  headSha: string
  exportedAt: string
  destination: string
  destinationFirstCommit: string | null
  proposalId: string
  state: ImportState
  createdAt: string
  endedAt: string | null
  files: { path: string; change: string; whole: boolean }[]
  proposal: ProposalRecord | null
}

export type ImportFailure = {
  kind: ImportErrorKind
  message: string
  conflicts: Conflict[]
  unacknowledged?: string[]
}

const failureOf = (e: unknown): ImportFailure => {
  const f = (e ?? {}) as {
    kind?: ImportErrorKind
    message?: unknown
    conflicts?: Conflict[] | null
    unacknowledged?: string[]
  }
  return {
    kind: f.kind ?? 'io',
    message: typeof f.message === 'string' ? f.message : errorText(e),
    conflicts: Array.isArray(f.conflicts) ? f.conflicts : [],
    ...(Array.isArray(f.unacknowledged) && f.unacknowledged.length
      ? { unacknowledged: f.unacknowledged }
      : {}),
  }
}

export const newImportToken = () =>
  `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export async function importBundle(
  token: string,
  bundle: string,
  destination: string
): Promise<({ ok: true } & ImportView) | ({ ok: false } & ImportFailure)> {
  try {
    const view = await invoke<ImportView>('agent_bundle_import', {
      token,
      bundle,
      destination,
    })
    return { ok: true, ...view }
  } catch (e) {
    return { ok: false, ...failureOf(e) }
  }
}

export async function cancelImport(token: string): Promise<boolean> {
  try {
    return await invoke<boolean>('agent_bundle_import_cancel', { token })
  } catch {
    return false
  }
}

export async function listImports(destination: string): Promise<ImportView[]> {
  try {
    const found = await invoke<ImportView[]>('agent_bundle_imports_list', {
      destination,
    })
    return Array.isArray(found) ? found : []
  } catch {
    return []
  }
}

/** Apply a reviewed import; the approval is bound to that import. */
export async function applyImport(
  view: ImportView,
  approval: Approval
): Promise<
  Outcome<{ state: ProposalState; filesWritten: number }> & {
    kind?: ImportErrorKind
  }
> {
  try {
    const report = await invoke<{ state: ProposalState; filesWritten: number }>(
      'agent_bundle_apply',
      {
        approval: {
          importId: view.id,
          bundleSha256: view.bundleSha256,
          manifestSha256: view.manifestSha256,
          destination: view.destination,
          approval,
        },
      }
    )
    return { ok: true, state: report.state, filesWritten: report.filesWritten }
  } catch (e) {
    const f = failureOf(e)
    return {
      ok: false,
      message: f.message,
      conflicts: f.conflicts,
      kind: f.kind,
      ...(f.unacknowledged ? { unacknowledged: f.unacknowledged } : {}),
    }
  }
}

export async function abandonImport(id: string): Promise<void> {
  await invoke('agent_bundle_abandon', { id })
}
