/**
 * What the run actually sends, measured by category.
 *
 * The complaint this answers is "Jan starts with too little context" — which
 * nobody could confirm or refute, because no number existed anywhere. The
 * readiness card had the categories and the vocabulary for this from the start
 * and was handed `measured(null)` for every one of them.
 *
 * Two rules shape everything here.
 *
 * **Measure the payload, not the intent.** Every number below comes from
 * serialising the thing that is actually sent — the system prompt string, the
 * tool schemas as JSON, the conversation as the model will receive it. Nothing
 * is inferred from a setting or a count of files. If a category is not in the
 * payload, it measures zero, and that zero is the honest headline: a repository
 * map worth 0 tokens is precisely the answer to "what did the model get?".
 *
 * **A zero is not an unknown.** `measured(0)` says "nothing of this was sent";
 * `measured(null)` says "nobody knows". Conflating them would turn the card
 * back into the thing it replaced.
 */

import type { UIMessage } from 'ai'
import {
  estimated,
  measured,
  UNKNOWN_SHAPING,
  type ContextAccounting,
  type ContextShaping,
  type Measured,
} from '@/lib/coworkReadiness'

/**
 * Characters per token, for text that is mostly English prose and code.
 *
 * Deliberately a single blunt constant rather than a tuned table. The number
 * is shown to the user *as an estimate with its method attached*, so its job is
 * to be roughly right and obviously approximate — not to look authoritative.
 * A per-model table would make it look counted without making it counted.
 */
const CHARS_PER_TOKEN = 4

/** Shown next to any number this module derives. */
export const ESTIMATE_METHOD = `~${CHARS_PER_TOKEN} chars per token`

/**
 * Bytes, not UTF-16 code units.
 *
 * `String.length` counts a 4-byte emoji as 2 and a 3-byte CJK character as 1,
 * so a prompt of CJK text would be reported at roughly a third of its size.
 * Tokenizers work on the encoded form, so the estimate should too.
 */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** A labelled token estimate for one piece of text. Empty text is a real zero. */
export function estimateTokens(text: string | null | undefined): Measured {
  if (text == null) return measured(null)
  if (text === '') return measured(0)
  return estimated(utf8Bytes(text) / CHARS_PER_TOKEN, ESTIMATE_METHOD)
}

/**
 * The conversation as the model receives it.
 *
 * Counts the text of every part that carries text, plus tool call inputs and
 * results, because those are in the payload too and are frequently the largest
 * thing in it — a run that has read six files is mostly tool results by the
 * time it is a dozen steps in. Non-text parts (images) are not counted: their
 * cost is not a function of their serialised length, and guessing would be
 * worse than the visible omission.
 */
export function conversationText(messages: readonly UIMessage[]): string {
  const out: string[] = []
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') out.push(record.text)
      if (record.input != null) out.push(safeJson(record.input))
      if (record.output != null) out.push(safeJson(record.output))
      if (typeof record.errorText === 'string') out.push(record.errorText)
    }
  }
  return out.join('\n')
}

/**
 * JSON, or an empty string when the value cannot be serialised.
 *
 * A circular structure in a tool result must not take the whole card down with
 * it; the cost of the miss is one under-counted part, which the estimate label
 * already covers.
 */
function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

export type ContextPackInput = {
  /** The assembled system prompt, exactly as it will be sent. */
  systemPrompt: string | null
  /** The advertised tool set, keyed by name, as handed to the model. */
  toolSchemas: Record<string, unknown> | null
  /** The conversation so far, as it will be sent. */
  messages: readonly UIMessage[] | null
  /**
   * The repository map block, exactly as it was embedded in `systemPrompt`.
   *
   * Passed separately because it is *inside* the system prompt: counting it on
   * its own and leaving `instructions` alone would report the same bytes twice,
   * and the two categories would sum to more than the run sends. So the map's
   * bytes are subtracted from `instructions` below, and the categories still
   * add up to the payload.
   *
   * Absent means no map was built for this run, which measures zero: the
   * repository-map share of the prompt really is nothing.
   */
  repositoryMap?: string | null
  /**
   * Skill content carried *in the prompt*.
   *
   * Not the number of skills available. Cowork advertises `skill_list` and
   * `skill_read` and injects no catalogue, so this is normally zero: skills
   * reach the model only if it goes and fetches them, and that traffic lands in
   * the conversation where it is already counted.
   */
  skillsInPrompt?: string | null
  /**
   * The model's context window.
   *
   * Configured rather than live: llama.cpp's `--fit` can pick a runtime `n_ctx`
   * far from the configured size, and that is only knowable once the model is
   * loaded. So a configured value is reported as an estimate, with the reason.
   */
  configuredContextTokens?: number | null
  /**
   * What the context manager did on the way out.
   *
   * Omitted only where there is nothing to say yet — before a run has
   * dispatched anything. It is never defaulted to "unchanged": claiming
   * nothing was removed is a claim, and an un-dispatched run has not earned
   * it.
   */
  shaping?: ContextShaping
}

