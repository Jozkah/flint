/* eslint-disable @typescript-eslint/no-explicit-any */
import type { UIMessage } from 'ai'
import type { CoworkTurn } from '@/types/coworkSession'
import { reasoningPartsFromText } from '@/lib/messages'

/**
 * Adapts the code screen's flat `CoworkTurn[]` transcript into the AI SDK
 * `UIMessage[]` shape that `MessageItem` (the shared chat renderer) consumes.
 *
 * Grouping: each `user` turn starts a user message; every following
 * `assistant`/`tool` turn folds into a single assistant message (assistant text
 * as reasoning/`text` parts, tool calls as `tool-<name>` parts) until the next user turn —
 * mirroring how one agent turn maps to one assistant message with ordered parts.
 *
 * `diff` has no slot on a UIMessage tool part, so it does not travel here at all.
 * It is published to `useToolCallRuntime.diffs` by the caller and rendered as a
 * real coloured diff by `AgentToolWidget`, keyed on `toolCallId`. Folding it into
 * the output text would also corrupt the output the widget parses.
 */
/**
 * The id `coworkTurnsToUIMessages` will give the assistant message currently
 * being built — the one a tool call happening now will render inside.
 *
 * Anything that needs to attach to that message (the inline workflow card) has
 * to name it by the same rule the conversion uses, so the rule lives here
 * beside it: a block starts after the last user turn, and its id comes from the
 * first turn in that block that actually produces a part. An assistant turn
 * with no content produces none, so it does not open the message.
 *
 * Returns undefined when the block has produced nothing yet, because there is
 * no message to attach to.
 */
export function assistantAnchorId(
  turns: CoworkTurn[],
  idPrefix = 'code'
): string | undefined {
  let start = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') {
      start = i + 1
      break
    }
  }
  for (let i = start; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.role === 'tool' || (turn.role === 'assistant' && turn.content)) {
      return `${idPrefix}-asst-${i}`
    }
  }
  return undefined
}

/**
 * Whether a tool turn is one the "Hide completed tool activity" option may
 * hide.
 *
 * Only a clean success. Anything running, waiting on permission, failed,
 * refused, cancelled or stale stays on screen whatever the setting says --
 * hiding those would hide the things that need attention.
 */
export function isHideableToolTurn(turn: CoworkTurn): boolean {
  if (turn.role !== 'tool') return false
  if (turn.isError) return false
  if (turn.toolState) return turn.toolState === 'succeeded'
  // Turns written before the state field existed: a finished call with no
  // error is a success.
  return turn.status === 'done'
}

export type CoworkTurnsOptions = {
  /**
   * Hide successfully completed tool activity from the timeline.
   *
   * A presentation filter and nothing more: the turns are still in the
   * session, still exported, and still searchable. Turning it off shows them
   * again with no reload.
   */
  hideCompletedTools?: boolean
  /**
   * Leave out user rows Flint wrote itself (`CoworkTurn.hidden`). For the
   * timeline only: the stored transcript keeps them, because the model has to
   * see what it was asked.
   */
  omitHiddenTurns?: boolean
}

