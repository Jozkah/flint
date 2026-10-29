import { canModelSummarize } from '@/lib/continueFromSummary'
import { pendingComposerTokens } from '@/lib/context-manager'
import { isSendableAttachment } from '@/lib/attachmentChip'
import { ImageViewer } from '@/components/ImageViewer'
import { RichComposerEditor, type RichComposerHandle } from '@/containers/RichComposerEditor'
import { cn, getModelDisplayName } from '@/lib/utils'
import { useElementWidth } from '@/hooks/useElementWidth'
import { ComposerDensityProvider } from '@/containers/ComposerDensity'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  memo,
} from 'react'
import type { ReactNode } from 'react'
import { holdQueueThenStop } from '@/lib/chatSteering'
import { useMessageQueue } from '@/stores/message-queue-store'
import { ComposerQueue } from '@/containers/ComposerQueue'
import { SamplerPopover } from '@/containers/SamplerPopover'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { VoiceInputButton } from '@/containers/VoiceInputButton'
import { DropRim } from '@/components/ui/drop-rim'
import { ComposerAttachmentChips } from '@/containers/ComposerAttachmentChips'
import {
  useConversationModel,
  type ModelSelection,
} from '@/hooks/useConversationPane'
import { useTokensCount } from '@/hooks/useTokensCount'
import { isOverridden } from '@/lib/modelOverrides'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useModelToolsEnabled } from '@/hooks/useThreadToolGrants'
import { useReconcileVideoCapability } from '@/hooks/useReconcileVideoCapability'

import { useAppState } from '@/hooks/useAppState'
import type { ChatStatus } from 'ai'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useAssistant } from '@/hooks/useAssistant'
import { AssistantSwitcher } from '@/containers/AssistantSwitcher'
import { ComposerOptionsMenu } from '@/containers/ComposerOptionsMenu'
import { useTools } from '@/hooks/useTools'
import { TokenCounter } from '@/components/TokenCounter'
import type { TokenUsageSource } from '@/hooks/useTokensCount'
import { useActiveMessages } from '@/hooks/useActiveMessages'
import { useShallow } from 'zustand/react/shallow'
import { useAttachments } from '@/hooks/useAttachments'
import { toast } from 'sonner'
import { requestChatCompaction } from '@/lib/chatCompaction'
import {
  NEW_THREAD_ATTACHMENT_KEY,
  useChatAttachments,
} from '@/hooks/useChatAttachments'
import { VisionDisabledDialog } from '@/containers/dialogs/VisionDisabledDialog'
import { EnableModelCapabilityDialog } from '@/containers/dialogs/EnableModelCapabilityDialog'

import { acceptAttribute } from '@/lib/attachmentSupport'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useComposerFocus } from '@/hooks/useComposerFocus'
import { useMediaAttachments } from '@/hooks/useMediaAttachments'
import { ComposerAttachMenu } from '@/containers/ComposerAttachMenu'
import { ComposerToolControls } from '@/containers/ComposerToolControls'
import { ComposerReasoningMenu } from '@/containers/ComposerReasoningMenu'
import { REASONING_MENU_PROVIDERS } from '@/lib/reasoningMenu'
import { ComposerSendButton } from '@/containers/ComposerSendButton'
import {
  ComposerErrorLine,
  PathOfferBanner,
  WebSearchOffPrompt,
} from '@/containers/ComposerBanners'
import { useImageAttachments } from '@/hooks/useImageAttachments'
import { useDocumentAttachments } from '@/hooks/useDocumentAttachments'
import { usePathOffer } from '@/hooks/usePathOffer'
import { useComposerSend, type ModelCheck } from '@/hooks/useComposerSend'
import { useComposerEffort } from '@/hooks/useComposerEffort'
import { useComposerDropPaste } from '@/hooks/useComposerDropPaste'
import { useModelCapabilityPrompt } from '@/hooks/useModelCapabilityPrompt'
import { useComposerSlashCommands } from '@/hooks/useComposerSlashCommands'
import { useReferencePicker } from '@/hooks/useReferencePicker'
import { useWebSearchChoice, useWebSearchOn } from '@/hooks/useWebSearchChoice'
import { useChatShell } from '@/hooks/useChatShell'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { getSandboxStatus } from '@/lib/agentTools'
import { optionId, type NamedSource } from '@/lib/referenceMenu'
import { mentionTrigger } from '@/lib/chatMentions'
import { listConversations } from '@/lib/chatMentionSources'
import { MentionChips } from '@/containers/MentionChips'
import { useMentionPreview } from '@/hooks/useMentionPreview'
import { knownContextWindow } from '@/lib/knownContextWindow'
import { FilePickerPopover } from '@/components/FilePickerPopover'
import { PromptFillDialog } from '@/containers/PromptFillDialog'
import { SlashCommandMenu } from '@/components/SlashCommandMenu'
import { slashOptionId } from '@/lib/slashCommands'
import type { SlashSurface } from '@/hooks/useSlashCommands'
import type { SlashBuiltin } from '@/lib/slashCommands'

