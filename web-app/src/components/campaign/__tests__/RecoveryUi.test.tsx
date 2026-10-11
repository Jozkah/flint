import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { GateBanner, lastLines } from '../GateBanner'
import { RecheckNotice, StrandedNotice } from '../TaskNotices'
import {
  allTasksSettled,
  dependantsOf,
  dotOf,
  gateFailedOf,
  headlineOf,
  primaryActionOf,
  skippedDepsOf,
  taskCounts,
  wordOf,
} from '@/lib/campaignView'
import type { Campaign, CampaignTask } from '@/lib/campaignModel'

const task = (
  id: string,
  status: CampaignTask['status'],
  dependsOn: string[] = []
): CampaignTask =>
  ({
    id,
    title: `Task ${id}`,
    brief: '',
    acceptance: [],
    paths: [],
    dependsOn,
    status,
    attempt: 0,
    tokensUsed: 0,
    detail: '',
  }) as CampaignTask

afterEach(() => vi.useRealTimers())

describe('skipped tasks and their dependants', () => {
  const all = [
    task('a', 'cancelled'),
    task('b', 'pending', ['a']),
    task('c', 'pending', ['b']),
    task('d', 'merged'),
  ]

  it('a task waiting on a skipped one needs a person, and says why', () => {
    expect(skippedDepsOf(all[1], all).map((t) => t.id)).toEqual(['a'])
    expect(dotOf(all[1], all)).toBe('needs-you')
    expect(wordOf(all[1], all)).toEqual({
      word: 'waitingSkipped',
      waitingFor: ['Task a'],
    })
    // c waits on b, which is only waiting: ordinary waiting.
    expect(dotOf(all[2], all)).toBe('blocked')
  })

  it('counts what skipping a task would hold up, through other tasks', () => {
    expect(dependantsOf('a', all).map((t) => t.id)).toEqual(['b', 'c'])
    expect(dependantsOf('d', all)).toEqual([])
  })

  it('counts merged and skipped apart', () => {
    expect(taskCounts(all)).toEqual({ merged: 1, skipped: 1, total: 4 })
  })

  it('only merged and skipped left, one merged: finished work for review', () => {
    const c = {
      status: 'running',
      tasks: [task('a', 'merged'), task('b', 'cancelled'), task('c', 'cancelled')],
    } as unknown as Campaign
    expect(allTasksSettled(c)).toBe(true)
    expect(headlineOf(c)).toMatchObject({ key: 'review', done: 1, skipped: 2 })
    expect(primaryActionOf(c)).toBe('review')
    const none = {
      status: 'running',
      tasks: [task('a', 'cancelled'), task('b', 'cancelled')],
    } as unknown as Campaign
    expect(allTasksSettled(none)).toBe(false)
  })
})

describe('a failed final check', () => {
  it('is not "ready for review"', () => {
    const c = {
      status: 'reviewing',
      tasks: [task('a', 'merged')],
      gate: { passed: false, skipped: false, command: 'npm test', exitCode: 1 },
    } as unknown as Campaign
    expect(gateFailedOf(c)).toBe(true)
    expect(headlineOf(c).key).toBe('gateFailed')
    expect(gateFailedOf({ gate: { passed: true } })).toBe(false)
    expect(gateFailedOf({ gate: { passed: false, skipped: true } })).toBe(false)
    expect(gateFailedOf({ gateFailed: true })).toBe(true)
  })

  it('shows command, exit code and the end of the output, with three actions', () => {
    const onFix = vi.fn()
    const onRetry = vi.fn()
    const onReview = vi.fn()
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    render(
      <GateBanner
        gate={{ command: 'npm test', exitCode: 2, output }}
        onFix={onFix}
        onRetry={onRetry}
        onReview={onReview}
      />
    )
    expect(screen.getByText('Checks failed')).toBeInTheDocument()
    expect(screen.getByTestId('campaign-gate-command')).toHaveTextContent('npm test')
    expect(screen.getByTestId('campaign-gate-exit')).toHaveTextContent('Exit code 2')
    const out = screen.getByTestId('campaign-gate-output')
    expect(out).toHaveTextContent('line 39')
    expect(out).not.toHaveTextContent('line 5\n')
    fireEvent.click(screen.getByRole('button', { name: 'Fix it automatically' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run checks again' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review anyway' }))
    expect(onFix).toHaveBeenCalled()
    expect(onRetry).toHaveBeenCalled()
    expect(onReview).toHaveBeenCalled()
  })

  it('keeps the last lines only', () => {
    expect(lastLines('a\nb\nc\n\n', 2)).toBe('b\nc')
  })
})

describe('stranded and rechecking tasks', () => {
  it('a stranded task explains itself and offers both ways out', () => {
    const skipToo = vi.fn()
    const runWithout = vi.fn()
    render(
      <StrandedNotice
        taskId="b"
        skipped={['Build the API']}
        onSkipToo={skipToo}
        onRunWithout={runWithout}
      />
    )
    expect(screen.getByTestId('campaign-stranded-b')).toHaveTextContent(
      'Build the API, which was skipped'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Skip this too' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run without it' }))
    expect(skipToo).toHaveBeenCalled()
    expect(runWithout).toHaveBeenCalled()
  })

  it('says checking again, then offers Check again after the stall time', () => {
    vi.useFakeTimers()
    const again = vi.fn()
    render(<RecheckNotice taskId="t" stateKey="completed" onCheckAgain={again} />)
    expect(screen.getByTestId('campaign-recheck-t')).toHaveTextContent(
      'Checking again'
    )
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(again).toHaveBeenCalled()
  })
})
