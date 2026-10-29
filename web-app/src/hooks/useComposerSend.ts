import { useEffect, useRef, useState, type RefObject } from 'react'
import { useRouter } from '@tanstack/react-router'
import { generateId } from 'ai'
import { toast } from 'sonner'
import { stripInvisible } from '@/lib/invisibleText'
import {
  refusedDraftToRestore,
  unescapeComposerMarkdown,
} from '@/lib/composerText'
import { isSendableAttachment } from '@/lib/attachmentChip'
import { offerToEnableMentionedServers } from '@/lib/mcpMention'
import { modelKey, unavailableModels } from '@/lib/modelReplace'
import { currentDescriber } from '@/lib/imageDescription'
import { needsWeb } from '@/lib/needsWeb'
import { withdrawApprovalsForSteering } from '@/lib/chatSteering'
import { resolveReplyModel } from '@/lib/resolveReplyModel'
import { resolveThreadModelId } from '@/lib/models'
import { resolvePromptMentions, withMentionBlocks } from '@/lib/chatMentionSend'
import { modelSummarizer } from '@/lib/compactionSummarizer'
import { safeSessionSet } from '@/lib/safeStorage'
import { withoutSent } from '@/lib/attachmentIntake'
import type { EnableableCapability } from '@/lib/modelCapabilityEnable'
import type { Attachment } from '@/types/attachment'
import { route } from '@/constants/routes'
import {
  TEMPORARY_CHAT_ID,
  TEMPORARY_CHAT_QUERY_ID,
  SESSION_STORAGE_PREFIX,
} from '@/constants/chat'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { useMessageQueue } from '@/stores/message-queue-store'
import { promptReplaceModels } from '@/hooks/useModelReplacePrompt'
import { useDraftSampling } from '@/hooks/useDraftSampling'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useWebSearchChoice } from '@/hooks/useWebSearchChoice'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useLatestCallback } from '@/hooks/useLatestCallback'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { usePrompt } from '@/hooks/usePrompt'
import type { useAssistant } from '@/hooks/useAssistant'
import type { ModelSelection } from '@/hooks/useConversationPane'
import type { useSlashCommands } from '@/hooks/useSlashCommands'
import type { useReferencePicker } from '@/hooks/useReferencePicker'
import { useTranslation } from '@/i18n/react-i18next-compat'

export type ModelCheck = { status: 'ok' | 'stop' } | { status: 'retry'; modelId: string }

type Assistants = ReturnType<typeof useAssistant.getState>

export type ComposerSubmit = (
  text: string,
  files?: Array<{ type: string; mediaType: string; url: string }>,
  /**
   * Call when the send is refused before anything started (no tool-calling
   * model, say): the composer then gets its text and attachments back.
   */
  onRefused?: () => void
) => void

type ComposerSendDeps = {
  modelSelection: ModelSelection | undefined
  currentThread: ReturnType<ReturnType<typeof useThreads.getState>['getCurrentThread']>
  selectModelProvider: ReturnType<typeof useModelProvider.getState>['selectModelProvider']
  latestPromptRef: RefObject<string>
  setWebOffPrompt: (prompt: string | null) => void
  webSearchEnabled: boolean
  slashCommands: ReturnType<typeof useSlashCommands>
  confirmModel?: () => ModelCheck | Promise<ModelCheck>
  selectedModel: ModelSelection['selectedModel']
  unavailableModel?: string
  allProviders: ReturnType<typeof useModelProvider.getState>['providers']
  preferredModel: ReturnType<typeof useModelEvidence.getState>['preferredModel']
  setMessage: (message: string) => void
  attachments: Attachment[]
  selectedProvider: ModelSelection['selectedProvider']
  requestCapabilities: (
    capabilities: EnableableCapability[],
    onEnabled: () => void | Promise<void>
  ) => void
  setPrompt: (value: string) => void
  resolvePromptReferences: ReturnType<
    typeof useReferencePicker
  >['resolvePromptReferences']
  scopeKey?: string
  currentThreadId: string | undefined
  ownsToolSet: boolean
  effectiveAgentMode: boolean
  canSummarize: boolean
  attachmentsKey: string
  addToHistory: ReturnType<typeof usePrompt.getState>['addToHistory']
  onSubmit?: ComposerSubmit
  isStreaming: boolean
  threadBusy: boolean
  queueId: string
  restoredDraftRef: RefObject<string | null>
  isAgentMode: boolean
  agentModeKey: string
  projectId?: string
  assistants: Assistants['assistants']
  selectedAssistantId: string | undefined
  setCurrentAssistant: Assistants['setCurrentAssistant']
  webSearchScope?: string | null
  prompt: string
}

/**
 * Sending from the composer: the web-search and model checks, capabilities a
 * draft's attachments need, `/` commands, `@` references and mentions, then
 * queueing behind a run, handing to the surface's `onSubmit`, or starting a
 * new thread. One send at a time; a send parked for a model switch goes once
 * the model shows.
 */
export function useComposerSend(deps: ComposerSendDeps) {
  const {
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
  } = deps
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const router = useRouter()
  const createThread = useThreads((state) => state.createThread)
  const getProviderByName = useModelProvider((state) => state.getProviderByName)
  const setAttachmentsForThread = useChatAttachments(
    (state) => state.setAttachments
  )
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

  return { handleSendMessage, sending }
}
