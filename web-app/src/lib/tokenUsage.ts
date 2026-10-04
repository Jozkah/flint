/**
 * Provider-reported token usage, with the prompt cache kept apart. AH-211.
 *
 * One shape for every surface — Chat message metadata, the Cowork runner, its
 * subagents, the session store — so a cache count read off the wire reaches
 * the counter without a surface quietly re-deriving or dropping it.
 *
 * The rule the whole module exists to keep: a count the provider did not
 * report is `undefined`, never `0`. The AI SDK's own converters default an
 * absent `cached_tokens` (and Anthropic's absent cache fields) to zero, so
 * their normalized numbers cannot say whether a cache was measured. Presence
 * is therefore decided from the provider's raw usage object, and only then is
 * a number believed.
 *
 * Semantics, per wire format (see docs/AGENT_HARNESS_ARCHITECTURE.md):
 *
 * - `inputTokens` is every prompt token the request carried: fresh, read from
 *   the cache, and written to it. OpenAI-shaped `prompt_tokens` already means
 *   that. Anthropic's `input_tokens` does not — it excludes both cache counts —
 *   so the total there is `input_tokens + cache_read + cache_creation`, which
 *   is what the Anthropic converter reports as the input total.
 * - `cachedInputTokens` is what was read from the cache.
 * - `uncachedInputTokens` is derived: `max(input - cached, 0)`. It is a token
 *   count, not a count of cache misses.
 * - `cacheWriteTokens` is what was written to the cache. It is a subset of the
 *   uncached input (those tokens were processed fresh, then stored), so it is
 *   never added to anything; adding it would count those tokens twice.
 * - `totalTokens` is input plus output.
 *
 * None of this is AH-073's dispatched-payload estimate. That is Flint's own
 * byte count and is labelled as an estimate where it is shown; this is only
 * ever what a provider reported.
 */
import type { LanguageModelUsage } from 'ai'
import type { Usage as CoworkUsage } from '@/types/coworkSession'

/** Which wire field a cache count came from. */
export type CacheReportSource =
  /** `prompt_tokens_details.cached_tokens` — OpenAI Chat, OpenAI-compatible
   * servers, and llama-server's own `usage`. */
  | 'openai-chat'
  /** `input_tokens_details.cached_tokens` — the OpenAI Responses API. */
  | 'openai-responses'
  /** `cache_read_input_tokens` / `cache_creation_input_tokens`. */
  | 'anthropic'
  /** `cachedContentTokenCount` — Gemini. */
  | 'google'
  /** llama.cpp / MLX `timings.cache_n`, when `usage` carried no cache count. */
  | 'engine-timings'

export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** Read from the provider's prompt cache. Absent when not reported. */
  cachedInputTokens?: number
  /** `max(input - cached, 0)`. Absent unless both sides are known. */
  uncachedInputTokens?: number
  /** Written to the prompt cache. Absent when not reported. */
  cacheWriteTokens?: number
  cacheSource?: CacheReportSource
  /**
   * The provider's own values where they were inconsistent and had to be
   * clamped — a cached count larger than the input, say. Kept so the number
   * shown can be traced back to what was actually sent.
   */
  reported?: {
    cachedInputTokens?: number
    cacheWriteTokens?: number
  }
  /**
   * How many model requests these numbers cover, how many of them reported a
   * cache count at all, and how many reported reading from the cache. A turn
   * or a session is several requests; these keep "how many requests hit the
   * cache" apart from "how many tokens were cached". Absent on usage saved
   * before they existed.
   */
  requests?: number
  cacheReportedRequests?: number
  cacheHitRequests?: number
  /**
   * The input tokens of the requests that reported a cache count: the base
   * `cachedInputTokens` is a share of. Equal to `inputTokens` for one request;
   * smaller for several when some of them said nothing about their cache, so
   * a session's cached share is never diluted by requests that did not report.
   * Absent when it equals `inputTokens`.
   */
  cacheReportedInputTokens?: number
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A token count, or `undefined`. Never coerces a missing value to zero. */
export const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined

