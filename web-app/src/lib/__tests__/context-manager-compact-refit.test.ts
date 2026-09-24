import { describe, it, expect, vi } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

vi.mock('../utilityAgents', () => ({
  runUtilityAgent: vi.fn(async () => 'S'.repeat(400)),
}))

import { compactMessages } from '../context-manager'

const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text' as const, text }],
})

// #81: the summary is prepended as the oldest message and the merged list is
// re-trimmed, which drops it first. It must not then be reported as preserved.
describe('compactMessages re-trim', () => {
  const config = { maxContextTokens: 200, maxOutputTokens: 50, autoCompact: true }

  it('reports no summary when the re-trim dropped it', async () => {
    const messages = [
      msg('1', 'user', 'A'.repeat(500)),
      msg('2', 'assistant', 'B'.repeat(500)),
      // Alone over budget: kept (the newest always is), leaving no room.
      msg('3', 'user', 'C'.repeat(2000)),
    ]
    const result = await compactMessages(messages, config, {} as never)

    expect(result.messages.map((m) => m.id)).toEqual(['3'])
    expect(result.compactedSummary).toBeUndefined()
    expect(result.trimmedCount).toBe(2)
  })

  it('reports the summary when it fits', async () => {
    const messages = [
      // Budget 250: the first message (~290 tokens) is summarized away, and
      // the summary (~128) fits beside the other two (~67).
      msg('1', 'user', 'A'.repeat(1000)),
      msg('2', 'assistant', 'B'.repeat(200)),
      msg('3', 'user', 'hi'),
    ]
    const result = await compactMessages(
      messages,
      { ...config, maxContextTokens: 400 },
      {} as never
    )
    const summaryKept = result.messages.some((m) => m.id.startsWith('compact-summary-'))
    expect(summaryKept).toBe(true)
    expect(result.compactedSummary).toBe('S'.repeat(400))
  })
})
