import { create } from 'zustand'
import type { WebCitation } from '@/components/Citations'

type State = {
  byMessageId: Record<string, Record<string, WebCitation>>
  setForMessage: (messageId: string, citations: WebCitation[]) => void
}

const fingerprint = (map: Record<string, WebCitation>) =>
  Object.keys(map).sort().join('|')

// Capped (oldest message first) so a long session does not keep every
// message's citations until reload.
const MAX_MESSAGES = 300

export const useWebCitationStore = create<State>((set) => ({
  byMessageId: {},
  setForMessage: (messageId, citations) => {
    if (!messageId || !citations.length) return
    const map: Record<string, WebCitation> = {}
    for (const c of citations) map[c.url] = c
    set((s) => {
      const prev = s.byMessageId[messageId]
      if (prev && fingerprint(prev) === fingerprint(map)) return s
      const next = { ...s.byMessageId, [messageId]: map }
      const keys = Object.keys(next)
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_MESSAGES)))
        delete next[k]
      return { byMessageId: next }
    })
  },
}))