type ChatInputProps = {
  className?: string
  showSpeedToken?: boolean
  /**
   * Hide the composer's token counter. For a surface that already shows token
   * usage elsewhere (Cowork shows it per turn), so the same number is not
   * reported twice.
   */
  hideTokenCounter?: boolean
  /**
   * Compacts the open conversation, offered from the context circle. Chat
   * compacts through its registered compactor; a surface with its own (Cowork)
   * supplies this.
   */
  onCompact?: () => void
  model?: ThreadModel
  initialMessage?: boolean
  projectId?: string
  projectAssistantId?: string
  onSubmit?: (
    text: string,
    files?: Array<{ type: string; mediaType: string; url: string }>,
    /**
     * Call when the send is refused before anything started (no tool-calling
     * model, say): the composer then gets its text and attachments back.
     */
    onRefused?: () => void
  ) => void
  onStop?: () => void
  chatStatus?: ChatStatus
  // Overrides the conversation scope this input belongs to — both its message
  // queue and its pending attachments (default: useThreads' currentThreadId).
  // Callers outside the general chat (e.g. Cowork, keyed by session id) pass
  // their own id so each gets an independent queue and attachment draft.
  scopeKey?: string
  /**
   * Whether the surface's tool set is configured from this composer.
   *
   * False for a surface that builds its own set (Cowork, via
   * `buildCoworkTools`). Its toggles here would be inert on this surface while
   * still writing the global chat stores, so a user turning "agent tools" off
   * in Cowork would silently disable them in Chat.
   */
  ownsToolSet?: boolean
  /**
   * The folder `@` references may name (AH-204). A reference is a path inside
   * it, read through the backend's confined reader; with none, the picker
   * offers nothing and a typed reference resolves to nothing. Never the home
   * directory: that used to make every file under it, keys included, one `@`
   * away from the prompt.
   */
  referenceRoot?: string | null
  /**
   * What else `@` can name besides files (AH-204): the skills and saved agents
   * of the surface. Offered in the same ranked list, inserted as typed
   * references (`@skill:name`, `@agent:name`).
   */
  referenceSources?: { skills?: NamedSource[]; agents?: NamedSource[] }
  /**
   * Surface-specific controls docked in the composer's control row (Cowork's
   * plan toggle and folder chip). They sit outside the streaming dim, because
   * both configure the *next* message rather than the run in flight.
   */
  surfaceControls?: ReactNode
  /** Put the assistant, sampling, tools, web search and reasoning controls
   * behind one Options button (Cowork), for a quieter row. */
  groupOptions?: boolean
  /**
   * Where this composer's web search choice is kept (useWebSearchChoice).
   * Absent: the chat shown (or the new-chat draft). `null`: nothing yet, so
   * the default from Settings shows until `ensureWebSearchScope` makes one.
   */
  webSearchScope?: string | null
  /** Makes the scope a choice is written to (Cowork creates its session). */
  ensureWebSearchScope?: () => string
  /**
   * The model selector, docked under the composer at the right. The reasoning
   * effort control, when the model has one, sits to its left. Absent, the
   * effort control still shows (alone) so it is reachable on every surface.
   */
  modelControl?: ReactNode
  /** Controls under the composer at the left (Cowork's mode and access). */
  belowLeft?: ReactNode
  /**
   * Like `belowLeft`, but handed the reasoning-effort control so the surface
   * can fold it into its own settings group; the effort is then not drawn on
   * the right.
   */
  belowLeftWithEffort?: (ctx: {
    effort: ReactNode
    effortOverridden: boolean
    effortLabel: string | null
  }) => ReactNode
  /**
   * Replaces the default stop button while streaming.
   *
   * Cowork supplies one control that asks how far to stop; without this slot
   * it would have to render a second stop button beside this one, which is
   * exactly the thing being removed.
   */
  stopControl?: ReactNode
  /**
   * The surface shows held messages in a panel of its own (Cowork's held
   * input, with Send and Discard), so the composer leaves them out of its
   * chips and each held message is shown once.
   */
  heldShownElsewhere?: boolean
  /**
   * A surface that can hold a project folder (Cowork). When set, a pasted
   * path to a folder offers to attach it; `attached` are the folders it
   * already has, which are not offered again.
   */
  pastedFolder?: {
    attached: readonly string[]
    onAttach: (path: string) => void
  }
  /**
   * Usage for a surface that keeps no thread messages (Cowork). Rendering the
   * counter here rather than in the caller is what keeps its placement, the
   * `tokenCounterCompact` setting and the spacing to the send button identical
   * across surfaces.
   */
  tokenSource?: TokenUsageSource
  /**
   * The thread this composer writes to, when that is not the current thread:
   * a split conversation pane passes its own, because the current thread is
   * whichever pane is active. Defaults to useThreads' currentThreadId.
   */
  threadId?: string
  /**
   * The model this composer sends with, when the surface decides it rather
   * than the global picker or a thread: a Cowork session sends with its own
   * saved model, so "is a model chosen" has to ask the session.
   */
  modelSelection?: ModelSelection
  /**
   * The key this composer's per-conversation model overrides (reasoning
   * effort) are stored under, when that is not a thread: a Cowork session's
   * id, which is the key its transport resolves the model with. Defaults to
   * the thread id; an empty string means "no conversation yet" (the global
   * model setting is written, as on the new-chat screen) rather than falling
   * back to whichever chat thread is current.
   */
  modelOverrideScope?: string
  /**
   * The saved model that no longer resolves, named in the message shown
   * instead of the generic "select a model" when nothing can be sent with.
   */
  unavailableModel?: string
  /**
   * Checked before a send, for a host that owns the model choice (Cowork): if
   * the saved model is gone, ask the user for another and record it. `'retry'`
   * means a replacement was applied and the send should go ahead once it shows;
   * `'stop'` means the user cancelled. Absent, a chat checks its own thread.
   */
  confirmModel?: () => ModelCheck | Promise<ModelCheck>
  /**
   * Keeps this composer's draft apart from the main one. The second pane of a
   * split conversation passes a scope; without one the shared main draft is
   * used, as before.
   */
  draftScope?: string
  /**
   * Whether the composer may take focus on its own -- on mount, on a thread
   * change, when a reply finishes. A split pane the user is not working in
   * must not pull focus away from the one they are.
   */
  takeFocus?: boolean
  /**
   * Which surface's `/` commands this composer offers (default Home). Plugin
   * commands and skills are filtered by that surface's enablement toggle.
   */
  slashSurface?: SlashSurface
  /** Cowork's folder: its project commands and skills join the global ones. */
  slashProject?: string | null
  /** Surface built-ins; Home gets `/new` by default. `/help` is always there. */
  slashBuiltins?: SlashBuiltin[]
}

