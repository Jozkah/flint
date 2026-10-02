import { useEffect, useState } from 'react'
import {
  canSummarizeLocally,
  summarizeConversation,
} from '@/lib/thread-title-summarizer'

const cache = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()

/** The remembered summary for a row in this state, if one was made. */
export const cachedPreviewSummary = (key: string): string | undefined =>
  cache.get(key)

/**
 * A real summary of a conversation for its preview card: asked once when the
 * card first opens, remembered while the conversation is unchanged (the key
 * carries its last-updated time), and absent when it cannot be made, so the
 * card falls back to its plain line.
 *
 * `getTranscript` is called only on open; the sidebar never reads a transcript
 * just to draw a row.
 */
export function usePreviewSummary(
  key: string | undefined,
  open: boolean,
  getTranscript: (() => Promise<string> | string) | undefined
): { summary: string | undefined; loading: boolean } {
  const [, bump] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !key || !getTranscript || cache.has(key)) return
    // A remote provider is never asked, and its transcript is not even read.
    if (!canSummarizeLocally(key.split('\u0000')[0])) return
    let current = true
    let run = inFlight.get(key)
    if (!run) {
      run = (async () => {
        const transcript = await getTranscript()
        if (!transcript) return null
        return summarizeConversation(
          transcript,
          new AbortController().signal,
          key.split('\u0000')[0]
        )
      })().finally(() => inFlight.delete(key))
      inFlight.set(key, run)
    }
    setLoading(true)
    void run
      .then((text) => {
        if (text) cache.set(key, text)
      })
      .catch(() => {})
      .finally(() => {
        if (!current) return
        setLoading(false)
        bump((n) => n + 1)
      })
    return () => {
      current = false
    }
    // getTranscript is a fresh closure each render; the key says when to redo it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key])

  return { summary: key ? cache.get(key) : undefined, loading }
}
