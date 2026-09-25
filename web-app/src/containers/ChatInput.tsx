import TextareaAutosize from 'react-textarea-autosize'
import { cn, formatBytes, getModelDisplayName } from '@/lib/utils'
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
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import {
  ArrowUp,
  Brain,
  CodeXml,
  Globe,
  ImageIcon,
  Loader2,
  Music,
  Paperclip,
  PlusIcon,
  Square,
  Video,
  Wrench,
  X,
} from 'lucide-react'
import { generateId } from 'ai'
import { useMessageQueue } from '@/stores/message-queue-store'
import { QueuedMessageChip } from '@/containers/QueuedMessageBubble'
import { SamplerPopover } from '@/containers/SamplerPopover'
import { BotIcon } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useConversationModel } from '@/hooks/useConversationPane'
import { useTokensCount } from '@/hooks/useTokensCount'
import { ReasoningEffortSlider } from '@/containers/ReasoningEffortSlider'
import {
  EFFORT_SETTING_KEY,
  effortOf,
  isOpenAICompatibleReasoningProvider,
  supportedEffortLevels,
} from '@/lib/modelEffort'
import { isOverridden, resolveModel } from '@/lib/modelOverrides'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import {
  THINKING_BUDGET_LEVELS,
  DEFAULT_THINKING_BUDGET_LEVEL,
  tokensForThinkingBudgetLevel,
  isThinkingBudgetLevelKey,
  type ThinkingBudgetLevelKey,
} from '@/lib/thinkingBudget'
import { useReconcileVideoCapability } from '@/hooks/useReconcileVideoCapability'

import { useAppState } from '@/hooks/useAppState'
import type { ChatStatus } from 'ai'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  TEMPORARY_CHAT_ID,
  TEMPORARY_CHAT_QUERY_ID,
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_PREFIX,
} from '@/constants/chat'
import { resolveThreadModelId } from '@/lib/models'
import { useAssistant } from '@/hooks/useAssistant'
import { AssistantSwitcher } from '@/containers/AssistantSwitcher'
import DropdownToolsAvailable from '@/containers/DropdownToolsAvailable'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTools } from '@/hooks/useTools'
import { TokenCounter } from '@/components/TokenCounter'
import type { TokenUsageSource } from '@/hooks/useTokensCount'
import { useMessages } from '@/hooks/useMessages'
import { useShallow } from 'zustand/react/shallow'
import { McpExtensionToolLoader } from './McpExtensionToolLoader'
import {
  ExtensionTypeEnum,
  MCPExtension,
  fs,
  VectorDBExtension,
} from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { useAttachments } from '@/hooks/useAttachments'
import { toast } from 'sonner'
import { isPlatformTauri } from '@/lib/platform/utils'
import { shouldShowTokenCounter } from '@/lib/tokenCounterVisibility'
import { useAttachmentIngestionPrompt } from '@/hooks/useAttachmentIngestionPrompt'
import {
  NEW_THREAD_ATTACHMENT_KEY,
  useChatAttachments,
} from '@/hooks/useChatAttachments'
import {
  VisionDisabledDialog,
  type VisionDisabledChoice,
} from '@/containers/dialogs/VisionDisabledDialog'

import {
  acceptAttribute,
  DEFAULT_ATTACHMENT_LIMITS,
  isTextual,
  reasonMessageKey,
  validateAttachment,
  visionBlockedFiles,
  type ModelCapabilities,
  type RejectionReason,
} from '@/lib/attachmentSupport'
import {
  Attachment,
  createImageAttachment,
  createDocumentAttachment,
  createAudioAttachment,
  createVideoAttachment,
} from '@/types/attachment'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import {
  formatPathReferenceText,
  parsePromptForReferences,
  stripPromptReferences,
  typedReference,
} from '@/lib/path-references'
import { resolveReference, searchReferences } from '@/lib/safeReferences'
import {
  optionId,
  rankReferences,
  type NamedSource,
  type ReferenceEntry,
} from '@/lib/referenceMenu'
import { resolveAlias, useReferenceAliases } from '@/lib/referenceAliases'
import { getServiceHub } from '@/hooks/useServiceHub'
import { FilePickerPopover } from '@/components/FilePickerPopover'
import { readFileAsText } from '@/lib/fileSafety'

