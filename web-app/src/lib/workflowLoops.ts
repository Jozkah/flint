/**
 * Declarative loops for `workflow` phases (docs/WORKFLOWS.md, section 4).
 *
 * `repeat_until` is expanded into a static graph before anything runs: the
 * phase's agents once per round, and a check agent after every round but the
 * last. [`wrapLoops`] then decides, as each of those tasks starts, whether the
 * loop has already stopped; a stopped loop's remaining tasks hand back the last
 * round that really ran instead of running. There is no script, no `eval` and
 * no interpreter here, on purpose: see "No script runtime" in the design note.
 */
import type { TaskResult, TeamTask } from '@/lib/coworkTeam'

export const MAX_LOOP_ROUNDS = 5
export const DEFAULT_LOOP_ROUNDS = 3
/** Tasks a workflow may expand to once it holds a loop; without one the team cap stands. */
export const MAX_LOOP_TASKS = 40

export type RepeatUntil = {
  check: string
  maxRounds: number
  stopWhenNoProgress: boolean
}

/** Marks a task as one step of an expanded loop. */
export type LoopMeta = {
  /** The phase index it belongs to. */
  phase: number
  round: number
  kind: 'agent' | 'check'
  /** The agent id it repeats (`kind: 'agent'`). */
  base?: string
  max: number
  noProgress: boolean
}

export const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['done', 'reason'],
  additionalProperties: false,
} as const

type Raw = Record<string, unknown>

