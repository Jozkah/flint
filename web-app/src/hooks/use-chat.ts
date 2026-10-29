import {
  CustomChatTransport,
  type ContinuationContent,
} from '@/lib/custom-chat-transport'
import { RoutedChatTransport } from '@/lib/routed-chat-transport'
import {
  Chat,
  type UIMessage,
  type UseChatOptions,
  useChat as useChatSDK,
} from '@ai-sdk/react'
import { type ChatInit } from 'ai'
import { settleStoppedToolCalls } from '@/lib/stopped-tool-calls'
import { useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react'
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

/**
 * The callbacks a session's Chat is built with. Each one resolves the view's
 * latest handler when it is called (see `ChatCallbacks`), so a Chat that
 * outlives the component that made it never runs that component's stale
 * closures. A stopped turn is settled first: its unfinished tool calls become
 * errors before the handler stores the message.
 */
function sessionCallbacks(sessionId: string): ChatInit<UIMessage> {
  const latest = () => useChatSessions.getState().sessions[sessionId]?.callbacks
  return {
    onFinish: (event) => {
      const settled = event.isAbort
        ? settleStoppedToolCalls(event.messages, event.message.id)
        : event.messages
      let next = event
      if (settled !== event.messages) {
        next = {
          ...event,
          messages: settled,
          message:
            settled.find((m) => m.id === event.message.id) ?? event.message,
        }
        // The live copy too, so the card stops saying "Running" at once.
        const session = useChatSessions.getState().sessions[sessionId]
        if (session) session.chat.messages = settled
      }
      return latest()?.onFinish?.(next)
    },
    onToolCall: (event) => latest()?.onToolCall?.(event),
    onError: (error) => latest()?.onError?.(error),
    onData: (part) => latest()?.onData?.(part),
  }
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
    // Resolved from the session at each call, never frozen into the Chat.
    onFinish,
    onToolCall,
    onError,
    onData,
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
      existingSessionTransport ?? new RoutedChatTransport(systemMessage, sessionId)
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
      () =>
        new Chat({
          ...chatInitOptions,
          ...sessionCallbacks(sessionId),
          transport: transportRef.current,
        }),
      sessionTitle
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ensureSession])

  // The Chat was built for the first view of this session; a later view (the
  // page remounted, a handler's closure changed) has newer callbacks. Record
  // them on the session so the Chat's next event calls these, not the old ones.
  // In a layout effect, not the render body: a discarded concurrent render
  // must not leave its closures on the session.
  useLayoutEffect(() => {
    if (sessionId) {
      useChatSessions
        .getState()
        .setSessionCallbacks(sessionId, { onFinish, onToolCall, onError, onData })
    }
  })

  useEffect(() => {
    if (sessionId && sessionTitle) {
      setSessionTitle(sessionId, sessionTitle)
    }
  }, [sessionId, sessionTitle, setSessionTitle])

  const chatResult = useChatSDK({
    ...(chat
      ? { chat }
      : {
          transport: transportRef.current,
          ...chatInitOptions,
          onFinish,
          onToolCall,
          onError,
          onData,
        }),
    experimental_throttle: options?.experimental_throttle,
    resume: false,
  })

  // Stop aborts the stream, but a tool call that was still being written or
  // waiting to run is never answered, so its card would read "Running" for the
  // rest of the conversation. Settle it as stopped once the abort is in.
  const { stop: stopChat, setMessages: setChatMessages } = chatResult
  const stop = useCallback(async () => {
    await stopChat()
    setChatMessages((messages) => settleStoppedToolCalls(messages))
  }, [stopChat, setChatMessages])

  // While a turn is live, publish a per-thread controller whose abort runs the
  // same stop as the Stop button, so other surfaces (temporary-chat discard,
  // llama.cpp router errors, exit dialog) can end it without polling.
  const live =
    chatResult.status === 'submitted' || chatResult.status === 'streaming'
  useEffect(() => {
    if (!sessionId || !live) return
    const controller = new AbortController()
    controller.signal.addEventListener('abort', () => void stop(), {
      once: true,
    })
    useAppState.getState?.()?.setAbortController?.(sessionId, controller)
    return () =>
      useAppState.getState?.()?.clearAbortController?.(sessionId, controller)
  }, [sessionId, live, stop])

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

  // Manual compaction of this conversation (`/compact`, the banner's button).
  const compactNow = useCallback(
    async (messages: UIMessage[], focus?: string) =>
      sessionId && transportRef.current
        ? transportRef.current.compactNow(sessionId, messages, undefined, focus)
        : null,
    [sessionId]
  )

  // `/btw`: a tool-less answer from a snapshot, never added to the thread.
  const sideQuestion = useCallback(
    async (messages: UIMessage[], question: string) =>
      sessionId && transportRef.current
        ? transportRef.current.sideQuestion(sessionId, messages, question)
        : null,
    [sessionId]
  )

  return {
    ...chatResult,
    sideQuestion,
    stop,
    updateRagToolsAvailability,
    setContinueFromContent,
    compactNow,
  }
}