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
}

export function coworkTurnsToUIMessages(
  turns: CoworkTurn[],
  idPrefix = 'code',
  options: CoworkTurnsOptions = {}
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

  turns.forEach((turn, i) => {
    if (turn.role === 'user') {
      flushAssistant()
      messages.push({
        id: `${idPrefix}-user-${i}`,
        role: 'user',
        parts: [{ type: 'text', text: turn.content }],
        // janhq/jan#8864: marked where it entered a run as steering.
        ...(turn.steered ? { metadata: { steered: true } } : {}),
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
      input: turn.args,
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
