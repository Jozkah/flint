/**
 * Coalesces calls into at most one per animation frame.
 *
 * A model streams many deltas between two paints, and each one used to reach
 * the store (and every subscriber) on its own. `schedule` queues `run` for the
 * next frame and ignores further calls until it fires; `flush` runs a queued
 * call now, for a write that must not wait (a tool row that has to land after
 * the text before it); `cancel` drops a queued call whose work a synchronous
 * write already covered.
 */
export type FrameBatch = {
  schedule: () => void
  flush: () => void
  cancel: () => void
  readonly pending: boolean
}

type FrameApi = {
  request: (cb: () => void) => number
  cancel: (handle: number) => void
}

const defaultFrames = (): FrameApi =>
  typeof requestAnimationFrame === 'function'
    ? {
        request: (cb) => requestAnimationFrame(cb),
        cancel: (h) => cancelAnimationFrame(h),
      }
    : {
        request: (cb) => setTimeout(cb, 16) as unknown as number,
        cancel: (h) => clearTimeout(h),
      }

export function createFrameBatch(
  run: () => void,
  frames: FrameApi = defaultFrames()
): FrameBatch {
  let handle: number | null = null
  const fire = () => {
    handle = null
    run()
  }
  return {
    schedule() {
      if (handle !== null) return
      handle = frames.request(fire)
    },
    flush() {
      if (handle === null) return
      frames.cancel(handle)
      fire()
    },
    cancel() {
      if (handle === null) return
      frames.cancel(handle)
      handle = null
    },
    get pending() {
      return handle !== null
    },
  }
}
