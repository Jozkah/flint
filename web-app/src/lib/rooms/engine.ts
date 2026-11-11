/**
 * The room turn loop (docs/DISCUSSION_ROOMS.md, "Engine").
 *
 * All side effects go through injected deps, so tests are deterministic. The
 * engine writes only discussion state (status, usage, round bookkeeping,
 * availability, transcript). It never derives `toolAccess`, `limits`,
 * participants or the moderator from model output, and never consults any
 * tool-approval store.
 */
import { rt } from './text'
import { isAbortLike } from '@/lib/coworkRunner'
import { checkModel, clearSuspensions, localEngineOf } from './availability'
import { quoteText } from './context'
import { redactSecrets } from '@/lib/redact'
import { HARD_CALL_CEILING, clampLimits } from './limits'
import { moderatorInstruction, parseDirective, renderDirective } from './moderator'
import { isRoomPersistenceError } from './persistence'
import {
  activeParticipants,
  atRoundBoundary,
  beginSpeakingTurn,
  markSpoken,
  nextSpeaker,
  resolveParticipant,
} from './policy'
import { isRepetitive, recentSpeech } from './repetition'
import { stripConclusion } from './consensus'
import { compareGrid, hasAnswered, isAskedOf, missingQuestions } from './compareGrid'
import {
  composeSynthesisText,
  computeDissent,
  finalPositionPrompt,
  latestFinalPositions,
  synthesisPrompt,
} from './synthesis'
import {
  compareRunOf,
  type ModeratorDirective,
  type Participant,
  type Room,
  type RoomModelRef,
  type StopReason,
} from './types'
import { parseVote, renderTally, tallyVotes, votePrompt } from './votes'
import { truncate, parseAddressFor, settleAfterCommand, chunkTranscript } from './engineText'
import {
  type EngineDeps,
  type RunOptions,
  RunAborted,
  LimitStop,
  type TurnOutcome,
  type Finalize,
} from './engineShared'
import { RoomRunTurns } from './engineTurns'

export { chunkTranscript }
export type {
  SummarizeFn,
  EngineUpdate,
  EngineDeps,
  AbortIntent,
  RunCommand,
  RunOptions,
} from './engineShared'
export { writingSpeed } from './engineShared'

class RoomRun extends RoomRunTurns {
  /** Consecutive speech turns addressed to the user, to break a wait-loop. */
  private consecutiveUserWaits = 0

  // ---- discussion ------------------------------------------------------------

  moderatorReady(): { ok: true; model: RoomModelRef } | { ok: false; problem: string } {
    const m = this.room.moderator
    if (!m.enabled || !m.model) {
      return { ok: false, problem: rt('moderatorNotConfigured') }
    }
    const problem = checkModel(m.model, this.lookup)
    if (problem) return { ok: false, problem: rt('moderatorUnavailable', { message: problem.message }) }
    return { ok: true, model: m.model }
  }

  async moderatorStep(): Promise<{ directive: ModeratorDirective | null; problem: string | null }> {
    const ready = this.moderatorReady()
    if (!ready.ok) return { directive: null, problem: ready.problem }
    const box: { directive: ModeratorDirective | null } = { directive: null }
    const outcome = await this.modelTurn({
      author: { kind: 'moderator', name: this.room.moderator.name || 'Moderator' },
      speaker: { kind: 'moderator' },
      model: ready.model,
      kind: 'moderator-note',
      instruction: moderatorInstruction(this.room),
      finalize: (raw) => {
        const parsed = parseDirective(raw)
        box.directive = parsed
        if (!parsed) {
          return {
            text: raw.slice(0, 2000),
            status: 'failed',
            error: { code: 'invalid-directive', message: rt('directiveInvalid') },
          }
        }
        const next = resolveParticipant(parsed.next, activeParticipants(this.room))
        return {
          text: renderDirective(parsed, next?.name ?? null),
          directive: parsed,
          to: next ? { kind: 'participant', participantId: next.id } : { kind: 'room' },
        }
      },
    })
    if (outcome.kind !== 'complete') {
      return { directive: null, problem: rt('moderatorCallFailed') }
    }
    if (!box.directive) {
      return { directive: null, problem: rt('directiveInvalid') }
    }
    return { directive: box.directive, problem: null }
  }

