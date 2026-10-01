import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dispatchRemoteRpc, type RemoteHandlers } from '../bridge'
import { createExtraHandlers, safeRelPath, type RemoteExtras } from '../extras'
import { createActionHandlers, type RemoteActions } from '../actions'
import { createIdempotencyCache } from '../idempotency'
import { replyMetaFrom } from '../replyMeta'

const device = { id: 'd1', name: 'Pixel' }
let handlers: RemoteHandlers
const call = (method: string, params: unknown) => dispatchRemoteRpc({ id: 'x', method, params, device }, handlers)

function mockExtras(over: Partial<RemoteExtras> = {}): RemoteExtras {
  return {
    chatDetails: vi.fn((id: string) => (id === 'c1' ? ({ id: 'c1' } as never) : null)),
    setChatEffort: vi.fn(),
    setChatAssistant: vi.fn(),
    assistants: vi.fn(() => ({ assistants: [{ id: 'jan', name: 'Flint', builtIn: true }, { id: 'quartz', name: 'Quartz', builtIn: true }], routing: true })),
    forkChat: vi.fn(async (id: string) => (id === 'c1' ? 'c2' : null)),
    compactChat: vi.fn(() => true),
    regenerateTitle: vi.fn(async () => 'done' as const),
    clearRoom: vi.fn(async () => {}),
    coworkFiles: vi.fn(async () => ({ root: '/p', entries: [], truncated: false })),
    coworkFile: vi.fn(async (_id: string, path: string) => ({ path, status: 'ready' as const, content: 'x', changed: {}, language: 'Go', touched: [] })),
    coworkPreview: vi.fn(async () => ({ artifacts: [], path: null, kind: null, content: null })),
    hfSearch: vi.fn(async () => ({ models: [], device: null })),
    hfDownload: vi.fn(async (repo: string) => `hf:llamacpp:${repo}`),
    downloads: vi.fn(() => []),
    ...over,
  }
}

describe('extra handlers (#30–#87)', () => {
  let x: RemoteExtras
  beforeEach(() => {
    x = mockExtras()
    handlers = createExtraHandlers(x) as unknown as RemoteHandlers
  })

  it('reads a chat’s details, and says when there is no such chat', async () => {
    expect(await call('chat.details', { id: 'c1' })).toEqual({ result: { id: 'c1' } })
    expect(await call('chat.details', { id: 'nope' })).toMatchObject({ error: { code: 'not_found' } })
    expect(await call('chat.details', {})).toMatchObject({ error: { code: 'bad_params' } })
  })

  it('sets an effort stop, resets with null, and refuses unknown ones', async () => {
    await call('chat.effort', { id: 'c1', choice: 'high' })
    await call('chat.effort', { id: 'c1', choice: null })
    expect(x.setChatEffort).toHaveBeenNthCalledWith(1, 'c1', 'high')
    expect(x.setChatEffort).toHaveBeenNthCalledWith(2, 'c1', null)
    expect(await call('chat.effort', { id: 'c1', choice: 'max' })).toMatchObject({ error: { code: 'bad_params' } })
  })

  it('picks Auto or a known assistant only', async () => {
    await call('chat.assistant', { id: 'c1', assistant: 'auto' })
    await call('chat.assistant', { id: 'c1', assistant: 'quartz' })
    expect(x.setChatAssistant).toHaveBeenCalledTimes(2)
    expect(await call('chat.assistant', { id: 'c1', assistant: 'evil' })).toMatchObject({ error: { code: 'not_found' } })
  })

  it('forks from a message and regenerates titles per kind', async () => {
    expect(await call('chat.fork', { id: 'c1', messageId: 'm2' })).toEqual({ result: { id: 'c2' } })
    expect(x.forkChat).toHaveBeenCalledWith('c1', 'm2')
    expect(await call('chat.fork', { id: 'empty' })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('title.regenerate', { kind: 'room', id: 'r1' })).toEqual({ result: { result: 'done' } })
    expect(await call('title.regenerate', { kind: 'x', id: 'r1' })).toMatchObject({ error: { code: 'bad_params' } })
  })

  it('clears a room with a known scope', async () => {
    await call('room.clear', { id: 'r1', scope: 'knowledge' })
    expect(x.clearRoom).toHaveBeenCalledWith('r1', 'knowledge')
    expect(await call('room.clear', { id: 'r1', scope: 'disk' })).toMatchObject({ error: { code: 'bad_params' } })
  })

  it('reads project files by relative path only', async () => {
    expect(await call('cowork.file', { id: 'w1', path: 'internal/radar/client.go' })).toMatchObject({ result: { status: 'ready' } })
    for (const path of ['../etc/passwd', '/etc/passwd', 'a/../../b', 'C:/x']) {
      expect(await call('cowork.file', { id: 'w1', path })).toMatchObject({ error: { code: 'forbidden' } })
    }
    expect(await call('cowork.file', { id: 'w1' })).toMatchObject({ error: { code: 'bad_params' } })
    expect(safeRelPath('./src\\a.ts')).toBe('src/a.ts')
  })

  it('validates Hugging Face searches and downloads', async () => {
    await call('hf.search', { query: 'qwen', modality: 'vision' })
    expect(x.hfSearch).toHaveBeenCalledWith({ query: 'qwen', modality: 'vision' })
    expect(await call('hf.search', { modality: 'smell' })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('hf.download', { repo: 'Qwen/Qwen3-8B-GGUF', quant: 'Q4_K_M' })).toEqual({ result: { ok: true, id: 'hf:llamacpp:Qwen/Qwen3-8B-GGUF' } })
    expect(await call('hf.download', { repo: 'https://evil' })).toMatchObject({ error: { code: 'bad_params' } })
  })

  it('answers not_implemented without a desktop implementation', async () => {
    handlers = createExtraHandlers() as unknown as RemoteHandlers
    expect(await call('assistants.list', {})).toMatchObject({ error: { code: 'not_implemented' } })
  })
})

