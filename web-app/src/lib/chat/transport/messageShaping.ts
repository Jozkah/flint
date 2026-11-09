// Shaping a conversation before it is sent: empty and orphaned turns, tool
// waves, alternation, images a server cannot take, and continuations. Pure;
// used by CustomChatTransport.

import { hasToolImageSentinel, stripToolImageSentinels } from '@/lib/tool-image-sentinel'
import { i18n } from '@/i18n/react-i18next-compat'
import type { UIMessage } from '@ai-sdk/react'
import type { UIMessageChunk } from 'ai'
import type { ContinuationContent } from '@/lib/custom-chat-transport'
import { hasAudioSentinel } from '@/lib/audio-sentinel'
import { limitImageParts } from '@/lib/imageLimit'
import { hasVideoSentinel } from '@/lib/video-sentinel'

/**
 * Returns true when an assistant message carries no content the model would
 * actually render: no text, no tool call, no file, no reasoning. These appear
 * when a generation fails before any chunk arrives — the AI SDK leaves a bare
 * placeholder in the message list with empty parts.
 */
export function isAssistantMessageEmpty(message: UIMessage): boolean {
  if (message.role !== 'assistant') return false
  const parts = Array.isArray(message.parts) ? message.parts : []
  if (parts.length === 0) return true
  return parts.every((part) => {
    const type = (part as { type?: string }).type
    if (type === 'text' || type === 'reasoning') {
      const text = (part as { text?: string }).text
      return typeof text !== 'string' || text.trim().length === 0
    }
    return false
  })
}

/**
 * Parts of an unanswered user turn to keep when a newer user turn replaces it:
 * its attachments, but not its question. The UI still shows those attachments
 * in the earlier bubble, so a follow-up like "what is in it?" must still reach
 * the model with them. By this point images are `file` parts, audio and video
 * are sentinel-only text parts, and documents are an [ATTACHED_FILES] block
 * (plus any inlined contents) appended after the question text.
 */
export function carryAttachmentsForward(
  dropped: UIMessage['parts'],
  kept: UIMessage['parts']
): UIMessage['parts'] {
  const attachments: UIMessage['parts'] = []
  for (const part of Array.isArray(dropped) ? dropped : []) {
    if (part.type === 'file') {
      attachments.push(part)
    } else if (part.type === 'text' && typeof part.text === 'string') {
      if (hasAudioSentinel(part.text) || hasVideoSentinel(part.text)) {
        attachments.push(part)
        continue
      }
      const filesAt = part.text.indexOf('[ATTACHED_FILES]')
      if (filesAt !== -1) {
        attachments.push({ ...part, text: part.text.slice(filesAt) })
      }
    }
  }
  return [...attachments, ...(Array.isArray(kept) ? kept : [])]
}

/** Only the newest `limit` images, when the server told us how many it takes. */
export const limitIfNeeded = (messages: UIMessage[], limit: number | undefined) =>
  limit != null && limit > 0 ? limitImageParts(messages, limit) : messages

/** Providers that run a model on this machine, with a small context. */
export const LOCAL_ENGINE_PROVIDERS = new Set(['llamacpp', 'mlx'])

/**
 * Drop image parts (and AI-SDK `image` parts) from the history when the
 * active model lacks the `vision` capability. Without this, switching from
 * a vision-capable model to a text-only model mid-thread sends `file` parts
 * the new model can't interpret — most OpenAI-compatible providers 400 on
 * unsupported content types, and llama-server with a non-vision template
 * either errors or silently strips the content (depending on template).
 *
 * Audio sentinels (planted by `encodeAudioAttachments`) are not file parts
 * at this point yet — they're still `file` parts with `audio/*` mediaType —
 * so this only matches `image/*`. Files inlined via `mapUserInlineAttachments`
 * are already text and not affected.
 */
export function stripUnsupportedImageParts(
  messages: UIMessage[],
  modelSupportsVision: boolean
): UIMessage[] {
  if (modelSupportsVision) return messages
  return messages.map((message) => {
    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      return message
    }
    let touched = false
    const nextParts = message.parts.filter((part) => {
      const type = (part as { type?: string }).type
      if (type === 'image') {
        touched = true
        return false
      }
      if (type === 'file') {
        const mediaType = (part as { mediaType?: string }).mediaType
        if (typeof mediaType === 'string' && mediaType.startsWith('image/')) {
          touched = true
          return false
        }
      }
      return true
    }).map((part) => {
      // A tool image sentinel would decode into an image_url part on the tool
      // message; a text-only model rejects that. An error reaches the model
      // the same way a result does.
      const omitted = ` ${i18n.t('chat:transport.imageOmitted', { defaultValue: '(image omitted: the model has no vision)' })}`
      const next: Record<string, string> = {}
      for (const key of ['output', 'errorText'] as const) {
        const value = (part as { [k in typeof key]?: unknown })[key]
        if (typeof value === 'string' && hasToolImageSentinel(value)) {
          next[key] = stripToolImageSentinels(value, omitted)
        }
      }
      if (Object.keys(next).length === 0) return part
      touched = true
      return { ...part, ...next } as typeof part
    })
    if (!touched) return message
    return { ...message, parts: nextParts } as UIMessage
  })
}