  async discuss() {
    this.room = clearSuspensions(this.room)
    if (!(await this.preflight(2))) return
    await this.save({ status: 'running', stopReason: null })
    if (this.room.mode === 'compare') return this.compareRound()

    for (;;) {
      this.checkAbort()
      await this.drainUserMessages()

      let limit = this.breach(true)
      if (limit) return this.stopForLimit(limit)

      if (this.room.round > 0 && atRoundBoundary(this.room)) {
        if (!(await this.preflight(2))) return
      }

      const override = this.opts.takeOverride?.() ?? null
      let directive: ModeratorDirective | null = null
      let directiveProblem: string | null = null
      if (this.room.mode === 'moderator-selected' && !override && !this.room.nextSpeakerId) {
        const step = await this.moderatorStep()
        directive = step.directive
        directiveProblem = step.problem
        if (directive && (directive.converged || directive.stop)) {
          return this.close({ kind: 'converged', by: 'moderator' })
        }
        this.checkAbort()
        limit = this.breach(true)
        if (limit) return this.stopForLimit(limit)
      }

      const choice = nextSpeaker({
        room: this.room,
        messages: this.messages,
        override,
        directive,
        directiveProblem,
      })
      if (choice.kind === 'awaiting-user') {
        await this.save({ status: 'awaiting-user', nextSpeakerId: null })
        return
      }
      if (choice.kind === 'none') {
        return this.pauseNoParticipants(choice.note)
      }
      if (choice.note) await this.system(choice.note)

      this.room = beginSpeakingTurn({ ...this.room, nextSpeakerId: null })
      const speaker = choice.participant
      const request = choice.via === 'moderator' && directive?.request ? directive.request : null
      const before = this.messages.length
      // A participant may end the discussion early by concluding it, but never
      // when a moderator is the one deciding when to stop, and never as a lone
      // voice (with fewer than two participants "consensus" is one opinion) or
      // before a full round has been spoken.
      const allowConsensus =
        this.room.mode !== 'moderator-selected' &&
        activeParticipants(this.room).length >= 2 &&
        this.room.usage.turns >= activeParticipants(this.room).length
      let concluded = false
      const outcome = await this.participantTurn(
        speaker,
        'speech',
        request ? `The moderator asks you: ${quoteText(request)}` : null,
        (raw) => {
          const c = stripConclusion(raw)
          concluded = c.concluded && allowConsensus
          return { to: parseAddressFor(c.text, this.room), text: c.text }
        }
      )

      this.room = markSpoken(this.room, speaker.id)
      let converged = false
      if (outcome.kind === 'complete') {
        const limits = clampLimits(this.room.limits)
        const recent = recentSpeech(
          this.messages.slice(0, before),
          activeParticipants(this.room).length
        )
        const repetitive = isRepetitive(outcome.raw, recent, limits.repetitionSimilarity)
        const consecutiveRepetitive = repetitive ? this.room.usage.consecutiveRepetitive + 1 : 0
        this.room = {
          ...this.room,
          usage: {
            ...this.room.usage,
            turns: this.room.usage.turns + 1,
            consecutiveRepetitive,
          },
        }
        converged = consecutiveRepetitive >= limits.maxRepetitiveTurns
      }
      // Track a wait-loop: turns addressed to the user, when the participants
      // are asking for input rather than talking to each other.
      const addressedUser = outcome.kind === 'complete' && outcome.message.to?.kind === 'user'
      this.consecutiveUserWaits = addressedUser ? this.consecutiveUserWaits + 1 : 0
      await this.save()

      if (!(await this.ensureEnough(2))) return
      if (concluded) {
        // The participant's own message is the conclusion, so stop cleanly here
        // rather than running close()'s final-positions round and synthesis --
        // those only restate a point already made and read as noise after
        // "concluded". Moderator/repetition convergence still synthesises,
        // where an automatic summary earns its place.
        await this.note('objectiveMet')
        await this.save({
          status: 'completed',
          stopReason: { kind: 'converged', by: 'consensus' },
          nextSpeakerId: null,
        })
        return
      }
      if (converged) {
        await this.note('converged')
        return this.close({ kind: 'converged', by: 'repetition' })
      }
      // A whole round of participants all waiting on the user (e.g. every model
      // asking for a file or a tool it lacks): stop churning and hand back to the
      // user instead of looping. A reply resumes it.
      if (
        this.consecutiveUserWaits >= 2 &&
        this.consecutiveUserWaits >= activeParticipants(this.room).length
      ) {
        this.consecutiveUserWaits = 0
        await this.note('allWaiting')
        await this.save({ status: 'awaiting-user', nextSpeakerId: null })
        return
      }
      if (this.room.mode === 'user-selected') {
        await this.save({ status: 'awaiting-user', nextSpeakerId: null })
        return
      }
    }
  }

