import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createSurfaceDelegation } = vi.hoisted(() => ({ createSurfaceDelegation: vi.fn() }))
vi.mock('@/lib/surfaceDelegation', async (orig) => ({
  ...(await orig<typeof import('../surfaceDelegation')>()),
  createSurfaceDelegation,
}))
vi.mock('@/lib/coworkSubagentRegistry', () => ({
  listSubagents: vi.fn(async () => [{ name: 'explorer' }, { name: 'mine' }]),
}))

import {
  CHAT_DELEGATION_TOOL_NAMES,
  chatDelegationEnabled,
  chatDelegationTools,
  chatHasRunningChildren,
  runChatDelegation,
  stopChatDelegation,
} from '../chatDelegation'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useChatSessions } from '@/stores/chat-session-store'

const call = { toolCallId: 'c1', toolName: 'task', input: { subagent_name: 'explorer', description: 'd' } }

beforeEach(() => {
  createSurfaceDelegation.mockReset()
  useAgentToolsConfig.setState({ agentToolsEnabled: true, chatDelegationEnabled: true })
  useChatSessions.setState({ sessions: {} } as never)
  stopChatDelegation('t1')
})

describe('chat delegation setting', () => {
  it('is on by default, and offered only while the agent tools are on', async () => {
    expect(useAgentToolsConfig.getInitialState().chatDelegationEnabled).toBe(true)
    expect(chatDelegationEnabled()).toBe(true)
    const offered = await chatDelegationTools()
    expect(Object.keys(offered.tools).sort()).toEqual(['await_task', 'cancel_task', 'task', 'task_status'])
    expect(offered.names).toEqual(['explorer', 'mine'])

    useAgentToolsConfig.setState({ agentToolsEnabled: false })
    expect(chatDelegationEnabled()).toBe(false)
    expect((await chatDelegationTools()).tools).toEqual({})
  })

  it('can be switched off on its own', async () => {
    useAgentToolsConfig.setState({ chatDelegationEnabled: false })
    expect(chatDelegationEnabled()).toBe(false)
    expect((await chatDelegationTools()).tools).toEqual({})
  })

  it('names the four tools the chat executes itself', () => {
    expect([...CHAT_DELEGATION_TOOL_NAMES].sort()).toEqual(['await_task', 'cancel_task', 'task', 'task_status'])
  })

  it('offers no team and no isolate to a chat', async () => {
    const { tools } = await chatDelegationTools()
    const description = (tools.task as { description: string }).description
    expect(description).not.toContain('team')
    expect(description).not.toContain('isolate')
  })
})

describe('running a delegation call in a chat', () => {
  it('says so plainly when the conversation has no transport', async () => {
    const out = await runChatDelegation('t1', 'qwen', call)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('not available')
    expect(createSurfaceDelegation).not.toHaveBeenCalled()
  })

  it('builds one delegation per conversation and reuses it', async () => {
    const run = vi.fn(async () => ({ output: 'ok' }))
    createSurfaceDelegation.mockResolvedValue({ tools: {}, tasks: { running: () => [] }, run })
    useChatSessions.setState({
      sessions: { t1: { transport: { model: {}, reasoningProviderOptions: () => undefined } } },
    } as never)
    expect((await runChatDelegation('t1', 'qwen', call)).output).toBe('ok')
    await runChatDelegation('t1', 'qwen', { ...call, toolCallId: 'c2' })
    expect(createSurfaceDelegation).toHaveBeenCalledTimes(1)
    expect(createSurfaceDelegation.mock.calls[0][0]).toMatchObject({ id: 't1', scope: 'thread', background: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('turns a throw into an error the model can read', async () => {
    createSurfaceDelegation.mockRejectedValue(new Error('registry unreadable'))
    useChatSessions.setState({ sessions: { t1: { transport: { model: {} } } } } as never)
    const out = await runChatDelegation('t1', 'qwen', call)
    expect(out).toEqual({ output: 'ERROR: registry unreadable', isError: true })
  })

  it('stops every child with the conversation, and starts fresh afterwards', async () => {
    let signal!: AbortSignal
    createSurfaceDelegation.mockImplementation(async (spec: { signal: AbortSignal }) => {
      signal = spec.signal
      return { tools: {}, tasks: { running: () => [{ id: 'a' }] }, run: async () => ({ output: 'ok' }) }
    })
    useChatSessions.setState({ sessions: { t1: { transport: { model: {} } } } } as never)
    await runChatDelegation('t1', 'qwen', call)
    expect(chatHasRunningChildren('t1')).toBe(true)
    stopChatDelegation('t1')
    expect(signal.aborted).toBe(true)
    expect(chatHasRunningChildren('t1')).toBe(false)
    await runChatDelegation('t1', 'qwen', call)
    expect(createSurfaceDelegation).toHaveBeenCalledTimes(2)
  })
})