export function coworkTurnsToUIMessages(
  turns: CoworkTurn[],
  idPrefix = 'code',
  options: CoworkTurnsOptions = {},
  // The position of `turns[0]` in the whole transcript, so a slice converted on
  // its own mints the same message ids the full transcript would. Lets the
  // committed transcript and the rows a run is still producing be converted
  // separately without either changing identity. AH: only-live-tail re-render.
  indexOffset = 0
): UIMessage[] {
  const messages: UIMessage[] = []
  let assistant: any = null

  const flushAssistant = () => {
    if (assistant && assistant.parts.length > 0) messages.push(assistant)
    assistant = null
  }

  const ensureAssistant = (index: number) => {
    if (!assistant) {
      assistant = { id: `${idPrefix}-asst-${index}`, role: 'assistant', parts: [] }
    }
    return assistant
  }

  turns.forEach((turn, at) => {
    const i = at + indexOffset
    // Another session stopped this run: a row of its own, display only.
    if (turn.stopNotice) {
      flushAssistant()
      messages.push({
        id: `${idPrefix}-stop-${i}`,
        role: 'assistant',
        parts: [{ type: 'data-session-stop', data: turn.stopNotice }],
      } as any)
      return
    }
    // The conversation was compacted here: a divider row, display only.
    if (turn.compaction) {
      flushAssistant()
      messages.push({
        id: `${idPrefix}-compaction-${i}`,
        role: 'assistant',
        parts: [{ type: 'data-compaction', data: turn.compaction }],
      } as any)
      return
    }
    if (turn.role === 'user') {
      flushAssistant()
      if (turn.hidden && options.omitHiddenTurns) return
      const metadata: Record<string, unknown> = {}
      if (turn.hidden) metadata.hidden = true
      // janhq/jan#8864: marked where it entered a run as steering.
      if (turn.steered) metadata.steered = true
      // Mail from another session: attributed to its sender, not the user.
      if (turn.from) {
        metadata.agentMessage = {
          sessionId: turn.from.sessionId,
          displayName: turn.from.displayName,
          messageId: turn.from.messageId,
          replyTo: turn.from.replyTo ?? null,
        }
      }
      messages.push({
        id: `${idPrefix}-user-${i}`,
        role: 'user',
        parts: [{ type: 'text', text: turn.content }],
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      } as any)
      return
    }

    if (turn.role === 'assistant') {
      // AH-078. The snapshot rides on the assistant message it produced, so the
      // viewer sits with the invocation it belongs to rather than showing a
      // "latest" payload beside an older turn.
      if (turn.promptSnapshot) {
        ensureAssistant(i).parts.push({
          type: 'data-prompt-snapshot',
          data: turn.promptSnapshot,
        } as never)
      }
      // The request's own usage and the memory ids it carried, so this turn's
      // breakdown is shown for this turn. Display only: `data-` parts are not
      // sent to the model.
      if (turn.usage || turn.memory) {
        ensureAssistant(i).parts.push({
          type: 'data-turn-usage',
          data: { usage: turn.usage, memory: turn.memory },
        } as never)
      }
      if (turn.tokenSpeed) {
        const asst = ensureAssistant(i)
        asst.metadata = {
          ...(asst.metadata ?? {}),
          tokenSpeed: turn.tokenSpeed,
        }
      }
      // Questions the run asked here. They stay in the transcript after they
      // are answered, so the answer is part of the history.
      for (const ask of turn.asks ?? []) {
        ensureAssistant(i).parts.push({
          type: 'data-ask',
          data: ask,
        } as never)
      }
      // Split out <think>/<thought> reasoning into reasoning parts (same helper
      // the chat loader uses) so the agent's chain-of-thought renders in the
      // collapsible reasoning UI instead of leaking into the transcript as text.
      if (turn.content) {
        const asst = ensureAssistant(i)
        for (const part of reasoningPartsFromText(turn.content)) {
          asst.parts.push(part)
        }
      }
      return
    }

    if (options.hideCompletedTools && isHideableToolTurn(turn)) {
      // Counted, not dropped: the timeline says how many are hidden and offers
      // to show them.
      const asst = ensureAssistant(i)
      const existing = asst.parts.find(
        (p: any) => p.type === 'data-hidden-tools'
      )
      if (existing) existing.data.count += 1
      else asst.parts.push({ type: 'data-hidden-tools', data: { count: 1 } })
      return
    }

    // tool turn -> a `tool-<name>` part on the current assistant message.
    const name = turn.name ?? 'tool'
    const running = turn.status === 'running'
    const part: any = {
      type: `tool-${name}`,
      toolCallId: turn.callId ?? `code-tool-${i}`,
      // #321: a call saved before its arguments arrived is replayed with an
      // empty object, never without `input`: providers reject a tool call
      // with no arguments, and every later request would fail the same way.
      input: turn.args ?? {},
      state: running
        ? 'input-available'
        : turn.isError
          ? 'output-error'
          : 'output-available',
    }

    if (!running) {
      // Legacy turns carry only `content`; new turns carry `result`.
      const output = turn.result ?? turn.content ?? ''
      if (turn.isError) {
        part.errorText = output
      } else {
        part.output = output
      }
    }

    ensureAssistant(i).parts.push(part)
  })

  flushAssistant()
  return messages
}

