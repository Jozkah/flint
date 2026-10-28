import type { UIMessage } from '@ai-sdk/react'
import type { LanguageModel } from 'ai'
import {
  compactHistory,
  estimateHistoryTokens,
  planCompaction,
  compactionTriggerTokens,
  clipToolResultsToFit,
  TRIM_HEADROOM_SHARE,
  type CompactionRecord,
  type CompactResult,
} from '@/lib/compaction'
import { clearStaleToolResults } from '@/lib/context-manager'
import {
  CompactionLoopError,
  PRECOMPUTE_FRACTION,
  cancelPrecompute,
  isCompactionLooping,
  recordCompaction,
  startPrecompute,
  takePrecomputedPrefix,
} from '@/lib/compactionGuard'
import { manualSummarizer, modelSummarizer } from '@/lib/compactionSummarizer'
import {
  applyChatCompaction,
  readChatCompaction,
  stateAfter,
  writeChatCompaction,
} from '@/lib/chatCompaction'
import { recordLifecycle } from '@/lib/toolActivity'

// Chat's compaction pipeline, moved out of `CustomChatTransport` unchanged.
// The class state these functions touch is reached through `CompactionHost`;
// the class methods delegate here.

export interface CompactionHost {
  /** The model the transport is sending to right now. */
  model(): LanguageModel | null
  /** Remember the compaction so the reply that follows can announce it. */
  announce(record: CompactionRecord): void
}

export type CompactAtThresholdOptions = {
  window: number
  /** What the trimmer keeps free of the window; compaction starts before it acts. */
  trimReserveTokens?: number
  systemPromptTokens: number
  keepRecent: number
  summaryMaxTokens: number
  provider: string
  modelId: string
  session: string
  signal?: AbortSignal
  /** The provider refused the request for its length: compact regardless. */
  force?: boolean
}

export type RunCompactionOptions = {
  window: number | null
  keepRecent: number
  splitTurn?: boolean
  summaryMaxTokens: number
  provider: string
  modelId: string
  session: string
  reason: CompactionRecord['reason']
  signal?: AbortSignal
  focus?: string
}

/**
 * Chat's automatic compaction (`lib/compaction.ts`).
 *
 * The summary in force is applied first: everything before its boundary is
 * replaced by it. When the request is still past the threshold of the
 * window, the older part is summarized again (the earlier summary folded
 * in) and the new boundary remembered, so the next request reuses it.
 */