  /**
   * One compare answer: `p` answers question `questionId` from its own context.
   * The message records the model, the question and how long it took. Returns
   * null when the participant became unavailable before its turn.
   */
  async compareAnswer(p: Participant, questionId: string | null): Promise<TurnOutcome | null> {
    const current = this.room.participants.find((x) => x.id === p.id)
    if (!current || current.removed || current.availability.state === 'unavailable') return null
    const startedAt = this.deps.now()
    if (questionId) this.compareTargets.set(p.id, questionId)
    // Earlier questions it never answered: its prompt shows them unanswered, so
    // a late joiner answers them too in this one reply. Recorded so the cell
    // can say so instead of mixing them in silently (R-043).
    const grid = compareGrid(this.messages)
    const at = questionId ? grid.questions.findIndex((q) => q.id === questionId) : grid.questions.length - 1
    const catchUp = grid.questions
      .slice(0, Math.max(0, at))
      .filter((q) => !hasAnswered(grid, q.id, p.id))
      .map((q) => ({ id: q.id, text: q.text.slice(0, 160) }))
    try {
      const outcome = await this.participantTurn(current, 'speech', null, () => ({
        compare: {
          provider: current.model.provider,
          model: current.model.id,
          ...(questionId ? { replyTo: questionId } : {}),
          ...(catchUp.length ? { catchUp } : {}),
          durationMs: Math.max(0, this.deps.now() - startedAt),
        },
      }))
      if (outcome.kind === 'complete') {
        this.room = {
          ...this.room,
          usage: { ...this.room.usage, turns: this.room.usage.turns + 1 },
        }
      }
      return outcome
    } finally {
      this.compareTargets.delete(p.id)
    }
  }

