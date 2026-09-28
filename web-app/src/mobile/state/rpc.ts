// Reads from the computer, cached per method and params, refetched when an
// event says they changed (`invalidate`).

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { RemoteMethod, RemoteMethods } from '@/lib/remote/protocol'
import type { RemoteCallError } from '../api/client'
import { client } from './app'

type Entry = {
  data?: unknown
  error?: RemoteCallError | Error
  loading: boolean
  stale: boolean
  promise?: Promise<void>
}

const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()
let version = 0

const notify = () => {
  version++
  listeners.forEach((l) => l())
}

const keyOf = (method: string, params: unknown) => `${method} ${JSON.stringify(params ?? {})}`

function load(method: RemoteMethod, params: unknown, key: string) {
  const prev = cache.get(key)
  if (prev?.promise) return prev.promise
  const entry: Entry = { ...prev, loading: true, stale: false }
  cache.set(key, entry)
  const promise = client()
    .rpc(method, params as never)
    .then(
      (data) => {
        cache.set(key, { data, loading: false, stale: false })
      },
      (error: Error) => {
        cache.set(key, { data: prev?.data, error, loading: false, stale: false })
      }
    )
    .finally(notify)
  entry.promise = promise
  notify()
  return promise
}

/** Marks every cached read whose method starts with one of `prefixes` as
 * stale; mounted readers refetch. */
export function invalidate(prefixes: string[]) {
  let hit = false
  for (const [key, entry] of cache) {
    if (prefixes.some((p) => key.startsWith(p))) {
      entry.stale = true
      hit = true
    }
  }
  if (hit) notify()
}

/** Refetches every cached read whose method starts with one of `prefixes`
 * now, resolving once they are all back. */
export function refresh(prefixes: string[]): Promise<void> {
  const loads: Promise<void>[] = []
  for (const key of [...cache.keys()]) {
    if (!prefixes.some((p) => key.startsWith(p))) continue
    const space = key.indexOf(' ')
    const method = key.slice(0, space) as RemoteMethod
    const params = JSON.parse(key.slice(space + 1)) as unknown
    const prev = cache.get(key)
    // A load already in flight may have started before the change.
    if (prev?.promise) {
      loads.push(prev.promise.then(() => load(method, params, key)))
    } else loads.push(load(method, params, key))
  }
  return Promise.all(loads).then(() => undefined)
}

/** What a read last returned, without subscribing. */
export function peekRpc<M extends RemoteMethod>(
  method: M,
  params: RemoteMethods[M]['params']
): RemoteMethods[M]['result'] | undefined {
  return cache.get(keyOf(method, params))?.data as RemoteMethods[M]['result'] | undefined
}

export function clearRpcCache() {
  cache.clear()
  notify()
}

/** Seeds the cache (tests, and screens that already hold a result). */
export function primeRpc<M extends RemoteMethod>(
  method: M,
  params: RemoteMethods[M]['params'],
  data: RemoteMethods[M]['result']
) {
  cache.set(keyOf(method, params), { data, loading: false, stale: false })
  notify()
}

export type RpcState<T> = {
  data: T | undefined
  error: RemoteCallError | Error | undefined
  loading: boolean
  reload: () => void
}

export function useRpc<M extends RemoteMethod>(
  method: M,
  params: RemoteMethods[M]['params'],
  enabled = true
): RpcState<RemoteMethods[M]['result']> {
  const key = keyOf(method, params)
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => version,
    () => version
  )
  const entry = cache.get(key)
  const needed = enabled && (!entry || entry.stale) && !entry?.promise
  useEffect(() => {
    if (needed) void load(method, params, key)
    // `params` is captured through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed, key])
  const reload = useCallback(() => {
    void load(method, params, key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return {
    data: entry?.data as RemoteMethods[M]['result'] | undefined,
    error: entry?.error,
    loading: Boolean(entry?.loading || (enabled && !entry)),
    reload,
  }
}
