import { describe, it, expect, vi, beforeEach } from 'vitest'

// The store persists via backendStorage; stub the persist layer so the import
// is inert and no disk I/O happens in tests.
vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { settingAgentTools: 'setting-agent-tools' },
}))
// Capture the persist options so the migration can be exercised directly.
const captured = vi.hoisted(() => ({ options: undefined as any }))
vi.mock('zustand/middleware', () => ({
  persist: (fn: any, options: any) => {
    captured.options = options
    return fn
  },
  createJSONStorage: () => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))

import { useAgentToolsConfig } from '../useAgentToolsConfig'

describe('useAgentToolsConfig defaults', () => {
  it('defaults agent tools off and network on', () => {
    expect(useAgentToolsConfig.getState().agentToolsEnabled).toBe(false)
    expect(useAgentToolsConfig.getState().bashNetworkEnabled).toBe(true)
  })

  it('migrates a stored network-off from before v1 to on, once', () => {
    expect(captured.options.version).toBe(1)
    expect(
      captured.options.migrate(
        { agentToolsEnabled: true, bashNetworkEnabled: false },
        0
      )
    ).toEqual({ agentToolsEnabled: true, bashNetworkEnabled: true })
    // A choice made at v1 or later is kept.
    expect(
      captured.options.migrate({ bashNetworkEnabled: false }, 1)
    ).toEqual({ bashNetworkEnabled: false })
  })
})

describe('useAgentToolsConfig', () => {
  beforeEach(() => {
    useAgentToolsConfig.setState({
      agentToolsEnabled: false,
      bashNetworkEnabled: false,
    })
  })

  it('toggles the agent tools switch on and off', () => {
    useAgentToolsConfig.getState().setAgentToolsEnabled(true)
    expect(useAgentToolsConfig.getState().agentToolsEnabled).toBe(true)

    useAgentToolsConfig.getState().setAgentToolsEnabled(false)
    expect(useAgentToolsConfig.getState().agentToolsEnabled).toBe(false)
  })

  it('keeps bash network and agent tools switches independent', () => {
    useAgentToolsConfig.getState().setAgentToolsEnabled(true)
    expect(useAgentToolsConfig.getState().bashNetworkEnabled).toBe(false)

    useAgentToolsConfig.getState().setBashNetworkEnabled(true)
    expect(useAgentToolsConfig.getState().bashNetworkEnabled).toBe(true)
    expect(useAgentToolsConfig.getState().agentToolsEnabled).toBe(true)
  })
})