  /**
   * Run `jobs` (each a participant and the questions it answers, in order).
   * Together: participants run at once, each through its own questions. One by
   * one: strictly in order, awaiting each answer. A failed answer never blocks
   * the next; an abort stops the run between or during turns.
   */
  async runCompareJobs(
    jobs: Array<{ participant: Participant; questions: Array<string | null> }>,
    onAnswered?: (p: Participant) => void
  ) {
    const oneByOne = compareRunOf(this.room) === 'one-by-one'
    const runJob = async (job: (typeof jobs)[number]) => {
      for (const q of job.questions) {
        this.checkAbort()
        const limit = this.breach(true)
        if (limit) throw new LimitStop(limit)
        await this.compareAnswer(job.participant, q)
        onAnswered?.(job.participant)
        // Together, answers land at once: the room is saved once they all have.
        if (oneByOne) await this.save()
      }
    }
    if (oneByOne) {
      for (const job of jobs) await runJob(job)
      return
    }
    // Participants on the same local engine cannot run together (they share its
    // model slots): each engine's participants run in turn, the rest at once.
    const lanes = new Map<string, Array<(typeof jobs)[number]>>()
    jobs.forEach((job, i) => {
      const key = localEngineOf(job.participant) ?? `remote:${i}`
      lanes.set(key, [...(lanes.get(key) ?? []), job])
    })
    const runLane = async (lane: Array<(typeof jobs)[number]>) => {
      let failure: unknown = null
      for (const job of lane) {
        try {
          await runJob(job)
        } catch (e) {
          // An abort or a limit ends the lane; a failure lets the next one run.
          if (e instanceof RunAborted || e instanceof LimitStop || isAbortLike(e, this.signal)) throw e
          failure ??= e
        }
      }
      if (failure) throw failure
    }
    const outcomes = await Promise.allSettled([...lanes.values()].map(runLane))
    let aborted = false
    let failure: unknown = null
    let limit: LimitStop | null = null
    for (const o of outcomes) {
      if (o.status !== 'rejected') continue
      if (o.reason instanceof RunAborted || isAbortLike(o.reason, this.signal)) aborted = true
      else if (o.reason instanceof LimitStop) limit ??= o.reason
      else failure ??= o.reason
    }
    if (failure) throw failure
    if (aborted) throw new RunAborted()
    if (limit) throw limit
  }

  /**
   * Compare mode: every included participant answers the newest question, each
   * from its own context (the user and itself, see `projectHistory`), together
   * or one by one as the room says; then the room waits for the user. A round
   * cut short (pause, restart) is finished by those that have not answered.
   */
  async compareRound() {
    this.checkAbort()
    await this.drainUserMessages()
    const limit = this.breach(true)
    if (limit) return this.stopForLimit(limit)

    // Started with no question: the objective is the question, posted as one,
    // so its answers have a row in the compare grid and can be re-run.
    if (compareGrid(this.messages).questions.length === 0 && this.room.objective.trim()) {
      await this.appendMessage(
        this.message({ author: { kind: 'user' }, kind: 'user', text: this.room.objective.trim() })
      )
    }
    const grid = compareGrid(this.messages)
    const asked = grid.questions.at(-1)
    const question = asked?.id ?? null
    // A question written to one participant is answered by that one only.
    const addressedTo = asked?.to?.kind === 'participant' ? asked.to.participantId : null
    // A question nobody has answered yet opens a new round, even when the last
    // one never closed (a participant joined or was switched back on after it):
    // otherwise only the newcomers would answer it (R-044). A round cut short
    // on this same question is still finished by those left.
    const untouched =
      question !== null && (grid.answers.get(question) ?? []).length === 0
    if (untouched && this.room.round > 0 && this.room.spokenThisRound.length > 0) {
      this.room = {
        ...this.room,
        round: this.room.round + 1,
        spokenThisRound: [],
        usage: { ...this.room.usage, rounds: Math.max(this.room.usage.rounds, this.room.round) },
      }
    }
    this.room = beginSpeakingTurn({ ...this.room, nextSpeakerId: null })
    const pending = activeParticipants(this.room).filter(
      (p) => !this.room.spokenThisRound.includes(p.id)
    )
    const leftOut = (p: Participant) =>
      addressedTo !== null ? p.id !== addressedTo : !!p.compareSkip
    // Left out of this run: counted as having passed, so the round closes.
    for (const p of pending.filter(leftOut)) {
      this.room = markSpoken(this.room, p.id)
    }
    try {
      await this.runCompareJobs(
        pending.filter((p) => !leftOut(p)).map((p) => ({ participant: p, questions: [question] })),
        (p) => {
          this.room = markSpoken(this.room, p.id)
        }
      )
    } catch (e) {
      if (e instanceof LimitStop) return this.stopForLimit(e.limit)
      throw e
    }
    await this.save()
    if (!(await this.ensureEnough(2))) return
    await this.save({ status: 'awaiting-user', nextSpeakerId: null })
  }

