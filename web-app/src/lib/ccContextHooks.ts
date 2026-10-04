/**
 * The user's Claude Code context hooks (`SessionStart`, `UserPromptSubmit`),
 * for the surfaces that do not run the Rust agent loop: desktop chat and
 * Cowork. The hooks themselves run in Rust (`cc_hooks.rs`), with the loop's
 * trust (the user's opt-in at import time), timeouts, output caps and
 * placement; this file only asks for them and puts the text where the loop
 * does.
 *
 * - SessionStart text follows the system prompt, once per session.
 * - UserPromptSubmit text is a `<SYSTEM>` reminder appended to the user's own,
 *   unanswered message, never to a tool result and never stored.
 *
 * Nothing here can fail a turn: no opt-in, no Tauri, a broken hook or a slow
 * one all come back as "nothing to add".
 */
import type { UIMessage } from 'ai'
import { invoke } from '@/lib/previewInvoke'

export type CcContextHooks = {
  enabled: boolean
  sessionStart: string[]
  promptSubmit: string[]
}

export const NO_CC_CONTEXT: CcContextHooks = {
  enabled: false,
  sessionStart: [],
  promptSubmit: [],
}

/** A slow hook must not hold a turn; the Rust side has its own, longer limits. */
const ASK_TIMEOUT_MS = 20_000

const OPEN_TAG = '<SYSTEM>'
const CLOSE_TAG = '</SYSTEM>'

/** The text of a user message, the way a hook reads it as the prompt. */
export function userMessageText(message: UIMessage | undefined): string {
  if (!message || message.role !== 'user') return ''
  return message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim()
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : []
}

/**
 * Ask Rust to run the hooks for this turn. `prompt` is the user's message, or
 * nothing on a turn that is not answering one (a tool follow-up), in which
 * case only the session context comes back.
 */
export async function runCcContextHooks(args: {
  sessionId?: string | null
  projectDir?: string | null
  prompt?: string | null
  /** For tests; defaults to the turn-holding limit. */
  timeoutMs?: number
}): Promise<CcContextHooks> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([
      invoke<Partial<CcContextHooks> | null>('run_cc_context_hooks', {
        sessionId: args.sessionId ?? null,
        projectDir: args.projectDir ?? null,
        prompt: args.prompt ?? null,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), args.timeoutMs ?? ASK_TIMEOUT_MS)
      }),
    ])
    if (!answer || answer.enabled !== true) return NO_CC_CONTEXT
    return {
      enabled: true,
      sessionStart: strings(answer.sessionStart),
      promptSubmit: strings(answer.promptSubmit),
    }
  } catch {
    return NO_CC_CONTEXT
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** SessionStart blocks after the system prompt, blank-line separated, as the loop does. */
export function appendSessionContext(
  system: string | undefined,
  blocks: string[]
): string | undefined {
  if (blocks.length === 0) return system
  const added = blocks.join('\n\n')
  return system && system.trim() !== '' ? `${system}\n\n${added}` : added
}

/**
 * UserPromptSubmit blocks as `<SYSTEM>` reminders on the trailing user
 * message. A copy: the stored conversation never holds them. When the last
 * message is not the user's, there is nothing unanswered to attach to and the
 * messages are returned as they are.
 */
export function withPromptContext(
  messages: UIMessage[],
  blocks: string[]
): UIMessage[] {
  if (blocks.length === 0 || messages.length === 0) return messages
  const last = messages[messages.length - 1]
  if (last.role !== 'user') return messages
  const reminders = blocks.map((text) => ({
    type: 'text' as const,
    text: `${OPEN_TAG}\n${text}\n${CLOSE_TAG}`,
  }))
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts, ...reminders] }]
}
