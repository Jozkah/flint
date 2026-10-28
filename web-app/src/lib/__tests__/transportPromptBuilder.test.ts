import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CustomChatTransport } from '../custom-chat-transport'

// Same mocks as custom-chat-transport-class.test.ts: the transport pulls in
// many stores, none of which these builders need.
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: null }) },
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: {
    getState: () => ({ getDisabledToolsForThread: () => [], getDefaultDisabledTools: () => [] }),
  },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({ selectedModel: null, selectedProvider: '', getProviderByName: () => null }),
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
  useMCPServers: { getState: () => ({ settings: {} }) },
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
vi.mock('./model-factory', () => ({
  ModelFactory: { createModel: vi.fn() },
}))

type Internals = {
  tools: Record<string, unknown>
  smallContext: boolean
}

const userMsg = (text: string) =>
  ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] }) as never

describe('transport prompt builders (output fixed across the module split)', () => {
  let transport: CustomChatTransport
  const internals = () => transport as unknown as Internals

  beforeEach(() => {
    transport = new CustomChatTransport('You are helpful', 'thread-1')
  })

  it('color instruction, normal and small context', () => {
    expect(transport.buildColorOutputInstruction()).toMatchSnapshot()
    internals().smallContext = true
    expect(transport.buildColorOutputInstruction()).toBe('')
  })

  it('files instruction: none, inline only, retrieved', () => {
    expect(transport.buildFilesSystemInstruction([userMsg('hi')])).toBe('')
    expect(
      transport.buildFilesSystemInstruction([userMsg('[ATTACHED_FILES]\n- a (mode: inline)')])
    ).toBe('')
    expect(
      transport.buildFilesSystemInstruction([userMsg('[ATTACHED_FILES]\n- a (mode: embeddings)')])
    ).toMatchSnapshot()
  })

  it('web search instruction: off, normal, with images, small context', async () => {
    const { useWebSearchConfig } = await import('@/hooks/useWebSearchConfig')
    useWebSearchConfig.setState({ webSearchEnabled: false })
    internals().tools = { web_search: {} }
    expect(transport.buildWebSearchSystemInstruction()).toBe('')
    useWebSearchConfig.setState({ webSearchEnabled: true })
    internals().tools = {}
    expect(transport.buildWebSearchSystemInstruction()).toBe('')
    internals().tools = { web_search: {}, web_fetch: {} }
    expect(transport.buildWebSearchSystemInstruction()).toMatchSnapshot()
    internals().tools = { web_search: {}, image_search: {} }
    expect(transport.buildWebSearchSystemInstruction()).toMatchSnapshot()
    internals().smallContext = true
    expect(transport.buildWebSearchSystemInstruction()).toMatchSnapshot()
    useWebSearchConfig.setState({ webSearchEnabled: false })
  })

  it('agent tools instruction: off, sandboxed, unsandboxed, small context', async () => {
    const { useAgentToolsConfig } = await import('@/hooks/useAgentToolsConfig')
    const agentTools = await import('@/lib/agentTools')
    const sandbox = vi.spyOn(agentTools, 'sandboxEnforces')
    useAgentToolsConfig.setState({ agentToolsEnabled: false })
    expect(transport.buildAgentToolsSystemInstruction()).toBe('')

    useAgentToolsConfig.setState({ agentToolsEnabled: true, bashNetworkEnabled: false })
    sandbox.mockReturnValue(true)
    expect(transport.buildAgentToolsSystemInstruction()).toMatchSnapshot()
    useAgentToolsConfig.setState({ bashNetworkEnabled: true })
    expect(transport.buildAgentToolsSystemInstruction()).toMatchSnapshot()
    sandbox.mockReturnValue(false)
    expect(transport.buildAgentToolsSystemInstruction()).toMatchSnapshot()

    internals().smallContext = true
    sandbox.mockReturnValue(true)
    expect(transport.buildAgentToolsSystemInstruction()).toMatchSnapshot()
    sandbox.mockReturnValue(false)
    expect(transport.buildAgentToolsSystemInstruction()).toMatchSnapshot()
    useAgentToolsConfig.setState({ agentToolsEnabled: false })
    sandbox.mockRestore()
  })

  it('audio and video attachments become sentinel text parts', () => {
    const file = (mediaType: string, url: string) => ({ type: 'file', mediaType, url })
    const messages = [
      {
        id: 'u',
        role: 'user',
        parts: [
          file('audio/wav', 'data:audio/wav;base64,AAAA'),
          file('video/mp4', 'data:video/mp4;base64,BBBB'),
          file('image/png', 'data:image/png;base64,CCCC'),
          file('audio/wav', 'not-a-data-url'),
        ],
      },
      { id: 'a', role: 'assistant', parts: [file('audio/wav', 'data:audio/wav;base64,AAAA')] },
    ] as never[]
    expect(transport.encodeAudioAttachments(messages)).toMatchSnapshot()
    expect(transport.encodeVideoAttachments(messages)).toMatchSnapshot()
  })

  it('a subclass overriding a protected hook still shapes the prompt', () => {
    class Overriding extends CustomChatTransport {
      protected override chatShellWithheld(): boolean {
        return true
      }
    }
    const t = new Overriding('sys', 'thread-1')
    const asInternals = t as unknown as Internals
    asInternals.smallContext = false
    return import('@/hooks/useAgentToolsConfig').then(({ useAgentToolsConfig }) => {
      useAgentToolsConfig.setState({ agentToolsEnabled: true })
      const text = t.buildAgentToolsSystemInstruction()
      useAgentToolsConfig.setState({ agentToolsEnabled: false })
      expect(text).not.toContain('bash runs commands in that workspace')
    })
  })
})
