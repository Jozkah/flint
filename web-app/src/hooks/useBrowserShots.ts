import { create } from 'zustand'

const KEEP = 20

type State = {
  /** Base64 PNGs by tool call id. Display only: never sent to the model. */
  shots: Record<string, string>
  put: (callId: string, base64: string) => void
}

/** The screenshots the tool card shows, kept for the last few calls only. */
export const useBrowserShots = create<State>()((set) => ({
  shots: {},
  put: (callId, base64) =>
    set((s) => {
      const next = { ...s.shots, [callId]: base64 }
      const ids = Object.keys(next)
      for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) {
        delete next[id]
      }
      return { shots: next }
    }),
}))
