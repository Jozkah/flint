/**
 * Named points on the window's start-up, as User Timing marks, so a slow open
 * can be told apart by phase (`performance.getEntriesByType('mark')` in a
 * debugger, or the Performance panel). A mark costs microseconds; in dev each
 * is also logged with its time since the window began loading.
 */
export function bootMark(name: string): void {
  try {
    performance.mark(name)
    if (import.meta.env?.DEV) {
      console.debug(`[boot] ${name} +${Math.round(performance.now())}ms`)
    }
  } catch {
    /* no Performance API */
  }
}
