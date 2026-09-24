/**
 * Where a Cowork run may write, kept separate from how freely it may act.
 *
 * These are two questions that kept being answered as one. "Autonomous" said
 * how often Flint stops to ask; it never said whether the thing it was about to
 * change was the user's checkout, and conflating them means granting one
 * grants the other. So the run mode stays what it was, and the access mode is
 * its own choice with its own default.
 *
 * The default is the safe one and stays the safe one: a session that has never
 * been told otherwise — including every session saved before this existed —
 * may read a repository and write nothing but its own sandbox.
 */

import type { CoworkMode } from '@/lib/coworkMode'
import { isReadOnly } from '@/lib/coworkMode'
import type { Binding, WriteDestination } from '@/lib/coworkReadiness'

export type AccessMode =
  /** Read the repository; everything produced lands in the session sandbox. */
  | 'review-only'
  /** Read and write an isolated worktree, leaving the checkout alone. */
  | 'managed-worktree'
  /** Read and write the picker-selected folder itself. */
  | 'edit-folder'

export const ACCESS_MODES: readonly AccessMode[] = [
  'review-only',
  'managed-worktree',
  'edit-folder',
]

export const accessLabelKey = (access: AccessMode): string =>
  `common:coworkAccess.${access}.label`

export const accessDescriptionKey = (access: AccessMode): string =>
  `common:coworkAccess.${access}.description`

/**
 * What the backend can actually enforce right now.
 *
 * A mode is only offered when the layer beneath it can hold the line. Showing
 * "Flint can modify files in this exact folder" while the write gate still
 * refuses every path outside the sandbox would be a promise the product does
 * not keep — the precise class of claim this rework exists to remove.
 *
 * Both write modes rest on the same thing: an authorized writable root the tool
 * gate confines to. That is why they move together rather than separately —
 * `directEdit` authorizes the user's own checkout, `managedWorktree` authorizes
 * a Flint-owned worktree, and neither can be honoured on a platform that cannot
 * confine a shell to a directory.
 *
 * A worktree additionally needs Git, since there is nothing to branch from
 * without it.
 */
export type AccessCapability = {
  managedWorktree: boolean
  directEdit: boolean
}

/**
 * The safe default, used before the backend has answered.
 *
 * False is not "no"; it is "not yet established", and the two are the same
 * thing here because neither may be acted on.
 */
export const BACKEND_ACCESS_CAPABILITY: AccessCapability = {
  managedWorktree: false,
  directEdit: false,
}

export const supports = (
  capability: AccessCapability,
  access: AccessMode
): boolean => {
  switch (access) {
    case 'review-only':
      return true
    case 'managed-worktree':
      return capability.managedWorktree
    case 'edit-folder':
      return capability.directEdit
  }
}

/**
 * Read a session's access mode, including sessions saved before it existed.
 *
 * Absent means Review only. Never anything else: an old session's silence is
 * not consent, and reading a missing field as permission is how a safe default
 * quietly stops being one.
 */
export const accessOf = (session: { access?: AccessMode }): AccessMode =>
  session.access ?? 'review-only'

// ---------------------------------------------------------------------------
// Consent

/**
 * Permission to edit one folder, in one session.
 *
 * Deliberately narrow, and deliberately not global. It names the session and
 * the folder it was given for, so switching either leaves it matching nothing
 * — consent cannot follow the user to a repository they never agreed to.
 */
export type EditConsent = { sessionId: string; folder: string }

export const consentCovers = (
  consent: EditConsent | undefined,
  binding: { sessionId: string | null; folder: string | null }
): boolean =>
  consent != null &&
  binding.sessionId != null &&
  binding.folder != null &&
  consent.sessionId === binding.sessionId &&
  consent.folder === binding.folder

// ---------------------------------------------------------------------------
// Roots

export type Roots = {
  /** What this run may read. */
  readRoot: string | null
  /**
   * Where mutations land. Null means the session sandbox — which is not a
   * repository path, and must never be described as one.
   */
  writeRoot: string | null
  destination: WriteDestination
}

/**
 * The two roots a run actually uses.
 *
 * A managed worktree is the run's whole world: it is read *and* written, and
 * the source checkout is not read alongside it. Mixing the two would mean the
 * agent reasoning about one tree and changing another.
 */
