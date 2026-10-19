import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ sandbox: true }))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: {
    getState: () => ({
      serviceHub: {
        mcp: () => ({
          getTools: async () => [],
          getToolsForServers: async () => [],
          getServerSummaries: async () => [],
        }),
        rag: () => ({ getTools: async () => [] }),
      },
    }),
  },
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: { getState: () => ({ getDisabledTools: () => [] }) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedModel: { capabilities: ['tools'] },
      selectedProvider: '',
      getProviderByName: () => null,
    }),
  },
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: { getState: () => ({ currentAssistant: null }) },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: {} }) },
}))
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: { getState: () => ({ enabled: false }) },
}))
vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: {
    getState: () => ({ settings: { enableSmartToolRouting: false } }),
  },
}))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => null }) },
}))
vi.mock('@/lib/mcp-orchestrator', () => ({
  mcpOrchestrator: { getRelevantTools: vi.fn() },
}))
vi.mock('@/lib/mcp-router-model-filter', () => ({
  isRouterModelSelectable: () => false,
}))
vi.mock('@/lib/agentTools', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/agentTools')>('@/lib/agentTools')
  const schema = (name: string) => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object' } },
  })
  return {
    ...actual,
    getAgentToolSchemas: async () => [schema('bash'), schema('read')],
    sandboxEnforces: () => h.sandbox,
  }
})
vi.mock('../model-factory', () => ({
  ModelFactory: { createModel: vi.fn() },
}))

import { CustomChatTransport } from '../custom-chat-transport'
import { useChatShell } from '@/hooks/useChatShell'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'

// Chat's own shell switch: off withholds the tool and the prompt text that
// describes it; the next send picks the change up without a new transport.
describe('chat shell switch', () => {
  beforeEach(() => {
    h.sandbox = true
    useChatShell.setState({ shellEnabled: true })
    useAgentToolsConfig.setState({ agentToolsEnabled: true, shellEnabled: true })
  })

  it('offers bash and describes it while the switch is on', async () => {
    const t = new CustomChatTransport('sys', 'thread-1')
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).toContain('bash')
    expect(t.buildAgentToolsSystemInstruction()).toContain('bash runs')
  })

  it('withholds bash and every bash sentence once the switch is off', async () => {
    useChatShell.setState({ shellEnabled: false })
    const t = new CustomChatTransport('sys', 'thread-1')
    await t.refreshTools(undefined, true)
    const names = Object.keys(t.getTools())
    expect(names).not.toContain('bash')
    expect(names).toContain('read')
    const text = t.buildAgentToolsSystemInstruction()
    expect(text).not.toMatch(/\bbash\b/i)
    expect(text).not.toContain('network access')
    // The git tool is a separate tool and stays described.
    expect(text).toContain('git tool')
  })

  it('takes effect on the next send without a new transport', async () => {
    const t = new CustomChatTransport('sys', 'thread-1')
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).toContain('bash')
    useChatShell.setState({ shellEnabled: false })
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).not.toContain('bash')
    useChatShell.setState({ shellEnabled: true })
    await t.refreshTools(undefined, true)
    expect(Object.keys(t.getTools())).toContain('bash')
  })
})
