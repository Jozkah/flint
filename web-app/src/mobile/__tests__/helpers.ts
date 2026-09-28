import { vi } from 'vitest'
import fx from './fixtures.json'
import { RemoteCallError, type RemoteClient } from '../api/client'
import { app, initialState, installRuntime } from '../state/app'
import { clearRpcCache } from '../state/rpc'
import type { Route } from '../state/router'

type Rpc = Record<string, unknown>

/** A client answering from the fixtures; methods not in them are refused
 * with `not_implemented`, as the desktop does today. */
export function fakeClient(over: Rpc = {}) {
  const rpc = vi.fn(async (method: string, params?: { id?: string }) => {
    const table = { ...(fx.rpc as Rpc), ...over }
    let r = table[method] as Record<string, unknown> | undefined
    if (r && params?.id && r[params.id] !== undefined) r = r[params.id] as Record<string, unknown>
    if (r === undefined) throw new RemoteCallError('not_implemented', `${method} is not available from phones yet`)
    return r
  })
  const client = {
    rpc,
    me: vi.fn(async () => fx.me),
    unpair: vi.fn(async () => {}),
    pair: vi.fn(),
    pairStatus: vi.fn(),
    setUnauthorizedHandler: vi.fn(),
    token: 'tok',
  } as unknown as RemoteClient & { rpc: typeof rpc }
  return client
}

export function resetApp(route: Route = { name: 'home' }) {
  clearRpcCache()
  app.set({ ...initialState(), auth: 'paired', conn: 'connected', route, computerName: 'Desk PC' })
}

export function useFixtures(over: Rpc = {}) {
  const client = fakeClient(over)
  installRuntime({ client, socket: null })
  return client
}
