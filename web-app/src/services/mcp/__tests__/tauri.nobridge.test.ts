import { describe, it, expect, vi } from 'vitest'
import { TauriMCPService } from '../tauri'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('TauriMCPService without the bridge', () => {
  it('answers with empty values instead of undefined', async () => {
    Object.defineProperty(globalThis, 'window', {
      value: { core: undefined },
      writable: true,
    })
    const svc = new TauriMCPService()
    expect(await svc.getTools()).toEqual([])
    expect(await svc.getConnectedServers()).toEqual([])
    const call = svc.callToolWithCancellation({ toolName: 'x' })
    await expect(call.promise).resolves.toMatchObject({
      error: 'MCP bridge unavailable',
    })
  })
})
