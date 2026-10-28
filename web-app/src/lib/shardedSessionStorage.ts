import type {
  PersistStorage,
  StateStorage,
  StorageValue,
} from 'zustand/middleware'

/**
 * Persist the Cowork session list one session per key.
 *
 * The store used to write one blob holding every session, so changing one
 * message sent (and redacted, and re-parsed) the whole history. Here the index
 * key `name` holds the small state plus `sessionIds`, and each session lives
 * at `name:<id>`. A flush stringifies every session but only writes the ones
 * whose text changed, and the redaction below this wrapper only sees those.
 *
 * Safety rules (this is the user's chat history):
 *  - shards are written before the index, so a crash leaves the previous index
 *    (or the legacy single blob) valid and readable;
 *  - a shard is removed only after the index that no longer lists it landed;
 *  - a shard that could not be read is not a deleted session: its id stays in
 *    the index and its data is never removed, so a transient read failure
 *    cannot turn into data loss;
 *  - an old single-blob value (sessions inline) is read as it is, and the next
 *    write replaces it with the index;
 *  - a session list that cannot be keyed (no or repeated id) is written as the
 *    single blob, as before.
 */

type SessionLike = { id?: unknown }
type Sharded<S> = Omit<S, 'sessions'> & { sessionIds?: string[] }
type SessionsState = { sessions: unknown[] }

const shardKey = (name: string, id: string) => `${name}:${id}`

// A session object the store has not replaced has the text it had last time,
// so a flush stringifies only the sessions that changed.
const shardTexts = new WeakMap<object, string>()
function shardText(session: unknown): string {
  const isObject = typeof session === 'object' && session !== null
  const known = isObject ? shardTexts.get(session) : undefined
  if (known !== undefined) return known
  const text = JSON.stringify({ state: { sessions: [session] } })
  if (isObject) shardTexts.set(session, text)
  return text
}

function idsOf(sessions: unknown[]): string[] | null {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    const id = (session as SessionLike | null)?.id
    if (typeof id !== 'string' || !id || seen.has(id)) return null
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function shardedSessionStorage<S = unknown>(
  inner: StateStorage
): PersistStorage<S> {
  // The text last written (or read) for each shard, per index key.
  const lastShard = new Map<string, string>()
  // Ids the last index listed, per index key: what a later write may remove.
  const lastIds = new Map<string, string[]>()
  // Ids the index listed whose shard could not be read, per index key.
  const unreadable = new Map<string, string[]>()

  return {
    getItem: async (name) => {
      const raw = await inner.getItem(name)
      if (raw == null) return null
      // An unreadable index throws, as the plain JSON storage does.
      const doc: StorageValue<Sharded<S>> = JSON.parse(raw)
      const state = doc?.state as
        | (Sharded<S> & { sessions?: unknown[] })
        | undefined
      const ids = state?.sessionIds
      if (!state || !Array.isArray(ids)) {
        // Legacy blob (sessions inline), or a store with nothing saved yet.
        return doc as unknown as StorageValue<S>
      }

      const started = Date.now()
      const texts = await Promise.all(
        ids.map((id) =>
          Promise.resolve(inner.getItem(shardKey(name, id))).catch(() => null)
        )
      )
      const sessions: unknown[] = []
      const missing: string[] = []
      ids.forEach((id, i) => {
        const text = texts[i]
        try {
          const parsed = text ? JSON.parse(text) : null
          const session = parsed?.state?.sessions?.[0]
          if (session) {
            sessions.push(session)
            lastShard.set(shardKey(name, id), text as string)
            return
          }
        } catch {
          // falls through to "missing"
        }
        missing.push(id)
      })
      if (missing.length > 0) {
        console.warn(
          `[sessions] ${missing.length} saved session(s) could not be read and were left on disk`
        )
      }
      lastIds.set(name, [...ids])
      unreadable.set(name, missing)
      console.debug(
        `[sessions] loaded ${sessions.length} session(s) in ${Date.now() - started} ms`
      )
      const { sessionIds: _ids, ...rest } = state
      void _ids
      return {
        ...doc,
        state: { ...rest, sessions },
      } as unknown as StorageValue<S>
    },

    setItem: async (name, value) => {
      const { sessions, ...rest } = value.state as SessionsState
      const ids = Array.isArray(sessions) ? idsOf(sessions) : null
      if (!ids) {
        await inner.setItem(name, JSON.stringify(value))
        lastIds.delete(name)
        unreadable.delete(name)
        return
      }

      // Shards first, index last.
      const writes: Array<Promise<unknown>> = []
      const written: Array<[string, string]> = []
      sessions.forEach((session, i) => {
        const key = shardKey(name, ids[i])
        const text = shardText(session)
        if (lastShard.get(key) === text) return
        written.push([key, text])
        writes.push(Promise.resolve(inner.setItem(key, text)))
      })
      await Promise.all(writes)
      for (const [key, text] of written) lastShard.set(key, text)

      // A shard that could not be read stays listed so it survives.
      const held = (unreadable.get(name) ?? []).filter((id) => !ids.includes(id))
      const listed = [...ids, ...held]
      const index = {
        ...value,
        state: { ...rest, sessionIds: listed },
      }
      await inner.setItem(name, JSON.stringify(index))

      const before = lastIds.get(name) ?? []
      lastIds.set(name, listed)
      for (const id of before) {
        if (listed.includes(id)) continue
        const key = shardKey(name, id)
        lastShard.delete(key)
        try {
          await inner.removeItem(key)
        } catch (error) {
          // An orphan shard is harmless; failing here would re-run the flush.
          console.warn(`[sessions] could not remove '${key}':`, error)
        }
      }
    },

    removeItem: async (name) => {
      const ids = lastIds.get(name) ?? []
      await inner.removeItem(name)
      for (const id of ids) {
        const key = shardKey(name, id)
        lastShard.delete(key)
        try {
          await inner.removeItem(key)
        } catch {
          // see setItem
        }
      }
      lastIds.delete(name)
      unreadable.delete(name)
    },
  }
}
