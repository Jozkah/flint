// Where a phone's message enters a conversation: the same function the
// desktop's composer calls. A conversation registers its send (and stop)
// while it is mounted -- `ThreadConversation` for a chat, the Cowork route for
// the session in view -- so a phone's message runs through the very code the
// Send button runs, and the desktop window shows it as if typed there.

import { useEffect, useRef } from 'react'
import type { SessionKind } from './protocol'

/** Media as the composer hands it to its submit (data URLs). */
export type ComposerFile = { type: string; mediaType: string; url: string }

export type ComposerEntry = {
  send: (text: string, files?: ComposerFile[]) => void | Promise<void>
  stop?: () => void
}

type Waiter = { key: string; resolve: (e: ComposerEntry | null) => void }

const entries = new Map<string, ComposerEntry>()
let waiters: Waiter[] = []

const keyOf = (kind: SessionKind, id: string) => `${kind}:${id}`

/** Registers a mounted conversation's composer; returns the unregister. */
export function registerComposer(
  kind: SessionKind,
  id: string,
  entry: ComposerEntry
): () => void {
  const key = keyOf(kind, id)
  entries.set(key, entry)
  const ready = waiters.filter((w) => w.key === key)
  waiters = waiters.filter((w) => w.key !== key)
  ready.forEach((w) => w.resolve(entry))
  return () => {
    if (entries.get(key) === entry) entries.delete(key)
  }
}

export function composerFor(kind: SessionKind, id: string): ComposerEntry | null {
  return entries.get(keyOf(kind, id)) ?? null
}

/** The composer once the conversation mounts, or null after `timeoutMs`. */
export function waitForComposer(
  kind: SessionKind,
  id: string,
  timeoutMs = 8000
): Promise<ComposerEntry | null> {
  const now = composerFor(kind, id)
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const key = keyOf(kind, id)
    const waiter: Waiter = {
      key,
      resolve: (e) => {
        clearTimeout(timer)
        resolve(e)
      },
    }
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== waiter)
      resolve(null)
    }, timeoutMs)
    waiters.push(waiter)
  })
}

/** Test helper. */
export function resetComposers() {
  entries.clear()
  waiters.forEach((w) => w.resolve(null))
  waiters = []
}

/**
 * Registers `send`/`stop` for `kind:id` while mounted. The latest render's
 * functions are called, through a ref, so registering once is enough.
 */
export function useRemoteComposer(
  kind: SessionKind,
  id: string | null | undefined,
  send: ComposerEntry['send'],
  stop?: ComposerEntry['stop']
) {
  const ref = useRef({ send, stop })
  ref.current = { send, stop }
  useEffect(() => {
    if (!id) return
    return registerComposer(kind, id, {
      send: (text, files) => ref.current.send(text, files),
      stop: () => ref.current.stop?.(),
    })
  }, [kind, id])
}
