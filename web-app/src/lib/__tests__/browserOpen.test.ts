import { beforeEach, describe, expect, it, vi } from 'vitest'

const openUrl = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ opener: () => ({ openUrl }) }),
}))

import { parseBrowserTarget, runOpenInBrowser } from '../browserOpen'

beforeEach(() => {
  openUrl.mockReset()
})

describe('parseBrowserTarget', () => {
  it('takes http and https only, and no credentials', () => {
    expect(parseBrowserTarget({ url: 'file:///C:/x.html' })).toBeNull()
    expect(parseBrowserTarget({ url: 'javascript:alert(1)' })).toBeNull()
    expect(parseBrowserTarget({ url: 'https://u:p@example.com' })).toBeNull()
    expect(parseBrowserTarget({ url: 'nope' })).toBeNull()
    expect(parseBrowserTarget({})).toBeNull()
  })

  it('splits the origin from the path and knows this computer', () => {
    const t = parseBrowserTarget({ url: 'http://localhost:5199/docs?a=1', title: ' Flint ' })
    expect(t).toMatchObject({ origin: 'localhost:5199', path: '/docs?a=1', title: 'Flint', local: true })
    expect(parseBrowserTarget({ url: 'http://127.0.0.1:3000' })?.path).toBe('')
    expect(parseBrowserTarget({ url: 'https://example.com' })?.local).toBe(false)
    expect(parseBrowserTarget({ url: 'http://localhost.evil.com' })?.local).toBe(false)
  })
})

describe('runOpenInBrowser', () => {
  it('opens a page on this computer at once', async () => {
    const out = await runOpenInBrowser({ url: 'http://localhost:5199' })
    expect(openUrl).toHaveBeenCalledWith('http://localhost:5199/')
    expect(out).toEqual({ content: expect.stringContaining('"opened"') })
  })

  it('leaves any other site to the user', async () => {
    const out = await runOpenInBrowser({ url: 'https://example.com' })
    expect(openUrl).not.toHaveBeenCalled()
    expect(out).toEqual({ content: expect.stringContaining('"shown"') })
  })

  it('refuses an address it cannot open', async () => {
    expect(await runOpenInBrowser({ url: 'file:///x' })).toHaveProperty('error')
  })
})