  /** Compare rooms: answer with chosen participants, outside the round. */
  async compareRun(participantIds: string[] | null, scope: 'latest' | 'missing') {
    await this.drainUserMessages()
    const grid = compareGrid(this.messages)
    const latest = grid.questions.at(-1)
    if (!latest) {
      await this.note('askFirst')
      return
    }
    const chosen = activeParticipants(this.room).filter((p) =>
      participantIds ? participantIds.includes(p.id) : !p.compareSkip
    )
    const jobs = chosen
      .map((p) => ({
        participant: p,
        questions:
          scope === 'latest'
            ? isAskedOf(latest, p.id)
              ? [latest.id]
              : []
            : missingQuestions(grid, p.id).map((q) => q.id),
      }))
      .filter((j) => j.questions.length > 0)
    try {
      await this.runCompareJobs(jobs)
    } catch (e) {
      this.countAnsweredQuestions()
      if (e instanceof LimitStop) {
        await this.stopForLimit(e.limit)
        return false
      }
      throw e
    }
    this.countAnsweredQuestions()
    return true
  }

  /**
   * A compare room spends one round per question, and its header reads
   * `usage.rounds` as "Questions n / max". Answers given from the Run panel
   * (outside a round) never closed one, so the header stayed at 0 after a
   * question both participants had answered (RQA-013). Count the questions
   * that have an answer instead; never lower what rounds already counted.
   */
  private countAnsweredQuestions() {
    const grid = compareGrid(this.messages)
    const answered = grid.questions.filter((q) => (grid.answers.get(q.id) ?? []).length > 0).length
    if (answered > this.room.usage.rounds) {
      this.room = { ...this.room, usage: { ...this.room.usage, rounds: answered } }
    }
  }

  // ---- closing -------------------------------------------------------------

  /** Returns false when a limit stopped the room part-way. */
  async finalPositions(): Promise<boolean> {
    for (const p of activeParticipants(this.room)) {
      this.checkAbort()
      const limit = this.breach(false)
      if (limit) {
        await this.stopForLimit(limit)
        return false
      }
      const current = this.room.participants.find((x) => x.id === p.id)
      if (!current || current.removed || current.availability.state === 'unavailable') continue
      await this.participantTurn(current, 'final-position', finalPositionPrompt())
      await this.save()
    }
    return true
  }

  async synthesize(stopReason: StopReason): Promise<void> {
    if (latestFinalPositions(this.messages).length === 0) {
      if (!(await this.finalPositions())) return
    }
    this.checkAbort()
    const limit = this.breach(false)
    if (limit) return this.stopForLimit(limit)

    const positions = latestFinalPositions(this.messages).map((m) => {
      const pid = m.author.kind === 'participant' ? m.author.participantId : ''
      const p = this.room.participants.find((x) => x.id === pid)
      return { name: p?.name ?? 'participant', role: p?.role ?? '', text: m.text }
    })
    const instruction = synthesisPrompt(positions)
    const finalize: Finalize = (raw) => {
      const dissent = computeDissent(this.messages)
      return { text: composeSynthesisText(raw, dissent), dissent, to: { kind: 'user' } }
    }

    const moderator = this.moderatorReady()
    let outcome: TurnOutcome
    if (moderator.ok) {
      outcome = await this.modelTurn({
        author: { kind: 'moderator', name: this.room.moderator.name || 'Moderator' },
        speaker: { kind: 'moderator' },
        model: moderator.model,
        kind: 'synthesis',
        instruction,
        finalize,
      })
    } else {
      const first = activeParticipants(this.room)[0]
      if (!first) return this.pauseNoParticipants(rt('noSynthesisParticipant'))
      outcome = await this.participantTurn(first, 'synthesis', instruction, finalize)
    }

    if (outcome.kind === 'complete') {
      await this.save({ status: 'completed', stopReason, nextSpeakerId: null })
    } else {
      await this.note('synthesisFailed')
      await this.save({ status: 'paused', stopReason: { kind: 'error', code: 'synthesis-failed', message: rt('synthesisCallFailed') } })
    }
  }

