import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import {
  acceptsSystemRole,
  customChatTemplate,
  foldSummaryIntoSystem,
  templateAcceptsSystem,
} from '../compactionSystemRole'
import { SUMMARY_HEADER, summaryMessage } from '../compaction'

const withTemplate = (value: string) => ({
  settings: { chat_template: { controller_props: { value } } },
})

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage

const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage

const summary = (text: string, latestRequest?: string) =>
  summaryMessage(
    {
      at: 1,
      reason: 'threshold',
      summary: text,
      summarizedCount: 4,
      tokensBefore: 1000,
      tokensAfter: 100,
    } as never,
    latestRequest
  )

describe('acceptsSystemRole', () => {
  it('accepts hosted APIs that take a system message for every model', () => {
    expect(acceptsSystemRole('openai', null)).toBe(true)
    expect(acceptsSystemRole('anthropic', undefined)).toBe(true)
  })

  it('refuses providers whose templates it cannot see', () => {
    expect(acceptsSystemRole('openrouter', null)).toBe(false)
    expect(acceptsSystemRole('my-custom-endpoint', null)).toBe(false)
    expect(acceptsSystemRole(null, null)).toBe(false)
  })

  it('refuses a local model whose template comes from the GGUF', () => {
    expect(acceptsSystemRole('llamacpp', { settings: {} })).toBe(false)
    expect(acceptsSystemRole('llamacpp', withTemplate(''))).toBe(false)
  })

  it('accepts a known built-in template name', () => {
    expect(acceptsSystemRole('llamacpp', withTemplate('chatml'))).toBe(true)
    expect(acceptsSystemRole('llamacpp', withTemplate('gemma'))).toBe(false)
  })

  it('inspects an inline template for a system role', () => {
    const ok =
      "{% for m in messages %}{% if m['role'] == 'system' %}<|system|>{{ m['content'] }}{% endif %}{% endfor %}"
    const raises =
      "{% if messages[0]['role'] == 'system' %}{{ raise_exception('System role not supported') }}{% endif %}"
    const noSystem = "{% for m in messages %}{{ m['content'] }}{% endfor %}"
    expect(acceptsSystemRole('llamacpp', withTemplate(ok))).toBe(true)
    expect(acceptsSystemRole('llamacpp', withTemplate(raises))).toBe(false)
    expect(acceptsSystemRole('llamacpp', withTemplate(noSystem))).toBe(false)
    // A path to a .jinja file cannot be read here.
    expect(acceptsSystemRole('llamacpp', withTemplate('/t/x.jinja'))).toBe(
      false
    )
  })

  it('reads the setting in either stored shape', () => {
    expect(customChatTemplate(withTemplate(' chatml '))).toBe('chatml')
    expect(customChatTemplate({ settings: { chat_template: 'llama3' } })).toBe(
      'llama3'
    )
    expect(templateAcceptsSystem('plain text')).toBe(false)
  })
})

describe('foldSummaryIntoSystem', () => {
  it('merges the summary into the system prompt and drops the user form', () => {
    const messages = [
      summary('read three files'),
      user('u1', 'now fix it'),
      assistant('a1', 'on it'),
    ]
    const out = foldSummaryIntoSystem('You are Flint.', messages)
    expect(out.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(out.system).toContain('You are Flint.')
    expect(out.system).toContain(SUMMARY_HEADER)
    expect(out.system).toContain('read three files')
    expect(out.system!.indexOf('You are Flint.')).toBe(0)
  })

  it('uses the summary as the whole system prompt when there was none', () => {
    const out = foldSummaryIntoSystem(undefined, [
      summary('s'),
      user('u1', 'go'),
    ])
    expect(out.system?.startsWith(SUMMARY_HEADER)).toBe(true)
  })

  it('keeps the user form when no genuine user turn would remain', () => {
    const messages = [
      summary('folded', 'the request'),
      assistant('a1', 'working'),
    ]
    const out = foldSummaryIntoSystem('sys', messages)
    expect(out.messages).toBe(messages)
    expect(out.system).toBe('sys')
  })

  it('changes nothing without a summary', () => {
    const messages = [user('u1', 'hi')]
    const out = foldSummaryIntoSystem('sys', messages)
    expect(out).toEqual({ system: 'sys', messages })
  })
})
