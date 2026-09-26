/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Split view: several panes, several threads, nothing shared.
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
    busyThreads: {},
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
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
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
// The panes' width, switchable mid-test without remounting anything.
vi.mock('@/hooks/useElementWidth', async () => {
  const { create } = await import('zustand')
  const width = create<{ px: number }>(() => ({ px: 800 }))
  return {
    __width: width,
    useElementWidth: () => width((s) => s.px),
  }
})

import { Route } from '../$threadId'
import { usePrompt } from '@/hooks/usePrompt'
import {
  PRIMARY_PANE,
  useSplitConversation,
} from '@/hooks/useSplitConversation'
import * as widthModule from '@/hooks/useElementWidth'
import { SplitWorkspace } from '@/containers/SplitConversation'
import { usePaneWidth } from '@/hooks/useCoworkPane'

const width = (widthModule as any).__width as {
  setState: (s: { px: number }) => void
}

const renderRoute = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

const pane = (id: string) => screen.getByTestId(`conversation-pane-${id}`)

const split = () => useSplitConversation.getState()

describe('split view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(h.mounts)) delete h.mounts[key]
    for (const id of ['thread-a', 'thread-b', 'thread-c', 'thread-d']) {
      h.sessions[id] = { status: 'streaming', stop: vi.fn(), messages: [] }
    }
    h.threadsState.currentThreadId = undefined
    const thread = (id: string, title: string, model: string, provider: string, updated: number) => ({
      id,
      title,
      metadata: {},
      assistants: [],
      model: { id: model, provider },
      updated,
    })
    h.threadsState.threads = {
      'thread-a': thread('thread-a', 'Alpha', 'model-a', 'openai', 4),
      'thread-b': thread('thread-b', 'Beta', 'model-b', 'anthropic', 3),
      'thread-c': thread('thread-c', 'Gamma', 'model-a', 'openai', 2),
      'thread-d': thread('thread-d', 'Delta', 'model-a', 'openai', 1),
    }
    usePrompt.setState({
      prompt: '',
      historyIndex: -1,
      draftPrompt: '',
      promptHistory: [],
      scoped: {},
    })
    useSplitConversation.setState({
      panes: [{ id: 'secondary', kind: 'chat', refId: 'thread-b' }],
      sizes: [0.5, 0.5],
      activePane: PRIMARY_PANE,
      maxPanes: 4,
    })
    width.setState({ px: 800 })
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
    // The pane migrated from the two-pane split keeps its old draft scope.
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
    expect(pane('secondary')).toHaveAttribute('data-active', 'true')
    expect(pane('primary')).toHaveAttribute('data-active', 'false')
  })

  it('opens more than two panes, each with its own conversation and draft', () => {
    width.setState({ px: 2000 })
    act(() => {
      split().addPane({ kind: 'chat', refId: 'thread-c' })
      split().addPane({ kind: 'chat', refId: 'thread-d' })
    })
    renderRoute()
    const ids = split().panes.map((p) => p.id)
    expect(ids).toHaveLength(3)
    expect(screen.getByTestId('conversation-panes')).toHaveAttribute(
      'data-layout',
      'columns'
    )
    for (const [paneId, threadId] of [
      [ids[1], 'thread-c'],
      [ids[2], 'thread-d'],
    ]) {
      expect(
        within(pane(paneId)).getByTestId(`composer-${threadId}`)
      ).toBeInTheDocument()
    }
    fireEvent.change(screen.getByTestId('input-thread-c'), {
      target: { value: 'for gamma' },
    })
    fireEvent.change(screen.getByTestId('input-thread-d'), {
      target: { value: 'for delta' },
    })
    expect(screen.getByTestId('input-thread-c')).toHaveValue('for gamma')
    expect(screen.getByTestId('input-thread-d')).toHaveValue('for delta')
    expect(screen.getByTestId('input-thread-a')).toHaveValue('')
    expect(screen.getByTestId('input-thread-b')).toHaveValue('')
    // Three dividers between four panes.
    expect(screen.getAllByRole('separator')).toHaveLength(3)
    // At the cap the Add pane action stands down.
    expect(split().addPane()).toBe('full')

    fireEvent.click(screen.getByTestId('stop-thread-c'))
    expect(h.sessions['thread-c'].stop).toHaveBeenCalledTimes(1)
    expect(h.sessions['thread-d'].stop).not.toHaveBeenCalled()
  })

  it('adds an empty pane from the Add pane action and fills it from the picker', () => {
    renderRoute()
    fireEvent.click(screen.getByTestId('split-add-pane'))
    const added = split().panes[1]
    expect(added.refId).toBeUndefined()
    expect(
      within(pane(added.id)).getByTestId('split-pane-picker')
    ).toBeInTheDocument()
    // Conversations already on screen are not offered again.
    expect(
      within(pane(added.id)).queryByTestId('split-pick-thread-a')
    ).toBeNull()
    expect(
      within(pane(added.id)).queryByTestId('split-pick-thread-b')
    ).toBeNull()
    fireEvent.click(within(pane(added.id)).getByTestId('split-pick-thread-c'))
    expect(split().panes[1].refId).toBe('thread-c')
    expect(
      within(pane(added.id)).getByTestId('composer-thread-c')
    ).toBeInTheDocument()
  })

  it('closes one pane and leaves the others running', () => {
    act(() => {
      split().addPane({ kind: 'chat', refId: 'thread-c' })
    })
    renderRoute()
    fireEvent.change(screen.getByTestId('input-thread-c'), {
      target: { value: 'kept' },
    })
    fireEvent.click(screen.getByTestId('split-pane-close-secondary'))
    expect(screen.queryByTestId('composer-thread-b')).toBeNull()
    expect(split().panes.map((p) => p.refId)).toEqual(['thread-c'])
    expect(screen.getByTestId('input-thread-c')).toHaveValue('kept')
    expect(h.mounts['thread-a']).toBe(1)
    expect(h.mounts['thread-c']).toBe(1)
  })

  it('shows one pane at a time when they do not fit, and says when another is replying', () => {
    h.chatSessionsState.sessions = {
      'thread-b': { isStreaming: true, chat: { messages: [] } },
    }
    try {
      renderRoute()
      expect(screen.getByTestId('conversation-panes')).toHaveAttribute(
        'data-layout',
        'tabs'
      )
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

  it('turns extra panes into tabs below the minimum width per pane', () => {
    act(() => {
      split().addPane({ kind: 'chat', refId: 'thread-c' })
    })
    // Room for two panes of 420px, not three.
    width.setState({ px: 1000 })
    renderRoute()
    expect(screen.getByTestId('conversation-panes')).toHaveAttribute(
      'data-layout',
      'tabs'
    )
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
    act(() => width.setState({ px: 1300 }))
    expect(screen.getByTestId('conversation-panes')).toHaveAttribute(
      'data-layout',
      'columns'
    )
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('switching panes and crossing the width threshold keep every conversation mounted', () => {
    renderRoute()
    fireEvent.change(screen.getByTestId('input-thread-b'), {
      target: { value: 'kept draft' },
    })
    fireEvent.click(screen.getByTestId('split-pane-tab-secondary'))
    fireEvent.click(screen.getByTestId('split-pane-tab-primary'))
    act(() => width.setState({ px: 2000 }))
    act(() => width.setState({ px: 600 }))

    expect(h.mounts['thread-a']).toBe(1)
    expect(h.mounts['thread-b']).toBe(1)
    expect(screen.getByTestId('input-thread-b')).toHaveValue('kept draft')
  })

  it('sits side by side when wide enough, with dividers the keyboard can move', () => {
    width.setState({ px: 1200 })
    renderRoute()
    expect(pane('primary')).not.toHaveClass('invisible')
    expect(pane('secondary')).not.toHaveClass('invisible')
    expect(pane('primary').style.flexGrow).toBe('0.5')

    const divider = screen.getByRole('separator')
    expect(divider).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(split().sizes[0]).toBeCloseTo(0.52)
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(split().sizes[0]).toBeCloseTo(0.48)
    expect(divider).toHaveAttribute('aria-valuenow', '48')
  })

  it('never opens the same thread in two panes', () => {
    useSplitConversation.setState({
      panes: [{ id: 'secondary', kind: 'chat', refId: 'thread-a' }],
    })
    renderRoute()
    expect(screen.getAllByTestId('composer-thread-a')).toHaveLength(1)
    expect(screen.getByTestId('split-pane-picker')).toBeInTheDocument()
  })

  it('changes the conversation a pane shows', () => {
    renderRoute()
    fireEvent.click(screen.getByTestId('split-pane-change-secondary'))
    expect(split().panes[0].refId).toBeUndefined()
    fireEvent.click(screen.getByTestId('split-pick-thread-c'))
    expect(split().panes[0].refId).toBe('thread-c')
    expect(
      within(pane('secondary')).getByTestId('composer-thread-c')
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

  it('opens a new pane from the header Split action', () => {
    useSplitConversation.setState({ panes: [], sizes: [1] })
    renderRoute()
    expect(screen.queryByTestId('split-bar')).toBeNull()
    fireEvent.click(screen.getByTestId('split-conversation-open'))
    expect(split().panes).toHaveLength(1)
    expect(screen.getByTestId('split-bar')).toBeInTheDocument()
    expect(screen.getByTestId('split-pane-picker')).toBeInTheDocument()
    expect(h.mounts['thread-a']).toBe(1)
  })
})

describe('the width a pane gives its page', () => {
  const Probe = () => {
    const w = usePaneWidth()
    return <span data-testid="pane-width">{w === null ? 'window' : w}</span>
  }
  const renderProbe = () =>
    render(
      <SplitWorkspace primary={{ kind: 'cowork', refId: 's1' }}>
        {() => <Probe />}
      </SplitWorkspace>
    )

  beforeEach(() => {
    useSplitConversation.setState({
      panes: [],
      sizes: [1],
      activePane: PRIMARY_PANE,
      maxPanes: 4,
    })
  })

  it('is the window outside split view', () => {
    width.setState({ px: 1600 })
    renderProbe()
    expect(screen.getByTestId('pane-width')).toHaveTextContent('window')
  })

  it("is the pane's share side by side, and the whole width as tabs", () => {
    useSplitConversation.setState({
      panes: [{ id: 'p2', kind: 'chat' }],
      sizes: [0.25, 0.75],
    })
    width.setState({ px: 1600 })
    renderProbe()
    // A Cowork page in a 400px pane lays out for a phone, not the window.
    expect(screen.getByTestId('pane-width')).toHaveTextContent('400')
    act(() => width.setState({ px: 800 }))
    expect(screen.getByTestId('pane-width')).toHaveTextContent('800')
  })
})
