/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Split conversations: two panes, two threads, nothing shared.
 *
 * The route is rendered for real with the conversation machinery stubbed at
 * the same seams the single-thread route test uses. The composer stub reads
 * and writes the real prompt store through the `draftScope` the route hands
 * it, and the chat hook stub answers per session id, so what is asserted is
 * the route's wiring: which thread, draft, stream, model and focus each pane
 * gets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => {
  const sessions: Record<
    string,
    { status: string; stop: ReturnType<typeof vi.fn>; messages: any[] }
  > = {}
  const capturedChat: Record<string, any> = {}
  const mounts: Record<string, number> = {}

  const threadsState: any = {
    threads: {},
    currentThreadId: undefined,
    setCurrentThreadId: vi.fn((id?: string) => {
      threadsState.currentThreadId = id
    }),
    updateThread: vi.fn(),
  }
  const useThreadsMock: any = (selector: any) => selector(threadsState)
  useThreadsMock.getState = () => threadsState

  const messagesState: any = {
    messages: {},
    setMessages: vi.fn(),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    getMessages: vi.fn(() => []),
  }
  const useMessagesMock: any = (selector: any) => selector(messagesState)
  useMessagesMock.getState = () => messagesState

  const appStateState: any = {
    ragToolNames: new Set<string>(),
    mcpToolNames: new Set<string>(),
    tools: [],
    oomError: undefined,
    backendError: undefined,
    setOomError: vi.fn(),
    setBackendError: vi.fn(),
    embeddingThreads: {},
    setThreadBusy: vi.fn(),
    setThreadEmbedding: vi.fn(),
  }
  const useAppStateMock: any = (selector: any) => selector(appStateState)
  useAppStateMock.getState = () => appStateState

  const modelOf = (id: string) => ({ id, capabilities: ['tools'], settings: {} })
  const providers: Record<string, any> = {
    openai: { provider: 'openai', models: [modelOf('model-a')] },
    anthropic: { provider: 'anthropic', models: [modelOf('model-b')] },
  }
  const modelProviderState: any = {
    selectedModel: modelOf('model-a'),
    selectedProvider: 'openai',
    providers: Object.values(providers),
    getProviderByName: vi.fn((name: string) => providers[name]),
    updateProvider: vi.fn(),
  }
  const useModelProviderMock: any = (selector: any) =>
    selector(modelProviderState)
  useModelProviderMock.getState = () => modelProviderState

  const chatSessionsState: any = {
    sessions: {},
    dataById: {} as Record<string, { tools: unknown[] }>,
    getSessionData: vi.fn((id: string) => {
      chatSessionsState.dataById[id] ??= { tools: [] }
      return chatSessionsState.dataById[id]
    }),
  }
  const useChatSessionsMock: any = (selector: any) =>
    selector(chatSessionsState)
  useChatSessionsMock.getState = () => chatSessionsState

  const attachmentsState: any = {
    getAttachments: vi.fn(() => []),
    clearAttachments: vi.fn(),
  }
  const useChatAttachmentsMock: any = (selector: any) =>
    selector(attachmentsState)
  useChatAttachmentsMock.getState = () => attachmentsState

  const plain = (state: any) => {
    const hook: any = (selector: any) => selector(state)
    hook.getState = () => state
    return hook
  }

  return {
    sessions,
    capturedChat,
    mounts,
    threadsState,
    useThreadsMock,
    messagesState,
    useMessagesMock,
    appStateState,
    useAppStateMock,
    modelProviderState,
    useModelProviderMock,
    chatSessionsState,
    useChatSessionsMock,
    useChatAttachmentsMock,
    useAttachmentsMock: plain({ enabled: true, parseMode: 'auto' }),
    useToolAvailableMock: plain({ disabledTools: [] }),
    toolApprovalState: {
      approveToolForThread: vi.fn(),
      clearPendingForThread: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
    } as any,
    messageQueueState: { dequeue: vi.fn(() => null), clearQueue: vi.fn() },
  }
})

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/threads/$threadId' }),
  useParams: () => ({ threadId: 'thread-a' }),
  useSearch: () => ({ threadModel: undefined }),
  useNavigate: () => vi.fn(),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => <div data-testid="header-page">{children}</div>,
}))

vi.mock('@/containers/DropdownModelProvider', () => ({
  default: ({ model }: any) => (
    <div data-testid="model-dropdown">{model ? model.id : 'no-model'}</div>
  ),
}))

