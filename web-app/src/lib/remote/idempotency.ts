// Sends from a phone carry a `clientId`. A phone that lost its connection
// mid-send cannot know whether the computer got the message, so it sends
// again with the same id; this cache answers the retry with the first
// result instead of sending twice. In memory only: a restart of the window
// ends every run anyway.

export type IdempotencyCache = {
  /** Runs `fn` once per key; later calls get the same result, flagged
   * `duplicate`. A failure is not remembered, so a retry may try again. */
  once<T extends object>(key: string, fn: () => Promise<T>): Promise<T & { duplicate?: boolean }>
  size(): number
}

export function createIdempotencyCache({
  max = 500,
  ttlMs = 15 * 60_000,
  now = () => Date.now(),
}: { max?: number; ttlMs?: number; now?: () => number } = {}): IdempotencyCache {
  const entries = new Map<string, { at: number; promise: Promise<object> }>()

  const prune = () => {
    const t = now()
    for (const [k, e] of entries) {
      if (t - e.at > ttlMs) entries.delete(k)
    }
    while (entries.size > max) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    async once(key, fn) {
      prune()
      const seen = entries.get(key)
      if (seen) {
        const first = await seen.promise
        return { ...first, duplicate: true } as never
      }
      const promise = fn()
      entries.set(key, { at: now(), promise })
      prune()
      try {
        return await promise
      } catch (e) {
        entries.delete(key)
        throw e
      }
    },
    size: () => entries.size,
  }
}
