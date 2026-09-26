/**
 * One poller for background jobs, however many Cowork panes are mounted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  bashJobsList: vi.fn(),
}))

import {
  JOB_POLL_MS,
  setJobsLister,
  watchJobs,
  watchedSessionCount,
} from '@/lib/coworkJobsPoller'

const flush = () => Promise.resolve().then(() => Promise.resolve())

describe('shared job poller', () => {
  const lister = vi.fn(async (sid: string) => [
    { jobId: `${sid}-job`, finished: false } as never,
  ])

  beforeEach(() => {
    vi.useFakeTimers()
    lister.mockClear()
    setJobsLister(lister)
  })
  afterEach(() => vi.useRealTimers())

  it('asks once per session per tick, however many panes watch it', async () => {
    const a1 = vi.fn()
    const a2 = vi.fn()
    const b = vi.fn()
    const offA1 = watchJobs('A', a1)
    const offA2 = watchJobs('A', a2)
    const offB = watchJobs('B', b)
    await flush()
    // The first watcher of each session asks straight away; the second shares.
    expect(lister.mock.calls.map((c) => c[0])).toEqual(['A', 'B'])
    expect(a1).toHaveBeenCalledTimes(1)
    expect(a2).toHaveBeenCalledTimes(1)

    lister.mockClear()
    vi.advanceTimersByTime(JOB_POLL_MS)
    await flush()
    expect(lister.mock.calls.map((c) => c[0]).sort()).toEqual(['A', 'B'])

    offA1()
    offA2()
    offB()
    expect(watchedSessionCount()).toBe(0)
    lister.mockClear()
    vi.advanceTimersByTime(JOB_POLL_MS * 3)
    expect(lister).not.toHaveBeenCalled()
  })

  it('hands a late watcher the latest list at once', async () => {
    const off1 = watchJobs('C', vi.fn())
    await flush()
    const late = vi.fn()
    const off2 = watchJobs('C', late)
    expect(late).toHaveBeenCalledWith([{ jobId: 'C-job', finished: false }])
    off1()
    off2()
  })
})
