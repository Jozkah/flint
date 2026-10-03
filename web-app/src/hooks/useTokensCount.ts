import { useEffect, useMemo, useRef, useState } from 'react'
import { ThreadMessage } from '@janhq/core'
import { parseContextOverflow } from '@/utils/error'
import { usableContextValue } from '@/lib/modelCapabilities'
import {
  getLocalPropsExtension,
  type LlamacppModelProps,
} from '@/lib/llamacppRouterProps'
import { fetchServerWindow } from '@/lib/serverWindow'
import { useContextBreakdown } from './useContextBreakdown'
import { useModelProvider } from './useModelProvider'
import { useAppState } from './useAppState'
import {
  finalizeTokenUsage,
  readTokenUsage,
  type TokenUsage,
} from '@/lib/tokenUsage'

export type ModelProps = LlamacppModelProps

export interface TokenCountData {
  tokenCount: number
  inputTokens?: number
  outputTokens?: number
  /**
   * The breakdown behind the counter's popover: input, the cached and
   * uncached parts of it, cache writes, output and total — each only when the
   * provider reported it.
   */
  usage?: TokenUsage
  maxTokens?: number
  percentage?: number
  isNearLimit: boolean
  loading: boolean
  modelProps?: ModelProps
  modelDisplayName?: string
  fitEnabled: boolean
  configuredCtxLen?: number
  modalities?: { vision: boolean; audio: boolean }
  error?: string
  isOverflow?: boolean
}

/** The usage a message or session carries. See `lib/tokenUsage.ts`. */
export type UsageMeta = TokenUsage

/**
 * Usage for a surface that keeps no `ThreadMessage`s.
 *
 * Cowork stores its transcript as its own turns, so there is nothing to scan
 * for `metadata.usage`. It reports the same two facts directly rather than
 * synthesising thread messages to carry them.
 */
export interface TokenUsageSource {
  threadId?: string
  usage?: UsageMeta
  /** Last failed request, when it never produced usage metadata. */
  contextError?: string
  /** Every request in this session, added up (see `summarizeUsage`). */
  session?: UsageMeta
  /**
   * Whether the model is loading for this surface's own thread.
   *
   * A surface that keeps its load state outside `useAppState` reports it here:
   * Cowork mirrors loads in `useCoworkRun` under the session id, so the
   * thread-keyed slots the hook reads on its own never see them. Without it the
   * launched context window is never refetched for a Cowork session.
   */
  loadingModel?: boolean
  /** Generation speed of the latest reply and the session's average. */
  speed?: { last?: number; average?: number }
}

// The token-usage popup normally reflects the last *successful* turn. When a
// request overflows, that turn is never recorded, so the popup would keep
// showing a comfortable percentage next to an "out of context" error. Parse
// the failing request's counts out of the stamped contextError so the popup
// reflects the request that actually overflowed.
const getActiveContextOverflow = (messages: ThreadMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ctx = (messages[i].metadata as { contextError?: unknown } | undefined)
      ?.contextError
    if (typeof ctx === 'string' && ctx.length > 0) return parseContextOverflow(ctx)
  }
  return null
}

// Read through `readTokenUsage`, so a message saved before cache accounting
// existed comes back with its cache fields absent — "not reported" — rather
// than zero.
const getLatestServerUsage = (messages: ThreadMessage[]): UsageMeta => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = readTokenUsage(
      (messages[i].metadata as { usage?: unknown } | undefined)?.usage
    )
    if (usage && typeof usage.totalTokens === 'number' && usage.totalTokens > 0)
      return usage
  }
  return {}
}

/**
 * The configured context size, or `undefined` when there is not one.
 *
 * Goes through the same gate as every other context number
 * ([`usableContextValue`]), so a stored `0` reads as "not configured" rather
 * than as a model that can hold nothing. Showing `Configured ctx_len: 0` was
 * the visible half of that bug.
 */
const readSettingNumber = (v: unknown): number | undefined =>
  usableContextValue(v) ?? undefined

