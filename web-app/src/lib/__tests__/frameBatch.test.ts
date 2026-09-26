import { describe, it, expect, vi } from 'vitest'
import { createFrameBatch } from '../frameBatch'

function fakeFrames() {
  const queued = new Map<number, () => void>()
  let next = 1
  return {
    api: {
      request: (cb: () => void) => {
        queued.set(next, cb)
        return next++
      },
      cancel: (h: number) => void queued.delete(h),
    },
    queued,
    paint() {
      const due = [...queued.values()]
      queued.clear()
      due.forEach((cb) => cb())
    },
  }
}

describe('createFrameBatch', () => {
  it('runs many scheduled calls once per frame', () => {
    const frames = fakeFrames()
    const run = vi.fn()
    const batch = createFrameBatch(run, frames.api)
    for (let i = 0; i < 100; i++) batch.schedule()
    expect(run).not.toHaveBeenCalled()
    expect(frames.queued.size).toBe(1)
    frames.paint()
    expect(run).toHaveBeenCalledTimes(1)
    batch.schedule()
    frames.paint()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('flush runs a queued call now and not again at the frame', () => {
    const frames = fakeFrames()
    const run = vi.fn()
    const batch = createFrameBatch(run, frames.api)
    batch.flush()
    expect(run).not.toHaveBeenCalled()
    batch.schedule()
    batch.flush()
    expect(run).toHaveBeenCalledTimes(1)
    frames.paint()
    expect(run).toHaveBeenCalledTimes(1)
    expect(batch.pending).toBe(false)
  })

  it('cancel drops a queued call', () => {
    const frames = fakeFrames()
    const run = vi.fn()
    const batch = createFrameBatch(run, frames.api)
    batch.schedule()
    expect(batch.pending).toBe(true)
    batch.cancel()
    frames.paint()
    expect(run).not.toHaveBeenCalled()
  })

  it('a synchronous publish that cancels the batch keeps the order of writes', () => {
    // The Cowork lane: text deltas schedule, a tool row publishes at once.
    const frames = fakeFrames()
    const lane: string[] = []
    const published: string[][] = []
    const textFrame = createFrameBatch(() => publish(), frames.api)
    const publish = () => {
      textFrame.cancel()
      published.push([...lane])
    }
    lane.push('text a')
    textFrame.schedule()
    lane[0] += ' b'
    textFrame.schedule()
    lane.push('tool')
    publish()
    frames.paint()
    expect(published).toEqual([['text a b', 'tool']])
  })
})
