/**
 * What to do with the first thing someone says about a repository they just
 * attached.
 *
 * The failure this prevents: "continue where the other tool left off" was
 * treated as an instruction to start working, so the run picked a task out of a
 * plan file and began editing — on its first turn, in a repository nobody had
 * confirmed, against a reading of "where it left off" the user never saw. The
 * work may even have been right. It was not asked for.
 *
 * So an opening request is answered in two turns, not one: inspect and propose,
 * then act once the user says which. The proposal is the product of the first
 * turn, and it is a stopping point rather than a preamble.
 *
 * **The classifier can only widen, never narrow.** A first turn on a bound
 * repository inspects unless the request is *explicitly* directive, so a
 * request this module fails to understand is treated as ambiguous and stops —
 * which costs a round trip. Reversing the default would make a
 * misunderstanding cost an unwanted edit instead, and those are not comparable.
 * This mirrors how the rest of Cowork reads a missing value: silence is not
 * consent.
 *
 * **The classifier is not the enforcement.** It decides what to ask for, and
 * the mode gate decides what may run — the same doubling plan mode already
 * uses, where a denied tool is both withheld from the advertised set and
 * refused by name. A classifier that gets it wrong must not be able to turn
 * into a write.
 */

/** Where a repository-bound session is in the opening exchange. */
export type ContinuityState =
  /** Reading, to find out what the repository is and what state it is in. */
  | 'inspecting'
  /** A next step has been proposed; the user has not answered. */
  | 'awaiting-continuation'
  /** The user chose. Work is under way. */
  | 'executing'
  /** The proposed work finished. */
  | 'completed'
  /** Something stopped it that the user has to resolve. */
  | 'blocked'
  /** The user declined, or abandoned the session. */
  | 'cancelled'

export type ContinuityRecord = {
  state: ContinuityState
  /** The repository this record is about. A record never outlives its folder. */
  folder: string
  /** The one-line next step put to the user, when there is one. */
  proposal?: string
  /** What the proposal was read off — file paths, plan entries, statuses. */
  evidence?: string[]
}

/**
 * Verbs that ask for a change, in the imperative.
 *
 * Only the directive sense counts. "I need to fix this eventually" is not an
 * instruction to fix it now, so the match is anchored to the start of the
 * request or to a clause boundary rather than searched for anywhere in the
 * text.
 */
const DIRECTIVE_VERBS = [
  'add',
  'apply',
  'build',
  'bump',
  'change',
  'commit',
  'convert',
  'create',
  'delete',
  'disable',
  'drop',
  'enable',
  'fix',
  'implement',
  'install',
  'migrate',
  'move',
  'port',
  'refactor',
  'remove',
  'rename',
  'replace',
  'revert',
  'rewrite',
  'run',
  'update',
  'upgrade',
  'write',
]

/**
 * Words that ask to be shown something.
 *
 * Present so the intent is documented and testable, not because a match here
 * grants anything: inspection is already the default, so these change nothing.
 * They exist to make the asymmetry explicit — this list is decorative, and the
 * directive list is load-bearing.
 */
export const INSPECTION_WORDS = [
  'read',
  'learn',
  'look',
  'explore',
  'understand',
  'review',
  'check',
  'inspect',
  'summarise',
  'summarize',
  'explain',
]

/** Strips code spans and fenced blocks, so a verb quoted from a file is not read as an instruction. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
}

/**
 * Does this request plainly instruct a change?
 *
 * Requires an imperative at the start of the request or of a clause: "implement
 * task 2" qualifies, "continue where the other harness stopped, probably task
 * 1" does not, and neither does "the plan says to implement task 2" — reporting
 * what a document says is not asking for it.
 *
 * Hedges disqualify. "Probably", "maybe" and "I think" are how someone says
 * they are not sure, and acting on an unsure instruction is the behaviour this
 * exists to stop.
 */