// A composer that does what ChatInput does with the props under test: its
// draft lives in the prompt store under `draftScope`, and Stop calls onStop.
vi.mock('@/containers/ChatInput', async () => {
  const { usePrompt } = await import('@/hooks/usePrompt')
  const { useEffect } = await import('react')
  return {
    default: ({ threadId, draftScope, onStop, chatStatus, takeFocus }: any) => {
      useEffect(() => {
        h.mounts[threadId] = (h.mounts[threadId] ?? 0) + 1
      }, [threadId])
      const prompt = usePrompt((s) =>
        draftScope ? (s.scoped[draftScope]?.prompt ?? '') : s.prompt
      )
      return (
        <div data-testid={`composer-${threadId}`} data-take-focus={takeFocus}>
          <textarea
            aria-label={`composer ${threadId}`}
            data-testid={`input-${threadId}`}
            value={prompt}
            onChange={(e) =>
              draftScope
                ? usePrompt.getState().setScopedPrompt(draftScope, e.target.value)
                : usePrompt.getState().setPrompt(e.target.value)
            }
          />
          <span data-testid={`status-${threadId}`}>{chatStatus}</span>
          <button data-testid={`stop-${threadId}`} onClick={() => onStop()}>
            stop
          </button>
        </div>
      )
    },
  }
})

vi.mock('@/containers/MessageItem', () => ({
  MessageItem: ({ message }: any) => <div data-testid={`message-${message.id}`} />,
}))
vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: any) => <div>{children}</div>,
  ConversationContent: ({ children }: any) => <div>{children}</div>,
  ConversationScrollButton: () => null,
}))
vi.mock('@/components/ai-elements/shimmer', () => ({
  Shimmer: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('@/components/PromptProgress', () => ({ PromptProgress: () => null }))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...rest }: any) => (
    <button
      onClick={onClick}
      aria-label={rest['aria-label']}
      data-testid={rest['data-testid']}
    >
      {children}
    </button>
  ),
}))
vi.mock('@/containers/WhatJanIsUsing', () => ({
  WhatJanIsUsing: () => null,
  WhatJanIsUsingToggle: () => null,
  WhatJanIsUsingPanel: () => null,
}))
vi.mock('@/containers/TemporaryChatBanner', () => ({
  TemporaryChatBanner: () => null,
}))
vi.mock('@/containers/MemoryProposalCard', () => ({
  MemoryProposalList: () => null,
}))
vi.mock('@/hooks/useMemoryProposals', () => ({
  useMemoryProposals: () => ({
    proposals: [],
    location: undefined,
    reload: vi.fn(),
    onResolved: vi.fn(),
  }),
}))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => undefined }) },
}))
vi.mock('ai', () => ({
  generateId: () => 'gen-id',
  lastAssistantMessageIsCompleteWithToolCalls: () => false,
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: any) => fn }))

vi.mock('@/hooks/use-chat', () => ({
  useChat: (args: any) => {
    h.capturedChat[args.sessionId] = args
    const session = h.sessions[args.sessionId]
    return {
      messages: session.messages,
      status: session.status,
      error: null,
      sendMessage: vi.fn(),
      regenerate: vi.fn(),
      setMessages: vi.fn(),
      stop: session.stop,
      addToolOutput: vi.fn(),
      updateRagToolsAvailability: vi.fn(),
      setContinueFromContent: vi.fn(),
    }
  },
}))

vi.mock('@/hooks/useThreads', () => ({ useThreads: h.useThreadsMock }))
vi.mock('@/hooks/useMessages', () => ({ useMessages: h.useMessagesMock }))
vi.mock('@/hooks/useTools', () => ({ useTools: vi.fn() }))
vi.mock('@/hooks/useAppState', () => ({ useAppState: h.useAppStateMock }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: h.useModelProviderMock,
}))
vi.mock('@/stores/chat-session-store', () => ({
  useChatSessions: h.useChatSessionsMock,
}))
vi.mock('@/hooks/useChatAttachments', () => ({
  useChatAttachments: h.useChatAttachmentsMock,
  NEW_THREAD_ATTACHMENT_KEY: '__new-thread__',
}))
vi.mock('@/hooks/useAttachments', () => ({ useAttachments: h.useAttachmentsMock }))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: h.useToolAvailableMock,
}))
vi.mock('@/hooks/useToolApproval', () => ({
  useToolApproval: Object.assign((s: any) => s(h.toolApprovalState), {
    getState: () => h.toolApprovalState,
  }),
}))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: Object.assign((s: any) => s(h.toolApprovalState), {
    getState: () => h.toolApprovalState,
  }),
}))
vi.mock('@/stores/message-queue-store', () => ({
  useMessageQueue: Object.assign(() => undefined, {
    getState: () => h.messageQueueState,
  }),
}))
vi.mock('@/hooks/useAutoScroll', () => ({
  useAutoScroll: () => ({
    containerRef: { current: null },
    isAtBottom: true,
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
    forceScrollToBottom: vi.fn(),
    reset: vi.fn(),
  }),
}))
// The breakpoint, switchable mid-test without remounting anything.
vi.mock('@/hooks/useMediaQuery', async () => {
  const { create } = await import('zustand')
  const media = create<{ wide: boolean }>(() => ({ wide: false }))
  return {
    __media: media,
    useMediaQuery: () => media((s) => s.wide),
  }
})

