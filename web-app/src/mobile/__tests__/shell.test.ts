import { describe, expect, it } from 'vitest'
import {
  clearDesktop,
  connectDesktop,
  saveDesktop,
  savedDesktop,
  shellInvoke,
  splitAddress,
} from '../shell'

describe('splitAddress', () => {
  it('takes a bare host and port', () => {
    expect(splitAddress('192.168.1.20:1340')).toEqual({ address: 'https://192.168.1.20:1340', fragment: '' })
  })
  it('keeps the pairing fragment of a link and drops its path', () => {
    expect(splitAddress(' https://pc.local:1340/m/#pair=abc&name=PC ')).toEqual({
      address: 'https://pc.local:1340',
      fragment: '#pair=abc&name=PC',
    })
  })
  it('upgrades http links to https', () => {
    expect(splitAddress('http://10.0.0.5:1340/m/').address).toBe('https://10.0.0.5:1340')
  })
})

describe('saved desktop', () => {
  it('round-trips through storage and survives a broken one', () => {
    const data = new Map<string, string>()
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    }
    expect(savedDesktop(store)).toBeNull()
    saveDesktop('https://pc:1340', store)
    expect(savedDesktop(store)).toBe('https://pc:1340')
    clearDesktop(store)
    expect(savedDesktop(store)).toBeNull()
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(savedDesktop(broken)).toBeNull()
  })
})

describe('shellInvoke', () => {
  it('is absent in a browser and bound to the bridge in the shell', async () => {
    expect(shellInvoke({} as Window)).toBeNull()
    const calls: unknown[] = []
    const win = {
      __TAURI_INTERNALS__: {
        invoke(this: unknown, cmd: string, args?: unknown) {
          calls.push([cmd, args, this !== undefined])
          return Promise.resolve({ base: 'http://127.0.0.1:5', host: 'pc', port: 1340, fingerprint: 'AA', firstUse: true })
        },
      },
    } as unknown as Window
    const invoke = shellInvoke(win)!
    const c = await connectDesktop(invoke, 'https://pc:1340')
    expect(c.base).toBe('http://127.0.0.1:5')
    expect(calls).toEqual([['thin_client_connect', { url: 'https://pc:1340' }, true]])
  })
})
