/**
 * Bounds on a Cowork run.
 *
 * The AI SDK cannot enforce these for us: Flint's tools are declared without an
 * `execute`, so `streamText` returns after a single step and its `stopWhen`
 * conditions never evaluate. The loop is the runner's, so the caps are too —
 * and without them an agent with real tools has no upper bound at all.
 */

/** Model turns in one user request. Generous: real work runs long. */
export const MAX_AGENT_STEPS = 100

/** Tighter for a nested run, which should be a focused errand. */
export const MAX_SUBAGENT_STEPS = 30

/**
 * Token spend for one user request, matching what the Rust loop enforced.
 *
 * Per request, not per session, because that is where `SessionBudget` actually
 * lives in Rust: it is constructed inside `run_orchestration_streamed`, so each
 * request gets its own allowance.
 */
export const MAX_SESSION_TOKENS = 200_000

export type BudgetState = {
  step: number
  sessionTokens: number
}

/**
 * Running spend, and what is needed to charge only the *new* tokens.
 *
 * `lastTotal`/`lastPrompt` exist because every step of an agent turn replays the
 * whole conversation, so each step's `total_tokens` includes the prompt again.
 * Summing those totals charges the same context 20+ times over and trips the cap
 * a few steps into a run that is nowhere near it.
 */
export type SpendState = {
  spent: number
  lastTotal: number
  lastPrompt?: number
}

export const newSpend = (spent = 0): SpendState => ({ spent, lastTotal: 0 })

/**
 * Fold one step's usage into the running spend.
 *
 * Charges new completion tokens plus positive prompt *growth*, not replayed
 * prompt history; the first step of a request uses its reported total as the
 * baseline. Falls back through progressively weaker signals because providers
 * omit different usage fields. Ported from `core/agent/session.rs::record`.
 */
export function recordSpend(
  state: SpendState,
  usage: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
): SpendState {
  if (!usage) return state
  const { prompt_tokens: prompt, completion_tokens: completion } = usage
  const total = usage.total_tokens
  const gap = (a: number, b: number) => Math.max(0, a - b)

  let delta: number
  let lastTotal = state.lastTotal
  if (total != null) {
    if (prompt != null && state.lastPrompt != null && completion != null) {
      delta = completion + gap(prompt, state.lastPrompt)
    } else if (prompt != null && state.lastPrompt == null) {
      delta = total
    } else if (state.lastPrompt != null && completion != null) {
      delta = Math.max(completion, gap(total, state.lastTotal))
    } else {
      delta = gap(total, state.lastTotal)
    }
    lastTotal = total
  } else {
    delta = completion ?? 0
  }

  return {
    spent: state.spent + delta,
    lastTotal,
    lastPrompt: prompt ?? state.lastPrompt,
  }
}

export type BudgetStop = 'steps' | 'tokens' | null

/** Which cap, if any, this run has reached. */
export function budgetExceeded(
  state: BudgetState,
  maxSteps: number = MAX_AGENT_STEPS
): BudgetStop {
  if (state.step >= maxSteps) return 'steps'
  if (state.sessionTokens >= MAX_SESSION_TOKENS) return 'tokens'
  return null
}

/**
 * Room kept for the model's own reply. AH-088.
 *
 * A request that exactly fills the window is not a request that fits: the
 * model still has to answer inside it. Providers differ in how they fail when
 * it does not -- some truncate the conversation silently, which is the worst
 * of them -- so the headroom is reserved here, before dispatch, rather than
 * discovered afterwards.
 */
export const REPLY_RESERVE_FRACTION = 0.15
export const MIN_REPLY_RESERVE = 512
export const MAX_REPLY_RESERVE = 8192

export function replyReserveFor(window: number): number {
  return Math.min(
    MAX_REPLY_RESERVE,
    Math.max(MIN_REPLY_RESERVE, Math.floor(window * REPLY_RESERVE_FRACTION))
  )
}

export type TurnPlanStatus = 'unknown' | 'fits' | 'tight' | 'over'

export type TurnPlan = {
  status: TurnPlanStatus
  /** The window in force, when it is known. */
  window: number | null
  /** What the request is expected to carry. */
  projected: number
  /** Tokens held back for the reply. */
  reserve: number
  /** How far past the window the request would be. Zero unless `over`. */
  overBy: number
}

/**
 * Decide whether this turn can be dispatched as it stands.
 *
 * An unknown window is reported as unknown and never as a refusal: refusing to
 * send because Flint could not discover a limit would make an unreadable server
 * unusable, which is worse than the request the server itself would reject.
 */
export function planTurn(input: {
  projected: number
  window: number | null | undefined
}): TurnPlan {
  const { projected } = input
  const window = input.window ?? null
  if (window == null || window <= 0) {
    return { status: 'unknown', window: null, projected, reserve: 0, overBy: 0 }
  }

  const reserve = replyReserveFor(window)
  const ceiling = window - reserve
  if (projected > ceiling) {
    return {
      status: 'over',
      window,
      projected,
      reserve,
      // What has to go for the request to fit, reply space included.
      overBy: projected - ceiling,
    }
  }
  // Close enough that the next tool result is likely to push it over, which is
  // worth saying while there is still room to act on it.
  const tight = projected > ceiling - reserve
  return {
    status: tight ? 'tight' : 'fits',
    window,
    projected,
    reserve,
    overBy: 0,
  }
}

/** Raised instead of dispatching a request that cannot fit. */
export class ContextOverflowError extends Error {
  readonly plan: TurnPlan
  constructor(plan: TurnPlan) {
    super(
      `the request needs about ${plan.projected.toLocaleString()} tokens and the window is ${(plan.window ?? 0).toLocaleString()}, with ${plan.reserve.toLocaleString()} kept for the reply`
    )
    this.name = 'ContextOverflowError'
    this.plan = plan
  }
}

export function isContextOverflow(error: unknown): error is ContextOverflowError {
  return error instanceof ContextOverflowError
}
