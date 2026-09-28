import { describe, it, expect, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { dispatchRemoteRpc } from '../bridge'
import { createRemoteHandlers, type RemoteSources } from '../handlers'
import { approvalOf, coworkDetailOf, roomDetailOf, toolOrigin, toolStepsOf } from '../details'
import type { CoworkDetail, RoomDetail } from '../protocol'
import type { Room } from '@/lib/rooms/types'
import { DEFAULT_ROOM_LIMITS } from '@/lib/rooms/types'

vi.mock('@/hooks/useAppState', () => ({ useAppState: {} }))

const device = { id: 'd1', name: 'Pixel' }
const call = (handlers: ReturnType<typeof createRemoteHandlers>, method: string, params: unknown = {}) =>
  dispatchRemoteRpc({ id: 'x', method, params, device }, handlers)

describe('toolStepsOf', () => {
  const message = {
    id: 'm1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Reading.' },
      { type: 'tool-read', toolCallId: 't1', state: 'output-available', input: { path: 'internal/radar/client.go' }, output: 'ok' },
      { type: 'tool-bash', toolCallId: 't2', state: 'output-error', input: { command: 'go test ./...' }, errorText: 'exit 1' },
      { type: 'tool-bash', toolCallId: 't3', state: 'input-available', input: { command: 'git push' } },
      { type: 'dynamic-tool', toolName: 'github__list_checks', toolCallId: 't4', state: 'input-streaming', input: {} },
      { type: 'tool-web_search', toolCallId: 't5', state: 'output-available', input: { query: 'redis ttl' }, output: { isError: true } },
    ],
  } as unknown as UIMessage

  it('maps each call to its desktop row: kind, status, argument, origin', () => {
    const steps = toolStepsOf(message, new Set(['t3']))
    expect(steps).toEqual([
      { id: 't1', name: 'read', kind: 'read', status: 'done', arg: 'internal/radar/client.go', origin: 'Workspace' },
      { id: 't2', name: 'bash', kind: 'fail', status: 'failed', arg: 'go test ./...', origin: 'Workspace' },
      { id: 't3', name: 'bash', kind: 'appr', status: 'awaiting', arg: 'git push', origin: 'Workspace' },
      { id: 't4', name: 'github__list_checks', kind: 'other', status: 'running', origin: 'MCP · github' },
      { id: 't5', name: 'web_search', kind: 'fail', status: 'failed', arg: 'redis ttl', origin: 'Web' },
    ])
  })

  it('names origins as the timeline does', () => {
    expect(toolOrigin('web_fetch')).toBe('Web')
    expect(toolOrigin('mcp__postgres__query')).toBe('MCP · postgres')
    expect(toolOrigin('edit')).toBe('Workspace')
  })
})

