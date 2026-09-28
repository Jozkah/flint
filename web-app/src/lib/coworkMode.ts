/**
 * What a Cowork session is allowed to do.
 *
 * This replaces a boolean `planMode`, which could only say "plan" or "not
 * plan" and left the interesting case — run, but ask before changing anything
 * — with nowhere to live. A boolean also made the safe state the unusual one:
 * it defaulted to off, so attaching a repository and typing anything at all
 * could edit it on the first turn.
 *
 * The three modes are ordered by what they permit. A session bound to a
 * repository starts in `ask`; its opening turn is read-only on its own.
 */

import { PLAN_DENIED_TOOLS } from '@/lib/coworkTools'

export type CoworkMode =
  /** Read, list, search, inspect. Nothing that writes or runs commands. */
  | 'review'
  /** Everything is available, but a mutation waits for the user to allow it. */
  | 'ask'
  /** No gate. Opt-in, and labelled as such wherever it is shown. */
  | 'auto'

export const COWORK_MODES: readonly CoworkMode[] = ['review', 'ask', 'auto']

/** i18n key for a mode's short name, used in the selector and readiness card. */
export const modeLabelKey = (mode: CoworkMode): string =>
  `common:coworkMode.${mode}.label`

/** i18n key for the one-word name used under the composer. */
export const modeShortLabelKey = (mode: CoworkMode): string =>
  `common:coworkMode.${mode}.short`

/** i18n key for the one-line explanation shown under the name. */
export const modeDescriptionKey = (mode: CoworkMode): string =>
  `common:coworkMode.${mode}.description`

/**
 * Is this mode read-only?
 *
 * Named rather than compared inline so the question has one answer: several
 * places need it (tool advertisement, the dispatcher's refusal, the readiness
 * card), and `mode === 'review'` scattered across them drifts.
 */
export const isReadOnly = (mode: CoworkMode): boolean => mode === 'review'

/** Does a mutation in this mode wait for the user? */
export const gatesMutations = (mode: CoworkMode): boolean => mode === 'ask'

const EMPTY: ReadonlySet<string> = new Set()

/**
 * Tools this mode refuses outright.
 *
 * Review mode withholds exactly what plan mode withheld — the set is shared,
 * not re-listed, so a tool added to one is added to both.
 */
export function deniedTools(mode: CoworkMode): ReadonlySet<string> {
  return isReadOnly(mode) ? PLAN_DENIED_TOOLS : EMPTY
}

/**
 * Does this call need the user's word before it runs?
 *
 * Only in `ask`: `review` has already refused these by name, and `auto` is the
 * mode whose entire meaning is that it does not ask.
 */
export function needsApproval(mode: CoworkMode, toolName: string): boolean {
  return gatesMutations(mode) && PLAN_DENIED_TOOLS.has(toolName)
}

/**
 * The mode a session should start in.
 *
 * A session with a repository attached starts in `ask`: every change waits for
 * the user. The opening turn is protected separately — a first message that
 * only looks at the project runs read-only for that turn alone (see
 * `decideOpening`) — so the stored mode must not be `review` as well. A stored
 * `review` outlives the opening turn, and a later "refactor this" then ran with
 * write and edit withheld: no approval prompt, only a bare refusal. Without a
 * repository there is nothing to protect, so the session behaves as before.
 */
export const defaultModeFor = (folder: string | null | undefined): CoworkMode =>
  folder ? 'ask' : 'auto'

/**
 * Read a session's mode, including sessions saved before modes existed.
 *
 * Legacy sessions carry `planMode`. `true` meant read-only, which is `review`.
 * `false` meant no gate at all, which is `auto` — reading it as `ask` would
 * start interrupting people who never asked to be interrupted.
 */
export function modeOf(session: {
  mode?: CoworkMode
  planMode?: boolean
}): CoworkMode {
  if (session.mode) return session.mode
  return session.planMode ? 'review' : 'auto'
}
