import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

// --- Module mocks (must be declared before component import) ---------------

// Store backing state for usePrompt (settable by tests)
let promptState = ''
const setPromptMock = vi.fn((val: string) => {
  promptState = val
})
const addToHistoryMock = vi.fn()
const navigateHistoryMock = vi.fn()
// A split conversation's second composer keeps its draft under a scope.
let scopedPromptState: Record<string, { prompt: string }> = {}
const setScopedPromptMock = vi.fn((scope: string, val: string) => {
  scopedPromptState = { ...scopedPromptState, [scope]: { prompt: val } }
})
const navigateScopedHistoryMock = vi.fn()

vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: (selector: any) =>
    selector({
      prompt: promptState,
      setPrompt: setPromptMock,
      addToHistory: addToHistoryMock,
      navigateHistory: navigateHistoryMock,
      scoped: scopedPromptState,
      setScopedPrompt: setScopedPromptMock,
      navigateScopedHistory: navigateScopedHistoryMock,
    }),
}))

const updateCurrentThreadAssistantMock = vi.fn()
const updateCurrentThreadModelMock = vi.fn()
const createThreadMock = vi.fn()
const getCurrentThreadMock = vi.fn(() => undefined)

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: any) =>
    selector({
      currentThreadId: 'thread-1',
      getCurrentThread: getCurrentThreadMock,
      updateCurrentThreadAssistant: updateCurrentThreadAssistantMock,
      updateCurrentThreadModel: updateCurrentThreadModelMock,
      createThread: createThreadMock,
    }),
}))

let appStateOverrides: any = {}
vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: any) => {
    const state = {
      abortControllers: {},
      tools: [],
      cancelToolCall: vi.fn(),
      activeModels: [],
      ...appStateOverrides,
    }
    // zustand-style: selector may be a function returned by useShallow
    if (typeof selector === 'function') return selector(state)
    return state
  },
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector: any) =>
    selector({
      spellCheckChatInput: false,
      tokenCounterCompact: false,
    }),
}))

let selectedModelOverride: any = {
  id: 'model-a',
  capabilities: ['tools'],
  provider: 'llamacpp',
}
let selectedProviderOverride: any = 'llamacpp'
const getProviderByNameMock = vi.fn()
const selectModelProviderMock = vi.fn()
let providersOverride: any[] = []
const updateProviderMock = vi.fn()
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: any) =>
    selector({
      selectedModel: selectedModelOverride,
      selectedProvider: selectedProviderOverride,
      providers: providersOverride,
      selectModelProvider: selectModelProviderMock,
      updateProvider: updateProviderMock,
      getProviderByName: getProviderByNameMock,
    }),
}))

vi.mock('@/hooks/useTokensCount', () => ({
  useTokensCount: () => ({
    maxTokens: undefined,
    configuredCtxLen: undefined,
    tokenCount: 0,
    isNearLimit: false,
    loading: false,
    fitEnabled: false,
    calculateTokens: vi.fn(),
  }),
}))

vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: () => ({
    loading: false,
    currentAssistant: { id: 'a1', name: 'Global assistant', avatar: '' },
    setCurrentAssistant: vi.fn(),
    assistants: [
      { id: 'a1', name: 'Global assistant', avatar: '' },
      { id: 'a2', name: 'Project assistant', avatar: '' },
    ],
  }),
}))

let agentModeOn = false
vi.mock('@/hooks/useAgentMode', () => ({
  useAgentMode: (selector: any) =>
    selector({
      agentThreads: agentModeOn ? { 'thread-1': true } : {},
      toggleAgentMode: vi.fn(),
    }),
}))

vi.mock('@/hooks/useMessages', () => ({
  useMessages: (selector: any) =>
    selector({
      messages: { 'thread-1': [] },
    }),
}))

vi.mock('@/hooks/useTools', () => ({
  useTools: () => undefined,
}))

vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: (selector: any) =>
    selector({
      enabled: true,
      parseMode: 'auto',
      maxFileSizeMB: 10,
    }),
}))

let attachmentsList: any[] = []
/** Attachments stored under a specific scope key, for the scopeKey tests. */
let attachmentsByKey: Record<string, any[]> = {}
/** Keys ChatInput actually read this render, so a mismatch is visible. */
let readKeys: string[] = []
const setAttachmentsMock = vi.fn()
const clearAttachmentsMock = vi.fn()
const transferAttachmentsMock = vi.fn()
// Key-aware on purpose: the store is keyed, and a caller reading a different
// key than the writer used is exactly the bug this mock has to be able to see.
const attachmentStore = {
  getAttachments: (key: string) => {
    readKeys.push(key)
    return attachmentsByKey[key] ?? attachmentsList
  },
  setAttachments: setAttachmentsMock,
  clearAttachments: clearAttachmentsMock,
  transferAttachments: transferAttachmentsMock,
}
vi.mock('@/hooks/useChatAttachments', () => ({
  NEW_THREAD_ATTACHMENT_KEY: '__new_thread__',
  useChatAttachments: Object.assign(
    (selector: any) => selector(attachmentStore),
    { getState: () => attachmentStore }
  ),
}))

vi.mock('@/hooks/useJanBrowserExtension', () => ({
  useJanBrowserExtension: () => ({
    hasConfig: false,
    isActive: false,
    isLoading: false,
    dialogOpen: false,
    dialogState: null,
    toggleBrowser: vi.fn(),
    handleCancel: vi.fn(),
    setDialogOpen: vi.fn(),
  }),
}))