export const RESOLVED_TOOL_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
])

/**
 * Mark unresolved tool-call parts on assistant messages as errored so the
 * history sent to the next model still satisfies the "every tool call has a
 * matching tool result" invariant most chat templates enforce.
 *
 * Triggered by: a tool-call sequence is interrupted mid-flight (parse error,
 * abort, network drop). The AI SDK leaves the assistant message with a
 * tool-* part whose `state` is `input-streaming` / `input-available` — no
 * result was ever appended. Sending that history back to a strict template
 * (Gemma, Mistral, alternation-checking Qwen variants) trips a Jinja
 * `raise_exception` on the next turn.
 *
 * We synthesise an `output-error` so the orphan reads as a failed tool call
 * with a brief explanation, preserving the user's intent and the assistant's
 * reasoning instead of dropping the whole turn.
 */
export function resolveOrphanToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message
    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) return message

    // A tool call with no usable name (a stream that never sent one, an
    // imported message) is replayed as `function.name: undefined`, and the
    // provider rejects the whole request ("Expected 'function.name' to be a
    // string"). There is nothing to replay: drop it.
    const named = parts.filter((original) => {
      const type = (original as { type?: string }).type
      if (type === 'dynamic-tool') {
        const name = (original as { toolName?: unknown }).toolName
        return typeof name === 'string' && name.trim() !== '' && name !== 'undefined'
      }
      if (typeof type === 'string' && type.startsWith('tool-')) {
        const name = type.slice('tool-'.length)
        return name.trim() !== '' && name !== 'undefined' && name !== 'null'
      }
      return true
    })
    let mutated = named.length !== parts.length
    const nextParts = named.map((original) => {
      const type = (original as { type?: string }).type
      if (typeof type !== 'string' || !type.startsWith('tool-')) return original
      let part = original
      // A call whose arguments were not JSON keeps its raw text as `input`,
      // and a thread saved that way reloads it the same (messages.ts keeps
      // the unparsed string). Replayed, that is a tool call whose input is
      // not an object, which a chat template cannot render -- every later
      // request in the conversation failed. The call itself stays in the
      // history; only its unusable input is replaced.
      const input = (part as { input?: unknown }).input
      if (
        input !== undefined &&
        (input === null || typeof input !== 'object' || Array.isArray(input))
      ) {
        mutated = true
        part = { ...(part as object), input: {} } as typeof part
      }
      const state = (part as { state?: string }).state
      if (typeof state === 'string' && RESOLVED_TOOL_STATES.has(state)) {
        return part
      }
      mutated = true
      return {
        ...(part as object),
        state: 'output-error',
        errorText:
          (part as { errorText?: string }).errorText ??
          'Tool call did not complete (interrupted by an earlier error).',
      } as typeof part
    })

    if (!mutated) return message
    return { ...message, parts: nextParts }
  })
}

/**
 * Split any assistant message whose parts place non-tool content (text,
 * reasoning, file) AFTER tool-call parts into consecutive assistant messages,
 * one per "wave". This is required for two reasons:
 *
 * 1. Correctness: the Claude API rejects an assistant turn that interleaves
 *    tool_use with text (error 400); it needs tool_use / tool_result pairing.
 * 2. Prompt-cache stability: when a tool-call turn completes, the AI SDK stores
 *    the follow-up text in the SAME assistant UIMessage as the tool call, so
 *    `convertToModelMessages` renders `assistant(tool-call, text)` then
 *    `tool(result)`. But that turn was generated in two requests — the cache
 *    was seeded with `assistant(tool-call)` then `tool(result)`, with no text
 *    yet. Splitting restores the generated order `assistant(tool-call)` ->
 *    `tool(result)` -> `assistant(text)`, so the prefix stays byte-identical
 *    across turns and llama.cpp reuses the KV cache.
 *
 * A message with no tool parts, or with all non-tool parts before the tool
 * parts, is returned unchanged.
 */
