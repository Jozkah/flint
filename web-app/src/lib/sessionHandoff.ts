/**
 * Handing a session to another computer. AH-210.
 *
 * Builds on the session export (AH-203): the same file, the same redaction,
 * plus what the other machine needs to *continue* rather than only read --
 * which folder the session worked in and which model it used -- described in
 * terms that mean something there. The folder is named, never located: its
 * name, and the branch and commit it was on. The model is its provider's name
 * and the model id, never a key or an endpoint.
 *
 * On import, what could not be restored is said plainly, item by item: the
 * folder has to be attached again (and is checked against what the session
 * was on), the model or its provider may not exist on this machine. The
 * session is created either way; nothing is resumed into a state that cannot
 * work without the user being told.
 */
import { invoke } from '@tauri-apps/api/core'
import type { SessionBundle } from '@/lib/sessionBundle'
import { errorText } from '@/lib/errorText'
import { i18n } from '@/i18n/react-i18next-compat'

/** A folder as another machine can recognise it. */
export type FolderIdentity = {
  name: string
  branch?: string | null
  head?: string | null
}

export type HandoffInfo = {
  /** Present when the session had a folder attached. */
  folder: FolderIdentity | null
  model: { provider: string; id: string } | null
}

export type HandoffBundle = SessionBundle & { handoff?: HandoffInfo }

export type ProviderView = {
  provider: string
  models: { id: string }[]
  /** Whether it can be used on this machine at all. */
  usable: boolean
}

/** One thing that could not be carried over, or needs the user. */
export type RestoreItem =
  | { kind: 'folder'; expected: FolderIdentity }
  | { kind: 'provider'; provider: string }
  | { kind: 'model'; provider: string; id: string }

export type HandoffRecord = {
  info: HandoffInfo
  /** What the import could not restore, at the time it was imported. */
  unrestored: RestoreItem[]
  /** The user has read the notice and put it away. */
  dismissed?: boolean
}

/** What an import of `info` cannot restore on a machine with `providers`. */
export function restoreReport(
  info: HandoffInfo,
  providers: ProviderView[]
): RestoreItem[] {
  const out: RestoreItem[] = []
  // A folder is never attached for the user: which one, on this machine, is
  // theirs to say. So it is always something to do.
  if (info.folder) out.push({ kind: 'folder', expected: info.folder })
  if (info.model) {
    const provider = providers.find((p) => p.provider === info.model!.provider)
    if (!provider || !provider.usable) {
      out.push({ kind: 'provider', provider: info.model.provider })
    } else if (!provider.models.some((m) => m.id === info.model!.id)) {
      out.push({
        kind: 'model',
        provider: info.model.provider,
        id: info.model.id,
      })
    }
  }
  return out
}

/** A restore item, said plainly. */
export function describeRestoreItem(item: RestoreItem): string {
  switch (item.kind) {
    case 'folder': {
      const { name, branch, head } = item.expected
      const commit = head ? head.slice(0, 12) : null
      const at =
        branch && commit
          ? i18n.t('common:handoff.restore.atBranchCommit', { branch, commit })
          : branch
            ? i18n.t('common:handoff.restore.atBranch', { branch })
            : commit
              ? i18n.t('common:handoff.restore.atCommit', { commit })
              : null
      return at
        ? i18n.t('common:handoff.restore.folderAt', { name, at })
        : i18n.t('common:handoff.restore.folder', { name })
    }
    case 'provider':
      return i18n.t('common:handoff.restore.provider', {
        provider: item.provider,
      })
    case 'model':
      return i18n.t('common:handoff.restore.model', {
        id: item.id,
        provider: item.provider,
      })
  }
}

export type FolderMatch =
  | { matches: true }
  | { matches: false; differences: string[] }

/** Is the attached folder the one the session worked in? */
export function compareFolder(
  expected: FolderIdentity,
  actual: FolderIdentity
): FolderMatch {
  const differences: string[] = []
  if (expected.name !== actual.name) {
    differences.push(
      i18n.t('common:handoff.differs.name', {
        actual: actual.name,
        expected: expected.name,
      })
    )
  }
  if (expected.branch && expected.branch !== actual.branch) {
    differences.push(
      actual.branch
        ? i18n.t('common:handoff.differs.branch', {
            actual: actual.branch,
            expected: expected.branch,
          })
        : i18n.t('common:handoff.differs.noBranch', {
            expected: expected.branch,
          })
    )
  }
  if (expected.head && expected.head !== actual.head) {
    const want = expected.head.slice(0, 12)
    differences.push(
      actual.head
        ? i18n.t('common:handoff.differs.head', {
            actual: actual.head.slice(0, 12),
            expected: want,
          })
        : i18n.t('common:handoff.differs.noHead', { expected: want })
    )
  }
  return differences.length
    ? { matches: false, differences }
    : { matches: true }
}

export type HandoffOutcome =
  | { ok: true; path: string; redactions: number }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string }

/**
 * Save a handoff. The folder's path goes to the backend only so it can work
 * out the folder's identity and take the path out of everything written; it
 * is never written itself.
 */
export async function exportHandoff(
  bundle: SessionBundle,
  model: HandoffInfo['model'],
  folder: string | null
): Promise<HandoffOutcome> {
  try {
    const report = await invoke<{ path: string; redactions: number } | null>(
      'session_handoff_save',
      { bundle: { ...bundle, handoff: { folder: null, model } }, folder }
    )
    if (!report) return { ok: false, cancelled: true }
    return { ok: true, path: report.path, redactions: report.redactions }
  } catch (e) {
    return { ok: false, cancelled: false, message: errorText(e) }
  }
}

/** The identity of a folder attached on this machine, to compare. */
export async function folderIdentity(folder: string): Promise<FolderIdentity> {
  return await invoke<FolderIdentity>('session_folder_identity', { folder })
}
