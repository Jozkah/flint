import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createThread: vi.fn(async (_m: unknown, _t: unknown) => ({ id: 't-new' })),
  deleteThread: vi.fn(),
  busy: {} as Record<string, boolean>,
  composerFor: vi.fn(),
  waitForComposer: vi.fn(),
  stopFn: vi.fn(),
}))

const store = (state: unknown) => ({ getState: () => state })

vi.mock('@/hooks/useThreads', () => ({
  useThreads: store({
    createThread: h.createThread,
    deleteThread: h.deleteThread,
    currentThreadId: null,
    threads: {},
  }),
}))
vi.mock('@/hooks/useCoworkSessions', () => ({ useCoworkSessions: store({}) }))
vi.mock('@/hooks/useCoworkRun', () => ({ useCoworkRun: store({ runs: {} }) }))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: { getState: () => ({ busyThreads: h.busy }) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: store({
    selectedProvider: 'p',
    selectedModel: { id: 'm' },
    providers: [],
    getProviderByName: () => ({ models: [{ id: 'm' }] }),
  }),
}))
vi.mock('@/hooks/useWebSearchConfig', () => ({ useWebSearchConfig: store({}) }))
vi.mock('@/hooks/useDirectEditGrants', () => ({ useDirectEditGrants: store({}) }))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  allApprovalRequests: () => [],
  canTemporarilyAllowGit: () => false,
  useToolApprovalRequests: store({}),
}))
vi.mock('@/stores/message-queue-store', () => ({ useMessageQueue: store({ queues: {} }) }))
vi.mock('@/lib/chatSteering', () => ({ holdQueueThenStop: vi.fn() }))
vi.mock('@/lib/coworkRunner', () => ({ abortAll: vi.fn(), abortRun: vi.fn(), answerAsk: vi.fn() }))
vi.mock('../appAsks', () => ({ appAsks: {} }))
vi.mock('../appPrompts', () => ({ appPrompts: {}, respondAppPrompt: vi.fn() }))
vi.mock('@/lib/rooms/controller', () => ({ roomController: { stop: vi.fn() } }))
vi.mock('@/lib/rooms/persistence', () => ({ getRoomPersistence: () => ({}) }))
vi.mock('@/lib/rooms/store', () => ({ useRoomsStore: store({ runningRoomIds: [] }) }))
vi.mock('@/lib/permissionRequest', () => ({ describePermissionRequest: vi.fn() }))
vi.mock('@/lib/models', () => ({ resolveThreadModelId: (_p: unknown, id: unknown) => id }))
vi.mock('../api', () => ({ remoteApi: {} }))
vi.mock('../composer', () => ({
  composerFor: (...a: unknown[]) => h.composerFor(...a),
  waitForChatActions: vi.fn(),
  waitForComposer: (...a: unknown[]) => h.waitForComposer(...a),
}))
vi.mock('@/lib/resolveReplyModel', () => ({ resolveReplyModel: () => undefined }))
vi.mock('@/hooks/useModelEvidence', () => ({
  useModelEvidence: store({ preferredModel: undefined }),
}))
vi.mock('@/utils/getModelToStart', () => ({ getLastUsedModel: () => undefined }))
vi.mock('@/hooks/useChatAttachments', () => ({
  useChatAttachments: store({ setAttachments: vi.fn() }),
}))
vi.mock('@/hooks/useAttachments', () => ({ useAttachments: store({ parseMode: 'auto' }) }))
vi.mock('@/i18n/react-i18next-compat', () => ({ i18n: { t: (k: string) => k } }))
vi.mock('../attachments', () => ({ planAttachments: vi.fn() }))

import { appActions } from '../appActions'

describe('appActions chat stop', () => {
  const navigate = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    h.busy = { c1: true }
  })

  it('opens an unmounted chat, waits for the composer, then stops it', async () => {
    h.composerFor.mockReturnValue(null)
    h.waitForComposer.mockResolvedValue({ stop: h.stopFn, send: vi.fn() })
    expect(await appActions(navigate).stop('chat', 'c1')).toBe(true)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(h.waitForComposer).toHaveBeenCalledWith('chat', 'c1')
    expect(h.stopFn).toHaveBeenCalled()
  })

  it('stops a mounted chat without navigating', async () => {
    h.composerFor.mockReturnValue({ stop: h.stopFn, send: vi.fn() })
    expect(await appActions(navigate).stop('chat', 'c1')).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
    expect(h.stopFn).toHaveBeenCalled()
  })

  it('reports unavailable when the composer never mounts', async () => {
    h.composerFor.mockReturnValue(null)
    h.waitForComposer.mockResolvedValue(null)
    await expect(appActions(navigate).stop('chat', 'c1')).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('returns false for a chat that is not busy', async () => {
    h.busy = {}
    expect(await appActions(navigate).stop('chat', 'c1')).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('appActions createChat hand-off', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes the new thread and reports unavailable when sessionStorage rejects the write', async () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    const navigate = vi.fn()
    await expect(appActions(navigate).createChat({ text: 'hello' })).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(h.createThread).toHaveBeenCalledTimes(1)
    expect(h.deleteThread).toHaveBeenCalledWith('t-new')
    expect(navigate).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
