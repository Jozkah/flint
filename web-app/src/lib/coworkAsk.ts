import type {
  AskAnswer,
  AskQuestion,
  AskRequestPayload,
} from '@/types/coworkSession'
import type { ToolOutcome } from '@/lib/coworkRunner'

/**
 * The `ask` tool: suspend the run until the user answers.
 *
 * Because Cowork dispatches tools after the model stream has terminated, a
 * suspended ask holds no HTTP connection and occupies no llama.cpp slot while
 * the user thinks — unlike the Rust loop, which blocked inside the turn.
 */

/** Reject a malformed request rather than rendering an unanswerable card. */
export function parseAskRequest(input: unknown): AskRequestPayload | string {
  const raw = (input ?? {}) as { questions?: unknown }
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    return '`ask` requires a non-empty `questions` array'
  }
  const questions: AskQuestion[] = []
  for (const entry of raw.questions) {
    const q = entry as Partial<AskQuestion>
    if (typeof q.id !== 'string' || !q.id.trim()) {
      return 'each question requires a non-empty `id`'
    }
    if (typeof q.question !== 'string' || !q.question.trim()) {
      return `question '${q.id}' requires a \`question\` string`
    }
    if (!Array.isArray(q.options) || q.options.length < 2) {
      return `question '${q.id}' requires at least two options`
    }
    const options = q.options
      .map((o) => o as { label?: unknown; description?: unknown })
      .filter((o) => typeof o.label === 'string' && o.label.trim())
      .map((o) => ({
        label: o.label as string,
        ...(typeof o.description === 'string'
          ? { description: o.description }
          : {}),
      }))
    if (options.length < 2) {
      return `question '${q.id}' requires at least two labelled options`
    }
    questions.push({
      id: q.id,
      question: q.question,
      options,
      ...(q.multi === true ? { multi: true } : {}),
      ...(typeof q.recommended === 'number' && q.recommended >= 0
        ? { recommended: q.recommended }
        : {}),
    })
  }
  return { questions }
}

/**
 * The tool result for a settled ask. `null` answers mean the card was never
 * answered: dismissed, timed out, or the run was stopped. The model is told so
 * plainly -- and that it is not approval. "Proceed with your best judgement"
 * read as consent: a model that had offered "Execute plan" went on to tell the
 * user the plan was approved while the card was still unanswered.
 */
export const ASK_UNANSWERED_RESULT =
  'The user did not answer this question. This is not approval: no option ' +
  'was chosen, so do not act on any of them or say that anything was ' +
  'approved or agreed. Continue only with work that does not depend on the ' +
  'answer; otherwise end the turn and say you are waiting for their answer.'

export function renderAskResult(answers: AskAnswer[] | null): ToolOutcome {
  if (answers === null) {
    return { output: ASK_UNANSWERED_RESULT }
  }
  return { output: JSON.stringify(answers) }
}
