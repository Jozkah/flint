/**
 * The state split conversations rely on to keep two panes apart.
 *
 * Each test names the thing that used to be global and proves the keyed
 * version keeps one conversation's state out of the other's, while the
 * unkeyed path behaves exactly as before.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { usePrompt } from '@/hooks/usePrompt'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import {
  PANE_MIN_SHARE,
  PRIMARY_PANE,
  SPLIT_DEFAULT_MAX_PANES,
  clampMaxPanes,
  migrateSplitState,
  moveDivider,
  normalizeSizes,
  paneDraftScope,
  SECONDARY_DRAFT_SCOPE,
  useSplitConversation,
} from '@/hooks/useSplitConversation'
import { resolveThreadModelSelection } from '@/hooks/useConversationPane'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { CustomChatTransport } from '@/lib/custom-chat-transport'

const model = (id: string) => ({ id, capabilities: [], settings: {} }) as never

describe('prompt drafts per composer', () => {
  beforeEach(() => {
    usePrompt.setState({
      prompt: '',
      historyIndex: -1,
      draftPrompt: '',
      promptHistory: [],
      scoped: {},
    })
  })

  it('keeps a scoped draft apart from the main draft', () => {
    usePrompt.getState().setPrompt('main pane text')
    usePrompt.getState().setScopedPrompt('split:secondary', 'second pane text')

    expect(usePrompt.getState().prompt).toBe('main pane text')
    expect(usePrompt.getState().scoped['split:secondary'].prompt).toBe(
      'second pane text'
    )

    usePrompt.getState().setPrompt('main pane edited')
    expect(usePrompt.getState().scoped['split:secondary'].prompt).toBe(
      'second pane text'
    )
  })

  it('walks the shared history from each draft without moving the other', () => {
    usePrompt.getState().addToHistory('older')
    usePrompt.getState().addToHistory('newer')
    usePrompt.getState().setPrompt('main draft')
    usePrompt.getState().setScopedPrompt('split:secondary', 'second draft')

    usePrompt.getState().navigateScopedHistory('split:secondary', 'up')
    expect(usePrompt.getState().scoped['split:secondary'].prompt).toBe('newer')
    // The main composer did not move.
    expect(usePrompt.getState().prompt).toBe('main draft')
    expect(usePrompt.getState().historyIndex).toBe(-1)

    usePrompt.getState().navigateScopedHistory('split:secondary', 'down')
    expect(usePrompt.getState().scoped['split:secondary'].prompt).toBe(
      'second draft'
    )
  })
})

describe('tool call runtime', () => {
  beforeEach(() => useToolCallRuntime.getState().reset())

  it('forgets one conversation’s calls and keeps the other’s', () => {
    const runtime = useToolCallRuntime.getState()
    runtime.enqueue(['a1', 'b1'])
    runtime.markRunning('a1')
    runtime.recordDiff('a1', 'diff a')
    runtime.recordDiff('b1', 'diff b')

    useToolCallRuntime.getState().forget(['a1'])

    const after = useToolCallRuntime.getState()
    expect(after.timings.a1).toBeUndefined()
    expect(after.diffs.a1).toBeUndefined()
    expect(after.timings.b1).toBeDefined()
    expect(after.diffs.b1).toBe('diff b')
    expect(after.queue).toEqual(['b1'])
  })
})

describe('split view store', () => {
  beforeEach(() => {
    useSplitConversation.setState({
      panes: [],
      sizes: [1],
      activePane: PRIMARY_PANE,
      maxPanes: SPLIT_DEFAULT_MAX_PANES,
    })
  })

  const store = () => useSplitConversation.getState()

  it('opens more than two panes, each active as it opens', () => {
    expect(store().addPane({ kind: 'chat', refId: 'thread-b' })).toBe('added')
    expect(store().addPane({ kind: 'cowork', refId: 'session-1' })).toBe(
      'added'
    )
    expect(store().addPane({ kind: 'chat', refId: 'thread-c' })).toBe('added')
    const { panes, sizes, activePane } = store()
    expect(panes.map((p) => p.refId)).toEqual([
      'thread-b',
      'session-1',
      'thread-c',
    ])
    expect(panes[1].kind).toBe('cowork')
    expect(activePane).toBe(panes[2].id)
    // Four panes share the width equally.
    expect(sizes).toHaveLength(4)
    for (const share of sizes) expect(share).toBeCloseTo(0.25)
  })

  it('stops at the cap, which counts the main pane', () => {
    store().addPane({ kind: 'chat', refId: 'b' })
    store().addPane({ kind: 'chat', refId: 'c' })
    store().addPane({ kind: 'chat', refId: 'd' })
    expect(store().addPane({ kind: 'chat', refId: 'e' })).toBe('full')
    expect(store().panes).toHaveLength(3)

    store().setMaxPanes(5)
    expect(store().addPane({ kind: 'chat', refId: 'e' })).toBe('added')
    // Lowering the cap closes the panes that no longer fit.
    store().setMaxPanes(2)
    expect(store().panes.map((p) => p.refId)).toEqual(['b'])
    expect(clampMaxPanes(99)).toBe(6)
    expect(clampMaxPanes('x')).toBe(SPLIT_DEFAULT_MAX_PANES)
  })

  it('shows a conversation once: asking again focuses its pane', () => {
    store().addPane({ kind: 'chat', refId: 'thread-b' })
    const first = store().panes[0].id
    store().addPane({ kind: 'chat', refId: 'thread-c' })
    expect(store().addPane({ kind: 'chat', refId: 'thread-b' })).toBe('shown')
    expect(store().panes).toHaveLength(2)
    expect(store().activePane).toBe(first)
  })

  it('fills an empty pane before opening another', () => {
    store().addPane()
    const empty = store().panes[0]
    expect(empty.refId).toBeUndefined()
    expect(store().addPane({ kind: 'cowork', refId: 'session-1' })).toBe(
      'filled'
    )
    expect(store().panes).toEqual([
      { id: empty.id, kind: 'cowork', refId: 'session-1' },
    ])
  })

  it('closing a pane gives its width to its neighbour and its focus back', () => {
    store().addPane({ kind: 'chat', refId: 'b' })
    store().addPane({ kind: 'chat', refId: 'c' })
    const [b, c] = store().panes
    store().closePane(c.id)
    expect(store().panes).toEqual([b])
    expect(store().activePane).toBe(b.id)
    expect(store().sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1)
    expect(store().sizes[1]).toBeCloseTo(2 / 3)

    store().closeAll()
    expect(store().panes).toEqual([])
    expect(store().activePane).toBe(PRIMARY_PANE)
  })

  it('keeps every pane at least a minimum share when a divider moves', () => {
    const moved = moveDivider([0.5, 0.5], 0, 0.9)
    expect(moved[1]).toBeCloseTo(PANE_MIN_SHARE)
    expect(moved[0] + moved[1]).toBeCloseTo(1)
    expect(normalizeSizes([0.2, 0.3], 3)).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(normalizeSizes('junk', 2)).toEqual([0.5, 0.5])
  })

  it('gives each extra pane its own draft scope', () => {
    expect(paneDraftScope(PRIMARY_PANE)).toBeUndefined()
    expect(paneDraftScope('pane-1')).toBe('split:pane-1')
    expect(paneDraftScope('pane-2')).not.toBe(paneDraftScope('pane-1'))
    // The migrated second pane keeps the draft it had.
    expect(paneDraftScope('secondary')).toBe(SECONDARY_DRAFT_SCOPE)
  })
})

describe('split view persistence', () => {
  it('migrates an open two-pane split', () => {
    expect(
      migrateSplitState(
        { open: true, secondaryThreadId: 'thread-b', ratio: 0.6 },
        0
      )
    ).toEqual({
      panes: [{ id: 'secondary', kind: 'chat', refId: 'thread-b' }],
      sizes: [expect.closeTo(0.6), expect.closeTo(0.4)],
      maxPanes: SPLIT_DEFAULT_MAX_PANES,
    })
  })

  it('migrates a closed split to a single pane', () => {
    expect(
      migrateSplitState({ open: false, secondaryThreadId: 'thread-b' }, 0)
    ).toEqual({ panes: [], sizes: [1], maxPanes: SPLIT_DEFAULT_MAX_PANES })
  })

  it('drops what it cannot read and repairs the widths', () => {
    const state = migrateSplitState(
      {
        panes: [
          { id: 'a', kind: 'chat', refId: 't1' },
          { id: 'primary', kind: 'chat' },
          { id: 'b', kind: 'mystery' },
          { id: 'c', kind: 'cowork', refId: 's1' },
        ],
        sizes: [1],
        maxPanes: 4,
      },
      1
    )
    expect(state.panes.map((p) => p.id)).toEqual(['a', 'c'])
    expect(state.sizes).toHaveLength(3)
  })

  it('round-trips the layout through storage', async () => {
    const storage = new Map<string, string>()
    const backend = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    }
    useSplitConversation.persist.setOptions({
      storage: {
        getItem: (k) => {
          const v = backend.getItem(k)
          return v ? JSON.parse(v) : null
        },
        setItem: (k, v) => backend.setItem(k, JSON.stringify(v)),
        removeItem: (k) => backend.removeItem(k),
      },
    })
    const name = useSplitConversation.persist.getOptions().name!
    // What the two-pane split left behind.
    backend.setItem(
      name,
      JSON.stringify({
        state: { open: true, secondaryThreadId: 'thread-b', ratio: 0.5 },
        version: 0,
      })
    )
    await useSplitConversation.persist.rehydrate()
    expect(store2().panes).toEqual([
      { id: 'secondary', kind: 'chat', refId: 'thread-b' },
    ])

    store2().addPane({ kind: 'cowork', refId: 'session-1' })
    const saved = JSON.parse(backend.getItem(name)!)
    expect(saved.version).toBe(1)
    expect(saved.state.panes).toHaveLength(2)
    expect(saved.state.activePane).toBeUndefined()

    useSplitConversation.setState({ panes: [], sizes: [1] })
    backend.setItem(name, JSON.stringify(saved))
    await useSplitConversation.persist.rehydrate()
    expect(store2().panes.map((p) => p.refId)).toEqual([
      'thread-b',
      'session-1',
    ])
  })

  const store2 = () => useSplitConversation.getState()
})

describe('model per conversation', () => {
  beforeEach(() => {
    useModelProvider.setState({
      selectedProvider: 'openai',
      selectedModel: model('global-model'),
      providers: [
        {
          provider: 'openai',
          active: true,
          models: [model('model-a'), model('global-model')],
        },
        { provider: 'anthropic', active: true, models: [model('model-b')] },
      ] as never,
    })
    useThreads.setState({
      currentThreadId: 'thread-a',
      threads: {
        'thread-a': {
          id: 'thread-a',
          title: 'A',
          model: { id: 'model-a', provider: 'openai' },
        },
        'thread-b': {
          id: 'thread-b',
          title: 'B',
          model: { id: 'model-b', provider: 'anthropic' },
        },
        'thread-gone': {
          id: 'thread-gone',
          title: 'Gone',
          model: { id: 'removed', provider: 'openai' },
        },
      } as never,
    })
  })

  it('resolves each thread to its own model, not the global picker', () => {
    const a = resolveThreadModelSelection('thread-a')
    const b = resolveThreadModelSelection('thread-b')
    expect(a.selectedModel?.id).toBe('model-a')
    expect(a.selectedProvider).toBe('openai')
    expect(b.selectedModel?.id).toBe('model-b')
    expect(b.selectedProvider).toBe('anthropic')
  })

  it('falls back to the global picker when a thread’s model is gone', () => {
    const gone = resolveThreadModelSelection('thread-gone')
    expect(gone.selectedModel?.id).toBe('global-model')
  })

  it('lets a transport send with a pane’s model, and go back to the global one', () => {
    const transport = new CustomChatTransport(undefined, 'thread-b')
    const selection = () =>
      (
        transport as unknown as {
          getModelSelection: () => { selectedModel: { id: string } | null }
        }
      ).getModelSelection()

    expect(selection().selectedModel?.id).toBe('global-model')
    transport.setModelSelectionResolver(() =>
      resolveThreadModelSelection('thread-b')
    )
    expect(selection().selectedModel?.id).toBe('model-b')
    transport.setModelSelectionResolver(undefined)
    expect(selection().selectedModel?.id).toBe('global-model')
  })

  it('records a model on the named thread, not the current one', () => {
    useThreads
      .getState()
      .updateThreadModel('thread-b', { id: 'model-a', provider: 'openai' })
    const { threads } = useThreads.getState()
    expect(threads['thread-b'].model).toEqual({
      id: 'model-a',
      provider: 'openai',
    })
    expect(threads['thread-a'].model).toEqual({
      id: 'model-a',
      provider: 'openai',
    })
  })

  it('still records on the current thread through the old entry point', () => {
    useThreads
      .getState()
      .updateCurrentThreadModel({ id: 'model-b', provider: 'anthropic' })
    const { threads } = useThreads.getState()
    expect(threads['thread-a'].model).toEqual({
      id: 'model-b',
      provider: 'anthropic',
    })
    expect(threads['thread-b'].model).toEqual({
      id: 'model-b',
      provider: 'anthropic',
    })
  })
})
