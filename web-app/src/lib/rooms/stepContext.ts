/**
 * Keeps one participant turn inside its window while it runs tools.
 *
 * A turn that uses tools is several model calls inside one SDK call, and every
 * tool result is added to the next call. Nothing between those steps looked at
 * the size, so a few large results took a request past the window with no
 * chance to compact: the provider refused it and the turn was lost. Before
 * each step the guard measures the request (and what the next result is
 * expected to add) against the window, and when it would not fit:
 *
 * 1. old tool output is cleared, oldest first (the cheapest thing to give up,
 *    as in Chat); the newest results are kept;
 * 2. if the newest results alone are too large, they are cut to fit;
 * 3. if even that leaves no room to continue, tools are turned off so the
 *    participant writes its reply with what it has.
 *
 * Pure: it knows nothing about models or the SDK's loop beyond message shape.
 */
import type { ModelMessage } from 'ai'
import { contextSafetyMargin, estimateTokens } from '@/lib/context-manager'
import { compactionHeadroom } from '@/lib/compaction'
import { replyReserveFor } from '@/lib/coworkBudget'

export const CLEARED_TOOL_OUTPUT =
  '[Earlier tool output cleared to keep the conversation inside the context window. Run the tool again if you still need it.]'

export const NO_ROOM_NOTICE =
  'The conversation has no room left for more tool output. Do not call any more tools: write your reply now from what you already have, saying what is still open and who should act next.'

export type StepGuardInput = {
  messages: ModelMessage[]
  /** The system prompt as sent. */
  system: string
  /** Tokens the advertised tool definitions take on every step. */
  toolTokens: number
  window: number
  /** The per-step output cap the request must leave room for. */
  maxOutputTokens: number
  /** The request size the provider reported for the previous step, if it did. */
  lastRequestTokens?: number
}

export type StepGuardResult = {
  messages: ModelMessage[]
  /** Tool results cleared outright. */
  cleared: number
  /** Tool results cut to fit. */
  clipped: number
  /** No room is left for another tool step. */
  finish: boolean
}

type ToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: string; value?: unknown }
}

function isToolMessage(m: ModelMessage): boolean {
  return m.role === 'tool' && Array.isArray(m.content)
}

/** Estimated tokens of messages as they will be serialised. */
export function estimateModelMessages(messages: readonly ModelMessage[]): number {
  let text = ''
  try {
    text = JSON.stringify(messages)
  } catch {
    text = String(messages.length)
  }
  return estimateTokens(text)
}

/** Estimated tokens of tool definitions: name, description and schema. */
export function estimateToolTokens(
  tools: Record<string, unknown> | undefined
): number {
  if (!tools) return 0
  let total = 0
  for (const [name, tool] of Object.entries(tools)) {
    const t = tool as { description?: string; inputSchema?: unknown }
    let schema = ''
    try {
      const raw = t.inputSchema as { jsonSchema?: unknown } | undefined
      schema = JSON.stringify(raw?.jsonSchema ?? raw ?? '')
    } catch {
      schema = ''
    }
    total += estimateTokens(`${name} ${t.description ?? ''} ${schema}`) + 8
  }
  return total
}

function outputText(output: ToolResultPart['output']): string {
  const v = output?.value
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v ?? '')
  } catch {
    return String(v)
  }
}

function withOutput(part: ToolResultPart, text: string): ToolResultPart {
  return { ...part, output: { type: part.output?.type === 'error-text' ? 'error-text' : 'text', value: text } }
}

/** Head and tail of `text`, within `chars`. */
function clipMiddle(text: string, chars: number): string {
  if (text.length <= chars) return text
  const half = Math.max(0, Math.floor((chars - 40) / 2))
  return `${text.slice(0, half)}\n... (cut to fit the context window) ...\n${text.slice(text.length - half)}`
}

/**
 * Growth per step from the messages themselves: each tool message is one
 * step's results. The basis for how much the next step is expected to add.
 */
export function stepGrowths(messages: readonly ModelMessage[]): number[] {
  return messages
    .filter(isToolMessage)
    .map((m) => estimateModelMessages([m as unknown as ModelMessage]))
}

export function guardStepMessages(input: StepGuardInput): StepGuardResult {
  const { window } = input
  const base = estimateTokens(input.system) + input.toolTokens
  const limit =
    window -
    Math.max(input.maxOutputTokens, replyReserveFor(window)) -
    contextSafetyMargin(window)
  const headroom = compactionHeadroom(stepGrowths(input.messages).slice(-3), window)
  // The provider's own count for the previous request is a floor: when it is
  // above the estimate, the estimate under-counts by that much from here on.
  const slack = Math.max(
    0,
    (input.lastRequestTokens ?? 0) - (base + estimateModelMessages(input.messages))
  )
  let messages = input.messages
  let cleared = 0
  let clipped = 0
  const size = () => base + slack + estimateModelMessages(messages)
  const fits = () => size() + headroom <= limit

  if (fits()) return { messages, cleared, clipped, finish: false }

  // 1. Clear old tool output, oldest first, keeping the newest tool message.
  const toolIdx = messages
    .map((m, i) => (isToolMessage(m) ? i : -1))
    .filter((i) => i >= 0)
  const newest = toolIdx.length ? toolIdx[toolIdx.length - 1] : -1
  for (const i of toolIdx) {
    if (i === newest || fits()) break
    const m = messages[i] as { role: 'tool'; content: ToolResultPart[] }
    const content = m.content.map((part) => {
      if (part.type !== 'tool-result' || outputText(part.output) === CLEARED_TOOL_OUTPUT) {
        return part
      }
      cleared++
      return withOutput(part, CLEARED_TOOL_OUTPUT)
    })
    const copy = [...messages]
    copy[i] = { ...m, content } as unknown as ModelMessage
    messages = copy
  }

  // 2. The newest results alone are too large: cut them to what is left.
  if (newest >= 0 && !fits()) {
    const m = messages[newest] as { role: 'tool'; content: ToolResultPart[] }
    const others = size() - estimateModelMessages([m as unknown as ModelMessage])
    const roomTokens = Math.max(0, limit - headroom - others)
    const results = m.content.filter((p) => p.type === 'tool-result').length
    const share = Math.max(200, Math.floor((roomTokens * 3.5) / Math.max(1, results)) - 120)
    const content = m.content.map((part) => {
      if (part.type !== 'tool-result') return part
      const text = outputText(part.output)
      if (text.length <= share) return part
      clipped++
      return withOutput(part, clipMiddle(text, share))
    })
    const copy = [...messages]
    copy[newest] = { ...m, content } as unknown as ModelMessage
    messages = copy
  }

  // 3. Still no room for what the next step may add: stop calling tools.
  return { messages, cleared, clipped, finish: !fits() }
}
