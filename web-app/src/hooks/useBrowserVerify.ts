import { create } from 'zustand'
import {
  cancelBrowserVerify,
  PROGRESS_EVENT,
  runBrowserVerify,
  type StepRecord,
  type VerifyReport,
  type VerifyStep,
} from '@/lib/browserVerify'

/**
 * Browser verifications per Cowork session: the one running (with its steps
 * as they change) and the latest reports, which the run summary shows as
 * evidence. Kept in memory only -- screenshots are large, and a report is
 * about the app as it was a moment ago.
 */
const KEEP_REPORTS = 3

type Running = { id: string; url: string; steps: StepRecord[] }

type BrowserVerifyState = {
  /** A URL handed over from the web preview, waiting for the panel. */
  draftUrl: string | null
  setDraftUrl: (url: string | null) => void
  running: Record<string, Running>
  reports: Record<string, VerifyReport[]>
  clearReports: (sessionId: string) => void
  start: (
    sessionId: string,
    url: string,
    steps: VerifyStep[],
    deps?: { run?: typeof runBrowserVerify; listen?: ListenFn }
  ) => Promise<VerifyReport>
  cancel: (sessionId: string, deps?: { cancel?: typeof cancelBrowserVerify }) => Promise<void>
}

type ListenFn = (
  event: string,
  handler: (e: { payload: { id: string; step: StepRecord } }) => void
) => Promise<() => void>

const defaultListen: ListenFn = async (event, handler) => {
  const { listen } = await import('@tauri-apps/api/event')
  return listen(event, handler as never)
}

let counter = 0

export const useBrowserVerify = create<BrowserVerifyState>()((set, get) => ({
  draftUrl: null,
  setDraftUrl: (draftUrl) => set({ draftUrl }),
  running: {},
  reports: {},
  clearReports: (sessionId) =>
    set((s) => {
      const reports = { ...s.reports }
      delete reports[sessionId]
      return { reports }
    }),
  start: async (sessionId, url, steps, deps = {}) => {
    const id = `bv-${Date.now().toString(36)}-${(counter++).toString(36)}`
    set((s) => ({ running: { ...s.running, [sessionId]: { id, url, steps: [] } } }))
    let unlisten: (() => void) | undefined
    try {
      unlisten = await (deps.listen ?? defaultListen)(PROGRESS_EVENT, (e) => {
        if (e.payload.id !== id) return
        set((s) => {
          const cur = s.running[sessionId]
          if (!cur || cur.id !== id) return s
          const steps = [...cur.steps]
          steps[e.payload.step.index] = e.payload.step
          return { running: { ...s.running, [sessionId]: { ...cur, steps } } }
        })
      }).catch(() => undefined)
      const report = await (deps.run ?? runBrowserVerify)({ id, url, steps })
      set((s) => ({
        reports: {
          ...s.reports,
          [sessionId]: [report, ...(s.reports[sessionId] ?? [])].slice(0, KEEP_REPORTS),
        },
      }))
      return report
    } finally {
      unlisten?.()
      set((s) => {
        if (s.running[sessionId]?.id !== id) return s
        const running = { ...s.running }
        delete running[sessionId]
        return { running }
      })
    }
  },
  cancel: async (sessionId, deps = {}) => {
    const cur = get().running[sessionId]
    if (cur) await (deps.cancel ?? cancelBrowserVerify)(cur.id).catch(() => false)
  },
}))