/**
 * Derive and clamp. Every `TokenUsage` passes through here, so the invariants
 * hold wherever one came from — the wire, a persisted message, a session
 * saved by an earlier build.
 */
export function finalizeTokenUsage(parts: {
  inputTokens?: unknown
  outputTokens?: unknown
  totalTokens?: unknown
  cachedInputTokens?: unknown
  cacheWriteTokens?: unknown
  cacheSource?: CacheReportSource
  reported?: TokenUsage['reported']
  requests?: unknown
  cacheReportedRequests?: unknown
  cacheHitRequests?: unknown
  cacheReportedInputTokens?: unknown
}): TokenUsage {
  const input = tokenCount(parts.inputTokens)
  const output = tokenCount(parts.outputTokens)
  let cached = tokenCount(parts.cachedInputTokens)
  let write = tokenCount(parts.cacheWriteTokens)
  const reported: NonNullable<TokenUsage['reported']> = {
    ...(parts.reported ?? {}),
  }

  // What the cached count is a share of: the requests that reported it.
  let base = input
  const givenBase = tokenCount(parts.cacheReportedInputTokens)
  if (givenBase !== undefined && cached !== undefined) {
    base = input !== undefined ? Math.min(givenBase, input) : givenBase
  }
  if (cached !== undefined && base !== undefined && cached > base) {
    reported.cachedInputTokens ??= cached
    cached = base
  }
  const uncached =
    base !== undefined && cached !== undefined
      ? Math.max(base - cached, 0)
      : undefined
  // What was written was processed fresh, so it cannot exceed the fresh part.
  const writeCeiling = uncached ?? input
  if (write !== undefined && writeCeiling !== undefined && write > writeCeiling) {
    reported.cacheWriteTokens ??= write
    write = writeCeiling
  }

  const total =
    tokenCount(parts.totalTokens) ??
    (input !== undefined || output !== undefined
      ? (input ?? 0) + (output ?? 0)
      : undefined)

  const out: TokenUsage = {}
  if (input !== undefined) out.inputTokens = input
  if (output !== undefined) out.outputTokens = output
  if (total !== undefined) out.totalTokens = total
  if (cached !== undefined) out.cachedInputTokens = cached
  if (uncached !== undefined) out.uncachedInputTokens = uncached
  if (write !== undefined) out.cacheWriteTokens = write
  if (parts.cacheSource && (cached !== undefined || write !== undefined)) {
    out.cacheSource = parts.cacheSource
  }
  if (Object.keys(reported).length > 0) out.reported = reported
  const requests = tokenCount(parts.requests)
  const reportedRequests = tokenCount(parts.cacheReportedRequests)
  const hitRequests = tokenCount(parts.cacheHitRequests)
  if (requests !== undefined) out.requests = requests
  if (reportedRequests !== undefined) out.cacheReportedRequests = reportedRequests
  if (hitRequests !== undefined) out.cacheHitRequests = hitRequests
  if (cached !== undefined && base !== undefined && base !== input) {
    out.cacheReportedInputTokens = base
  }
  return out
}

/**
 * What the provider said about its prompt cache for these requests.
 *
 * - `reused`: at least one request reported reading cached input tokens
 *   (`cached > 0`). A partly cached prompt is reuse.
 * - `none`: the provider reported the cache and said nothing was read from it
 *   (`cached = 0`).
 * - `not-reported`: the provider sent no cache count. Unknown is never taken
 *   for a miss.
 *
 * Only ever decided from provider-reported counts -- never from repeated text,
 * latency or an equal total.
 */
export type CacheStatus = 'reused' | 'none' | 'not-reported'

export function cacheStatus(usage: TokenUsage | undefined): CacheStatus {
  if (!usage) return 'not-reported'
  if ((usage.cachedInputTokens ?? 0) > 0 || (usage.cacheHitRequests ?? 0) > 0) {
    return 'reused'
  }
  if (usage.cachedInputTokens === 0) return 'none'
  return 'not-reported'
}