export const useTokensCount = (
  messages: ThreadMessage[] = [],
  source?: TokenUsageSource
) => {
  const { selectedModel, selectedProvider, getProviderByName } =
    useModelProvider()
  const [modelProps, setModelProps] = useState<ModelProps | undefined>(
    undefined
  )
  const [loading, setLoading] = useState(false)
  const reqId = useRef(0)

  const isLocalProvider =
    selectedProvider === 'llamacpp' || selectedProvider === 'mlx'
  const modelId = isLocalProvider ? selectedModel?.id : undefined

  const threadId = source?.threadId ?? messages[0]?.thread_id
  // Populated per-chunk while a llama.cpp turn is streaming (timings_per_token);
  // cleared on stream start/finish/error, so its presence means "live now".
  const liveStats = useAppState((s) =>
    threadId ? s.liveTokenStatsByThread[threadId] : undefined
  )
  // getModelProps only succeeds once the router has autoloaded the model, which
  // normally doesn't happen until the first turn is sent. Refetch as soon as that
  // load finishes so the counter can appear mid-turn instead of waiting for the
  // full response (and the resulting messages.length bump) to land.
  //
  // Cowork mirrors its load state onto `useCoworkRun` under the session id, so
  // these thread-keyed slots never see it; such a surface reports its own mirror
  // through `source.loadingModel`.
  const appLoadingModel = useAppState((s) =>
    threadId ? s.loadingModels[threadId] : s.loadingModel
  )
  const loadingModel = source?.loadingModel || appLoadingModel

  // The window the meter divides by is the one the engine actually launched,
  // and it moves without a model switch: "Increase context" recovery, the model
  // settings form, or a re-fit. A local settings write publishes the new value
  // only after the router has reloaded with it (`updateModelSettings` awaits
  // `refreshEnginePreset`), so depending on it here refetches the launched window
  // in the same tick the UI learns of the edit. Chat also refetched on its next
  // message; Cowork has no message-length trigger at all.
  const configuredCtxLen = readSettingNumber(
    selectedModel?.settings?.ctx_len?.controller_props?.value
  )

  useEffect(() => {
    if (!modelId) {
      setModelProps(undefined)
      setLoading(false)
      return
    }
    const ext = getLocalPropsExtension(selectedProvider)
    if (!ext?.getModelProps) {
      setModelProps(undefined)
      return
    }
    const id = ++reqId.current
    setLoading(true)
    ext
      .getModelProps(modelId)
      .then((props) => {
        if (id !== reqId.current) return
        setModelProps(props)
      })
      .catch(() => {
        if (id !== reqId.current) return
        setModelProps(undefined)
      })
      .finally(() => {
        if (id !== reqId.current) return
        setLoading(false)
      })
  }, [
    modelId,
    selectedProvider,
    messages.length,
    loadingModel,
    configuredCtxLen,
  ])

  // A server of the user's own that is not a bundled engine (a llama-server on
  // another port, say) reports its window at `/props`. Learned once per chat
  // and kept with it, so the context card has a size to divide by, and an
  // old chat shows it before anything is sent.
  const learnedWindow = useContextBreakdown((s) =>
    threadId ? s.windowById[threadId] : undefined
  )
  const setLearnedWindow = useContextBreakdown((s) => s.setWindow)
  const remoteBaseUrl = isLocalProvider
    ? undefined
    : getProviderByName(selectedProvider)?.base_url
  useEffect(() => {
    if (!threadId || !remoteBaseUrl) return
    let current = true
    fetchServerWindow(remoteBaseUrl).then((tokens) => {
      if (current && tokens) setLearnedWindow(threadId, tokens)
    })
    return () => {
      current = false
    }
  }, [threadId, remoteBaseUrl, selectedModel?.id, setLearnedWindow])

  const tokenData: TokenCountData = useMemo(() => {
    const sourceOverflow = source?.contextError
      ? parseContextOverflow(source.contextError)
      : null
    if (!isLocalProvider) {
      if (!selectedModel) {
        return {
          tokenCount: 0,
          loading: false,
          isNearLimit: false,
          fitEnabled: false,
        }
      }
      const usage = source?.usage ?? getLatestServerUsage(messages)
      return {
        tokenCount: sourceOverflow?.requestTokens ?? usage.totalTokens ?? 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usage,
        // What a refused request named, else the window this chat's server was
        // last found to run with. A hosted provider has neither, and keeps no
        // window rather than a guessed one.
        maxTokens:
          usableContextValue(sourceOverflow?.contextTokens) ??
          usableContextValue(learnedWindow) ??
          undefined,
        isOverflow: sourceOverflow != null,
        loading: false,
        isNearLimit: false,
        fitEnabled: false,
        modelDisplayName: selectedModel.name || selectedModel.id,
      }
    }
    if (!modelId) {
      return {
        tokenCount: 0,
        loading: false,
        isNearLimit: false,
        fitEnabled: false,
      }
    }
    const overflow = sourceOverflow ?? getActiveContextOverflow(messages)
    const usage: UsageMeta = liveStats
      ? finalizeTokenUsage({
          inputTokens: liveStats.promptTokens,
          outputTokens: liveStats.completionTokens,
          totalTokens: liveStats.promptTokens + liveStats.completionTokens,
          cachedInputTokens: liveStats.cachedPromptTokens,
          cacheSource: 'engine-timings',
        })
      : (source?.usage ?? getLatestServerUsage(messages))
    const tokenCount = overflow?.requestTokens ?? usage.totalTokens ?? 0
    // A runtime that reports `n_ctx: 0`, or a server whose overflow error
    // carried a zero limit, has told us nothing about the window. Left as `0`
    // it renders as `0 / 0` and reads as a model with no room at all.
    const maxTokens =
      usableContextValue(overflow?.contextTokens) ??
      usableContextValue(modelProps?.nCtx) ??
      undefined
    const percentage = maxTokens ? (tokenCount / maxTokens) * 100 : undefined
    const isNearLimit = overflow != null || (percentage ? percentage > 85 : false)

    const provider = getProviderByName(selectedProvider)
    const fitEnabled =
      provider?.settings?.find((s) => s.key === 'fit')?.controller_props
        ?.value === true
    const modelDisplayName =
      modelProps?.modelAlias || selectedModel?.name || modelId
    const caps = selectedModel?.capabilities ?? []
    const modalities = {
      vision: caps.includes('vision'),
      audio: caps.includes('audio'),
    }

    return {
      tokenCount,
      inputTokens: overflow ? overflow.requestTokens : usage.inputTokens,
      outputTokens: overflow ? 0 : usage.outputTokens,
      // An overflowed request was refused before anything was generated or
      // cached, so all that is known about it is its size.
      usage: overflow
        ? finalizeTokenUsage({ inputTokens: overflow.requestTokens })
        : usage,
      maxTokens,
      percentage,
      isNearLimit,
      loading,
      modelProps,
      modelDisplayName,
      fitEnabled,
      configuredCtxLen,
      modalities,
      isOverflow: overflow != null,
    }
  }, [
    messages,
    source,
    modelId,
    selectedProvider,
    isLocalProvider,
    modelProps,
    loading,
    liveStats,
    getProviderByName,
    selectedModel,
    configuredCtxLen,
    learnedWindow,
  ])

  return {
    ...tokenData,
    calculateTokens: async () => undefined,
  }
}
