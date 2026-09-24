import type { AskAnswer } from '@/types/coworkSession'
import type { ToolOutcome } from '@/lib/coworkRunner'
import { ASK_UNANSWERED_RESULT } from '@/lib/coworkAsk'
import {
  EXECUTE_PLAN_LABEL,
  EXIT_PLAN_LABEL,
  KEEP_PLANNING_LABEL,
  PLAN_REVIEW_QUESTION_ID,
} from '@/lib/coworkPrompt'

/**
 * Plan review for a read-only (review-mode) run. janhq/jan#8906.
 *
 * Asked to create a file while planning, a model reads the file it means to
 * create, gets "not found", announces it will create it, and reads it again --
 * thirty times in the reported run. Nothing it can call in review mode writes,
 * so the loop cannot end on its own. The dispatcher explains the first failure
 * and, on a second failed read of the same path, stops asking the filesystem
 * and asks the user instead; the answer here is what that question does.
 */

/** A failed read that means "there is nothing at that path". */
export function isMissingPathError(text: string): boolean {
  return /os error (2|3)\b|no such file|cannot find the (file|path)|does not exist|not found/i.test(
    text
  )
}

/** Appended to the first missing-file failure in review mode. The original
 * error stays first: a real filesystem error is never hidden. */
export function missingReadGuidance(path: string): string {
  return (
    `\n\n\`${path}\` does not exist yet. This run is read-only (review mode), ` +
    'so no tool you have here can create it. If the task needs new ' +
    'files, stage the plan with the `todo` tool, then call `ask` for plan ' +
    'review; the user decides whether it runs.'
  )
}

/** The question put to the user when the model keeps reading a missing path. */
export function planReviewRequest(path: string): unknown {
  return {
    questions: [
      {
        id: PLAN_REVIEW_QUESTION_ID,
        question:
          `The agent keeps reading \`${path}\`, which does not exist. Review ` +
          'mode cannot create files. How should it continue?',
        options: [
          { label: EXECUTE_PLAN_LABEL, description: 'Switch to Ask mode: changes run after you approve each one' },
          { label: KEEP_PLANNING_LABEL, description: 'Stay read-only and keep investigating' },
          { label: EXIT_PLAN_LABEL, description: 'Leave review mode and stop this run' },
        ],
      },
    ],
  }
}

export type PlanReviewDecision = 'execute' | 'keep' | 'exit' | 'none'

type ReviewQuestion = { id: string; options?: { label: string }[] }

const sameLabel = (a: string | undefined, b: string) =>
  a !== undefined && a.trim().toLowerCase() === b.toLowerCase()

/**
 * Whether a question is a plan review: the one Flint asks (`plan_review`), or
 * one the model wrote itself that offers "Execute plan". A model in plan mode
 * asks in its own words; choosing "Execute plan" on its card used to be passed
 * back as a bare answer and nothing happened.
 */
function isPlanReviewQuestion(q: ReviewQuestion): boolean {
  return (
    q.id === PLAN_REVIEW_QUESTION_ID ||
    (q.options ?? []).some((o) => sameLabel(o.label, EXECUTE_PLAN_LABEL))
  )
}

/** What the user chose on a plan review question, if one was asked. */
export function planReviewDecision(
  request: { questions: ReviewQuestion[] },
  answers: AskAnswer[] | null
): PlanReviewDecision {
  const reviews = request.questions.filter(isPlanReviewQuestion)
  if (reviews.length === 0) return 'none'
  const chosen = reviews.flatMap(
    (q) => answers?.find((a) => a.id === q.id)?.selected ?? []
  )
  if (chosen.some((c) => sameLabel(c, EXECUTE_PLAN_LABEL))) return 'execute'
  if (chosen.some((c) => sameLabel(c, EXIT_PLAN_LABEL))) return 'exit'
  // Keep planning, a custom answer, or a dismissed card: nothing changes, and
  // in particular nothing becomes writable.
  return 'keep'
}

/**
 * The tool result for an answered plan review.
 *
 * A mode applies from the next run -- the tool set is frozen for a run -- so
 * after Execute this run ends and the plan continues in a new run that can
 * make changes (`PLAN_EXECUTE_INSTRUCTION`); after Exit the model is told to
 * end the turn rather than try a write that this run would still refuse.
 */
export function renderPlanReviewResult(
  decision: PlanReviewDecision,
  answers: AskAnswer[] | null
): ToolOutcome {
  const raw = answers === null ? 'no answer' : JSON.stringify(answers)
  switch (decision) {
    case 'execute':
      return {
        output:
          `The user approved the plan (${raw}). Plan mode is off. This ` +
          'read-only run ends here and the plan continues at once in a new ' +
          'run where changes go ahead after the user approves each one. Do ' +
          'not call any tool that writes in this run and make no further ' +
          'tool calls.',
        endsTurn: true,
      }
    case 'exit':
      return {
        output:
          `The user left review mode (${raw}). Stop now: end the turn with ` +
          'one line saying what was found, and make no further tool calls.',
      }
    default:
      if (answers === null) {
        return { output: `${ASK_UNANSWERED_RESULT} Stay read-only.` }
      }
      return {
        output:
          `The user wants to keep planning (${raw}). Stay read-only. Do not ` +
          'read paths that do not exist; investigate what is there, then ' +
          'stage the plan and ask for review again.',
      }
  }
}

/** What the new run is asked to do after the user chose "Execute plan". */
export const PLAN_EXECUTE_INSTRUCTION =
  'The user approved the plan. Carry it out now, step by step.'

/**
 * Why an approved plan cannot change the user's files, if it cannot: no folder
 * attached, or the session's changes go to its own sandbox (Review only). The
 * plan still runs -- in the sandbox -- and the user is told what to change.
 */
export function planExecuteNotice(input: {
  folder: string | null | undefined
  access: string
}): 'noFolder' | 'reviewOnly' | null {
  if (!input.folder) return 'noFolder'
  if (input.access === 'review-only') return 'reviewOnly'
  return null
}
