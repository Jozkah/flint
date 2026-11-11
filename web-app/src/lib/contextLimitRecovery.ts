/**
 * Learning a model's real context window from the server that just refused a
 * request for exceeding it.
 *
 * This is the one moment a server tells the truth about its window without
 * being asked. Discovery (AH-195) walks the sources the app already has, and
 * for a local OpenAI-compatible endpoint that reports no metadata, all of them
 * come up empty -- until a request is too long and the refusal names the limit.
 * Throwing that away means the next request is the same guess as the last one.
 *
 * Two rules keep this from becoming a worse guess than no answer at all.
 *
 * **Structured fields before prose.** A server that puts the limit in a JSON
 * field has told us something; a server that puts it in a sentence has told us
 * something we have to parse, and parsing is where numbers get invented. Prose
 * is read only in shapes that are known, and only when the numbers make sense
 * together -- a "limit" that is not smaller than the request that overflowed it
 * is not a limit, it is a coincidence.
 *
 * **A learned limit belongs to one endpoint.** It is bound to provider, base
 * URL and model, because the same model id behind a different server is a
 * different window: `--fit` on a small machine, a different quantisation, a
 * different `-c`. Changing any of the three forgets it rather than carrying it
 * over, since a stale limit is enforced silently and a missing one is not.
 */

import { usableContextValue } from '@/lib/modelCapabilities'

/** What a refusal told us. */
export type ServerContextLimit = {
  /** The window the server says is in force. */
  contextTokens: number
  /** What the refused request measured, when the server said. */
  requestTokens: number | null
  /** Which shape it was read from, for the capability's provenance. */
  via: 'structured-field' | 'known-message'
}

/**
 * The smallest window worth believing.
 *
 * A server reporting a two-digit context is either speaking about something
 * else or is broken; enforcing it would make every subsequent request fail for
 * a reason the user cannot act on. Below this the answer is discarded and the
 * window stays unknown, which at least dispatches.
 */
const MIN_PLAUSIBLE_TOKENS = 256

/** Above this the number is not a context window; it is a byte count or an id. */
const MAX_PLAUSIBLE_TOKENS = 100_000_000

function plausible(value: unknown): number | null {
  const n = usableContextValue(value)
  if (n == null) return null
  return n >= MIN_PLAUSIBLE_TOKENS && n <= MAX_PLAUSIBLE_TOKENS ? n : null
}

/**
 * A request size, which has no floor.
 *
 * Deliberately laxer than [`plausible`]: a 100-token request is ordinary, and
 * holding it to the window's minimum would discard exactly the small number
 * that makes a contradictory pair detectable -- "request (100) exceeds the
 * context size (8192)" is not a refusal anyone could have received.
 */
function requestSize(value: unknown): number | null {
  const n = usableContextValue(value)
  return n != null && n <= MAX_PLAUSIBLE_TOKENS ? n : null
}

/**
 * Field names servers use for "the window you exceeded".
 *
 * Distinct from the discovery field list: these appear on *errors*, where
 * `max_tokens` would mean the reply cap that was rejected rather than the
 * window, and reading it as the window would shrink the model permanently.
 */
const LIMIT_FIELDS = [
  'n_ctx',
  'context_length',
  'max_context_length',
  'max_model_len',
  'context_size',
  'max_context_size',
  'model_max_context',
  'limit_tokens',
] as const

const REQUEST_FIELDS = [
  'n_prompt_tokens',
  'prompt_tokens',
  'request_tokens',
  'input_tokens',
  'n_tokens',
] as const

/** Walk an error payload for the first plausible value under `fields`. */
function readField(
  source: unknown,
  fields: readonly string[],
  depth = 0,
  accept: (value: unknown) => number | null = plausible
): number | null {
  if (!source || typeof source !== 'object' || depth > 4) return null
  const record = source as Record<string, unknown>
  for (const field of fields) {
    const value = accept(record[field])
    if (value != null) return value
  }
  // OpenAI-compatible servers nest the interesting part under `error`, and
  // llama.cpp puts a second copy of it under `error.metadata` or `data`.
  for (const nested of ['error', 'metadata', 'data', 'body', 'detail']) {
    const child = record[nested]
    if (child && typeof child === 'object') {
      const found = readField(child, fields, depth + 1, accept)
      if (found != null) return found
    }
  }
  return null
}

