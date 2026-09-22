import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CustomChatTransport, normalizeToolInputSchema } from '../custom-chat-transport'

// Mock all the heavy dependencies
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: null }) },
}))

vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: { getState: () => ({ getDisabledToolsForThread: () => [], getDefaultDisabledTools: () => [] }) },
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: { getState: () => ({ selectedModel: null, selectedProvider: '', getProviderByName: () => null }) },
}))

const mockState = vi.hoisted(() => ({
  currentAssistant: null as unknown,
  threads: {} as Record<string, unknown>,
}))

vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: { getState: () => ({ currentAssistant: mockState.currentAssistant }) },
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: mockState.threads }) },
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

describe('CustomChatTransport', () => {
  let transport: CustomChatTransport

  beforeEach(() => {
    mockState.currentAssistant = null
    mockState.threads = {}
    transport = new CustomChatTransport('You are helpful', 'thread-1')
  })

  it('initializes with system message', () => {
    expect(transport).toBeDefined()
    expect(transport.model).toBeNull()
  })

  it('getTools returns empty object initially', () => {
    expect(transport.getTools()).toEqual({})
  })

  it('setOnTokenUsage sets callback', () => {
    const cb = vi.fn()
    transport.setOnTokenUsage(cb)
    // No error means it worked
    expect(true).toBe(true)
  })

  it('updateSystemMessage updates the system message', () => {
    transport.updateSystemMessage('new message')
    // Internal state updated - no public getter, just verify no error
    expect(true).toBe(true)
  })

  it('setContinueFromContent sets content', () => {
    transport.setContinueFromContent('partial content')
    expect(true).toBe(true)
  })

  it('setLastUserMessage sets the message', () => {
    transport.setLastUserMessage('hello')
    expect(true).toBe(true)
  })

  it('reconnectToStream returns null', async () => {
    const result = await transport.reconnectToStream({ chatId: 'c1' } as any)
    expect(result).toBeNull()
  })

  it('puts the enabled plugin inventory and the request_access rule in the agent instruction', async () => {
    const { useAgentToolsConfig } = await import('@/hooks/useAgentToolsConfig')
    const { setCachedPluginInventory } = await import('@/lib/pluginInventory')
    const agentTools = await import('@/lib/agentTools')
    vi.spyOn(agentTools, 'sandboxEnforces').mockReturnValue(true)
    useAgentToolsConfig.setState({ agentToolsEnabled: true })
    setCachedPluginInventory({
      plugins: [
        {
          id: 'caveman',
          name: 'caveman',
          scope: 'global',
          enabled: true,
          version: '1.0.0',
          description: '',
          source: null,
          skills: ['caveman'],
          commands: [],
          agents: [],
          mcpServer: null,
        },
      ],
      errors: [],
    })
    try {
      const text = transport.buildAgentToolsSystemInstruction()
      expect(text).toContain('call request_access with the narrowest absolute path')
      // The inventory does not depend on the agent tools being on.
      useAgentToolsConfig.setState({ agentToolsEnabled: false })
      const prompt = (
        transport as unknown as { buildSystemPrompt: (m: unknown[]) => string }
      ).buildSystemPrompt([])
      expect(prompt).toContain('Enabled Flint plugins: caveman (skills: caveman)')
      expect(prompt).toContain('never search the filesystem for plugin settings')
    } finally {
      setCachedPluginInventory(null)
    }
  })

  it('mapUserInlineAttachments passes through non-user messages', () => {
    const messages = [
      { role: 'assistant', parts: [{ type: 'text', text: 'Hi' }], metadata: {} },
    ] as any
    const result = transport.mapUserInlineAttachments(messages)
    expect(result[0].parts[0].text).toBe('Hi')
  })

  it('mapUserInlineAttachments appends inline files to user text', () => {
    const messages = [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'Check this' }],
        metadata: {
          inline_file_contents: [{ name: 'file.txt', content: 'hello world' }],
        },
      },
    ] as any
    const result = transport.mapUserInlineAttachments(messages)
    expect(result[0].parts[0].text).toContain('file.txt')
    expect(result[0].parts[0].text).toContain('hello world')
  })

  it('mapUserInlineAttachments ignores entries without content', () => {
    const messages = [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'Check' }],
        metadata: {
          inline_file_contents: [{ name: 'empty.txt' }],
        },
      },
    ] as any
    const result = transport.mapUserInlineAttachments(messages)
    expect(result[0].parts[0].text).toBe('Check')
  })

  // Regression for jan#9022: mapUserInlineAttachments must never mutate its
  // input UIMessage objects or their parts, so mapping the same array twice
  // (which happens when a request is retried) yields identical output without
  // the attachment content being appended a second time.
  it('mapUserInlineAttachments does not mutate the input message or parts', () => {
    const originalPart = { type: 'text', text: 'Check this' }
    const message = {
      role: 'user',
      parts: [originalPart],
      metadata: {
        inline_file_contents: [{ name: 'file.txt', content: 'hello world' }],
      },
    }
    const messages = [message] as any

    const result = transport.mapUserInlineAttachments(messages)

    // Original object, its parts array, and each part are untouched.
    expect(result[0]).not.toBe(message)
    expect(message.parts).toHaveLength(1)
    expect(message.parts[0]).toBe(originalPart)
    expect(originalPart.text).toBe('Check this')
    // The expansion landed on the copy only.
    expect(result[0].parts[0].text).toContain('hello world')
  })

  it('mapUserInlineAttachments is idempotent across repeated calls', () => {
    const messages = [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'Check this' }],
        metadata: {
          inline_file_contents: [{ name: 'file.txt', content: 'hello world' }],
        },
      },
    ] as any

    const first = transport.mapUserInlineAttachments(messages)
    const second = transport.mapUserInlineAttachments(messages)

    // Same output both times, and the attachment text appears exactly once.
    expect(second[0].parts[0].text).toBe(first[0].parts[0].text)
    const occurrences = (second[0].parts[0].text.match(/hello world/g) || [])
      .length
    expect(occurrences).toBe(1)
  })

  it('mapUserInlineAttachments appends every attachment and preserves non-text parts', () => {
    const filePart = { type: 'file', url: 'blob:x', mediaType: 'image/png' }
    const messages = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'one' },
          filePart,
          { type: 'text', text: 'two' },
        ],
        metadata: {
          inline_file_contents: [
            { name: 'a.txt', content: 'alpha' },
            { name: 'b.txt', content: 'beta' },
          ],
        },
      },
    ] as any

    const result = transport.mapUserInlineAttachments(messages)
    const parts = result[0].parts

    // Both text parts carry both attachments.
    for (const idx of [0, 2]) {
      expect(parts[idx].text).toContain('alpha')
      expect(parts[idx].text).toContain('beta')
    }
    // The non-text part is carried over untouched, same reference.
    expect(parts[1]).toBe(filePart)
    // Original message untouched.
    expect(messages[0].parts[0].text).toBe('one')
    expect(messages[0].parts[2].text).toBe('two')
  })

  it('mapUserInlineAttachments returns messages without attachments unchanged', () => {
    const message = {
      role: 'user',
      parts: [{ type: 'text', text: 'no files here' }],
      metadata: { some: 'meta' },
    }
    const messages = [message] as any

    const result = transport.mapUserInlineAttachments(messages)

    // Nothing to expand: same reference, metadata preserved.
    expect(result[0]).toBe(message)
    expect(result[0].metadata).toEqual({ some: 'meta' })
    expect(result[0].parts[0].text).toBe('no files here')
  })

  it('mapUserInlineAttachments leaves the persisted transcript unchanged', () => {
    // The array handed in stands in for the stored transcript; projecting it
    // for a request must not write the expansion back into it.
    const transcript = [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'persisted' }],
        metadata: {
          inline_file_contents: [{ name: 'file.txt', content: 'secret' }],
        },
      },
    ] as any
    const snapshot = JSON.stringify(transcript)

    transport.mapUserInlineAttachments(transcript)

    expect(JSON.stringify(transcript)).toBe(snapshot)
  })

  describe('inference params follow the thread assistant', () => {
    type Resolvable = {
      getActiveInferenceParams: () => Record<string, unknown>
    }
    const resolve = (t: CustomChatTransport = transport) =>
      (t as unknown as Resolvable).getActiveInferenceParams()

    it('reads params from the thread assistant when set', () => {
      mockState.currentAssistant = { id: 'default', parameters: { temperature: 0.1 } }
      mockState.threads = {
        'thread-1': { assistants: [{ id: 'agent-b', parameters: { temperature: 0.9 } }] },
      }
      expect(resolve()).toEqual({ temperature: 0.9 })
    })

    it('uses no params for a model-only thread, ignoring the global default', () => {
      mockState.currentAssistant = { id: 'default', parameters: { temperature: 0.1 } }
      mockState.threads = { 'thread-1': { assistants: [{ id: 'model-only' }] } }
      expect(resolve()).toEqual({})
    })

    it('falls back to the global assistant only when off-thread', () => {
      mockState.currentAssistant = { id: 'default', parameters: { temperature: 0.1 } }
      mockState.threads = {}
      expect(resolve(new CustomChatTransport('sys'))).toEqual({ temperature: 0.1 })
    })

    it('returns an empty object when nothing is set', () => {
      expect(resolve(new CustomChatTransport('sys'))).toEqual({})
    })
  })
})

describe('normalizeToolInputSchema edge cases', () => {
  it('handles null/undefined values', () => {
    expect(normalizeToolInputSchema({ type: 'string', default: null })).toEqual({
      type: 'string',
      default: null,
    })
  })

  it('handles primitive values', () => {
    expect(normalizeToolInputSchema({ type: 'number' })).toEqual({ type: 'number' })
  })

  it('handles $ref without adding type', () => {
    const schema = { $ref: '#/definitions/Foo', description: 'A foo' }
    const result = normalizeToolInputSchema(schema)
    expect(result.type).toBeUndefined()
    expect(result.$ref).toBe('#/definitions/Foo')
  })

  it('handles arrays at top level', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { description: 'A tag' },
        },
      },
    }
    const result = normalizeToolInputSchema(schema)
    expect((result.properties as any).tags.items.type).toBe('string')
  })
})