import { Route } from '../$threadId'
import { usePrompt } from '@/hooks/usePrompt'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import * as mediaModule from '@/hooks/useMediaQuery'

const media = (mediaModule as any).__media as {
  setState: (s: { wide: boolean }) => void
}

const renderRoute = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

const pane = (id: 'primary' | 'secondary') =>
  screen.getByTestId(`conversation-pane-${id}`)

describe('split conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(h.mounts)) delete h.mounts[key]
    h.sessions['thread-a'] = { status: 'streaming', stop: vi.fn(), messages: [] }
    h.sessions['thread-b'] = { status: 'streaming', stop: vi.fn(), messages: [] }
    h.threadsState.currentThreadId = undefined
    h.threadsState.threads = {
      'thread-a': {
        id: 'thread-a',
        title: 'Alpha',
        metadata: {},
        assistants: [],
        model: { id: 'model-a', provider: 'openai' },
        updated: 2,
      },
      'thread-b': {
        id: 'thread-b',
        title: 'Beta',
        metadata: {},
        assistants: [],
        model: { id: 'model-b', provider: 'anthropic' },
        updated: 1,
      },
    }
    usePrompt.setState({
      prompt: '',
      historyIndex: -1,
      draftPrompt: '',
      promptHistory: [],
      scoped: {},
    })
    useSplitConversation.setState({
      open: true,
      secondaryThreadId: 'thread-b',
      activePane: 'primary',
      ratio: 0.5,
    })
    media.setState({ wide: false })
  })

  it('renders each pane as its own conversation with its own thread', () => {
    renderRoute()
    expect(
      within(pane('primary')).getByTestId('composer-thread-a')
    ).toBeInTheDocument()
    expect(
      within(pane('secondary')).getByTestId('composer-thread-b')
    ).toBeInTheDocument()
    // Each pane opened the chat session of its own thread.
    expect(h.capturedChat['thread-a'].sessionId).toBe('thread-a')
    expect(h.capturedChat['thread-b'].sessionId).toBe('thread-b')
  })

  it('typing in one pane does not change the other', () => {
    renderRoute()
    fireEvent.change(screen.getByTestId('input-thread-b'), {
      target: { value: 'question for beta' },
    })
    expect(screen.getByTestId('input-thread-b')).toHaveValue('question for beta')
    expect(screen.getByTestId('input-thread-a')).toHaveValue('')

    fireEvent.change(screen.getByTestId('input-thread-a'), {
      target: { value: 'question for alpha' },
    })
    expect(screen.getByTestId('input-thread-a')).toHaveValue('question for alpha')
    expect(screen.getByTestId('input-thread-b')).toHaveValue('question for beta')
    expect(usePrompt.getState().prompt).toBe('question for alpha')
    expect(usePrompt.getState().scoped['split:secondary'].prompt).toBe(
      'question for beta'
    )
  })

  it('stopping one pane leaves the other streaming', () => {
    renderRoute()
    fireEvent.click(screen.getByTestId('stop-thread-a'))
    expect(h.sessions['thread-a'].stop).toHaveBeenCalledTimes(1)
    expect(h.sessions['thread-b'].stop).not.toHaveBeenCalled()
    expect(screen.getByTestId('status-thread-b')).toHaveTextContent('streaming')
  })

  it('each pane sends with, and shows, its own model', () => {
    renderRoute()
    expect(
      within(pane('primary')).getByTestId('model-dropdown')
    ).toHaveTextContent('model-a')
    expect(
      within(pane('secondary')).getByTestId('model-dropdown')
    ).toHaveTextContent('model-b')

    const resolveA = h.capturedChat['thread-a'].resolveModelSelection
    const resolveB = h.capturedChat['thread-b'].resolveModelSelection
    expect(resolveA().selectedModel.id).toBe('model-a')
    expect(resolveB().selectedModel.id).toBe('model-b')
    expect(resolveB().selectedProvider).toBe('anthropic')
  })

  it('makes only the active pane the current thread, and moves it on switch', () => {
    renderRoute()
    expect(h.threadsState.setCurrentThreadId).toHaveBeenCalledWith('thread-a')
    expect(h.threadsState.setCurrentThreadId).not.toHaveBeenCalledWith(
      'thread-b'
    )
    expect(screen.getByTestId('composer-thread-a')).toHaveAttribute(
      'data-take-focus',
      'true'
    )
    expect(screen.getByTestId('composer-thread-b')).toHaveAttribute(
      'data-take-focus',
      'false'
    )

    fireEvent.click(screen.getByTestId('split-pane-tab-secondary'))
    expect(h.threadsState.setCurrentThreadId).toHaveBeenLastCalledWith(
      'thread-b'
    )
    expect(screen.getByTestId('split-pane-tab-secondary')).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('shows one pane at a time below 1100px and says when the other is replying', () => {
    h.chatSessionsState.sessions = {
      'thread-b': { isStreaming: true, chat: { messages: [] } },
    }
    try {
      renderRoute()
      expect(pane('primary')).not.toHaveClass('invisible')
      expect(pane('secondary')).toHaveClass('invisible')
      expect(pane('secondary')).toHaveAttribute('aria-hidden', 'true')
      expect(screen.getByTestId('split-pane-tab-secondary')).toHaveAttribute(
        'data-streaming',
        'true'
      )
      expect(
        within(screen.getByTestId('split-pane-tab-secondary')).getByText(
          'chat:split.streaming'
        )
      ).toBeInTheDocument()
    } finally {
      h.chatSessionsState.sessions = {}
    }
  })

  it('switching panes and crossing the breakpoint keep both conversations mounted', () => {
    renderRoute()
    fireEvent.change(screen.getByTestId('input-thread-b'), {
      target: { value: 'kept draft' },
    })
    fireEvent.click(screen.getByTestId('split-pane-tab-secondary'))
    fireEvent.click(screen.getByTestId('split-pane-tab-primary'))
    act(() => media.setState({ wide: true }))
    act(() => media.setState({ wide: false }))

    expect(h.mounts['thread-a']).toBe(1)
    expect(h.mounts['thread-b']).toBe(1)
    expect(screen.getByTestId('input-thread-b')).toHaveValue('kept draft')
  })

  it('sits side by side at 1100px with a divider the keyboard can move', () => {
    media.setState({ wide: true })
    renderRoute()
    expect(pane('primary')).not.toHaveClass('invisible')
    expect(pane('secondary')).not.toHaveClass('invisible')
    expect(pane('primary')).toHaveStyle({ width: '50%' })

    const divider = screen.getByRole('separator')
    expect(divider).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(useSplitConversation.getState().ratio).toBeCloseTo(0.52)
    fireEvent.keyDown(divider, { key: 'End' })
    expect(divider).toHaveAttribute('aria-valuenow', '70')
  })

  it('never opens the same thread in both panes', () => {
    useSplitConversation.setState({ secondaryThreadId: 'thread-a' })
    renderRoute()
    expect(screen.getAllByTestId('composer-thread-a')).toHaveLength(1)
    expect(screen.getByTestId('split-pane-picker')).toBeInTheDocument()
  })

  it('opens a recent conversation from the picker in the second pane', () => {
    useSplitConversation.setState({ secondaryThreadId: undefined })
    renderRoute()
    fireEvent.click(screen.getByTestId('split-pick-thread-b'))
    expect(useSplitConversation.getState().secondaryThreadId).toBe('thread-b')
    expect(
      within(pane('secondary')).getByTestId('composer-thread-b')
    ).toBeInTheDocument()
  })

  it('closing the split keeps the main conversation as it was', () => {
    renderRoute()
    fireEvent.change(screen.getByTestId('input-thread-a'), {
      target: { value: 'main draft' },
    })
    fireEvent.click(screen.getByTestId('split-conversation-close'))

    expect(screen.queryByTestId('composer-thread-b')).toBeNull()
    expect(h.mounts['thread-a']).toBe(1)
    expect(screen.getByTestId('input-thread-a')).toHaveValue('main draft')
    // Back to one conversation: the Split action is offered again.
    expect(screen.getByTestId('split-conversation-open')).toBeInTheDocument()
  })
})
