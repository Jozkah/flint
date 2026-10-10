/**
 * The context window a local model needs to be usable from Claude Code.
 *
 * Claude Code opens with a system prompt, tool schemas and project context that
 * add up to roughly 24k tokens before the first question, so a model loaded
 * with Flint's default 8192-token context answers every request with an
 * `exceed_context_size_error` (janhq/jan#8108).
 *
 * This only decides; applying the result goes through the same
 * `updateModelSettings` + reload path the "Increase Context Size" button uses.
 */

import {
  assessModelFit,
  DEFAULT_CTX_LENGTH,
  type FitInput,
} from '@/lib/modelCompatibility'

/** Workable context for Claude Code. */
export const CLAUDE_CODE_MIN_CONTEXT = 32768

/** The smallest context worth raising to; below this Claude Code cannot work. */
const LADDER_FLOOR = 8192

export type ClaudeCodeContextShortfall = {
  /** The context the model will run with. */
  context: number
  /**
   * Why it is below the target: the model was trained for less, the device's
   * memory cannot hold more, or the user set a smaller value that still wins.
   */
  reason: 'trained' | 'memory' | 'user-setting'
}

export type ClaudeCodeContextPlan = {
  target: number
  /** The context the model runs with once the plan is applied; null if unknown. */
  context: number | null
  /** A new `ctx_len` to write, or null when nothing should change. */
  raiseTo: number | null
  shortfall: ClaudeCodeContextShortfall | null
}

export type PlanInput = {
  /** The model's `ctx_len` setting: a number, or empty for "let the engine pick". */
  configured: number | string | null | undefined
  /** The context the model was trained for, from its GGUF header. */
  trainedContext?: number | null
  /** Whether llama.cpp's auto-fit is on, which owns an unset context. */
  fitEnabled: boolean
  /** Whether `context` tokens fit this device's memory. */
  fitsAt: (context: number) => boolean
}

function positive(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * Picks the context a model should run with for Claude Code.
 *
 * A value the user chose always wins. The seeded default (8192), or an empty
 * value with auto-fit off, is not a choice, so it is raised as far as the
 * trained maximum and the device's memory allow, up to the target.
 */
export function planClaudeCodeContext(input: PlanInput): ClaudeCodeContextPlan {
  const trained = positive(input.trainedContext)
  const target = trained
    ? Math.min(CLAUDE_CODE_MIN_CONTEXT, trained)
    : CLAUDE_CODE_MIN_CONTEXT
  const configured = positive(input.configured)
  const isDefault = configured === null || configured === DEFAULT_CTX_LENGTH

  // The largest step of the ladder, target first, that fits in memory.
  let ceiling: number | null = null
  for (let c = target; c >= LADDER_FLOOR; c = Math.floor(c / 2)) {
    if (input.fitsAt(c)) {
      ceiling = c
      break
    }
  }

  const shortfallOf = (
    context: number,
    userChosen: boolean
  ): ClaudeCodeContextShortfall | null => {
    if (context >= CLAUDE_CODE_MIN_CONTEXT) return null
    if (trained && trained < CLAUDE_CODE_MIN_CONTEXT && context >= trained) {
      return { context, reason: 'trained' }
    }
    if (userChosen && (ceiling === null || ceiling > context)) {
      return { context, reason: 'user-setting' }
    }
    return { context, reason: 'memory' }
  }

  // Auto-fit with nothing set: llama.cpp sizes the context to memory itself.
  if (configured === null && input.fitEnabled) {
    return { target, context: null, raiseTo: null, shortfall: null }
  }

  if (!isDefault) {
    return {
      target,
      context: configured,
      raiseTo: null,
      shortfall: shortfallOf(configured!, true),
    }
  }

  const current = configured ?? DEFAULT_CTX_LENGTH
  const next = ceiling !== null && ceiling > current ? ceiling : current
  return {
    target,
    context: next,
    raiseTo: next > current ? next : null,
    shortfall: shortfallOf(next, false),
  }
}

/** Memory check for `planClaudeCodeContext`: only a clear "exceeds" blocks. */
export function fitCheckFor(
  base: Omit<FitInput, 'ctxLength'>
): (context: number) => boolean {
  return (context) =>
    assessModelFit({ ...base, ctxLength: context }).verdict !== 'exceeds'
}