/**
 * Cached input as a share of the input of the requests that reported a cache
 * count, 0-100. Undefined when no request did, or there was no input.
 */
export function cacheReusePercent(usage: TokenUsage | undefined): number | undefined {
  const cached = usage?.cachedInputTokens
  const base = usage?.cacheReportedInputTokens ?? usage?.inputTokens
  if (base === undefined || cached === undefined || base <= 0) return undefined
  return (Math.min(cached, base) / base) * 100
}

/** Exact values for an accessible label or tooltip; absent ones say so. */
export function exactUsageText(usage: TokenUsage | undefined): string {
  // Fixed grouping, so a label read aloud or asserted reads the same anywhere.
  const n = (v: number | undefined) =>
    v === undefined ? 'not reported' : v.toLocaleString('en-US')
  if (!usage) return 'Usage not reported'
  const parts = [
    `Input ${n(usage.inputTokens)}`,
    `Cached ${n(usage.cachedInputTokens)}`,
    `Uncached ${n(usage.uncachedInputTokens)}`,
    `Output ${n(usage.outputTokens)}`,
    `Total ${n(usage.totalTokens)}`,
  ]
  if (usage.cacheWriteTokens !== undefined) {
    parts.splice(3, 0, `Cache write ${n(usage.cacheWriteTokens)}`)
  }
  return parts.join(', ')
}

/**
 * Where a displayed value came from.
 *
 * - `reported`: the provider (or the local engine's own timings) sent it.
 * - `derived`: computed here from reported values -- uncached input, and the
 *   total, which is input plus output.
 * - `clamped`: reported, but inconsistent, and cut to a consistent value; the
 *   original is in `reported`.
 *
 * Nothing in a `TokenUsage` is ever `estimated`: Flint's own byte estimate is
 * AH-073's record and is never merged into provider usage. A value that is
 * absent is unavailable and has no kind.
 */
export type UsageValueKind = 'reported' | 'derived' | 'clamped'

export type UsageField =
  | 'input'
  | 'cached'
  | 'uncached'
  | 'cacheWrite'
  | 'output'
  | 'total'

export function usageValueKinds(
  usage: TokenUsage
): Partial<Record<UsageField, UsageValueKind>> {
  const kinds: Partial<Record<UsageField, UsageValueKind>> = {}
  if (usage.inputTokens !== undefined) kinds.input = 'reported'
  if (usage.outputTokens !== undefined) kinds.output = 'reported'
  if (usage.totalTokens !== undefined) kinds.total = 'derived'
  if (usage.cachedInputTokens !== undefined) {
    kinds.cached =
      usage.reported?.cachedInputTokens !== undefined ? 'clamped' : 'reported'
  }
  if (usage.uncachedInputTokens !== undefined) kinds.uncached = 'derived'
  if (usage.cacheWriteTokens !== undefined) {
    kinds.cacheWrite =
      usage.reported?.cacheWriteTokens !== undefined ? 'clamped' : 'reported'
  }
  return kinds
}

/** A reader-facing name for the wire field a cache count came from. */
export function cacheSourceLabel(source: CacheReportSource | undefined): string {
  switch (source) {
    case 'openai-chat':
      return 'prompt_tokens_details.cached_tokens'
    case 'openai-responses':
      return 'input_tokens_details.cached_tokens'
    case 'anthropic':
      return 'Anthropic cache_read / cache_creation'
    case 'google':
      return 'Gemini cachedContentTokenCount'
    case 'engine-timings':
      return 'engine timings (cache_n)'
    default:
      return ''
  }
}

/** Whether the provider said anything about its prompt cache. */
export const hasCacheReport = (usage: TokenUsage | undefined): boolean =>
  usage?.cachedInputTokens !== undefined || usage?.cacheWriteTokens !== undefined

/**
 * The engine's own timings, as the llama.cpp/MLX metadata extractor exposes
 * them under `providerMetadata.providerMetadata`.
 */
