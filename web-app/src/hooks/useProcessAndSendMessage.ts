import { useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { UIMessage, UseChatHelpers } from '@ai-sdk/react'
import { generateId } from 'ai'
import { toast } from 'sonner'
import type { ServiceHub } from '@/services'
import { useAppState } from '@/hooks/useAppState'
import { useAttachments } from '@/hooks/useAttachments'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import type { useConversationModel } from '@/hooks/useConversationPane'
import { useMessages } from '@/hooks/useMessages'
import { useModelProvider } from '@/hooks/useModelProvider'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { useToolApproval } from '@/hooks/useToolApproval'
import type { useTranslation } from '@/i18n/react-i18next-compat'
import {
  applyIngestionChoices,
  describeAttachmentFailure,
  isMissingFileError,
  estimateAttachmentTokens,
  needsIngestionChoice,
  processAttachmentsForSend,
  promptIngestionChoices,
  resolveAutoInlineBudget,
} from '@/lib/attachmentProcessing'
import { estimateTokens as estimateTextTokens } from '@/lib/context-manager'
import { newUserThreadContent } from '@/lib/completion'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'
import { computeActivePath, hasBranching } from '@/lib/message-branching'
import { markThreadHasDocuments } from '@/lib/threadDocuments'
import {
  createImageAttachment,
  createAudioAttachment,
  createVideoAttachment,
} from '@/types/attachment'

type ChatAttachmentsState = ReturnType<typeof useChatAttachments.getState>

/**
 * The Chat composer's send: resolves the attachments (asking how to ingest a
 * document when the model's window cannot decide it), stores the user turn,
 * and hands it to the AI SDK. Lifted out of ThreadConversation.tsx unchanged,
 * memoized on the same values as before.
 */
export function useProcessAndSendMessage({
  threadId,
  thread,
  selectedModel,
  selectedProvider,
  toolsEnabled,
  serviceHub,
  attachmentsKey,
  getAttachments,
  setAttachmentsForThread,
  clearAttachmentsForThread,
  titleAbortRef,
  pendingAssistantParentId,
  addMessage,
  setChatMessages,
  sendMessage,
  t,
}: {
  threadId: string
  thread: Thread | undefined
  selectedModel: ReturnType<typeof useConversationModel>['selectedModel']
  selectedProvider: string
  toolsEnabled: boolean
  serviceHub: ServiceHub
  attachmentsKey: string
  getAttachments: ChatAttachmentsState['getAttachments']
  setAttachmentsForThread: ChatAttachmentsState['setAttachments']
  clearAttachmentsForThread: ChatAttachmentsState['clearAttachments']
  titleAbortRef: MutableRefObject<AbortController | null>
  pendingAssistantParentId: MutableRefObject<string | null>
  addMessage: ReturnType<typeof useMessages.getState>['addMessage']
  setChatMessages: UseChatHelpers<UIMessage>['setMessages']
  sendMessage: UseChatHelpers<UIMessage>['sendMessage']
  t: ReturnType<typeof useTranslation>['t']
}) {
  return useCallback(
    async (
      text: string,
      files?: Array<{ type: string; mediaType: string; url: string }>
    ) => {
      // Cancel any in-flight title summarization so it doesn't compete with this request
      titleAbortRef.current?.abort()
      titleAbortRef.current = null

      // Get all attachments from the store (media transferred from the
      // new-thread key, plus documents).
      const allAttachments = getAttachments(attachmentsKey)

      // In-thread sends pass media inline via `files`; reconstruct typed by
      // mediaType (image/audio/video — not all images). New-thread sends pass
      // no media in `files` (quota), so fall back to media already in the store.
      const fileMediaAttachments = (files ?? []).map((file) => {
        const base64 = file.url.split(',')[1] || ''
        const size = Math.ceil((base64.length * 3) / 4) // Estimate from base64
        if (file.mediaType.startsWith('audio/')) {
          return createAudioAttachment({
            name: `audio-${Date.now()}`,
            mimeType: file.mediaType,
            dataUrl: file.url,
            audioFormat: file.mediaType === 'audio/mpeg' ? 'mp3' : 'wav',
            size,
          })
        }
        if (file.mediaType.startsWith('video/')) {
          return createVideoAttachment({
            name: `video-${Date.now()}`,
            mimeType: file.mediaType,
            dataUrl: file.url,
            size,
          })
        }
        return createImageAttachment({
          name: `image-${Date.now()}`,
          mimeType: file.mediaType,
          dataUrl: file.url,
          size,
        })
      })

      const storeMediaAttachments = allAttachments.filter(
        (a) => a.type === 'image' || a.type === 'audio' || a.type === 'video'
      )
      const mediaAttachments = fileMediaAttachments.length
        ? fileMediaAttachments
        : storeMediaAttachments

      // Combine media attachments with document attachments from the store
      let combinedAttachments = [
        ...mediaAttachments,
        ...allAttachments.filter((a) => a.type === 'document'),
      ]

      const projectId = thread?.metadata?.project?.id
      const { parseMode: parsePreference, autoInlineContextRatio } =
        useAttachments.getState()
      const hasUnprocessedDocs = combinedAttachments.some(
        (a) => a.type === 'document' && !a.processed
      )
      let contextThreshold: number | undefined
      if (hasUnprocessedDocs && !projectId) {
        const modelState = useModelProvider.getState()
        // What the conversation already occupies: a document that fits the
        // bare window can still overflow it on top of a long thread.
        const usedTokens = useMessages
          .getState()
          .getMessages(threadId)
          .reduce(
            (sum, m) =>
              sum +
              (m.content ?? []).reduce(
                (n, c) => n + estimateTextTokens(c.text?.value ?? ''),
                0
              ),
            0
          )
        contextThreshold = resolveAutoInlineBudget(
          modelState.selectedModel,
          modelState.getProviderByName(selectedProvider),
          autoInlineContextRatio,
          usedTokens
        )
      }
      // The budget can be gone since attach time (model switched, window
      // unknown), so 'auto' documents that would silently fall back to
      // embeddings are put to the user. Project files always embed.
      // A model that cannot call tools gets every document in its prompt, so
      // there is nothing to choose (janhq/jan#9388).
      const unrouted =
        projectId || contextThreshold !== undefined || !toolsEnabled
          ? []
          : combinedAttachments.filter((a) =>
              needsIngestionChoice(a, parsePreference, false)
            )
      if (unrouted.length > 0) {
        const choices = await promptIngestionChoices(unrouted)
        if (!choices) {
          // ChatInput cleared the input on submit; hand the draft back so
          // cancelling only cancels the send.
          setAttachmentsForThread(attachmentsKey, () => allAttachments)
          usePrompt.getState().setPrompt(text)
          return
        }
        combinedAttachments = applyIngestionChoices(
          combinedAttachments,
          choices
        )
      }

      const messageId = generateId()
      const hasDocuments = combinedAttachments.some(
        (a) => a.type === 'document' && !a.processed
      )
      const hasEmbeddingDocuments = combinedAttachments.some(
        (a) =>
          a.type === 'document' &&
          !a.processed &&
          a.parseMode !== 'inline' &&
          toolsEnabled
      )

      // When there are unprocessed documents (e.g. first-message flow),
      // show the user message in the conversation immediately so the UI
      // doesn't hang while embeddings are generated.
      if (hasDocuments) {
        const previewMessage = newUserThreadContent(
          threadId,
          text,
          combinedAttachments,
          messageId
        )
        const previewUI =
          convertThreadMessagesToUIMessages([previewMessage])
        setChatMessages((prev) => [...prev, ...previewUI])
      }

      // Clear attachment chips from the input — they are now either
      // about to be sent or visible in the preview message above.
      clearAttachmentsForThread(attachmentsKey)

      // Process attachments (ingest images, parse/index documents)
      let processedAttachments = combinedAttachments
      if (combinedAttachments.length > 0) {
        if (hasEmbeddingDocuments) {
          useAppState.getState().setThreadEmbedding(threadId, true)
          useAppState.getState().setThreadBusy(threadId, true)
        }
        try {
          const result = await processAttachmentsForSend({
            attachments: combinedAttachments,
            threadId,
            projectId,
            serviceHub,
            selectedProvider,
            modelSupportsTools: toolsEnabled,
            modelSupportsVision: !!selectedModel?.capabilities?.includes('vision'),
            parsePreference,
            contextThreshold,
            estimateTokens: estimateAttachmentTokens,
          })
          processedAttachments = result.processedAttachments

          // Update thread metadata if documents were embedded
          if (result.hasEmbeddedDocuments) {
            const toolApproval = useToolApproval.getState()
            const ragTools = useAppState.getState().ragToolNames
            for (const toolName of ragTools) {
              toolApproval.approveToolForThread(threadId, toolName)
            }
            markThreadHasDocuments(threadId)
          }
        } catch (error) {
          console.error('Failed to process attachments:', error)
          // Remove the preview message on failure
          if (hasDocuments) {
            setChatMessages((prev) =>
              prev.filter((m) => m.id !== messageId)
            )
          }
          // Hand the draft back, as a cancelled send does, and say why.
          setAttachmentsForThread(attachmentsKey, () => allAttachments)
          usePrompt.getState().setPrompt(text)
          toast.error(t('common:attachmentsProcessFailed'), {
            description: isMissingFileError(error)
              ? t('common:attachmentMissingFile')
              : describeAttachmentFailure(error),
          })
          return
        } finally {
          // Only what this send set: a send with just images must not clear
          // the busy flag of a turn whose tools are still waiting.
          if (hasEmbeddingDocuments) {
            useAppState.getState().setThreadEmbedding(threadId, false)
            useAppState.getState().setThreadBusy(threadId, false)
          }
        }
      }

      // Remove the preview before sendMessage adds the real user message
      // with the same id — this prevents duplicates.
      if (hasDocuments) {
        setChatMessages((prev) => prev.filter((m) => m.id !== messageId))
      }

      // Persist the final message to backend
      const baseUserMessage = newUserThreadContent(
        threadId,
        text,
        processedAttachments,
        messageId
      )
      // Once a thread has branches, link new turns into the active path so the
      // assistant reply attaches to this message. Legacy threads stay linear.
      const branchedMessages = useMessages.getState().getMessages(threadId)
      let userMessage = baseUserMessage
      if (hasBranching(branchedMessages)) {
        const activeRootId = (
          useThreads.getState().threads[threadId]?.metadata as
            | Record<string, unknown>
            | undefined
        )?.activeRootId as string | undefined
        const path = computeActivePath(branchedMessages, activeRootId)
        const parentId = path.length ? path[path.length - 1].id : null
        userMessage = {
          ...baseUserMessage,
          metadata: { ...(baseUserMessage.metadata ?? {}), parentId },
        }
        pendingAssistantParentId.current = messageId
      }
      addMessage(userMessage)

      // Build parts for AI SDK. Derive media file parts from the resolved
      // attachments (not the raw `files` arg) so the first-message flow — where
      // media lives in the store and `files` is empty — still renders live.
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'file'; mediaType: string; url: string }
      > = [
        {
          type: 'text',
          text: userMessage.content[0].text?.value ?? text,
        },
      ]

      mediaAttachments.forEach((a) => {
        if (a.dataUrl && a.mimeType) {
          parts.push({
            type: 'file',
            mediaType: a.mimeType,
            url: a.dataUrl,
          })
        }
      })

      sendMessage({
        parts,
        id: messageId,
        metadata: { ...userMessage.metadata, createdAt: new Date() },
      })
    },
    // selectedModel is read as of the last change below, as it always was;
    // the refs it reads are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sendMessage,
      threadId,
      thread,
      addMessage,
      getAttachments,
      attachmentsKey,
      setAttachmentsForThread,
      setChatMessages,
      clearAttachmentsForThread,
      serviceHub,
      selectedProvider,
      toolsEnabled,
      t,
    ]
  )
}