export function splitAssistantToolWaves(messages: UIMessage[]): UIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message]

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) return [message]

    const isToolPart = (p: (typeof parts)[number]) =>
      typeof p.type === 'string' && p.type.startsWith('tool-')

    const waves: (typeof parts)[] = []
    let currentWave: typeof parts = []
    let seenToolParts = false

    for (const part of parts) {
      if (isToolPart(part)) {
        seenToolParts = true
        currentWave.push(part)
      } else if (seenToolParts) {
        waves.push(currentWave)
        currentWave = [part]
        seenToolParts = false
      } else {
        currentWave.push(part)
      }
    }
    if (currentWave.length > 0) waves.push(currentWave)

    if (waves.length <= 1) return [message]

    return waves.map((waveParts, i) => ({
      ...message,
      id: `${message.id}_w${i}`,
      parts: waveParts,
    }))
  })
}

/**
 * Enforce strict user/assistant alternation on the message history before it
 * goes to the model.
 *
 * Most chat templates (Gemma, Mistral, Llama 3, Anthropic Claude API,
 * tool-calling Qwen variants, etc.) reject two consecutive turns with the
 * same role — either via a Jinja `raise_exception` or a 400 from the
 * provider. When a generation fails mid-stream the AI SDK still keeps the
 * user message in its state but never appends an assistant reply, so the
 * next send produces `[user, user]` and the next request 500s on the
 * server side. We fix that here by:
 *
 * 1. Dropping assistant placeholders with no content (failed turns).
 * 2. Keeping only the last of any adjacent user messages. The earlier ones
 *    were never answered; merging their text would resend a failed question
 *    inside the next one while the UI shows them as separate bubbles. Their
 *    attachments are carried forward (see carryAttachmentsForward).
 *
 * Adjacent assistant messages are intentionally left alone: the Anthropic
 * serial-tool-use wave-split in `sendMessages` deliberately produces them.
 */
export function coalesceMessagesForAlternation(
  messages: UIMessage[]
): UIMessage[] {
  const filtered = messages.filter((m) => !isAssistantMessageEmpty(m))
  if (filtered.length <= 1) return filtered

  const out: UIMessage[] = [filtered[0]]
  for (let i = 1; i < filtered.length; i++) {
    const prev = out[out.length - 1]
    const cur = filtered[i]
    if (prev.role === 'user' && cur.role === 'user') {
      // The summary a continued chat opens with is a user turn the model must
      // still read: keep it ahead of the next question instead of replacing it.
      const seed = (prev.metadata as Record<string, unknown> | undefined)
        ?.continuedFrom
      out[out.length - 1] = {
        ...cur,
        parts: seed
          ? [...(prev.parts ?? []), ...(cur.parts ?? [])]
          : carryAttachmentsForward(prev.parts, cur.parts),
      }
    } else {
      out.push(cur)
    }
  }
  return out
}

export const TOOL_RESPONSE_ONLY = /^<tool_response>[\s\S]*<\/tool_response>$/

/**
 * A "genuine" user query is a user-role message with non-empty text that isn't
 * entirely a <tool_response> wrapper. Qwen3.5+ chat templates raise
 * "No user query found in messages" when none survives — e.g. the user deletes
 * the only real user turn (leaving orphaned assistant/tool turns) or token
 * eviction drops it. Guard the send so we fail with a clear message instead.
 */
export function hasGenuineUserQuery(messages: UIMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== 'user') return false
    const text = (m.parts ?? [])
      .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
      .join('')
      .trim()
    return text.length > 0 && !TOOL_RESPONSE_ONLY.test(text)
  })
}

/** Text from the most recent user message (for MCP server routing). */
export function extractLatestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const parts = Array.isArray(m.parts) ? m.parts : []
    const chunks: string[] = []
    for (const p of parts) {
      if (p.type === 'text' && typeof (p as { text?: string }).text === 'string') {
        const t = (p as { text: string }).text.trim()
        if (t) chunks.push(t)
      }
    }
    if (chunks.length > 0) return chunks.join('\n')
  }
  return ''
}

/**
 * Wraps a UIMessageChunk stream so the partial content of a resumed turn is
 * injected back into the new message right away: `reasoning` into the first
 * `reasoning-start` block and `text` into the first `text-start` block. This
 * makes the continuation look seamless instead of dropping the partial output.
 */
export function prependContinuationToUIStream(
  stream: ReadableStream<UIMessageChunk>,
  prefix: ContinuationContent
): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader()
  let reasoningEmitted = !prefix.reasoning
  let textEmitted = !prefix.text
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
        const type = (value as { type: string }).type
        if (!reasoningEmitted && type === 'reasoning-start') {
          reasoningEmitted = true
          const id = (value as { id: string }).id
          controller.enqueue({
            type: 'reasoning-delta',
            id,
            delta: prefix.reasoning,
          } as UIMessageChunk)
        }
        if (!textEmitted && type === 'text-start') {
          textEmitted = true
          const id = (value as { id: string }).id
          controller.enqueue({
            type: 'text-delta',
            id,
            delta: prefix.text,
          } as UIMessageChunk)
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      reader.cancel()
    },
  })
}
