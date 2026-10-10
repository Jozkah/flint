import { describe, it, expect, vi } from 'vitest'
import { probeLocalProviders } from '../localProviderProbe'

const ok = () => new Response('{"data":[]}', { status: 200 })

describe('probeLocalProviders', () => {
  it('reports the servers that answer and only those', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes(':1234')) return ok()
      throw new Error('connection refused')
    })
    const found = await probeLocalProviders(fetchImpl as unknown as typeof fetch)
    expect(found).toEqual([
      { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
    ])
  })

  it('only ever asks loopback, one /models request per known server', async () => {
    const fetchImpl = vi.fn(async () => ok())
    await probeLocalProviders(fetchImpl as unknown as typeof fetch)
    const urls = fetchImpl.mock.calls.map((c) => String(c[0 as never]))
    expect(urls.sort()).toEqual([
      'http://localhost:11434/v1/models',
      'http://localhost:1234/v1/models',
    ])
  })

  it('does not probe providers that are already configured', async () => {
    const fetchImpl = vi.fn(async () => ok())
    const found = await probeLocalProviders(
      fetchImpl as unknown as typeof fetch,
      ['http://localhost:11434/v1/']
    )
    expect(found.map((c) => c.name)).toEqual(['LM Studio'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('treats an error status as not found', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 404 }))
    expect(
      await probeLocalProviders(fetchImpl as unknown as typeof fetch)
    ).toEqual([])
  })

  it('gives up on a server that never answers', async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const found = await probeLocalProviders(
      fetchImpl as unknown as typeof fetch,
      [],
      20
    )
    expect(found).toEqual([])
  })
})
