import type { Participant, Room, RoomMessage } from './types'

/**
 * A compare room as questions (the user's messages) and the answers each one
 * got. An answer names its question in `compare.replyTo`; an older answer
 * without it belongs to the last question before it.
 */
export type CompareGrid = {
  questions: RoomMessage[]
  /** Question id -> participant answers to it (any status), in order. */
  answers: Map<string, RoomMessage[]>
}

const isAnswer = (m: RoomMessage) => m.kind === 'speech' && m.author.kind === 'participant'

const authorId = (m: RoomMessage) => (m.author.kind === 'participant' ? m.author.participantId : '')

export function compareGrid(messages: RoomMessage[]): CompareGrid {
  const questions: RoomMessage[] = []
  const answers = new Map<string, RoomMessage[]>()
  const ids = new Set(messages.filter((m) => m.kind === 'user').map((m) => m.id))
  let last: RoomMessage | null = null
  for (const m of messages) {
    if (m.kind === 'user') {
      questions.push(m)
      answers.set(m.id, [])
      last = m
      continue
    }
    if (!isAnswer(m)) continue
    const ref = m.compare?.replyTo
    const qid = ref && ids.has(ref) ? ref : last?.id
    if (!qid) continue
    answers.get(qid)?.push(m)
  }
  return { questions, answers }
}

/** The answers one participant gave to a question, oldest first. */
export function answersBy(grid: CompareGrid, questionId: string, participantId: string) {
  return (grid.answers.get(questionId) ?? []).filter((m) => authorId(m) === participantId)
}

export function hasAnswered(grid: CompareGrid, questionId: string, participantId: string) {
  return answersBy(grid, questionId, participantId).some((m) => m.status === 'complete')
}

/** Whether a question is put to this participant: one written to another participant is not. */
export function isAskedOf(question: RoomMessage, participantId: string) {
  return question.to?.kind !== 'participant' || question.to.participantId === participantId
}

/** The questions put to a participant that it has no complete answer to, in order. */
export function missingQuestions(grid: CompareGrid, participantId: string): RoomMessage[] {
  return grid.questions.filter(
    (q) => isAskedOf(q, participantId) && !hasAnswered(grid, q.id, participantId)
  )
}

/** Participants (not removed, not left out) that miss an answer to an earlier question. */
export function participantsMissingEarlier(room: Room, grid: CompareGrid): Participant[] {
  const earlier = grid.questions.slice(0, -1)
  return room.participants
    .filter((p) => !p.removed && !p.compareSkip)
    .filter((p) => earlier.some((q) => isAskedOf(q, p.id) && !hasAnswered(grid, q.id, p.id)))
}

/**
 * What a participant sees when answering `questionId`: every earlier question
 * followed by its own latest complete answer to it, then the question itself --
 * as if it had been in the room from the start, whenever it answered.
 */
export function compareHistory(
  messages: RoomMessage[],
  participantId: string,
  questionId: string | null
): RoomMessage[] {
  const grid = compareGrid(messages)
  const target = grid.questions.findIndex((q) => q.id === questionId)
  const upTo = target < 0 ? grid.questions.length - 1 : target
  if (upTo < 0) return messages
  const out: RoomMessage[] = []
  grid.questions.slice(0, upTo + 1).forEach((q, i) => {
    out.push(q)
    if (i === upTo) return
    const done = answersBy(grid, q.id, participantId).filter((m) => m.status === 'complete')
    if (done.length) out.push(done[done.length - 1])
  })
  return out
}
