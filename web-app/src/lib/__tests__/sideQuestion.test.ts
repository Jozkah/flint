import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/utilityAgents', () => ({ runUtilityAgent: vi.fn() }))
import { sideQuestionPrompt } from '../sideQuestion'
import type { UIMessage } from 'ai'

describe('sideQuestionPrompt', () => {
  it('carries the thread as text and ends with the question', () => {
    const messages = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'fix the parser' }] },
    ] as UIMessage[]
    const p = sideQuestionPrompt(messages, '  what changed? ')
    expect(p).toContain('fix the parser')
    expect(p.endsWith('Side question: what changed?')).toBe(true)
  })
})