type ChatInputProps = {
  className?: string
  showSpeedToken?: boolean
  /**
   * Hide the composer's token counter. For a surface that already shows token
   * usage elsewhere (Cowork shows it per turn), so the same number is not
   * reported twice.
   */
  hideTokenCounter?: boolean
  model?: ThreadModel
  initialMessage?: boolean
  projectId?: string
  projectAssistantId?: string
  onSubmit?: (
    text: string,
    files?: Array<{ type: string; mediaType: string; url: string }>
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
  /**
   * Replaces the default stop button while streaming.
   *
   * Cowork supplies one control that asks how far to stop; without this slot
   * it would have to render a second stop button beside this one, which is
   * exactly the thing being removed.
   */
  stopControl?: ReactNode
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
}

// Video containers llama-server can decode via ffmpeg/ffprobe into frames.
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']
const videoMimeForExt = (ext: string | undefined): string => {
  switch (ext) {
    case 'mov':
      return 'video/quicktime'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'avi':
      return 'video/x-msvideo'
    default:
      return 'video/mp4'
  }
}


const ChatInput = memo(function ChatInput({
  className,
  initialMessage,
  projectId,
  projectAssistantId,
  onSubmit,
  onStop,
  chatStatus,
  scopeKey,
  ownsToolSet = true,
  referenceRoot,
  referenceSources,
  surfaceControls,
  stopControl,
  tokenSource,
  hideTokenCounter,
  threadId: threadIdProp,
  draftScope,
  takeFocus = true,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isFocused, setIsFocused] = useState(false)
  // The control row is absolutely positioned at the bottom of the composer, so
  // the composer must reserve exactly as much space as the row occupies. The
  // row wraps when it runs out of width, so the reserve cannot be a constant:
  // 40px is one row, and a wrapped row silently covered the textarea.
  const footerRef = useRef<HTMLDivElement | null>(null)
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
  const [rows, setRows] = useState(1)
  const serviceHub = useServiceHub()
  const abortControllers = useAppState((state) => state.abortControllers)
  const tools = useAppState((state) => state.tools)
  const cancelToolCall = useAppState((state) => state.cancelToolCall)
  // The main draft, or this composer's own when it has a scope (the second
  // pane of a split conversation), so typing in one never edits the other.
  const mainPrompt = usePrompt((state) => state.prompt)
  const scopedPrompt = usePrompt((state) =>
    draftScope ? (state.scoped?.[draftScope]?.prompt ?? '') : ''
  )
  const prompt = draftScope ? scopedPrompt : mainPrompt
  const setMainPrompt = usePrompt((state) => state.setPrompt)
  const setScopedPrompt = usePrompt((state) => state.setScopedPrompt)
  const setPrompt = useCallback(
    (value: string) =>
      draftScope ? setScopedPrompt(draftScope, value) : setMainPrompt(value),
    [draftScope, setScopedPrompt, setMainPrompt]
  )
  const addToHistory = usePrompt((state) => state.addToHistory)
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
  const routeThreadId = useThreads((state) => state.currentThreadId)
  const currentThreadId = threadIdProp ?? routeThreadId
  // Subscribed to the map, not read through getState(), so the control
  // re-renders when this chat's overrides change.
  const overridesByThread = useModelOverrides((state) => state.byThread)
  const chatOverrides = currentThreadId
    ? overridesByThread[currentThreadId]
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
  const tokenCounterCompact = useGeneralSetting(
    (state) => state.tokenCounterCompact
  )
  useTools()
  const router = useRouter()
  const createThread = useThreads((state) => state.createThread)
  const { 
    loading,
    currentAssistant,
    setCurrentAssistant,
    assistants
  } = useAssistant()

  // Agent mode
  // Use TEMPORARY_CHAT_ID as fallback key on the home screen (same pattern as attachments)
  const agentModeKey = currentThreadId ?? TEMPORARY_CHAT_ID
  const isAgentMode = useAgentMode((state) =>
    state.agentThreads[agentModeKey] === true
  )
  // When projectId is present, treat as normal chat (disable agent mode UI)
  const effectiveAgentMode = isAgentMode && !projectId
  // Gate for the controls that shape which tools the model is offered.
  const showToolControls = ownsToolSet && !effectiveAgentMode
  const toggleAgentMode = useAgentMode((state) => state.toggleAgentMode)
  const webSearchEnabled = useWebSearchConfig((s) => s.webSearchEnabled)
  const setWebSearchEnabled = useWebSearchConfig((s) => s.setWebSearchEnabled)

  const [filePickerOpen, setFilePickerOpen] = useState(false)
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
  const referenceListId = useId()
  const referenceSkills = referenceSources?.skills
  const referenceAgents = referenceSources?.agents
  const [filePickerPosition, setFilePickerPosition] = useState<{
    top: number
    left: number
  } | null>(null)
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

      // Only where a folder is attached: it is the only thing a reference can
      // name (AH-204).
      if (!workingDir) {
        setFilePickerOpen(false)
        return
      }

      const cursorIdx = filePickerCursorPos.current ?? value.length

      // Look backwards from current cursor to find the last word starting with
      // @ (the @ must not be glued to a preceding word char, so `user@host`
      // never opens the picker)
      const beforeCursor = value.slice(0, cursorIdx)
      const atMatch = beforeCursor.match(/(?<![A-Za-z0-9_])@([\w./:-]*)$/)

      if (atMatch) {
        const query = atMatch[1] ?? ''
        setFilePickerQuery(query)

        // One ranked list. The file index is searched through the backend's
        // confined listing; if it cannot be read the rest are still offered,
        // and typing is never waited on.
        const rank = (files: Awaited<ReturnType<typeof searchReferences>>) => {
          const ranked = rankReferences(query, {
            files,
            skills: referenceSkills ?? [],
            agents: referenceAgents ?? [],
            aliases: useReferenceAliases.getState().list(workingDir),
          })
          setFilePickerEntries(ranked)
          setReferenceActive(0)
          setReferenceStatus(
            ranked.length === 0
              ? 'No references match'
              : `${ranked.length} reference${ranked.length === 1 ? '' : 's'}`
          )
        }
        const fileQuery = /^(skill|agent|alias):/.test(query) ? null : query
        if (referenceDataFolder && fileQuery !== null) {
          searchReferences(referenceDataFolder, workingDir, fileQuery)
            .then(rank)
            .catch(() => rank([]))
        } else {
          rank([])
        }

        // Position the picker above the text
        if (textareaRef.current) {
          const lineHeight = 22
          const lines = beforeCursor.split('\n').length
          const pos = {
            top: -Math.min(lines * lineHeight + 40, 300),
            left: 0,
          }
          setFilePickerPosition(pos)
        }
        setFilePickerOpen(true)
      } else {
        setFilePickerOpen(false)
      }
    },
    [workingDir, referenceDataFolder, setPrompt, referenceSkills, referenceAgents]
  )

  // Insert the selected reference into the prompt
  const handleFilePickerSelect = useCallback(
    (entry: ReferenceEntry) => {
      if (filePickerCursorPos.current == null) return

      const beforeCursor = prompt.slice(0, filePickerCursorPos.current)
      const afterCursor = prompt.slice(filePickerCursorPos.current)

      // Replace the `@query` with the entry's token
      const textBefore = beforeCursor.replace(
        /(?<![A-Za-z0-9_])@[\w./:-]*$/,
        ''
      )
      // The identifier, not the label: a folder-relative path, or a typed
      // reference. It means the same thing however it is displayed, and a
      // path cannot name anything outside the folder.
      const refText = formatPathReferenceText(entry.token) + ' '
      const newPrompt = textBefore + refText + afterCursor

      setPrompt(newPrompt)
      setFilePickerOpen(false)
      filePickerCursorPos.current = null

      // Focus back on textarea
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [prompt, setPrompt]
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
        setReferenceStatus(`Alias not saved: ${out.message}`)
        return
      }
      setAliasDraft(null)
      setAliasError(null)
      setReferenceStatus(
        `Saved @alias:${out.alias.name} for ${out.alias.target}`
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
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [aliasDraft, workingDir, filePickerQuery, referenceSkills, referenceAgents]
  )

  const handleAliasCancel = useCallback(() => {
    setAliasDraft(null)
    setAliasError(null)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [])

  // Resolve @path references in the prompt text, returning the resolved content
  const resolvePromptReferences = useCallback(
    async (text: string): Promise<{
      text: string
      resolvedContents: string
    }> => {
      const refs = parsePromptForReferences(text)
      // No folder, no references: an `@name` in an ordinary chat is left as
      // typed. It used to be read as a path -- relative to nothing, or
      // absolute -- so `@C:\Users\me\.ssh\id_rsa` put that file in the prompt.
      if (refs.length === 0 || !workingDir) return { text, resolvedContents: '' }

      const parts: string[] = []
      for (const ref of refs) {
        const typed = typedReference(ref)
        // A skill reference is acted on by the skill machinery, which reads
        // it from the text; it stays there and needs nothing inlined.
        if (typed?.kind === 'skill') continue
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
          // Said in the message, not dropped: the model should know a
          // reference was refused, and why, rather than miss it silently.
          parts.push(`[Reference @${ref} was not included: ${resolved.message}]`)
        }
      }

      const resolvedContents = parts.join('\n\n')

      // Remove @ references from the prompt text (they'll be replaced by the
      // resolved contents above so the model sees the content directly)
      const cleanText = stripPromptReferences(text)

      return { text: cleanText, resolvedContents }
    },
    [workingDir, referenceDataFolder, referenceAgents]
  )

  const handleAgentToggle = useCallback(() => {
    toggleAgentMode(agentModeKey)
  }, [agentModeKey, toggleAgentMode])

  // Get current thread messages for token counting
  const threadMessages = useMessages(
    useShallow((state) =>
      currentThreadId ? state.messages[currentThreadId] : []
    )
  )

  const maxRows = 10
  const ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES = 512 * 1024

  // This conversation's model: a split pane's own thread model, otherwise the
  // global picker.
  const conversationModel = useConversationModel()
  const selectedModel = conversationModel.selectedModel

  /**
   * What the picker offers.
   *
   * Images are always offered, whatever the model claims: picking one now
   * opens a question -- send without it, or turn vision on -- and a file the
   * picker refuses to show cannot raise that question at all. The desktop
   * dialog has always offered images regardless, so this is also the two
   * intakes finally agreeing. Audio and video still follow the capability,
   * since neither has an equivalent answer to offer.
   */
  const attachmentAccept = useMemo(
    () =>
      acceptAttribute({
        vision: true,
        audio: Boolean(selectedModel?.capabilities?.includes('audio')),
        video: Boolean(selectedModel?.capabilities?.includes('video')),
      }),
    [selectedModel?.capabilities]
  )
  const selectedProvider = conversationModel.selectedProvider
  const selectModelProvider = useModelProvider(
    (state) => state.selectModelProvider
  )
  const updateProvider = useModelProvider((state) => state.updateProvider)
  const { maxTokens: liveMaxTokens, configuredCtxLen } =
    useTokensCount(threadMessages || [])
  const [message, setMessage] = useState('')
  const [dropdownToolsAvailable, setDropdownToolsAvailable] = useState(false)
  const [tooltipShown, setTooltipShown] = useState<
    'tools' | 'assistants' | false
  >(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const activeModels = useAppState(useShallow((state) => state.activeModels))
  // Check if selected model is currently loaded/active
  const isModelActive = selectedModel?.id ? activeModels.includes(selectedModel.id) : false

  // Reconcile video capability from /props once the model is loaded.
  useReconcileVideoCapability(selectedModel?.id, selectedProvider, isModelActive)

  const tokenCounterVisible =
    !hideTokenCounter &&
    shouldShowTokenCounter({
      hasSelectedModel: !!selectedModel,
      isAgentMode: effectiveAgentMode,
      isInitialMessage: !!initialMessage,
      hasMessages: (threadMessages?.length ?? 0) > 0,
      hasPromptText: prompt.trim().length > 0,
      hasReportedUsage: (tokenSource?.usage?.totalTokens ?? 0) > 0,
    })
  const [selectedAssistantId, setSelectedAssistantId] = useState<
    string | undefined
  >(loading ? undefined : projectAssistantId || currentAssistant?.id || '')

  useEffect(() => {
    setSelectedAssistantId(projectAssistantId || currentAssistant?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const clearAttachmentsForThread = useChatAttachments(
    (state) => state.clearAttachments
  )
  const transferAttachments = useChatAttachments(
    (state) => state.transferAttachments
  )
  const getProviderByName = useModelProvider((state) => state.getProviderByName)

  const ingestingDocs = attachments.some(
    (a) => a.type === 'document' && a.processing
  )
  const ingestingAny = attachments.some((a) => a.processing)
  const hasSendableMedia = attachments.some(
    (a) =>
      (a.type === 'image' || a.type === 'audio' || a.type === 'video') &&
      !!a.dataUrl
  )

  const [, setFileIngestProgress] = useState<{
    completed: number
    total: number
  } | null>(null)

  // Queued messages for this thread (shown as chips in the input area)
  const queueId = scopeKey ?? currentThreadId ?? ''
  const queuedMessages = useMessageQueue(
    useShallow((s) => s.getQueue(queueId))
  )
  const queueLength = queuedMessages.length

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

  // Check if there are active MCP servers
  const hasActiveMCPServers =
    tools.filter((tool) => tool.server !== 'Jan Browser MCP').length > 0

  // Get MCP extension and its custom component
  const extensionManager = ExtensionManager.getInstance()
  const mcpExtension = extensionManager.get<MCPExtension>(ExtensionTypeEnum.MCP)
  const MCPToolComponent = mcpExtension?.getToolComponent?.()

  const handleSendMessage = async (prompt: string) => {
    if (!selectedModel) {
      setMessage('Please select a model to start chatting.')
      return
    }

    // Resolve @path references before sending
    const { text: resolvedText, resolvedContents } =
      await resolvePromptReferences(prompt)
    const effectivePrompt = resolvedContents
      ? `${resolvedText}\n\n---\nReferenced file contents:\n\n${resolvedContents}`
      : resolvedText

    if (!effectivePrompt.trim() && !hasSendableMedia) {
      return
    }
    if (ingestingAny) {
      toast.info('Please wait for attachments to finish processing')
      return
    }

    setMessage('')
    addToHistory(effectivePrompt)

    // Use onSubmit prop if available (AI SDK), otherwise create thread and navigate
    if (onSubmit) {
      // When the model is still streaming, queue the message for later
      if (isStreaming && queueId) {
        useMessageQueue.getState().enqueue(queueId, {
          id: generateId(),
          text: effectivePrompt,
          createdAt: Date.now(),
        })
        setPrompt('')
        return
      }

      const imageFiles = attachments
        .filter((att) => att.type === 'image' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.mimeType ?? 'image/jpeg',
          url: att.dataUrl!,
        }))
      const audioFiles = attachments
        .filter((att) => att.type === 'audio' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          url: att.dataUrl!,
        }))
      const videoFiles = attachments
        .filter((att) => att.type === 'video' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.mimeType ?? 'video/mp4',
          url: att.dataUrl!,
        }))
      const files = [...imageFiles, ...audioFiles, ...videoFiles]

      onSubmit(effectivePrompt, files.length > 0 ? files : undefined)
      setPrompt('')
      clearAttachmentsForThread(attachmentsKey)
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
        // For temporary chat, store message and navigate to temporary thread
        sessionStorage.setItem(
          SESSION_STORAGE_KEY.INITIAL_MESSAGE_TEMPORARY,
          JSON.stringify(messagePayload)
        )
        sessionStorage.setItem('temp-chat-nav', 'true')
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

        setCurrentAssistant(assistant)

        // Never pin a thread to a model the provider cannot serve — a local
        // engine has no cloud catalogue to borrow an id from (janhq/jan#8007).
        const threadModelId = resolveThreadModelId(
          selectedProvider,
          selectedModel?.id,
          (getProviderByName(selectedProvider)?.models ?? []).map((m) => m.id)
        )
        if (!threadModelId) {
          setMessage('Please select a model to start chatting.')
          return
        }

        const newThread = await createThread(
          {
            id: threadModelId,
            provider: selectedProvider,
          },
          prompt, // Use prompt as thread title
          assistant,
          projectMetadata
        )

        // Transfer agent mode from home screen to the new thread
        if (isAgentMode) {
          useAgentMode.getState().setAgentMode(newThread.id, true)
          useAgentMode.getState().removeThread(agentModeKey)
        }

        // Store the initial message for the new thread
        sessionStorage.setItem(
          `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${newThread.id}`,
          JSON.stringify(messagePayload)
        )

        router.navigate({
          to: route.threadsDetail,
          params: { threadId: newThread.id },
        })
      }

      setPrompt('')
      // Don't clear attachments here — document attachments stored under
      // NEW_THREAD_ATTACHMENT_KEY need to survive until the thread detail
      // page transfers and processes them.  The thread detail page's
      // processAndSendMessage already calls clearAttachmentsForThread after
      // processing is complete.
    }
  }

  useEffect(() => {
    const handleFocusIn = () => {
      if (document.activeElement === textareaRef.current) {
        setIsFocused(true)
      }
    }

    const handleFocusOut = () => {
      if (document.activeElement !== textareaRef.current) {
        setIsFocused(false)
      }
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  // Focus when component mounts
  useEffect(() => {
    if (takeFocus && textareaRef.current) {
      textareaRef.current.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tooltipShown && dropdownToolsAvailable) {
      setTooltipShown(false)
    }
  }, [dropdownToolsAvailable, tooltipShown])

  // Focus when thread changes
  useEffect(() => {
    if (takeFocus && textareaRef.current) {
      textareaRef.current.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThreadId])

  // Focus when streaming content finishes
  useEffect(() => {
    if (takeFocus && chatStatus !== 'submitted' && textareaRef.current) {
      // Small delay to ensure UI has updated
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 10)
    }
  }, [chatStatus, takeFocus])

  const stopStreaming = useCallback(
    (threadId: string) => {
      // Use onStop prop if available (AI SDK), otherwise use legacy abort
      if (onStop) {
        onStop()
      } else {
        abortControllers[threadId]?.abort()
      }
      cancelToolCall?.()
    },
    [abortControllers, cancelToolCall, onStop]
  )

  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const audioSupported = !!selectedModel?.capabilities?.includes('audio')
  const videoInputRef = useRef<HTMLInputElement>(null)
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

  const handleAttachDocsIngest = async () => {
    try {
      if (!attachmentsEnabled) {
        toast.info('Attachments are disabled in Settings')
        return
      }
      const selection = await serviceHub.dialog().open({
        multiple: true,
        filters: [
          {
            name: 'Documents & Code',
            extensions: [
              // Documents
              'pdf',
              'docx',
              'txt',
              'md',
              'csv',
              'xlsx',
              'xls',
              'ods',
              'pptx',
              'html',
              'htm',
              // JavaScript / TypeScript
              'js',
              'mjs',
              'cjs',
              'ts',
              'mts',
              'cts',
              'jsx',
              'tsx',
              // Python
              'py',
              'pyw',
              'pyi',
              // C / C++
              'c',
              'h',
              'cpp',
              'cc',
              'cxx',
              'hpp',
              'hh',
              // Systems languages
              'rs',
              'go',
              'swift',
              'zig',
              // JVM languages
              'java',
              'kt',
              'kts',
              'scala',
              'groovy',
              // Scripting languages
              'rb',
              'php',
              'lua',
              'pl',
              'r',
              'jl',
              // .NET
              'cs',
              'fs',
              'vb',
              'xaml',
              'csproj',
              'sln',
              // CUDA
              'cu',
              'cuh',
              // Shaders
              'hlsl',
              'glsl',
              'cg',
              'shader',
              // Shell
              'sh',
              'bash',
              'zsh',
              'fish',
              'ps1',
              'bat',
              'cmd',
              'vbs',
              // More languages
              'asm',
              's',
              'm',
              'mm',
              'pas',
              'pp',
              'erl',
              'hrl',
              'ex',
              'exs',
              'clj',
              'cljs',
              'hs',
              'lhs',
              'ml',
              'mli',
              'f',
              'f90',
              // Web
              'css',
              'scss',
              'sass',
              'less',
              'vue',
              'svelte',
              'astro',
              'php',
              'asp',
              'aspx',
              'jsp',
              // Data / config formats
              'json',
              'jsonc',
              'yaml',
              'yml',
              'toml',
              'xml',
              'ini',
              'cfg',
              'conf',
              'env',
              'properties',
              'dockerfile',
              'makefile',
              'cmake',
              'lock',
              // Query / markup
              'sql',
              'graphql',
              'gql',
              'tex',
              'rst',
              'adoc',
              'textile',
              // Misc text
              'log',
              'diff',
              'patch',
              'gitignore',
            ],
          },
          {
            name: 'All Files',
            extensions: ['*'],
          },
        ],
      })
      if (!selection) return
      const paths = Array.isArray(selection) ? selection : [selection]
      if (!paths.length) return

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
          toast.error('File too large', {
            description: `One or more files exceed the ${maxFileSizeMB}MB limit`,
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
        toast.warning('Files already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }

      if (newDocAttachments.length > 0) {
        await processNewDocumentAttachments(newDocAttachments)
      }
    } catch (e) {
      console.error('Failed to attach documents:', e)
      const desc = e instanceof Error ? e.message : JSON.stringify(e)
      toast.error('Failed to attach documents', { description: desc })
    }
  }

  const handleRemoveAttachment = async (indexToRemove: number) => {
    const attachmentToRemove = attachments[indexToRemove]

    // If attachment was ingested (has an ID), delete it from the backend
    if (attachmentToRemove?.id && currentThreadId) {
      try {
        if (attachmentToRemove.type === 'document') {
          const vectorDBExtension = ExtensionManager.getInstance().get(
            ExtensionTypeEnum.VectorDB
          ) as VectorDBExtension | undefined

          if (vectorDBExtension?.deleteFile) {
            await vectorDBExtension.deleteFile(
              currentThreadId,
              attachmentToRemove.id
            )
          }
        }
      } catch (error) {
        console.error('Failed to delete attachment from backend:', error)
        toast.error('Failed to remove attachment', {
          description: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }

    setAttachmentsForThread(attachmentsKey, (prev) =>
      prev.filter((_, index) => index !== indexToRemove)
    )
  }

  const getFileTypeFromExtension = (fileName: string): string => {
    const extension = fileName.toLowerCase().split('.').pop()
    switch (extension) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg'
      case 'png':
        return 'image/png'
      default:
        return ''
    }
  }

  const hashBase64 = async (base64: string): Promise<string> => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * An attach that is waiting on the user, because the model cannot read the
   * images in it. The whole batch is held, not just the pictures: cancelling
   * has to leave the draft exactly as it was, which it cannot do if the text
   * files have already been read and attached.
   */
  const [visionPrompt, setVisionPrompt] = useState<{
    files: File[]
    blocked: File[]
    canEnable: boolean
  } | null>(null)

  const openVisionPrompt = useCallback(
    async (files: File[], blocked: File[]) => {
      // Offering to turn vision on is only honest where it would work. A
      // llama.cpp model sees through an mmproj file; without one the switch
      // buys nothing but a request that fails later, so the option is withheld
      // and the reason shown instead.
      let canEnable = true
      if (selectedProvider === 'llamacpp' && selectedModel?.id) {
        try {
          canEnable = await serviceHub
            .models()
            .checkMmprojExists(selectedModel.id)
        } catch (error) {
          console.error('Failed to check mmproj support:', error)
          canEnable = false
        }
      }
      setVisionPrompt({ files, blocked, canEnable })
    },
    [selectedModel?.id, selectedProvider, serviceHub]
  )

  /** Turn vision on for the selected model, the way the edit dialog would. */
  const enableVisionOnSelectedModel = useCallback(() => {
    if (!selectedModel?.id || !selectedProvider) return
    const provider = getProviderByName(selectedProvider)
    if (!provider) return

    const models = provider.models.map((model: Model) =>
      model.id === selectedModel.id
        ? ({
            ...model,
            capabilities: Array.from(
              new Set([...(model.capabilities ?? []), 'vision'])
            ),
            // Marked as the user's own decision so the automatic capability
            // detection does not quietly take it away again.
            _userConfiguredCapabilities: true,
          } as Model)
        : model
    )
    updateProvider(selectedProvider, { ...provider, models })
  }, [
    getProviderByName,
    selectedModel?.id,
    selectedProvider,
    updateProvider,
  ])

  type ProcessImageOptions = {
    /**
     * The model's media capabilities, when they must not be read from the
     * store. Enabling vision and re-running in the same tick would otherwise
     * see the capabilities this render closed over -- the old ones.
     */
    capabilities?: ModelCapabilities
    /** The vision question has been asked and answered; do not ask again. */
    visionAsked?: boolean
  }

  const processImageFiles = useCallback(async (
    files: File[],
    options?: ProcessImageOptions
  ) => {
    const maxSize = 10 * 1024 * 1024 // 10MB in bytes

    const validFiles: File[] = []
    const textFiles: File[] = []
    // Each rejection keeps its own reason, so the message can say which of
    // several possible problems this file actually had.
    const rejected: { name: string; reason: RejectionReason }[] = []

    const capabilities = options?.capabilities ?? {
      vision: Boolean(selectedModel?.capabilities?.includes('vision')),
      audio: Boolean(selectedModel?.capabilities?.includes('audio')),
      video: Boolean(selectedModel?.capabilities?.includes('video')),
    }
    const limits = {
      maxBytes: maxSize,
      maxCount: DEFAULT_ATTACHMENT_LIMITS.maxCount,
    }

    // An image handed to a model that cannot see is a question, not an error.
    // Dropping it silently threw away something the user had already decided
    // mattered, and the model's own metadata is often just incomplete -- a
    // manually added OpenAI-compatible endpoint rarely declares vision even
    // when it has it. Ask before anything is read, so a cancel leaves nothing
    // behind.
    if (!options?.visionAsked) {
      const blocked = visionBlockedFiles(files, { capabilities, limits })
      if (blocked.length > 0) {
        void openVisionPrompt(files, blocked)
        return
      }
    }

    Array.from(files).forEach((file) => {
      const decision = validateAttachment(file, { capabilities, limits })
      if (!decision.ok) {
        rejected.push({ name: file.name, reason: decision.reason })
        return
      }
      // Text and code are read as text and travel through the document
      // pipeline; raw bytes are never handed to a model.
      if (isTextual(decision.kind)) textFiles.push(file)
      else if (decision.kind === 'image') validFiles.push(file)
      else rejected.push({ name: file.name, reason: 'unsupported' })
    })

    // Process valid files into attachments
    const preparedFiles: Attachment[] = []

    // Text and code arrive as text, not bytes. They become inline document
    // attachments, which is the path the model already understands, and which
    // is why they need nothing of its media capabilities.
    for (const file of textFiles) {
      // Classification is by extension, so the bytes get the deciding vote:
      // a renamed binary or a credentials file is refused here, not sent.
      const read = await readFileAsText(file)
      if (!read.ok) {
        rejected.push({ name: file.name, reason: read.reason })
        continue
      }
      const text = read.text
      preparedFiles.push({
        ...createDocumentAttachment({
          name: file.name,
          path: file.name,
          fileType: file.name.split('.').pop(),
          size: file.size,
          parseMode: 'inline',
        }),
        inlineContent: text,
        processed: true,
      })
    }
    for (const file of validFiles) {
      const detectedType = file.type || getFileTypeFromExtension(file.name)
      const actualType = getFileTypeFromExtension(file.name) || detectedType

      const reader = new FileReader()
      await new Promise<void>((resolve) => {
        reader.onload = () => {
          const result = reader.result
          if (typeof result === 'string') {
            const base64String = result.split(',')[1]
            const att = createImageAttachment({
              name: file.name,
              size: file.size,
              mimeType: actualType,
              base64: base64String,
              dataUrl: result,
            })
            preparedFiles.push(att)
          }
          resolve()
        }
        reader.readAsDataURL(file)
      })
    }

    // Compute content hashes for deduplication (allows different images with same filename)
    for (const att of preparedFiles) {
      if (att.base64) {
        att.contentHash = await hashBase64(att.base64)
      }
    }

    const duplicates: string[] = []
    const newFiles: Attachment[] = []

    const currentAttachments = useChatAttachments.getState().getAttachments(
      attachmentsKey
    )

    const existingImageHashes = new Set<string>()
    const existingImageNames = new Set<string>()
    for (const a of currentAttachments) {
      if (a.type !== 'image') continue
      if (a.contentHash) {
        existingImageHashes.add(a.contentHash)
      } else if (a.base64) {
        existingImageHashes.add(await hashBase64(a.base64))
      } else {
        existingImageNames.add(a.name)
      }
    }

    const seenHashesInBatch = new Set<string>()
    for (const att of preparedFiles) {
      const hash = att.contentHash
      const isDuplicateByContent =
        hash &&
        (existingImageHashes.has(hash) || seenHashesInBatch.has(hash))
      const isDuplicateByName =
        existingImageNames.has(att.name)
      if (isDuplicateByContent || isDuplicateByName) {
        duplicates.push(att.name)
        continue
      }
      if (hash) {
        seenHashesInBatch.add(hash)
      }
      newFiles.push(att)
    }

    setAttachmentsForThread(attachmentsKey, (prev) =>
      newFiles.length > 0 ? [...prev, ...newFiles] : prev
    )

    if (currentThreadId && newFiles.length > 0) {
      const ingestTotal = newFiles.length
      void (async () => {
        setFileIngestProgress({ completed: 0, total: ingestTotal })
        try {
          for (let i = 0; i < newFiles.length; i++) {
            const img = newFiles[i]
            const matchImg = (a: Attachment) =>
              a.type === 'image' &&
              (img.contentHash
                ? a.contentHash === img.contentHash
                : a.name === img.name)

            try {
              setAttachmentsForThread(attachmentsKey, (prev) =>
                prev.map((a) => (matchImg(a) ? { ...a, processing: true } : a))
              )

              const result = await serviceHub
                .uploads()
                .ingestImage(currentThreadId, img)

              if (result?.id) {
                setAttachmentsForThread(attachmentsKey, (prev) =>
                  prev.map((a) =>
                    matchImg(a)
                      ? {
                          ...a,
                          processing: false,
                          processed: true,
                          id: result.id,
                        }
                      : a
                  )
                )
              } else {
                throw new Error('No ID returned from image ingestion')
              }
            } catch (error) {
              console.error('Failed to ingest image:', error)
              setAttachmentsForThread(attachmentsKey, (prev) =>
                prev.filter((a) => !matchImg(a))
              )
              toast.error(`Failed to ingest ${img.name}`, {
                description:
                  error instanceof Error ? error.message : String(error),
              })
            } finally {
              setFileIngestProgress({
                completed: i + 1,
                total: ingestTotal,
              })
            }
          }
        } finally {
          setFileIngestProgress(null)
        }
      })()
    }

    // Display validation errors
    if (duplicates.length > 0) {
      toast.warning('Some images already attached', {
        description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
      })
    }

    const errors: string[] = []
    // One line per reason, naming the files it applies to. The old message
    // asserted an image-only rule that is no longer true, and never said
    // which of several problems a given file actually had.
    const byReason = new Map<RejectionReason, string[]>()
    for (const item of rejected) {
      byReason.set(item.reason, [
        ...(byReason.get(item.reason) ?? []),
        item.name,
      ])
    }
    for (const [reason, names] of byReason) {
      errors.push(`${t(reasonMessageKey(reason))}: ${names.join(', ')}`)
    }

    if (errors.length > 0) {
      setMessage(errors.join(' | '))
      // Reset file input to allow re-uploading
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } else {
      setMessage('')
    }
  }, [
    attachmentsKey,
    currentThreadId,
    setAttachmentsForThread,
    serviceHub,
    setFileIngestProgress,
    selectedModel?.capabilities,
    openVisionPrompt,
    t,
  ])

  /** Act on the answer to the vision question, then let the attach finish. */
  const handleVisionChoice = useCallback(
    async (choice: VisionDisabledChoice) => {
      const pending = visionPrompt
      setVisionPrompt(null)
      if (!pending) return

      // The picker keeps its last selection, so it has to be cleared or the
      // same file cannot be chosen again.
      if (fileInputRef.current) fileInputRef.current.value = ''

      if (choice === 'cancel') return

      if (choice === 'proceed') {
        const blocked = new Set(pending.blocked)
        const rest = pending.files.filter((file) => !blocked.has(file))
        if (rest.length > 0)
          await processImageFiles(rest, { visionAsked: true })
        return
      }

      enableVisionOnSelectedModel()
      await processImageFiles(pending.files, {
        visionAsked: true,
        // The store update lands in the next render; this call must not wait
        // for it, so the new capability is passed in directly.
        capabilities: {
          vision: true,
          audio: Boolean(selectedModel?.capabilities?.includes('audio')),
          video: Boolean(selectedModel?.capabilities?.includes('video')),
        },
      })
    },
    [
      enableVisionOnSelectedModel,
      processImageFiles,
      selectedModel?.capabilities,
      visionPrompt,
    ]
  )

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files

    if (files && files.length > 0) {
      void processImageFiles(Array.from(files))

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }

    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }

  const decodeAudioDuration = (dataUrl: string): Promise<number | undefined> =>
    new Promise((resolve) => {
      try {
        const audio = new Audio()
        audio.preload = 'metadata'
        audio.onloadedmetadata = () => {
          const d = audio.duration
          resolve(Number.isFinite(d) && d > 0 ? d : undefined)
        }
        audio.onerror = () => resolve(undefined)
        audio.src = dataUrl
      } catch {
        resolve(undefined)
      }
    })

  const processAudioFiles = useCallback(
    async (files: File[]) => {
      const maxBytes = 25 * 1024 * 1024
      const oversized: string[] = []
      const invalid: string[] = []
      const prepared: Attachment[] = []

      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase()
        const ext = lower.split('.').pop()
        const isWav = file.type === 'audio/wav' || file.type === 'audio/x-wav' || ext === 'wav'
        const isMp3 = file.type === 'audio/mpeg' || file.type === 'audio/mp3' || ext === 'mp3'
        if (!isWav && !isMp3) {
          invalid.push(file.name)
          continue
        }
        if (file.size > maxBytes) {
          oversized.push(file.name)
          continue
        }
        const fmt: 'wav' | 'mp3' = isWav ? 'wav' : 'mp3'
        const mimeType = fmt === 'wav' ? 'audio/wav' : 'audio/mpeg'
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const r = reader.result
            if (typeof r === 'string') resolve(r)
            else reject(new Error('read failed'))
          }
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1] ?? ''
        const durationSec = await decodeAudioDuration(dataUrl)
        prepared.push(
          createAudioAttachment({
            name: file.name,
            base64,
            dataUrl,
            mimeType,
            audioFormat: fmt,
            size: file.size,
            durationSec,
          })
        )
      }

      const current = useChatAttachments.getState().getAttachments(attachmentsKey)
      const existingNames = new Set(
        current.filter((a) => a.type === 'audio').map((a) => a.name)
      )
      const duplicates: string[] = []
      const newOnes: Attachment[] = []
      for (const att of prepared) {
        if (existingNames.has(att.name)) {
          duplicates.push(att.name)
          continue
        }
        newOnes.push(att)
      }

      if (newOnes.length > 0) {
        setAttachmentsForThread(attachmentsKey, (prev) => [...prev, ...newOnes])
      }

      if (duplicates.length > 0) {
        toast.warning('Some audio files already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }
      const errors: string[] = []
      if (oversized.length > 0) {
        errors.push(
          `Audio file${oversized.length > 1 ? 's' : ''} too large (max 25MB): ${oversized.join(', ')}`
        )
      }
      if (invalid.length > 0) {
        errors.push(
          `Invalid audio type${invalid.length > 1 ? 's' : ''} (only WAV, MP3 allowed): ${invalid.join(', ')}`
        )
      }
      if (errors.length > 0) {
        setMessage(errors.join(' | '))
        if (audioInputRef.current) audioInputRef.current.value = ''
      }
    },
    [attachmentsKey, setAttachmentsForThread]
  )

  const handleAudioFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void processAudioFiles(Array.from(files))
      if (audioInputRef.current) audioInputRef.current.value = ''
    }
    if (textareaRef.current) textareaRef.current.focus()
  }

  const openAudioPicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }],
        })
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []
          for (const path of paths) {
            try {
              const { convertFileSrc } = await import('@tauri-apps/api/core')
              const fileUrl = convertFileSrc(path)
              const response = await fetch(fileUrl)
              if (!response.ok) throw new Error(response.statusText)
              const blob = await response.blob()
              const fileName = path.split(/[\\/]/).filter(Boolean).pop() || 'audio'
              const ext = fileName.toLowerCase().split('.').pop()
              const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'
              files.push(new File([blob], fileName, { type: mimeType }))
            } catch (error) {
              console.error('Failed to read audio file:', error)
              toast.error('Failed to read audio file', {
                description: error instanceof Error ? error.message : String(error),
              })
            }
          }
          if (files.length > 0) await processAudioFiles(files)
        }
      } catch (error) {
        console.error('Failed to open audio dialog:', error)
      }
      if (textareaRef.current) textareaRef.current.focus()
    } else {
      audioInputRef.current?.click()
    }
  }, [serviceHub, processAudioFiles])

  const processVideoFiles = useCallback(
    async (files: File[]) => {
      const maxBytes = 100 * 1024 * 1024
      const oversized: string[] = []
      const invalid: string[] = []
      const prepared: Attachment[] = []

      for (const file of Array.from(files)) {
        const ext = file.name.toLowerCase().split('.').pop()
        const isVideo =
          file.type.startsWith('video/') || VIDEO_EXTS.includes(ext ?? '')
        if (!isVideo) {
          invalid.push(file.name)
          continue
        }
        if (file.size > maxBytes) {
          oversized.push(file.name)
          continue
        }
        const mimeType = file.type.startsWith('video/')
          ? file.type
          : videoMimeForExt(ext)
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const r = reader.result
            if (typeof r === 'string') resolve(r)
            else reject(new Error('read failed'))
          }
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1] ?? ''
        prepared.push(
          createVideoAttachment({
            name: file.name,
            base64,
            dataUrl,
            mimeType,
            size: file.size,
          })
        )
      }

      const current = useChatAttachments.getState().getAttachments(attachmentsKey)
      const existingNames = new Set(
        current.filter((a) => a.type === 'video').map((a) => a.name)
      )
      const duplicates: string[] = []
      const newOnes: Attachment[] = []
      for (const att of prepared) {
        if (existingNames.has(att.name)) {
          duplicates.push(att.name)
          continue
        }
        newOnes.push(att)
      }

      if (newOnes.length > 0) {
        setAttachmentsForThread(attachmentsKey, (prev) => [...prev, ...newOnes])
      }

      if (duplicates.length > 0) {
        toast.warning('Some video files already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }
      const errors: string[] = []
      if (oversized.length > 0) {
        errors.push(
          `Video file${oversized.length > 1 ? 's' : ''} too large (max 100MB): ${oversized.join(', ')}`
        )
      }
      if (invalid.length > 0) {
        errors.push(
          `Invalid video type${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`
        )
      }
      if (errors.length > 0) {
        setMessage(errors.join(' | '))
        if (videoInputRef.current) videoInputRef.current.value = ''
      }
    },
    [attachmentsKey, setAttachmentsForThread]
  )

  const handleVideoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void processVideoFiles(Array.from(files))
      if (videoInputRef.current) videoInputRef.current.value = ''
    }
    if (textareaRef.current) textareaRef.current.focus()
  }

  const openVideoPicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [{ name: 'Video', extensions: VIDEO_EXTS }],
        })
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []
          for (const path of paths) {
            try {
              const { convertFileSrc } = await import('@tauri-apps/api/core')
              const fileUrl = convertFileSrc(path)
              const response = await fetch(fileUrl)
              if (!response.ok) throw new Error(response.statusText)
              const blob = await response.blob()
              const fileName = path.split(/[\\/]/).filter(Boolean).pop() || 'video'
              const ext = fileName.toLowerCase().split('.').pop()
              files.push(new File([blob], fileName, { type: videoMimeForExt(ext) }))
            } catch (error) {
              console.error('Failed to read video file:', error)
              toast.error('Failed to read video file', {
                description: error instanceof Error ? error.message : String(error),
              })
            }
          }
          if (files.length > 0) await processVideoFiles(files)
        }
      } catch (error) {
        console.error('Failed to open video dialog:', error)
      }
      if (textareaRef.current) textareaRef.current.focus()
    } else {
      videoInputRef.current?.click()
    }
  }, [serviceHub, processVideoFiles])

  // Open the image picker dialog (extracted for reuse)
  const openImagePicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [
            {
              name: 'Images',
              extensions: ['jpg', 'jpeg', 'png'],
            },
          ],
        })

        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []

          for (const path of paths) {
            try {
              // Use Tauri's convertFileSrc to create a valid URL for the file
              const { convertFileSrc } = await import('@tauri-apps/api/core')
              const fileUrl = convertFileSrc(path)

              // Fetch the file as blob
              const response = await fetch(fileUrl)
              if (!response.ok) {
                throw new Error(`Failed to fetch file: ${response.statusText}`)
              }

              const blob = await response.blob()
              const fileName =
                path.split(/[\\/]/).filter(Boolean).pop() || 'image'
              const ext = fileName.toLowerCase().split('.').pop()
              const mimeType =
                ext === 'png'
                  ? 'image/png'
                  : ext === 'jpg' || ext === 'jpeg'
                    ? 'image/jpeg'
                    : 'image/jpeg'

              const file = new File([blob], fileName, { type: mimeType })
              files.push(file)
            } catch (error) {
              console.error('Failed to read file:', error)
              toast.error('Failed to read file', {
                description:
                  error instanceof Error ? error.message : String(error),
              })
            }
          }

          if (files.length > 0) {
            await processImageFiles(files)
          }
        }
      } catch (error) {
        console.error('Failed to open file dialog:', error)
      }

      if (textareaRef.current) {
        textareaRef.current.focus()
      }
    } else {
      // Fallback to input click for web
      fileInputRef.current?.click()
    }
  }, [serviceHub, processImageFiles])

  // The drop zone is always live. Gating it on the model's media capabilities
  // meant a text-only model refused every drop, a plain `.txt` included, and
  // an image now opens a question rather than being turned away at the door.
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
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

    if (!e.dataTransfer) {
      console.warn('No dataTransfer available in drop event')
      return
    }

    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length === 0) return

    const isAudioFile = (f: File) => {
      const ext = f.name.toLowerCase().split('.').pop()
      return (
        f.type === 'audio/wav' ||
        f.type === 'audio/x-wav' ||
        f.type === 'audio/mpeg' ||
        f.type === 'audio/mp3' ||
        ext === 'wav' ||
        ext === 'mp3'
      )
    }

    const isVideoFile = (f: File) => {
      const ext = f.name.toLowerCase().split('.').pop()
      return f.type.startsWith('video/') || VIDEO_EXTS.includes(ext ?? '')
    }

    const audioOnes = audioSupported ? dropped.filter(isAudioFile) : []
    const videoOnes = videoSupported ? dropped.filter(isVideoFile) : []
    const otherOnes = dropped.filter(
      (f) => !audioOnes.includes(f) && !videoOnes.includes(f)
    )

    if (otherOnes.length > 0) {
      const dt = new DataTransfer()
      otherOnes.forEach((f) => dt.items.add(f))
      const syntheticEvent = {
        target: { files: dt.files },
      } as React.ChangeEvent<HTMLInputElement>
      handleFileChange(syntheticEvent)
    }
    if (audioOnes.length > 0) {
      void processAudioFiles(audioOnes)
    }
    if (videoOnes.length > 0) {
      void processVideoFiles(videoOnes)
    }
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (audioSupported) {
      const clipboardItems = e.clipboardData?.items
      if (clipboardItems && clipboardItems.length > 0) {
        const audioFiles: File[] = []
        for (const item of Array.from(clipboardItems)) {
          if (
            item.type === 'audio/wav' ||
            item.type === 'audio/x-wav' ||
            item.type === 'audio/mpeg' ||
            item.type === 'audio/mp3'
          ) {
            const f = item.getAsFile()
            if (f) audioFiles.push(f)
          }
        }
        if (audioFiles.length > 0) {
          e.preventDefault()
          await processAudioFiles(audioFiles)
          return
        }
      }
    }

    // Pasted images are handled whatever the model can read: one it
    // cannot see opens the question below rather than being dropped on
    // the floor, which is what gating this on vision amounted to.
    const clipboardItems = e.clipboardData?.items
    let hasProcessedImage = false

    // Try clipboardData.items first (traditional method)
    if (clipboardItems && clipboardItems.length > 0) {
      const imageItems = Array.from(clipboardItems).filter((item) =>
        item.type.startsWith('image/')
      )

      if (imageItems.length > 0) {
        e.preventDefault()

        const files: File[] = []
        let processedCount = 0

        imageItems.forEach((item) => {
          const file = item.getAsFile()
          if (file) {
            files.push(file)
          }
          processedCount++

          // When all items are processed, handle the valid files
          if (processedCount === imageItems.length) {
            if (files.length > 0) {
              const syntheticEvent = {
                target: {
                  files: files,
                },
              } as unknown as React.ChangeEvent<HTMLInputElement>

              handleFileChange(syntheticEvent)
              hasProcessedImage = true
            }
          }
        })

        // If we found image items but couldn't get files, fall through to modern API
        if (processedCount === imageItems.length && !hasProcessedImage) {
          // Continue to modern clipboard API fallback below
        } else {
          return // Successfully processed with traditional method
        }
      }
    }

    // Modern Clipboard API fallback (for Linux, images copied from web, etc.)
    if (
      navigator.clipboard &&
      'read' in navigator.clipboard &&
      !hasProcessedImage
    ) {
      try {
        const clipboardContents = await navigator.clipboard.read()
        const files: File[] = []

        for (const item of clipboardContents) {
          const imageTypes = item.types.filter((type) =>
            type.startsWith('image/')
          )

          for (const type of imageTypes) {
            try {
              const blob = await item.getType(type)
              // Convert blob to File with better naming
              const extension = type.split('/')[1] || 'png'
              const file = new File(
                [blob],
                `pasted-image-${Date.now()}.${extension}`,
                { type }
              )
              files.push(file)
            } catch (error) {
              console.error('Error reading clipboard item:', error)
            }
          }
        }

        if (files.length > 0) {
          e.preventDefault()
          const syntheticEvent = {
            target: {
              files: files,
            },
          } as unknown as React.ChangeEvent<HTMLInputElement>

          handleFileChange(syntheticEvent)
          return
        }
      } catch (error) {
        console.error('Clipboard API access failed:', error)
      }
    }

    // If we reach here, no image was found - allow normal text pasting to continue
    console.log(
      'No image data found in clipboard, allowing normal text paste'
    )
  }

  const isStreaming = chatStatus === 'submitted' || chatStatus === 'streaming'

  return (
    <div className="relative">
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
            className={cn(
              'relative z-20 rounded-xl border-[0.8px] border-border bg-card px-0 shadow-[0_4px_14px_rgba(0,0,0,.04)] motion-safe:transition-[border-color,box-shadow,transform] motion-safe:duration-300 motion-safe:ease-expo',
              // A clear focus: a stronger edge, a soft ring, and the box lifts.
              isFocused &&
                'border-border-strong shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_18%,transparent),0_12px_30px_-12px_rgba(0,0,0,.25)] motion-safe:-translate-y-0.5',
              isDragOver && 'border-acc ring-3 ring-ring/30 bg-acc-tint'
            )}
            data-drop-zone="true"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {attachments.length > 0 && (
              <div className="flex flex-col gap-2 p-2 pb-0">
                {/* Attachments as chips: a thumbnail or kind icon, the name,
                    and a remove button, wrapping instead of overflowing. */}
                <div className="flex min-w-0 flex-wrap gap-1.5 items-center">
                  {attachments
                    .map((att, idx) => ({ att, idx }))
                    .map(({ att, idx }) => {
                      const isImage = att.type === 'image'
                      const isAudio = att.type === 'audio'
                      const isVideo = att.type === 'video'
                      const ext = att.fileType || att.mimeType?.split('/')[1]
                      const durLabel =
                        isAudio && typeof att.durationSec === 'number'
                          ? `${Math.floor(att.durationSec / 60)}:${Math.floor(att.durationSec % 60)
                              .toString()
                              .padStart(2, '0')}`
                          : undefined
                      return (
                        <div
                          key={`${att.type}-${idx}-${att.name}`}
                          data-testid="composer-attachment-chip"
                          className="relative flex h-9 min-w-0 max-w-56 items-center gap-1.5 rounded-md border-[0.8px] border-border bg-muted pl-1 pr-1 text-xs text-foreground pointer-coarse:h-11"
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={cn(
                                  'flex min-w-0 items-center gap-1.5'
                                )}
                              >
                                <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-card text-muted-foreground">
                                  {isImage && att.dataUrl ? (
                                    <img
                                      className="object-cover w-full h-full"
                                      src={att.dataUrl}
                                      alt={`${att.name}`}
                                    />
                                  ) : isAudio ? (
                                    <Music className="size-4" />
                                  ) : isVideo ? (
                                    <Video className="size-4" />
                                  ) : (
                                    <Paperclip className="size-4" />
                                  )}
                                </span>
                                <span className="min-w-0 truncate font-medium">
                                  {att.name}
                                </span>
                                {(durLabel || (!isImage && !isAudio && !isVideo && ext)) && (
                                  <span className="shrink-0 text-[11px] uppercase text-muted-foreground tabular-nums">
                                    {durLabel ?? `.${ext}`}
                                  </span>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="text-xs">
                                <div
                                  className="font-medium truncate max-w-52"
                                  title={att.name}
                                >
                                  {att.name}
                                </div>
                                <div className="opacity-70">
                                  {isImage
                                    ? att.mimeType || 'image'
                                    : isAudio
                                      ? att.audioFormat
                                        ? `.${att.audioFormat}${durLabel ? ` · ${durLabel}` : ''}`
                                        : 'audio'
                                      : ext
                                        ? `.${ext}`
                                        : 'document'}
                                  {att.size
                                    ? ` · ${formatBytes(att.size, {
                                        decimals: (_, unit) =>
                                          unit === 'B' ? 0 : 1,
                                      })}`
                                    : ''}
                                </div>
                                {isAudio && att.dataUrl && (
                                  <audio
                                    controls
                                    src={att.dataUrl}
                                    className="mt-1 w-56"
                                  />
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>

                          {/* No remove while it is still being processed. */}
                          {att.processing ? (
                            <Loader2 className="mx-1 size-3.5 shrink-0 motion-safe:animate-spin text-muted-foreground" />
                          ) : (
                            <button
                              type="button"
                              aria-label={`${t('common:dismiss')} ${att.name}`}
                              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-9"
                              onClick={() => handleRemoveAttachment(idx)}
                            >
                              <X className="size-3.5" />
                            </button>
                          )}
                        </div>
                      )
                    })}
                </div>
              </div>
            )}
            {queuedMessages.length > 0 && (
              <div className="flex flex-col gap-1 px-3 pt-2 pb-0">
                {queuedMessages.map((msg) => (
                  <QueuedMessageChip
                    key={msg.id}
                    message={msg}
                    onEdit={(queued) => {
                      // Put the text back in the input for editing, remove from queue
                      setPrompt(queued.text)
                      removeQueuedMessage(queued.id)
                      textareaRef.current?.focus()
                    }}
                    onRemove={removeQueuedMessage}
                  />
                ))}
              </div>
            )}
            <TextareaAutosize
              dir="auto"
              ref={textareaRef}
              minRows={2}
              rows={1}
              maxRows={10}
              value={prompt}
              data-testid={'chat-input'}
              // The `@` menu is a listbox the composer drives; these tell
              // assistive technology which row is active without moving focus.
              aria-autocomplete={workingDir ? 'list' : undefined}
              aria-expanded={
                workingDir
                  ? filePickerOpen && filePickerEntries.length > 0
                  : undefined
              }
              aria-controls={filePickerOpen ? referenceListId : undefined}
              aria-activedescendant={
                filePickerOpen && filePickerEntries.length > 0
                  ? optionId(referenceListId, referenceActive)
                  : undefined
              }
              onChange={(e) => {
                const value = e.target.value
                const cursorIdx = e.target.selectionStart

                // Track when @ is freshly typed
                const prevPrompt = prompt
                handlePromptChange(value)

                // Snapshot cursor position when user types @
                if (value.includes('@') && !prevPrompt.includes('@')) {
                  filePickerCursorPos.current = cursorIdx
                } else if (value.endsWith('@') && cursorIdx > 0) {
                  filePickerCursorPos.current = cursorIdx
                } else if (!value.includes('@')) {
                  filePickerCursorPos.current = null
                } else if (filePickerCursorPos.current == null) {
                  // If picker already open, keep tracking cursor
                  filePickerCursorPos.current = cursorIdx
                }

                // Count the number of newlines to estimate rows
                const newRows = (value.match(/\n/g) || []).length + 1
                setRows(Math.min(newRows, maxRows))
              }}
              onKeyDown={(e) => {
                // e.keyCode 229 is for IME input with Safari
                const isComposing =
                  e.nativeEvent.isComposing || e.keyCode === 229
                // The `@` menu owns these keys while it is open: Enter inserts
                // the reference rather than sending, and the arrows move the
                // active row rather than walking prompt history.
                if (filePickerOpen && !aliasDraft && !isComposing) {
                  const count = filePickerEntries.length
                  const active =
                    filePickerEntries[Math.min(referenceActive, count - 1)]
                  if (count > 0 && e.key === 'ArrowDown') {
                    e.preventDefault()
                    setReferenceActive((i) => (i + 1) % count)
                    return
                  }
                  if (count > 0 && e.key === 'ArrowUp') {
                    e.preventDefault()
                    setReferenceActive((i) => (i - 1 + count) % count)
                    return
                  }
                  if (
                    count > 0 &&
                    (e.key === 'Enter' || e.key === 'Tab') &&
                    !e.shiftKey
                  ) {
                    e.preventDefault()
                    handleFilePickerSelect(active)
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    handleFilePickerClose()
                    return
                  }
                  if (e.altKey && e.key.toLowerCase() === 'a' && active) {
                    e.preventDefault()
                    if (active.kind === 'file' || active.kind === 'directory') {
                      setAliasDraft(active)
                      setAliasError(null)
                      setReferenceStatus(`Name ${active.token} as an alias`)
                    } else {
                      setReferenceStatus('Only a file or folder can be named')
                    }
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
                  e.preventDefault()
                  // Submit prompt when Enter is pressed without Shift and prompt is not empty.
                  // If streaming, handleSendMessage will queue the message automatically.
                  if ((prompt.trim() || hasSendableMedia) && !ingestingAny) {
                    handleSendMessage(prompt)
                  }
                  // When Shift+Enter is pressed, a new line is added (default behavior)
                }
                // Navigate prompt history with Up/Down arrow keys
                if (e.key === 'ArrowUp' && !isComposing) {
                  const textarea = e.currentTarget
                  const cursorAtStart =
                    textarea.selectionStart === 0 &&
                    textarea.selectionEnd === 0
                  if (cursorAtStart || !prompt) {
                    e.preventDefault()
                    navigateHistory('up')
                  }
                }
                if (e.key === 'ArrowDown' && !isComposing) {
                  const textarea = e.currentTarget
                  const cursorAtEnd =
                    textarea.selectionStart === prompt.length &&
                    textarea.selectionEnd === prompt.length
                  if (cursorAtEnd) {
                    e.preventDefault()
                    navigateHistory('down')
                  }
                }
              }}
              onPaste={handlePaste}
              placeholder={t('common:placeholder.chatInput')}
              autoFocus={takeFocus}
              spellCheck={spellCheckChatInput}
              data-gramm={spellCheckChatInput}
              data-gramm_editor={spellCheckChatInput}
              data-gramm_grammarly={spellCheckChatInput}
              className={cn(
                // 16px below md so a phone does not zoom into the field.
                'w-full shrink-0 resize-none border-none bg-transparent px-3 pt-3 pb-1 text-base leading-normal text-foreground outline-0 placeholder:text-muted-foreground md:text-[13.5px]',
                rows < maxRows && 'scrollbar-hide',
                className
              )}
            />
            {/* @path file reference picker popover */}
            {/* Shown wherever a folder is attached -- Cowork included, which
                is not "agent mode" -- because that folder is all it offers. */}
            {filePickerOpen && workingDir && (
              <div className="relative">
                <FilePickerPopover
                  entries={filePickerEntries}
                  query={filePickerQuery}
                  open={filePickerOpen}
                  position={filePickerPosition}
                  activeIndex={referenceActive}
                  onActiveChange={setReferenceActive}
                  onSelect={handleFilePickerSelect}
                  onClose={handleFilePickerClose}
                  textareaRef={textareaRef}
                  listId={referenceListId}
                  aliasDraft={aliasDraft}
                  aliasError={aliasError}
                  onAliasSave={handleAliasSave}
                  onAliasCancel={handleAliasCancel}
                />
              </div>
            )}
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

        <div ref={footerRef} className="absolute z-20 bg-transparent bottom-0 w-full p-2">
          <div className="flex justify-between items-center w-full">
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1 flex-1 min-w-0">
              <div
                className={cn(
                  'flex items-center gap-1',
                  isStreaming && 'opacity-50 pointer-events-none'
                )}
              >
                {/* Dropdown for attachments — hidden in agent mode */}
                {!effectiveAgentMode && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={t('common:attachments')}
                      className="mr-0.5 size-7 rounded-[7px] text-secondary-foreground pointer-coarse:size-11"
                    >
                      <PlusIcon className="size-[15px]" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {/* Not gated on vision: text and code are attachable to
                        any model, and hiding the only entry point behind an
                        image capability left text-only models with no way to
                        attach anything at all. */}
                    <DropdownMenuItem onClick={() => void openImagePicker()}>
                      <ImageIcon className="size-4 text-muted-foreground" />
                      <span>
                        {t('common:attachFiles.addFilesOrImages')}
                      </span>
                      <input
                        type="file"
                        ref={fileInputRef}
                        className="hidden"
                        multiple
                        accept={attachmentAccept}
                        onChange={handleFileChange}
                      />
                    </DropdownMenuItem>
                    {audioSupported && (
                      <DropdownMenuItem onClick={() => void openAudioPicker()}>
                        <Music className="size-4 text-muted-foreground" />
                        <span>Add Audio</span>
                        <input
                          type="file"
                          ref={audioInputRef}
                          className="hidden"
                          multiple
                          accept="audio/wav,audio/mpeg,.wav,.mp3"
                          onChange={handleAudioFileChange}
                        />
                      </DropdownMenuItem>
                    )}
                    {videoSupported && (
                      <DropdownMenuItem onClick={() => void openVideoPicker()}>
                        <Video className="size-4 text-muted-foreground" />
                        <span>Add Video</span>
                        <input
                          type="file"
                          ref={videoInputRef}
                          className="hidden"
                          multiple
                          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.mp4,.mov,.webm,.mkv,.avi,.m4v"
                          onChange={handleVideoFileChange}
                        />
                      </DropdownMenuItem>
                    )}
                    {/* RAG document attachments - desktop-only via dialog; shown when feature enabled */}
                    <DropdownMenuItem
                      onClick={handleAttachDocsIngest}
                      disabled={!selectedModel?.capabilities?.includes('tools')}
                    >
                      {ingestingDocs ? (
                        <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" />
                      ) : (
                        <Paperclip className="size-4 text-muted-foreground" />
                      )}
                      <span>
                        {ingestingDocs
                          ? 'Indexing documents…'
                          : 'Add documents or files'}
                      </span>
                    </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {/* {model?.provider === 'llamacpp' && loadingModel ? (
                  <ModelLoader />
                ) : (
                  <DropdownModelProvider
                    model={model}
                    useLastUsedModel={initialMessage}
                  />
                )} */}
                <AssistantSwitcher
                  assistants={assistants}
                  currentThread={currentThread}
                  selectedAssistantId={selectedAssistantId}
                  setSelectedAssistantId={setSelectedAssistantId}
                  updateCurrentThreadAssistant={updateCurrentThreadAssistant}
                />
                <SamplerPopover
                  providerId={selectedProvider}
                  modelId={selectedModel?.id}
                  assistantSwitcher={{
                    assistants,
                    currentThread,
                    selectedAssistantId,
                    setSelectedAssistantId,
                    updateCurrentThreadAssistant,
                  }}
                />
                {showToolControls && selectedModel?.capabilities?.includes('embeddings') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                          variant="ghost"
                          size="icon-xs"
                          className="size-7 rounded-[7px] pointer-coarse:size-11"
                        >
                        <CodeXml className="size-4 text-muted-foreground" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('embeddings')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {showToolControls && selectedModel?.capabilities?.includes('tools') &&
                  hasActiveMCPServers &&
                  (MCPToolComponent ? (
                    // Use custom MCP component
                    <McpExtensionToolLoader
                      tools={tools}
                      hasActiveMCPServers={hasActiveMCPServers}
                      selectedModelHasTools={
                        selectedModel?.capabilities?.includes('tools') ?? false
                      }
                      MCPToolComponent={MCPToolComponent}
                    />
                  ) : (
                    // Use default tools dropdown
                    <Tooltip
                      open={tooltipShown === 'tools'}
                      onOpenChange={(newValue) => newValue ? setTooltipShown('tools') : setTooltipShown(false)}
                    >
                      <TooltipTrigger
                        asChild
                        disabled={dropdownToolsAvailable}
                      >
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="size-7 rounded-[7px] pointer-coarse:size-11"
                          onClick={(e) => {
                            setDropdownToolsAvailable(false)
                            e.stopPropagation()
                          }}
                        >
                          <DropdownToolsAvailable
                            onOpenChange={(isOpen) => {
                              setDropdownToolsAvailable(isOpen)
                              if (isOpen) {
                                setTooltipShown(false)
                              }
                            }}
                          >
                            {() => {
                              return (
                                <div
                                  className={cn(
                                    'p-1 flex items-center justify-center rounded-sm transition-all duration-200 ease-in-out gap-1 cursor-pointer',
                                  )}
                                >
                                  <Wrench
                                    className={cn(
                                      'size-4 text-muted-foreground',
                                    )}
                                  />
                                </div>
                              )
                            }}
                          </DropdownToolsAvailable>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('tools')}</p>
                      </TooltipContent>
                    </Tooltip>
                  ))}

                {/* Agent mode toggle hidden — kept as dead code for future use */}
                {false && !projectId && isAgentMode && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={isAgentMode ? "default" : "ghost"}
                        size="icon-xs"
                        onClick={currentThreadId ? handleAgentToggle : undefined}
                        className={cn(
                          isAgentMode && 'items-center bg-[color-mix(in_oklab,var(--primary)_12%,transparent)] text-foreground hover:bg-[color-mix(in_oklab,var(--primary)_16%,transparent)]',
                          !currentThreadId && 'cursor-default pointer-events-none'
                        )}
                      >
                        <BotIcon
                          className={cn(
                            'text-muted-foreground -mt-0.5',
                            isAgentMode && 'text-foreground'
                          )}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {isAgentMode
                          ? 'Agent mode active'
                          : 'Enable agent mode'}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {!effectiveAgentMode && selectedModel?.capabilities?.includes('tools') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-pressed={webSearchEnabled}
                        className={cn(
                          'size-7 rounded-[7px] pointer-coarse:size-11',
                          webSearchEnabled && 'bg-[color-mix(in_oklab,var(--primary)_12%,transparent)] text-foreground hover:bg-[color-mix(in_oklab,var(--primary)_16%,transparent)]'
                        )}
                        onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                      >
                        <Globe
                          className={cn(
                            'size-4 text-muted-foreground',
                            webSearchEnabled && 'text-foreground'
                          )}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {webSearchEnabled
                          ? t('common:web_search') + t('common:activeSuffix')
                          : t('common:web_search')}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {!effectiveAgentMode &&
                  (selectedProvider === 'llamacpp' ||
                    selectedProvider === 'google' ||
                    selectedProvider === 'gemini' ||
                    selectedProvider === 'anthropic' ||
                    selectedProvider === 'openai' ||
                    isOpenAICompatibleReasoningProvider(
                      selectedProvider,
                      selectedModel
                    )) &&
                  (() => {
                    // The token-budget submenu only applies to local llama.cpp
                    // (budget resolved against live n_ctx). Cloud providers size
                    // their own budget dynamically, so on/off/auto is enough.
                    const showThinkingBudget = selectedProvider === 'llamacpp'
                    // Auto/On/Off writes the `reasoning` setting, which only the
                    // first-party providers wire into a request. A remote
                    // OpenAI-compatible model reaches this menu solely for the
                    // effort bar, so it must not show reasoning items that would
                    // do nothing.
                    const showReasoningModes =
                      selectedProvider === 'llamacpp' ||
                      selectedProvider === 'google' ||
                      selectedProvider === 'gemini' ||
                      selectedProvider === 'anthropic' ||
                      selectedProvider === 'openai'
                    const reasoningValue =
                      (selectedModel?.settings?.reasoning?.controller_props
                        ?.value as 'auto' | 'on' | 'off' | undefined) ?? 'auto'
                    const updateModelSetting = (
                      settingKey: string,
                      title: string,
                      controllerType: string,
                      value: unknown
                    ) => {
                      if (!selectedProvider || !selectedModel) return
                      const providerObj = getProviderByName(selectedProvider)
                      if (!providerObj) return
                      const modelIndex = providerObj.models.findIndex(
                        (m) => m.id === selectedModel.id
                      )
                      if (modelIndex === -1) return
                      const existing = selectedModel.settings?.[settingKey] ?? {
                        key: settingKey,
                        title,
                        description: '',
                        controller_type: controllerType,
                        controller_props: { value },
                      }
                      const updatedModel = {
                        ...selectedModel,
                        settings: {
                          ...selectedModel.settings,
                          [settingKey]: {
                            ...existing,
                            controller_props: {
                              ...(existing.controller_props ?? {}),
                              value,
                            },
                          },
                        },
                      } as Model
                      const updatedModels = [...providerObj.models]
                      updatedModels[modelIndex] = updatedModel
                      updateProvider(selectedProvider, {
                        models: updatedModels,
                      })
                      // selectedModel is a snapshot, not a live derivation —
                      // re-select to refresh it so the dropdown UI and the
                      // chat transport both observe the new value.
                      selectModelProvider(selectedProvider, selectedModel.id)
                    }

                    // Providers that honour a discrete reasoning effort get the
                    // stepped bar. Which levels exist is the provider's answer,
                    // not a guess: see `supportedEffortLevels`. The value is
                    // stored per chat, over the global model configuration.
                    // Which discrete effort levels this provider will act
                    // on. Empty for providers that size their own thinking, in
                    // which case the bar is not shown at all — see
                    // `supportedEffortLevels`.
                    const effortLevels = supportedEffortLevels(
                      selectedProvider,
                      selectedModel
                    )
                    // What this chat will actually send: its own override
                    // where it has one, the global model setting otherwise.
                    const currentEffort = effortOf(
                      resolveModel(selectedModel, chatOverrides)
                    )
                    const effortOverridden = isOverridden(
                      chatOverrides,
                      EFFORT_SETTING_KEY
                    )
                    /**
                     * Store the chosen level.
                     *
                     * Per chat once a chat exists. On the new-chat screen there
                     * is no thread yet, and the control still has to work — so
                     * it writes the global model setting there, which is what
                     * the menu it replaced always did.
                     */
                    const setEffort = (level: string) => {
                      if (currentThreadId) {
                        setThreadOverride(
                          currentThreadId,
                          EFFORT_SETTING_KEY,
                          level
                        )
                        return
                      }
                      updateModelSetting(
                        EFFORT_SETTING_KEY,
                        'Reasoning Effort',
                        'dropdown',
                        level
                      )
                    }
                    const setReasoning = (value: 'auto' | 'on' | 'off') =>
                      updateModelSetting(
                        'reasoning',
                        'Reasoning',
                        'dropdown',
                        value
                      )
                    const label =
                      reasoningValue === 'on'
                        ? 'On'
                        : reasoningValue === 'off'
                          ? 'Off'
                          : 'Auto'
                    const tooltipText =
                      reasoningValue === 'on'
                        ? 'Reasoning forced on for every request.'
                        : reasoningValue === 'off'
                          ? 'Reasoning disabled for every request.'
                          : "Reasoning uses the model's default."

                    // Stored as a symbolic level, not an absolute token count:
                    // the live context size (post auto-fit) is only known once
                    // the model is actually loaded, so resolving to tokens
                    // happens at send time (custom-chat-transport.ts) against
                    // whatever the context size turns out to be then.
                    const rawBudgetLevel =
                      selectedModel?.settings?.thinking_budget_tokens
                        ?.controller_props?.value
                    const currentBudgetLevel = isThinkingBudgetLevelKey(
                      rawBudgetLevel
                    )
                      ? rawBudgetLevel
                      : DEFAULT_THINKING_BUDGET_LEVEL
                    const setThinkingBudget = (level: ThinkingBudgetLevelKey) =>
                      updateModelSetting(
                        'thinking_budget_tokens',
                        'Thinking Budget',
                        'dropdown',
                        level
                      )
                    const currentBudgetLabel = THINKING_BUDGET_LEVELS.find(
                      (l) => l.key === currentBudgetLevel
                    )!.label
                    // Best-effort preview only; the request-time value may
                    // differ once the model is loaded and fit settles n_ctx.
                    const approxContextSize =
                      liveMaxTokens || configuredCtxLen || 8192

                    return (
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="size-7 rounded-[7px] pointer-coarse:size-11"
                                aria-label={`Reasoning: ${label}`}
                              >
                                <Brain
                                  className={cn(
                                    'size-4 text-muted-foreground',
                                    reasoningValue === 'on' && 'text-foreground',
                                    reasoningValue === 'off' && 'opacity-50'
                                  )}
                                />
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{tooltipText}</p>
                          </TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="start" className="w-64">
                          {effortLevels.length > 0 && (
                            <>
                              <div className="px-2 py-1.5">
                                <ReasoningEffortSlider
                                  levels={effortLevels}
                                  value={currentEffort}
                                  overridden={effortOverridden}
                                  onChange={setEffort}
                                  onReset={
                                    currentThreadId && effortOverridden
                                      ? () =>
                                          clearThreadOverride(
                                            currentThreadId,
                                            EFFORT_SETTING_KEY
                                          )
                                      : undefined
                                  }
                                />
                              </div>
                              {showReasoningModes && <DropdownMenuSeparator />}
                            </>
                          )}
                          {showReasoningModes && (
                            <>
                              <DropdownMenuItem
                                onClick={() => setReasoning('auto')}
                              >
                                Auto
                                {reasoningValue === 'auto' && (
                                  <span className="ml-auto text-xs text-muted-foreground">
                                    ✓
                                  </span>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setReasoning('on')}>
                                On
                                {reasoningValue === 'on' && (
                                  <span className="ml-auto text-xs text-muted-foreground">
                                    ✓
                                  </span>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setReasoning('off')}
                              >
                                Off
                                {reasoningValue === 'off' && (
                                  <span className="ml-auto text-xs text-muted-foreground">
                                    ✓
                                  </span>
                                )}
                              </DropdownMenuItem>
                            </>
                          )}
                          {showThinkingBudget && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                  <span className="flex-1">Thinking Budget</span>
                                  <span className="text-xs text-muted-foreground">
                                    {currentBudgetLabel}
                                  </span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent
                                  collisionPadding={{ bottom: 16 }}
                                >
                                  {THINKING_BUDGET_LEVELS.map((level) => {
                                    const approxTokens =
                                      tokensForThinkingBudgetLevel(
                                        level.key,
                                        approxContextSize
                                      )
                                    return (
                                      <DropdownMenuItem
                                        key={level.key}
                                        onClick={() =>
                                          setThinkingBudget(level.key)
                                        }
                                        className="gap-2"
                                      >
                                        <span className="flex-1">
                                          {level.label}
                                        </span>
                                        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                                          {approxTokens === -1
                                            ? ''
                                            : `~${approxTokens}`}
                                        </span>
                                        <span className="w-3 shrink-0 text-xs text-muted-foreground">
                                          {currentBudgetLevel === level.key
                                            ? '✓'
                                            : ''}
                                        </span>
                                      </DropdownMenuItem>
                                    )
                                  })}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  })()}
              </div>
              {surfaceControls && (
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  <Separator
                    orientation="vertical"
                    className="mx-1 h-4 shrink-0"
                  />
                  {surfaceControls}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {tokenCounterVisible && tokenCounterCompact && (
                <div className="flex-1 flex justify-center">
                  <TokenCounter
                    messages={threadMessages || []}
                    source={tokenSource}
                    compact={true}
                  />
                </div>
              )}

              {/* A surface that owns its own stop control -- Cowork, which
                  asks how far to stop -- supplies it here, in the same slot,
                  so there is never a second stop button beside this one. */}
              {isStreaming && stopControl ? (
                stopControl
              ) : isStreaming ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* A quiet red outline: stopping keeps the partial
                        reply, so it is not a filled destructive action. */}
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="size-7 border-destructive/40 text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive hover:shadow-none pointer-coarse:size-11"
                      data-test-id="stop-button"
                      aria-label={
                        queueLength > 0
                          ? `Clear ${queueLength} queued message(s)`
                          : 'Stop generating'
                      }
                      onClick={() => {
                        // Stopping with messages queued clears the queue —
                        // there is nothing to interrupt yet. The old
                        // `if (!currentThreadId) return` guard made this button
                        // inert for any surface without a thread id.
                        if (queueId) {
                          const queue = useMessageQueue
                            .getState()
                            .getQueue(queueId)
                          if (queue.length > 0) {
                            useMessageQueue.getState().clearQueue(queueId)
                            return
                          }
                        }
                        stopStreaming(currentThreadId ?? '')
                      }}
                    >
                      <Square className="size-3 fill-current" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{queueLength > 0 ? `Clear ${queueLength} queued message(s)` : 'Stop generating'}</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  variant="default"
                  size="icon-sm"
                  disabled={(!prompt.trim() && !hasSendableMedia) || ingestingAny}
                  data-test-id="send-message-button"
                  aria-label={t('chat:sendMessage')}
                  onClick={() => handleSendMessage(prompt)}
                  className={cn(
                    'size-7 pointer-coarse:size-11',
                    // Wakes up with a small pop once there is something to send.
                    (prompt.trim() || hasSendableMedia) &&
                      !ingestingAny &&
                      'shadow-[0_4px_14px_-4px_rgba(0,0,0,.35)] motion-safe:animate-send-ready'
                  )}
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {message && (
        <div
          role="alert"
          className="mt-1.5 mx-1 rounded-lg border-[0.8px] border-destructive/30 bg-destructive-tint px-3 py-1.5 text-xs text-destructive"
        >
          <div className="flex items-center gap-2 justify-between">
            <span className="min-w-0 wrap-break-word">{message}</span>
            <button
              type="button"
              aria-label={t('common:dismiss')}
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
              onClick={() => {
                setMessage('')
                // Reset file input to allow re-uploading the same file
                if (fileInputRef.current) {
                  fileInputRef.current.value = ''
                }
              }}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      {tokenCounterVisible && !tokenCounterCompact && (
        <div className="flex-1 w-full flex justify-start px-2">
          <TokenCounter messages={threadMessages || []} source={tokenSource} />
        </div>
      )}

      <VisionDisabledDialog
        open={visionPrompt !== null}
        fileNames={(visionPrompt?.blocked ?? []).map((file) => file.name)}
        modelName={
          selectedModel ? getModelDisplayName(selectedModel) : ''
        }
        canEnable={visionPrompt?.canEnable ?? false}
        onChoose={(choice) => void handleVisionChoice(choice)}
      />

    </div>
  )
})

export default ChatInput