describe('stop all in this chat and Allow all temporarily', () => {
  const actions = (over: Partial<RemoteActions> = {}) =>
    ({
      stop: vi.fn(async () => true),
      stopAll: vi.fn(async () => 3),
      stopConversation: vi.fn(async () => 4),
      permissions: vi.fn(async () => ({ approvals: true, alwaysAllow: false })),
      findApproval: vi.fn(() => ({ toolCallId: 'tc1', scopes: ['once', 'temporary'] })),
      resolveApproval: vi.fn(),
      ...over,
    }) as unknown as RemoteActions

  it('run.stop with scope chat stops the whole conversation', async () => {
    const a = actions()
    handlers = createActionHandlers(a, createIdempotencyCache()) as unknown as RemoteHandlers
    expect(await call('run.stop', { kind: 'chat', id: 'c1', scope: 'chat' })).toEqual({ result: { stopped: 4 } })
    expect(a.stopConversation).toHaveBeenCalledWith('chat', 'c1')
    expect(a.stop).not.toHaveBeenCalled()
  })

  it('a temporary grant reaches the desktop as allow-git-temporary, only when offered', async () => {
    const a = actions()
    handlers = createActionHandlers(a, createIdempotencyCache()) as unknown as RemoteHandlers
    await call('approvals.respond', { requestId: 'ap1', decision: 'allow', scope: 'temporary' })
    expect(a.resolveApproval).toHaveBeenCalledWith('tc1', 'ap1', 'allow-git-temporary')
    const b = actions({ findApproval: vi.fn(() => ({ toolCallId: 'tc1', scopes: ['once'] as never })) })
    handlers = createActionHandlers(b, createIdempotencyCache()) as unknown as RemoteHandlers
    expect(await call('approvals.respond', { requestId: 'ap1', decision: 'allow', scope: 'temporary' })).toMatchObject({ error: { code: 'bad_params' } })
  })
})

describe('reply meta', () => {
  it('reads speed, tokens, cache, draft, assistant and skills from message metadata', () => {
    const meta = replyMetaFrom(
      {
        assistantName: 'Quartz',
        tokenSpeed: { tokenSpeed: 41.2, promptSpeed: 612, tokenCount: 412, durationMs: 10000, draftTokens: 380, draftAccepted: 270 },
        usage: { inputTokens: 6214, outputTokens: 412, totalTokens: 6626, cachedInputTokens: 6000 },
      },
      ['acme:go-testing', 'pr-writer']
    )
    expect(meta).toEqual({
      assistant: 'Quartz',
      outputTokens: 412,
      tokensPerSecond: 41.2,
      promptPerSecond: 612,
      cache: 'reused',
      draft: { tokens: 380, accepted: 270 },
      skills: ['acme:go-testing', 'pr-writer'],
    })
    expect(replyMetaFrom({}, [])).toBeNull()
  })
})
