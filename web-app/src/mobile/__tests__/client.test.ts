import { describe, it, expect, vi } from 'vitest'
import { RemoteCallError, RemoteClient } from '../api/client'
import { memoryPairingStore, localPairingStore, PAIRING_KEY } from '../api/storage'

const pairing = { token: 'tok123', deviceId: 'd1', deviceName: 'Pixel', pairedAt: 1 }

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

describe('RemoteClient', () => {
  it('sends RPCs with the bearer token and returns the result', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => reply(200, { id: 'x', result: { modelsLoaded: 2 } }))
    const client = new RemoteClient({ store: memoryPairingStore(pairing), fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await client.rpc('status', {})
    expect(result).toEqual({ modelsLoaded: 2 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/remote/v1/rpc')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok123')
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'status', params: {} })
    // Never sent anywhere else: no credentials, no referrer.
    expect(init?.credentials).toBe('omit')
  })

  it("surfaces the desktop's refusal with its code", async () => {
    const fetchImpl = vi.fn(() => reply(200, { id: 'x', error: { code: 'not_implemented', message: 'chat.send is not available from phones yet' } }))
    const client = new RemoteClient({ store: memoryPairingStore(pairing), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.rpc('chat.send', {})).rejects.toMatchObject({ code: 'not_implemented' })
  })

  it('on 401 forgets the token, tells the app once, and fails as unauthorized', async () => {
    const store = memoryPairingStore(pairing)
    const onUnauthorized = vi.fn()
    const fetchImpl = vi.fn(() => reply(401, { error: { code: 'unauthorized', message: 'Not paired' } }))
    const client = new RemoteClient({ store, fetchImpl: fetchImpl as unknown as typeof fetch, onUnauthorized })
    await expect(client.me()).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    expect(store.get()).toBeNull()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    // Without a token nothing is sent at all.
    await expect(client.rpc('status', {})).rejects.toBeInstanceOf(RemoteCallError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('reports a network failure as such', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    const client = new RemoteClient({ store: memoryPairingStore(pairing), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.rpc('status', {})).rejects.toMatchObject({ code: 'network' })
  })

  it('carries server errors (403 forbidden) with their message', async () => {
    const fetchImpl = vi.fn(() => reply(403, { error: { code: 'forbidden', message: 'Approvals from phones are turned off on the computer' } }))
    const client = new RemoteClient({ store: memoryPairingStore(pairing), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.rpc('approvals.respond', {})).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  })

  it('pairs without a token and polls with the pairing header', async () => {
    const fetchImpl = vi.fn((url: RequestInfo | URL) =>
      String(url).endsWith('/pair') ? reply(200, { status: 'pending', pollId: 'poll1', confirmNumber: '482913' }) : reply(200, { status: 'pending' })
    )
    const client = new RemoteClient({ store: memoryPairingStore(), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.pair('code1', 'Pixel')).toMatchObject({ pollId: 'poll1' })
    await client.pairStatus('poll1')
    const [, pairInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const [, pollInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect((pairInit.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(JSON.parse(String(pairInit.body))).toEqual({ code: 'code1', deviceName: 'Pixel' })
    expect((pollInit.headers as Record<string, string>)['X-Flint-Pairing']).toBe('poll1')
  })
})

describe('localPairingStore', () => {
  it('round-trips and ignores malformed entries', () => {
    localStorage.clear()
    const store = localPairingStore(localStorage)
    expect(store.get()).toBeNull()
    store.set(pairing)
    expect(store.get()).toEqual(pairing)
    localStorage.setItem(PAIRING_KEY, '{"token":""}')
    expect(store.get()).toBeNull()
    localStorage.setItem(PAIRING_KEY, 'not json')
    expect(store.get()).toBeNull()
    store.clear()
    expect(localStorage.getItem(PAIRING_KEY)).toBeNull()
  })
})