type EngineTimings = {
  promptTokens?: unknown
  completionTokens?: unknown
  cacheTokens?: unknown
}

const engineTimingsOf = (providerMetadata: unknown): EngineTimings | undefined => {
  if (!isRecord(providerMetadata)) return undefined
  const inner = providerMetadata.providerMetadata
  return isRecord(inner) ? (inner as EngineTimings) : undefined
}

/**
 * One model call's usage, as the AI SDK reported it, with the cache counts
 * believed only where the provider's raw usage carried them.
 */
export function normalizeLanguageModelUsage(
  usage: LanguageModelUsage | undefined,
  providerMetadata?: unknown
): TokenUsage {
  const raw = isRecord(usage?.raw) ? usage.raw : undefined
  const details = usage?.inputTokenDetails
  let cached: number | undefined
  let write: number | undefined
  let source: CacheReportSource | undefined

  if (raw) {
    if ('prompt_tokens' in raw || 'completion_tokens' in raw) {
      const promptDetails = raw.prompt_tokens_details
      if (isRecord(promptDetails)) {
        cached = tokenCount(promptDetails.cached_tokens)
      }
      // Proxies that front Anthropic with an OpenAI shape (LiteLLM, Flint's own
      // server) carry the creation count through under Anthropic's name.
      write = tokenCount(raw.cache_creation_input_tokens)
      if (cached !== undefined || write !== undefined) source = 'openai-chat'
    } else if (
      'input_tokens' in raw &&
      ('cache_read_input_tokens' in raw || 'cache_creation_input_tokens' in raw)
    ) {
      // The raw object is the `message_start` snapshot while streaming, so it
      // decides presence only; the numbers come from the converter, which
      // follows `message_delta` to the final values.
      if (raw.cache_read_input_tokens != null) {
        cached = tokenCount(details?.cacheReadTokens ?? raw.cache_read_input_tokens)
      }
      if (raw.cache_creation_input_tokens != null) {
        write = tokenCount(
          details?.cacheWriteTokens ?? raw.cache_creation_input_tokens
        )
      }
      if (cached !== undefined || write !== undefined) source = 'anthropic'
    } else if ('input_tokens' in raw) {
      const inputDetails = raw.input_tokens_details
      if (isRecord(inputDetails)) {
        cached = tokenCount(inputDetails.cached_tokens)
        if (cached !== undefined) source = 'openai-responses'
      }
    } else if ('promptTokenCount' in raw) {
      cached = tokenCount(raw.cachedContentTokenCount)
      if (cached !== undefined) source = 'google'
    }
  }

  let input: number | undefined = tokenCount(usage?.inputTokens)
  let output: number | undefined = tokenCount(usage?.outputTokens)
  const timings = engineTimingsOf(providerMetadata)
  if (timings) {
    // A local engine that streamed without `usage` (MLX) still reports its
    // own counts; they are the same numbers, measured by the same server.
    input ??= tokenCount(timings.promptTokens)
    output ??= tokenCount(timings.completionTokens)
    if (cached === undefined) {
      const engineCached = tokenCount(timings.cacheTokens)
      if (engineCached !== undefined) {
        cached = engineCached
        source = 'engine-timings'
      }
    }
  }

  return finalizeTokenUsage({
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      input !== undefined && output !== undefined ? input + output : undefined,
    cachedInputTokens: cached,
    cacheWriteTokens: write,
    cacheSource: source,
    requests: 1,
    cacheReportedRequests: cached !== undefined ? 1 : 0,
    cacheHitRequests: cached !== undefined && cached > 0 ? 1 : 0,
  })
}

const sumKnown = (a?: number, b?: number): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)

/**
 * Two separate model calls, added together.
 *
 * Only for distinct requests — the steps of one turn. Never for successive
 * snapshots of one streaming response: those are cumulative, and the last one
 * is the answer. A cache count is only known for the pair when both calls
 * reported one; a sum over a call that said nothing would pass off a partial
 * figure as the whole.
 */
