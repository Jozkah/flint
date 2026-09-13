/**
 * One answer to "what happened in this run", derived from evidence.
 *
 * Several surfaces talk about a finished run: the run notice says how it
 * stopped, the summary says what changed, the Changes rail shows the diff and
 * the rewind list offers a way back. Each of them used to decide for itself
 * whether the run "worked". This is the single derivation they read instead,
 * so a run cannot be reported as finished in one place and failed in another.
 *
 * Everything here is counted from records the application wrote — the origin
 * ledger, the tool rows of the transcript and their exit codes, the run's own
 * stop reason. The assistant's prose is read for one thing only: statements
 * about checks, which are kept apart as `claims` and never counted as a check
 * that ran.
 *
 * Pure, and free of React and i18n, so it can be tested exhaustively and every
 * caller gets the same result for the same inputs.
 */
import type { CoworkTurn } from '@/types/coworkSession'
import type { RunOutcome as RunnerOutcome } from '@/lib/coworkRunner'
import type { CheckpointDestination } from '@/hooks/useCoworkCheckpoints'
import {
  janAuthoredPaths,
  type BaselineState,
  type ChangeDestination,
  type CompletionSummary,
} from '@/lib/coworkOrigins'
import { parseBashOutput } from '@/lib/toolPresentation'

export type RunStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial'
  | 'running'

/** How the runner said the run ended. `done` is a normal finish. */
export type StopReason = RunnerOutcome['stoppedBy']

export type CheckKind = 'command' | 'test' | 'build' | 'lint'

export type CheckOutcome = 'passed' | 'failed' | 'not-run' | 'unknown'

/** A check Jan actually executed, as the tool record shows it. */
export type ObservedCheck = {
  kind: CheckKind
  command: string
  outcome: CheckOutcome
  /** Always observed: built only from a recorded tool execution. */
  evidence: 'observed'
  /** The command's exit status, when the tool reported one. */
  exitCode: number | null
  callId?: string
}

/**
 * Something the assistant said about a check, in its own words.
 *
 * Never upgraded to a check: the model writes the transcript this comes from,
 * and "all tests pass" costs it nothing to say.
 */
export type CheckClaim = {
  kind: Exclude<CheckKind, 'command'>
  text: string
  evidence: 'assistant-text'
  verified: false
}

export type UnresolvedItem =
  /** The run stopped for a reason other than finishing. */
  | { kind: 'stop'; reason: Exclude<StopReason, 'done'>; message?: string }
  /** A tool call the permission gate or the user refused. */
  | { kind: 'refused'; tool: string; target: string }
  /** A tool call cancelled before it finished. */
  | { kind: 'cancelled'; tool: string; target: string }
  /** A tool call that failed or timed out. Checks are reported separately. */
  | { kind: 'failed'; tool: string; target: string }
  /** A tool call still waiting or running when the run ended. */
  | { kind: 'interrupted'; tool: string; target: string }
  /** An observed check that did not pass. */
  | { kind: 'check-failed'; command: string; exitCode: number | null }

/**
 * Next steps, each backed by a handler the caller said it has.
 *
 * Nothing is offered on the strength of it being a good idea: an action whose
 * handler is missing is left out rather than rendered as a dead button.
 */
export type NextAction =
  | 'open-result'
  | 'review-changes'
  | 'continue'
  | 'retry'
  | 'restore'

export type TreeKind = 'sandbox' | 'worktree' | 'user-checkout' | 'none'

export type HeadlineCode =
  | 'running'
  | 'completed-with-changes'
  | 'completed-no-changes'
  | 'completed-checks-failed'
  | 'partial'
  | 'failed'
  | 'cancelled'

export type RunOutcome = {
  status: RunStatus
  headline: HeadlineCode
  /** Null while running or after a normal finish. */
  stopReason: Exclude<StopReason, 'done'> | null
  /** Where this outcome came from, so it can be tied back to its run. */
  source: {
    sessionId: string | null
    runId: string | null
    finishedAt: number | null
  }
  resultLocation: {
    destination: ChangeDestination | null
    treeKind: TreeKind
    /** The working tree the paths are relative to, when there is one. */
    tree: string | null
    /** Files Jan itself wrote. */
    paths: string[]
  }
  changes: {
    /** False when no ledger was recorded, so nothing is known either way. */
    known: boolean
    janAuthored: { destination: ChangeDestination; paths: string[] }[]
    janWritesOverExisting: string[]
    observed: string[]
    preExisting: string[]
    unknown: string[]
    baseline: BaselineState | 'none'
  }
  checks: ObservedCheck[]
  claims: CheckClaim[]
  unresolved: UnresolvedItem[]
  nextActions: NextAction[]
  /** At least one successful Jan write or completed tool step. */
  progress: boolean
}

