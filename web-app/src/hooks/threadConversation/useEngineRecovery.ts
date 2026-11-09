import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { toast } from 'sonner'
import type { ServiceHub } from '@/services'
import type { useChat } from '@/hooks/use-chat'
import { useAppState } from '@/hooks/useAppState'
import type { useModelProvider } from '@/hooks/useModelProvider'
import type { useTranslation } from '@/i18n/react-i18next-compat'
import {
  claimAutoRetry,
  isEngineGoneError,
  isRecoverableLocalProvider,
  planEngineRecovery,
} from '@/lib/chat/turnRecovery'
import { waitForEngineReady } from '@/lib/chat/engineReadiness'

type ChatHelpers = ReturnType<typeof useChat>

/** Resolves once no tool loop runs for the thread, or `signal` aborts. */
function toolLoopSettled(threadId: string, signal: AbortSignal): Promise<void> {
  const idle = () => !useAppState.getState().busyThreads?.[threadId]
  if (idle() || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      unsubscribe()
      signal.removeEventListener('abort', done)
      resolve()
    }
    const unsubscribe = useAppState.subscribe(() => {
      if (idle()) done()
    })
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * The one automatic retry of a local (llama.cpp) turn whose engine went
 * away: the model is loaded again, then the turn is answered again, or --
 * when its earlier steps already ran tools -- continued after them with
 * their results reused, so no tool runs twice. A toast says what happened;
 * a second failure of the same turn is shown as it is.
 */
export function useEngineRecovery({
  threadId,
  status,
  error,
  selectedProvider,
  selectedModelId,
  getProviderByName,
  serviceHub,
  chatMessagesRef,
  setChatMessages,
  sendMessage,
  handleRegenerate,
  t,
}: {
  threadId: string
  status: ChatHelpers['status']
  error: ChatHelpers['error']
  selectedProvider: string
  selectedModelId: string | undefined
  getProviderByName: ReturnType<
    typeof useModelProvider.getState
  >['getProviderByName']
  serviceHub: Pick<ServiceHub, 'models'>
  chatMessagesRef: MutableRefObject<UIMessage[]>
  setChatMessages: ChatHelpers['setMessages']
  sendMessage: ChatHelpers['sendMessage']
  handleRegenerate: (messageId?: string) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const statusRef = useRef(status)
  statusRef.current = status
  const abortRef = useRef<AbortController | null>(null)
  // 'sent': the retry was handed to the chat; 'running': it started.
  const retryPhaseRef = useRef<'sent' | 'running' | null>(null)
  const toastId = `engine-recovery-${threadId}`

  // Read through refs so the effect below runs on a new error only.
  const latest = useRef({
    selectedProvider,
    selectedModelId,
    getProviderByName,
    serviceHub,
    setChatMessages,
    sendMessage,
    handleRegenerate,
    t,
  })
  latest.current = {
    selectedProvider,
    selectedModelId,
    getProviderByName,
    serviceHub,
    setChatMessages,
    sendMessage,
    handleRegenerate,
    t,
  }

  useEffect(() => {
    if (!error) return
    const deps = latest.current
    const modelId = deps.selectedModelId
    if (!modelId || !isRecoverableLocalProvider(deps.selectedProvider)) return
    if (!isEngineGoneError(error)) return
    // A recovery under way covers this failure too (a tool follow-up sent
    // to the engine while it was still coming back).
    if (abortRef.current) return
    const plan = planEngineRecovery(chatMessagesRef.current)
    if (!plan || !claimAutoRetry(plan.turnKey)) return

    const controller = new AbortController()
    abortRef.current = controller
    toast.loading(deps.t('chat:turnRecovery.restarting'), { id: toastId })

    void (async () => {
      // Calls the failed step already received may still be running; their
      // results are what a resume reuses.
      await toolLoopSettled(threadId, controller.signal)
      const readiness = await waitForEngineReady({
        provider: deps.getProviderByName(deps.selectedProvider) as
          | ProviderObject
          | undefined,
        modelId,
        serviceHub: deps.serviceHub,
        signal: controller.signal,
      })
      if (controller.signal.aborted || abortRef.current !== controller) return
      abortRef.current = null
      const now = latest.current
      if (!readiness.ok) {
        console.warn(
          `[chat] could not load ${modelId} again for a retry: ${readiness.reason}${readiness.error ? ` (${readiness.error})` : ''}`
        )
        toast.error(now.t('chat:turnRecovery.restartFailed'), { id: toastId })
        return
      }
      // Something else answered the turn meanwhile (the user sent again, a
      // tool follow-up got through): nothing to retry.
      if (statusRef.current !== 'error') {
        toast.dismiss(toastId)
        return
      }
      // Planned again on the conversation as it is now: tool results may
      // have landed while the model was loading.
      const current = planEngineRecovery(chatMessagesRef.current)
      if (!current || current.turnKey !== plan.turnKey) {
        toast.dismiss(toastId)
        return
      }
      toast.loading(now.t('chat:turnRecovery.retrying'), { id: toastId })
      retryPhaseRef.current = 'sent'
      if (current.kind === 'resume') {
        chatMessagesRef.current = current.messages
        now.setChatMessages(current.messages)
        // No message: the chat continues its last (assistant) message.
        void now.sendMessage()
        return
      }
      now.handleRegenerate(current.failedMessageId)
    })()
  }, [error]) // eslint-disable-line react-hooks/exhaustive-deps

  // How the retried turn ended.
  useEffect(() => {
    const phase = retryPhaseRef.current
    if (!phase) return
    if (status === 'submitted' || status === 'streaming') {
      retryPhaseRef.current = 'running'
      return
    }
    if (phase !== 'running') return
    retryPhaseRef.current = null
    if (status === 'ready') {
      toast.success(latest.current.t('chat:turnRecovery.recovered'), {
        id: toastId,
      })
    } else if (status === 'error') {
      toast.error(latest.current.t('chat:turnRecovery.retryFailed'), {
        id: toastId,
      })
    }
  }, [status, toastId])

  // A recovery belongs to the thread it started on.
  useEffect(
    () => () => {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
        toast.dismiss(toastId)
      }
      retryPhaseRef.current = null
    },
    [threadId, toastId]
  )
}