describe('coworkDetailOf', () => {
  it('reads mode and access the way the desktop does, and flattens the plan', () => {
    const d = coworkDetailOf({
      id: 'w1',
      title: 'Fix radar',
      folder: '/home/u/acme-weather',
      planMode: true,
      todos: {
        phases: [
          { name: 'a', tasks: [{ content: 'Reproduce', status: 'completed' }, { content: 'Fix', status: 'in_progress' }] },
          { name: 'b', tasks: [{ content: 'PR', status: 'pending' }] },
        ],
      },
      lastUsage: { prompt_tokens: 100, completion_tokens: 20 },
    } as Parameters<typeof coworkDetailOf>[0])
    expect(d).toMatchObject({
      group: 'acme-weather',
      mode: 'review',
      access: 'review-only',
      model: null,
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    expect(d.todos.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
  })
})

describe('roomDetailOf', () => {
  it('keeps live participants in order with their models', () => {
    const room = {
      v: 1,
      id: 'r1',
      title: 'Release',
      objective: 'Decide',
      status: 'awaiting-user',
      mode: 'round-robin',
      moderator: { enabled: false, name: 'Moderator', model: null },
      participants: [
        { id: 'b', name: 'GPT', role: 'expert', model: { provider: 'openai', id: 'gpt-5' }, toolAccess: 'read', removed: false, order: 2, availability: { state: 'unknown' } },
        { id: 'a', name: 'Claude', role: 'skeptic', model: { provider: 'anthropic', id: 'claude' }, toolAccess: 'none', removed: false, order: 1, availability: { state: 'unknown' } },
        { id: 'c', name: 'Gone', role: 'x', model: { provider: 'x', id: 'x' }, toolAccess: 'none', removed: true, order: 0, availability: { state: 'unknown' } },
      ],
      limits: DEFAULT_ROOM_LIMITS,
      usage: { turns: 3, rounds: 1, inputTokens: 100, outputTokens: 50, estimated: false, costUsd: null, activeMs: 1000, consecutiveRepetitive: 0 },
      round: 1,
      spokenThisRound: [],
      nextSpeakerId: 'b',
      stopReason: null,
      rev: 1,
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Room
    const d = roomDetailOf(room)
    expect(d.status).toBe('waiting')
    expect(d.participants.map((p) => p.name)).toEqual(['Claude', 'GPT'])
    expect(d.usage.tokens).toBe(150)
    expect(d.limits.maxTurns).toBe(DEFAULT_ROOM_LIMITS.maxTurns)
  })
})

describe('approvalOf', () => {
  it('words a command request like the approval card, with wire scopes', () => {
    const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)
    const a = approvalOf(
      {
        requestId: 'q1',
        threadId: 'w1',
        toolName: 'bash',
        input: { command: 'git push -u origin flint/radar-retry' },
        workspaceLabel: 'acme-weather',
        taskContext: 'Push the branch',
      },
      t
    )
    expect(a.subject).toBe('git push -u origin flint/radar-retry')
    expect(a.why).toBe('Push the branch')
    expect(a.title).toContain('permissions:')
    expect(a.scopes.map((s) => s.scope)).toContain('once')
    expect(a.scopes.every((s) => ['once', 'thread', 'always'].includes(s.scope))).toBe(true)
    expect(JSON.parse(a.argumentsJson)).toEqual({ command: 'git push -u origin flint/radar-retry' })
  })
})

describe('new read handlers', () => {
  const room = { id: 'r1', status: 'idle' } as unknown as RoomDetail
  const cowork = { id: 'w1', status: 'idle' } as unknown as CoworkDetail
  const src = {
    running: () => ({ chat: new Set<string>(), cowork: new Set(['w1']), room: new Set(['r1']) }),
    approvals: () => [],
    roomDetail: async (id: string) => (id === 'r1' ? room : null),
    coworkDetail: (id: string) => (id === 'w1' ? cowork : null),
    approvalDetails: () => [],
    mcpServers: () => [{ name: 'github', active: true, transport: 'stdio' as const }],
    appearance: () => ({ vars: { light: {}, dark: { '--primary': '#fff' } } }),
  } as unknown as RemoteSources
  const handlers = createRemoteHandlers(src)

  it('rooms.get and cowork.get need an id and report what is running', async () => {
    expect(await call(handlers, 'rooms.get', {})).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call(handlers, 'rooms.get', { id: 'nope' })).toMatchObject({ error: { code: 'not_found' } })
    expect(await call(handlers, 'rooms.get', { id: 'r1' })).toMatchObject({ result: { status: 'running' } })
    expect(await call(handlers, 'cowork.get', { id: 'w1' })).toMatchObject({ result: { status: 'running' } })
  })

  it('lists tools and the accent', async () => {
    expect(await call(handlers, 'tools.list')).toMatchObject({ result: { servers: [{ name: 'github' }] } })
    expect(await call(handlers, 'appearance.get')).toMatchObject({ result: { vars: { dark: { '--primary': '#fff' } } } })
    expect(await call(handlers, 'approvals.list')).toEqual({ result: { approvals: [] } })
  })

  it('still refuses changes from the phone', async () => {
    for (const m of ['room.send', 'settings.set', 'approvals.respond']) {
      expect(await call(handlers, m)).toMatchObject({ error: { code: 'not_implemented' } })
    }
  })
})

describe('models.list favorites', () => {
  it('marks the models starred on the desktop', async () => {
    const handlers = createRemoteHandlers({
      providers: () => [{ provider: 'llamacpp', title: 'Llama.cpp', local: true, models: [{ id: 'qwen' }, { id: 'gemma' }] }],
      loadedModels: async () => [],
      favoriteModels: () => ['gemma'],
    } as unknown as RemoteSources)
    const r = await call(handlers, 'models.list')
    expect(r).toEqual({
      result: {
        models: [
          { id: 'qwen', name: 'qwen', provider: 'llamacpp', providerName: 'Llama.cpp', local: true, loaded: false },
          { id: 'gemma', name: 'gemma', provider: 'llamacpp', providerName: 'Llama.cpp', local: true, loaded: false, favorite: true },
        ],
      },
    })
  })
})
