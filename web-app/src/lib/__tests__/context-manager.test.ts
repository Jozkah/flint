import { describe, it, expect } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import {
  estimateTokens,
  estimateMessageTokens,
  trimMessages,
  compactMessages,
  deriveToolOutputCap,
  contextSafetyMargin,
  inputBudgetTokens,
  clearStaleToolResults,
  extractSummary,
  type ContextManagerConfig,
} from '../context-manager'

function makeMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string
): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text' as const, text }],
  }
}

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('should estimate tokens based on character count', () => {
    // 35 chars / 3.5 chars per token = 10 tokens
    const text = 'Hello, this is a test of the token.'
    const result = estimateTokens(text)
    expect(result).toBe(Math.ceil(text.length / 3.5))
  })

  it('should handle short text', () => {
    expect(estimateTokens('Hi')).toBeGreaterThan(0)
  })
})

describe('estimateMessageTokens', () => {
  it('should estimate tokens for a simple text message', () => {
    const msg = makeMessage('1', 'user', 'Hello world')
    const tokens = estimateMessageTokens(msg)
    // text tokens + 4 overhead
    expect(tokens).toBe(estimateTokens('Hello world') + 4)
  })

  it('should include inline file contents in token count', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Check this file' }],
      metadata: {
        inline_file_contents: [
          { name: 'readme.md', content: 'This is a long file content string' },
        ],
      },
    } as unknown as UIMessage
    const tokens = estimateMessageTokens(msg)
    expect(tokens).toBeGreaterThan(estimateTokens('Check this file') + 4)
  })

  it('should handle messages with no text parts', () => {
    const msg: UIMessage = {
      id: '1',
      role: 'assistant',
      parts: [],
    }
    const tokens = estimateMessageTokens(msg)
    expect(tokens).toBe(4) // just overhead
  })
})

describe('input budget safety margin', () => {
  it('reserves a window-proportional margin, with a floor', () => {
    // 2% of the window, above the 1024-token floor.
    expect(contextSafetyMargin(200_000)).toBe(4_000)
    // Below the floor for a small window.
    expect(contextSafetyMargin(8_192)).toBe(1_024)
  })

  it('subtracts output, system prompt and the margin from the window', () => {
    // The 200000/22000/178001 overflow: the budget now leaves headroom under
    // the window instead of packing input to the exact limit.
    const budget = inputBudgetTokens(200_000, 22_000, 1_000)
    expect(budget).toBe(200_000 - 22_000 - 1_000 - 4_000)
    expect(budget).toBeLessThan(200_000 - 22_000)
  })
})

describe('trimMessages', () => {
  const defaultConfig: ContextManagerConfig = {
    maxContextTokens: 200,
    maxOutputTokens: 50,
    autoCompact: false,
  }

  it('should return all messages when they fit within budget', () => {
    const messages = [
      makeMessage('1', 'user', 'Hi'),
      makeMessage('2', 'assistant', 'Hello'),
    ]
    const result = trimMessages(messages, defaultConfig)
    expect(result.trimmedCount).toBe(0)
    expect(result.messages).toHaveLength(2)
  })

  it('should not trim when maxContextTokens is 0 (disabled)', () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      makeMessage(
        String(i),
        i % 2 === 0 ? 'user' : 'assistant',
        'A'.repeat(500)
      )
    )
    const result = trimMessages(messages, {
      maxContextTokens: 0,
      maxOutputTokens: 50,
      autoCompact: false,
    })
    expect(result.trimmedCount).toBe(0)
    expect(result.messages).toHaveLength(100)
  })

  it('should trim oldest messages when conversation exceeds budget', () => {
    // Each message: ~143 tokens text + 4 overhead = ~147 tokens
    // Budget: 200 - 50 = 150 input tokens → only 1 message fits
    const messages = [
      makeMessage('1', 'user', 'A'.repeat(500)),
      makeMessage('2', 'assistant', 'B'.repeat(500)),
      makeMessage('3', 'user', 'C'.repeat(500)),
    ]
    const result = trimMessages(messages, defaultConfig)
    expect(result.trimmedCount).toBeGreaterThan(0)
    // Most recent message should always be kept
    expect(result.messages[result.messages.length - 1].id).toBe('3')
  })

  it('should keep at least the last message even if it exceeds budget', () => {
    const messages = [
      makeMessage('1', 'user', 'A'.repeat(5000)),
    ]
    const result = trimMessages(messages, {
      maxContextTokens: 100,
      maxOutputTokens: 50,
      autoCompact: false,
    })
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe('1')
  })

  it('should account for system prompt tokens', () => {
    const messages = [
      makeMessage('1', 'user', 'Hello'),
      makeMessage('2', 'assistant', 'Hi there'),
    ]
    // With large system prompt, even small messages may not fit
    const result = trimMessages(messages, {
      maxContextTokens: 200,
      maxOutputTokens: 50,
      autoCompact: false,
    }, 180) // leaves only 200-50-180 = negative → the last message, plus
    // the user message it answers: a request with no user turn is refused.
    expect(result.messages.map((m) => m.id)).toEqual(['1', '2'])
  })

  it('should preserve message order', () => {
    const messages = [
      makeMessage('1', 'user', 'First'),
      makeMessage('2', 'assistant', 'Second'),
      makeMessage('3', 'user', 'Third'),
      makeMessage('4', 'assistant', 'Fourth'),
    ]
    const result = trimMessages(messages, {
      maxContextTokens: 500,
      maxOutputTokens: 50,
      autoCompact: false,
    })
    const ids = result.messages.map((m) => m.id)
    for (let i = 1; i < ids.length; i++) {
      expect(Number(ids[i])).toBeGreaterThan(Number(ids[i - 1]))
    }
  })
})

