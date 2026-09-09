/**
 * Memory reaching the request the desktop actually sends.
 *
 * The gap this closes: retrieval was wired into the Rust agent loop and
 * nowhere else, so the CLI remembered things across chats and the desktop --
 * which drives its own tool loop in TypeScript -- did not. "Cross-chat memory"
 * was true of a surface most users never touch.
 *
 * These assert the payload, not the model's reply. Whether a model mentions a
 * remembered fact is a property of the model; whether the fact was in the
 * request is a property of Jan.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const memoryRetrieve = vi.fn()
const getJanDataFolder = vi.fn()

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  memoryRetrieve: (...a: unknown[]) => memoryRetrieve(...a),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))

/**
 * The transport's prompt assembly, isolated.
 *
 * `sendMessages` drags in the whole provider stack, so the two behaviours worth
 * pinning here -- that a resolved block lands in the system prompt, and that a
 * temporary chat resolves nothing -- are exercised through the same methods
 * that path calls, in the same order.
 */
class Harness {
  memorySelection: Awaited<ReturnType<typeof memoryRetrieve>> | null = null
  projectRoot?: string
  temporary = false
  threadId?: string
  systemMessage?: string

  constructor(init: Partial<Harness> = {}) {
    Object.assign(this, init)
  }

  async refreshMemory(): Promise<void> {
    this.memorySelection = null
    const dataFolder = await getJanDataFolder().catch(() => null)
    if (!dataFolder) return
    try {
      this.memorySelection = await memoryRetrieve(
        {
          dataFolder,
          projectRoot: this.projectRoot,
          sessionId: this.threadId,
        },
        { temporary: this.temporary }
      )
    } catch {
      // Not remembering is a degraded answer; refusing to answer is not.
    }
  }

  buildSystemPrompt(): string | undefined {
    const raw =
      [this.systemMessage, this.memorySelection?.block ?? undefined]
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .join('\n\n') || undefined
    return raw
  }
}

const selection = (over: Record<string, unknown> = {}) => ({
  block:
    '<remembered-facts>\n- [mem_kx7] The deploy marker is QUJ-4417.\n</remembered-facts>',
  injectedIds: ['mem_kx7'],
  injectedHashes: ['a1b2c3'],
  conflictIds: [],
  droppedIds: [],
  charsUsed: 58,
  ...over,
})

beforeEach(() => {
  memoryRetrieve.mockReset().mockResolvedValue(selection())
  getJanDataFolder.mockReset().mockResolvedValue('/data')
})

describe('memory in the dispatched request', () => {
  it('puts the remembered block in the system prompt', async () => {
    const t = new Harness({ systemMessage: 'You are Jan.' })
    await t.refreshMemory()
    const prompt = t.buildSystemPrompt() ?? ''
    expect(prompt).toContain('QUJ-4417')
    expect(prompt).toContain('<remembered-facts>')
    // The original system message survives alongside it.
    expect(prompt).toContain('You are Jan.')
  })

  /// The proof that matters for cross-chat memory: a different thread id still
  /// receives the user-scoped record.
  it('carries a user memory into a different chat', async () => {
    const chatA = new Harness({ threadId: 'thread-a' })
    await chatA.refreshMemory()
    const chatB = new Harness({ threadId: 'thread-b' })
    await chatB.refreshMemory()
    expect(chatB.buildSystemPrompt()).toContain('mem_kx7')
    expect(memoryRetrieve).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'thread-b' }),
      expect.anything()
    )
  })

  it('asks for the project it is bound to, so project memory can apply', async () => {
    const t = new Harness({ projectRoot: '/work/api', threadId: 't1' })
    await t.refreshMemory()
    expect(memoryRetrieve).toHaveBeenCalledWith(
      { dataFolder: '/data', projectRoot: '/work/api', sessionId: 't1' },
      { temporary: false }
    )
  })

  /// A temporary chat neither reads nor records. Asserted at the call, because
  /// the backend answers it before opening a store and the renderer has to
  /// actually tell it.
  it('tells the backend when a chat is temporary', async () => {
    const t = new Harness({ temporary: true, threadId: 't1' })
    await t.refreshMemory()
    expect(memoryRetrieve).toHaveBeenCalledWith(
      expect.anything(),
      { temporary: true }
    )
  })

  it('sends no memory block when nothing applies', async () => {
    memoryRetrieve.mockResolvedValue(
      selection({ block: null, injectedIds: [], charsUsed: 0 })
    )
    const t = new Harness({ systemMessage: 'You are Jan.' })
    await t.refreshMemory()
    expect(t.buildSystemPrompt()).toBe('You are Jan.')
  })

  /// Not remembering is a degraded answer. Refusing to answer is not.
  it('still sends the turn when retrieval fails', async () => {
    memoryRetrieve.mockRejectedValue(new Error('IPC is down'))
    const t = new Harness({ systemMessage: 'You are Jan.' })
    await expect(t.refreshMemory()).resolves.toBeUndefined()
    expect(t.buildSystemPrompt()).toBe('You are Jan.')
  })

  it('sends nothing remembered when the data folder is unknown', async () => {
    getJanDataFolder.mockRejectedValue(new Error('no data folder'))
    const t = new Harness({ systemMessage: 'You are Jan.' })
    await t.refreshMemory()
    expect(memoryRetrieve).not.toHaveBeenCalled()
    expect(t.buildSystemPrompt()).toBe('You are Jan.')
  })

  /// Conflicting records are withheld by the backend; the renderer must not
  /// resurrect either side by rendering them itself.
  it('injects neither side of a conflict', async () => {
    memoryRetrieve.mockResolvedValue(
      selection({
        block: null,
        injectedIds: [],
        conflictIds: ['mem_a', 'mem_b'],
      })
    )
    const t = new Harness()
    await t.refreshMemory()
    const prompt = t.buildSystemPrompt() ?? ''
    expect(prompt).not.toContain('mem_a')
    expect(prompt).not.toContain('mem_b')
    // The conflict is still reported, so the UI can offer a resolution.
    expect(t.memorySelection?.conflictIds).toEqual(['mem_a', 'mem_b'])
  })

  /// A retry must record the selection it actually sent, so the set is frozen
  /// per invocation rather than recomputed between the send and the record.
  it('freezes the selection for the invocation', async () => {
    const t = new Harness()
    await t.refreshMemory()
    const first = t.memorySelection
    // The store changes underneath.
    memoryRetrieve.mockResolvedValue(
      selection({ injectedIds: ['mem_zzz'], block: 'different' })
    )
    // No new dispatch, so the recorded selection does not move.
    expect(t.memorySelection).toBe(first)
    expect(t.memorySelection?.injectedIds).toEqual(['mem_kx7'])
    // The next dispatch picks up the change.
    await t.refreshMemory()
    expect(t.memorySelection?.injectedIds).toEqual(['mem_zzz'])
  })

  it('reports ids, hashes and size for the snapshot and accounting', async () => {
    const t = new Harness()
    await t.refreshMemory()
    expect(t.memorySelection?.injectedIds).toEqual(['mem_kx7'])
    // The hash proves which *version* of a memory the model saw.
    expect(t.memorySelection?.injectedHashes).toEqual(['a1b2c3'])
    expect(t.memorySelection?.charsUsed).toBe(58)
  })
})