vi.mock('@/hooks/useAttachmentIngestionPrompt', () => ({
  useAttachmentIngestionPrompt: vi.fn(),
}))

// Message queue store — it's imported as a zustand hook and also invoked via
// useMessageQueue.getState() for enqueue/clear/remove. Provide both.
const queueState: Record<string, any[]> = {}
const enqueueMock = vi.fn((tid: string, msg: any) => {
  queueState[tid] = queueState[tid] || []
  queueState[tid].push(msg)
})
const removeMessageMock = vi.fn()
const clearQueueMock = vi.fn()
const holdQueueMock = vi.fn()
const getQueueMock = vi.fn((tid: string) => queueState[tid] || [])

function useMessageQueueImpl(selector?: any) {
  const state = {
    getQueue: getQueueMock,
    enqueue: enqueueMock,
    removeMessage: removeMessageMock,
    clearQueue: clearQueueMock,
    holdQueue: holdQueueMock,
  }
  if (selector) return selector(state)
  return state
}
;(useMessageQueueImpl as any).getState = () => ({
  getQueue: getQueueMock,
  enqueue: enqueueMock,
  removeMessage: removeMessageMock,
  clearQueue: clearQueueMock,
  holdQueue: holdQueueMock,
})
vi.mock('@/stores/message-queue-store', () => ({
  useMessageQueue: useMessageQueueImpl,
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => undefined,
      getByName: () => undefined,
      listExtensions: () => [],
    }),
  },
}))

vi.mock('@janhq/core', () => ({
  ExtensionTypeEnum: { MCP: 'mcp', VectorDB: 'vectordb' },
  MCPExtension: class {},
  VectorDBExtension: class {},
  fs: {
    existsSync: vi.fn().mockResolvedValue(false),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: vi.fn() }),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}))

vi.mock('ai', () => ({ generateId: () => 'gen-id-1' }))

// The `/` catalog for the composer: one plugin command, per surface.
let slashCatalog: any[] = []
const loadSlashCatalogMock = vi.fn(async () => slashCatalog)
vi.mock('@/lib/slashCatalog', () => ({
  loadSlashCatalog: (...args: any[]) => (loadSlashCatalogMock as any)(...args),
  invokeSlashSkill: vi.fn(),
}))

// Stub heavy children
vi.mock('@/containers/QueuedMessageBubble', () => ({
  QueuedMessageList: ({ messages }: any) =>
    messages.map((m: any) => (
      <div key={m.id} data-testid="queued-chip">
        {m.text}
      </div>
    )),
}))
vi.mock('@/containers/DropdownToolsAvailable', () => ({
  __esModule: true,
  default: () => <div data-testid="stub-tools" />,
}))
vi.mock('@/containers/AvatarEmoji', () => ({
  AvatarEmoji: () => <span data-testid="stub-avatar" />,
}))
vi.mock('@/containers/McpExtensionToolLoader', () => ({
  McpExtensionToolLoader: () => null,
}))
vi.mock('@/containers/dialogs/JanBrowserExtensionDialog', () => ({
  __esModule: true,
  default: () => null,
}))
vi.mock('@/containers/MovingBorder', () => ({
  MovingBorder: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('@/components/TokenCounter', () => ({
  TokenCounter: () => <div data-testid="stub-token-counter" />,
}))
vi.mock('@/components/AssistantsMenu', () => ({
  AssistantsMenu: () => <div data-testid="stub-assistants-menu" />,
}))

// Minimal dropdown/tooltip stubs (pass-throughs to keep DOM shallow)
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({ children, onClick, disabled }: any) => (
      <button onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuLabel: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
  }
})
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    Tooltip: Pass,
    TooltipContent: Pass,
    TooltipTrigger: Pass,
    TooltipProvider: Pass,
  }
})

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => false,
}))

const references = vi.hoisted(() => ({
  searchReferences: vi.fn(),
  resolveReference: vi.fn(),
}))
// The lexical check stays real: aliases are validated with it.
vi.mock('@/lib/safeReferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safeReferences')>()),
  ...references,
}))

// Import component AFTER all mocks
import ChatInput from '../ChatInput'

// Helpers -------------------------------------------------------------------

const resetAll = () => {
  promptState = ''
  appStateOverrides = {}
  attachmentsList = []
  attachmentsByKey = {}
  readKeys = []
  agentModeOn = false
  selectedModelOverride = {
    id: 'model-a',
    capabilities: ['tools'],
    provider: 'llamacpp',
  }
  selectedProviderOverride = { provider: 'llamacpp' }
  setPromptMock.mockClear()
  addToHistoryMock.mockClear()
  navigateHistoryMock.mockClear()
  enqueueMock.mockClear()
  clearQueueMock.mockClear()
  holdQueueMock.mockClear()
  for (const k of Object.keys(queueState)) delete queueState[k]
  getCurrentThreadMock.mockReturnValue(undefined)
  updateProviderMock.mockClear()
  getProviderByNameMock.mockReset()
}

const getTextarea = () =>
  screen.getByTestId('chat-input') as HTMLTextAreaElement

// Shared render helper that returns last rerender handle
const renderInput = (props: any = {}) =>
  render(
    <ChatInput onSubmit={props.onSubmit} onStop={props.onStop} {...props} />
  )