/**
 * Message shapes that are known to carry a window, with the capture groups in
 * (request, limit) order.
 *
 * Deliberately anchored on the words around the numbers. A bare "two numbers in
 * a sentence" match is how an error about rate limits or token pricing becomes
 * a context window.
 */
const KNOWN_MESSAGES: { pattern: RegExp; request: number; limit: number }[] = [
  // llama.cpp: "the request exceeds the available context size. try increasing
  // the context size or enable context shift" preceded by the two counts.
  {
    pattern:
      /request\s*\((\d+)\s*tokens?\)[^(]{0,80}?context size\s*\((\d+)\s*tokens?\)/i,
    request: 1,
    limit: 2,
  },
  // llama.cpp alternate: "input (N tokens) is larger than the max context size (M tokens)"
  {
    pattern:
      /input\s*\((\d+)\s*tokens?\)[^(]{0,80}?context size\s*\((\d+)\s*tokens?\)/i,
    request: 1,
    limit: 2,
  },
  // OpenAI-compatible: "This model's maximum context length is 8192 tokens.
  // However, your messages resulted in 9001 tokens."
  {
    pattern:
      /maximum context length is\s*(\d+)\s*tokens?.{0,120}?resulted in\s*(\d+)\s*tokens?/i,
    request: 2,
    limit: 1,
  },
  // OpenAI/Anthropic-compatible that splits input and output and gives a total:
  // "This model's maximum context length is 200000 tokens. However, you
  // requested 22000 output tokens and your prompt contains at least 178001 input
  // tokens, for a total of at least 200001 tokens." Here "requested 22000" is the
  // reply cap, not the request, so the total is the number that overflowed.
  // Matched before the bare "requested" shape so that reply cap is not read as
  // the request size.
  {
    pattern:
      /maximum context length is\s*(\d+)\s*tokens?.{0,200}?total of (?:at least\s*)?(\d+)\s*tokens?/i,
    request: 2,
    limit: 1,
  },
  // vLLM: "This model's maximum context length is 4096 tokens. However, you
  // requested 5000 tokens"
  {
    pattern:
      /maximum context length is\s*(\d+)\s*tokens?.{0,120}?requested\s*(\d+)\s*tokens?/i,
    request: 2,
    limit: 1,
  },
]

/**
 * The window a refusal reports, or `null` when nothing trustworthy was said.
 *
 * `payload` is the parsed error body when there is one; `message` is the text.
 * Both are consulted, structured first.
 */
export function parseServerContextLimit(
  payload: unknown,
  message?: string | null
): ServerContextLimit | null {
  const structured = readField(payload, LIMIT_FIELDS)
  if (structured != null) {
    return {
      contextTokens: structured,
      requestTokens: readField(payload, REQUEST_FIELDS, 0, requestSize),
      via: 'structured-field',
    }
  }

  const text =
    message ??
    (typeof payload === 'string'
      ? payload
      : ((payload as { message?: unknown } | null)?.message as string) ?? '')
  if (typeof text !== 'string' || text === '') return null

  for (const shape of KNOWN_MESSAGES) {
    const match = text.match(shape.pattern)
    if (!match) continue
    const limit = plausible(match[shape.limit])
    const request = requestSize(match[shape.request])
    if (limit == null) continue
    // A limit that is not smaller than the request that overflowed it did not
    // cause this refusal, so the two numbers are not what they look like.
    if (request != null && limit >= request) continue
    return { contextTokens: limit, requestTokens: request, via: 'known-message' }
  }
  return null
}

/** What a learned limit belongs to. Any change makes it a different window. */
export type EndpointBinding = {
  provider: string
  /** The base URL as configured. `''` for a provider with a fixed endpoint. */
  baseUrl: string
  model: string
}

export const bindingKey = (b: EndpointBinding): string =>
  `${b.provider} ${b.baseUrl} ${b.model}`

export type LearnedLimit = ServerContextLimit & {
  binding: EndpointBinding
  learnedAtMs: number
  /**
   * The window the provider or runtime itself reported when this limit was
   * first seen. Stamped by `reconcileServerLimit`.
   */
  reportedWindow?: number | null
}

/**
 * Limits learned this session.
 *
 * In memory rather than persisted, deliberately. A window learned from one
 * refusal is the best answer available *now*; writing it to settings would make
 * a transient server configuration look like a decision the user made, and the
 * migration that had to undo persisted zeroes is a recent enough lesson.
 */
const learned = new Map<string, LearnedLimit>()

/** Record what a refusal reported. Returns what was stored, or null. */
export function rememberServerLimit(
  binding: EndpointBinding,
  limit: ServerContextLimit | null,
  nowMs: number = Date.now()
): LearnedLimit | null {
  if (!limit) return null
  const entry: LearnedLimit = { ...limit, binding, learnedAtMs: nowMs }
  learned.set(bindingKey(binding), entry)
  return entry
}

/** What was learned for this endpoint, if anything. */
export function serverReportedLimit(
  binding: EndpointBinding
): LearnedLimit | null {
  return learned.get(bindingKey(binding)) ?? null
}

/**
 * What was learned for this endpoint, while the server is still the one that
 * refused.
 *
 * `reported` is the window the provider or local runtime reports now, without
 * the learned limit. The first call after a refusal records it. When it later
 * changes (llama-server reloaded with a larger `-c`, a model unloaded and
 * loaded with another context), the server is not the one that refused, so
 * the learned limit is forgotten instead of outranking the new answer. A
 * reported window that stays the same keeps the learned one: a provider can
 * list 262,144 for a model its server runs at 200,000.
 */
export function reconcileServerLimit(
  binding: EndpointBinding,
  reported: number | null
): LearnedLimit | null {
  const entry = learned.get(bindingKey(binding))
  if (!entry) return null
  // Nothing reported (yet: a local runtime answers asynchronously) is not a
  // change, and is not recorded as the baseline either.
  if (reported == null) return entry
  if (entry.reportedWindow == null) {
    entry.reportedWindow = reported
    return entry
  }
  if (entry.reportedWindow !== reported) {
    learned.delete(bindingKey(binding))
    return null
  }
  return entry
}

/**
 * Forget what was learned for one endpoint.
 *
 * Called when the provider's configuration changes. A limit learned from the
 * old endpoint would be enforced silently against the new one.
 */
export function forgetServerLimit(binding: EndpointBinding): void {
  learned.delete(bindingKey(binding))
}

/** Forget everything. For a settings change whose blast radius is every model. */
export function forgetAllServerLimits(): void {
  learned.clear()
}

/**
 * What to do about a refusal.
 *
 * One compaction and one retry, at most, and only when the newly-learned window
 * is big enough for a compacted request to plausibly fit. Two rules matter
 * here: a retry loop against a server that keeps refusing is worse than the
 * original error, and a retry that changes nothing is just a slower failure.
 */
export type RecoveryPlan =
  | { action: 'retry-after-compaction'; limit: LearnedLimit }
  | { action: 'report'; reason: 'already-retried' | 'no-limit-reported' | 'nothing-to-compact' }

export function planRecovery(input: {
  limit: LearnedLimit | null
  /** Whether this request has already been compacted and retried once. */
  alreadyRetried: boolean
  /** Tokens the request would still carry after compaction, when known. */
  compactedTokens?: number | null
}): RecoveryPlan {
  if (!input.limit) return { action: 'report', reason: 'no-limit-reported' }
  // One attempt. The original error is what the user sees if it fails again,
  // which is the honest outcome -- not a spinner that never resolves.
  if (input.alreadyRetried) return { action: 'report', reason: 'already-retried' }
  if (
    input.compactedTokens != null &&
    input.compactedTokens >= input.limit.contextTokens
  ) {
    // Compaction cannot get under the window, so retrying would refuse again
    // for exactly the same reason.
    return { action: 'report', reason: 'nothing-to-compact' }
  }
  return { action: 'retry-after-compaction', limit: input.limit }
}
