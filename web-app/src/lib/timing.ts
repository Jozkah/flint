export type Debounced<A extends unknown[]> = ((...args: A) => void) & {
  /** Drops a pending call. */
  cancel: () => void
  /** Runs a pending call now. */
  flush: () => void
}

/** Calls `fn` once `ms` after the last call; the last arguments win. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: A | undefined
  const run = () => {
    timer = undefined
    const args = pending
    pending = undefined
    if (args) fn(...args)
  }
  const debounced = ((...args: A) => {
    pending = args
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(run, ms)
  }) as Debounced<A>
  debounced.cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending = undefined
  }
  debounced.flush = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    run()
  }
  return debounced
}
