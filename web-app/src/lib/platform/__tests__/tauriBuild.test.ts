import { describe, it, expect, afterEach, vi } from 'vitest'
import { isTauriBuild } from '../tauriBuild'

describe('isTauriBuild', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('follows the build flag, read at call time', () => {
    vi.stubGlobal('IS_TAURI', true)
    expect(isTauriBuild()).toBe(true)
    vi.stubGlobal('IS_TAURI', false)
    expect(isTauriBuild()).toBe(false)
  })
})
