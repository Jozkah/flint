import { describe, expect, it } from 'vitest'
import { detectIos } from '../platform'
import { backFallback, isTabRoot, tabForRoute, tabRoute } from '../shell/iosTabs'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'

describe('detectIos', () => {
  it('matches iPhone and iPad user agents', () => {
    expect(detectIos({ userAgent: IPHONE })).toBe(true)
    expect(detectIos({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe(true)
  })
  it('matches iPadOS posing as a Mac only with touch', () => {
    expect(detectIos({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(detectIos({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
  })
  it('honours ?ios=1', () => {
    expect(detectIos({ userAgent: 'Mozilla/5.0 (X11; Linux)', search: '?a=b&ios=1' })).toBe(true)
    expect(detectIos({ userAgent: 'Mozilla/5.0 (X11; Linux)', search: '?ios=0' })).toBe(false)
  })
  it('leaves Android and desktop alone', () => {
    expect(detectIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', maxTouchPoints: 5 })).toBe(false)
    expect(detectIos({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false)
  })
})

describe('tab selection', () => {
  it('maps routes to tabs', () => {
    expect(tabForRoute({ name: 'home' })).toBe('chat')
    expect(tabForRoute({ name: 'home' }, 'cowork')).toBe('cowork')
    expect(tabForRoute({ name: 'home', mode: 'room' })).toBe('rooms')
    expect(tabForRoute({ name: 'chat', id: 'a' })).toBe('chat')
    expect(tabForRoute({ name: 'cowork', id: 'a' })).toBe('cowork')
    expect(tabForRoute({ name: 'room', id: 'a' })).toBe('rooms')
    expect(tabForRoute({ name: 'studio' })).toBe('studio')
    expect(tabForRoute({ name: 'models' })).toBe('more')
    expect(tabForRoute({ name: 'settings-sub', sub: 'general' })).toBe('more')
  })
  it('tab routes land on their own tab', () => {
    for (const tab of ['chat', 'cowork', 'rooms', 'studio', 'more'] as const) {
      expect(tabForRoute(tabRoute(tab))).toBe(tab)
    }
  })
  it('only tab roots show the bar', () => {
    expect(isTabRoot({ name: 'home' })).toBe(true)
    expect(isTabRoot({ name: 'settings' })).toBe(true)
    expect(isTabRoot({ name: 'chat', id: 'a' })).toBe(false)
    expect(isTabRoot({ name: 'models' })).toBe(false)
  })
  it('back falls to the owning root', () => {
    expect(backFallback({ name: 'room', id: 'a' })).toEqual({ name: 'rooms' })
    expect(backFallback({ name: 'chat', id: 'a' })).toEqual({ name: 'home', mode: 'chat' })
    expect(backFallback({ name: 'models' })).toEqual({ name: 'settings' })
  })
})
