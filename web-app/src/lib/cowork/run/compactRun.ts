import type { UIMessage } from 'ai'
import {
  compactHistory,
  compactionNeedsTurnSplit,
  compactionWindow,
  shouldCompact,
  DEFAULT_KEEP_RECENT,
} from '@/lib/compaction'
import type { CompactionPolicy } from '@/lib/compactionPolicy'
import { parseServerContextLimit, rememberServerLimit } from '@/lib/contextLimitRecovery'
import { accountedTotal } from '@/lib/coworkReadiness'
import { replyReserveFor } from '@/lib/coworkBudget'
import { assertEstimatedContextFits } from '@/lib/contextEstimate'
import { UnfittableRequestError } from './unfittable'
import type { CoworkChatTransport } from '@/lib/coworkTransport'
import { recordLifecycle } from '@/lib/toolActivity'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { CoworkTurn } from '@/types/coworkSession'

/**
 * What one run's compaction reads and writes, named rather than closed over
 * (the route's `runRequest` used to hold all of it in scope).
 */
export type CompactRunContext = {
  sid: string
  runId: string
  autoCompact: boolean
  /** The configured window; null when the model does not name one. */
  runWindow: number | null | undefined
  compactionPolicy: CompactionPolicy
  selectedProvider: string
  selectedModelId: string
  transport: Pick<CoworkChatTransport, 'measureContext'> &
    Partial<Pick<CoworkChatTransport, 'advertisedTools'>>
  summarize: Parameters<typeof compactHistory>[1]['summarize']
  /** A window learned from a server refusal, shared with the summarizer. */
  getLearnedWindow: () => number | null
  setLearnedWindow: (tokens: number) => void
  setCompacting: (on: boolean) => void
  pushLive: (turns: CoworkTurn[]) => void
}

/** The `compact` hook a run hands the runner: null keeps history as it is. */
export function createCompactRun(ctx: CompactRunContext) {
  return async (
    msgs: UIMessage[],
    why: 'threshold' | 'context-error',
    signal: AbortSignal,
    failure?: unknown,
    headroom?: number
  ): Promise<UIMessage[] | null> => {
    const { runWindow, compactionPolicy } = ctx
    if (!ctx.autoCompact) return null
    if (why === 'context-error') {
      const limit = parseServerContextLimit(
        (failure as { data?: unknown } | null)?.data ?? null,
        failure instanceof Error ? failure.message : String(failure ?? '')
      )
      // Learned when no window was known, and also when the server enforces a
      // smaller one than the run planned against: a provider can list 262,144
      // for a model its server runs at 200,000, and only the refusal says so.
      if (limit && (runWindow == null || limit.contextTokens < runWindow)) {
        ctx.setLearnedWindow(limit.contextTokens)
        rememberServerLimit(
          {
            provider: ctx.selectedProvider ?? '',
            baseUrl:
              (useModelProvider.getState().getProviderByName(ctx.selectedProvider)
                ?.base_url as string) ?? '',
            model: ctx.selectedModelId,
          },
          limit
        )
      }
    }
    if (why === 'threshold') {
      const now = ctx.transport.measureContext(msgs, runWindow ?? ctx.getLearnedWindow())
      const window = compactionWindow(
        now.budget.known === false ? null : now.budget.tokens
      )
      // What the next step is expected to add, never more than a quarter of
      // the window, so one big result cannot make every step compact.
      const expected = Math.min(
        Math.max(0, headroom ?? 0),
        Math.floor(window * 0.25)
      )
      if (
        !shouldCompact(
          accountedTotal(now).tokens,
          window,
          undefined,
          expected,
          compactionPolicy
        )
      ) {
        return null
      }
    }
    const known = effectiveWindow(runWindow, ctx.getLearnedWindow())
    // When the fixed part (system prompt and tools) is most of the window,
    // summarizing the conversation cannot make the request fit: stop with
    // what is large instead of sending a summary request and the same prompt.
    if (why === 'context-error' && known != null) {
      assertConversationCanHelp(ctx, msgs, known)
    }
    ctx.setCompacting(true)
    let result: Awaited<ReturnType<typeof compactHistory>>
    try {
      const keepRecent = compactionPolicy.keepRecent || DEFAULT_KEEP_RECENT
      result = await compactHistory(msgs, {
        summarize: ctx.summarize,
        keepRecent,
        // A follow-up turn whose own tool loop fills the window would be kept
        // whole by the turn-preserving cut, leaving nothing to fold.
        splitTurn: compactionNeedsTurnSplit(
          msgs,
          keepRecent,
          compactionWindow(runWindow, ctx.getLearnedWindow()),
          compactionPolicy
        ),
        reason: why,
        signal,
      })
    } finally {
      ctx.setCompacting(false)
    }
    if (!result) return null
    // A compacted request still over the window would only be refused again:
    // end the run with the breakdown rather than resend it.
    if (why === 'context-error' && known != null) {
      assertFits(ctx, result.messages, known)
    }
    ctx.pushLive([{ role: 'assistant', content: '', compaction: result.record }])
    void recordLifecycle(
      { session: ctx.sid, run: ctx.runId, source: 'cowork' },
      {
        id: `compaction:${ctx.runId}:${result.record.at}`,
        lifecycle: 'compaction',
        phase: 'succeeded',
        summary: `Compacted ${result.record.summarizedCount} messages into a summary`,
      }
    )
    return result.messages
  }
}