export function rootsFor(
  access: AccessMode,
  input: { folder: string | null; worktreePath?: string | null }
): Roots {
  if (access === 'managed-worktree' && input.worktreePath) {
    return {
      readRoot: input.worktreePath,
      writeRoot: input.worktreePath,
      destination: 'managed',
    }
  }
  if (access === 'edit-folder' && input.folder) {
    return {
      readRoot: input.folder,
      writeRoot: input.folder,
      destination: 'repository',
    }
  }
  return { readRoot: input.folder, writeRoot: null, destination: 'sandbox' }
}

/**
 * What a run carries: the tree it reads, and the authority it holds.
 *
 * Derived from the effective access in one place, so every destination is
 * distinct wherever it is read. The mistake this exists to prevent is subtle
 * and was real: a run that read the attached folder while its access said
 * "managed worktree" wrote to a sandbox and reported an isolated checkout, and
 * every part of that is a sentence someone would believe.
 *
 * The grant travels only when there is somewhere to write. A session holding a
 * live grant whose access has been downgraded — capability lost, binding
 * changed, worktree gone — carries none, which is what makes the downgrade
 * mean something rather than merely display something.
 */
export function runCarries(
  effective: Pick<EffectiveAccess, 'readRoot' | 'writeRoot' | 'destination'>,
  input: { folder: string | null; grantId: string | null }
): { readRoot: string | null; writeGrant: string | null } {
  return {
    readRoot: effective.readRoot ?? input.folder,
    writeGrant: effective.writeRoot ? input.grantId : null,
  }
}

// ---------------------------------------------------------------------------
// The decision

export type MutationRefusal =
  /** The folder changed under a run that had already captured its root. */
  | 'stale-binding'
  /** A skill the user asked for is not in play. */
  | 'unresolved-skill'
  /** Review first: read, search, inspect, change nothing. */
  | 'review-mode'
  /** The chosen access mode is not enforceable yet, so it is not honoured. */
  | 'unsupported-access'
  /** Editing this folder was never confirmed, or was confirmed for another. */
  | 'no-consent'

export type MutationDecision =
  | { allowed: true; needsApproval: boolean; destination: WriteDestination }
  | { allowed: false; reason: MutationRefusal }

export type MutationInput = {
  runMode: CoworkMode
  access: AccessMode
  binding: { sessionId: string | null; folder: string | null }
  consent?: EditConsent
  bindingIntact: boolean
  unresolvedSkillCount: number
  capability: AccessCapability
  worktreePath?: string | null
}

/**
 * May this run change something, and does it have to ask first?
 *
 * Ordered so the most fundamental objection is the one reported. A stale
 * binding is checked before anything else because the rest of the answer would
 * be about a repository that is no longer attached; an unresolved skill comes
 * next because approving a change that ignores the user's instructions is
 * worse than not offering to. Every branch that is not plainly permitted
 * refuses.
 */
export function decideMutation(input: MutationInput): MutationDecision {
  if (!input.bindingIntact) return { allowed: false, reason: 'stale-binding' }
  if (input.unresolvedSkillCount > 0) {
    return { allowed: false, reason: 'unresolved-skill' }
  }
  // Review first outranks every access mode: attaching a folder for editing
  // does not stop the run from being an inspection.
  if (isReadOnly(input.runMode)) {
    return { allowed: false, reason: 'review-mode' }
  }
  if (!supports(input.capability, input.access)) {
    return { allowed: false, reason: 'unsupported-access' }
  }
  if (
    input.access === 'edit-folder' &&
    !consentCovers(input.consent, input.binding)
  ) {
    return { allowed: false, reason: 'no-consent' }
  }

  const { destination } = rootsFor(input.access, {
    folder: input.binding.folder,
    worktreePath: input.worktreePath,
  })
  return {
    allowed: true,
    // Ask before changes is about each change, whatever the destination.
    needsApproval: input.runMode === 'ask',
    destination,
  }
}

/** i18n key for why a mutation was refused. */
export const refusalMessageKey = (reason: MutationRefusal): string =>
  `common:coworkAccess.refusal.${reason}`

// ---------------------------------------------------------------------------
// Effective access

/**
 * A grant the backend actually holds, as the renderer knows it.
 *
 * The id is authority-bearing even though it is opaque, so it lives only in
 * memory and never reaches a prompt, a message, an activity row or a log.
 */
export type LiveGrant = {
  sessionId: string
  /** Canonical folder the grant was issued for. */
  folder: string
  grantId: string
}

export type AccessDowngrade =
  /** The platform cannot confine a shell to a folder. */
  | 'no-capability'
  /** Nothing has been authorized, or the authorization is gone. */
  | 'no-grant'
  /** Authorized, but for a different session or folder than this one. */
  | 'binding-changed'
  /** The capability query has not answered, or failed. */
  | 'capability-unknown'