export type RunOutcomeInput = {
  running: boolean
  /** Null when no ending was recorded (treated as a normal finish). */
  stoppedBy: StopReason | null
  errorText?: string
  /** The session transcript. Only the last run's slice is read. */
  turns: readonly CoworkTurn[]
  summary: CompletionSummary | null
  /** The run's frozen destination, when a run published one. */
  destination: ChangeDestination | null
  /** The tree the run's changes land in. */
  tree: string | null
  sessionId: string | null
  runId?: string | null
  finishedAt?: number | null
  /** The session's recorded checkpoints. */
  checkpoints: readonly { root: string; destination: CheckpointDestination }[]
  /** Which next-step handlers the caller can actually carry out. */
  handlers: {
    openResult: boolean
    reviewChanges: boolean
    continue: boolean
    retry: boolean
  }
}

/**
 * Stop reasons whose notice already offers "Try again".
 *
 * Mirrors the kinds `CoworkRunNotice` renders with `onRetry`. A budget stop
 * has its own notice with its own remedies and is not retried from here.
 */
export const RETRYABLE_STOPS: ReadonlySet<StopReason> = new Set<StopReason>([
  'error',
  'deadline',
  'timeout',
  'loop',
])

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

/** Wrappers that run another command, stripped before classifying. */
const WRAPPERS =
  /^(?:(?:sudo|time|env|nice|npx|bunx|pnpx|dotenv|cross-env)\s+(?:--?\S+\s+)*|(?:pnpm|yarn|npm)\s+exec\s+(?:--\s+)?|(?:uv|poetry|pipenv|hatch|pdm|rye)\s+run\s+|bundle\s+exec\s+|python3?\s+-m\s+|py\s+-m\s+)/i

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/

type Rule = { kind: CheckKind; pattern: RegExp }

/**
 * Known runners, most specific kind first.
 *
 * The same ecosystems AH-070's project tooling detection recognises on the
 * Rust side (`core/agent/tooling.rs`). That detection answers "which runner
 * does this project use", not "is this command a test", and lives behind a
 * per-folder scan, so the command shapes are matched here directly.
 */
const RULES: Rule[] = [
  // Tests.
  {
    kind: 'test',
    pattern:
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?(?:\s|$)|^npm\s+t(?:\s|$)|^bun\s+test(?:\s|$)/i,
  },
  {
    kind: 'test',
    pattern:
      /^(?:vitest|jest|mocha|ava|tap|karma|jasmine|cypress\s+run|playwright\s+test|pytest|py\.test|nose2?|tox|nox|unittest|rspec|phpunit|pest|ctest)(?:\s|$)/i,
  },
  {
    kind: 'test',
    pattern:
      /^(?:cargo\s+(?:test|nextest)|go\s+test|dotnet\s+test|swift\s+test|deno\s+test|mix\s+test|rake\s+(?:test|spec)|(?:mvn|mvnw|\.\/mvnw)\s+(?:\S+\s+)*(?:test|verify)|(?:gradle|gradlew|\.\/gradlew)\s+(?:\S+\s+)*(?:test|check)|make\s+(?:test|check)|flutter\s+test)(?:\s|$)/i,
  },
  // Static checks.
  {
    kind: 'lint',
    pattern:
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck|type-check|check-types|tsc)(?::\S+)?(?:\s|$)/i,
  },
  {
    kind: 'lint',
    pattern:
      /^(?:eslint|oxlint|biome\s+(?:check|lint)|prettier\s+(?:\S+\s+)*--check|ruff(?:\s+check)?|flake8|pylint|mypy|pyright|black\s+(?:\S+\s+)*--check|rubocop|golangci-lint|go\s+vet|staticcheck|cargo\s+(?:check|clippy|fmt\s+(?:\S+\s+)*--check)|clippy-driver|tsc\s+(?:\S+\s+)*--noEmit|dotnet\s+format\s+(?:\S+\s+)*--verify-no-changes|shellcheck|stylelint)(?:\s|$)/i,
  },
  // Builds.
  {
    kind: 'build',
    pattern:
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?::\S+)?(?:\s|$)/i,
  },
  {
    kind: 'build',
    pattern:
      /^(?:tsc|vite\s+build|next\s+build|webpack|rollup|esbuild|cargo\s+build|go\s+build|dotnet\s+build|swift\s+build|(?:mvn|mvnw|\.\/mvnw)\s+(?:\S+\s+)*(?:compile|package|install)|(?:gradle|gradlew|\.\/gradlew)\s+(?:\S+\s+)*(?:build|assemble)|make|cmake\s+--build|ninja|msbuild|tauri\s+build|flutter\s+build)(?:\s|$)/i,
  },
  // Project scripts that are checks by name but not a known runner.
  {
    kind: 'command',
    pattern:
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|verify|validate|ci)(?::\S+)?(?:\s|$)/i,
  },
]