export function combineTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const reported = { ...(a.reported ?? {}), ...(b.reported ?? {}) }
  const inputTokens = sumKnown(a.inputTokens, b.inputTokens)
  const outputTokens = sumKnown(a.outputTokens, b.outputTokens)
  const cachedInputTokens = sumKnown(a.cachedInputTokens, b.cachedInputTokens)
  return finalizeTokenUsage({
    inputTokens,
    outputTokens,
    // Input plus output, so the sum can never disagree with its parts; a
    // provider's own total only stands in when neither part is known.
    totalTokens:
      inputTokens === undefined && outputTokens === undefined
        ? sumKnown(a.totalTokens, b.totalTokens)
        : undefined,
    // Over the requests that reported a cache count, with the input they
    // carried kept beside it: a request that said nothing neither adds a zero
    // nor hides the rest.
    cachedInputTokens,
    cacheReportedInputTokens:
      cachedInputTokens === undefined
        ? undefined
        : sumKnown(cacheBaseOf(a), cacheBaseOf(b)),
    cacheWriteTokens: sumKnown(a.cacheWriteTokens, b.cacheWriteTokens),
    cacheSource:
      a.cacheSource === b.cacheSource ? a.cacheSource : undefined,
    reported: Object.keys(reported).length > 0 ? reported : undefined,
    // Request counts add up even where a cache count could not: a hit on one
    // request is still a hit when another request said nothing.
    requests: sumKnown(requestsOf(a), requestsOf(b)),
    cacheReportedRequests: sumKnown(reportedRequestsOf(a), reportedRequestsOf(b)),
    cacheHitRequests: sumKnown(hitRequestsOf(a), hitRequestsOf(b)),
  })
}

/** The input the cached count of one usage is a share of. */
const cacheBaseOf = (u: TokenUsage): number | undefined =>
  u.cachedInputTokens === undefined ? undefined : (u.cacheReportedInputTokens ?? u.inputTokens)

/** Usage saved before request counts existed is one request. */
const requestsOf = (u: TokenUsage): number | undefined =>
  u.requests ?? (u.inputTokens !== undefined || u.totalTokens !== undefined ? 1 : undefined)
const reportedRequestsOf = (u: TokenUsage): number | undefined =>
  u.cacheReportedRequests ?? (u.requests === undefined ? (u.cachedInputTokens !== undefined ? 1 : 0) : undefined)
const hitRequestsOf = (u: TokenUsage): number | undefined =>
  u.cacheHitRequests ?? (u.requests === undefined ? ((u.cachedInputTokens ?? 0) > 0 ? 1 : 0) : undefined)

/** Several requests' usage -- a session's turns -- added up. */
export function summarizeUsage(usages: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const known = usages.filter((u): u is TokenUsage => !!u && Object.keys(u).length > 0)
  return known.length > 0 ? known.reduce(combineTokenUsage) : undefined
}

/**
 * Collects each step's usage from a `streamText` part stream.
 *
 * `finish-step` carries the step's own usage with the provider's raw object;
 * the `finish` part's `totalUsage` has already been summed by the SDK and has
 * lost `raw`, so it is only the fallback when no step reported anything.
 */
export function createUsageCollector() {
  const steps: TokenUsage[] = []
  return {
    observe(part: { type: string; usage?: unknown; providerMetadata?: unknown }) {
      if (part.type !== 'finish-step') return
      steps.push(
        normalizeLanguageModelUsage(
          part.usage as LanguageModelUsage | undefined,
          part.providerMetadata
        )
      )
    },
    total(fallback?: LanguageModelUsage): TokenUsage {
      if (steps.length > 0) return steps.reduce(combineTokenUsage)
      return normalizeLanguageModelUsage(fallback)
    },
  }
}

/**
 * Read a usage object back from storage.
 *
 * Accepts what every build has written: this shape, the older
 * `{inputTokens, outputTokens, totalTokens}`, and snake_case. A field that is
 * missing stays missing — a message saved before cache accounting existed
 * reads as "not reported", never as "nothing was cached".
 */
