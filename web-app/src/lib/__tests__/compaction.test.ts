import { describe, it, expect, vi } from 'vitest'
import type { UIMessage } from 'ai'
import {
  clipToolResultsToFit,
  compactHistory,
  compactionOf,
  compactionTriggerTokens,
  DEFAULT_COMPACT_THRESHOLD,
  estimateHistoryTokens,
  hasUnresolvedToolCall,
  isContextLengthError,
  isSummaryMessage,
  planCompaction,
  resolveAutoCompact,
  compactionHeadroom,
  shouldCompact,
  summaryMessage,
  thresholdTokens,
  transcriptForSummary,
} from '../compaction'
import { ContextOverflowError } from '../coworkBudget'

const text = (id: string, role: UIMessage['role'], body: string): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: body }] }) as UIMessage

const toolCall = (
  id: string,
  callId: string,
  resolved: boolean
): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-read',
        toolCallId: callId,
        input: { path: `${callId}.txt` },
        state: resolved ? 'output-available' : 'input-available',
        ...(resolved ? { output: `contents of ${callId}` } : {}),
      },
    ],
  }) as unknown as UIMessage

/** A conversation of `turns` user/assistant pairs. */
const chat = (turns: number): UIMessage[] =>
  Array.from({ length: turns }, (_, i) => [
    text(`u${i}`, 'user', `question ${i}`),
    text(`a${i}`, 'assistant', `answer ${i}`),
  ]).flat()

/** Every tool part in `messages` sits in the same message as its result. */
const noSplitPairs = (messages: UIMessage[]) => {
  for (const m of messages) {
    for (const p of m.parts as Array<{ type: string; toolCallId?: string; state?: string }>) {
      if (p.type.startsWith('tool-') && p.state === 'output-available') {
        expect(p).toHaveProperty('output')
      }
    }
  }
}