/**
 * The committed transcript followed by the rows a run is still producing.
 *
 * Converting the two separately keeps every committed message's identity across
 * a streamed delta, so `MessageItem`'s memo skips them and a `write` of any
 * size re-renders only the card it is filling. The one seam is a run resumed
 * without a question: its first rows continue the last committed assistant
 * message, so the two are joined here exactly as one conversion would have.
 */
export function appendLiveMessages(
  committed: UIMessage[],
  live: UIMessage[]
): UIMessage[] {
  if (live.length === 0) return committed
  const last = committed.at(-1)
  if (!last || last.role !== 'assistant' || live[0].role !== 'assistant') {
    return [...committed, ...live]
  }
  const joined = { ...last, parts: [...last.parts, ...live[0].parts] }
  return [...committed.slice(0, -1), joined, ...live.slice(1)]
}

const segmentCache = new WeakMap<UIMessage, UIMessage[]>()

/**
 * An assistant message split into the model rounds it was built from.
 *
 * One reply folds every round of a run (text, tool calls, the next request's
 * text ...) into a single message, but what belongs to each round -- what the
 * model received, the round's token usage, a workflow card -- is drawn after
 * the message. Rendered whole, a live run's newest text and approval requests
 * therefore landed above those older rows. Split at each round's start (the
 * `data-prompt-snapshot` part, or `data-turn-usage` when a round has no
 * snapshot), every round renders with its own rows directly beneath it, and
 * the newest round is always last.
 *
 * The first segment keeps the message's id, so anything anchored to the
 * message (a workflow, a positional snapshot) still finds it. Cached per
 * message object, so a committed message keeps stable segments across renders.
 */
export function segmentAssistantMessage(message: UIMessage): UIMessage[] {
  if (message.role !== 'assistant') return [message]
  const cached = segmentCache.get(message)
  if (cached) return cached
  const groups: UIMessage['parts'][] = [[]]
  message.parts.forEach((part, index) => {
    const current = groups[groups.length - 1]
    const type = (part as { type: string }).type
    const previous = (message.parts[index - 1] as { type?: string } | undefined)
      ?.type
    const startsRound =
      type === 'data-prompt-snapshot' ||
      (type === 'data-turn-usage' && previous !== 'data-prompt-snapshot')
    if (startsRound && current.length > 0) groups.push([part])
    else current.push(part)
  })
  const segments =
    groups.length === 1
      ? [message]
      : groups.map((parts, k) =>
          k === 0
            ? { ...message, parts }
            : { ...message, id: `${message.id}-r${k}`, parts }
        )
  segmentCache.set(message, segments)
  return segments
}

/**
 * The segment a workflow card follows: the round that made its first
 * dispatch, so the card sits where the work started and everything the run
 * did afterwards is below it. The last segment when no dispatch is found.
 */
export function workflowSegmentIndex(
  segments: UIMessage[],
  callIds: Iterable<string>
): number {
  const ids = new Set(callIds)
  const at = segments.findIndex((segment) =>
    segment.parts.some((part) => {
      const id = (part as { toolCallId?: string }).toolCallId
      return typeof id === 'string' && ids.has(id)
    })
  )
  return at >= 0 ? at : segments.length - 1
}

/**
 * Messages with every tool part carrying an `input`. #321.
 *
 * A tool call replayed without arguments is rejected by the provider on every
 * request after it, so a session holding one can never continue. Parts that
 * already have an input are left alone, and so is every message without such a
 * part (returned as the same object).
 */
export function withToolInputs<T extends { parts: unknown[] }>(messages: T[]): T[] {
  return messages.map((message) => {
    if (!Array.isArray(message.parts)) return message
    let changed = false
    const parts = message.parts.map((part) => {
      const record = part as Record<string, unknown> | null
      if (
        record &&
        typeof record.type === 'string' &&
        (record.type.startsWith('tool-') || record.type === 'dynamic-tool') &&
        'toolCallId' in record &&
        record.input === undefined
      ) {
        changed = true
        return { ...record, input: {} }
      }
      return part
    })
    return changed ? { ...message, parts } : message
  })
}
