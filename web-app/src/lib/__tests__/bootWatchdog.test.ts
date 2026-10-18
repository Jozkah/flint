import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOT_STALL_MESSAGE,
  BOOT_STALL_MESSAGE_APP,
  BOOT_STALL_MS,
  noteBootError,
  resetBootErrors,
  startBootWatchdog,
} from '../bootWatchdog'

const caption = () => document.getElementById('initial-loader-caption')!

describe('startBootWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.className = ''
    document.body.innerHTML =
      '<div id="initial-loader"><p id="initial-loader-caption">Starting your workspace…</p></div>'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetBootErrors()
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('replaces the caption with an actionable message when boot stalls', () => {
    startBootWatchdog()
    vi.advanceTimersByTime(BOOT_STALL_MS - 1)
    expect(caption().textContent).toBe('Starting your workspace…')
    vi.advanceTimersByTime(1)
    expect(caption().textContent).toBe(BOOT_STALL_MESSAGE)
  })

  it('leaves a boot that finished (splash removed) alone', () => {
    startBootWatchdog()
    document.getElementById('initial-loader')!.remove()
    vi.advanceTimersByTime(BOOT_STALL_MS)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('leaves a boot that is fading out alone', () => {
    startBootWatchdog()
    document.body.classList.add('loaded')
    vi.advanceTimersByTime(BOOT_STALL_MS)
    expect(caption().textContent).toBe('Starting your workspace…')
  })

  it('can be cancelled', () => {
    const stop = startBootWatchdog()
    stop()
    vi.advanceTimersByTime(BOOT_STALL_MS)
    expect(caption().textContent).toBe('Starting your workspace…')
  })

  it('names the first error and offers Reload; the app wording has no F12', () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    startBootWatchdog()
    noteBootError(new Error('Failed to fetch module X\nat stack'))
    noteBootError(new Error('a later error'))
    vi.advanceTimersByTime(BOOT_STALL_MS)
    expect(caption().textContent).toBe(
      `${BOOT_STALL_MESSAGE_APP} (Failed to fetch module X)`
    )
    expect(caption().textContent).not.toMatch(/F12|browser console/)
    expect(
      document.getElementById('initial-loader')!.hasAttribute('data-stalled')
    ).toBe(true)
    expect(document.getElementById('initial-loader-reload')).not.toBeNull()
  })
})