const ChatInput = memo(function ChatInput({
  className,
  projectId,
  projectAssistantId,
  onSubmit,
  onStop,
  chatStatus,
  heldShownElsewhere = false,
  pastedFolder,
  scopeKey,
  ownsToolSet = true,
  referenceRoot,
  referenceSources,
  surfaceControls,
  groupOptions = false,
  webSearchScope,
  ensureWebSearchScope,
  modelControl,
  belowLeft,
  belowLeftWithEffort,
  stopControl,
  tokenSource,
  hideTokenCounter,
  onCompact,
  threadId: threadIdProp,
  modelSelection,
  modelOverrideScope,
  unavailableModel,
  confirmModel,
  draftScope,
  takeFocus = true,
  slashSurface = 'home',
  slashProject,
  slashBuiltins,
}: ChatInputProps) {
  const richComposerRef = useRef<RichComposerHandle>(null)
  const routeThreadId = useThreads((state) => state.currentThreadId)
  const currentThreadId = threadIdProp ?? routeThreadId
  const { isFocused, focusComposer } = useComposerFocus({
    composerRef: richComposerRef,
    takeFocus,
    threadId: currentThreadId,
    chatStatus,
  })
  // The control row is absolutely positioned at the bottom of the composer, so
  // the composer must reserve exactly as much space as the row occupies. The
  // row wraps when it runs out of width, so the reserve cannot be a constant:
  // 40px is one row, and a wrapped row silently covered the textarea.
  const footerRef = useRef<HTMLDivElement | null>(null)
  // The control row's own width decides which labels show: a split pane is
  // narrower than the window, so a viewport query would be wrong.
  const controlsRowRef = useRef<HTMLDivElement | null>(null)
  const controlsWidth = useElementWidth(controlsRowRef)
  const [footerHeight, setFooterHeight] = useState(40)
  useEffect(() => {
    const el = footerRef.current
    if (!el) return
    const measure = () =>
      setFooterHeight((prev) => {
        const next = Math.ceil(el.getBoundingClientRect().height)
        return next > 0 && next !== prev ? next : prev
      })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const abortControllers = useAppState((state) => state.abortControllers)
  const cancelToolCall = useAppState((state) => state.cancelToolCall)
  // The main draft, or this composer's own when it has a scope (the second
  // pane of a split conversation), so typing in one never edits the other.
  const mainPrompt = usePrompt((state) => state.prompt)
  const scopedPrompt = usePrompt((state) =>
    draftScope ? (state.scoped?.[draftScope]?.prompt ?? '') : ''
  )
  const prompt = draftScope ? scopedPrompt : mainPrompt
  // The draft as of the last render, for a refused send's restore (below).
  const latestPromptRef = useRef(prompt)
  latestPromptRef.current = prompt
  // Text put back after a refused send. The draft store may be shared with
  // other composers (the unscoped one is), so it is taken out again when this
  // composer goes away or moves to another session, if still untouched.
  const restoredDraftRef = useRef<string | null>(null)
  const setMainPrompt = usePrompt((state) => state.setPrompt)
  const setScopedPrompt = usePrompt((state) => state.setScopedPrompt)
  const setPrompt = useCallback(
    (value: string) =>
      draftScope ? setScopedPrompt(draftScope, value) : setMainPrompt(value),
    [draftScope, setScopedPrompt, setMainPrompt]
  )
  const addToHistory = usePrompt((state) => state.addToHistory)
  useEffect(
    () => () => {
      const restored = restoredDraftRef.current
      restoredDraftRef.current = null
      if (restored !== null && latestPromptRef.current === restored) {
        setPrompt('')
      }
    },
    [scopeKey, draftScope, setPrompt]
  )
  const navigateMainHistory = usePrompt((state) => state.navigateHistory)
  const navigateScopedHistory = usePrompt(
    (state) => state.navigateScopedHistory
  )
  const navigateHistory = useCallback(
    (direction: 'up' | 'down') =>
      draftScope
        ? navigateScopedHistory(draftScope, direction)
        : navigateMainHistory(direction),
    [draftScope, navigateScopedHistory, navigateMainHistory]
  )
  // The main composer's draft is per chat: leaving a chat keeps its unsent
  // text for it, and the chat shown gets back its own (or nothing).
  const draftKey =
    scopeKey ??
    threadIdProp ??
    // Home and New Chat keep the last chat id in the store: key them apart.
    (routeThreadId && /\/threads\//.test(window.location.pathname)
      ? routeThreadId
      : '__new__')
  const switchDraft = usePrompt((state) => state.switchDraft)
  useEffect(() => {
    if (!draftScope) switchDraft?.(draftKey)
  }, [draftKey, draftScope, switchDraft])
  // The SDK reports "ready" before the previous turn's tool loop has run
  // (onFinish fires after the status flips), so streaming status alone says
  // nothing about tools still awaiting approval or executing. The thread is
  // marked busy for exactly that window; a send then must queue, or a second
  // tool loop starts over the same tool queue and re-runs its calls (#129).
  const threadBusy = useAppState((state) =>
    currentThreadId ? Boolean(state.busyThreads?.[currentThreadId]) : false
  )
  // Subscribed to the map, not read through getState(), so the control
  // re-renders when this chat's overrides change.
  const overridesByThread = useModelOverrides((state) => state.byThread)
  const overrideScope =
    modelOverrideScope !== undefined
      ? modelOverrideScope || undefined
      : currentThreadId
  const chatOverrides = overrideScope
    ? overridesByThread[overrideScope]
    : undefined
  const currentThread = useThreads((state) =>
    threadIdProp ? state.threads?.[threadIdProp] : state.getCurrentThread()
  )
  const updateCurrentThreadAssistant = useThreads(
    (state) => state.updateCurrentThreadAssistant
  )
  const { t } = useTranslation()
  const spellCheckChatInput = useGeneralSetting(
    (state) => state.spellCheckChatInput
  )
  const enterKeyInsertsNewline = useGeneralSetting(
    (state) => state.enterKeyInsertsNewline
  )
  const reasoningDefault = useGeneralSetting((state) => state.reasoningDefault)
  const tokenCounterCompact = useGeneralSetting(
    (state) => state.tokenCounterCompact
  )
  useTools()
  const router = useRouter()
  const { loading, currentAssistant, setCurrentAssistant, assistants } =
    useAssistant()

  // Agent mode
  // Use TEMPORARY_CHAT_ID as fallback key on the home screen (same pattern as attachments)
  const agentModeKey = currentThreadId ?? TEMPORARY_CHAT_ID
  const isAgentMode = useAgentMode(
    (state) => state.agentThreads[agentModeKey] === true
  )
  // When projectId is present, treat as normal chat (disable agent mode UI)
  const effectiveAgentMode = isAgentMode && !projectId
  // Gate for the controls that shape which tools the model is offered.
  const showToolControls = ownsToolSet && !effectiveAgentMode
  // Web search per chat: on by default when Settings has it on; the chat's
  // own switch, once flipped, wins (useWebSearchChoice). The new-chat draft
  // keeps its choice under the same key agent mode uses, and hands it on.
  const resolvedWebSearchScope =
    webSearchScope !== undefined ? webSearchScope : agentModeKey
  const webSearchEnabled = useWebSearchOn(resolvedWebSearchScope)
  const setWebSearchEnabled = useCallback(
    (on: boolean) => {
      const scope = ensureWebSearchScope?.() ?? resolvedWebSearchScope
      if (scope) useWebSearchChoice.getState().set(scope, on)
    },
    [ensureWebSearchScope, resolvedWebSearchScope]
  )

  // The image viewer over the composer's attachments: which image is open.
  const [viewerAt, setViewerAt] = useState<number | null>(null)
  const slashListId = useId()
  const {
    slashCommands,
    libraryPrompts,
    promptFill,
    setPromptFill,
    beginPromptInsert,
  } = useComposerSlashCommands({
    slashSurface,
    slashProject,
    slashBuiltins,
    currentThreadId,
    setPrompt,
  })
  const {
    filePickerOpen,
    filePickerQuery,
    filePickerEntries,
    referenceActive,
    aliasDraft,
    aliasError,
    referenceStatus,
    menuTrigger,
    referenceListId,
    workingDir,
    filePickerCursorPos,
    handlePromptChange,
    handleFilePickerSelect,
    handleFilePickerClose,
    handleAliasSave,
    handleAliasCancel,
    setReferenceActive,
    handleReferenceKeyDown,
    resolvePromptReferences,
  } = useReferencePicker({
    referenceRoot,
    referenceSources,
    prompt,
    setPrompt,
    scopeKey,
    currentThreadId,
    libraryPrompts,
    beginPromptInsert,
    focusComposer,
  })

  // Get current thread messages for token counting
  const threadMessages = useActiveMessages(currentThreadId)

  // This conversation's model: a split pane's own thread model, otherwise the
  // global picker.
  const threadModelSelection = useConversationModel()
  const conversationModel = modelSelection ?? threadModelSelection
  const selectedModel = conversationModel.selectedModel
  const toolsEnabled = useModelToolsEnabled(selectedModel, currentThreadId)
  // Chat's shell switch. Offered only where there is a shell to turn off: Agent
  // tools and the Settings shell on, a sandbox that can confine it, and a model
  // that takes tools. Cowork owns its tool set and never shows it.
  const chatShellOn = useChatShell((s) => s.shellEnabled)
  const setChatShellOn = useChatShell((s) => s.setShellEnabled)
  const agentToolsOn = useAgentToolsConfig(
    (s) => s.agentToolsEnabled && s.shellEnabled
  )
  const [sandboxEnforcesShell, setSandboxEnforcesShell] = useState(false)
  useEffect(() => {
    let live = true
    void getSandboxStatus()
      .then((s) => {
        if (live) setSandboxEnforcesShell(Boolean(s?.enforces))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  /** The general picker handles images; audio and video have their own entries. */
  const attachmentAccept = acceptAttribute({
        vision: true,
    audio: false,
    video: false,
  })
  const selectedProvider = conversationModel.selectedProvider
  const selectModelProvider = useModelProvider(
    (state) => state.selectModelProvider
  )
  // The counter measures this conversation's model, not the global picker's
  // (a Cowork session on a remote model was read against a local window, C-006).
  const counterSource = useMemo<TokenUsageSource>(
    () => ({
      ...tokenSource,
      selection: tokenSource?.selection ?? {
        selectedProvider: conversationModel.selectedProvider,
        selectedModel: conversationModel.selectedModel,
      },
    }),
    [tokenSource, conversationModel.selectedProvider, conversationModel.selectedModel]
  )
  const { maxTokens: liveMaxTokens, configuredCtxLen } = useTokensCount(
    threadMessages || [],
    counterSource
  )
  const [message, setMessage] = useState('')
  // A send held back because it needs the web and web search is off.
  const [webOffPrompt, setWebOffPrompt] = useState<string | null>(null)
  const activeModels = useAppState(useShallow((state) => state.activeModels))
  // Check if selected model is currently loaded/active
  const isModelActive = selectedModel?.id
    ? activeModels.includes(selectedModel.id)
    : false

  // A remote model can always write a summary; a local one only when loaded.
  const canSummarize = canModelSummarize(
    selectedProvider,
    selectedModel?.id,
    activeModels
  )

  // Reconcile video capability from /props once the model is loaded.
  useReconcileVideoCapability(
    selectedModel?.id,
    selectedProvider,
    isModelActive
  )

  const compactFromCounter =
    onCompact ??
    (currentThreadId
      ? () => {
          if (!requestChatCompaction(currentThreadId)) {
            toast.info(t('common:budget.compactFailed'))
          }
        }
      : undefined)

  // The counter's "Set a price" link: the model's provider settings.
  const openPriceSettings = (providerName: string) =>
    void router.navigate({
      to: route.settings.providers,
      params: { providerName },
    })

  // Always there, so its slot never shifts the controls beside it; with
  // nothing counted yet it is an empty ring.
  const tokenCounterVisible = !hideTokenCounter
  const [selectedAssistantId, setSelectedAssistantId] = useState<
    string | undefined
  >(loading ? undefined : projectAssistantId || currentAssistant?.id || '')

  // Re-chosen when loading ends or the project's assistant changes, not when
  // the current assistant does: that would undo the person's own pick.
  const currentAssistantIdRef = useRef(currentAssistant?.id)
  currentAssistantIdRef.current = currentAssistant?.id
  useEffect(() => {
    setSelectedAssistantId(
      projectAssistantId || currentAssistantIdRef.current || ''
    )
  }, [loading, projectAssistantId])

  const attachmentsEnabled = useAttachments((s) => s.enabled)
  const maxFileSizeMB = useAttachments((s) => s.maxFileSizeMB)

  // Derived: any document currently processing (ingestion in progress)
  // Same scope as the message queue: a surface writing attachments under its
  // own id would have them silently dropped if this read a thread id.
  const attachmentsKey =
    scopeKey ?? currentThreadId ?? NEW_THREAD_ATTACHMENT_KEY
  const attachments = useChatAttachments(
    useCallback(
      (state) => state.getAttachments(attachmentsKey),
      [attachmentsKey]
    )
  )
  const setAttachmentsForThread = useChatAttachments(
    (state) => state.setAttachments
  )
  const transferAttachments = useChatAttachments(
    (state) => state.transferAttachments
  )
  const getProviderByName = useModelProvider((state) => state.getProviderByName)
  // What the draft's conversation mentions resolve to: the chips above the
  // editor and the pills inside it read the same lookup.
  const mentionPreviews = useMentionPreview(prompt, scopeKey ?? currentThreadId)
  const mentionContextWindow = useMemo(
    () =>
      knownContextWindow(
        selectedModel as Parameters<typeof knownContextWindow>[0],
        getProviderByName(selectedProvider ?? '') as Parameters<typeof knownContextWindow>[1]
      ),
    [selectedModel, selectedProvider, getProviderByName]
  )

  const allProviders = useModelProvider((state) => state.providers)
  const preferredModel = useModelEvidence((state) => state.preferredModel)

  const ingestingDocs = attachments.some(
    (a) => a.type === 'document' && a.processing
  )
  const ingestingAny = attachments.some((a) => a.processing)
  const hasSendableMedia = attachments.some(isSendableAttachment)
  // The draft and its inline documents, so the context ring counts them
  // before send.
  const pendingTokens = useMemo(
    () => pendingComposerTokens(prompt, attachments),
    [prompt, attachments]
  )

  // Queued messages for this thread (shown as chips in the input area)
  const queueId = scopeKey ?? currentThreadId ?? ''
  const queuedMessages = useMessageQueue(
    useShallow((s) =>
      heldShownElsewhere
        ? s.getQueue(queueId).filter((m) => !m.held)
        : s.getQueue(queueId)
    )
  )

  const lastTransferredThreadId = useRef<string | null>(null)

  useEffect(() => {
    // Only the general chat migrates a draft: it composes under the "new
    // thread" key until the thread exists. A scopeKey caller has a stable id
    // from the start, so there is nothing to move. Nor does a split's second
    // pane: the home screen's draft belongs to the conversation it started.
    if (scopeKey || draftScope) return
    if (
      currentThreadId &&
      lastTransferredThreadId.current !== currentThreadId
    ) {
      transferAttachments(NEW_THREAD_ATTACHMENT_KEY, currentThreadId)
      lastTransferredThreadId.current = currentThreadId
    }
  }, [scopeKey, draftScope, currentThreadId, transferAttachments])

  const stopStreaming = useCallback(
    (threadId: string) => {
      // Use onStop prop if available (AI SDK), otherwise use legacy abort
      if (onStop) {
        onStop()
      } else {
        abortControllers[threadId]?.abort()
      }
      cancelToolCall?.()
      // The turn's per-thread canceller too: a tool still running (or waiting
      // for approval) belongs to the turn that Stop ends.
      useAppState.getState?.().cancelToolCalls?.[threadId]?.()
    },
    [abortControllers, cancelToolCall, onStop]
  )

  const visionSupported = !!selectedModel?.capabilities?.includes('vision')
  const audioSupported = !!selectedModel?.capabilities?.includes('audio')
  const media = useMediaAttachments({
    attachmentsKey,
    setMessage,
    focusComposer,
  })
  const processAudioFiles = media.audio.process
  const processVideoFiles = media.video.process
  const openAudioPicker = media.audio.openPicker
  const openVideoPicker = media.video.openPicker
  const videoSupported = !!selectedModel?.capabilities?.includes('video')

  const {
    attachDroppedDocuments,
    handleAttachDocsIngest,
    handleRemoveAttachment,
    removeAttachmentWithUndo,
  } = useDocumentAttachments({ attachmentsKey, currentThreadId, attachments })

  const {
    enableCapabilitiesOnSelectedModel,
    capabilityPrompt,
    setCapabilityPrompt,
    requestCapabilities,
    handleEnableCapabilities,
  } = useModelCapabilityPrompt({ selectedModel, selectedProvider })

  const {
    fileInputRef,
    processImageFiles,
    attachFiles,
    handleFileChange,
    openImagePicker,
    visionPrompt,
    handleVisionChoice,
  } = useImageAttachments({
    attachmentsKey,
    currentThreadId,
    selectedModel,
    selectedProvider,
    maxFileSizeMB,
    setMessage,
    focusComposer,
    enableCapabilities: enableCapabilitiesOnSelectedModel,
  })

  const isStreaming = chatStatus === 'submitted' || chatStatus === 'streaming'
  const {
    pathOffer,
    setPathOffer,
    attachFileUris,
    declinePathOffer,
    offerPastedPath,
    acceptPathOffer,
  } = usePathOffer({
    attachmentsKey,
    isStreaming,
    pastedFolder,
    richComposerRef,
    latestPromptRef,
    setPrompt,
    attachFiles,
    attachDroppedDocuments,
    focusComposer,
  })

  const { handleSendMessage, sending } = useComposerSend({
    modelSelection,
    currentThread,
    selectModelProvider,
    latestPromptRef,
    setWebOffPrompt,
    webSearchEnabled,
    slashCommands,
    confirmModel,
    selectedModel,
    unavailableModel,
    allProviders,
    preferredModel,
    setMessage,
    attachments,
    selectedProvider,
    requestCapabilities,
    setPrompt,
    resolvePromptReferences,
    scopeKey,
    currentThreadId,
    ownsToolSet,
    effectiveAgentMode,
    canSummarize,
    attachmentsKey,
    addToHistory,
    onSubmit,
    isStreaming,
    threadBusy,
    queueId,
    restoredDraftRef,
    isAgentMode,
    agentModeKey,
    projectId,
    assistants,
    selectedAssistantId,
    setCurrentAssistant,
    webSearchScope,
    prompt,
  })

  const {
    isDragOver,
    dragCount,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleUriDrop,
    handlePaste,
    largePaste,
  } = useComposerDropPaste({
    attachmentsKey,
    attachmentsEnabled,
    attachments,
    audioSupported,
    videoSupported,
    richComposerRef,
    latestPromptRef,
    setPrompt,
    attachFiles,
    processImageFiles,
    processAudioFiles,
    processVideoFiles,
    attachDroppedDocuments,
    requestCapabilities,
    attachFileUris,
    setPathOffer,
    offerPastedPath,
  })

  const composerImages = attachments
    .filter((a) => a.type === 'image' && a.dataUrl)
    .map((a) => ({ url: a.dataUrl as string, name: a.name }))

  // A tool call in flight (the reply has finished streaming but the tool is
  // still running) can be cancelled from here.
  const toolInFlight = useAppState((state) =>
    currentThreadId ? Boolean(state.cancelToolCalls?.[currentThreadId]) : false
  )
  const {
    updateModelSetting,
    effortLevels,
    localModelWithoutReasoning,
    currentEffort,
    effortOverridden,
    effortControl,
  } = useComposerEffort({
    selectedProvider,
    selectedModel,
    ownsModelChoice: !modelSelection,
    chatOverrides,
    overrideScope,
    reasoningDefault,
  })

  return (
    <div className="relative" data-composer>
      <div className="relative">
        {/* A reply in progress is said by the Stop button in the send slot,
            not by the accent: the accent marks selection and the primary
            action (Graphite), never activity. */}
        <div className="relative rounded-lg">
          <div
            // The control row below is absolutely positioned at the bottom of
            // this box, so the box has to reserve its height. That used to be a
            // fixed `pb-10`, which is one row's worth: as soon as the controls
            // wrapped to a second line they grew upward over the textarea. The
            // reserve now follows the row's measured height.
            style={{ paddingBottom: `${footerHeight}px` }}
            data-composer-box
            className={cn(
              'relative z-20 rounded-xl border-[0.8px] border-border bg-card px-0 shadow-[0_4px_14px_rgba(0,0,0,.04)] motion-safe:transition-[border-color,box-shadow,transform] motion-safe:duration-300 motion-safe:ease-expo',
              // A clear focus: a stronger edge, a soft ring, and the box lifts.
              isFocused &&
                'border-border-strong shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_18%,transparent),0_12px_30px_-12px_rgba(0,0,0,.25)] motion-safe:-translate-y-0.5',
              // The dashed rim below draws the edge while files are dragged over.
              isDragOver && 'border-transparent'
            )}
            data-drop-zone="true"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDropCapture={handleUriDrop}
            onDrop={handleDrop}
          >
            <DropRim active={isDragOver} count={dragCount} />
            {pathOffer && (
              <PathOfferBanner
                path={pathOffer.path}
                kind={pathOffer.kind}
                onAccept={() => void acceptPathOffer()}
                onDecline={declinePathOffer}
              />
            )}
            <ComposerAttachmentChips
              attachments={attachments}
              canSeeImages={visionSupported}
              onRemove={(i) => void handleRemoveAttachment(i)}
              onTogglePdfImages={(i) =>
                setAttachmentsForThread(attachmentsKey, (prev) =>
                  prev.map((a, j) => (j === i ? { ...a, sendAsImages: !a.sendAsImages } : a))
                )
              }
              onOpenImage={(url) =>
                setViewerAt(
                  Math.max(0, composerImages.findIndex((i) => i.url === url))
                )
              }
            />
            {queuedMessages.length > 0 && (
              <ComposerQueue
                queueId={queueId}
                messages={queuedMessages}
                busy={isStreaming || threadBusy}
                onEdit={(text) => {
                  setPrompt(text)
                  focusComposer()
                }}
                onStopForSteer={() => stopStreaming(currentThreadId ?? '')}
              />
            )}
            {slashCommands.open && (
              <div className="relative">
                <SlashCommandMenu
                  items={slashCommands.visible}
                  activeIndex={slashCommands.activeIndex}
                  listId={slashListId}
                  help={slashCommands.helpOpen}
                  onActiveChange={slashCommands.setActiveIndex}
                  onSelect={(item) => {
                    const text = slashCommands.pick(item)
                    const promptId = item.builtin?.promptId
                    const lib = promptId
                      ? libraryPrompts.find((p) => p.id === promptId)
                      : undefined
                    if (lib) {
                      setPrompt('')
                      beginPromptInsert(lib, (out) => setPrompt(out))
                    } else {
                      setPrompt(text)
                    }
                    focusComposer()
                  }}
                />
              </div>
            )}
            {/* The menus sit above the editor (their anchor precedes it), so an
                upward menu never covers the line being typed. */}
            {/* @path file reference picker popover */}
            {/* Shown wherever a folder is attached -- Cowork included, which
                is not "agent mode" -- because that folder is all it offers.
                Library prompts are offered with or without one. */}
            {filePickerOpen && (
              <div className="relative">
                <FilePickerPopover
                  triggerChar={menuTrigger}
                  emptyMessage={
                    menuTrigger === '#' ||
                    /^(chat|session|room):/.test(filePickerQuery)
                      ? listConversations().some(
                          (c) => c.id !== (scopeKey ?? currentThreadId)
                        )
                        ? t('common:mentions.noMatch')
                        : t('common:mentions.empty')
                      : undefined
                  }
                  entries={filePickerEntries}
                  query={filePickerQuery}
                  open={filePickerOpen}
                  activeIndex={referenceActive}
                  onActiveChange={setReferenceActive}
                  onSelect={handleFilePickerSelect}
                  onClose={handleFilePickerClose}
                  listId={referenceListId}
                  aliasDraft={aliasDraft}
                  aliasError={aliasError}
                  onAliasSave={handleAliasSave}
                  onAliasCancel={handleAliasCancel}
                />
              </div>
            )}
            <MentionChips
              prompt={prompt}
              currentId={scopeKey ?? currentThreadId}
              onChange={setPrompt}
              canSummarize={canSummarize}
              previews={mentionPreviews}
              contextWindow={mentionContextWindow}
            />
            <RichComposerEditor
              ref={richComposerRef}
              value={prompt}
              mentions={mentionPreviews}
              onChange={(markdown) => {
                filePickerCursorPos.current = mentionTrigger(markdown)
                  ? markdown.length
                  : null
                handlePromptChange(markdown)
                slashCommands.onTextChange(markdown)
              }}
              onSend={(markdown, steer) => {
                if (!ingestingAny && (markdown.trim() || hasSendableMedia)) {
                  void handleSendMessage(markdown, { steer })
                }
              }}
              onPaste={handlePaste}
              enterInsertsNewline={enterKeyInsertsNewline}
              onKeyDownCapture={(event) => {
                largePaste.noteKeyDown(event)
                if (event.nativeEvent.isComposing) return
                // Esc ends a tool call that is running (the Stop button's twin).
                if (
                  event.key === 'Escape' &&
                  toolInFlight &&
                  !isStreaming &&
                  !slashCommands.open &&
                  !filePickerOpen
                ) {
                  event.preventDefault()
                  stopStreaming(currentThreadId ?? '')
                  return
                }
                // Backspace in an empty box takes the last chip back off, with undo.
                if (
                  event.key === 'Backspace' &&
                  // A held key removes one chip, not the whole row.
                  !event.repeat &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.altKey &&
                  !event.shiftKey &&
                  prompt.length === 0
                ) {
                  const last = attachments.length - 1
                  if (last >= 0 && !attachments[last].processing) {
                    event.preventDefault()
                    removeAttachmentWithUndo(last)
                    return
                  }
                }
                if (slashCommands.open) {
                  const highlighted =
                    slashCommands.visible[slashCommands.activeIndex]
                  const selection = slashCommands.onKeyDown(event)
                  if (typeof selection === 'string') {
                    const lib = highlighted?.builtin?.promptId
                      ? libraryPrompts.find(
                          (p) => p.id === highlighted.builtin?.promptId
                        )
                      : undefined
                    if (lib) {
                      setPrompt('')
                      beginPromptInsert(lib, (out) => setPrompt(out))
                    } else {
                      setPrompt(selection)
                    }
                  }
                  if (event.defaultPrevented) return
                }
                // Prompt history: Up at the very start, Down at the very end.
                if (
                  (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
                  !filePickerOpen &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  const edge = richComposerRef.current?.caretEdge()
                  const wanted = event.key === 'ArrowUp' ? 'start' : 'end'
                  if (edge === wanted || edge === 'both') {
                    event.preventDefault()
                    navigateHistory(event.key === 'ArrowUp' ? 'up' : 'down')
                    return
                  }
                }
                handleReferenceKeyDown(event)
              }}
              placeholder={t('common:placeholder.chatInput')}
              className={className}
              domAttributes={{
                'data-testid': 'chat-input',
                // The `@` menu is a listbox the composer drives; these tell
                // assistive technology which row is active without moving focus.
                'aria-autocomplete': 'list',
                'aria-controls': slashCommands.open
                  ? slashListId
                  : filePickerOpen
                    ? referenceListId
                    : undefined,
                'aria-activedescendant':
                  slashCommands.open && slashCommands.visible.length > 0
                    ? slashOptionId(slashListId, slashCommands.activeIndex)
                    : filePickerOpen && filePickerEntries.length > 0
                      ? optionId(referenceListId, referenceActive)
                      : undefined,
                spellcheck: String(spellCheckChatInput),
                'data-gramm': String(spellCheckChatInput),
              }}
            />
            <PromptFillDialog
              prompt={promptFill?.prompt ?? null}
              onSubmit={(text) => {
                promptFill?.apply(text)
                setPromptFill(null)
                setTimeout(() => focusComposer(), 0)
              }}
              onCancel={() => {
                promptFill?.cancel?.()
                setPromptFill(null)
                setTimeout(() => focusComposer(), 0)
              }}
            />
            <span
              role="status"
              aria-live="polite"
              className="sr-only"
              data-testid="reference-status"
            >
              {workingDir ? referenceStatus : ''}
            </span>
          </div>
        </div>

        <div
          ref={footerRef}
          data-composer-footer
          className="absolute z-20 bg-transparent bottom-0 w-full p-2"
        >
          <div
            ref={controlsRowRef}
            data-testid="composer-controls-row"
            className="flex justify-between items-center w-full"
          >
            {/* One row, never two: when the pane is narrow the controls give
                up their text labels (ComposerDensity) and, past that, clip
                here, so the send button at the right is never pushed out. */}
            <div className="flex flex-nowrap items-center gap-x-0.5 flex-1 min-w-0 overflow-hidden">
              {/* Assistant, sampling, tools, web search and reasoning stay
                  live while a reply streams: they configure the *next*
                  message (each request reads them when it is sent), so
                  freezing them only made the user wait. Attachments are the
                  exception: a message queued behind a run carries text only. */}
              <div className="flex items-center gap-0.5">
                {/* Dropdown for attachments — hidden in agent mode */}
                {!effectiveAgentMode && (
                  <ComposerAttachMenu
                    disabled={isStreaming}
                    fileInputRef={fileInputRef}
                    accept={attachmentAccept}
                    onFileChange={handleFileChange}
                    onPickImages={() => void openImagePicker()}
                    onPickAudio={() => {
                      if (audioSupported) void openAudioPicker()
                      else requestCapabilities(['audio'], openAudioPicker)
                    }}
                    onPickVideo={() => {
                      if (videoSupported) void openVideoPicker()
                      else requestCapabilities(['video'], openVideoPicker)
                    }}
                    onPickDocuments={() => {
                      // A model without tools still takes documents: they
                      // go into the prompt as text (janhq/jan#9388).
                      if (!toolsEnabled) {
                        toast.info(t('sweep:chat.docsInPrompt'), {
                          description: t('sweep:chat.docsInPromptDescription'),
                        })
                      }
                      void handleAttachDocsIngest()
                    }}
                    ingestingDocs={ingestingDocs}
                  />
                )}
                {/* {model?.provider === 'llamacpp' && loadingModel ? (
                  <ModelLoader />
                ) : (
                  <DropdownModelProvider
                    model={model}
                    useLastUsedModel={initialMessage}
                  />
                )} */}
                {(() => {
                  // The model's less-used knobs: inline in a chat, behind one
                  // Options button where the surface asks for a quieter row.
                  // Web search is a row in the parameters panel, not a
                  // button of its own.
                  const webSearchToggle =
                    !effectiveAgentMode && toolsEnabled
                      ? {
                          enabled: webSearchEnabled,
                          onChange: setWebSearchEnabled,
                        }
                      : undefined
                  const shellToggle =
                    slashSurface !== 'cowork' &&
                    toolsEnabled &&
                    agentToolsOn &&
                    sandboxEnforcesShell
                      ? { enabled: chatShellOn, onChange: setChatShellOn }
                      : undefined
                  const options = (
                    <>
                <AssistantSwitcher
                  assistants={assistants}
                  currentThread={slashSurface === 'cowork' ? undefined : currentThread}
                  selectedAssistantId={selectedAssistantId}
                  setSelectedAssistantId={setSelectedAssistantId}
                        updateCurrentThreadAssistant={
                          updateCurrentThreadAssistant
                        }
                />
                <SamplerPopover
                  providerId={selectedProvider}
                  modelId={selectedModel?.id}
                  draftOffThread={slashSurface !== 'cowork'}
                  webSearch={groupOptions ? undefined : webSearchToggle}
                  shell={groupOptions ? undefined : shellToggle}
                  assistantSwitcher={{
                    assistants,
                    currentThread: slashSurface === 'cowork' ? undefined : currentThread,
                    selectedAssistantId,
                    setSelectedAssistantId,
                    updateCurrentThreadAssistant,
                  }}
                />
                      {showToolControls && (
                        <ComposerToolControls
                          hasEmbeddings={Boolean(
                            selectedModel?.capabilities?.includes('embeddings')
                          )}
                          hasModel={Boolean(selectedModel)}
                          toolsEnabled={toolsEnabled}
                          onEnableTools={() =>
                            requestCapabilities(['tools'], () => {})
                          }
                        />
                      )}

                {/* Cowork has no chat agent mode of its own; the flag read
                    above belongs to whichever chat thread was last open. */}
                {/* The effort bar (under the composer) is the reasoning control
                    wherever the model has one; this menu is only for models
                    that size their own thinking and so have no bar. */}
                {(!effectiveAgentMode || slashSurface === 'cowork') &&
                  effortLevels.length === 0 &&
                  // A local model with no effort bar does not reason (C052).
                  !localModelWithoutReasoning &&
                  selectedProvider &&
                  (REASONING_MENU_PROVIDERS as readonly string[]).includes(
                    selectedProvider
                  ) && (
                    <ComposerReasoningMenu
                      selectedProvider={selectedProvider}
                      modelSettings={selectedModel?.settings}
                      chatOverridesReasoning={isOverridden(
                        chatOverrides,
                        'reasoning'
                      )}
                      reasoningDefault={reasoningDefault}
                      approxContextSize={
                        liveMaxTokens || configuredCtxLen || 8192
                      }
                      onSetting={(key, title, value) =>
                        updateModelSetting(key, title, 'dropdown', value)
                      }
                    />
                  )}
                    </>
                  )
                  if (!groupOptions) return options
                  return (
                    <ComposerOptionsMenu
                      label={t('common:composerOptions')}
                      webSearch={webSearchToggle}
                      shell={shellToggle}
                      active={
                        webSearchEnabled && !effectiveAgentMode
                          ? [t('common:web_search')]
                          : []
                      }
                    >
                      {options}
                    </ComposerOptionsMenu>
                  )
                })()}
              </div>
              {surfaceControls && (
                // Same 2px rhythm as the buttons before it: one group.
                <div className="flex min-w-0 flex-nowrap items-center gap-0.5">
                  <ComposerDensityProvider width={controlsWidth}>
                    {surfaceControls}
                  </ComposerDensityProvider>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {tokenCounterVisible && tokenCounterCompact && (
                <div className="flex-1 flex justify-center">
                  <TokenCounter
                    messages={threadMessages || []}
                    source={counterSource}
                    additionalTokens={pendingTokens}
                    compact={true}
                    onCompact={compactFromCounter}
                    onSetPrice={openPriceSettings}
                  />
                </div>
              )}

              {/* Dictation: speech to text on this computer, spliced in at
                  the caret. */}
              <VoiceInputButton
                composer={{
                  getValue: () =>
                    draftScope
                      ? (usePrompt.getState().scoped?.[draftScope]?.prompt ?? '')
                      : usePrompt.getState().prompt,
                  // The rich editor's caret has no Markdown offset, so
                  // dictated text is appended to the draft.
                  getCaret: () => null,
                  apply: (value) => {
                    setPrompt(value)
                  },
                }}
              />

              {/* A surface that owns its own stop control -- Cowork, which
                  asks how far to stop -- supplies it here, in the same slot,
                  so there is never a second stop button beside this one. */}
              {isStreaming && stopControl ? (
                stopControl
              ) : (
                <ComposerSendButton
                  isStreaming={isStreaming}
                  toolInFlight={toolInFlight}
                  onStop={() => {
                    // Stop always stops the run. What is queued is held,
                    // not cleared: each chip then offers Send and
                    // Discard. Held first, so the stopping run cannot
                    // take a steering message on its way out.
                    holdQueueThenStop([queueId], () =>
                      stopStreaming(currentThreadId ?? '')
                    )
                  }}
                  canSend={
                    !((!prompt.trim() && !hasSendableMedia) || ingestingAny || sending)
                  }
                  ready={Boolean((prompt.trim() || hasSendableMedia) && !ingestingAny)}
                  sending={sending}
                  onSend={() => handleSendMessage(prompt)}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Under the composer, as Claude lays it out: what the run may do on the
          left; the reasoning effort and the model on the right. Wraps, never
          clips. */}
      {(belowLeft || belowLeftWithEffort || modelControl || effortLevels.length > 0) && (
        <div
          data-testid="composer-model-row"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-1"
        >
          {(belowLeft || belowLeftWithEffort) && (
            <div
              data-testid="composer-below-left"
              className="flex min-w-0 max-w-full flex-wrap items-center gap-0.5"
            >
              {belowLeft}
              {belowLeftWithEffort?.({
                effort: effortControl,
                effortOverridden: effortLevels.length > 0 && effortOverridden,
                effortLabel:
                  effortLevels.length > 0 && currentEffort
                    ? String(currentEffort)
                    : null,
              })}
            </div>
          )}
          {/* Takes the room left beside the run controls and shrinks the model
              name into it, wrapping only when less than 7rem is left. */}
          <div className="ml-auto flex min-w-0 max-w-full flex-[1_1_7rem] items-center justify-end gap-1">
            {!belowLeftWithEffort && effortControl}
            {modelControl && (
              <div className="flex min-w-20 max-w-64 shrink justify-end">
                {modelControl}
              </div>
            )}
          </div>
        </div>
      )}

      {webOffPrompt !== null && (
        <WebSearchOffPrompt
          onEnable={() => {
            const held = webOffPrompt
            setWebSearchEnabled(true)
            void handleSendMessage(held, { allowNoWeb: true })
          }}
          onSendAnyway={() => {
            const held = webOffPrompt
            void handleSendMessage(held, { allowNoWeb: true })
          }}
        />
      )}

      {message && (
        <ComposerErrorLine
          message={message}
          onDismiss={() => {
            setMessage('')
            // Reset file input to allow re-uploading the same file
            if (fileInputRef.current) {
              fileInputRef.current.value = ''
            }
          }}
        />
      )}

      {tokenCounterVisible && !tokenCounterCompact && (
        <div className="flex-1 w-full flex justify-start px-2">
          <TokenCounter
            messages={threadMessages || []}
            source={counterSource}
            additionalTokens={pendingTokens}
            onCompact={compactFromCounter}
            onSetPrice={openPriceSettings}
          />
        </div>
      )}

      {viewerAt !== null && composerImages.length > 0 && (
        <ImageViewer
          images={composerImages}
          index={Math.min(viewerAt, composerImages.length - 1)}
          onIndexChange={setViewerAt}
          onClose={() => setViewerAt(null)}
        />
      )}

      <input
        type="file"
        ref={media.audio.inputRef}
        className="hidden"
        multiple
        accept="audio/wav,audio/mpeg,.wav,.mp3"
        onChange={media.audio.onInputChange}
      />
      <input
        type="file"
        ref={media.video.inputRef}
        className="hidden"
        multiple
        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.mp4,.mov,.webm,.mkv,.avi,.m4v"
        onChange={media.video.onInputChange}
      />

      <VisionDisabledDialog
        open={visionPrompt !== null}
        fileNames={(visionPrompt?.blocked ?? []).map((file) => file.name)}
        modelName={selectedModel ? getModelDisplayName(selectedModel) : ''}
        canEnable={visionPrompt?.canEnable ?? false}
        onChoose={(choice) => void handleVisionChoice(choice)}
      />

      <EnableModelCapabilityDialog
        open={capabilityPrompt !== null}
        modelName={selectedModel ? getModelDisplayName(selectedModel) : ''}
        capabilities={capabilityPrompt?.capabilities ?? []}
        onEnable={handleEnableCapabilities}
        onCancel={() => setCapabilityPrompt(null)}
      />
    </div>
  )
})

export default ChatInput
