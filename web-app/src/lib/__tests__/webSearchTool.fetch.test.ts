import { describe, it, expect, beforeEach, vi } from 'vitest'

const webFetch = vi.fn()
vi.mock('@janhq/tauri-plugin-websearch-api', () => ({
  webSearch: vi.fn(),
  webFetch: (...args: unknown[]) => webFetch(...args),
}))

import {
  WEB_FETCH_MAX_CHARS,
  executeWebTool,
  pageWindow,
  resetWebFetchFailures,
} from '@/lib/webSearchTool'

describe('web_fetch output', () => {
  beforeEach(() => {
    webFetch.mockReset()
    resetWebFetchFailures()
  })

  it('caps page text and says how to read on', async () => {
    const content = 'a'.repeat(WEB_FETCH_MAX_CHARS + 500)
    webFetch.mockResolvedValue({ title: 'T', url: 'https://x', content, truncated: false })
    const res = await executeWebTool('web_fetch', { url: 'https://x' })
    const text = String(res.content)
    expect(text.length).toBeLessThan(WEB_FETCH_MAX_CHARS + 200)
    expect(text).toContain(`truncated, 500 chars more`)
    expect(text).toContain(`offset ${WEB_FETCH_MAX_CHARS}`)
  })

  it('reads a later window from an offset', () => {
    expect(pageWindow('abcdef', 4)).toBe('ef')
    expect(pageWindow('abc', 0)).toBe('abc')
  })

  it('does not fetch a URL that just failed again', async () => {
    webFetch.mockRejectedValue(new Error('CRAWL_NOT_FOUND'))
    const first = await executeWebTool('web_fetch', { url: 'https://archive.org/x' })
    const second = await executeWebTool('web_fetch', { url: 'https://archive.org/x' })
    expect(first.error).toBe('CRAWL_NOT_FOUND')
    expect(second.error).toContain('already failed')
    expect(webFetch).toHaveBeenCalledTimes(1)
    await executeWebTool('web_fetch', { url: 'https://archive.org/y' })
    expect(webFetch).toHaveBeenCalledTimes(2)
  })
})