export type EffectiveAccess = {
  /** What this session is operating under right now. */
  access: AccessMode
  /** The stored preference, when it is not what is in force. */
  downgradedFrom?: AccessMode
  reason?: AccessDowngrade
  readRoot: string | null
  writeRoot: string | null
  destination: WriteDestination
}

/**
 * What this session may actually do, as opposed to what it last asked for.
 *
 * The stored access mode is a preference. Authority is the backend's grant,
 * which lives in that process and dies with it — so a session restored from
 * disk with `edit-folder` remembered has a preference and no authority, and
 * saying "editable" on the strength of the preference alone would be the
 * screen inventing a permission nobody holds.
 *
 * Everything that needs to know — the readiness card, the system prompt, tool
 * dispatch — asks this one function, so they cannot answer it differently.
 */
export function effectiveAccess(input: {
  /** The session's stored preference. */
  persisted: AccessMode
  capability: AccessCapability
  /** Absent when nothing is authorized; `undefined` while unknown. */
  grant?: LiveGrant | null
  binding: Binding
  /** False while the capability query is in flight or after it failed. */
  capabilityKnown?: boolean
  /**
   * The session's resolved worktree, when it has one.
   *
   * Absent means none has been created yet, which is not permission: a
   * managed-worktree session with nowhere isolated to write falls back to its
   * sandbox like any other unauthorized run.
   */
  worktreePath?: string | null
}): EffectiveAccess {
  const sandbox = (
    downgradedFrom?: AccessMode,
    reason?: AccessDowngrade
  ): EffectiveAccess => ({
    access: 'review-only',
    ...(downgradedFrom ? { downgradedFrom, reason } : {}),
    readRoot: input.binding.folder,
    writeRoot: null,
    destination: 'sandbox',
  })

  if (input.persisted === 'review-only') return sandbox()

  // An unanswered or failed capability query is not permission.
  if (input.capabilityKnown === false) {
    return sandbox(input.persisted, 'capability-unknown')
  }

  if (input.persisted === 'managed-worktree') {
    if (!input.capability.managedWorktree) {
      return sandbox('managed-worktree', 'no-capability')
    }
    // No worktree resolved yet is not a downgrade the user did anything to
    // deserve, but it is still not authority: until one exists there is
    // nowhere isolated to write.
    if (!input.worktreePath) return sandbox('managed-worktree', 'no-grant')
    if (!input.grant) return sandbox('managed-worktree', 'no-grant')
    // The grant must be for *this* worktree. A grant naming the source
    // checkout would write the very tree this mode exists to leave alone.
    if (
      input.grant.sessionId !== input.binding.sessionId ||
      input.grant.folder !== input.worktreePath
    ) {
      return sandbox('managed-worktree', 'binding-changed')
    }
    // The worktree is the run's whole world: read and written. The source
    // checkout is not read alongside it, so the agent cannot reason about one
    // tree while changing another.
    return {
      access: 'managed-worktree',
      readRoot: input.worktreePath,
      writeRoot: input.worktreePath,
      destination: 'managed',
    }
  }

  if (!input.capability.directEdit)
    return sandbox('edit-folder', 'no-capability')
  if (!input.grant) return sandbox('edit-folder', 'no-grant')
  // A grant belongs to one session and one folder. Anything else is a grant
  // for a run that is not this one.
  if (
    input.grant.sessionId !== input.binding.sessionId ||
    input.grant.folder !== input.binding.folder
  ) {
    return sandbox('edit-folder', 'binding-changed')
  }

  return {
    access: 'edit-folder',
    readRoot: input.binding.folder,
    writeRoot: input.binding.folder,
    destination: 'repository',
  }
}

/** i18n key for why the stored preference is not in force. */
export const downgradeMessageKey = (reason: AccessDowngrade): string =>
  `common:coworkAccess.downgrade.${reason}`

/**
 * i18n key for why this session is not operating under its stored access,
 * or null when it is. A managed-worktree session with no grant is, in
 * practice, one whose grant died with the previous app process, so it says
 * that and how to get it back.
 */
export function effectiveDowngradeKey(effective: EffectiveAccess): string | null {
  if (!effective.downgradedFrom || !effective.reason) return null
  if (effective.downgradedFrom === 'managed-worktree' && effective.reason === 'no-grant') {
    return 'common:coworkAccess.downgrade.worktree-restart'
  }
  return downgradeMessageKey(effective.reason)
}