  async close(reason: StopReason) {
    if (!(await this.finalPositions())) return
    await this.synthesize(reason)
  }

  async vote(proposal: string) {
    const text = truncate(proposal.trim())
    const call = await this.appendMessage(
      this.message({ author: { kind: 'user' }, kind: 'vote-call', text })
    )
    for (const p of activeParticipants(this.room)) {
      this.checkAbort()
      const limit = this.breach(false)
      if (limit) {
        await this.stopForLimit(limit)
        return false
      }
      await this.participantTurn(p, 'vote', votePrompt(text), (raw) => {
        const parsed = parseVote(raw)
        return { text: raw, vote: { callId: call.id, choice: parsed.choice, proposal: text } }
      })
      await this.save()
    }
    await this.system(renderTally(tallyVotes(this.messages, call.id)))
    return true
  }
}

/**
 * Run one engine command for a room. Resolves with the final room state.
 * Guaranteed to terminate: every iteration makes a model call or returns,
 * and calls are capped per run by the hard ceiling.
 */
export async function runRoom(
  roomId: string,
  deps: EngineDeps,
  signal: AbortSignal,
  options: RunOptions = {}
): Promise<Room> {
  const run = new RoomRun(roomId, deps, signal, options)
  await run.load()
  const command = options.command ?? { kind: 'discuss' }
  const previous = run.room.status
  const previousReason = run.room.stopReason
  run.activeSince = deps.now()

  try {
    run.checkAbort()
    switch (command.kind) {
      case 'discuss':
        await run.discuss()
        break
      case 'vote': {
        if (!(await run.preflight(1))) break
        await run.save({ status: 'running' })
        await run.drainUserMessages()
        if (await run.vote(command.proposal)) {
          await run.save({ status: settleAfterCommand(previous), stopReason: previousReason })
        }
        break
      }
      case 'final-positions': {
        if (!(await run.preflight(1))) break
        await run.save({ status: 'running' })
        if (await run.finalPositions()) {
          await run.save({ status: settleAfterCommand(previous), stopReason: previousReason })
        }
        break
      }
      case 'compare-run': {
        // Running a participant again is the user's retry: a model that failed
        // to load (or found its slot busy) is tried again, not skipped.
        run.room = clearSuspensions(
          run.room,
          command.participantIds ??
            run.room.participants.filter((p) => !p.compareSkip).map((p) => p.id)
        )
        if (!(await run.preflight(1))) break
        await run.save({ status: 'running', stopReason: null })
        if (await run.compareRun(command.participantIds, command.scope)) {
          await run.save({ status: 'awaiting-user', nextSpeakerId: null })
        }
        break
      }
      case 'synthesize': {
        if (!(await run.preflight(1))) break
        await run.save({ status: 'running' })
        await run.synthesize({ kind: 'synthesized' })
        break
      }
    }
  } catch (e) {
    if (e instanceof RunAborted || isAbortLike(e, signal)) {
      await run.handleAbort()
    } else {
      const raw = e instanceof Error ? e.message : String(e)
      const message = redactSecrets(raw.replace(/\s+/g, ' ').trim()).slice(0, 300)
      const storage = isRoomPersistenceError(e)
      const code: string = isRoomPersistenceError(e) ? e.code : 'engine'
      try {
        await (storage
          ? run.note('storageFailed', { code, message })
          : run.note('internalError', { message }))
        await run.save({ status: 'paused', stopReason: { kind: 'error', code, message } })
      } catch {
        // Persistence itself failed; the caller reports the original error.
      }
      throw e
    }
  } finally {
    run.emit({ type: 'live', roomId, live: null })
  }
  return run.room
}

export { HARD_CALL_CEILING as ENGINE_CALL_CEILING }
