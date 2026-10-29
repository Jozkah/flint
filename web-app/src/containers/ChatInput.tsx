import { stripInvisible } from '@/lib/invisibleText'
import { canModelSummarize } from '@/lib/continueFromSummary'
import { refusedDraftToRestore, unescapeComposerMarkdown } from '@/lib/composerText'
import { pendingComposerTokens } from '@/lib/context-manager'
import { isSendableAttachment } from '@/lib/attachmentChip'
import { offerToEnableMentionedServers } from '@/lib/mcpMention'
import { toAssetUrl } from '@/lib/assetPath'
import {
  dropFilePaths,
  pasteFilePaths,
  pastedPath,
  transferText,
  withoutPastedPath,
} from '@/lib/fileDrop'
import { readDroppedPaths } from '@/lib/droppedPaths'
import { promptReplaceModels } from '@/hooks/useModelReplacePrompt'
import { modelKey, unavailableModels } from '@/lib/modelReplace'
import { currentDescriber } from '@/lib/imageDescription'
import { ImageViewer } from '@/components/ImageViewer'
import { needsWeb } from '@/lib/needsWeb'
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
import { generateId } from 'ai'
import {
  holdQueueThenStop,
  withdrawApprovalsForSteering,
} from '@/lib/chatSteering'
import { useMessageQueue } from '@/stores/message-queue-store'
import { QueuedMessageList } from '@/containers/QueuedMessageBubble'
import { SamplerPopover } from '@/containers/SamplerPopover'
import { useDraftSampling } from '@/hooks/useDraftSampling'
import { useLargePaste } from '@/hooks/useLargePaste'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { resolveReplyModel } from '@/lib/resolveReplyModel'
import { VoiceInputButton } from '@/containers/VoiceInputButton'
import { DropRim } from '@/components/ui/drop-rim'
import { ComposerAttachmentChips } from '@/containers/ComposerAttachmentChips'
import { dragFileCount } from '@/lib/attachmentChip'
import {
  useConversationModel,
  type ModelSelection,
} from '@/hooks/useConversationPane'
import { useTokensCount } from '@/hooks/useTokensCount'
import { ComposerEffort } from '@/containers/ComposerEffort'
import {
  EFFORT_SETTING_KEY,
  effortOf,
  effortProfile,
  isThinkingOff,
  type EffortChoice,
} from '@/lib/modelEffort'
import {
  isOverridden,
  resolveModel,
  withSettings,
  type SettingWrite,
} from '@/lib/modelOverrides'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { withReasoningDefault } from '@/lib/reasoningDefault'
import { useModelToolsEnabled } from '@/hooks/useThreadToolGrants'
import { useReconcileVideoCapability } from '@/hooks/useReconcileVideoCapability'

import { useAppState } from '@/hooks/useAppState'
import type { ChatStatus } from 'ai'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  DOCUMENT_ATTACHMENT_EXTENSIONS,
  isDocumentAttachmentName,
} from '@/constants/attachments'
import {
  TEMPORARY_CHAT_ID,
  TEMPORARY_CHAT_QUERY_ID,
  SESSION_STORAGE_PREFIX,
} from '@/constants/chat'
import { resolveThreadModelId } from '@/lib/models'
import { useAssistant } from '@/hooks/useAssistant'
import { AssistantSwitcher } from '@/containers/AssistantSwitcher'
import { ComposerOptionsMenu } from '@/containers/ComposerOptionsMenu'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTools } from '@/hooks/useTools'
import { TokenCounter } from '@/components/TokenCounter'
import type { TokenUsageSource } from '@/hooks/useTokensCount'
import { useActiveMessages } from '@/hooks/useActiveMessages'
import { useShallow } from 'zustand/react/shallow'
import {
  ExtensionTypeEnum,
  fs,
  VectorDBExtension,
} from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { useAttachments } from '@/hooks/useAttachments'
import { toast } from 'sonner'
import {
  requestChatCompaction,
  requestChatSideQuestion,
} from '@/lib/chatCompaction'
import { isPlatformTauri } from '@/lib/platform/utils'
import { useAttachmentIngestionPrompt } from '@/hooks/useAttachmentIngestionPrompt'
import {
  NEW_THREAD_ATTACHMENT_KEY,
  useChatAttachments,
} from '@/hooks/useChatAttachments'
import { VisionDisabledDialog } from '@/containers/dialogs/VisionDisabledDialog'
import { EnableModelCapabilityDialog } from '@/containers/dialogs/EnableModelCapabilityDialog'
import {
  enableModelCapabilities,
  type EnableableCapability,
} from '@/lib/modelCapabilityEnable'

