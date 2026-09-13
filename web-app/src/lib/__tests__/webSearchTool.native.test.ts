import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('@janhq/tauri-plugin-websearch-api', () => ({
  webSearch: vi.fn(),
  webFetch: vi.fn(),
}))

import { isNativeWebTool } from '@/lib/webSearchTool'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'

describe('isNativeWebTool', () => {
  afterEach(() => useWebSearchConfig.setState({ webSearchEnabled: true }))

  it('claims the web tool names while built-in web search is on', () => {
    useWebSearchConfig.setState({ webSearchEnabled: true })
    expect(isNativeWebTool('web_search')).toBe(true)
    expect(isNativeWebTool('web_fetch')).toBe(true)
  })

  // janhq/jan#8777: with built-in search off, a call by that name came from an
  // MCP server; claiming it skipped that server's approval prompt.
  it('leaves the names to an MCP server while built-in web search is off', () => {
    useWebSearchConfig.setState({ webSearchEnabled: false })
    expect(isNativeWebTool('web_search')).toBe(false)
    expect(isNativeWebTool('web_fetch')).toBe(false)
  })

  it('never claims any other tool', () => {
    useWebSearchConfig.setState({ webSearchEnabled: true })
    expect(isNativeWebTool('fetch')).toBe(false)
    expect(isNativeWebTool('read')).toBe(false)
  })
})
