/**
 * Where a Cowork run may write, kept separate from how freely it may act.
 *
 * These are two questions that kept being answered as one. "Autonomous" said
 * how often Jan stops to ask; it never said whether the thing it was about to
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
import type { WriteDestination } from '@/lib/coworkReadiness'

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
 * "Jan can modify files in this exact folder" while the write gate still
 * refuses every path outside the sandbox would be a promise the product does
 * not keep — the precise class of claim this rework exists to remove.
 *
 * Both write modes are false until their enforcement lands: the managed
 * worktree needs a lifecycle the Git layer does not have yet (`core/agent/git`
 * offers `repo_root`, `status` and `file_diff` and nothing else), and direct
 * editing needs an authorized writable root threaded through the tool gate,
 * which today measures every write against the sandbox.
 */
export type AccessCapability = {
  managedWorktree: boolean
  directEdit: boolean
}

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
