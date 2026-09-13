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
  SPLIT_DEFAULT_RATIO,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  clampSplitRatio,
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

describe('split conversation store', () => {
  beforeEach(() => {
    useSplitConversation.setState({
      open: false,
      secondaryThreadId: undefined,
      activePane: 'primary',
      ratio: SPLIT_DEFAULT_RATIO,
    })
  })

  it('keeps the width share within its limits', () => {
    expect(clampSplitRatio(0.1)).toBe(SPLIT_MIN_RATIO)
    expect(clampSplitRatio(0.95)).toBe(SPLIT_MAX_RATIO)
    expect(clampSplitRatio('nonsense')).toBe(SPLIT_DEFAULT_RATIO)
    useSplitConversation.getState().setRatio(2)
    expect(useSplitConversation.getState().ratio).toBe(SPLIT_MAX_RATIO)
  })

  it('returns to the main pane when the split closes', () => {
    const split = useSplitConversation.getState()
    split.openSplit()
    split.setSecondaryThread('thread-b')
    split.setActivePane('secondary')
    useSplitConversation.getState().closeSplit()
    const after = useSplitConversation.getState()
    expect(after.open).toBe(false)
    expect(after.activePane).toBe('primary')
    // The second pane's conversation is remembered for next time.
    expect(after.secondaryThreadId).toBe('thread-b')
  })
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