/** The `repeat_until` of a phase, or a sentence naming the field that is wrong. */
export function parseRepeatUntil(raw: unknown, at: string): RepeatUntil | string | null {
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${at}.repeat_until must be an object`
  const one = raw as Raw
  const check = typeof one.check === 'string' ? one.check.trim() : ''
  if (!check) return `${at}.repeat_until.check is empty; it is the brief of the agent that decides whether to go on`
  let maxRounds = DEFAULT_LOOP_ROUNDS
  if (one.max_rounds !== undefined) {
    if (!Number.isInteger(one.max_rounds) || (one.max_rounds as number) < 1 || (one.max_rounds as number) > MAX_LOOP_ROUNDS) {
      return `${at}.repeat_until.max_rounds must be a whole number from 1 to ${MAX_LOOP_ROUNDS}`
    }
    maxRounds = one.max_rounds as number
  }
  if (one.stop_when_no_progress !== undefined && typeof one.stop_when_no_progress !== 'boolean') {
    return `${at}.repeat_until.stop_when_no_progress must be true or false`
  }
  return { check, maxRounds, stopWhenNoProgress: one.stop_when_no_progress !== false }
}

export const checkInstruction = (brief: string): string =>
  `${brief}\n\nYou are the check for a repeating step. Decide whether the work is finished. ` +
  'Answer only with the JSON object {"done": boolean, "reason": string}: done is true when no further round is needed.'

export const roundId = (base: string, round: number): string => (round === 1 ? base : `${base}~r${round}`)
export const checkId = (phase: number, round: number): string => `p${phase + 1}~check${round}`

/** What the agents of one phase look like before expansion. */
export type PhaseAgent = {
  id: string
  fields: Raw
}

/**
 * The tasks of one phase run `maxRounds` times with a check between rounds.
 * Round 1 keeps the agents' own ids. `previous` are the ids of the earlier
 * phase, carried into every round so a later round still sees what the phase
 * was given.
 */
export function expandLoop(
  phase: { name: string; index: number },
  agents: PhaseAgent[],
  loop: RepeatUntil,
  previous: string[]
): { tasks: Raw[]; last: string[] } {
  const tasks: Raw[] = []
  let priorAgents: string[] = []
  let priorCheck = ''
  for (let round = 1; round <= loop.maxRounds; round += 1) {
    const ids: string[] = []
    for (const agent of agents) {
      const id = roundId(agent.id, round)
      ids.push(id)
      const title = typeof agent.fields.title === 'string' && agent.fields.title ? agent.fields.title : phase.name
      tasks.push({
        ...agent.fields,
        id,
        title: round === 1 ? title : `${title} (round ${round})`,
        phase,
        loop: {
          phase: phase.index,
          round,
          kind: 'agent',
          base: agent.id,
          max: loop.maxRounds,
          noProgress: loop.stopWhenNoProgress,
        } satisfies LoopMeta,
        ...(round === 1
          ? previous.length
            ? { depends_on: previous, carry: previous }
            : {}
          : { depends_on: [priorCheck], carry: [...previous, ...priorAgents, priorCheck] }),
      })
    }
    if (round < loop.maxRounds) {
      const id = checkId(phase.index, round)
      tasks.push({
        id,
        description: checkInstruction(loop.check),
        schema: CHECK_SCHEMA,
        title: `${phase.name} check ${round}`,
        phase,
        depends_on: ids,
        carry: ids,
        loop: {
          phase: phase.index,
          round,
          kind: 'check',
          max: loop.maxRounds,
          noProgress: loop.stopWhenNoProgress,
        } satisfies LoopMeta,
      })
      priorCheck = id
    }
    priorAgents = ids
  }
  return { tasks, last: priorAgents }
}

/** Agents a phase may start at its worst: every round, and every check between them. */
export const loopWorstCase = (agents: number, maxRounds: number): number =>
  agents * maxRounds + (maxRounds - 1)

type PhaseState = {
  /** round -> agent base id -> output */
  rounds: Map<number, Map<string, string>>
  checks: Map<number, string>
  stopped?: string
}

const sameResults = (a: Map<string, string> | undefined, b: Map<string, string> | undefined): boolean => {
  if (!a || !b || a.size !== b.size || a.size === 0) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}

/** Whether a check's answer says the work is done. Anything unreadable is "not done". */
export function checkSaysDone(output: string): boolean {
  try {
    const parsed = JSON.parse(output) as { done?: unknown } | null
    return parsed?.done === true
  } catch {
    return false
  }
}

/**
 * Wrap a team's `runTask` with the loop rules. Outside the run log: a task of a
 * stopped loop is answered here and never reaches it, so it is neither replayed
 * nor saved, and a resume reaches the same stop decisions from the same saved
 * checks.
 */
export function wrapLoops(
  runTask: (task: TeamTask, signal: AbortSignal) => Promise<TaskResult>
): (task: TeamTask, signal: AbortSignal) => Promise<TaskResult> {
  const phases = new Map<number, PhaseState>()
  const stateOf = (phase: number): PhaseState => {
    let one = phases.get(phase)
    if (!one) {
      one = { rounds: new Map(), checks: new Map() }
      phases.set(phase, one)
    }
    return one
  }
  const answer = (task: TeamTask, output: string): TaskResult => ({
    taskId: task.id,
    ok: true,
    output,
    producedBy: `${task.id} (loop already stopped)`,
  })

  return async (task, signal) => {
    const loop = task.loop
    if (!loop) return runTask(task, signal)
    const state = stateOf(loop.phase)

    if (loop.kind === 'agent') {
      const base = loop.base as string
      if (loop.round > 1 && state.stopped) {
        // Hand back the last round that ran, so what follows carries it.
        const before = state.rounds.get(loop.round - 1)?.get(base) ?? ''
        const copy = state.rounds.get(loop.round) ?? new Map<string, string>()
        copy.set(base, before)
        state.rounds.set(loop.round, copy)
        return answer(task, before)
      }
      const result = await runTask(task, signal)
      if (result.ok) {
        const round = state.rounds.get(loop.round) ?? new Map<string, string>()
        round.set(base, result.output)
        state.rounds.set(loop.round, round)
      }
      return result
    }

    // A check.
    if (state.stopped) {
      return answer(task, state.checks.get(loop.round - 1) ?? JSON.stringify({ done: true, reason: state.stopped }))
    }
    if (
      loop.noProgress &&
      loop.round >= 2 &&
      sameResults(state.rounds.get(loop.round), state.rounds.get(loop.round - 1))
    ) {
      state.stopped = 'no progress: two rounds in a row returned identical results'
      const output = JSON.stringify({ done: true, reason: state.stopped })
      state.checks.set(loop.round, output)
      return answer(task, output)
    }
    const result = await runTask(task, signal)
    if (result.ok) {
      state.checks.set(loop.round, result.output)
      if (checkSaysDone(result.output)) state.stopped = 'the check said the work is done'
    }
    return result
  }
}
