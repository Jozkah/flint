// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel, convertFileSrc, invoke, isTauri } from '@/lib/tauriBridgeShim'

afterEach(() => vi.unstubAllGlobals())

describe('browser stand-in for the Tauri bridge', () => {
  it('turns invoke into a server call with the same arguments', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      text: async () => '{"name":"m1"}',
    })
    vi.stubGlobal('fetch', fetch)
    expect(await invoke('read_yaml', { path: 'file://models/m1/model.yml' })).toEqual({ name: 'm1' })
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/rpc/read_yaml')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ path: 'file://models/m1/model.yml' })
    await invoke('plugin:llamacpp|get_engine_info')
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/rpc/plugin%3Allamacpp%7Cget_engine_info')
  })

  it('reports a refused command and treats an empty answer as nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, redirected: false, text: async () => 'Unknown command' })
        .mockResolvedValueOnce({ ok: true, status: 200, redirected: false, text: async () => '' })
    )
    await expect(invoke('delete_everything')).rejects.toThrow('Unknown command')
    expect(await invoke('mkdir', { args: ['x'] })).toBeUndefined()
  })

  it('rejects with the plugin error object when the server sends one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        redirected: false,
        text: async () => '{"code":"MODEL_LOAD_FAILED","message":"Model m failed to load"}',
      })
    )
    await expect(invoke('plugin:llamacpp|load_llama_model', { modelId: 'm' })).rejects.toMatchObject({
      code: 'MODEL_LOAD_FAILED',
    })
  })

  it('has no native pieces to offer', () => {
    expect(isTauri()).toBe(false)
    expect(convertFileSrc('/a/b')).toBe('/a/b')
    expect(() => JSON.stringify(new Channel())).toThrow(/not available/)
  })
})

describe('commands the server does not answer', () => {
  it('makes no request for desktop-only commands a chat touches', async () => {
    vi.resetModules()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const shim = await import('@/lib/tauriBridgeShim')
    for (const command of [
      'agent_events_record',
      'plugin:agent-tools|memory_retrieve',
      'payload_usage_record',
      'agent_deferred_list',
      'bedrock_credential_status',
    ]) {
      await expect(shim.invoke(command, {})).rejects.toThrow('Unknown command')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks the server once per unknown command, then answers locally', async () => {
    vi.resetModules()
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      redirected: false,
      text: async () => 'Unknown command',
    })
    vi.stubGlobal('fetch', fetch)
    const shim = await import('@/lib/tauriBridgeShim')
    await expect(shim.invoke('some_new_command')).rejects.toThrow('Unknown command')
    await expect(shim.invoke('some_new_command')).rejects.toThrow('Unknown command')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
