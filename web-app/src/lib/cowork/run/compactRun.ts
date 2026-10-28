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
  transport: Pick<CoworkChatTransport, 'measureContext'>
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
    if (why === 'context-error' && runWindow == null) {
      const limit = parseServerContextLimit(
        (failure as { data?: unknown } | null)?.data ?? null,
        failure instanceof Error ? failure.message : String(failure ?? '')
      )
      if (limit) {
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
