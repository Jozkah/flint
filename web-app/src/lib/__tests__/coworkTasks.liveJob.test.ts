import { describe, expect, it } from 'vitest'
import { liveJobPatch, type LiveJob } from '@/lib/coworkTasks'

const job = (over: Partial<LiveJob>): LiveJob => ({
  jobId: 'bash-1',
  command: 'sleep 1',
  elapsedMs: 0,
  finished: false,
  ...over,
})

describe('a background job row, from the live job', () => {
  // The row was opened when the call arrived; an approval wait is not run time.
  it('takes its start from the backend, not from the approval request', () => {
    expect(liveJobPatch({ status: 'running', startedAt: 1000 }, job({ startedAtMs: 61_000 }), 70_000)).toEqual({
      startedAt: 61_000,
    })
  })

  it('settles a finished job with its real start and end', () => {
    expect(
      liveJobPatch(
        { status: 'running', startedAt: 1000 },
        job({ startedAtMs: 61_000, finished: true, finishedAtMs: 65_000, exitCode: 0 }),
        70_000
      )
    ).toMatchObject({ status: 'done', startedAt: 61_000, endedAt: 65_000 })
  })

  it('leaves a settled row and an unchanged start alone', () => {
    expect(liveJobPatch({ status: 'done', startedAt: 1 }, job({ finished: true }), 2)).toBeNull()
    expect(liveJobPatch({ status: 'running', startedAt: 5 }, job({ startedAtMs: 5 }), 9)).toBeNull()
  })
})
