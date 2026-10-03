// Questions a Cowork run is waiting on (its `ask` tool: plain questions, plan
// review, the opening "continue?" proposal), as a phone sees and answers them.
// Pure: the app hands in its live turns (see `appSources.asks`), tests hand in
// plain data.

import type { AskAnswer, CoworkTurn, TodoList } from '@/types/coworkSession'
import type { RemoteAsk, RemoteAskAnswer } from './protocol'

/** The desktop's plan-review question id (lib/coworkPrompt.ts). */
const PLAN_REVIEW = 'plan_review'

const planOf = (todos: TodoList | null | undefined): RemoteAsk['plan'] =>
  (todos?.phases ?? [])
    .filter((p) => p.tasks.length > 0)
    .map((p) => ({
      name: p.name,
      tasks: p.tasks.map((t) => ({
        content: t.content,
        done: t.status === 'completed' || t.status === 'abandoned',
      })),
    }))

/**
 * The questions still waiting in `turnsBySession`. `held` says whether the
 * run that asked is still there to take an answer: a card whose run is gone
 * cannot be answered, so it is not offered.
 */
export function pendingAsks(
  turnsBySession: Record<string, CoworkTurn[] | undefined>,
  held: (sessionId: string, requestId: string) => boolean,
  todosOf: (sessionId: string) => TodoList | null | undefined = () => undefined
): RemoteAsk[] {
  const out: RemoteAsk[] = []
  for (const [sid, turns] of Object.entries(turnsBySession)) {
    for (const turn of turns ?? []) {
      for (const ask of turn.asks ?? []) {
        if (ask.state !== 'pending' || !held(sid, ask.requestId)) continue
        const plan = ask.request.questions.some((q) => q.id === PLAN_REVIEW)
          ? planOf(todosOf(sid))
          : undefined
        const at = Date.parse(ask.at)
        out.push({
          requestId: ask.requestId,
          threadId: sid,
          questions: ask.request.questions.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options.map((o) => ({
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
            ...(q.multi ? { multi: true } : {}),
            ...(typeof q.recommended === 'number' ? { recommended: q.recommended } : {}),
          })),
          ...(plan && plan.length > 0 ? { plan } : {}),
          ...(Number.isFinite(at) ? { requestedAt: at } : {}),
        })
      }
    }
  }
  return out
}

const MAX_CUSTOM = 4000

/**
 * A phone's answers, checked against the question they answer: one answer per
 * question, each either option labels the question offers or the user's own
 * text. Returns what the desktop's own card would hand the run, or a message
 * saying what is wrong.
 */
export function checkAskAnswers(ask: RemoteAsk, raw: unknown): AskAnswer[] | string {
  if (!Array.isArray(raw)) return 'answers must be a list'
  const byId = new Map<string, RemoteAskAnswer>()
  for (const entry of raw) {
    const a = entry as Partial<RemoteAskAnswer> | null
    if (!a || typeof a.id !== 'string') return 'each answer needs the id of its question'
    byId.set(a.id, a as RemoteAskAnswer)
  }
  const out: AskAnswer[] = []
  for (const q of ask.questions) {
    const a = byId.get(q.id)
    if (!a) return `No answer for "${q.question}"`
    const custom = typeof a.custom_input === 'string' ? a.custom_input.trim() : ''
    if (custom) {
      if (custom.length > MAX_CUSTOM) return 'That answer is too long'
      out.push({ id: q.id, selected: [], custom_input: custom })
      continue
    }
    const selected = Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === 'string') : []
    if (selected.length === 0) return `No answer for "${q.question}"`
    if (!q.multi && selected.length > 1) return `"${q.question}" takes one choice`
    const labels = new Set(q.options.map((o) => o.label))
    if (!selected.every((s) => labels.has(s))) return 'That choice is not one of the options'
    out.push({ id: q.id, selected: [...new Set(selected)] })
  }
  return out
}
