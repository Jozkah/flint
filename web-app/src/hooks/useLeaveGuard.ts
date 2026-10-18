import { useEffect } from 'react'
import { useCoworkRun } from '@/hooks/useCoworkRun'

/**
 * Ask before the page is reloaded or closed while a Cowork run is live. A
 * reload ends the run's work in this window, and the person would find out only
 * when they look back. The browser words the question itself; the page can
 * only ask for it.
 */
export function shouldWarnBeforeLeaving(runCount: number): boolean {
  return runCount > 0
}

export function useLeaveGuard(): void {
  const runCount = useCoworkRun((s) => Object.keys(s.runs).length)
  const warn = shouldWarnBeforeLeaving(runCount)
  useEffect(() => {
    if (!warn) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older engines read the return value instead of the call above.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [warn])
}
