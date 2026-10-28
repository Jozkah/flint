import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  invoke: vi.fn(),
  ready: { value: true },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => {
    if (!hoisted.ready.value) throw new Error('not ready')
    return { core: () => ({ invoke: hoisted.invoke }) }
  },
}))

import { moveFieldToKeyring } from '../storeSecrets'

describe('moveFieldToKeyring', () => {
  beforeEach(() => {
    hoisted.invoke.mockReset()
    hoisted.ready.value = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('keeps the field when the keyring write fails', async () => {
    hoisted.invoke.mockRejectedValue(new Error('no keyring'))
    const state: Record<string, unknown> = { apiKey: 'secret' }
    await expect(
      moveFieldToKeyring(state, 'apiKey', 'k')
    ).resolves.toBeUndefined()
    expect(state.apiKey).toBe('secret')
  })

  it('keeps the field when the service hub is not ready', async () => {
    hoisted.ready.value = false
    const state: Record<string, unknown> = { apiKey: 'secret' }
    await moveFieldToKeyring(state, 'apiKey', 'k')
    expect(state.apiKey).toBe('secret')
  })

  it('deletes the field after a successful write', async () => {
    hoisted.invoke.mockResolvedValue(undefined)
    const state: Record<string, unknown> = { apiKey: 'secret' }
    await moveFieldToKeyring(state, 'apiKey', 'k')
    expect(hoisted.invoke).toHaveBeenCalledWith('set_secret', {
      key: 'k',
      value: 'secret',
    })
    expect('apiKey' in state).toBe(false)
  })

  it('keeps the field when an explicit invoke rejects', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('boom'))
    const state: Record<string, unknown> = { apiKey: 'secret' }
    await expect(
      moveFieldToKeyring(state, 'apiKey', 'k', invoke)
    ).rejects.toThrow('boom')
    expect(state.apiKey).toBe('secret')
  })
})
