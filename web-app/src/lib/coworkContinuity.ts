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
  // Start of a sentence, or after `and`/`then` inside it. `please` is
  // allowed in front.
  const anchored = new RegExp(
    `(?:^|\\band\\b|\\bthen\\b)\\s*(?:please\\s+)?(?:${verbs})\\b`
  )
  const reporting = /\b(says?|according to|suggests?|recommends?)\b/
  // Judged sentence by sentence: "Customers say 100.00 gets no discount. Fix
  // it." reports a symptom and then instructs, and the report in the first
  // sentence must not disqualify the instruction in the second (the s01
  // smoke prompt, #296). Within one sentence, a reporting word before the
  // verb still means the verb is being quoted: "the plan says to implement X".
  return clean.split(/[.;!?]+(?:\s|$)|\n+/).some((sentence) => {
    const match = anchored.exec(sentence)
    if (!match) return false
    return !reporting.test(sentence.slice(0, match.index + match[0].length))
  })
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

/**
 * Words that accept a proposal when typed as a free-text answer.
 *
 * Anchored at the start and refused on any negation, so "no, do it later" or
 * "don't apply it" never reads as a yes.
 */
const AFFIRMATIVE =
  /^(?:yes|yeah|yep|ok|okay|sure|please|do it|go ahead|go for it|proceed|apply it|continue|sounds good)\b/i
const NEGATION = /\b(?:no|not|don'?t|do not|never|stop|cancel|wait|instead)\b/i

/**
 * Did the user accept the opening turn's proposal? (#296)
 *
 * The opening addendum asks for the proposed step as the first option and an
 * alternative after it, so choosing the first option is a yes. A free-text
 * answer is a yes only when it plainly says so. Anything else -- the
 * alternative, a dismissed card, a question back -- is not, and the session
 * stays where it is.
 */
export function acceptsProposal(
  request: {
    questions: { id: string; options?: { label: string }[] }[]
  },
  answers: { id: string; selected?: string[]; custom_input?: string }[] | null
): boolean {
  const question = request.questions.find(
    (one) => one.id === CONTINUE_QUESTION_ID
  )
  if (!question || !answers) return false
  const answer = answers.find((one) => one.id === CONTINUE_QUESTION_ID)
  if (!answer) return false
  const chosen = answer.selected?.[0]
  if (chosen !== undefined) {
    if (answer.selected && answer.selected.length > 1) return false
    if (chosen === question.options?.[0]?.label) return true
    return AFFIRMATIVE.test(chosen.trim()) && !NEGATION.test(chosen)
  }
  const typed = answer.custom_input?.trim() ?? ''
  return typed.length > 0 && AFFIRMATIVE.test(typed) && !NEGATION.test(typed)
}

/**
 * The instruction the continuation run is started with.
 *
 * Sent as the user's next message, so the transcript shows what the new run
 * was asked to do and the model reads it as a plain instruction under the
 * session's own mode rather than as an answer to a read-only turn.
 */
export function continuationInstruction(
  proposal: string,
  answers: { id: string; selected?: string[]; custom_input?: string }[]
): string {
  const answer = answers.find((one) => one.id === CONTINUE_QUESTION_ID)
  const said = answer?.selected?.[0] ?? answer?.custom_input?.trim() ?? ''
  return [
    `Go ahead with the step you proposed${said ? ` ("${said}")` : ''}.`,
    `Your question was: ${proposal}`,
  ].join('\n')
}

/** The ask result when an accepted proposal hands the work to a new run. */
export const PROPOSAL_ACCEPTED_RESULT =
  'The user accepted the proposal. This read-only opening turn ends here; ' +
  'the step runs next, in a new turn with the session’s own tools.'