describe('compactMessages', () => {
  const config: ContextManagerConfig = {
    maxContextTokens: 200,
    maxOutputTokens: 50,
    autoCompact: true,
  }

  const mockModel = {
    modelId: 'test-model',
    provider: 'test',
    specificationVersion: 'v1',
  }

  it('should pass through when no trimming needed', async () => {
    const messages = [
      makeMessage('1', 'user', 'Hi'),
      makeMessage('2', 'assistant', 'Hello'),
    ]
    const result = await compactMessages(
      messages,
      config,
      mockModel as any
    )
    expect(result.trimmedCount).toBe(0)
    expect(result.messages).toHaveLength(2)
  })

  it('should pass through when maxContextTokens is 0', async () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      makeMessage(String(i), i % 2 === 0 ? 'user' : 'assistant', 'A'.repeat(500))
    )
    const result = await compactMessages(
      messages,
      { maxContextTokens: 0, maxOutputTokens: 50, autoCompact: true },
      mockModel as any
    )
    expect(result.trimmedCount).toBe(0)
    expect(result.messages).toHaveLength(50)
  })

  it('should fall back to trim when summarization fails', async () => {
    // Use messages that exceed context
    const messages = [
      makeMessage('1', 'user', 'A'.repeat(500)),
      makeMessage('2', 'assistant', 'B'.repeat(500)),
      makeMessage('3', 'user', 'C'.repeat(100)),
    ]

    // The mock model doesn't implement the real interface, so generateText
    // will throw. compactMessages should catch and fall back to trimMessages.
    const result = await compactMessages(
      messages,
      config,
      mockModel as any
    )

    expect(result.trimmedCount).toBeGreaterThan(0)
    // Should still return valid messages (fallback to trim)
    expect(result.messages.length).toBeGreaterThan(0)
    // No summary generated on fallback
    expect(result.compactedSummary).toBeUndefined()
  })
})

describe('deriveToolOutputCap', () => {
  it('scales the budget with the model context window', () => {
    const small = deriveToolOutputCap(8_192)
    const large = deriveToolOutputCap(1_000_000)

    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThan(small!)
  })

  it('leaves most of the window for the conversation itself', () => {
    // A single tool result must not be allowed to fill the context it lives in.
    const ctxTokens = 100_000
    const cap = deriveToolOutputCap(ctxTokens)!

    expect(estimateTokens('x'.repeat(cap))).toBeLessThan(ctxTokens / 2)
  })

  it('returns undefined when the context window is unknown', () => {
    // Remote providers often report no window; the user's setting then governs
    // alone rather than a fabricated budget taking over.
    expect(deriveToolOutputCap(undefined)).toBeUndefined()
    expect(deriveToolOutputCap(0)).toBeUndefined()
    expect(deriveToolOutputCap(-1)).toBeUndefined()
  })

  it('returns a whole number of characters', () => {
    expect(Number.isInteger(deriveToolOutputCap(8_191))).toBe(true)
  })
})