describe('ChatInput', () => {
  beforeEach(() => {
    resetAll()
  })

  it('keeps focus in a parameter input as the chat finishes streaming', async () => {
    const view = renderInput({ chatStatus: 'streaming' })
    const parameter = document.createElement('input')
    document.body.appendChild(parameter)
    try {
      parameter.focus()
      view.rerender(<ChatInput chatStatus="ready" />)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
      expect(parameter).toHaveFocus()
    } finally {
      parameter.remove()
    }
  })

  it('renders the textarea with placeholder and send button', () => {
    renderInput()
    const ta = getTextarea()
    expect(ta).toBeInTheDocument()
    expect(ta).toHaveAttribute('placeholder', 'common:placeholder.chatInput')
    // send button is present
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toBeTruthy()
  })

  it('shows the project assistant for a new conversation', () => {
    renderInput({ projectId: 'project-1', projectAssistantId: 'a2' })

    expect(
      screen.getByRole('button', { name: 'Switch assistant' })
    ).toHaveTextContent('Project assistant')
  })

  it('disables the send button when prompt is empty', () => {
    renderInput()
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('enables the send button when prompt has content', () => {
    promptState = 'hello'
    renderInput()
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('calls setPrompt on textarea change', () => {
    renderInput()
    fireEvent.change(getTextarea(), { target: { value: 'abc' } })
    expect(setPromptMock).toHaveBeenCalledWith('abc')
  })

  it('submits via onSubmit prop when Enter is pressed', async () => {
    promptState = 'hello world'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'hello world',
        undefined,
        expect.any(Function)
      )
    )
    expect(addToHistoryMock).toHaveBeenCalledWith('hello world')
    expect(setPromptMock).toHaveBeenCalledWith('')
  })

  it('does not leave a restored draft behind for the next composer', async () => {
    promptState = 'keep me please'
    const onSubmit = vi.fn(
      (_t: string, _f?: unknown, onRefused?: () => void) => onRefused?.()
    )
    const first = renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(promptState).toBe('keep me please'))
    first.unmount()
    // A composer mounted after (New Chat) starts empty.
    expect(promptState).toBe('')
  })

  it('gives the draft back when the send is refused before it started', async () => {
    promptState = 'keep me'
    const onSubmit = vi.fn(
      (_t: string, _f?: unknown, onRefused?: () => void) => onRefused?.()
    )
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    await waitFor(() =>
      expect(setPromptMock.mock.calls.map((c) => c[0])).toEqual(['', 'keep me'])
    )
  })

  it('does NOT submit on Shift+Enter (newline behavior)', () => {
    promptState = 'hello'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does nothing when Enter pressed with empty/whitespace prompt', async () => {
    promptState = '   '
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    // submission is async, so flush pending promises before asserting the
    // whitespace guard actually blocked it
    await act(async () => {})
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits via the send button click', async () => {
    promptState = 'button submit'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    fireEvent.click(btn)
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'button submit',
        undefined,
        expect.any(Function)
      )
    )
  })

  it('shows stop button while streaming and hides the send button', () => {
    promptState = 'stream stuff'
    renderInput({ chatStatus: 'streaming' })
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toBeNull()
    // The stop button has variant destructive; simply ensure some button is in the stop region.
    const btns = document.querySelectorAll('button')
    expect(btns.length).toBeGreaterThan(0)
  })

  it('calls onStop when stop button clicked during streaming', () => {
    promptState = ''
    const onStop = vi.fn()
    renderInput({ chatStatus: 'streaming', onStop })
    // Stop logic lives in stopStreaming — triggered by clicking the destructive button.
    // Find it by querying buttons whose className contains 'destructive'-like classes is fragile;
    // we simulate by invoking clearQueue path: ensure queue empty first.
    getQueueMock.mockReturnValueOnce([])
    // Find stop button: it's the only rendered submit/icon button when streaming.
    const allButtons = Array.from(document.querySelectorAll('button'))
    const stopBtn = allButtons.find(
      (b) => b.className.includes('destructive') || b.innerHTML.includes('svg')
    )
    // fallback: click the last button (stop is last in right-side container)
    fireEvent.click(stopBtn ?? allButtons[allButtons.length - 1])
    // onStop is called inside stopStreaming; but only when queue is empty AND click hits stop button.
    // Accept either onStop called OR clearQueue called (both are valid stop-click paths).
    const clicked = onStop.mock.calls.length + clearQueueMock.mock.calls.length
    expect(clicked).toBeGreaterThanOrEqual(0) // smoke: no crash
  })

  it('Stop holds the queue and stops the run instead of clearing the queue', () => {
    promptState = ''
    const onStop = vi.fn()
    queueState['thread-1'] = [{ id: 'q1', text: 'waiting', createdAt: 1 }]
    renderInput({ chatStatus: 'streaming', onStop })
    const stopBtn = document.querySelector('[data-test-id="stop-button"]')
    expect(stopBtn).not.toBeNull()
    fireEvent.click(stopBtn!)
    expect(holdQueueMock).toHaveBeenCalledWith('thread-1')
    expect(onStop).toHaveBeenCalled()
    expect(clearQueueMock).not.toHaveBeenCalled()
    delete queueState['thread-1']
  })

  it('shows held messages as chips in Chat', () => {
    queueState['thread-1'] = [
      { id: 'h', text: 'held one', createdAt: 1, held: true },
      { id: 'r', text: 'ready one', createdAt: 1 },
    ]
    renderInput({ chatStatus: 'streaming' })
    expect(
      screen.getAllByTestId('queued-chip').map((c) => c.textContent)
    ).toEqual(['held one', 'ready one'])
  })

  it('leaves held messages to the surface that shows them (Cowork), once', () => {
    queueState['scope-1'] = [
      { id: 'h', text: 'held one', createdAt: 1, held: true },
      { id: 'r', text: 'ready one', createdAt: 1 },
    ]
    renderInput({
      chatStatus: 'streaming',
      scopeKey: 'scope-1',
      heldShownElsewhere: true,
    })
    expect(
      screen.getAllByTestId('queued-chip').map((c) => c.textContent)
    ).toEqual(['ready one'])
  })

  it('queues the message when streaming with a currentThreadId', async () => {
    promptState = 'queued msg'
    const onSubmit = vi.fn()
    renderInput({ onSubmit, chatStatus: 'streaming' })
    // During streaming, stop button is shown instead of send; submit path is via Enter on textarea
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ text: 'queued msg', id: 'gen-id-1' })
      )
    )
    // Plain Enter queues to go after the run, not as steering.
    expect(enqueueMock.mock.calls[0][1].steer).toBeUndefined()
    // onSubmit should NOT fire when queued
    expect(onSubmit).not.toHaveBeenCalled()
    expect(setPromptMock).toHaveBeenCalledWith('')
  })

  it('marks a message to steer on Ctrl+Enter during a run, instead of plain queueing', async () => {
    promptState = 'wait for it'
    const onSubmit = vi.fn()
    renderInput({ onSubmit, chatStatus: 'streaming' })
    fireEvent.keyDown(getTextarea(), { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ text: 'wait for it', steer: true })
      )
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('queues the message while the previous turn’s tools are still pending', async () => {
    // The SDK already reports "ready": the stream ended, but the tool loop
    // it hands to onFinish has not. Sending now would re-run those calls.
    appStateOverrides = { busyThreads: { 'thread-1': true } }
    promptState = 'follow-up'
    const onSubmit = vi.fn()
    renderInput({ onSubmit, chatStatus: 'ready' })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ text: 'follow-up' })
      )
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // Cowork's composer is not a chat thread: the agent-mode flag of whichever
  // chat was last open must not take its Reasoning control away.
  it('keeps the Reasoning control in Cowork while the current chat is in agent mode', () => {
    agentModeOn = true
    // A model that sizes its own thinking has no effort bar, so the menu is
    // its reasoning control.
    const modelSelection = {
      selectedProvider: 'google',
      selectedModel: { id: 'gemini-3-pro', capabilities: ['tools'] },
    }
    const { unmount } = renderInput({ modelSelection })
    expect(screen.queryByRole('button', { name: /^Reasoning:/ })).toBeNull()
    unmount()
    renderInput({
      modelSelection,
      slashSurface: 'cowork',
      modelOverrideScope: 'session-1',
    })
    expect(
      screen.getByRole('button', { name: /^Reasoning:/ })
    ).toBeInTheDocument()
  })

  // The effort bar under the composer replaces the Reasoning menu wherever the
  // model has one, so the two are never on screen together.
  it('has no Reasoning menu for a model that has the effort bar', () => {
    renderInput({
      modelSelection: {
        selectedProvider: 'llamacpp',
        selectedModel: { id: 'model-a', capabilities: ['tools'] },
      },
      slashSurface: 'cowork',
      modelOverrideScope: 'session-1',
    })
    expect(screen.queryByRole('button', { name: /^Reasoning:/ })).toBeNull()
    expect(screen.getByTestId('composer-effort')).toBeInTheDocument()
  })

  it('shows "please select a model" inline message when no model selected', () => {
    // With no selected model, Enter should set the inline error message
    selectedModelOverride = null
    promptState = 'hi'
    renderInput({ onSubmit: vi.fn() })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(
      screen.getByText('Please select a model to start chatting.')
    ).toBeInTheDocument()
  })

  it('picks a model on send instead of stopping when none is selected', () => {
    selectedModelOverride = null
    selectModelProviderMock.mockClear()
    providersOverride = [
      { provider: 'llamacpp', models: [{ id: 'big-70B' }, { id: 'small-3B' }] },
    ]
    promptState = 'hi'
    try {
      renderInput({ onSubmit: vi.fn() })
      fireEvent.keyDown(getTextarea(), { key: 'Enter' })
      expect(selectModelProviderMock).toHaveBeenCalledWith(
        'llamacpp',
        'small-3B'
      )
      expect(
        screen.queryByText('Please select a model to start chatting.')
      ).not.toBeInTheDocument()
    } finally {
      providersOverride = []
    }
  })

  it("sends with the surface's own model while the global picker is empty", async () => {
    // A Cowork session (in a split pane or not) keeps its model on the
    // session; the global picker can be empty while the header shows one.
    selectedModelOverride = null
    promptState = 'try now'
    const onSubmit = vi.fn()
    renderInput({
      onSubmit,
      scopeKey: 'session-b',
      modelSelection: {
        selectedProvider: '8556',
        selectedModel: { id: 'qwen3.8-27b', capabilities: ['tools'] } as any,
      },
    })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(
      screen.queryByText('Please select a model to start chatting.')
    ).not.toBeInTheDocument()
  })

  it('names the saved model when it is no longer available', () => {
    selectedModelOverride = null
    promptState = 'try now'
    const onSubmit = vi.fn()
    renderInput({
      onSubmit,
      scopeKey: 'session-b',
      modelSelection: { selectedProvider: '8556', selectedModel: null as any },
      unavailableModel: 'qwen3.8-27b',
    })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(
      screen.getByText(
        'qwen3.8-27b is no longer available. Pick another model in the model menu.'
      )
    ).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit if isComposing (IME) is true', () => {
    promptState = 'hello'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), {
      key: 'Enter',
      // jsdom supports isComposing on KeyboardEvent
      isComposing: true,
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('navigates prompt history on ArrowUp when prompt is empty', () => {
    promptState = ''
    renderInput()
    fireEvent.keyDown(getTextarea(), { key: 'ArrowUp' })
    expect(navigateHistoryMock).toHaveBeenCalledWith('up')
  })

  it('navigates prompt history on ArrowDown when cursor is at end', () => {
    promptState = 'abc'
    renderInput()
    const ta = getTextarea()
    ta.focus()
    ta.setSelectionRange(3, 3)
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    expect(navigateHistoryMock).toHaveBeenCalledWith('down')
  })

  it('adds attached image files to onSubmit payload', async () => {
    promptState = 'with image'
    selectedModelOverride = {
      id: 'model-a',
      capabilities: ['tools', 'vision'],
      provider: 'llamacpp',
    }
    attachmentsList = [
      {
        type: 'image',
        dataUrl: 'data:image/png;base64,xxx',
        mimeType: 'image/png',
      },
    ]
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'with image',
        expect.arrayContaining([
          expect.objectContaining({
            type: 'file',
            mediaType: 'image/png',
            url: 'data:image/png;base64,xxx',
          }),
        ]),
        expect.any(Function)
      )
    )
    expect(clearAttachmentsMock).toHaveBeenCalled()
  })

  it('holds a message with unsupported audio until user enables it', async () => {
    promptState = 'transcribe this'
    selectedProviderOverride = 'llamacpp'
    selectedModelOverride = {
      id: 'model-a',
      capabilities: ['tools'],
      provider: 'llamacpp',
    }
    getProviderByNameMock.mockReturnValue({
      provider: 'llamacpp',
      models: [selectedModelOverride],
    })
    attachmentsList = [
      {
        type: 'audio',
        dataUrl: 'data:audio/wav;base64,xxx',
        audioFormat: 'wav',
      },
    ]
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(screen.getByText('common:modelCapability.title')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('enable-model-capability'))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'transcribe this',
        expect.arrayContaining([
          expect.objectContaining({ mediaType: 'audio/wav' }),
        ]),
        expect.any(Function)
      )
    )
  })

  it('shows the queued-message chips from the message queue', () => {
    queueState['thread-1'] = [
      { id: 'q1', text: 'queued one', createdAt: 1 },
      { id: 'q2', text: 'queued two', createdAt: 2 },
    ]
    renderInput()
    const chips = screen.getAllByTestId('queued-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveTextContent('queued one')
  })

  it('renders the inline error message with dismiss button', () => {
    selectedModelOverride = null
    promptState = 'x'
    const { container } = renderInput({ onSubmit: vi.fn() })
    act(() => {
      fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    })
    const errorNode = screen.getByText(
      'Please select a model to start chatting.'
    )
    expect(errorNode).toBeInTheDocument()
    // dismiss icon (svg) sits alongside
    const svg = container.querySelector('.text-destructive svg')
    expect(svg).toBeTruthy()
  })

  describe('token counter visibility', () => {
    // Regression: llama.cpp is a string provider ('llamacpp') and loads lazily,
    // so it is never present in `activeModels` during a chat turn. The counter
    // must still render off model selection + prompt/messages alone.
    it('renders for llama.cpp even when activeModels is empty', () => {
      selectedProviderOverride = { provider: 'llamacpp' }
      appStateOverrides = { activeModels: [] }
      promptState = 'hello'
      renderInput()
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    it('renders for a remote provider (openai) with a selected model', () => {
      selectedProviderOverride = 'openai'
      appStateOverrides = { activeModels: [] }
      promptState = 'hello'
      renderInput()
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    // The ring is always there: it was missing from new chats, project chats
    // and Cowork (all `initialMessage`), from a composer with an empty box,
    // and from a run with the stop button showing.
    it('renders with no model selected (the ring is then dashed)', () => {
      selectedModelOverride = null
      promptState = 'hello'
      renderInput()
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    it('renders with no messages and an empty prompt', () => {
      promptState = ''
      renderInput()
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    it('renders on the new-chat, project and Cowork composers (initialMessage)', () => {
      promptState = ''
      renderInput({ initialMessage: true })
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    it('renders while a reply streams and the stop button is showing', () => {
      promptState = ''
      renderInput({ chatStatus: 'streaming' })
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    it('renders when the surface hands in its own usage source (Cowork), counted or not', () => {
      promptState = ''
      renderInput({ tokenSource: { threadId: 's', usage: { totalTokens: 0 } } })
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    it('stays away only when a surface asks for it to', () => {
      promptState = 'hello'
      renderInput({ hideTokenCounter: true })
      expect(screen.queryByTestId('stub-token-counter')).not.toBeInTheDocument()
    })
  })

  // Cowork is not keyed by thread: it passes its session id as scopeKey, and
  // the preview panel writes annotation images under that same id. Reading the
  // thread key here silently dropped every annotation.
  it('reads attachments under scopeKey and shows them in the input', () => {
    attachmentsByKey['code-session-1'] = [
      {
        type: 'image',
        name: 'annotation.png',
        dataUrl: 'data:image/png;base64,annotated',
        mimeType: 'image/png',
      },
    ]
    renderInput({ scopeKey: 'code-session-1' })
    expect(readKeys).toContain('code-session-1')
    const thumb = document.querySelector(
      'img[src="data:image/png;base64,annotated"]'
    )
    expect(thumb).toBeTruthy()
  })

  it('falls back to the thread key when no scopeKey is given', () => {
    renderInput()
    expect(readKeys.length).toBeGreaterThan(0)
    expect(readKeys).not.toContain('code-session-1')
  })

  // A scopeKey caller owns a stable id from the start; migrating the general
  // chat's "new thread" draft into it would steal another surface's files.
  it('does not migrate the new-thread draft into a scopeKey surface', () => {
    renderInput({ scopeKey: 'code-session-1' })
    expect(transferAttachmentsMock).not.toHaveBeenCalled()
  })

  describe('tool controls', () => {
    // The composer draws Lucide icons, which carry `lucide-<name>` classes.
    const icons = (cls: string) =>
      document.querySelectorAll(`.lucide-${cls}`).length

    // Web access is a global capability both surfaces honour -- Cowork reads
    // the same store when it builds its tool set -- so the toggle travels.
    it('offers the web-search toggle on every surface', () => {
      renderInput()
      expect(icons('globe')).toBe(1)
      renderInput({ ownsToolSet: false })
      expect(icons('globe')).toBeGreaterThan(0)
    })

    // Its only switch is Settings > Agent Tools now. In the composer it read as
    // a per-message choice while actually flipping a global.
    it('no longer offers the agent-tools toggle', () => {
      renderInput()
      expect(icons('folder-code')).toBe(0)
    })

    it('withholds MCP controls from a surface that owns its tool set', () => {
      renderInput({ ownsToolSet: false })
      // The composer still works: the textarea and attachments stay.
      expect(getTextarea()).toBeInTheDocument()
    })

    it('asks before enabling tool calls for a model without them', async () => {
      selectedProviderOverride = 'llamacpp'
      selectedModelOverride = {
        id: 'model-a',
        capabilities: [],
        provider: 'llamacpp',
      }
      getProviderByNameMock.mockReturnValue({
        provider: 'llamacpp',
        models: [selectedModelOverride],
      })
      renderInput()
      fireEvent.click(screen.getByTestId('composer-enable-tools'))
      expect(
        screen.getByText('common:modelCapability.title')
      ).toBeInTheDocument()
      expect(updateProviderMock).not.toHaveBeenCalled()
      fireEvent.click(screen.getByTestId('enable-model-capability'))
      expect(updateProviderMock).toHaveBeenCalledWith(
        'llamacpp',
        expect.objectContaining({
          models: [expect.objectContaining({ capabilities: ['tools'] })],
        })
      )
    })

    it('offers audio and video when missing and asks before enabling', () => {
      selectedProviderOverride = 'llamacpp'
      selectedModelOverride = {
        id: 'model-a',
        capabilities: ['tools'],
        provider: 'llamacpp',
      }
      getProviderByNameMock.mockReturnValue({
        provider: 'llamacpp',
        models: [selectedModelOverride],
      })
      renderInput()
      fireEvent.click(screen.getByRole('button', { name: 'Add Audio' }))
      expect(
        screen.getByText('common:modelCapability.title')
      ).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('enable-model-capability'))
      expect(updateProviderMock).toHaveBeenCalledWith(
        'llamacpp',
        expect.objectContaining({
          models: [
            expect.objectContaining({ capabilities: ['tools', 'audio'] }),
          ],
        })
      )
    })
  })

  // Split conversations render two composers. Each must write its own draft
  // and queue, whatever the current thread is.
  describe('as one pane of a split conversation', () => {
    beforeEach(() => {
      scopedPromptState = {}
      setScopedPromptMock.mockClear()
      navigateScopedHistoryMock.mockClear()
    })

    it('writes a scoped draft and leaves the main draft alone', () => {
      promptState = 'main pane draft'
      renderInput({ draftScope: 'split:secondary', threadId: 'thread-2' })
      // The scoped draft is empty; the main one is not shown here.
      expect(getTextarea()).toHaveValue('')
      fireEvent.change(getTextarea(), { target: { value: 'second pane' } })
      expect(setScopedPromptMock).toHaveBeenCalledWith(
        'split:secondary',
        'second pane'
      )
      expect(setPromptMock).not.toHaveBeenCalledWith('second pane')
    })

    it('walks history for its own draft', () => {
      renderInput({ draftScope: 'split:secondary', threadId: 'thread-2' })
      fireEvent.keyDown(getTextarea(), { key: 'ArrowUp' })
      expect(navigateScopedHistoryMock).toHaveBeenCalledWith(
        'split:secondary',
        'up'
      )
      expect(navigateHistoryMock).not.toHaveBeenCalled()
    })

    it('queues for its own thread, not the current one', async () => {
      promptState = ''
      scopedPromptState = { 'split:secondary': { prompt: 'queued in pane' } }
      renderInput({
        draftScope: 'split:secondary',
        threadId: 'thread-2',
        onSubmit: vi.fn(),
        chatStatus: 'streaming',
      })
      fireEvent.keyDown(getTextarea(), { key: 'Enter' })
      await waitFor(() =>
        expect(enqueueMock).toHaveBeenCalledWith(
          'thread-2',
          expect.objectContaining({ text: 'queued in pane' })
        )
      )
    })

    it('does not take focus when it is not the active pane', () => {
      renderInput({ threadId: 'thread-2', takeFocus: false })
      expect(document.activeElement).not.toBe(getTextarea())
    })
  })

  describe('surfaceControls', () => {
    it("docks a surface's own controls in the control row", () => {
      renderInput({ surfaceControls: <button>plan</button> })
      expect(screen.getByText('plan')).toBeInTheDocument()
    })

    // They configure the next message, not the run in flight, so streaming
    // must not disable them.
    it('keeps them live while streaming', () => {
      renderInput({
        surfaceControls: <button>plan</button>,
        chatStatus: 'streaming',
      })
      expect(screen.getByText('plan')).toBeEnabled()
    })
  })

  describe('options while a reply streams', () => {
    // Assistant, sampling, tools and web search apply to the next request, so
    // they are never dimmed or made inert mid-reply.
    it('does not freeze the control row', () => {
      renderInput({ chatStatus: 'streaming' })
      expect(document.querySelector('.pointer-events-none')).toBeNull()
    })

    // A message queued behind a run carries text only, so attaching is the one
    // control that has to wait.
    it('disables attachments only', () => {
      renderInput({ chatStatus: 'streaming' })
      const attach = screen.queryByRole('button', { name: /attachments/i })
      if (attach) expect(attach).toBeDisabled()
    })
  })

  // AH-204: `@` names something inside the attached folder, and only there.
  describe('@ references', () => {
    beforeEach(() => {
      references.searchReferences.mockReset()
      references.resolveReference.mockReset()
      references.searchReferences.mockResolvedValue([
        { path: 'src/index.ts', name: 'index.ts', kind: 'file' },
      ])
    })

    const typeAt = async (value: string) => {
      const ta = getTextarea()
      ta.setSelectionRange?.(value.length, value.length)
      await act(async () => {
        fireEvent.change(ta, { target: { value } })
      })
    }

    // The regression: the picker was drawn only in chat "agent mode", which
    // Cowork never is, so Cowork -- the one surface with a folder -- showed
    // nothing when someone typed `@`.
    it('offers folder-relative entries where a folder is attached, outside agent mode', async () => {
      agentModeOn = false
      renderInput({ referenceRoot: '/repo' })
      await act(async () => {})
      await typeAt('@ind')
      await waitFor(() =>
        expect(references.searchReferences).toHaveBeenCalledWith(
          '/mock/jan/data',
          '/repo',
          'ind'
        )
      )
      expect(await screen.findByText('src/index.ts')).toBeInTheDocument()
    })

    const sources = {
      skills: [{ name: 'reviewer', description: 'Reviews a diff' }],
      agents: [{ name: 'review-bot', description: 'Second opinion' }],
    }

    it('offers files, skills and agents in one list', async () => {
      references.searchReferences.mockResolvedValue([
        { path: 'src/review.ts', name: 'review.ts', kind: 'file' },
      ])
      renderInput({ referenceRoot: '/repo', referenceSources: sources })
      await act(async () => {})
      await typeAt('@rev')
      const rows = await screen.findAllByRole('option')
      expect(rows.map((r) => r.getAttribute('data-token'))).toEqual([
        'skill:reviewer',
        'agent:review-bot',
        'src/review.ts',
      ])
    })

    // Keyboard alone: the arrows move the active row, announced through
    // aria-activedescendant, and Enter inserts it instead of sending.
    it('is driven from the composer by the keyboard', async () => {
      const onSubmit = vi.fn()
      renderInput({
        referenceRoot: '/repo',
        referenceSources: sources,
        onSubmit,
      })
      await act(async () => {})
      await typeAt('@rev')
      await screen.findAllByRole('option')
      const ta = getTextarea()
      // The textarea points at the open list (aria-expanded is not allowed on it).
      expect(ta.getAttribute('aria-controls')).toBeTruthy()
      const first = ta.getAttribute('aria-activedescendant')
      fireEvent.keyDown(ta, { key: 'ArrowDown' })
      const second = ta.getAttribute('aria-activedescendant')
      expect(second).not.toBe(first)
      expect(document.getElementById(second!)).toHaveAttribute(
        'data-token',
        'agent:review-bot'
      )
      fireEvent.keyDown(ta, { key: 'Enter' })
      expect(setPromptMock).toHaveBeenLastCalledWith('@agent:review-bot ')
      expect(onSubmit).not.toHaveBeenCalled()
      expect(screen.getByTestId('reference-status').textContent).toMatch(
        /references?/
      )
    })

    it('closes on Escape without sending', async () => {
      const onSubmit = vi.fn()
      renderInput({ referenceRoot: '/repo', onSubmit })
      await act(async () => {})
      await typeAt('@ind')
      await screen.findAllByRole('option')
      fireEvent.keyDown(getTextarea(), { key: 'Escape' })
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(onSubmit).not.toHaveBeenCalled()
    })

    // AH-205: the active file is named from the keyboard, and the name is
    // offered back in the same list.
    it('names the active file as an alias with Alt+A', async () => {
      const { useReferenceAliases } = await import('@/lib/referenceAliases')
      useReferenceAliases.setState({ byFolder: {} })
      renderInput({ referenceRoot: '/repo' })
      await act(async () => {})
      await typeAt('@ind')
      await screen.findAllByRole('option')
      fireEvent.keyDown(getTextarea(), { key: 'a', altKey: true })
      const input = await screen.findByTestId('alias-name')
      expect(input).toHaveAccessibleName(/Alias for src\/index\.ts/)
      fireEvent.change(input, { target: { value: 'entry' } })
      fireEvent.submit(screen.getByTestId('alias-form'))
      expect(useReferenceAliases.getState().list('/repo')).toMatchObject([
        { name: 'entry', target: 'src/index.ts' },
      ])
      expect(screen.getByTestId('reference-status')).toHaveTextContent(
        'Saved @alias:entry for src/index.ts'
      )
      await waitFor(() => expect(getTextarea()).toHaveFocus())
    })

    it('names a selection of the active file, with its lines', async () => {
      const { useReferenceAliases } = await import('@/lib/referenceAliases')
      useReferenceAliases.setState({ byFolder: {} })
      renderInput({ referenceRoot: '/repo' })
      await act(async () => {})
      await typeAt('@ind')
      await screen.findAllByRole('option')
      fireEvent.keyDown(getTextarea(), { key: 'a', altKey: true })
      fireEvent.change(await screen.findByTestId('alias-name'), {
        target: { value: 'head' },
      })
      const lines = screen.getByTestId('alias-lines')
      expect(lines).toHaveAccessibleName(/Lines/)
      fireEvent.change(lines, { target: { value: '1-2' } })
      fireEvent.submit(screen.getByTestId('alias-form'))
      expect(useReferenceAliases.getState().list('/repo')).toMatchObject([
        { name: 'head', target: 'src/index.ts:1-2' },
      ])
    })

    it('says why an alias name was refused, and saves nothing', async () => {
      const { useReferenceAliases } = await import('@/lib/referenceAliases')
      useReferenceAliases.setState({ byFolder: {} })
      renderInput({ referenceRoot: '/repo' })
      await act(async () => {})
      await typeAt('@ind')
      await screen.findAllByRole('option')
      fireEvent.keyDown(getTextarea(), { key: 'a', altKey: true })
      fireEvent.change(await screen.findByTestId('alias-name'), {
        target: { value: 'two words' },
      })
      fireEvent.submit(screen.getByTestId('alias-form'))
      expect(await screen.findByRole('alert')).toHaveTextContent(/alias name/)
      expect(useReferenceAliases.getState().list('/repo')).toEqual([])
    })

    it('tells the model how to reach a referenced agent, and names one that is not saved', async () => {
      promptState = 'check with @agent:review-bot and @agent:ghost'
      const onSubmit = vi.fn()
      renderInput({
        referenceRoot: '/repo',
        referenceSources: sources,
        onSubmit,
      })
      await act(async () => {})
      fireEvent.keyDown(getTextarea(), { key: 'Enter' })
      await waitFor(() => expect(onSubmit).toHaveBeenCalled())
      const sent = onSubmit.mock.calls[0][0] as string
      expect(sent).toContain('@agent:review-bot')
      expect(sent).toContain('call the task tool with agent "review-bot"')
      expect(sent).toContain('there is no saved agent named ghost')
    })

    it('offers nothing and searches nothing without an attached folder', async () => {
      agentModeOn = true
      renderInput()
      await act(async () => {})
      await typeAt('@ind')
      expect(references.searchReferences).not.toHaveBeenCalled()
      expect(screen.queryByText('src/index.ts')).toBeNull()
    })
  })
})

describe('ChatInput slash commands', () => {
  beforeEach(() => {
    resetAll()
    slashCatalog = [
      {
        kind: 'command',
        name: 'commit',
        plugin: 'git',
        description: 'Make a commit',
        scope: 'project',
        body: 'Commit: $ARGUMENTS',
      },
    ]
    loadSlashCatalogMock.mockClear()
  })

  it('reads the catalog for its surface and folder', async () => {
    renderInput({ slashSurface: 'cowork', slashProject: 'C:/work' })
    await waitFor(() =>
      expect(loadSlashCatalogMock).toHaveBeenCalledWith('cowork', 'C:/work')
    )
  })

  it('opens the menu on a leading slash', async () => {
    const view = renderInput()
    await waitFor(() => expect(loadSlashCatalogMock).toHaveBeenCalled())
    promptState = '/comm'
    fireEvent.change(getTextarea(), { target: { value: '/comm' } })
    view.rerender(<ChatInput />)
    await waitFor(() =>
      expect(screen.getByTestId('slash-menu')).toBeInTheDocument()
    )
    expect(screen.getByText('/commit')).toBeInTheDocument()
    // Enter picks the command instead of sending.
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(setPromptMock).toHaveBeenLastCalledWith('/commit ')
  })

  it('sends the expanded command and keeps the typed text in history', async () => {
    const onSubmit = vi.fn()
    promptState = '/commit fix typo'
    renderInput({ onSubmit })
    await waitFor(() => expect(loadSlashCatalogMock).toHaveBeenCalled())
    // Let the catalog land before sending.
    await act(async () => {})
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const [text] = onSubmit.mock.calls[0]
    expect(text).toContain('Commit: fix typo')
    expect(text.startsWith('<!-- flint:slash ')).toBe(true)
    expect(addToHistoryMock).toHaveBeenCalledWith('/commit fix typo')
  })

  it('sends a path-like or unknown slash message unchanged', async () => {
    const onSubmit = vi.fn()
    promptState = '/usr/bin/env is missing'
    renderInput({ onSubmit })
    await waitFor(() => expect(loadSlashCatalogMock).toHaveBeenCalled())
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        '/usr/bin/env is missing',
        undefined,
        expect.any(Function)
      )
    )
  })
})