/**
 * The system prompt's own share, with the repository map's bytes taken out.
 *
 * The map is a block of the system prompt, so measuring both from the whole
 * string would double-count it and the categories would sum past the payload.
 * Subtracting bytes rather than deleting a substring keeps this exact even if
 * the block appears with different surrounding whitespace than the caller
 * expects — and it can never go negative, because the map is a substring of the
 * prompt it came from. A map that somehow is not (a caller passing a block the
 * prompt did not embed) clamps at zero rather than reporting a negative
 * instruction budget.
 */
function instructionsWithoutMap(
  systemPrompt: string | null | undefined,
  map: string
): Measured {
  if (systemPrompt == null) return measured(null)
  if (map === '') return estimateTokens(systemPrompt)
  const rest = Math.max(0, utf8Bytes(systemPrompt) - utf8Bytes(map))
  if (rest === 0) return measured(0)
  return estimated(rest / CHARS_PER_TOKEN, ESTIMATE_METHOD)
}

/** Why a configured window is not the same as the window in force. */
export const BUDGET_METHOD = 'configured context size; the loaded model may differ'

/**
 * One run's context accounting.
 *
 * Every category resolves to a number or to an explicit unknown; none is left
 * to a default. `systemPrompt`, `toolSchemas` and `messages` are nullable
 * because the card is drawn before a run exists, and before a run exists the
 * honest answer for those is that nobody knows yet — not zero.
 */
export function measureContextPack(input: ContextPackInput): ContextAccounting {
  const map = input.repositoryMap ?? ''
  return {
    categories: {
      instructions: instructionsWithoutMap(input.systemPrompt, map),
      skills: estimateTokens(input.skillsInPrompt ?? ''),
      repositoryMap: estimateTokens(map),
      conversation: input.messages
        ? estimateTokens(conversationText(input.messages))
        : measured(null),
      tools: input.toolSchemas
        ? estimateTokens(safeJson(input.toolSchemas))
        : measured(null),
    },
    budget:
      input.configuredContextTokens != null
        ? estimated(input.configuredContextTokens, BUDGET_METHOD)
        : measured(null),
    shaping: input.shaping ?? UNKNOWN_SHAPING,
  }
}

/**
 * The shaping record for a payload that went out exactly as assembled.
 *
 * Distinct from `UNKNOWN_SHAPING`, and the distinction is the point: this one
 * is a measurement ("everything was sent"), the other is an absence ("nothing
 * has been sent"). Collapsing them would let a run that has not started yet
 * report a clean bill of health.
 */
export function unchangedShaping(retained: number): ContextShaping {
  return {
    kind: 'unchanged',
    removed: 0,
    retained,
    removedTokens: measured(0),
    reason: null,
  }
}

/**
 * The shaping record for a payload the context manager cut down.
 *
 * `removedTokens` is estimated from the messages that were dropped, by the
 * same method every other number here uses — so "3 messages, ~1,200 tokens"
 * can be read against the budget on the same line without converting units in
 * the reader's head. The messages themselves are not retained: this record is
 * rendered, and a dropped message can hold anything the conversation held.
 */
export function shapingFor(input: {
  kind: ContextShaping['kind']
  before: readonly UIMessage[]
  after: readonly UIMessage[]
  summarised?: boolean
  reason?: string | null
}): ContextShaping {
  const removed = Math.max(0, input.before.length - input.after.length)
  if (removed === 0 && input.kind !== 'failed') {
    return unchangedShaping(input.after.length)
  }
  // Measured as the difference between the two payloads rather than by
  // slicing off the front: compaction rewrites as well as drops, so "the first
  // N messages" is not the same set as "what is no longer being sent".
  const beforeBytes = utf8Bytes(conversationText(input.before))
  const afterBytes = utf8Bytes(conversationText(input.after))
  return {
    kind: input.kind,
    removed,
    retained: input.after.length,
    removedTokens: estimated(
      Math.max(0, beforeBytes - afterBytes) / CHARS_PER_TOKEN,
      ESTIMATE_METHOD
    ),
    reason: input.reason ?? null,
  }
}

/**
 * One line describing what happened to the payload, ready to translate.
 *
 * Shared so the context breakdown and the completion summary say the same
 * thing about the same run. Two surfaces phrasing this independently is how
 * they end up disagreeing about whether anything was dropped.
 *
 * Carries counts and a failure reason. It never carries message text: this
 * reaches the screen, and a dropped message holds whatever the conversation
 * held.
 */
export type ShapingNotice = {
  key: string
  params: Record<string, string | number>
}

export function shapingNotice(shaping: ContextShaping): ShapingNotice {
  const tokens =
    shaping.removedTokens.known === false ? 0 : shaping.removedTokens.tokens
  return {
    key: `common:readiness.shaping.${shaping.kind}`,
    params: {
      removed: shaping.removed,
      retained: shaping.retained,
      tokens,
      // Empty rather than absent, so a template referring to it never renders
      // the literal placeholder.
      reason: shaping.reason ?? '',
    },
  }
}

/**
 * Did the context manager actually take something out?
 *
 * The question the completion summary asks: an unchanged payload is not worth
 * a line there, and an un-dispatched one has nothing to report. A failed
 * compaction is always worth saying, even if trimming then removed nothing,
 * because the window in force is not the one that was configured.
 */
export function shapingWorthReporting(shaping: ContextShaping): boolean {
  return shaping.kind === 'failed' || shaping.removed > 0
}