export function isExplicitDirective(text: string): boolean {
  const clean = withoutCode(text).toLowerCase()
  if (!clean.trim()) return false
  if (/\b(probably|maybe|perhaps|i think|not sure|might|could you maybe)\b/.test(clean)) {
    return false
  }
  const verbs = DIRECTIVE_VERBS.join('|')
  // Start of the text, or after a clause break. `please` is allowed in front.
  const anchored = new RegExp(
    `(?:^|[.;\\n]|\\band\\b|\\bthen\\b)\\s*(?:please\\s+)?(?:${verbs})\\b`
  )
  if (!anchored.test(clean)) return false
  // "the plan says to implement X" reports rather than instructs.
  if (/\b(says?|according to|suggests?|recommends?)\b[^.]*\b(?:to\s+)?(?:$|\w)/.test(clean)) {
    const beforeVerb = clean.split(new RegExp(`\\b(?:${verbs})\\b`))[0] ?? ''
    if (/\b(says?|according to|suggests?|recommends?)\b/.test(beforeVerb)) {
      return false
    }
  }
  return true
}

export type OpeningDecision =
  /** Read first, then put a next step to the user. */
  | 'inspect-and-propose'
  /** The request said what to do; the mode gate decides whether it may. */
  | 'follow-the-request'

/**
 * How to treat a turn.
 *
 * Only the *first* turn of a repository-bound session is gated this way. After
 * that the user has seen what the repository is and has answered a proposal,
 * so continuing to second-guess plain instructions would be an obstacle rather
 * than a safeguard.
 */
export function decideOpening(input: {
  /** Null when no repository is attached; then there is nothing to protect. */
  folder: string | null
  /** Turns already in the session's transcript. */
  priorTurns: number
  text: string
  /** An existing record, when the session already has one. */
  record?: ContinuityRecord | null
}): OpeningDecision {
  if (!input.folder) return 'follow-the-request'
  // Answering a proposal is not a fresh opening, whatever it says.
  if (input.record && input.record.state === 'awaiting-continuation') {
    return 'follow-the-request'
  }
  if (input.priorTurns > 0) return 'follow-the-request'
  return isExplicitDirective(input.text)
    ? 'follow-the-request'
    : 'inspect-and-propose'
}

/**
 * A record for a folder, or nothing.
 *
 * A record naming another folder is not this session's: rebinding must not
 * carry a proposal about one repository over to a different one.
 */
export function recordFor(
  record: ContinuityRecord | null | undefined,
  folder: string | null
): ContinuityRecord | null {
  if (!record || !folder) return null
  return record.folder === folder ? record : null
}

/**
 * What a resumed session may do without being told again.
 *
 * The property most likely to regress quietly, so it is a function with a name
 * rather than a condition inlined at the call site: a session restored from
 * disk in `awaiting-continuation` holds a proposal nobody has answered, and
 * running it because the state was saved would be the original failure with
 * extra steps.
 */
export function resumesIntoWork(record: ContinuityRecord | null): boolean {
  return record?.state === 'executing'
}

/** The prompt addendum for an inspect-and-propose turn. */
export const INSPECT_AND_PROPOSE_ADDENDUM = [
  'OPENING TURN (read only): This is the first thing the user has said about',
  'this repository, and it does not plainly say what to change. Do not change',
  'anything, and do not start a task.',
  '',
  'This first turn is read-only: write, edit and bash are withheld for this',
  'turn only. Do not announce writes or offer to apply changes in this turn.',
  'Deliver findings in chat and offer to continue; the user’s next reply runs',
  'with full tools. There is no plan mode to exit.',
  '',
  'Instead:',
  '1. Establish what this repository is, from its own files.',
  '2. Read whatever states its progress — a plan, a todo list, a status file,',
  '   recent commits — and say what is done and what is not, citing the file',
  '   or commit each claim comes from.',
  '3. Propose exactly one next step.',
  '4. Stop, and ask whether to do it, using `ask` with a single question whose',
  `   id is "${'continue_proposal'}" and whose options are the proposed step and`,
  '   an alternative.',
  '',
  'If the evidence is ambiguous, say so and propose the step you would take',
  'anyway. Do not present a guess as a finding: every claim about what is',
  'already done needs something behind it.',
].join('\n')

/** The reserved question id the opening turn ends on. */
export const CONTINUE_QUESTION_ID = 'continue_proposal'