export async function compactAtThreshold(
  host: CompactionHost,
  threadId: string,
  messages: UIMessage[],
  opts: CompactAtThresholdOptions
): Promise<UIMessage[]> {
  const inForce = readChatCompaction(threadId)
  const applied = applyChatCompaction(messages, inForce)
  const stale = applied.stale
  let history = applied.history
  // The boundary message was edited or deleted: the summary no longer
  // describes what precedes it.
  if (stale) {
    writeChatCompaction(threadId, null)
    cancelPrecompute(threadId)
  }

  const fullTrigger = compactionTriggerTokens(
    opts.window,
    opts.trimReserveTokens
  )
  // The next request grows by about what the last assistant turns did (tool
  // output rides in them), so compact before that growth crosses the window
  // rather than after. At most a tenth of the window, so a compaction that
  // keeps a large recent turn cannot leave the request still over the trigger.
  const recentAssistant = history
    .filter((m) => m.role === 'assistant')
    .slice(-4)
    .map((m) => estimateHistoryTokens([m]))
  const headroom = Math.min(
    Math.floor(opts.window * 0.1),
    Math.ceil(Math.max(0, ...recentAssistant) * 1.25)
  )
  let trigger = Math.max(
    Math.floor(opts.window * 0.1),
    fullTrigger - headroom
  )
  let projected = opts.systemPromptTokens + estimateHistoryTokens(history)
  // The provider just refused this request: whatever the estimate says, it
  // did not fit, so aim well under what it measured.
  const forced = opts.force === true
  if (forced) trigger = Math.min(trigger, Math.floor(projected * 0.6))
  if (!forced && projected < trigger) {
    if (projected >= trigger * PRECOMPUTE_FRACTION) {
      // When clearing old tool output alone will keep the request well under
      // the trigger, the summary would never be used: don't write it.
      const afterClearing =
        opts.systemPromptTokens +
        estimateHistoryTokens(clearStaleToolResults(history).messages)
      if (afterClearing >= trigger * PRECOMPUTE_FRACTION) {
        precomputeSummary(host, threadId, history, opts)
      }
    }
    return history
  }

  // Old tool output is the cheapest thing to give up: clear it first and
  // summarize only if the request is still over.
  const cleared = clearStaleToolResults(history)
  if (cleared.clearedCount > 0) {
    history = cleared.messages
    projected = opts.systemPromptTokens + estimateHistoryTokens(history)
    if (projected < trigger) return history
  }

  // A conversation that refills right after a compaction is not helped by
  // the same compaction again, so it starts at a harder cut instead of
  // stopping: more of the recent turns, then the middle of the current one,
  // are folded.
  const looping = !forced && isCompactionLooping(threadId, history.length)
  const result = await compactToFit(host, threadId, history, {
    ...opts,
    trigger,
    reason: forced ? 'context-error' : 'threshold',
    startLevel: looping ? 1 : 0,
  })
  let out = result?.messages ?? history
  // What no summary can shrink is the newest thing in the conversation: a
  // single tool result that alone fills the window. It keeps its head and
  // tail and loses the middle, rather than the request being refused.
  const ceiling = Math.floor(
    (opts.window - (opts.trimReserveTokens ?? 0)) * TRIM_HEADROOM_SHARE
  )
  const room = Math.max(
    1000,
    (forced ? Math.min(ceiling, trigger) : ceiling) - opts.systemPromptTokens
  )
  let clippedCount = 0
  if (estimateHistoryTokens(out) > room) {
    const clipped = clipToolResultsToFit(out, room)
    out = clipped.messages
    clippedCount = clipped.clippedCount
  }
  if (!result && clippedCount === 0) {
    // Nothing could be folded or shrunk and the breaker had already seen
    // this loop: say so rather than send a request that will be refused.
    if (looping) throw new CompactionLoopError()
    return history
  }
  // Still over the window itself after every cut: the refill loop is real.
  if (
    looping &&
    opts.systemPromptTokens + estimateHistoryTokens(out) >= opts.window
  ) {
    throw new CompactionLoopError()
  }
  if (result) {
    recordCompaction(threadId, history.length, result.messages.length)
    host.announce(result.record)
  }
  return out
}

/**
 * Compact until the request is under `trigger`, cutting harder each time it
 * is not: the configured share of recent turns, then half of it with the cut
 * allowed inside the current user turn (a long tool loop is one turn), then
 * only the newest message. A cut whose kept part alone is over is skipped
 * without a model call. Null when nothing could be folded.
 */
