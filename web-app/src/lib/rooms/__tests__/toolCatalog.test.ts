import { describe, it, expect } from 'vitest'
import { TOOL_WINDOW_WARN_SHARE, accessToolNames, summarizeToolTokens } from '../toolCatalog'

const entries = [
  { name: 'read', group: 'files' as const, tokens: 200 },
  { name: 'write', group: 'files' as const, tokens: 300 },
  { name: 'web_search', group: 'web' as const, tokens: 500 },
]

describe('summarizeToolTokens', () => {
  it('counts only enabled tools and warns past the share of the window', () => {
    const all = summarizeToolTokens(entries, undefined, 6_000)
    expect(all.enabledTokens).toBe(1000)
    expect(all.enabledCount).toBe(3)
    expect(all.share).toBeCloseTo(1000 / 6000)
    expect(all.warn).toBe(true)
    const fewer = summarizeToolTokens(entries, ['web_search'], 6_000)
    expect(fewer.enabledTokens).toBe(500)
    expect(fewer.warn).toBe(false)
    expect(TOOL_WINDOW_WARN_SHARE).toBe(0.15)
  })

  it('does not warn when the window is unknown', () => {
    expect(summarizeToolTokens(entries, undefined, 0).warn).toBe(false)
  })
})

describe('accessToolNames', () => {
  it('read gets only read tools, edit adds write/edit, full keeps all but withheld', () => {
    const names = ['read', 'ls', 'find', 'grep', 'write', 'edit', 'bash', 'memory_write', 'send_message']
    expect(accessToolNames(names, 'read')).toEqual(['read', 'ls', 'find', 'grep'])
    expect(accessToolNames(names, 'edit')).toEqual(['read', 'ls', 'find', 'grep', 'write', 'edit'])
    expect(accessToolNames(names, 'full')).toEqual(['read', 'ls', 'find', 'grep', 'write', 'edit', 'bash'])
    expect(accessToolNames(names, 'none')).toEqual([])
  })
})