describe('threshold math', () => {
  it('compacts at the default share of the window', () => {
    expect(DEFAULT_COMPACT_THRESHOLD).toBe(0.8)
    expect(thresholdTokens(10_000)).toBe(8_000)
    expect(shouldCompact(7_999, 10_000)).toBe(false)
    expect(shouldCompact(8_000, 10_000)).toBe(true)
  })

  it('honours a custom threshold, clamped to a sane range', () => {
    expect(thresholdTokens(10_000, 0.5)).toBe(5_000)
    expect(thresholdTokens(10_000, 5)).toBe(10_000)
    expect(thresholdTokens(10_000, 0)).toBe(1_000)
  })

  it('compacts early when the next step is expected to cross the trigger', () => {
    expect(shouldCompact(7_000, 10_000, undefined, 500)).toBe(false)
    expect(shouldCompact(7_000, 10_000, undefined, 1_000)).toBe(true)
    // No headroom by default, so the plain behaviour is unchanged.
    expect(shouldCompact(7_999, 10_000)).toBe(false)
  })

  it('never lets the trigger sit inside the reply reserve', () => {
    // A 95% share of a 10,000 window is 9,500, but 1,500 is kept for the
    // reply, so the trigger is 8,500.
    expect(shouldCompact(8_499, 10_000, 0.95)).toBe(false)
    expect(shouldCompact(8_500, 10_000, 0.95)).toBe(true)
  })

  it('derives headroom from recent growth, capped at a quarter of the window', () => {
    expect(compactionHeadroom([], 100_000)).toBe(0)
    expect(compactionHeadroom([400, 2_000, 100], 100_000)).toBe(2_500)
    expect(compactionHeadroom([90_000], 100_000)).toBe(25_000)
    expect(compactionHeadroom([1_000], null)).toBe(0)
  })

  it('never compacts against an unknown window', () => {
    expect(shouldCompact(1e9, null)).toBe(false)
    expect(shouldCompact(1e9, 0)).toBe(false)
    expect(thresholdTokens(0)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('resolveAutoCompact', () => {
  it('lets the model parameter win either way', () => {
    expect(resolveAutoCompact({ auto_compact: false }, true)).toBe(false)
    expect(resolveAutoCompact({ auto_compact: 'false' }, true)).toBe(false)
    expect(resolveAutoCompact({ auto_compact: true }, false)).toBe(true)
  })

  it('falls back to the policy when the parameter is not set', () => {
    expect(resolveAutoCompact({}, true)).toBe(true)
    expect(resolveAutoCompact(undefined, false)).toBe(false)
  })
})

describe('planCompaction', () => {
  it('keeps the system prompt and the most recent turns', () => {
    const system = text('sys', 'system', 'be brief')
    const plan = planCompaction([system, ...chat(6)], { keepRecent: 4 })!
    expect(plan.pinned).toEqual([system])
    expect(plan.keep.map((m) => m.id)).toEqual(['u4', 'a4', 'u5', 'a5'])
    expect(plan.summarize.map((m) => m.id)).toEqual([
      'u0', 'a0', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3',
    ])
  })

  it('moves the cut back to the start of a user turn', () => {
    const plan = planCompaction(chat(6), { keepRecent: 3 })!
    // The last three are a4, u5, a5; the kept part starts at u4 instead.
    expect(plan.keep[0].id).toBe('u4')
    expect(plan.keep.map((m) => m.id)).toEqual(['u4', 'a4', 'u5', 'a5'])
  })

  it('folds mid-run when the only user turn is at the start', () => {
    const run = [
      text('u0', 'user', 'refactor the parser'),
      ...Array.from({ length: 10 }, (_, i) => toolCall(`s${i}`, `c${i}`, true)),
    ]
    const plan = planCompaction(run, { keepRecent: 4 })!
    expect(plan.keep.map((m) => m.id)).toEqual(['s6', 's7', 's8', 's9'])
    expect(plan.summarize[0].id).toBe('u0')
  })

  it('keeps every unresolved tool call and what follows it', () => {
    const run = [
      text('u0', 'user', 'go'),
      toolCall('s0', 'c0', true),
      toolCall('s1', 'c1', false),
      toolCall('s2', 'c2', true),
      toolCall('s3', 'c3', true),
      toolCall('s4', 'c4', true),
    ]
    const plan = planCompaction(run, { keepRecent: 1 })!
    expect(plan.keep.map((m) => m.id)).toEqual(['s1', 's2', 's3', 's4'])
    expect(plan.summarize.some(hasUnresolvedToolCall)).toBe(false)
  })

  it('never splits a tool call from its result', () => {
    const run = [
      text('u0', 'user', 'go'),
      ...Array.from({ length: 6 }, (_, i) => toolCall(`s${i}`, `c${i}`, true)),
    ]
    for (let keep = 1; keep <= 6; keep++) {
      const plan = planCompaction(run, { keepRecent: keep })!
      const keptCalls = plan.keep.flatMap((m) =>
        (m.parts as Array<{ toolCallId?: string }>).map((p) => p.toolCallId)
      )
      const foldedCalls = plan.summarize.flatMap((m) =>
        (m.parts as Array<{ toolCallId?: string }>).map((p) => p.toolCallId)
      )
      // No call id is on both sides of the cut.
      expect(keptCalls.filter((id) => id && foldedCalls.includes(id))).toEqual([])
      noSplitPairs(plan.keep)
    }
  })

  it('folds an earlier summary into the next one instead of stacking them', () => {
    const earlier = summaryMessage({
      summarizedCount: 5,
      summary: 'old',
      at: 1,
      reason: 'threshold',
    })
    const plan = planCompaction([earlier, ...chat(6)], { keepRecent: 2 })!
    expect(plan.summarize[0]).toBe(earlier)
    expect(plan.keep.some(isSummaryMessage)).toBe(false)
  })

  it('returns null when there is nothing to fold', () => {
    expect(planCompaction(chat(2), { keepRecent: 8 })).toBeNull()
    const earlier = summaryMessage({ summarizedCount: 3, summary: 's', at: 1, reason: 'manual' })
    expect(planCompaction([earlier, ...chat(1)], { keepRecent: 2 })).toBeNull()
  })
})

describe('compactHistory', () => {
  it('replaces the folded part with one summary and keeps the rest', async () => {
    const summarize = vi.fn(async () => 'the gist')
    const system = text('sys', 'system', 'rules')
    const out = (await compactHistory([system, ...chat(6)], {
      summarize,
      keepRecent: 2,
      reason: 'threshold',
      now: () => 42,
    }))!
    expect(out.messages[0]).toBe(system)
    expect(isSummaryMessage(out.messages[1])).toBe(true)
    expect(out.messages.slice(2).map((m) => m.id)).toEqual(['u5', 'a5'])
    expect(out.record).toEqual({
      summarizedCount: 10,
      summary: 'the gist',
      at: 42,
      reason: 'threshold',
    })
    expect(compactionOf(out.messages[1])).toEqual(out.record)
    expect(summarize.mock.calls[0][0]).toContain('question 0')
  })

  it('counts the messages an earlier summary already held', async () => {
    const earlier = summaryMessage({ summarizedCount: 7, summary: 'old', at: 1, reason: 'threshold' })
    const out = (await compactHistory([earlier, ...chat(4)], {
      summarize: async () => 'new',
      keepRecent: 2,
      reason: 'manual',
    }))!
    expect(out.record.summarizedCount).toBe(7 + 6)
  })

  it('still compacts when the summarizer fails', async () => {
    const out = (await compactHistory(chat(6), {
      summarize: async () => {
        throw new Error('model offline')
      },
      keepRecent: 2,
      reason: 'threshold',
    }))!
    expect(out.record.summary).toContain('question 0')
  })

  it('carries a folded request verbatim when no user turn is kept', async () => {
    const run = [
      text('u0', 'user', 'refactor the parser, keep the API'),
      ...Array.from({ length: 6 }, (_, i) => toolCall(`s${i}`, `c${i}`, true)),
    ]
    const out = (await compactHistory(run, {
      summarize: async () => 'did some reads',
      keepRecent: 2,
      reason: 'threshold',
    }))!
    expect(out.latestRequest).toBe('refactor the parser, keep the API')
    const body = (out.messages[0].parts[0] as { text: string }).text
    expect(body).toContain('refactor the parser, keep the API')
  })

  it('describes tool calls and results for the summarizer', () => {
    const t = transcriptForSummary([toolCall('s0', 'c0', true)])
    expect(t).toContain('[tool read]')
    expect(t).toContain('contents of c0')
  })
})

describe('isContextLengthError', () => {
  it('recognises provider refusals for length', () => {
    expect(
      isContextLengthError(
        new Error("This model's maximum context length is 8192 tokens. However, you requested 9000 tokens")
      )
    ).toBe(true)
    expect(isContextLengthError(new Error('prompt is too long: 210000 tokens'))).toBe(true)
    expect(isContextLengthError({ message: 'context_length_exceeded' })).toBe(true)
    expect(
      isContextLengthError(
        new ContextOverflowError({ status: 'over', window: 10, projected: 20, reserve: 1, overBy: 11 })
      )
    ).toBe(true)
  })

  it('does not mistake other failures for it', () => {
    expect(isContextLengthError(new Error('429 rate limited'))).toBe(false)
    expect(isContextLengthError(null)).toBe(false)
  })

  it('does not treat a bare "too many tokens" throttle as a length refusal', () => {
    expect(isContextLengthError(new Error('Too many tokens per minute, slow down'))).toBe(false)
    expect(isContextLengthError(new Error('429: too many tokens, retry after 20s'))).toBe(false)
    expect(isContextLengthError(new Error('Rate limit: too many tokens in your request per minute'))).toBe(false)
  })

  it('still recognises "too many tokens" when it names the prompt or context', () => {
    expect(isContextLengthError(new Error('Too many tokens in the prompt: 210000'))).toBe(true)
    expect(isContextLengthError(new Error('The input has too many tokens for this model'))).toBe(true)
  })
})

describe('compactionWindow', () => {
  it('uses the known window, then one a server named, then the assumed one', async () => {
    const { compactionWindow, ASSUMED_WINDOW_TOKENS } = await import('../compaction')
    expect(compactionWindow(200_000, 100_000)).toBe(200_000)
    expect(compactionWindow(null, 200_000)).toBe(200_000)
    expect(compactionWindow(null, null)).toBe(ASSUMED_WINDOW_TOKENS)
    expect(compactionWindow(0, undefined)).toBe(ASSUMED_WINDOW_TOKENS)
  })
})

describe('compactionTriggerTokens', () => {
  const reserve = (w: number) => Math.min(16384, Math.floor(w / 4)) + Math.max(1024, Math.min(Math.ceil(w * 0.02), Math.floor(w / 4)))

  it('keeps the fixed share for a window the trimmer leaves alone', () => {
    expect(compactionTriggerTokens(128_000, reserve(128_000))).toBe(thresholdTokens(128_000))
    expect(compactionTriggerTokens(200_000, reserve(200_000))).toBe(thresholdTokens(200_000))
    expect(compactionTriggerTokens(128_000)).toBe(thresholdTokens(128_000))
  })

  it('goes under the trimmer for a small window, so compaction gets its chance first', () => {
    for (const w of [4_096, 8_192, 12_000, 32_000, 64_000]) {
      const trigger = compactionTriggerTokens(w, reserve(w))
      expect(trigger).toBeLessThan(thresholdTokens(w))
      // The trimmer drops messages beyond window - reserve; compaction starts before.
      expect(trigger).toBeLessThan(w - reserve(w))
      expect(trigger).toBeGreaterThan(0)
    }
  })

  it('never exceeds the fixed share and has a floor', () => {
    for (let w = 2_000; w <= 400_000; w += 3_333) {
      const t = compactionTriggerTokens(w, reserve(w))
      expect(t).toBeLessThanOrEqual(thresholdTokens(w))
      expect(t).toBeGreaterThanOrEqual(Math.floor(w * 0.1))
    }
  })
})

const bigResult = (id: string, chars: number): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-read',
        toolCallId: `call-${id}`,
        input: {},
        state: 'output-available',
        output: 'x'.repeat(chars),
      },
    ],
  }) as unknown as UIMessage

describe('planCompaction splitTurn', () => {
  // An earlier exchange, then one user turn that grows into a long tool loop.
  const loop = (): UIMessage[] => [
    text('u0', 'user', 'earlier'),
    text('a0', 'assistant', 'earlier answer'),
    text('u1', 'user', 'do the long task'),
    ...Array.from({ length: 12 }, (_, i) => bigResult(`w${i}`, 100)),
  ]

  it('by default backs up to the start of the turn, keeping the whole loop', () => {
    const plan = planCompaction(loop(), { keepRecent: 4 })!
    expect(plan.summarize.map((m) => m.id)).toEqual(['u0', 'a0'])
    expect(plan.keep).toHaveLength(13)
  })

  it('cuts inside the turn when asked, so the loop itself can be folded', () => {
    const plan = planCompaction(loop(), { keepRecent: 4, splitTurn: true })!
    expect(plan.keep.map((m) => m.id)).toEqual(['w8', 'w9', 'w10', 'w11'])
    expect(plan.summarize.map((m) => m.id)).toContain('u1')
  })

  it('carries the folded request verbatim when the turn is split', async () => {
    const result = (await compactHistory(loop(), {
      summarize: async () => 'gist',
      keepRecent: 4,
      splitTurn: true,
      reason: 'threshold',
    }))!
    expect(result.latestRequest).toBe('do the long task')
    expect(JSON.stringify(result.messages[0])).toContain('do the long task')
    noSplitPairs(result.messages)
  })
})

describe('clipToolResultsToFit', () => {
  it('leaves a history that fits untouched, as the same objects', () => {
    const messages = [text('u', 'user', 'hi'), bigResult('a', 3000)]
    const out = clipToolResultsToFit(messages, 100_000)
    expect(out.clippedCount).toBe(0)
    expect(out.messages[1]).toBe(messages[1])
  })

  it('shrinks the largest tool result to fit, keeping its head and tail', () => {
    const big = bigResult('a', 200_000)
    const messages = [text('u', 'user', 'hi'), big]
    const out = clipToolResultsToFit(messages, 5_000)
    expect(estimateHistoryTokens(out.messages)).toBeLessThanOrEqual(5_000)
    const part = out.messages[1].parts[0] as { output: string }
    expect(part.output.startsWith('xxxx')).toBe(true)
    expect(part.output.endsWith('xxxx')).toBe(true)
    expect(part.output).toContain('left out to fit the context window')
    // The input message is not modified.
    expect((big.parts[0] as { output: string }).output).toHaveLength(200_000)
  })

  it('clips the biggest first and stops once it fits', () => {
    const messages = [bigResult('small', 4_000), bigResult('huge', 150_000)]
    const out = clipToolResultsToFit(messages, 12_000)
    expect(out.messages[0]).toBe(messages[0])
    expect(out.clippedCount).toBeGreaterThan(0)
  })

  it('gives up cleanly when nothing is left to clip', () => {
    const messages = [text('u', 'user', 'y'.repeat(50_000))]
    const out = clipToolResultsToFit(messages, 100)
    expect(out.clippedCount).toBe(0)
    expect(out.messages).toBe(messages)
  })
})
