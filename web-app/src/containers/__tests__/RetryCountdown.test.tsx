import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const pause = vi.fn().mockResolvedValue(undefined)

vi.mock('@/hooks/useHuggingFaceDownloads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useHuggingFaceDownloads')>()
  return { ...actual, pauseHuggingFaceBundle: (id: string) => pause(id) }
})
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.seconds !== undefined ? `${key}:${vars.seconds}` : key,
  }),
}))

import { RetryCountdown, retrySecondsLeft } from '@/containers/RetryCountdown'
import { PausedDownloads } from '@/containers/PausedDownloads'
import { useHuggingFaceDownloads } from '@/hooks/useHuggingFaceDownloads'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'))
  pause.mockClear()
  useHuggingFaceDownloads.setState({ tasks: {}, aliases: {} })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('retrySecondsLeft', () => {
  it('rounds up and never goes below zero', () => {
    expect(retrySecondsLeft(10_500, 10_000)).toBe(1)
    expect(retrySecondsLeft(74_000, 10_000)).toBe(64)
    expect(retrySecondsLeft(5_000, 10_000)).toBe(0)
  })
})

describe('RetryCountdown', () => {
  it('counts down each second, then says it is retrying', () => {
    render(<RetryCountdown retryAt={Date.now() + 3000} />)
    expect(screen.getByRole('status').textContent).toBe('sweep:hub.retryingIn:3')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole('status').textContent).toBe('sweep:hub.retryingIn:2')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByRole('status').textContent).toBe('sweep:hub.retryingNow')
  })
})

describe('PausedDownloads while retrying', () => {
  it('lists a waiting download with its countdown and a working pause', () => {
    useHuggingFaceDownloads.setState({
      tasks: {
        a: {
          id: 'a',
          repo: 'org/a',
          label: 'a',
          status: 'downloading',
          files: [],
          paths: [],
          currentFileIndex: 0,
          downloaded: 10,
          total: 100,
          progress: 0.1,
          retryAt: Date.now() + 64_000,
          retryAttempt: 6,
        },
      },
    })
    render(<PausedDownloads />)
    expect(screen.getByRole('status').textContent).toBe('sweep:hub.retryingIn:64')
    fireEvent.click(screen.getByText('common:a11y.pauseDownload'))
    expect(pause).toHaveBeenCalledWith('a')
  })
})