async function compactToFit(
  host: CompactionHost,
  threadId: string,
  history: UIMessage[],
  opts: {
    window: number
    systemPromptTokens: number
    keepRecent: number
    summaryMaxTokens: number
    provider: string
    modelId: string
    session: string
    signal?: AbortSignal
    trigger: number
    reason: CompactionRecord['reason']
    startLevel: number
  }
): Promise<CompactResult | null> {
  const levels = [
    { keepRecent: opts.keepRecent, splitTurn: false },
    {
      keepRecent: Math.max(2, Math.floor(opts.keepRecent / 2)),
      splitTurn: true,
    },
    { keepRecent: 1, splitTurn: true },
  ]
  // What the summary itself will add to the request.
  const summaryAllowance = opts.summaryMaxTokens + 200
  let current = history
  let last: CompactResult | null = null
  for (
    let i = Math.min(opts.startLevel, levels.length - 1);
    i < levels.length;
    i++
  ) {
    const level = levels[i]
    const isLast = i === levels.length - 1
    const plan = planCompaction(current, level)
    if (!plan) continue
    // Summarizing everything older cannot make this cut fit when what it
    // keeps is already over: cut deeper instead of paying for a summary
    // that would not help. The deepest cut always runs; what it keeps is
    // then shrunk by the caller.
    const kept =
      opts.systemPromptTokens +
      estimateHistoryTokens([...plan.pinned, ...plan.keep]) +
      summaryAllowance
    if (kept >= opts.trigger && !isLast) continue
    const result = await runCompaction(host, threadId, current, {
      window: opts.window,
      keepRecent: level.keepRecent,
      splitTurn: level.splitTurn,
      summaryMaxTokens: opts.summaryMaxTokens,
      provider: opts.provider,
      modelId: opts.modelId,
      session: opts.session,
      reason: opts.reason,
      signal: opts.signal,
    })
    if (!result) continue
    last = result
    current = result.messages
    if (
      opts.systemPromptTokens + estimateHistoryTokens(current) <
      opts.trigger
    ) {
      break
    }
  }
  return last
}

/** Start the summary a coming compaction will need, without waiting for it. */
function precomputeSummary(
  host: CompactionHost,
  threadId: string,
  history: UIMessage[],
  opts: {
    window: number
    keepRecent: number
    summaryMaxTokens: number
    provider: string
    modelId: string
    session: string
  }
): void {
  const plan = planCompaction(history, { keepRecent: opts.keepRecent })
  if (!plan) return
  startPrecompute(
    threadId,
    plan.summarize,
    modelSummarizer({
      provider: opts.provider,
      modelId: opts.modelId,
      session: opts.session,
      maxOutputTokens: opts.summaryMaxTokens,
      window: opts.window,
      model: () => host.model(),
    })
  )
}

/** Compact, keep the result with the thread, and record it. */
export async function runCompaction(
  host: CompactionHost,
  threadId: string,
  history: UIMessage[],
  opts: RunCompactionOptions
) {
  // Asked for by the user: a model that cannot summarize is an error they
  // are told about, never a digest in place of their conversation.
  const manual = opts.reason === 'manual'
  const chosen = manual
    ? manualSummarizer({
        provider: opts.provider,
        modelId: opts.modelId,
        session: opts.session,
        focus: opts.focus,
        maxOutputTokens: opts.summaryMaxTokens,
        window: opts.window,
        model: () => host.model(),
      })
    : null
  const result = await compactHistory(history, {
    summarize:
      chosen?.summarize ??
      modelSummarizer({
        provider: opts.provider,
        modelId: opts.modelId,
        session: opts.session,
        maxOutputTokens: opts.summaryMaxTokens,
        window: opts.window,
        model: () => host.model(),
      }),
    ...(manual ? { fallback: false, summarizedBy: chosen?.usedBy } : {}),
    keepRecent: opts.keepRecent,
    splitTurn: opts.splitTurn,
    reason: opts.reason,
    signal: opts.signal,
    reusePrefix: (covered) => takePrecomputedPrefix(threadId, covered),
  })
  cancelPrecompute(threadId)
  if (!result) return null
  // Kept with the thread, so a restart reuses it rather than summarizing
  // the same messages again.
  const state = stateAfter(result.messages, result.record, result.latestRequest)
  if (state) writeChatCompaction(threadId, state)
  // A compaction changes what the model sees from here on, so it is part of
  // what the conversation did and goes in its record.
  void recordLifecycle(
    { session: opts.session, run: '', source: 'chat' },
    {
      id: `compaction:${result.record.at}`,
      lifecycle: 'compaction',
      phase: 'succeeded',
      summary: `Compacted ${result.record.summarizedCount} messages into a summary`,
    }
  )
  return result
}