const PRIORITY: CheckKind[] = ['test', 'build', 'lint', 'command']

/** One simple command, with environment and wrappers removed. */
function normalizeSegment(segment: string): string {
  let s = segment.trim().replace(/^\(+|\)+$/g, '').trim()
  // Assignments and wrappers can be stacked (`CI=1 npx vitest`), so strip
  // until nothing changes.
  for (let i = 0; i < 6; i++) {
    const next = s.replace(ENV_ASSIGNMENT, '').replace(WRAPPERS, '').trim()
    if (next === s) break
    s = next
  }
  return s
}

/**
 * What kind of check a shell command is, or null when it is not one.
 *
 * A compound command (`cd web-app && npx vitest run`) is split on its
 * operators and classified by the most significant check it contains, so a
 * build followed by the tests reads as the tests.
 */
export function classifyCommand(command: string): CheckKind | null {
  const segments = command.split(/&&|\|\||;|\||\n/)
  let best: CheckKind | null = null
  for (const raw of segments) {
    const segment = normalizeSegment(raw)
    if (!segment || /^cd\s/i.test(segment)) continue
    const rule = RULES.find((one) => one.pattern.test(segment))
    if (!rule) continue
    if (!best || PRIORITY.indexOf(rule.kind) < PRIORITY.indexOf(best)) {
      best = rule.kind
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

/**
 * The turns of the most recent run.
 *
 * A run starts at a user row. A steered row was typed into a run already
 * going, so it does not start a new one.
 */
export function lastRunTurns(turns: readonly CoworkTurn[]): CoworkTurn[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn.role === 'user' && !turn.steered) return turns.slice(i + 1)
  }
  return [...turns]
}

const argsOf = (turn: CoworkTurn): Record<string, unknown> => {
  const args = turn.args
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
}

const targetOf = (turn: CoworkTurn): string => {
  const args = argsOf(turn)
  for (const field of ['path', 'file_path', 'command', 'url', 'pattern', 'resource']) {
    const value = args[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

type ToolPhase = NonNullable<CoworkTurn['toolState']> | 'done-ok' | 'done-error'

/** What became of a tool row, reading the newer state before the older one. */
function phaseOf(turn: CoworkTurn): ToolPhase {
  const refusedByGate =
    turn.permission === 'denied' || turn.permission === 'prompted-denied'
  if (refusedByGate) return 'refused'
  if (turn.toolState) return turn.toolState
  if (turn.status === 'running') return 'running'
  return turn.isError ? 'done-error' : 'done-ok'
}

const isUnfinished = (phase: ToolPhase) =>
  phase === 'requested' ||
  phase === 'awaiting-permission' ||
  phase === 'running'

/** The exit status a command reported, from the row or its output. */
function exitCodeOf(turn: CoworkTurn): { code: number | null; signaled: boolean } {
  if (typeof turn.exitCode === 'number') {
    return { code: turn.exitCode, signaled: false }
  }
  if (typeof turn.result !== 'string' || !turn.result) {
    return { code: null, signaled: false }
  }
  const parsed = parseBashOutput(turn.result)
  return { code: parsed.exit ?? null, signaled: parsed.signaled }
}

function checkFromTurn(turn: CoworkTurn): ObservedCheck | null {
  if (turn.role !== 'tool' || turn.name !== 'bash') return null
  const command = argsOf(turn).command
  // Polling a background job is not running anything.
  if (typeof command !== 'string' || !command.trim()) return null
  const kind = classifyCommand(command)
  if (!kind) return null

  const phase = phaseOf(turn)
  const { code, signaled } = exitCodeOf(turn)
  let outcome: CheckOutcome
  if (phase === 'refused') outcome = 'not-run'
  else if (isUnfinished(phase)) outcome = 'unknown'
  else if (code === 0 && !signaled) outcome = 'passed'
  else if (code !== null || signaled) outcome = 'failed'
  else if (phase === 'cancelled') outcome = 'not-run'
  // Finished without an exit status — an error before the command ran, or a
  // tool that reported nothing. Neither proves a pass or a failure.
  else outcome = 'unknown'

  return {
    kind,
    command: command.trim(),
    outcome,
    evidence: 'observed',
    exitCode: code,
    callId: turn.callId,
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const CLAIM_SUBJECT: { kind: CheckClaim['kind']; pattern: RegExp }[] = [
  { kind: 'test', pattern: /\b(?:tests?|test suite|specs?)\b/i },
  { kind: 'lint', pattern: /\b(?:lint(?:er|ing)?|type-?check(?:s|ing|er)?|typecheck)\b/i },
  { kind: 'build', pattern: /\b(?:build(?:s)?|compil(?:es|ed|ation))\b/i },
]
const CLAIM_SUCCESS =
  /\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|successful(?:ly)?|green|clean(?:ly)?|all good|no (?:errors|failures))\b/i
/** A hedge or negation: not a claim of success, and not ours to reinterpret. */
const CLAIM_HEDGE =
  /\b(?:not|never|no longer|didn'?t|doesn'?t|couldn'?t|can'?t|cannot|unable|should|would|could|might|may|if|once|after you|try|run the|please|failed|failing|fails)\b/i

const MAX_CLAIMS = 3
const MAX_CLAIM_LENGTH = 200

/**
 * Sentences in the final assistant message asserting that a check succeeded.
 *
 * Deliberately narrow: a sentence has to name a check and assert success
 * without hedging. Missing a claim costs nothing — nothing is upgraded from
 * it — while inventing one would put words in the model's mouth.
 */
export function claimsFromText(text: string): CheckClaim[] {
  const claims: CheckClaim[] = []
  const sentences = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
  for (const raw of sentences) {
    const sentence = raw.replace(/^[\s*>#-]+/, '').trim()
    if (!sentence || !CLAIM_SUCCESS.test(sentence) || CLAIM_HEDGE.test(sentence))
      continue
    const subject = CLAIM_SUBJECT.find((one) => one.pattern.test(sentence))
    if (!subject) continue
    claims.push({
      kind: subject.kind,
      text:
        sentence.length > MAX_CLAIM_LENGTH
          ? `${sentence.slice(0, MAX_CLAIM_LENGTH - 1)}…`
          : sentence,
      evidence: 'assistant-text',
      verified: false,
    })
    if (claims.length >= MAX_CLAIMS) break
  }
  return claims
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const treeKindOf = (destination: ChangeDestination | null): TreeKind => {
  switch (destination) {
    case 'sandbox':
      return 'sandbox'
    case 'managed':
      return 'worktree'
    case 'repository':
      return 'user-checkout'
    default:
      return 'none'
  }
}

export function deriveRunOutcome(input: RunOutcomeInput): RunOutcome {
  const runTurns = lastRunTurns(input.turns)
  const toolTurns = runTurns.filter((turn) => turn.role === 'tool')
  const summary = input.summary
  const paths = summary ? janAuthoredPaths(summary) : []

  const checks: ObservedCheck[] = []
  const checkCalls = new Set<CoworkTurn>()
  for (const turn of toolTurns) {
    const check = checkFromTurn(turn)
    if (check) {
      checks.push(check)
      checkCalls.add(turn)
    }
  }

  const lastAssistant = [...runTurns]
    .reverse()
    .find((turn) => turn.role === 'assistant' && turn.content.trim())
  const claims = lastAssistant ? claimsFromText(lastAssistant.content) : []

  const stopReason =
    input.running || !input.stoppedBy || input.stoppedBy === 'done'
      ? null
      : input.stoppedBy

  const unresolved: UnresolvedItem[] = []
  if (stopReason) {
    unresolved.push({
      kind: 'stop',
      reason: stopReason,
      ...(input.errorText?.trim() ? { message: input.errorText.trim() } : {}),
    })
  }
  for (const turn of toolTurns) {
    const phase = phaseOf(turn)
    const tool = turn.name ?? ''
    const target = targetOf(turn)
    if (phase === 'refused') unresolved.push({ kind: 'refused', tool, target })
    else if (phase === 'cancelled' && !checkCalls.has(turn))
      unresolved.push({ kind: 'cancelled', tool, target })
    else if (
      !input.running &&
      isUnfinished(phase) &&
      !checkCalls.has(turn)
    )
      unresolved.push({ kind: 'interrupted', tool, target })
    else if (
      (phase === 'failed' || phase === 'timed-out' || phase === 'done-error') &&
      !checkCalls.has(turn)
    )
      unresolved.push({ kind: 'failed', tool, target })
  }
  for (const check of checks) {
    if (check.outcome === 'failed')
      unresolved.push({
        kind: 'check-failed',
        command: check.command,
        exitCode: check.exitCode,
      })
  }

  const completedStep = toolTurns.some((turn) => {
    const phase = phaseOf(turn)
    return phase === 'succeeded' || phase === 'done-ok'
  })
  const progress = paths.length > 0 || completedStep

  let status: RunStatus
  if (input.running) status = 'running'
  else if (!stopReason) status = 'completed'
  else if (progress) status = 'partial'
  else if (stopReason === 'aborted') status = 'cancelled'
  else status = 'failed'

  const failedChecks = checks.some((check) => check.outcome === 'failed')
  let headline: HeadlineCode
  switch (status) {
    case 'running':
      headline = 'running'
      break
    case 'completed':
      headline = failedChecks
        ? 'completed-checks-failed'
        : paths.length > 0
          ? 'completed-with-changes'
          : 'completed-no-changes'
      break
    default:
      headline = status
  }

  const observed = summary?.observed ?? []
  const nextActions: NextAction[] = []
  if (status !== 'running') {
    if (input.handlers.openResult && paths.length > 0)
      nextActions.push('open-result')
    if (input.handlers.reviewChanges && paths.length + observed.length > 0)
      nextActions.push('review-changes')
    if (input.handlers.retry && stopReason && RETRYABLE_STOPS.has(stopReason))
      nextActions.push('retry')
    if (
      input.destination === 'managed' &&
      input.tree &&
      input.checkpoints.some(
        (point) => point.root === input.tree && point.destination === 'managed'
      )
    )
      nextActions.push('restore')
    if (input.handlers.continue) nextActions.push('continue')
  }

  return {
    status,
    headline,
    stopReason,
    source: {
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      finishedAt: input.running ? null : (input.finishedAt ?? null),
    },
    resultLocation: {
      destination: input.destination,
      treeKind: treeKindOf(input.destination),
      tree: input.tree,
      paths,
    },
    changes: {
      known: summary !== null,
      janAuthored: summary?.janWrites.map((group) => ({ ...group })) ?? [],
      janWritesOverExisting: summary?.janWritesOverExisting ?? [],
      observed,
      preExisting: summary?.preExisting ?? [],
      unknown: summary?.unknown ?? [],
      baseline: summary?.baseline ?? 'none',
    },
    checks,
    claims,
    unresolved,
    nextActions,
    progress,
  }
}

/**
 * Whether the outcome has anything worth a panel.
 *
 * A clean finish that wrote nothing, ran no checks and left nothing behind is
 * an ordinary answer, and a panel under it would be noise. Anything that did
 * not finish cleanly is always shown, because its preserved progress and its
 * loose ends are exactly what someone needs to see.
 */
export function shouldShowRunOutcome(outcome: RunOutcome): boolean {
  if (outcome.status === 'running') return false
  if (outcome.status !== 'completed') return true
  return (
    outcome.resultLocation.paths.length > 0 ||
    outcome.checks.length > 0 ||
    outcome.claims.length > 0 ||
    outcome.unresolved.length > 0
  )
}

/** Checks that actually produced a verdict. */
export const verifiedChecks = (outcome: RunOutcome): ObservedCheck[] =>
  outcome.checks.filter(
    (check) => check.outcome === 'passed' || check.outcome === 'failed'
  )
