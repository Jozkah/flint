import { beforeEach, describe, expect, it, vi } from 'vitest'

const shellLog = vi.fn()
vi.mock('./shell', () => ({ shellLog: (...a: unknown[]) => shellLog(...a) }))

import { markBooted, resetBootedForTests, showFatal } from './fatal'

describe('showFatal', () => {
  beforeEach(() => {
    shellLog.mockClear()
    resetBootedForTests()
    document.body.innerHTML = '<div id="root"><p id="app">app</p></div>'
  })

  it('replaces root before boot', () => {
    showFatal('boom')
    expect(document.querySelector('[data-testid="fatal"]')).not.toBeNull()
    expect(document.getElementById('app')).toBeNull()
  })

  it('only logs after markBooted', () => {
    markBooted()
    showFatal('late error')
    expect(document.getElementById('app')).not.toBeNull()
    expect(document.querySelector('[data-testid="fatal"]')).toBeNull()
    expect(shellLog).toHaveBeenCalledWith('error', 'late error')
  })

  it('does not duplicate the fatal box', () => {
    showFatal('one')
    showFatal('two')
    expect(document.querySelectorAll('[data-testid="fatal"]').length).toBe(1)
  })
})
