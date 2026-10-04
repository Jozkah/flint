import { create } from 'zustand'
import type { UnknownWindowEntry } from '@/lib/rooms/unknownWindows'

type Request = {
  subject: string
  entries: UnknownWindowEntry[]
  /** true: every window was set or accepted. false: cancelled. */
  resolve: (ok: boolean) => void
}

type State = {
  request: Request | null
  answer: (ok: boolean) => void
}

export const useUnknownWindowPrompt = create<State>((set, get) => ({
  request: null,
  answer: (ok) => {
    const current = get().request
    set({ request: null })
    current?.resolve(ok)
  },
}))

/**
 * Ask the user about models whose context window is unknown. One question at a
 * time: a second call while one is open cancels the first.
 */
export function promptUnknownWindows(
  subject: string,
  entries: UnknownWindowEntry[]
): Promise<boolean> {
  if (entries.length === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    useUnknownWindowPrompt.getState().request?.resolve(false)
    useUnknownWindowPrompt.setState({ request: { subject, entries, resolve } })
  })
}
