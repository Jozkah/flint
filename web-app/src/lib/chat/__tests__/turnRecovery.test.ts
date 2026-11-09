import { beforeEach, describe, expect, it } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import {
  MAX_AUTO_RETRIES_PER_TURN,
  claimAutoRetry,
  isEngineGoneError,
  isRecoverableLocalProvider,
  planEngineRecovery,
  resetAutoRetries,
  resolvedToolCallIds,
  turnUserMessageId,
} from '../turnRecovery'
import { LLAMACPP_CRASH_MESSAGE } from '@/lib/model/transportErrors'
import { OUT_OF_CONTEXT_SIZE } from '@/utils/error'

// What a dead llama.cpp looks like by the time it reaches the chat: the
// transport's own words for a loopback failure (core/net/transport.rs
// `transport_failed`), customFetch's friendly wrapper, and the OS text.
const REFUSED_BEFORE_HEAD =
  "Couldn't reach the provider — the connection failed. Check the provider's Base URL and your internet connection, then try again. (http://localhost:3141/v1/chat/completions)\nDetails: localhost:3141 could not connect: tcp connect error: No connection could be made because the target machine actively refused it. (os error 10061)"
const RESET_MID_STREAM =
  'localhost:3141 failed: error decoding response body: An existing connection was forcibly closed by the remote host. (os error 10054)'
const ABORTED_LOCALIZED =
  'Программа на вашем хост-компьютере разорвала установленное подключение. (os error 10053)'

describe('isEngineGoneError', () => {
  it.each([
    ['the router reporting a crashed child', LLAMACPP_CRASH_MESSAGE],
    ['a refused connect', REFUSED_BEFORE_HEAD],
    ['a reset mid-stream', RESET_MID_STREAM],
    ['a localized Windows abort, by its code', ABORTED_LOCALIZED],
    ['a Linux reset', 'Connection reset by peer (os error 104)'],
    ['a macOS refusal', 'tcp connect error (os error 61)'],
    ['an EOF mid-chunk', '127.0.0.1:8080 failed: unexpected EOF during chunk size line'],
  ])('is true for %s', (_name, text) => {
    expect(isEngineGoneError(new Error(text))).toBe(true)
  })

  it('reads the crash out of an API error body', () => {
    const error = Object.assign(new Error('Internal Server Error'), {
      statusCode: 500,
      responseBody: JSON.stringify({ error: { message: LLAMACPP_CRASH_MESSAGE } }),
    })
    expect(isEngineGoneError(error)).toBe(true)
  })

  it.each([
    ['a user stop', new Error('request cancelled')],
    ['an AbortError', Object.assign(new Error('x'), { name: 'AbortError' })],
    ['a timeout: the engine may only be slow', new Error('localhost:3141 timed out: operation timed out')],
    ['a context overflow', new Error(`${OUT_OF_CONTEXT_SIZE} (os error 10054)`)],
    ['a 4xx', Object.assign(new Error(RESET_MID_STREAM), { statusCode: 400 })],
    ['an auth failure', new Error('401 Unauthorized (os error 10061)')],
    ['an unrelated failure', new Error('Model not found')],
    ['nothing', undefined],
  ])('is false for %s', (_name, error) => {
    expect(isEngineGoneError(error)).toBe(false)
  })

  it('only llama.cpp is recovered', () => {
    expect(isRecoverableLocalProvider('llamacpp')).toBe(true)
    expect(isRecoverableLocalProvider('openai')).toBe(false)
    expect(isRecoverableLocalProvider('anthropic')).toBe(false)
    expect(isRecoverableLocalProvider(undefined)).toBe(false)
  })
})

const user = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

const toolPart = (id: string, state: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'dynamic-tool',
    toolName: 'run_command',
    toolCallId: id,
    state,
    input: { command: 'echo hi' },
    ...extra,
  }) as unknown as UIMessage['parts'][number]

describe('planEngineRecovery', () => {
  it('regenerates a failed turn that ran no tools, keyed by its user message', () => {
    const messages: UIMessage[] = [
      user('u1', 'hello'),
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Half an ans' }],
        metadata: { error: RESET_MID_STREAM },
      },
    ]
    expect(planEngineRecovery(messages)).toEqual({
      kind: 'regenerate',
      turnKey: 'u1',
      failedMessageId: 'a1',
    })
  })

  it('regenerates when the turn failed before any reply', () => {
    expect(planEngineRecovery([user('u1', 'a'), user('u2', 'b')])).toEqual({
      kind: 'regenerate',
      turnKey: 'u2',
      failedMessageId: undefined,
    })
  })

  it('resumes after finished tool calls, reusing them by toolCallId', () => {
    const failed: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me check.' },
        toolPart('call-1', 'output-available', { output: 'hi' }),
        toolPart('call-2', 'output-error', { errorText: 'denied' }),
        { type: 'text', text: 'Now the half-written next st' },
        toolPart('call-3', 'input-available'),
      ],
      metadata: { error: LLAMACPP_CRASH_MESSAGE, model: 'm' },
    }
    const plan = planEngineRecovery([user('u1', 'go'), failed])
    expect(plan?.kind).toBe('resume')
    if (plan?.kind !== 'resume') return
    expect(plan.turnKey).toBe('u1')
    expect(plan.reusedToolCallIds).toEqual(['call-1', 'call-2'])
    const resumed = plan.messages.at(-1)!
    expect(resumed.id).toBe('a1')
    // The finished calls stay with their results; the failed step's partial
    // text and the call it never ran go, and so does the stored error.
    expect(resumed.parts).toEqual(failed.parts.slice(0, 3))
    expect(resumed.metadata).toEqual({ model: 'm' })
  })

  it('keeps each toolCallId once', () => {
    const failed: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        toolPart('call-1', 'output-available', { output: 'x' }),
        toolPart('call-1', 'output-available', { output: 'x' }),
      ],
    }
    const plan = planEngineRecovery([user('u1', 'go'), failed])
    expect(plan?.kind).toBe('resume')
    if (plan?.kind !== 'resume') return
    expect(plan.reusedToolCallIds).toEqual(['call-1'])
    expect(plan.messages.at(-1)!.parts).toHaveLength(1)
  })

  it('has nothing to retry without a user message', () => {
    expect(planEngineRecovery([])).toBeUndefined()
    expect(turnUserMessageId([])).toBeUndefined()
    expect(resolvedToolCallIds(undefined)).toEqual([])
  })
})

describe('claimAutoRetry', () => {
  beforeEach(() => resetAutoRetries())

  it('allows one automatic retry per turn', () => {
    expect(MAX_AUTO_RETRIES_PER_TURN).toBe(1)
    expect(claimAutoRetry('u1')).toBe(true)
    expect(claimAutoRetry('u1')).toBe(false)
    expect(claimAutoRetry('u2')).toBe(true)
  })
})
