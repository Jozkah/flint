import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from 'ai'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/previewInvoke', () => ({ invoke: invokeMock }))

import {
  appendSessionContext,
  NO_CC_CONTEXT,
  runCcContextHooks,
  userMessageText,
  withPromptContext,
} from '../ccContextHooks'

const msg = (role: UIMessage['role'], text: string): UIMessage =>
  ({ id: `${role}-${text}`, role, parts: [{ type: 'text', text }] }) as UIMessage

describe('runCcContextHooks', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('asks the backend with the session, project and prompt', async () => {
    invokeMock.mockResolvedValue({
      enabled: true,
      sessionStart: ['style on'],
      promptSubmit: ['per prompt'],
    })
    const got = await runCcContextHooks({
      sessionId: 's1',
      projectDir: 'C:/p',
      prompt: 'hello',
    })
    expect(invokeMock).toHaveBeenCalledWith('run_cc_context_hooks', {
      sessionId: 's1',
      projectDir: 'C:/p',
      prompt: 'hello',
    })
    expect(got).toEqual({
      enabled: true,
      sessionStart: ['style on'],
      promptSubmit: ['per prompt'],
    })
  })

  it('adds nothing when the user has not opted in', async () => {
    invokeMock.mockResolvedValue({
      enabled: false,
      sessionStart: ['leak'],
      promptSubmit: ['leak'],
    })
    expect(await runCcContextHooks({ sessionId: 's' })).toEqual(NO_CC_CONTEXT)
  })

  it('never throws: a failing command is nothing to add', async () => {
    invokeMock.mockRejectedValue(new Error('no tauri'))
    expect(await runCcContextHooks({ sessionId: 's' })).toEqual(NO_CC_CONTEXT)
    invokeMock.mockResolvedValue(undefined)
    expect(await runCcContextHooks({ sessionId: 's' })).toEqual(NO_CC_CONTEXT)
  })

  it('drops non-string and blank blocks', async () => {
    invokeMock.mockResolvedValue({
      enabled: true,
      sessionStart: ['ok', '  ', 5, null],
      promptSubmit: 'nope',
    })
    expect(await runCcContextHooks({ sessionId: 's' })).toEqual({
      enabled: true,
      sessionStart: ['ok'],
      promptSubmit: [],
    })
  })

  it('does not hold the turn for a hook that never answers', async () => {
    invokeMock.mockReturnValue(new Promise(() => {}))
    const got = await runCcContextHooks({
      sessionId: 's',
      prompt: 'hi',
      timeoutMs: 20,
    })
    expect(got).toEqual(NO_CC_CONTEXT)
  })
})

describe('placement', () => {
  it('puts SessionStart text after the system prompt, blank-line separated', () => {
    expect(appendSessionContext('base', ['a', 'b'])).toBe('base\n\na\n\nb')
    expect(appendSessionContext(undefined, ['a'])).toBe('a')
    expect(appendSessionContext('base', [])).toBe('base')
    expect(appendSessionContext(undefined, [])).toBeUndefined()
  })

  it('wraps UserPromptSubmit text as a <SYSTEM> reminder on the trailing user message', () => {
    const original = [msg('assistant', 'hi'), msg('user', 'do it')]
    const out = withPromptContext(original, ['remember X'])
    expect(out).not.toBe(original)
    const last = out[out.length - 1]
    expect(last.parts).toHaveLength(2)
    expect(last.parts[1]).toEqual({
      type: 'text',
      text: '<SYSTEM>\nremember X\n</SYSTEM>',
    })
    // The stored conversation is untouched.
    expect(original[1].parts).toHaveLength(1)
  })

  it('never attaches to an assistant turn or tool follow-up', () => {
    const messages = [msg('user', 'q'), msg('assistant', 'a')]
    expect(withPromptContext(messages, ['x'])).toBe(messages)
    expect(withPromptContext([], ['x'])).toEqual([])
    expect(withPromptContext([msg('user', 'q')], [])).toHaveLength(1)
  })

  it('reads the prompt from a user message only', () => {
    expect(userMessageText(msg('user', ' hello '))).toBe('hello')
    expect(userMessageText(msg('assistant', 'hello'))).toBe('')
    expect(userMessageText(undefined)).toBe('')
  })
})