import { acceptAttribute } from '@/lib/attachmentSupport'
import { safeSessionSet } from '@/lib/safeStorage'
import {
  clipboardImageFiles,
  clipboardMayHoldImage,
  missingMediaCapabilities,
  pastedImageFiles,
  pastedMediaFiles,
  splitDroppedFiles,
} from '@/lib/composerIntake'
import {
  withoutAttachment,
  withoutSent,
} from '@/lib/attachmentIntake'
import {
  Attachment,
  createDocumentAttachment,
} from '@/types/attachment'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useComposerFocus } from '@/hooks/useComposerFocus'
import { useLatestCallback } from '@/hooks/useLatestCallback'
import { useMediaAttachments } from '@/hooks/useMediaAttachments'
import { ComposerAttachMenu } from '@/containers/ComposerAttachMenu'
import { ComposerToolControls } from '@/containers/ComposerToolControls'
import {
  ComposerReasoningMenu,
  REASONING_MENU_PROVIDERS,
} from '@/containers/ComposerReasoningMenu'
import { ComposerSendButton } from '@/containers/ComposerSendButton'
import {
  ComposerErrorLine,
  PathOfferBanner,
  WebSearchOffPrompt,
} from '@/containers/ComposerBanners'
import { useImageAttachments } from '@/hooks/useImageAttachments'
import { useWebSearchChoice, useWebSearchOn } from '@/hooks/useWebSearchChoice'
import { useChatShell } from '@/hooks/useChatShell'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { getSandboxStatus } from '@/lib/agentTools'
import {
  formatPathReferenceText,
  parsePromptForReferences,
  stripPromptReferences,
  typedReference,
} from '@/lib/path-references'
import {
  resolveReference,
  searchReferences,
  unresolvedReferenceNote,
} from '@/lib/safeReferences'
import {
  optionId,
  rankReferences,
  type NamedSource,
  type ReferenceEntry,
} from '@/lib/referenceMenu'
import { resolveAlias, useReferenceAliases } from '@/lib/referenceAliases'
import { TRIGGER_TAIL, mentionTrigger } from '@/lib/chatMentions'
import { listConversations, listConversationsAsync } from '@/lib/chatMentionSources'
import { resolvePromptMentions, withMentionBlocks } from '@/lib/chatMentionSend'
import { MentionChips } from '@/containers/MentionChips'
import { useMentionPreview } from '@/hooks/useMentionPreview'
import { knownContextWindow } from '@/lib/knownContextWindow'
import { modelSummarizer } from '@/lib/compactionSummarizer'
import { getServiceHub } from '@/hooks/useServiceHub'
import { FilePickerPopover } from '@/components/FilePickerPopover'
import { PromptFillDialog } from '@/containers/PromptFillDialog'
import {
  fillPrompt,
  parseVars,
  promptSlug,
  usePromptLibrary,
  type LibraryPrompt,
} from '@/lib/promptLibrary'
import { SlashCommandMenu } from '@/components/SlashCommandMenu'
import { slashOptionId } from '@/lib/slashCommands'
import { useSlashCommands, type SlashSurface } from '@/hooks/useSlashCommands'
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
  const serviceHub = useServiceHub()
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
  const setThreadOverride = useModelOverrides((state) => state.setForThread)
  const clearThreadOverride = useModelOverrides((state) => state.clearForThread)
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
  const createThread = useThreads((state) => state.createThread)
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

  const [filePickerOpen, setFilePickerOpen] = useState(false)
  // The image viewer over the composer's attachments: which image is open.
  const [viewerAt, setViewerAt] = useState<number | null>(null)
  const [filePickerQuery, setFilePickerQuery] = useState('')
  const [filePickerEntries, setFilePickerEntries] = useState<ReferenceEntry[]>(
    []
  )
  // The `@` menu's active row, moved from the composer with the arrow keys.
  const [referenceActive, setReferenceActive] = useState(0)
  // A file or folder being named as an alias (AH-205), and why a name failed.
  const [aliasDraft, setAliasDraft] = useState<ReferenceEntry | null>(null)
  const [aliasError, setAliasError] = useState<string | null>(null)
  // Announced: how many references match, or what happened to an alias.
  const [referenceStatus, setReferenceStatus] = useState('')
  // Which character opened the menu: `#` lists conversations only.
  const [menuTrigger, setMenuTrigger] = useState<'@' | '#'>('@')
  // Re-ranks the open menu once the conversation counts have loaded.
  const rerankMenuRef = useRef<(() => void) | null>(null)
  // Whether the menu is open now, for work that finishes after it closed.
  const filePickerOpenRef = useRef(false)
  filePickerOpenRef.current = filePickerOpen
  const referenceListId = useId()
  const slashListId = useId()
  const defaultSlashBuiltins = useMemo<SlashBuiltin[]>(
    () =>
      slashSurface === 'home'
        ? [
            {
              name: 'new',
              description: t('slash:builtin.new'),
              run: () => void router.navigate({ to: route.home }),
            },
            // Only in an open conversation, which registers how to compact
            // itself (`lib/chatCompaction.ts`).
            ...(currentThreadId
              ? [
                  {
                    name: 'compact',
                    description: t('slash:builtin.compact'),
                    argumentHint: '[focus]',
                    run: (args: string) => {
                      if (
                        !requestChatCompaction(
                          currentThreadId,
                          args.trim() || undefined
                        )
                      ) {
                        toast.info(t('common:budget.compactFailed'))
                      }
                    },
                  },
                  {
                    name: 'btw',
                    description: t('slash:builtin.btw'),
                    argumentHint: '<question>',
                    run: (args: string) => {
                      const question = args.trim()
                      if (
                        !question ||
                        !requestChatSideQuestion(currentThreadId, question)
                      ) {
                        toast.info(t('common:budget.btwFailed'))
                      }
                    },
                  },
                ]
              : []),
          ]
        : [],
    [slashSurface, t, router, currentThreadId]
  )
  // Prompt library (AH-prompts): one state for the fill-in dialog, whichever
  // menu started the insert.
  const libraryPrompts = usePromptLibrary((s) => s.prompts)
  const [promptFill, setPromptFill] = useState<{
    prompt: LibraryPrompt
    apply: (text: string) => void
    /** Undoes what started the insert (the typed `@query`). */
    cancel?: () => void
  } | null>(null)
  /** Insert now when the prompt has no variables, else ask for them first. */
  const beginPromptInsert = useCallback(
    (
      prompt: LibraryPrompt,
      apply: (text: string) => void,
      cancel?: () => void
    ) => {
      if (parseVars(prompt.body).length === 0) {
        apply(fillPrompt(prompt.body, {}))
        return
      }
      setPromptFill({ prompt, apply, cancel })
    },
    []
  )
  const promptBuiltins = useMemo<SlashBuiltin[]>(() => {
    const used = new Set<string>()
    return libraryPrompts.map((p) => {
      let slug = promptSlug(p.name)
      for (let n = 2; used.has(slug); n++) slug = `${promptSlug(p.name)}-${n}`
      used.add(slug)
      return {
        name: `prompt:${slug}`,
        description: p.name,
        promptId: p.id,
        // Typed in full and sent: the draft is cleared by the send, so the
        // insert lands after it.
        run: () => {
          setTimeout(() => beginPromptInsert(p, (text) => setPrompt(text)), 0)
        },
      }
    })
  }, [libraryPrompts, beginPromptInsert, setPrompt])
  const slashCommands = useSlashCommands({
    surface: slashSurface,
    project: slashProject,
    builtins: [...(slashBuiltins ?? defaultSlashBuiltins), ...promptBuiltins],
    helpDescription: t('slash:builtin.help'),
  })
  const referenceSkills = referenceSources?.skills
  const referenceAgents = referenceSources?.agents
  const [workingDir, setWorkingDir] = useState<string | undefined>(undefined)
  // Textarea cursor position snapshot at the time @ was typed
  const filePickerCursorPos = useRef<number | null>(null)

  // The folder references may name, and the data folder the confined reader
  // needs. No folder means no references at all -- not the home directory.
  const [referenceDataFolder, setReferenceDataFolder] = useState<
    string | undefined
  >(undefined)
  // Whatever the mode: a surface that attached a folder (Cowork) names it
  // here, and one that did not gets no references at all.
  useEffect(() => {
    setWorkingDir(referenceRoot ?? undefined)
    if (!referenceRoot) return
    let alive = true
    void getServiceHub()
      .app()
      .getJanDataFolder()
      .then((folder) => {
        if (alive) setReferenceDataFolder(folder ?? undefined)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [referenceRoot])

  // Detect `@` in the prompt text and open the file picker
  const handlePromptChange = useCallback(
    (value: string) => {
      setPrompt(value)

      const cursorIdx = filePickerCursorPos.current ?? value.length

      // Look backwards from current cursor to find the last word starting with
      // @ (the @ must not be glued to a preceding word char, so `user@host`
      // never opens the picker), or a `#` that begins a word and is followed
      // by a letter, which lists conversations only. Files need a folder
      // (AH-204); conversations, skills and prompts do not.
      const beforeCursor = value.slice(0, cursorIdx)
      const atMatch = mentionTrigger(beforeCursor)

      if (atMatch) {
        const query = atMatch.query
        setFilePickerQuery(query)
        setMenuTrigger(atMatch.char)

        // One ranked list. The file index is searched through the backend's
        // confined listing; if it cannot be read the rest are still offered,
        // and typing is never waited on.
        const rank = (files: Awaited<ReturnType<typeof searchReferences>>) => {
          const ranked = rankReferences(query, {
            files,
            skills: referenceSkills ?? [],
            agents: referenceAgents ?? [],
            aliases: useReferenceAliases.getState().list(workingDir),
            prompts: libraryPrompts.map((p) => ({
              id: p.id,
              name: p.name,
              detail: p.folder ?? p.body.slice(0, 80),
            })),
            conversations: listConversations(),
            currentConversationId: scopeKey ?? currentThreadId,
          }, 50, atMatch.char)
          setFilePickerEntries(ranked)
          setReferenceActive(0)
          setReferenceStatus(
            ranked.length === 0
              ? t('chat:composer.referencesNone')
              : t('chat:composer.references', { count: ranked.length })
          )
          rerankMenuRef.current = () => rank(files)
        }
        // Counts and previews of the chats load once per menu opening, then
        // the open menu is ranked again with them.
        if (!filePickerOpen) {
          void listConversationsAsync().then(() => {
            // The menu may have closed while this loaded; ranking it again
            // would announce a status for a menu nobody sees.
            if (filePickerOpenRef.current) rerankMenuRef.current?.()
          })
        }
        const fileQuery =
          atMatch.char === '#' ||
          /^(skill|agent|alias|prompt|chat|session|room):/.test(query)
            ? null
            : query
        if (workingDir && referenceDataFolder && fileQuery !== null) {
          searchReferences(referenceDataFolder, workingDir, fileQuery)
            .then(rank)
            .catch(() => rank([]))
        } else {
          rank([])
        }
        setFilePickerOpen(true)
      } else {
        setFilePickerOpen(false)
      }
    },
    [
      t,
      workingDir,
      referenceDataFolder,
      setPrompt,
      referenceSkills,
      referenceAgents,
      libraryPrompts,
      scopeKey,
      currentThreadId,
      filePickerOpen,
    ]
  )

  // Insert the selected reference into the prompt
  const handleFilePickerSelect = useCallback(
    (entry: ReferenceEntry) => {
      if (filePickerCursorPos.current == null) return

      const beforeCursor = prompt.slice(0, filePickerCursorPos.current)
      const afterCursor = prompt.slice(filePickerCursorPos.current)

      // Replace the `@query` with the entry's token
      const textBefore = beforeCursor.replace(TRIGGER_TAIL, '$1')
      // The identifier, not the label: a folder-relative path, or a typed
      // reference. It means the same thing however it is displayed, and a
      // path cannot name anything outside the folder.
      // A library prompt is pasted as text, not left as a reference.
      if (entry.kind === 'prompt') {
        const found = libraryPrompts.find(
          (p) => `prompt:${p.id}` === entry.token
        )
        setFilePickerOpen(false)
        filePickerCursorPos.current = null
        if (found) {
          beginPromptInsert(
            found,
            (text) => setPrompt(textBefore + text + afterCursor),
            // Cancelling leaves no dangling `@query` behind.
            () => setPrompt(textBefore + afterCursor)
          )
        }
        setTimeout(() => focusComposer(), 0)
        return
      }
      const refText = formatPathReferenceText(entry.token) + ' '
      const newPrompt = textBefore + refText + afterCursor

      setPrompt(newPrompt)
      setFilePickerOpen(false)
      filePickerCursorPos.current = null

      // Focus back on textarea
      setTimeout(() => focusComposer(), 0)
    },
    [prompt, setPrompt, libraryPrompts, beginPromptInsert, focusComposer]
  )

  const handleFilePickerClose = useCallback(() => {
    setFilePickerOpen(false)
    setAliasDraft(null)
    setAliasError(null)
    filePickerCursorPos.current = null
  }, [])

  // Name the file or folder being drafted as an alias (AH-205). Focus goes
  // back to the composer either way, where it was when the draft began.
  const handleAliasSave = useCallback(
    (name: string, lines = '') => {
      if (!aliasDraft) return
      const out = useReferenceAliases
        .getState()
        .add(workingDir, name, aliasDraft.token, lines)
      if (!out.ok) {
        setAliasError(out.message)
        setReferenceStatus(
          t('chat:composer.aliasNotSaved', { message: out.message })
        )
        return
      }
      setAliasDraft(null)
      setAliasError(null)
      setReferenceStatus(
        t('chat:composer.aliasSaved', {
          name: out.alias.name,
          target: out.alias.target,
        })
      )
      setFilePickerEntries((entries) =>
        rankReferences(filePickerQuery, {
          files: entries
            .filter((e) => e.kind === 'file' || e.kind === 'directory')
            .map((e) => ({
              path: e.token,
              name: e.name,
              kind: e.kind as 'file' | 'directory',
              extension: e.extension,
            })),
          skills: referenceSkills ?? [],
          agents: referenceAgents ?? [],
          aliases: useReferenceAliases.getState().list(workingDir),
        })
      )
      setTimeout(() => focusComposer(), 0)
    },
    [
      aliasDraft,
      workingDir,
      filePickerQuery,
      referenceSkills,
      referenceAgents,
      focusComposer,
      t,
    ]
  )

  const handleAliasCancel = useCallback(() => {
    setAliasDraft(null)
    setAliasError(null)
    setTimeout(() => focusComposer(), 0)
  }, [focusComposer])

  // Resolve @path references in the prompt text, returning the resolved content
  const resolvePromptReferences = useCallback(
    async (
      text: string
    ): Promise<{
      text: string
      resolvedContents: string
    }> => {
      const refs = parsePromptForReferences(text)
      // No folder, no references: an `@name` in an ordinary chat is left as
      // typed. It used to be read as a path -- relative to nothing, or
      // absolute -- so `@C:\Users\me\.ssh\id_rsa` put that file in the prompt.
      if (refs.length === 0 || !workingDir)
        return { text, resolvedContents: '' }

      const parts: string[] = []
      const unresolved = new Set<string>()
      for (const ref of refs) {
        const typed = typedReference(ref)
        // A skill reference is acted on by the skill machinery, which reads
        // it from the text; it stays there and needs nothing inlined.
        if (typed?.kind === 'skill') continue
        // A conversation mention is resolved separately, with or without a
        // folder (chatMentionSend.ts).
        if (
          typed?.kind === 'chat' ||
          typed?.kind === 'session' ||
          typed?.kind === 'room'
        )
          continue
        if (typed?.kind === 'agent') {
          const agent = referenceAgents?.find((one) => one.name === typed.name)
          parts.push(
            agent
              ? `[Agent @agent:${agent.name}${agent.description ? `: ${agent.description}` : ''}. To hand work to it, call the task tool with agent "${agent.name}".]`
              : `[Reference @${ref} was not included: there is no saved agent named ${typed.name}]`
          )
          continue
        }
        if (typed?.kind === 'alias') {
          const alias = await resolveAlias(
            referenceDataFolder ?? '',
            workingDir,
            typed.name
          )
          parts.push(
            alias.ok
              ? alias.content
              : `[Reference @${ref} was not included: ${alias.message}]`
          )
          continue
        }
        const resolved = await resolveReference(
          referenceDataFolder ?? '',
          workingDir,
          ref
        )
        if (resolved.ok) {
          parts.push(resolved.content)
        } else {
          unresolved.add(ref)
          // Said in the message, not dropped: the model should know a
          // reference was refused, and why, rather than miss it silently.
          // A name that matched no file stays silent (pasted code, emails).
          const note = unresolvedReferenceNote(ref, resolved)
          if (note) parts.push(note)
        }
      }

      const resolvedContents = parts.join('\n\n')

      // Remove @ references from the prompt text (they'll be replaced by the
      // resolved contents above so the model sees the content directly)
      const cleanText = stripPromptReferences(text, unresolved)

      return { text: cleanText, resolvedContents }
    },
    [workingDir, referenceDataFolder, referenceAgents]
  )

  // Get current thread messages for token counting
  const threadMessages = useActiveMessages(currentThreadId)

  const ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES = 512 * 1024

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
  const updateProvider = useModelProvider((state) => state.updateProvider)
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
  const [isDragOver, setIsDragOver] = useState(false)
  const [dragCount, setDragCount] = useState(0)
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
  const parsePreference = useAttachments((s) => s.parseMode)
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

  const removeQueuedMessage = useCallback(
    (id: string) => {
      useMessageQueue.getState().removeMessage(queueId, id)
    },
    [queueId]
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

  // A send waiting for the replacement model to show; see handleSendMessage.
  const pendingSendRef = useRef<{
    typed: string
    modelId: string
    at: number
    /** The composer text when the send parked; editing it cancels the send. */
    draft: string
    options: { steer: boolean; allowNoWeb: boolean; capabilityAsked: boolean }
  } | null>(null)
  const updateThreadModelFor = useThreads((state) => state.updateThreadModel)
  const confirmThreadModel = (): ModelCheck | Promise<ModelCheck> => {
    // A composer whose host owns the model has its own check (`confirmModel`).
    const saved = modelSelection ? undefined : currentThread?.model
    const gone = unavailableModels([saved])
    // Nothing to ask: stay synchronous, so an ordinary send is no slower.
    if (!currentThread || gone.length === 0) return { status: 'ok' }
    return promptReplaceModels(t('common:modelReplace.thisChat'), gone).then(
      (choices): ModelCheck => {
        const pick = choices?.[modelKey(gone[0])]
        if (!pick) return { status: 'stop' }
        updateThreadModelFor(currentThread.id, pick)
        selectModelProvider(pick.provider, pick.id)
        return { status: 'retry', modelId: pick.id }
      }
    )
  }

  // One send at a time: a mention summary can take minutes before the draft
  // is cleared, and Enter or Send pressed again meanwhile would send twice.
  const sendInFlightRef = useRef(false)
  const [sending, setSending] = useState(false)
  const handleSendMessage = async (
    typedRaw: string,
    options: {
      steer?: boolean
      allowNoWeb?: boolean
      capabilityAsked?: boolean
    } = {}
  ) => {
    // A send the user just confirmed (a capability prompt) is the same send.
    if (sendInFlightRef.current && !options.capabilityAsked) return
    sendInFlightRef.current = true
    setSending(true)
    try {
      await sendMessage(typedRaw, options)
    } finally {
      sendInFlightRef.current = false
      setSending(false)
    }
  }

  const sendMessage = async (
    typedRaw: string,
    {
      steer = false,
      allowNoWeb = false,
      capabilityAsked = false,
    }: { steer?: boolean; allowNoWeb?: boolean; capabilityAsked?: boolean } = {}
  ) => {
    // The composer's Markdown escapes `*`, `_` and friends; the message is
    // sent and shown as typed.
    // Tag characters and bidi controls pasted along with text are hidden
    // instructions the sender cannot see; they never reach the model.
    const typed = stripInvisible(unescapeComposerMarkdown(typedRaw)).text
    // What the composer held when this send began; typing after that is not
    // part of the message and must survive the clear.
    const draftAtStart = latestPromptRef.current
    setWebOffPrompt(null)
    if (!allowNoWeb && !webSearchEnabled && needsWeb(typed)) {
      setWebOffPrompt(typed)
      return
    }
    // A model that has gone away is replaced with the user's say before the
    // message goes, not silently swapped for whatever the picker holds.
    if (!slashCommands.isBuiltin(typed)) {
      const check = (confirmModel ?? confirmThreadModel)()
      const checked = check instanceof Promise ? await check : check
      if (checked.status === 'stop') return
      if (checked.status === 'retry') {
        // The replacement is already the selected model: no switch is coming
        // for the effect below to see, so send now rather than park forever.
        if (selectedModel?.id !== checked.modelId) {
          pendingSendRef.current = {
            typed,
            modelId: checked.modelId,
            at: Date.now(),
            draft: draftAtStart,
            options: { steer, allowNoWeb, capabilityAsked },
          }
          return
        }
      }
    }
    if (!selectedModel && !slashCommands.isBuiltin(typed)) {
      // Nothing is selected yet: pick the model that should answer and send
      // once it shows, rather than stopping at a message. A model that went
      // away is the user's to replace, so that case keeps its own message.
      if (!unavailableModel) {
        const pick = resolveReplyModel({
          providers: allProviders,
          preferred: preferredModel,
          lastUsed: getLastUsedModel(),
        })
        if (pick) {
          pendingSendRef.current = {
            typed,
            modelId: pick.model,
            at: Date.now(),
            draft: draftAtStart,
            options: { steer, allowNoWeb, capabilityAsked },
          }
          selectModelProvider(pick.provider, pick.model)
          return
        }
      }
      setMessage(
        unavailableModel
          ? t('chat:composer.modelUnavailable', { model: unavailableModel })
          : t('chat:composer.selectModel')
      )
      return
    }
    if (selectedModel && !capabilityAsked) {
      const missing: EnableableCapability[] = []
      for (const [attachmentType, capability] of [
        ['image', 'vision'],
        ['audio', 'audio'],
        ['video', 'video'],
      ] as const) {
        if (
          attachments.some(
            (attachment) => attachment.type === attachmentType
          ) &&
          !selectedModel.capabilities?.includes(capability)
        ) {
          missing.push(capability)
        }
      }
      // A model that cannot see still gets its images, described by one that
      // can, so a missing vision capability is no reason to hold the message.
      // A local model that might see with its mmproj is still offered that.
      const describer = missing.includes('vision') ? currentDescriber() : null
      if (describer) {
        let mightSee = false
        if (selectedProvider === 'llamacpp') {
          try {
            mightSee = await serviceHub.models().checkMmprojExists(selectedModel.id)
          } catch {
            mightSee = false
          }
        }
        if (!mightSee) {
          missing.splice(missing.indexOf('vision'), 1)
          toast.info(
            t('chat:composer.describeFirst', {
              model: selectedModel.name ?? selectedModel.id,
              describer: describer.modelId,
            })
          )
        }
      }
      if (missing.length > 0) {
        if (missing.includes('vision') && selectedProvider === 'llamacpp') {
          let canSeeImages = false
          try {
            canSeeImages = await serviceHub
              .models()
              .checkMmprojExists(selectedModel.id)
          } catch (error) {
            console.error('Failed to check mmproj support:', error)
          }
          if (!canSeeImages) {
            setMessage(t('common:attachFiles.visionDisabled.needsMmproj'))
            return
          }
        }
        requestCapabilities(missing, () =>
          handleSendMessage(typed, { steer, allowNoWeb, capabilityAsked: true })
        )
        return
      }
    }
    // A `/command` expands into what the model receives; a built-in runs here
    // and sends nothing. Anything that names no known command is sent as typed.
    const slash = await slashCommands.prepareSend(typed)
    if (slash.kind === 'handled') {
      setPrompt('')
      return
    }
    if (slash.kind === 'error') {
      toast.error(
        t('slash:error', {
          command: typed.trim().split(/\s/)[0],
          error: slash.error,
        })
      )
      return
    }
    const prompt = slash.kind === 'message' ? slash.text : typed

    // Resolve @path references before sending
    const { text: resolvedText, resolvedContents } =
      await resolvePromptReferences(prompt)
    const referencedPrompt = resolvedContents
      ? `${resolvedText}\n\n---\nReferenced file contents:\n\n${resolvedContents}`
      : resolvedText
    // Mentioned conversations: bounded, redacted excerpts, fenced as data.
    // A missing one becomes a note; nothing here blocks the send.
    const mentions = await resolvePromptMentions(prompt, {
      currentId: scopeKey ?? currentThreadId,
      agentSurface: !ownsToolSet || effectiveAgentMode,
      summarize:
        canSummarize && selectedModel?.id
          ? (transcript) =>
              modelSummarizer({
                provider: selectedProvider ?? '',
                modelId: selectedModel.id,
                session: scopeKey ?? currentThreadId ?? 'mention',
              })(transcript)
          : undefined,
    })
    const effectivePrompt = withMentionBlocks(referencedPrompt, mentions)

    // Files can be attached, or finish ingesting, while @references and
    // mentions resolve above; what is sent is what is attached now, not what
    // the render that started the send saw.
    const liveAttachments = useChatAttachments
      .getState()
      .getAttachments(attachmentsKey)
    if (!effectivePrompt.trim() && !liveAttachments.some(isSendableAttachment)) {
      return
    }
    if (liveAttachments.some((a) => a.processing)) {
      toast.info(t('sweep:chat.waitAttachments'))
      return
    }

    setMessage('')
    addToHistory(slash.kind === 'message' ? typed : referencedPrompt)
    // Names an MCP server that is off? Offer to turn it on. Never blocks the send.
    void offerToEnableMentionedServers(prompt)

    // Use onSubmit prop if available (AI SDK), otherwise create thread and navigate
    if (onSubmit) {
      // When the model is still streaming, or the previous turn's tools are
      // still pending or running, queue the message for later
      if ((isStreaming || threadBusy) && queueId) {
        // Queued to go as its own turn after the run, unless the user asked
        // (Ctrl+Enter) to hand it to the running turn at its next safe point.
        useMessageQueue.getState().enqueue(queueId, {
          id: generateId(),
          text: effectivePrompt,
          createdAt: Date.now(),
          ...(steer ? { steer: true } : {}),
        })
        if (steer) withdrawApprovalsForSteering(queueId)
        setPrompt('')
        return
      }

      const imageFiles = liveAttachments
        .filter((att) => att.type === 'image' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.mimeType ?? 'image/jpeg',
          url: att.dataUrl!,
        }))
      const audioFiles = liveAttachments
        .filter((att) => att.type === 'audio' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          url: att.dataUrl!,
        }))
      const videoFiles = liveAttachments
        .filter((att) => att.type === 'video' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.mimeType ?? 'video/mp4',
          url: att.dataUrl!,
        }))
      const files = [...imageFiles, ...audioFiles, ...videoFiles]

      const sentAttachments = liveAttachments
      onSubmit(effectivePrompt, files.length > 0 ? files : undefined, () => {
        // After the clear below, which a synchronous refusal would precede.
        queueMicrotask(() => {
          // Not over something typed since. The render that follows the clear
          // may not have happened yet, so the sent text counts as empty too.
          const restore = refusedDraftToRestore(
            latestPromptRef.current,
            typedRaw
          )
          if (restore !== null) {
            restoredDraftRef.current = restore
            setPrompt(restore)
          }
          if (sentAttachments.length > 0) {
            setAttachmentsForThread(attachmentsKey, (prev) =>
              prev.length > 0 ? prev : sentAttachments
            )
          }
        })
      })
      // Not over something typed while the send was resolving.
      if (latestPromptRef.current === draftAtStart) setPrompt('')
      // Only what was sent: a file attached after the list was read stays.
      setAttachmentsForThread(attachmentsKey, (prev) =>
        withoutSent(prev, sentAttachments)
      )
    } else {
      // No onSubmit provided - create a new thread and navigate to it.
      // Media attachments (image/audio/video) are NOT serialized into
      // sessionStorage — their base64 data URLs blow past the ~5MB quota
      // (esp. video). They live in the in-memory attachments store and are
      // transferred to the new thread's key on the detail page (see the
      // transferAttachments effect); processAndSendMessage reads them there.
      const isTemporaryChat = window.location.search.includes(
        `${TEMPORARY_CHAT_QUERY_ID}=true`
      )

      const messagePayload = {
        text: effectivePrompt,
        files: [] as Array<{ type: string; mediaType: string; url: string }>,
      }

      if (isTemporaryChat) {
        // For temporary chat, flag the navigation to the temporary thread
        safeSessionSet('temp-chat-nav', 'true')
        // Not taken by a temporary chat: forget it so it cannot leak into a later one.
        useDraftSampling.getState().clearAll()
        // Transfer agent mode from home screen to temporary thread
        if (isAgentMode && agentModeKey !== TEMPORARY_CHAT_ID) {
          useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
          useAgentMode.getState().removeThread(agentModeKey)
        }
        router.navigate({
          to: route.threadsDetail,
          params: { threadId: TEMPORARY_CHAT_ID },
        })
      } else {
        // Get project metadata and assistant if projectId is provided
        let projectMetadata:
          | { id: string; name: string; updated_at: number }
          | undefined
        let projectAssistantId: string | undefined
        let projectModel: { id: string; provider: string } | undefined

        if (projectId) {
          try {
            const project = await serviceHub
              .projects()
              .getProjectById(projectId)
            if (project) {
              projectMetadata = {
                id: project.id,
                name: project.name,
                updated_at: project.updated_at,
              }
              projectAssistantId = project.assistantId
              projectModel = project.model
            }
          } catch (e) {
            console.warn('Failed to fetch project metadata:', e)
          }
        }

        // Only use assistant when chatting via project with an assigned assistant
        // When no projectId, use the selected assistant from dropdown (if any)
        const assistant = projectAssistantId
          ? assistants.find((a) => a.id === projectAssistantId)
          : assistants.find((a) => a.id === selectedAssistantId)

        // Not saved as "last used": the composer's assistant is a draft (see
        // AssistantsMenu), and routing may have moved it without the user.
        setCurrentAssistant(assistant, false)

        // Never pin a thread to a model the provider cannot serve — a local
        // engine has no cloud catalogue to borrow an id from (janhq/jan#8007).
        // A model linked to the project wins for a chat started in it, as
        // long as that model is still on its provider.
        const linkedModelOk =
          projectModel !== undefined &&
          (getProviderByName(projectModel.provider)?.models ?? []).some(
            (m) => m.id === projectModel!.id
          )
        const threadProvider = linkedModelOk
          ? projectModel!.provider
          : selectedProvider
        if (linkedModelOk) {
          selectModelProvider(projectModel!.provider, projectModel!.id)
        }
        const threadModelId = resolveThreadModelId(
          threadProvider,
          linkedModelOk ? projectModel!.id : selectedModel?.id,
          (getProviderByName(threadProvider)?.models ?? []).map((m) => m.id)
        )
        if (!threadModelId) {
          setMessage(t('chat:composer.selectModel'))
          return
        }

        const newThread = await createThread(
          {
            id: threadModelId,
            provider: threadProvider,
          },
          slash.kind === 'message' ? slash.display : prompt, // Use prompt as thread title
          // Sampling picked in the composer belongs to this chat only; the
          // assistant itself is never edited from there.
          assistant
            ? (() => {
                const draft = useDraftSampling.getState().take(assistant.id)
                return draft ? { ...assistant, parameters: draft } : assistant
              })()
            : assistant,
          projectMetadata
        )

        // Transfer agent mode from home screen to the new thread
        if (isAgentMode) {
          useAgentMode.getState().setAgentMode(newThread.id, true)
          useAgentMode.getState().removeThread(agentModeKey)
        }
        // And the web search choice made on the home screen, if any.
        if (webSearchScope === undefined) {
          useWebSearchChoice.getState().move(agentModeKey, newThread.id)
        }

        // Store the initial message for the new thread
        safeSessionSet(
          `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${newThread.id}`,
          JSON.stringify(messagePayload)
        )

        router.navigate({
          to: route.threadsDetail,
          params: { threadId: newThread.id },
        })
      }

      if (latestPromptRef.current === draftAtStart) setPrompt('')
      // Don't clear attachments here — document attachments stored under
      // NEW_THREAD_ATTACHMENT_KEY need to survive until the thread detail
      // page transfers and processes them.  The thread detail page's
      // processAndSendMessage already calls clearAttachmentsForThread after
      // processing is complete.
    }
  }

  const sendLatest = useLatestCallback(handleSendMessage)
  // A parked send belongs to the thread and the text it was typed for: moving
  // to another thread or editing the draft cancels it instead of sending later.
  useEffect(() => {
    pendingSendRef.current = null
  }, [currentThreadId])
  useEffect(() => {
    const pending = pendingSendRef.current
    if (pending && prompt !== pending.draft) pendingSendRef.current = null
  }, [prompt])

  // The replacement model has shown: send the message that was waiting for it.
  useEffect(() => {
    const pending = pendingSendRef.current
    if (!pending || selectedModel?.id !== pending.modelId) return
    pendingSendRef.current = null
    // Only a send waiting for this switch; one that waited too long is dropped.
    if (Date.now() - pending.at > 15_000) return
    void sendLatest(pending.typed, pending.options)
  }, [selectedModel?.id, sendLatest])



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

  const processNewDocumentAttachments = useCallback(
    async (docs: Attachment[]) => {
      if (!docs.length) return

      // Only collect the user's inline-vs-embeddings preference via the
      // dialog.  Actual ingestion is always deferred to send time
      // (processAttachmentsForSend inside processAndSendMessage).
      const docsNeedingPrompt = docs.filter((doc) => {
        if (doc.processed || doc.injectionMode) return false
        const preference = doc.parseMode ?? parsePreference
        return preference === 'prompt' || preference === 'auto'
      })

      if (docsNeedingPrompt.length > 0) {
        const choices = new Map<string, 'inline' | 'embeddings'>()
        for (let i = 0; i < docsNeedingPrompt.length; i++) {
          const doc = docsNeedingPrompt[i]
          const choice = await useAttachmentIngestionPrompt
            .getState()
            .showPrompt(
              doc,
              ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
              i,
              docsNeedingPrompt.length
            )

          if (!choice) {
            // User cancelled — remove all pending docs
            setAttachmentsForThread(attachmentsKey, (prev) =>
              prev.filter(
                (att) =>
                  !docsNeedingPrompt.some(
                    (d) => d.path && att.path && d.path === att.path
                  )
              )
            )
            return
          }

          if (doc.path) {
            choices.set(doc.path, choice)
          }
        }

        // Persist each document's chosen mode so processAttachmentsForSend
        // can pick it up at send time.
        if (choices.size > 0) {
          setAttachmentsForThread(attachmentsKey, (prev) =>
            prev.map((att) => {
              const mode = att.path ? choices.get(att.path) : undefined
              return mode ? { ...att, parseMode: mode } : att
            })
          )
        }
      }
    },
    [
      ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
      attachmentsKey,
      parsePreference,
      setAttachmentsForThread,
    ]
  )

  /** Attach files on disk as documents; shared by the picker and drag-and-drop. */
  const attachDocumentPaths = async (paths: string[]) => {
    // Prepare attachments with file sizes
    const preparedAttachments: Attachment[] = []
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() || p
      const fileType = name.split('.').pop()?.toLowerCase()
      let size: number | undefined = undefined
      try {
        const stat = await fs.fileStat(p)
        size = stat?.size ? Number(stat.size) : undefined
      } catch (e) {
        console.warn('Failed to read file size for', p, e)
      }
      preparedAttachments.push(
        createDocumentAttachment({
          name,
          path: p,
          fileType,
          size,
          parseMode: parsePreference,
        })
      )
    }

    const maxFileSizeBytes =
      typeof maxFileSizeMB === 'number' && maxFileSizeMB > 0
        ? maxFileSizeMB * 1024 * 1024
        : undefined

    if (maxFileSizeBytes !== undefined) {
      const hasOversized = preparedAttachments.some(
        (att) => typeof att.size === 'number' && att.size > maxFileSizeBytes
      )
      if (hasOversized) {
        toast.error(t('sweep:chat.fileTooLarge'), {
          description: t('sweep:chat.fileTooLargeDesc', { size: maxFileSizeMB }),
        })
        return
      }
    }

    let duplicates: string[] = []
    let newDocAttachments: Attachment[] = []

    setAttachmentsForThread(attachmentsKey, (currentAttachments) => {
      const existingPaths = new Set(
        currentAttachments
          .filter((a) => a.type === 'document' && a.path)
          .map((a) => a.path)
      )

      duplicates = []
      newDocAttachments = []

      for (const att of preparedAttachments) {
        if (existingPaths.has(att.path)) {
          duplicates.push(att.name)
          continue
        }
        newDocAttachments.push(att)
      }

      return newDocAttachments.length > 0
        ? [...currentAttachments, ...newDocAttachments]
        : currentAttachments
    })

    if (duplicates.length > 0) {
      toast.warning(t('sweep:chat.filesAlreadyAttached'), {
        description: t('sweep:chat.alreadyInList', { names: duplicates.join(', '), count: duplicates.length }),
      })
    }

    if (newDocAttachments.length > 0) {
      await processNewDocumentAttachments(newDocAttachments)
    }
  }

  /** Save dropped documents to disk, then attach them like picked files. */
  const attachDroppedDocuments = async (files: File[]) => {
    if (!attachmentsEnabled) {
      toast.info(t('sweep:chat.attachmentsDisabled'))
      return
    }
    const limitBytes =
      typeof maxFileSizeMB === 'number' && maxFileSizeMB > 0
        ? maxFileSizeMB * 1024 * 1024
        : undefined
    const withinLimit = files.filter(
      (f) => limitBytes === undefined || f.size <= limitBytes
    )
    if (withinLimit.length < files.length) {
      toast.error(t('sweep:chat.fileTooLarge'), {
        description: t('sweep:chat.fileTooLargeDesc', { size: maxFileSizeMB }),
      })
    }
    if (withinLimit.length === 0) return
    try {
      const paths = await Promise.all(
        withinLimit.map((f) =>
          serviceHub.uploads().saveDroppedFile(f, currentThreadId)
        )
      )
      await attachDocumentPaths(paths)
    } catch (e) {
      console.error('Failed to attach dropped documents:', e)
      toast.error(t('common:dropAttachFailed'), {
        description: e instanceof Error ? e.message : JSON.stringify(e),
      })
    }
  }

  const handleAttachDocsIngest = async () => {
    try {
      if (!attachmentsEnabled) {
        toast.info(t('sweep:chat.attachmentsDisabled'))
        return
      }
      const selection = await serviceHub.dialog().open({
        multiple: true,
        filters: [
          {
            name: t('chat:composer.filterDocuments'),
            extensions: [...DOCUMENT_ATTACHMENT_EXTENSIONS],
          },
          {
            name: t('chat:composer.filterAll'),
            extensions: ['*'],
          },
        ],
      })
      if (!selection) return
      const paths = Array.isArray(selection) ? selection : [selection]
      if (!paths.length) return
      await attachDocumentPaths(paths)
    } catch (e) {
      console.error('Failed to attach documents:', e)
      const desc = e instanceof Error ? e.message : JSON.stringify(e)
      toast.error(t('chat:composer.attachFailed'), { description: desc })
    }
  }

  /**
   * Deletes an ingested document from the vector store. False (after a toast)
   * when the backend refused, so the chip has to stay.
   */
  const deleteAttachmentFromBackend = async (
    attachment: Attachment,
    threadId: string | undefined
  ): Promise<boolean> => {
    if (!attachment.id || !threadId || attachment.type !== 'document') {
      return true
    }
    try {
      const vectorDBExtension = ExtensionManager.getInstance().get(
        ExtensionTypeEnum.VectorDB
      ) as VectorDBExtension | undefined
      if (vectorDBExtension?.deleteFile) {
        await vectorDBExtension.deleteFile(threadId, attachment.id)
      }
      return true
    } catch (error) {
      console.error('Failed to delete attachment from backend:', error)
      toast.error(t('chat:composer.removeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  const handleRemoveAttachment = async (indexToRemove: number) => {
    const attachmentToRemove = attachments[indexToRemove]
    if (!attachmentToRemove) return
    // If attachment was ingested (has an ID), delete it from the backend
    if (
      attachmentToRemove.id &&
      !(await deleteAttachmentFromBackend(attachmentToRemove, currentThreadId))
    )
      return
    setAttachmentsForThread(attachmentsKey, (prev) =>
      withoutAttachment(prev, attachmentToRemove)
    )
  }

  /**
   * Backspace in an empty box: the chip goes at once and a toast offers to
   * put it back. An ingested document is only deleted from the backend once
   * the toast closes without an undo; if that delete fails the chip returns.
   */
  const removeAttachmentWithUndo = (index: number) => {
    const target = attachments[index]
    if (!target) return
    const key = attachmentsKey
    const threadId = currentThreadId
    const restore = () =>
      setAttachmentsForThread(key, (prev) =>
        prev.includes(target)
          ? prev
          : [...prev.slice(0, index), target, ...prev.slice(index)]
      )
    setAttachmentsForThread(key, (prev) => withoutAttachment(prev, target))
    let settled = false
    const finalize = () => {
      if (settled) return
      settled = true
      void deleteAttachmentFromBackend(target, threadId).then((ok) => {
        if (!ok) restore()
      })
    }
    toast.info(t('chat:composer.attachmentRemoved', { name: target.name }), {
      action: {
        label: t('common:undo'),
        onClick: () => {
          if (settled) return
          settled = true
          restore()
        },
      },
      onAutoClose: finalize,
      onDismiss: finalize,
    })
  }

  /** Update the same model metadata as the edit dialog. */
  const enableCapabilitiesOnSelectedModel = useCallback(
    (capabilities: readonly EnableableCapability[]) => {
      if (!selectedModel?.id || !selectedProvider) return false
      const provider = getProviderByName(selectedProvider)
      if (!provider) return false
      const models = enableModelCapabilities(
        provider.models,
        selectedModel.id,
        capabilities
      )
      updateProvider(selectedProvider, { ...provider, models })
      return true
    },
    [getProviderByName, selectedModel?.id, selectedProvider, updateProvider]
  )

  const [capabilityPrompt, setCapabilityPrompt] = useState<{
    capabilities: EnableableCapability[]
    onEnabled: () => void | Promise<void>
  } | null>(null)

  const requestCapabilities = useCallback(
    (
      capabilities: EnableableCapability[],
      onEnabled: () => void | Promise<void>
    ) => {
      if (!selectedModel) return
      setCapabilityPrompt({ capabilities, onEnabled })
    },
    [selectedModel]
  )

  const handleEnableCapabilities = useCallback(() => {
    const pending = capabilityPrompt
    if (!pending) return
    if (!enableCapabilitiesOnSelectedModel(pending.capabilities)) {
      toast.error(t('sweep:chat.modelUnavailable'))
      return
    }
    setCapabilityPrompt(null)
    try {
      const continued = pending.onEnabled()
      if (continued) void Promise.resolve(continued).catch((error) => {
        console.error('Failed to continue after enabling model capability:', error)
        toast.error(t('sweep:chat.actionFailed'))
      })
    } catch (error) {
      console.error('Failed to continue after enabling model capability:', error)
      toast.error(t('sweep:chat.actionFailed'))
    }
  }, [capabilityPrompt, enableCapabilitiesOnSelectedModel, t])

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

  // The drop zone is always live. Gating it on the model's media capabilities
  // meant a text-only model refused every drop, a plain `.txt` included, and
  // an image now opens a question rather than being turned away at the door.
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragCount(dragFileCount(e.dataTransfer))
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set dragOver to false if we're leaving the drop zone entirely
    // In Tauri, relatedTarget can be null, so we need to handle that case
    const relatedTarget = e.relatedTarget as Node | null
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      setIsDragOver(false)
      setDragCount(0)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setDragCount(0)

    if (!e.dataTransfer) {
      console.warn('No dataTransfer available in drop event')
      return
    }

    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length === 0) return

    const {
      audio: audioOnes,
      video: videoOnes,
      // Documents take the same path as the + button once saved to disk;
      // anything else keeps going to the image path.
      documents: documentOnes,
      images: imageOnes,
    } = splitDroppedFiles(dropped, isDocumentAttachmentName)
    const missing = missingMediaCapabilities(
      { audio: audioOnes.length, video: videoOnes.length },
      { audio: audioSupported, video: videoSupported }
    )
    const attachMedia = () => {
      if (documentOnes.length > 0) void attachDroppedDocuments(documentOnes)
      if (imageOnes.length > 0) attachFiles(imageOnes)
      if (audioOnes.length > 0) void processAudioFiles(audioOnes)
      if (videoOnes.length > 0) void processVideoFiles(videoOnes)
    }
    if (missing.length > 0) requestCapabilities(missing, attachMedia)
    else attachMedia()
  }

  // Dragged or copied files can arrive as `file://` URIs with no File objects
  // (Linux file managers), which would land in the editor as raw text. Read
  // them from disk and attach them like any other file.
  const attachFileUris = async (paths: string[]) => {
    const { files, folders, failed } = await readDroppedPaths(paths)
    for (const { error } of failed) {
      toast.error(t('common:pastedPath.failed'), { description: error })
    }
    // A folder is offered as the project, never read in. Only one offer fits
    // above the editor; any folder it cannot cover is named, not dropped.
    const offered = pastedFolder ? folders.slice(0, 1) : []
    if (offered.length > 0) setPathOffer({ path: offered[0], kind: 'folder' })
    for (const folder of folders.slice(offered.length)) {
      toast.error(t('common:pastedPath.failed'), { description: folder })
    }
    const documents = files.filter((f) => isDocumentAttachmentName(f.name))
    const others = files.filter((f) => !documents.includes(f))
    if (documents.length > 0) void attachDroppedDocuments(documents)
    if (others.length > 0) attachFiles(others)
    focusComposer()
  }

  // Runs in the capture phase, before the editor's own drop handler, which
  // inserts text/uri-list or text/plain as text and runs before any bubbling
  // React handler. The editor leaves an already-cancelled event alone.
  const handleUriDrop = (e: React.DragEvent) => {
    const dt = e.dataTransfer
    if (!dt) return
    if ((dt.files?.length ?? 0) > 0) {
      // Real File objects: handleDrop attaches them. Only stop the editor
      // also inserting the URI text WebKitGTK sends alongside them.
      e.preventDefault()
      return
    }
    if (!isPlatformTauri()) return
    // Any web page can put a local path in the text a dragged link or image
    // carries, so only GNOME's own drag type attaches by itself; the rest is
    // asked about first, as a paste is.
    const named = dropFilePaths(dt)
    if (!named) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setDragCount(0)
    if (named.trusted) void attachFileUris(named.paths)
    else
      setPathOffer({
        path: named.paths[0],
        kind: 'file',
        paths: named.paths,
        raw: transferText(dt),
      })
  }

  // A pasted path is still pasted as text; this only notices it and offers,
  // above the editor, to attach what it points at.
  const [pathOffer, setPathOffer] = useState<{
    path: string
    kind: 'file' | 'folder'
    /** Every file a pasted URI list named, when there was more than a path. */
    paths?: string[]
    /** The text that was held back, put in the composer if the offer is declined. */
    raw?: string
    /** The path was pasted into the composer as text; accepting removes it. */
    inComposer?: boolean
  } | null>(null)
  const pathOfferRef = useRef(pathOffer)
  pathOfferRef.current = pathOffer
  // The offer, like the draft, belongs to the chat it was pasted in.
  useEffect(() => {
    setPathOffer(null)
  }, [attachmentsKey])

  /** Decline the offer; the text it held back goes into the composer instead. */
  const declinePathOffer = () => {
    const offer = pathOfferRef.current
    setPathOffer(null)
    if (offer?.raw) {
      if (typeof richComposerRef.current?.insertText === 'function')
        richComposerRef.current.insertText(offer.raw)
      else setPrompt(latestPromptRef.current + offer.raw)
    }
  }

  const offerPastedPath = async (candidate: string) => {
    if (!isPlatformTauri()) return
    // A UNC path would make the OS connect to that host on stat.
    if (/^[\\/]{2}/.test(candidate)) return
    try {
      const { fs } = await import('@janhq/core')
      const stat = await fs.fileStat(candidate)
      if (!stat) return
      if (stat.isDirectory) {
        if (!pastedFolder) return
        const same = (a: string) =>
          a.replace(/[\\/]+$/, '').toLowerCase() ===
          candidate.replace(/[\\/]+$/, '').toLowerCase()
        if (pastedFolder.attached.some(same)) return
        setPathOffer({ path: candidate, kind: 'folder', inComposer: true })
      } else {
        setPathOffer({ path: candidate, kind: 'file', inComposer: true })
      }
    } catch {
      // Not a path that exists: it was only text.
    }
  }

  const acceptPathOffer = async () => {
    const offer = pathOffer
    setPathOffer(null)
    if (!offer) return
    // The path was pasted as text too; once it is attached it is not part of
    // the message (C021).
    if (offer.inComposer) {
      const draft = latestPromptRef.current
      const cleaned = withoutPastedPath(draft, offer.path)
      if (cleaned !== draft) setPrompt(cleaned)
    }
    if (offer.kind === 'folder') {
      pastedFolder?.onAttach(offer.path)
      return
    }
    if (offer.paths) {
      await attachFileUris(offer.paths)
      return
    }
    try {
      const response = await fetch(await toAssetUrl(offer.path))
      if (!response.ok) throw new Error(response.statusText)
      const blob = await response.blob()
      const name = offer.path.split(/[\\/]/).filter(Boolean).pop() || 'file'
      const file = new File([blob], name, { type: blob.type })
      attachFiles([file])
    } catch (error) {
      toast.error(t('common:pastedPath.failed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
    focusComposer()
  }

  const largePaste = useLargePaste({
    enabled: attachmentsEnabled,
    attachedNames: attachments.map((a) => a.name),
    attach: (file) => processImageFiles([file]),
    insertText: (text) => {
      if (richComposerRef.current) richComposerRef.current.insertText(text)
      else setPrompt(latestPromptRef.current + text)
    },
    detach: (name) =>
      setAttachmentsForThread(attachmentsKey, (prev) =>
        prev.filter((a) => a.name !== name)
      ),
    t,
  })

  const handlePaste = async (e: React.ClipboardEvent) => {
    // Files copied in a Linux file manager arrive as URIs (text/uri-list,
    // x-special/gnome-copied-files or a text/plain block), not File objects.
    // Checked first so a long list never becomes a .txt via largePaste.
    // Real File objects (macOS Finder) win; only GNOME's own clipboard type
    // attaches by itself, since a web page can forge the other two.
    const named = isPlatformTauri() ? pasteFilePaths(e.clipboardData) : null
    if (named) {
      e.preventDefault()
      if (named.trusted) void attachFileUris(named.paths)
      else
        setPathOffer({
          path: named.paths[0],
          kind: 'file',
          paths: named.paths,
          raw: transferText(e.clipboardData),
        })
      return
    }
    // A large text paste becomes a .txt attachment; default is prevented
    // before anything below can await.
    if (largePaste.handlePaste(e)) return
    const pasted = pastedPath(e.clipboardData?.getData('text/plain') ?? '')
    if (pasted) void offerPastedPath(pasted)
    const mediaItems = e.clipboardData?.items
    if (mediaItems && mediaItems.length > 0) {
      const { audio: audioFiles, video: videoFiles } =
        pastedMediaFiles(mediaItems)
      if (audioFiles.length > 0 || videoFiles.length > 0) {
        e.preventDefault()
        const missing = missingMediaCapabilities(
          { audio: audioFiles.length, video: videoFiles.length },
          { audio: audioSupported, video: videoSupported }
        )
        const attachMedia = async () => {
          if (audioFiles.length > 0) await processAudioFiles(audioFiles)
          if (videoFiles.length > 0) await processVideoFiles(videoFiles)
        }
        if (missing.length > 0) requestCapabilities(missing, attachMedia)
        else await attachMedia()
          return
      }
    }

    // Pasted images are handled whatever the model can read: one it
    // cannot see opens the question below rather than being dropped on
    // the floor, which is what gating this on vision amounted to.
    const clipboardItems = e.clipboardData?.items

    // Try clipboardData.items first (traditional method). Image items that
    // give no file fall through to the async clipboard below.
    if (clipboardItems && clipboardItems.length > 0) {
      const images = pastedImageFiles(clipboardItems)
      if (images.found) {
        e.preventDefault()
        if (images.files.length > 0) {
          attachFiles(images.files)
          return
        }
      }
    }

    // Modern Clipboard API fallback (for Linux, images copied from web, etc.)
    // Never for plain text: reading the clipboard this way makes WebView2 ask
    // the user for permission ("wants to see text and images copied...").
    const mayHoldImage = clipboardMayHoldImage(
      Array.from(e.clipboardData?.types ?? [])
    )
    if (mayHoldImage && navigator.clipboard && 'read' in navigator.clipboard) {
      try {
        const files = await clipboardImageFiles(await navigator.clipboard.read())

        if (files.length > 0) {
          e.preventDefault()
          attachFiles(files)
          return
        }
      } catch (error) {
        console.error('Clipboard API access failed:', error)
      }
    }

    // If we reach here, no image was found - allow normal text pasting to continue
    console.log('No image data found in clipboard, allowing normal text paste')
  }

  const composerImages = attachments
    .filter((a) => a.type === 'image' && a.dataUrl)
    .map((a) => ({ url: a.dataUrl as string, name: a.name }))

  const isStreaming = chatStatus === 'submitted' || chatStatus === 'streaming'
  // A tool call in flight (the reply has finished streaming but the tool is
  // still running) can be cancelled from here.
  const toolInFlight = useAppState((state) =>
    currentThreadId ? Boolean(state.cancelToolCalls?.[currentThreadId]) : false
  )
  const declineLatest = useLatestCallback(declinePathOffer)
  // The offer belongs to the draft it was pasted into; sending ends it.
  useEffect(() => {
    // Not dropped silently: what was pasted still lands in the composer.
    if (isStreaming && pathOfferRef.current) declineLatest()
  }, [isStreaming, declineLatest])

  /**
   * Write one or more settings into the model's own configuration, in one
   * update. Built from the provider's current copy of the model, not the
   * `selectedModel` snapshot, which is stale by the time a second write runs.
   */
  const updateModelSettings = (writes: SettingWrite[]) => {
    if (!selectedProvider || !selectedModel) return
    const providerObj = getProviderByName(selectedProvider)
    if (!providerObj) return
    const modelIndex = providerObj.models.findIndex(
      (m) => m.id === selectedModel.id
    )
    if (modelIndex === -1) return
    const updatedModel = withSettings(providerObj.models[modelIndex], writes)
    const updatedModels = [...providerObj.models]
    updatedModels[modelIndex] = updatedModel
    updateProvider(selectedProvider, {
      models: updatedModels,
    })
    // selectedModel is a snapshot, not a live derivation — re-select to
    // refresh it so the dropdown UI and the chat transport both observe the
    // new value. A surface that supplies its own model (Cowork) re-derives it
    // from the providers, and must not move the global picker.
    if (!modelSelection) {
      selectModelProvider(selectedProvider, selectedModel.id)
    }
  }
  const updateModelSetting = (
    settingKey: string,
    title: string,
    controllerType: string,
    value: unknown
  ) =>
    updateModelSettings([
      {
        key: settingKey,
        title,
        controllerType,
        value: value as SettingWrite['value'],
      },
    ])

  // Which discrete effort levels this provider will act on. Empty for
  // providers that size their own thinking, in which case the control is not
  // shown at all — see `supportedEffortLevels`.
  const {
    levels: effortLevels,
    recommended: effortRecommended,
    canDisable: effortCanDisable,
  } = effortProfile(selectedProvider, selectedModel)
  // What this chat will actually send: its own override where it has one, the
  // global model setting otherwise.
  const resolvedForEffort = resolveModel(
    selectedModel,
    withReasoningDefault(
      chatOverrides,
      selectedProvider,
      selectedModel,
      reasoningDefault
    )
  )
  // A llama.cpp model is offered an effort only when it reasons (C052).
  const localModelWithoutReasoning =
    selectedProvider === 'llamacpp' && effortLevels.length === 0
  const currentEffort: EffortChoice | null =
    effortCanDisable && isThinkingOff(resolvedForEffort)
      ? 'off'
      : effortOf(resolvedForEffort)
  const effortOverridden =
    isOverridden(chatOverrides, EFFORT_SETTING_KEY) ||
    isOverridden(chatOverrides, 'reasoning')
  /**
   * Store a setting.
   *
   * Per chat once a chat exists. On the new-chat screen there is no thread
   * yet, and the control still has to work — so it writes the global model
   * setting there.
   */
  const setChatSettings = (
    writes: Array<{ key: string; title: string; value: string }>
  ) => {
    if (overrideScope) {
      for (const { key, value } of writes) {
        setThreadOverride(overrideScope, key, value)
      }
      return
    }
    // One update for all of them: see `updateModelSettings`.
    updateModelSettings(
      writes.map((w) => ({ ...w, controllerType: 'dropdown' }))
    )
  }
  /** Choose a stop: a level, or Off where the model can be told not to think. */
  const setEffort = (choice: EffortChoice) => {
    if (choice === 'off') {
      setChatSettings([{ key: 'reasoning', title: 'Reasoning', value: 'off' }])
      return
    }
    // Picking a level ends Off; the effort says how hard from there.
    setChatSettings([
      ...(currentEffort === 'off'
        ? [{ key: 'reasoning', title: 'Reasoning', value: 'auto' }]
        : []),
      { key: EFFORT_SETTING_KEY, title: 'Reasoning Effort', value: choice },
    ])
  }

  const effortControl =
    effortLevels.length > 0 ? (
              <ComposerEffort
                levels={effortLevels}
                value={currentEffort}
                recommended={effortRecommended}
                canDisable={effortCanDisable}
                overridden={effortOverridden}
                onChange={setEffort}
                onReset={
                  overrideScope && effortOverridden
                    ? () => {
                        clearThreadOverride(overrideScope, EFFORT_SETTING_KEY)
                        clearThreadOverride(overrideScope, 'reasoning')
                      }
                    : undefined
                }
              />
    ) : null
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
              <div className="flex flex-col gap-1 px-3 pt-2 pb-0">
                <QueuedMessageList
                  messages={queuedMessages}
                  onReorder={(id, overId) =>
                    useMessageQueue.getState().reorder(queueId, id, overId)
                  }
                  chipProps={(msg, index) => ({
                    onEdit: (queued) => {
                      // Put the text back in the input for editing, remove from queue
                      setPrompt(queued.text)
                      removeQueuedMessage(queued.id)
                      focusComposer()
                    },
                    onRemove: removeQueuedMessage,
                    // A held message (its run failed or was stopped) waits
                    // for the user: Send lets it go as the next turn.
                    onRelease: msg.held
                      ? (id) => useMessageQueue.getState().release(queueId, id)
                      : undefined,
                    // Steering only means something while a run works; a
                    // held message waits for the user and is sent, not steered.
                    onSteer:
                      (isStreaming || threadBusy) && !msg.held && !msg.from
                        ? (id) => {
                            useMessageQueue.getState().steerNow(queueId, id)
                            withdrawApprovalsForSteering(queueId)
                          }
                        : undefined,
                    // Already steering and the run still works: stop the
                    // run (steering stays queued, not held) and the end-of-run
                    // sender hands it over first, as the immediate next turn.
                    onSteerNow:
                      (isStreaming || threadBusy) && msg.steer && !msg.held
                        ? () => stopStreaming(currentThreadId ?? '')
                        : undefined,
                    onMoveUp:
                      index > 0
                        ? (id) =>
                            useMessageQueue.getState().move(queueId, id, -1)
                        : undefined,
                    onMoveDown:
                      index < queuedMessages.length - 1
                        ? (id) =>
                            useMessageQueue.getState().move(queueId, id, 1)
                        : undefined,
                  })}
                />
              </div>
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
                if (filePickerOpen && !aliasDraft) {
                  const count = filePickerEntries.length
                  const active = filePickerEntries[Math.min(referenceActive, count - 1)]
                  if (count > 0 && event.key === 'ArrowDown') {
                    event.preventDefault()
                    setReferenceActive((index) => (index + 1) % count)
                  } else if (count > 0 && event.key === 'ArrowUp') {
                    event.preventDefault()
                    setReferenceActive((index) => (index - 1 + count) % count)
                  } else if (active && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                    event.preventDefault()
                    handleFilePickerSelect(active)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    handleFilePickerClose()
                  } else if (event.altKey && event.key.toLowerCase() === 'a' && active) {
                    event.preventDefault()
                    if (active.kind === 'file' || active.kind === 'directory') {
                      setAliasDraft(active)
                      setAliasError(null)
                      setReferenceStatus(`Name ${active.token} as an alias`)
                    } else {
                      setReferenceStatus('Only a file or folder can be named')
                    }
                  }
                }
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

type ModelCheck = { status: 'ok' | 'stop' } | { status: 'retry'; modelId: string }

export default ChatInput
