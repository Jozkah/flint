import type { AskAnswer } from '@/types/coworkSession'
import type { ToolOutcome } from '@/lib/coworkRunner'
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
    `\n\nThis session is in review mode, which is read-only: \`read\` cannot ` +
    `create \`${path}\`, and no tool you have here can. If the task needs new ` +
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

/** What the user chose on a `plan_review` question, if one was asked. */
export function planReviewDecision(
  request: { questions: { id: string }[] },
  answers: AskAnswer[] | null
): PlanReviewDecision {
  if (!request.questions.some((q) => q.id === PLAN_REVIEW_QUESTION_ID)) {
    return 'none'
  }
  const chosen = answers?.find((a) => a.id === PLAN_REVIEW_QUESTION_ID)
    ?.selected?.[0]
  if (chosen === EXECUTE_PLAN_LABEL) return 'execute'
  if (chosen === EXIT_PLAN_LABEL) return 'exit'
  // Keep planning, a custom answer, or a dismissed card: nothing changes, and
  // in particular nothing becomes writable.
  return 'keep'
}

/**
 * The tool result for an answered plan review.
 *
 * A mode applies from the next message -- the tool set is frozen for a run --
 * so after Execute or Exit the model is told to end the turn rather than try a
 * write that this run would still refuse.
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
          `The user approved the plan (${raw}). The session switches to Ask ` +
          'mode from the next message, where changes run after the user ' +
          'approves each one. This run is still read-only: do not call any ' +
          'tool that writes. Summarise the plan in one or two lines and end ' +
          'the turn.',
      }
    case 'exit':
      return {
        output:
          `The user left review mode (${raw}). Stop now: end the turn with ` +
          'one line saying what was found, and make no further tool calls.',
      }
    default:
      return {
        output:
          `The user wants to keep planning (${raw}). Stay read-only. Do not ` +
          'read paths that do not exist; investigate what is there, then ' +
          'stage the plan and ask for review again.',
      }
  }
}
