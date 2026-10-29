import { describe, it, expect } from 'vitest'
import {
  autoConnectSkipped,
  clearServerConfig,
  loadServerConfig,
  normalizeServerUrl,
  probeServer,
  saveServerConfig,
  skipAutoConnect,
} from '../flintServer'

function memory(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  }
}

describe('normalizeServerUrl', () => {
  it('adds https and drops the query, fragment and trailing slash', () => {
    expect(normalizeServerUrl('flint.tail1.ts.net')).toEqual({
      ok: true,
      url: 'https://flint.tail1.ts.net',
      insecure: false,
    })
    expect(normalizeServerUrl('https://h.example/')).toMatchObject({ url: 'https://h.example' })
    expect(normalizeServerUrl(' https://h.example:8443/?x=1#y ')).toEqual({
      ok: true,
      url: 'https://h.example:8443',
      insecure: false,
    })
  })

  it('keeps a path prefix for a server behind a reverse proxy', () => {
    expect(normalizeServerUrl('https://host/flint/')).toMatchObject({ ok: true, url: 'https://host/flint' })
    expect(normalizeServerUrl('host/a/b?q=1')).toMatchObject({ ok: true, url: 'https://host/a/b' })
  })

  it('flags plain http except for this machine', () => {
    expect(normalizeServerUrl('http://10.0.0.5:1340')).toMatchObject({ ok: true, insecure: true })
    expect(normalizeServerUrl('http://localhost:1340')).toMatchObject({ ok: true, insecure: false })
    expect(normalizeServerUrl('http://127.0.0.1:1340')).toMatchObject({ ok: true, insecure: false })
  })

  it('refuses credentials, other schemes and junk', () => {
    expect(normalizeServerUrl('https://admin:secret@h.example')).toEqual({
      ok: false,
      reason: 'credentials',
    })
    expect(normalizeServerUrl('ftp://h.example')).toEqual({ ok: false, reason: 'scheme' })
    expect(normalizeServerUrl('javascript:alert(1)')).toMatchObject({ ok: false })
    expect(normalizeServerUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeServerUrl('http://')).toMatchObject({ ok: false })
  })
})

describe('server config storage', () => {
  it('round trips and normalizes what it reads back', () => {
    const storage = memory()
    expect(loadServerConfig(storage)).toBeNull()
    saveServerConfig({ url: 'https://h.example', autoConnect: true }, storage)
    expect(loadServerConfig(storage)).toEqual({ url: 'https://h.example', autoConnect: true })
    storage.setItem('flint.server', JSON.stringify({ url: 'javascript:alert(1)', autoConnect: true }))
    expect(loadServerConfig(storage)).toBeNull()
    storage.setItem('flint.server', '{not json')
    expect(loadServerConfig(storage)).toBeNull()
    saveServerConfig({ url: 'https://h.example', autoConnect: false }, storage)
    clearServerConfig(storage)
    expect(loadServerConfig(storage)).toBeNull()
  })

  it('reads addresses stored before paths were kept unchanged, and a stored prefix back', () => {
    const storage = memory()
    // What older builds saved: a bare origin.
    storage.setItem('flint.server', JSON.stringify({ url: 'https://h.example:8443', autoConnect: true }))
    expect(loadServerConfig(storage)).toEqual({ url: 'https://h.example:8443', autoConnect: true })
    saveServerConfig({ url: 'https://host/flint', autoConnect: false }, storage)
    expect(loadServerConfig(storage)).toEqual({ url: 'https://host/flint', autoConnect: false })
  })

  it('probes /healthz under the path prefix', async () => {
    const calls: string[] = []
    const fetchImpl = (async (u: string) => {
      calls.push(u)
      return new Response('ok')
    }) as unknown as typeof fetch
    expect(await probeServer('https://host/flint', { fetchImpl })).toEqual({ state: 'ok' })
    expect(calls).toEqual(['https://host/flint/healthz'])
  })

  it('never stores anything but the address and the switch', () => {
    const storage = memory()
    saveServerConfig({ url: 'https://h.example', autoConnect: false }, storage)
    const stored = JSON.parse(storage.getItem('flint.server') as string)
    expect(Object.keys(stored).sort()).toEqual(['autoConnect', 'url'])
  })

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(loadServerConfig(broken)).toBeNull()
    expect(() => saveServerConfig({ url: 'https://h.example', autoConnect: true }, broken)).not.toThrow()
    expect(() => clearServerConfig(broken)).not.toThrow()
    expect(autoConnectSkipped(broken)).toBe(false)
  })

  it('remembers a skipped countdown for the session', () => {
    const session = memory()
    expect(autoConnectSkipped(session)).toBe(false)
    skipAutoConnect(session)
    expect(autoConnectSkipped(session)).toBe(true)
  })
})

describe('probeServer', () => {
  const reply = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch

  it('reports a Flint server when /healthz says ok', async () => {
    const calls: string[] = []
    const result = await probeServer('https://h.example', {
      fetchImpl: async (url) => {
        calls.push(url)
        return new Response('ok')
      },
    })
    expect(result).toEqual({ state: 'ok' })
    expect(calls).toEqual(['https://h.example/healthz'])
  })

  it('does not call a different answer Flint', async () => {
    expect(await probeServer('https://h.example', { fetchImpl: reply('<html>', 200) })).toEqual({
      state: 'reachable',
    })
    expect(await probeServer('https://h.example', { fetchImpl: reply('nope', 502) })).toEqual({
      state: 'reachable',
    })
  })

  it('falls back to an opaque request when the read is blocked cross-origin', async () => {
    const modes: (string | undefined)[] = []
    const result = await probeServer('https://h.example', {
      fetchImpl: async (_url, init) => {
        modes.push(init?.mode)
        if (init?.mode !== 'no-cors') throw new TypeError('Failed to fetch')
        return new Response(null)
      },
    })
    expect(result).toEqual({ state: 'reachable' })
    expect(modes).toEqual([undefined, 'no-cors'])
  })

  it('is unreachable when nothing answers either way', async () => {
    const result = await probeServer('https://h.example', {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(result.state).toBe('unreachable')
  })

  it('never sends cookies or credentials to an unconfirmed address', async () => {
    const seen: (RequestCredentials | undefined)[] = []
    await probeServer('https://h.example', {
      fetchImpl: async (_url, init) => {
        seen.push(init?.credentials)
        return new Response('ok')
      },
    })
    expect(seen).toEqual(['omit'])
  })
})