export function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const reported = isRecord(value.reported)
    ? {
        ...(tokenCount(value.reported.cachedInputTokens) !== undefined
          ? { cachedInputTokens: tokenCount(value.reported.cachedInputTokens) }
          : {}),
        ...(tokenCount(value.reported.cacheWriteTokens) !== undefined
          ? { cacheWriteTokens: tokenCount(value.reported.cacheWriteTokens) }
          : {}),
      }
    : undefined
  return finalizeTokenUsage({
    inputTokens: value.inputTokens ?? value.promptTokens ?? value.prompt_tokens,
    outputTokens:
      value.outputTokens ?? value.completionTokens ?? value.completion_tokens,
    totalTokens: value.totalTokens ?? value.total_tokens,
    cachedInputTokens: value.cachedInputTokens ?? value.cached_prompt_tokens,
    cacheWriteTokens: value.cacheWriteTokens ?? value.cache_write_tokens,
    cacheSource: (value.cacheSource ?? value.cache_source) as
      | CacheReportSource
      | undefined,
    reported,
    requests: value.requests,
    cacheReportedRequests: value.cacheReportedRequests ?? value.cache_reported_requests,
    cacheHitRequests: value.cacheHitRequests ?? value.cache_hit_requests,
    cacheReportedInputTokens:
      value.cacheReportedInputTokens ?? value.cache_reported_input_tokens,
  })
}

/** The Cowork store's snake_case form, which mirrors the Rust `Usage`. */
export function toCoworkUsage(usage: TokenUsage): CoworkUsage {
  const out: CoworkUsage = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  }
  if (usage.cachedInputTokens !== undefined) {
    out.cached_prompt_tokens = usage.cachedInputTokens
  }
  if (usage.uncachedInputTokens !== undefined) {
    out.uncached_prompt_tokens = usage.uncachedInputTokens
  }
  if (usage.cacheWriteTokens !== undefined) {
    out.cache_write_tokens = usage.cacheWriteTokens
  }
  if (usage.cacheSource) out.cache_source = usage.cacheSource
  if (usage.reported) out.reported = { ...usage.reported }
  if (usage.requests !== undefined) out.requests = usage.requests
  if (usage.cacheReportedRequests !== undefined) {
    out.cache_reported_requests = usage.cacheReportedRequests
  }
  if (usage.cacheHitRequests !== undefined) out.cache_hit_requests = usage.cacheHitRequests
  if (usage.cacheReportedInputTokens !== undefined) {
    out.cache_reported_input_tokens = usage.cacheReportedInputTokens
  }
  return out
}

export function fromCoworkUsage(
  usage: CoworkUsage | null | undefined
): TokenUsage | undefined {
  return usage ? readTokenUsage(usage) : undefined
}

/**
 * A one-line account for places too small for the breakdown, such as a task
 * row's tooltip. Unreported cache counts are said to be unreported.
 */
export function describeTokenUsage(usage: TokenUsage | undefined): string {
  if (!usage) return ''
  const fmt = (n: number) => n.toLocaleString()
  const parts: string[] = []
  if (usage.inputTokens !== undefined) parts.push(`Input ${fmt(usage.inputTokens)}`)
  if (usage.cachedInputTokens !== undefined) {
    parts.push(`cached ${fmt(usage.cachedInputTokens)}`)
    if (usage.uncachedInputTokens !== undefined) {
      parts.push(`uncached ${fmt(usage.uncachedInputTokens)}`)
    }
  } else {
    parts.push('cache not reported')
  }
  if (usage.cacheWriteTokens !== undefined) {
    parts.push(`cache write ${fmt(usage.cacheWriteTokens)}`)
  }
  if (usage.outputTokens !== undefined) parts.push(`Output ${fmt(usage.outputTokens)}`)
  if (usage.totalTokens !== undefined) parts.push(`Total ${fmt(usage.totalTokens)}`)
  return parts.join(' · ')
}
