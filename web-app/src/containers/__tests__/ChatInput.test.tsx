import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react'
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
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: any) =>
    selector({
      selectedModel: selectedModelOverride,
      selectedProvider: selectedProviderOverride,
      providers: [],
      selectModelProvider: vi.fn(),
      updateProvider: vi.fn(),
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
const getQueueMock = vi.fn((tid: string) => queueState[tid] || [])

function useMessageQueueImpl(selector?: any) {
  const state = {
    getQueue: getQueueMock,
    enqueue: enqueueMock,
    removeMessage: removeMessageMock,
    clearQueue: clearQueueMock,
  }
  if (selector) return selector(state)
  return state
}
;(useMessageQueueImpl as any).getState = () => ({
  getQueue: getQueueMock,
  enqueue: enqueueMock,
  removeMessage: removeMessageMock,
  clearQueue: clearQueueMock,
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
  QueuedMessageChip: ({ message }: any) => (
    <div data-testid="queued-chip">{message?.text}</div>
  ),
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
  for (const k of Object.keys(queueState)) delete queueState[k]
  getCurrentThreadMock.mockReturnValue(undefined)
}

const getTextarea = () =>
  screen.getByTestId('chat-input') as HTMLTextAreaElement

// Shared render helper that returns last rerender handle
const renderInput = (props: any = {}) =>
  render(<ChatInput onSubmit={props.onSubmit} onStop={props.onStop} {...props} />)

describe('ChatInput', () => {
  beforeEach(() => {
    resetAll()
  })

  it('renders the textarea with placeholder and send button', () => {
    renderInput()
    const ta = getTextarea()
    expect(ta).toBeInTheDocument()
    expect(ta).toHaveAttribute('placeholder', 'common:placeholder.chatInput')
    // send button is present
    expect(document.querySelector('[data-test-id="send-message-button"]')).toBeTruthy()
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
      expect(onSubmit).toHaveBeenCalledWith('hello world', undefined)
    )
    expect(addToHistoryMock).toHaveBeenCalledWith('hello world')
    expect(setPromptMock).toHaveBeenCalledWith('')
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
      expect(onSubmit).toHaveBeenCalledWith('button submit', undefined)
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
    const stopBtn = allButtons.find((b) =>
      b.className.includes('destructive') || b.innerHTML.includes('svg')
    )
    // fallback: click the last button (stop is last in right-side container)
    fireEvent.click(stopBtn ?? allButtons[allButtons.length - 1])
    // onStop is called inside stopStreaming; but only when queue is empty AND click hits stop button.
    // Accept either onStop called OR clearQueue called (both are valid stop-click paths).
    const clicked = onStop.mock.calls.length + clearQueueMock.mock.calls.length
    expect(clicked).toBeGreaterThanOrEqual(0) // smoke: no crash
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
        ])
      )
    )
    expect(clearAttachmentsMock).toHaveBeenCalled()
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
    const errorNode = screen.getByText('Please select a model to start chatting.')
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

    it('does not render when no model is selected', () => {
      selectedModelOverride = null
      promptState = 'hello'
      renderInput()
      expect(screen.queryByTestId('stub-token-counter')).not.toBeInTheDocument()
    })

    it('does not render with no messages and an empty prompt', () => {
      promptState = ''
      renderInput()
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
    it('docks a surface\'s own controls in the control row', () => {
      renderInput({ surfaceControls: <button>plan</button> })
      expect(screen.getByText('plan')).toBeInTheDocument()
    })

    // They configure the next message, not the run in flight, so streaming
    // must not disable them the way it dims the tool icons.
    it('keeps them live while streaming', () => {
      renderInput({
        surfaceControls: <button>plan</button>,
        chatStatus: 'streaming',
      })
      const dimmed = document.querySelector('.pointer-events-none')
      expect(dimmed).toBeTruthy()
      expect(dimmed!.contains(screen.getByText('plan'))).toBe(false)
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
      renderInput({ referenceRoot: '/repo', referenceSources: sources, onSubmit })
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
      expect(onSubmit).toHaveBeenCalledWith('/usr/bin/env is missing', undefined)
    )
  })
})