/** The smaller of the planned and learned windows, when either is known. */
function effectiveWindow(
  planned: number | null | undefined,
  learned: number | null
): number | null {
  const valid = [planned, learned].filter((n): n is number => n != null && n > 0)
  return valid.length ? Math.min(...valid) : null
}

/** Share of the window the fixed part may take before summarizing is pointless. */
const FIXED_SHARE_LIMIT = 0.9
/** How far over the window an estimate must be before it is trusted to refuse. */
const CLEARLY_OVER = 1.1

function partsOf(ctx: CompactRunContext, msgs: UIMessage[], window: number) {
  const { categories: c } = ctx.transport.measureContext(msgs, window)
  const n = (v: (typeof c)['tools']) => (v.known === false ? 0 : v.tokens)
  return {
    systemPrompt: n(c.instructions) + n(c.skills) + n(c.repositoryMap),
    tools: n(c.tools),
    toolCount: Object.keys(ctx.transport.advertisedTools ?? {}).length,
    history: n(c.conversation),
    latest: 0,
  }
}

function refuse(
  breakdown: ReturnType<typeof partsOf>,
  window: number,
  reserve: number
): never {
  const total = breakdown.systemPrompt + breakdown.tools + breakdown.history
  try {
    assertEstimatedContextFits(total, 1, window, reserve, {
      source: 'the server that refused the request',
      breakdown,
      strict: true,
    })
  } catch (e) {
    throw new UnfittableRequestError(e instanceof Error ? e.message : String(e))
  }
  // Under the window by the estimate, but the server refused it anyway.
  throw new UnfittableRequestError(
    `The server refused the request for its length (window ${window.toLocaleString('en-US')} tokens). ` +
      'Turn off MCP servers or tools this conversation does not need, or start a new conversation.'
  )
}

function assertConversationCanHelp(
  ctx: CompactRunContext,
  msgs: UIMessage[],
  window: number
): void {
  const b = partsOf(ctx, msgs, window)
  const reserve = replyReserveFor(window)
  if (b.systemPrompt + b.tools + reserve > window * FIXED_SHARE_LIMIT) {
    refuse(b, window, reserve)
  }
}

function assertFits(ctx: CompactRunContext, msgs: UIMessage[], window: number): void {
  const b = partsOf(ctx, msgs, window)
  const reserve = replyReserveFor(window)
  // The measure is an estimate: refuse only when it is clearly over, and
  // otherwise let the runner's single resend find out.
  if (b.systemPrompt + b.tools + b.history + reserve > window * CLEARLY_OVER) {
    refuse(b, window, reserve)
  }
}
