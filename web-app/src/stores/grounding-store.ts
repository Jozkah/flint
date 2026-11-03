import { create } from 'zustand'
import type { RagCitation } from '@/components/Citations'
import {
  computeGrounding,
  type GroundingResult,
} from '@/lib/grounding'

type EmbedFn = (texts: string[]) => Promise<number[][]>

type State = {
  byMessageId: Record<string, GroundingResult>
  computing: Record<string, boolean>
  ensure: (
    messageId: string,
    text: string,
    citations: RagCitation[],
    embed: EmbedFn
  ) => void
}

// The text itself, not its length: an edit that keeps the length (a
// regenerated answer of the same size) must be grounded again.
const fingerprint = (text: string, citations: RagCitation[]) =>
  `${text}|${citations.map((c) => c.id).join(',')}`

// Per-message maps are capped (oldest message first) so a long session across
// many threads does not keep every grounding result in memory until reload.
const MAX_MESSAGES = 300
const trim = <T>(map: Record<string, T>): Record<string, T> => {
  const keys = Object.keys(map)
  if (keys.length <= MAX_MESSAGES) return map
  const out: Record<string, T> = {}
  for (const k of keys.slice(keys.length - MAX_MESSAGES)) out[k] = map[k]
  return out
}

const lastFp: Record<string, string> = {}
// Monotonic token per message: a multi-tool turn flickers to !isStreaming
// between tool calls, kicking off grounding on partial text while the final
// answer is still streaming. We can't drop the later (full-text) request — its
// result must win — so we tag each run and ignore any stale result that
// resolves after a newer run has started.
const runSeq: Record<string, number> = {}

export const useGroundingStore = create<State>((set) => ({
  byMessageId: {},
  computing: {},

  ensure: (messageId, text, citations, embed) => {
    if (!messageId || !text || !citations.length) return
    const fp = fingerprint(text, citations)
    if (lastFp[messageId] === fp) return

    lastFp[messageId] = fp
    const token = (runSeq[messageId] = (runSeq[messageId] ?? 0) + 1)
    const lastKeys = Object.keys(lastFp)
    if (lastKeys.length > MAX_MESSAGES) {
      // Insertion order: the oldest messages go first. A dropped run's late
      // result is ignored because its runSeq entry no longer matches.
      for (const k of lastKeys.slice(0, lastKeys.length - MAX_MESSAGES)) {
        if (k === messageId) continue
        delete lastFp[k]
        delete runSeq[k]
      }
    }
    set((s) => ({ computing: { ...s.computing, [messageId]: true } }))

    computeGrounding({ text, citations, embed })
      .then((result) => {
        if (runSeq[messageId] !== token) return
        set((s) => ({
          byMessageId: trim({ ...s.byMessageId, [messageId]: result }),
          computing: { ...s.computing, [messageId]: false },
        }))
      })
      .catch(() => {
        if (runSeq[messageId] !== token) return
        // Forget the fingerprint so the same text can be tried again.
        delete lastFp[messageId]
        set((s) => ({ computing: { ...s.computing, [messageId]: false } }))
      })
  },
}))