describe('trimMessages keeps the request', () => {
  it('keeps the latest user message when newer turns fill the budget', () => {
    const messages = [
      makeMessage('u', 'user', 'fix the parser'),
      ...Array.from({ length: 6 }, (_, i) =>
        makeMessage(`a${i}`, 'assistant', 'A'.repeat(500))
      ),
    ]
    const result = trimMessages(messages, {
      maxContextTokens: 400,
      maxOutputTokens: 50,
      autoCompact: false,
    })
    expect(result.messages[0].id).toBe('u')
    expect(result.messages.some((m) => m.role === 'user')).toBe(true)
  })
})

function toolMessage(id: string, tool: string, output: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: `tool-${tool}`,
        toolCallId: `call-${id}`,
        state: 'output-available',
        input: { q: 1 },
        output,
      },
    ],
  } as unknown as UIMessage
}

describe('clearStaleToolResults', () => {
  const big = 'x'.repeat(2000)
  const outputOf = (m: UIMessage) => (m.parts[0] as { output?: unknown }).output

  function history(): UIMessage[] {
    return [
      makeMessage('u1', 'user', 'one'),
      toolMessage('t1', 'read', big),
      toolMessage('t2', 'grep', big),
      makeMessage('u2', 'user', 'two'),
      toolMessage('t3', 'read', big),
      makeMessage('u3', 'user', 'three'),
      toolMessage('t4', 'bash', big),
    ]
  }

  it('clears old results with a sized placeholder and keeps the call', () => {
    const result = clearStaleToolResults(history(), {
      keepRecentResults: 1,
      protectedTurns: 2,
    })
    expect(result.clearedCount).toBe(2)
    expect(outputOf(result.messages[4])).toBe(big)
    expect(outputOf(result.messages[1])).toBe('[tool result cleared: read 2.0k chars]')
    expect(outputOf(result.messages[2])).toBe('[tool result cleared: grep 2.0k chars]')
    expect((result.messages[1].parts[0] as { input: unknown }).input).toEqual({ q: 1 })
  })

  it('never clears the latest turn or the newest K results', () => {
    const result = clearStaleToolResults(history(), {
      keepRecentResults: 0,
      protectedTurns: 1,
    })
    expect(outputOf(result.messages[6])).toBe(big)
    const keepTwo = clearStaleToolResults(history(), {
      keepRecentResults: 3,
      protectedTurns: 1,
    })
    expect(outputOf(keepTwo.messages[2])).toBe(big)
    expect(outputOf(keepTwo.messages[1])).toContain('[tool result cleared')
  })

  it('leaves small results alone, is idempotent and does not mutate', () => {
    const input = history()
    input.splice(1, 0, toolMessage('tiny', 'ls', 'ok'))
    const snapshot = JSON.stringify(input)
    const once = clearStaleToolResults(input, { keepRecentResults: 0 })
    expect(outputOf(once.messages[1])).toBe('ok')
    expect(JSON.stringify(input)).toBe(snapshot)
    const twice = clearStaleToolResults(once.messages, { keepRecentResults: 0 })
    expect(twice.clearedCount).toBe(0)
  })
})

describe('extractSummary', () => {
  it('keeps only the summary block', () => {
    expect(
      extractSummary('<analysis>thinking</analysis>\n<summary>\n- a\n- b\n</summary>')
    ).toBe('- a\n- b')
  })

  it('uses the raw text when the tags are missing', () => {
    expect(extractSummary('  plain summary ')).toBe('plain summary')
  })

  it('takes an unterminated summary and drops an unterminated analysis', () => {
    expect(extractSummary('<analysis>x</analysis><summary>cut off')).toBe('cut off')
    expect(extractSummary('<analysis>ran out of tokens')).toBe('')
  })

  it('strips a closed analysis when no summary tag follows', () => {
    expect(extractSummary('<analysis>x</analysis>the summary')).toBe('the summary')
  })
})
