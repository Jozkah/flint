import {
  CustomChatTransport,
  type ContinuationContent,
} from '@/lib/custom-chat-transport'
import {
  Chat,
  type UIMessage,
  type UseChatOptions,
  useChat as useChatSDK,
} from '@ai-sdk/react'
import { type ChatInit } from 'ai'
import { useEffect, useMemo, useRef, useCallback } from 'react'
import { useChatSessions } from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import type { TokenUsage } from '@/lib/tokenUsage'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useChatMemoryBinding } from '@/hooks/useChatMemoryBinding'

type CustomChatOptions = Omit<ChatInit<UIMessage>, 'transport'> &
  Pick<UseChatOptions<UIMessage>, 'experimental_throttle' | 'resume'> & {
    sessionId?: string
    sessionTitle?: string
    systemMessage?: string
    onTokenUsage?: (usage: TokenUsage, messageId: string) => void;
    /**
     * The model this conversation sends with, when it is not the global
     * picker's: a split conversation pane passes its own thread's model.
     * Return `undefined` to use the global picker.
     */
    resolveModelSelection?: Parameters<
      CustomChatTransport['setModelSelectionResolver']
    >[0]
  }

// This is a wrapper around the AI SDK's useChat hook
// It implements model switching and uses the custom chat transport,
// making a nice reusable hook for chat functionality.
export function useChat(
  options?: CustomChatOptions
) {
  const transportRef = useRef<CustomChatTransport | undefined>(undefined) // Using a ref here so we can update the model used in the transport without having to reload the page or recreate the transport
  const {
    sessionId,
    sessionTitle,
    systemMessage,
    onTokenUsage,
    resolveModelSelection,
    ...chatInitOptions
  } = options ?? {}
  const ensureSession = useChatSessions((state) => state.ensureSession)
  const setSessionTitle = useChatSessions((state) => state.setSessionTitle)
  const updateStatus = useChatSessions((state) => state.updateStatus)

  // Get serviceHub and model metadata from app state
  const mcpToolNames = useAppState((state) => state.mcpToolNames)
  const ragToolNames = useAppState((state) => state.ragToolNames)

  const existingSessionTransport = sessionId
    ? useChatSessions.getState().sessions[sessionId]?.transport
    : undefined

  // Create transport immediately with modelId and provider. A transport
  // belongs to one session: when this view moves to a different chat that
  // has none stored yet, reusing the old one carried its thread id and its
  // frozen MCP tool routing into the new chat.
  const transportSessionRef = useRef<string | undefined>(undefined)
  if (
    transportRef.current &&
    !existingSessionTransport &&
    transportSessionRef.current !== sessionId
  ) {
    transportRef.current = undefined
  }
  if (!transportRef.current) {
    transportRef.current =
      existingSessionTransport ?? new CustomChatTransport(systemMessage, sessionId)
    // A temporary chat neither reads nor records memory. Chats have no project
    // folder, so project memory never applies here; session and user memory do.
    transportRef.current.setMemoryBinding({
      temporary: sessionId === TEMPORARY_CHAT_ID,
    })
    transportSessionRef.current = sessionId
  } else if (
    existingSessionTransport &&
    transportRef.current !== existingSessionTransport
  ) {
    transportRef.current = existingSessionTransport
    transportSessionRef.current = sessionId
  }

  useEffect(() => {
    if (transportRef.current) {
      transportRef.current.updateSystemMessage(systemMessage)
    }
  }, [systemMessage])

  // Which project's memory this chat uses, and whether it is temporary.
  useChatMemoryBinding(sessionId, transportRef.current)

  // The transport outlives this component (it lives on the session), so the
  // resolver is withdrawn on unmount: a thread later shown on its own must go
  // back to the global picker.
  useEffect(() => {
    const transport = transportRef.current
    if (!transport || !resolveModelSelection) return
    transport.setModelSelectionResolver(resolveModelSelection)
    return () => transport.setModelSelectionResolver(undefined)
  }, [resolveModelSelection, sessionId])

  // Update the token usage callback when it changes
  useEffect(() => {
    if (transportRef.current) {
      transportRef.current.setOnTokenUsage(onTokenUsage)
    }
  }, [onTokenUsage])

  // Memoize to prevent calling ensureSession (which has side effects) on every render
  const chat = useMemo(() => {
    if (!sessionId || !transportRef.current) return undefined

    return ensureSession(
      sessionId,
      transportRef.current,
      () => new Chat({ ...chatInitOptions, transport: transportRef.current }),
      sessionTitle
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ensureSession])

  useEffect(() => {
    if (sessionId && sessionTitle) {
      setSessionTitle(sessionId, sessionTitle)
    }
  }, [sessionId, sessionTitle, setSessionTitle])

  const chatResult = useChatSDK({
    ...(chat
      ? { chat }
      : { transport: transportRef.current, ...chatInitOptions }),
    experimental_throttle: options?.experimental_throttle,
    resume: false,
  })

  useEffect(() => {
    if (sessionId) {
      updateStatus(sessionId, chatResult.status)
    }
  }, [sessionId, chatResult.status, updateStatus])

  // Refresh tools when MCP or RAG tool names change (e.g., when MCP servers start/stop)
  useEffect(() => {
    if (transportRef.current) {
      // Use forceRefreshTools to update the transport's tool cache
      // This ensures the transport has the latest tools when MCP server status changes
      transportRef.current.refreshTools()
    }
  }, [mcpToolNames, ragToolNames])

  const setContinueFromContent = useCallback(
    (content: string | ContinuationContent) => {
      transportRef.current?.setContinueFromContent(content)
    },
    []
  )

  // Expose method to update RAG tools availability
  const updateRagToolsAvailability = useCallback(
    async (
      hasDocuments: boolean,
      modelSupportsTools: boolean,
      ragFeatureAvailable: boolean
    ) => {
      if (transportRef.current) {
        await transportRef.current.updateRagToolsAvailability(
          hasDocuments,
          modelSupportsTools,
          ragFeatureAvailable
        )
      }
    },
    []
  )

  return {
    ...chatResult,
    updateRagToolsAvailability,
    setContinueFromContent,
  }
}
