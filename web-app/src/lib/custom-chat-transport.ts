import { hasAgentToolImages } from '@/lib/toolOutputImages'
import {
  hasToolImageSentinel,
  stripToolImageSentinels,
} from '@/lib/tool-image-sentinel'
import { pluginInventoryLine } from '@/lib/pluginInventory'
import { skillCatalogBlock } from '@/lib/skillCatalog'
import {
  encodeAudioAttachments,
  encodeVideoAttachments,
  mapUserInlineAttachments,
} from '@/lib/chat/transport/attachmentEncoding'
import {
  SHELL_ROUTING_GUIDANCE,
  SHELL_ROUTING_GUIDANCE_NO_BASH,
  buildAgentToolsSystemInstruction,
  buildColorOutputInstruction,
  buildFilesSystemInstruction,
  buildWebSearchSystemInstruction,
} from '@/lib/chat/transport/promptBuilder'

export { SHELL_ROUTING_GUIDANCE, SHELL_ROUTING_GUIDANCE_NO_BASH }
import { buildContextBreakdown } from '@/lib/contextBreakdown'
import { currentDescriber, describeImagesInMessages } from '@/lib/imageDescription'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
import {
  rememberedWindowFor,
  resolveCompactionWindow,
} from '@/lib/compactionWindowSource'
import { listedWindow } from '@/lib/listedWindows'
import { assertEstimatedContextFits, cappedContextWindow, ContextEstimate } from '@/lib/contextEstimate'
import {
  appendSessionContext,
  runCcContextHooks,
  userMessageText,
  withPromptContext,
} from '@/lib/ccContextHooks'
import { fetchServerWindow, serverWindowHeaders } from '@/lib/serverWindow'
import { fetchOllamaWindow, isOllamaProvider, shouldNoticeOllamaTruncation } from '@/lib/ollamaWindow'
import { knownContextWindowDetail } from '@/lib/knownContextWindow'
import { useUsageStats } from '@/stores/usage-stats-store'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import {
  fallbackRef,
  resolveFallbackChain,
  shouldFallback,
} from '@/lib/fallbackChain'
import { i18n } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'
import { replyCost, resolvePricing } from '@/lib/modelPricing'
import { type UIMessage } from '@ai-sdk/react'
import type { JSONObject } from '@ai-sdk/provider'
import { convertToModelMessages, streamText, type ChatRequestOptions, type ChatTransport, type LanguageModel, type UIMessageChunk, type Tool, type LanguageModelUsage, InvalidToolInputError } from 'ai'
import { repairToolArgs } from './toolCallRepair'
import { streamCutOff } from './streamFinish'
import {
  createIdleWatchdog,
  STREAM_IDLE_TIMEOUT_MS,
  streamIdleMessage,
} from './streamIdle'
import { ReasoningLoopGuard } from './reasoningLoopGuard'
import { recordMemoryUses } from './memoryUses'
import { getServiceHub, useServiceStore } from '@/hooks/useServiceHub'
import { DISPATCH_PARAM_KEY, ModelFactory } from './model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { SHELL_TOOL_NAME } from '@/lib/agentTools'
import { useChatShell } from '@/hooks/useChatShell'
import { routeRefusedToolCalls } from '@/lib/disabledToolCalls'
import { subagentGuide } from '@/lib/coworkPrompt'
import { truncateStaleWidgetCode } from '@/lib/visualize/history'
import { errorText } from '@/lib/errorText'
import {
  memoryRetrieve,
  type MemoryInstruction,
} from '@janhq/tauri-plugin-agent-tools-api'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import {
  chatMemoryBinding,
  memoryLocation,
  type MemoryBinding,
  type ScopedMemoryRetrieved,
} from '@/lib/memoryBinding'
import {
  assembleAttribution,
  attributionMetadata,
  bindUsageAtFinish,
  newRequestId,
  requestAttributions,
  type RequestAttribution,
} from '@/lib/requestAttribution'
import { recordPayloadUsage } from '@/lib/payloadUsage'
import { useAppState } from '@/hooks/useAppState'
import {
  cancelModelLoad,
  unloadLlamaModel,
  getLoadedModels,
} from '@janhq/tauri-plugin-llamacpp-api'
import { engineFailure } from '@/lib/engineError'
import { chatSafetyGuidelines, todayLine } from '@/lib/promptSafety'
import { replyLanguageLine } from '@/lib/replyLanguage'
import { getLlamacppExtension } from '@/lib/llamacppRouterProps'
import { clampThinkingBudget } from '@/lib/thinkingBudget'
import {
  buildLlamacppReasoningParams,
  resolveThinkingBudgetTokens,
} from '@/lib/llamacppReasoning'
// Moved to llamacppReasoning so Rooms can share it; still exported from here.
export { buildLlamacppReasoningParams }
import {
  buildReasoningProviderOptions,
  buildVerbosityProviderOptions,
  mergeProviderOptions,
} from '@/lib/reasoningProviderOptions'
import { resolveModel } from '@/lib/modelOverrides'
import { withReasoningDefault } from '@/lib/reasoningDefault'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { threadToolsGranted } from '@/hooks/useThreadToolGrants'
import { type MCPTool } from '@janhq/core'
import {
  trimMessages,
  estimateTokens,
  estimateToolTokens,
  estimateToolSchemaTokens,
  contextSafetyMargin,
  type ContextManagerConfig,
} from './context-manager'
import { estimateHistoryTokens, resolveAutoCompact, ASSUMED_WINDOW_TOKENS, DEFAULT_KEEP_RECENT, DEFAULT_COMPACT_THRESHOLD, type CompactionRecord } from '@/lib/compaction'
import {
  resetCompactionBreaker,
} from '@/lib/compactionGuard'
import {
  acceptsSystemRole,
  foldSummaryIntoSystem,
} from '@/lib/compactionSystemRole'
import { askSideQuestion } from '@/lib/sideQuestion'
import {
  applyChatCompaction,
  readChatCompaction,
  writeChatCompaction,
} from '@/lib/chatCompaction'
import { recordLifecycle } from '@/lib/toolActivity'
import {
  compactAtThreshold,
  runCompaction,
  type CompactAtThresholdOptions,
  type CompactionHost,
  type RunCompactionOptions,
} from '@/lib/chat/transport/compaction'
import { getCompactionPolicy, replyReserve, DEFAULT_COMPACTION_POLICY, compactThresholdFor } from '@/lib/compactionPolicy'
import { toolsForConversation, toolsForWindow } from '@/lib/leanTools'
import {
  SMALL_CONTEXT_MEMORY_CHARS,
  smallContextActive,
} from '@/lib/smallContext'
import { useLeanToolsConfig } from '@/hooks/useLeanToolsConfig'
import { chatAwaitsTools, chatRunOf, chatSnapshotId, continueOrBeginChatRun, endChatRun, markChatAwaitingTools, nextChatInvocation, recordChatMessage, recordChatUsage } from '@/lib/chatRun'
import { usageEventPayload } from '@/lib/executionTimeline'
import { hasAudioSentinel } from '@/lib/audio-sentinel'
import { prepareToolResultImagesForModel } from '@/lib/toolResultImages'
import {
  imageLimitFor,
  imageLimitKey,
  limitImageParts,
  parseImageLimit,
  rememberImageLimit,
} from '@/lib/imageLimit'
import { withEarlyRetry } from '@/lib/earlyRetryStream'
import {
  attachToolScreenshots,
  SCREENSHOT_TOKEN_ESTIMATE,
  screenshotsToAttach,
} from '@/lib/toolScreenshots'
import { transcodeWebpImages } from '@/lib/imageTranscode'
import { hasVideoSentinel } from '@/lib/video-sentinel'
import { CHAT_SLOT_ID } from '@/constants/models'
import { usableContextValue } from '@/lib/modelCapabilities'
import { mergeRequestParams } from '@/lib/chat/transport/requestParams'
import { recordGeneration } from '@/stores/engine-activity-store'
import { sendMessagesCore } from '@/lib/chat/transport/overflowRecovery'
import { isValidToolName, normalizeToolInputSchema } from '@/lib/chat/transport/toolSchema'
import { BUILTIN_WEB_TOOLS, recordMcpSet, refreshTools, type ToolRefreshHost } from '@/lib/chat/transport/toolRefresh'
export { isValidToolName, normalizeToolInputSchema }

// Built-ins advertised through the websearch plugin.
/** Flint's own chat tools that only read or render: none can change anything. */
const READ_ONLY_CHAT_TOOLS = new Set([
  ...BUILTIN_WEB_TOOLS,
  'list_plugins',
  'visualize_read_me',
  'show_widget',
  'chat_read',
])
import {
  createUsageCollector,
  readTokenUsage,
  type TokenUsage,
} from '@/lib/tokenUsage'
import { createDecodeClock, generationSpeed } from '@/lib/tokenSpeed'
import { addToReplySpeed, earlierTokenSpeed } from '@/lib/replyTokenSpeed'
import { earlierCreatedAt } from '@/lib/messageTime'
import { createReasoningClock } from '@/lib/reasoningClock'

export type TokenUsageCallback = (
  usage: TokenUsage,
  messageId: string
) => void
export type StreamingTokenSpeedCallback = (
  tokenCount: number,
  elapsedMs: number
) => void
export type OnFinishCallback = (params: {
  message: UIMessage
  isAbort?: boolean
}) => void
/** Partial assistant output replayed as a prefill to resume a stopped turn. */
export type ContinuationContent = { text?: string; reasoning?: string }
export type ServiceHub = {
  /**
   * A partially-stubbed host can hand back no app service at all, which is
   * why the return type admits `undefined` rather than the caller
   * optional-calling the method itself.
   */
  app(): { getJanDataFolder(): Promise<string | undefined> } | undefined
  rag(): {
    getTools(): Promise<
      Array<{ name: string; description: string; inputSchema: unknown }>
    >
  }
  mcp(): {
    /** `start`: start enabled servers that are not running (on demand). */
    getTools(options?: { start?: boolean }): Promise<MCPTool[]>
    /** TauriMCPService only */
    getToolsForServers?(
      serverNames: string[],
      options?: { start?: boolean }
    ): Promise<MCPTool[]>
    /** TauriMCPService only */
    getServerSummaries?(): Promise<
      Array<{ name: string; capabilities: string[]; description: string }>
    >
  }
}

// Per-model sidebar keys forwarded into each chat-completion request body as
// defaults. These *are* also written into the model's own preset section, so
// this is not the only path -- it exists so a sidebar change applies without
// regenerating the preset and reloading the engine. Assistant `parameters`
// override these in the merge.
const MODEL_SAMPLING_SETTING_KEYS = [
  'temperature',
  'top_k',
  'top_p',
  'min_p',
  'repeat_last_n',
  'repeat_penalty',
  'presence_penalty',
  'frequency_penalty',
  'seed',
] as const

/** Keys whose upstream handler throws on a negative value. */
const NON_NEGATIVE_SAMPLING_KEYS = new Set<string>([
  // A negative seed is "random", the same as not sending one.
  'seed',
  'repeat_last_n',
  'dry_penalty_last_n',
])

/**
 * llama.cpp's own defaults for the sampling keys that set the
 * suppress-the-GGUF-recommendation bit. Keys absent here set no bit and are
 * always forwarded.
 */
const UPSTREAM_SAMPLING_DEFAULTS: Record<string, number> = {
  temperature: 0.8,
  top_k: 40,
  top_p: 0.95,
  min_p: 0.05,
  repeat_last_n: 64,
  repeat_penalty: 1.0,
}

export function extractModelSamplingDefaults(
  model: Model | null | undefined
): Record<string, unknown> {
  if (!model?.settings) return {}
  const out: Record<string, unknown> = {}
  for (const key of MODEL_SAMPLING_SETTING_KEYS) {
    const raw = model.settings[key]?.controller_props?.value
    if (raw === undefined || raw === null || raw === '') continue
    // Sidebar inputs are string-typed even when controller_props.type is
    // 'number'; coerce so the request body matches the OpenAI schema.
    let value: unknown = raw
    if (typeof raw === 'string') {
      const n = Number(raw)
      if (!Number.isFinite(n)) continue
      value = n
    }
    // The server rejects a negative window outright rather than clamping, so a
    // value left over from the old "-1 = full context" UI would 400 every
    // request. Dropping it lets the server's own default apply.
    if (
      NON_NEGATIVE_SAMPLING_KEYS.has(key) &&
      typeof value === 'number' &&
      value < 0
    ) {
      continue
    }
    // Forwarding a value equal to llama.cpp's default is not a no-op: it sets a
    // bit that suppresses the GGUF's own recommended sampling, so an
    // untouched-looking default would silently override what the model asked
    // for. Same rule preset.ts applies.
    if (UPSTREAM_SAMPLING_DEFAULTS[key] === value) continue
    out[key] = value
  }
  // Per-model stop strings (one per line) ride the same request-body path; the
  // model factory turns the text into the wire array. An assistant's own
  // `stop` replaces them (see the merge in the transport).
  const stop = model.settings.stop_strings?.controller_props?.value
  if (typeof stop === 'string' && stop.trim().length > 0) out.stop = stop
  return out
}

/**
 * Per-model chat-template kwargs the user set in the model settings sidebar,
 * stored as an object under `settings.chat_template_kwargs`. Only primitive
 * values are forwarded; `enable_thinking` is owned by the reasoning control
 * and is dropped here.
 */
function extractModelTemplateKwargs(
  model: Model | null | undefined
): Record<string, boolean | number | string> {
  const raw: unknown =
    model?.settings?.chat_template_kwargs?.controller_props?.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, boolean | number | string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'enable_thinking') continue
    const t = typeof value
    if (t === 'boolean' || t === 'number' || t === 'string') {
      out[key] = value as boolean | number | string
    }
  }
  return out
}

/**
 * Whether llama.cpp shifts this model's context when it fills. The model's own
 * setting (`on` / `off`; `auto` or absent means "use global") wins over the
 * engine-wide Context Shift checkbox.
 */
export function resolveContextShift(
  modelSetting: unknown,
  globalSetting: unknown
): boolean {
  if (modelSetting === 'on' || modelSetting === true) return true
  if (modelSetting === 'off' || modelSetting === false) return false
  return globalSetting === true
}

export function effectiveContextWindow(
  configuredContextTokens: number,
  liveContextTokens: number | undefined,
  contextShiftEnabled: boolean
): number {
  const configured = usableContextValue(configuredContextTokens)
  const live = contextShiftEnabled ? usableContextValue(liveContextTokens) : null
  // A runtime window constrains the user's cap; it never enlarges it.
  return cappedContextWindow(configured, live) ?? 0
}


/**
 * Returns true when an assistant message carries no content the model would
 * actually render: no text, no tool call, no file, no reasoning. These appear
 * when a generation fails before any chunk arrives — the AI SDK leaves a bare
 * placeholder in the message list with empty parts.
 */
function isAssistantMessageEmpty(message: UIMessage): boolean {
  if (message.role !== 'assistant') return false
  const parts = Array.isArray(message.parts) ? message.parts : []
  if (parts.length === 0) return true
  return parts.every((part) => {
    const type = (part as { type?: string }).type
    if (type === 'text' || type === 'reasoning') {
      const text = (part as { text?: string }).text
      return typeof text !== 'string' || text.trim().length === 0
    }
    return false
  })
}

/**
 * Parts of an unanswered user turn to keep when a newer user turn replaces it:
 * its attachments, but not its question. The UI still shows those attachments
 * in the earlier bubble, so a follow-up like "what is in it?" must still reach
 * the model with them. By this point images are `file` parts, audio and video
 * are sentinel-only text parts, and documents are an [ATTACHED_FILES] block
 * (plus any inlined contents) appended after the question text.
 */
function carryAttachmentsForward(
  dropped: UIMessage['parts'],
  kept: UIMessage['parts']
): UIMessage['parts'] {
  const attachments: UIMessage['parts'] = []
  for (const part of Array.isArray(dropped) ? dropped : []) {
    if (part.type === 'file') {
      attachments.push(part)
    } else if (part.type === 'text' && typeof part.text === 'string') {
      if (hasAudioSentinel(part.text) || hasVideoSentinel(part.text)) {
        attachments.push(part)
        continue
      }
      const filesAt = part.text.indexOf('[ATTACHED_FILES]')
      if (filesAt !== -1) {
        attachments.push({ ...part, text: part.text.slice(filesAt) })
      }
    }
  }
  return [...attachments, ...(Array.isArray(kept) ? kept : [])]
}

/**
 * Enforce strict user/assistant alternation on the message history before it
 * goes to the model.
 *
 * Most chat templates (Gemma, Mistral, Llama 3, Anthropic Claude API,
 * tool-calling Qwen variants, etc.) reject two consecutive turns with the
 * same role — either via a Jinja `raise_exception` or a 400 from the
 * provider. When a generation fails mid-stream the AI SDK still keeps the
 * user message in its state but never appends an assistant reply, so the
 * next send produces `[user, user]` and the next request 500s on the
 * server side. We fix that here by:
 *
 * 1. Dropping assistant placeholders with no content (failed turns).
 * 2. Keeping only the last of any adjacent user messages. The earlier ones
 *    were never answered; merging their text would resend a failed question
 *    inside the next one while the UI shows them as separate bubbles. Their
 *    attachments are carried forward (see carryAttachmentsForward).
 *
 * Adjacent assistant messages are intentionally left alone: the Anthropic
 * serial-tool-use wave-split in `sendMessages` deliberately produces them.
 */
/**
 * Drop image parts (and AI-SDK `image` parts) from the history when the
 * active model lacks the `vision` capability. Without this, switching from
 * a vision-capable model to a text-only model mid-thread sends `file` parts
 * the new model can't interpret — most OpenAI-compatible providers 400 on
 * unsupported content types, and llama-server with a non-vision template
 * either errors or silently strips the content (depending on template).
 *
 * Audio sentinels (planted by `encodeAudioAttachments`) are not file parts
 * at this point yet — they're still `file` parts with `audio/*` mediaType —
 * so this only matches `image/*`. Files inlined via `mapUserInlineAttachments`
 * are already text and not affected.
 */
/**
 * Pull llama-server's structured context-overflow fields out of an
 * APICallError. The AI SDK's OpenAI-compatible provider zod-parses the
 * error body and strips unknown keys from `error.data`, but the raw text
 * survives on `error.responseBody`. Parse that to recover the original
 * `n_prompt_tokens` / `n_ctx` siblings so the UI can render an actionable
 * "Used X of Y context tokens" line instead of just the keyword-based
 * banner.
 *
 * Returns null unless both fields are present and numeric.
 */
export function extractContextInfoFromError(
  error: unknown
): { nPromptTokens: number; nCtx: number } | null {
  if (!error || typeof error !== 'object') return null
  const responseBody = (error as { responseBody?: unknown }).responseBody
  if (typeof responseBody !== 'string' || responseBody.length === 0) return null
  try {
    const parsed = JSON.parse(responseBody) as {
      error?: { n_prompt_tokens?: unknown; n_ctx?: unknown }
    }
    const inner = parsed?.error
    if (!inner || typeof inner !== 'object') return null
    const nPromptTokens = (inner as Record<string, unknown>).n_prompt_tokens
    const nCtx = (inner as Record<string, unknown>).n_ctx
    if (typeof nPromptTokens !== 'number' || typeof nCtx !== 'number') return null
    return { nPromptTokens, nCtx }
  } catch {
    return null
  }
}

export function unwrapRetryError(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error
  const errors = (error as { errors?: unknown }).errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors[errors.length - 1] ?? error
  }
  return error
}

const RETRY_PREFIX_RE = /^Failed after \d+ attempts\. Last error: /
const RETRY_NONRETRYABLE_RE = /^Failed after \d+ attempts with non-retryable error: '(.+)'$/s

export function stripRetryErrorWrapper(message: string): string {
  if (typeof message !== 'string') return message
  const m = message.match(RETRY_NONRETRYABLE_RE)
  if (m) return m[1]
  return message.replace(RETRY_PREFIX_RE, '')
}

/** Only the newest `limit` images, when the server told us how many it takes. */
const limitIfNeeded = (messages: UIMessage[], limit: number | undefined) =>
  limit != null && limit > 0 ? limitImageParts(messages, limit) : messages

/** Providers that run a model on this machine, with a small context. */
const LOCAL_ENGINE_PROVIDERS = new Set(['llamacpp', 'mlx'])

export function stripUnsupportedImageParts(
  messages: UIMessage[],
  modelSupportsVision: boolean
): UIMessage[] {
  if (modelSupportsVision) return messages
  return messages.map((message) => {
    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      return message
    }
    let touched = false
    const nextParts = message.parts.filter((part) => {
      const type = (part as { type?: string }).type
      if (type === 'image') {
        touched = true
        return false
      }
      if (type === 'file') {
        const mediaType = (part as { mediaType?: string }).mediaType
        if (typeof mediaType === 'string' && mediaType.startsWith('image/')) {
          touched = true
          return false
        }
      }
      return true
    }).map((part) => {
      // A tool image sentinel would decode into an image_url part on the tool
      // message; a text-only model rejects that.
      const output = (part as { output?: unknown }).output
      if (typeof output !== 'string' || !hasToolImageSentinel(output)) {
        return part
      }
      touched = true
      return {
        ...part,
        output: stripToolImageSentinels(output, TOOL_IMAGE_OMITTED),
      } as typeof part
    })
    if (!touched) return message
    return { ...message, parts: nextParts } as UIMessage
  })
}

const TOOL_IMAGE_OMITTED = ' (image omitted: the model has no vision)'

const RESOLVED_TOOL_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
])

/**
 * Mark unresolved tool-call parts on assistant messages as errored so the
 * history sent to the next model still satisfies the "every tool call has a
 * matching tool result" invariant most chat templates enforce.
 *
 * Triggered by: a tool-call sequence is interrupted mid-flight (parse error,
 * abort, network drop). The AI SDK leaves the assistant message with a
 * tool-* part whose `state` is `input-streaming` / `input-available` — no
 * result was ever appended. Sending that history back to a strict template
 * (Gemma, Mistral, alternation-checking Qwen variants) trips a Jinja
 * `raise_exception` on the next turn.
 *
 * We synthesise an `output-error` so the orphan reads as a failed tool call
 * with a brief explanation, preserving the user's intent and the assistant's
 * reasoning instead of dropping the whole turn.
 */
export function resolveOrphanToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message
    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) return message

    // A tool call with no usable name (a stream that never sent one, an
    // imported message) is replayed as `function.name: undefined`, and the
    // provider rejects the whole request ("Expected 'function.name' to be a
    // string"). There is nothing to replay: drop it.
    const named = parts.filter((original) => {
      const type = (original as { type?: string }).type
      if (type === 'dynamic-tool') {
        const name = (original as { toolName?: unknown }).toolName
        return typeof name === 'string' && name.trim() !== '' && name !== 'undefined'
      }
      if (typeof type === 'string' && type.startsWith('tool-')) {
        const name = type.slice('tool-'.length)
        return name.trim() !== '' && name !== 'undefined' && name !== 'null'
      }
      return true
    })
    let mutated = named.length !== parts.length
    const nextParts = named.map((original) => {
      const type = (original as { type?: string }).type
      if (typeof type !== 'string' || !type.startsWith('tool-')) return original
      let part = original
      // A call whose arguments were not JSON keeps its raw text as `input`,
      // and a thread saved that way reloads it the same (messages.ts keeps
      // the unparsed string). Replayed, that is a tool call whose input is
      // not an object, which a chat template cannot render -- every later
      // request in the conversation failed. The call itself stays in the
      // history; only its unusable input is replaced.
      const input = (part as { input?: unknown }).input
      if (
        input !== undefined &&
        (input === null || typeof input !== 'object' || Array.isArray(input))
      ) {
        mutated = true
        part = { ...(part as object), input: {} } as typeof part
      }
      const state = (part as { state?: string }).state
      if (typeof state === 'string' && RESOLVED_TOOL_STATES.has(state)) {
        return part
      }
      mutated = true
      return {
        ...(part as object),
        state: 'output-error',
        errorText:
          (part as { errorText?: string }).errorText ??
          'Tool call did not complete (interrupted by an earlier error).',
      } as typeof part
    })

    if (!mutated) return message
    return { ...message, parts: nextParts }
  })
}

/**
 * Split any assistant message whose parts place non-tool content (text,
 * reasoning, file) AFTER tool-call parts into consecutive assistant messages,
 * one per "wave". This is required for two reasons:
 *
 * 1. Correctness: the Claude API rejects an assistant turn that interleaves
 *    tool_use with text (error 400); it needs tool_use / tool_result pairing.
 * 2. Prompt-cache stability: when a tool-call turn completes, the AI SDK stores
 *    the follow-up text in the SAME assistant UIMessage as the tool call, so
 *    `convertToModelMessages` renders `assistant(tool-call, text)` then
 *    `tool(result)`. But that turn was generated in two requests — the cache
 *    was seeded with `assistant(tool-call)` then `tool(result)`, with no text
 *    yet. Splitting restores the generated order `assistant(tool-call)` ->
 *    `tool(result)` -> `assistant(text)`, so the prefix stays byte-identical
 *    across turns and llama.cpp reuses the KV cache.
 *
 * A message with no tool parts, or with all non-tool parts before the tool
 * parts, is returned unchanged.
 */
export function splitAssistantToolWaves(messages: UIMessage[]): UIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message]

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) return [message]

    const isToolPart = (p: (typeof parts)[number]) =>
      typeof p.type === 'string' && p.type.startsWith('tool-')

    const waves: (typeof parts)[] = []
    let currentWave: typeof parts = []
    let seenToolParts = false

    for (const part of parts) {
      if (isToolPart(part)) {
        seenToolParts = true
        currentWave.push(part)
      } else if (seenToolParts) {
        waves.push(currentWave)
        currentWave = [part]
        seenToolParts = false
      } else {
        currentWave.push(part)
      }
    }
    if (currentWave.length > 0) waves.push(currentWave)

    if (waves.length <= 1) return [message]

    return waves.map((waveParts, i) => ({
      ...message,
      id: `${message.id}_w${i}`,
      parts: waveParts,
    }))
  })
}

export function coalesceMessagesForAlternation(
  messages: UIMessage[]
): UIMessage[] {
  const filtered = messages.filter((m) => !isAssistantMessageEmpty(m))
  if (filtered.length <= 1) return filtered

  const out: UIMessage[] = [filtered[0]]
  for (let i = 1; i < filtered.length; i++) {
    const prev = out[out.length - 1]
    const cur = filtered[i]
    if (prev.role === 'user' && cur.role === 'user') {
      // The summary a continued chat opens with is a user turn the model must
      // still read: keep it ahead of the next question instead of replacing it.
      const seed = (prev.metadata as Record<string, unknown> | undefined)
        ?.continuedFrom
      out[out.length - 1] = {
        ...cur,
        parts: seed
          ? [...(prev.parts ?? []), ...(cur.parts ?? [])]
          : carryAttachmentsForward(prev.parts, cur.parts),
      }
    } else {
      out.push(cur)
    }
  }
  return out
}

const LOCAL_CHAT_ENGINES: Record<string, true> = {
  llamacpp: true,
  mlx: true,
}

const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  // What some local servers print as their listen address.
  '0.0.0.0': true,
  // URL.hostname keeps the brackets on IPv6 literals.
  '[::1]': true,
}

/**
 * Jan's own engines and any server on this machine (Ollama, LM Studio, a
 * local llama-server). Their 5xx is deterministic and a retry re-runs the
 * whole prompt, so such requests are not retried.
 */
export function isLocalChatServer(
  providerId: string,
  baseUrl: string | undefined
): boolean {
  if (LOCAL_CHAT_ENGINES[providerId]) return true
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname
    // URL has already normalised IPv4, so 127.0.0.0/8 is a prefix match.
    return !!LOOPBACK_HOSTS[host] || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

const TOOL_RESPONSE_ONLY = /^<tool_response>[\s\S]*<\/tool_response>$/

/**
 * A "genuine" user query is a user-role message with non-empty text that isn't
 * entirely a <tool_response> wrapper. Qwen3.5+ chat templates raise
 * "No user query found in messages" when none survives — e.g. the user deletes
 * the only real user turn (leaving orphaned assistant/tool turns) or token
 * eviction drops it. Guard the send so we fail with a clear message instead.
 */
export function hasGenuineUserQuery(messages: UIMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== 'user') return false
    const text = (m.parts ?? [])
      .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
      .join('')
      .trim()
    return text.length > 0 && !TOOL_RESPONSE_ONLY.test(text)
  })
}

/** Text from the most recent user message (for MCP server routing). */
function extractLatestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const parts = Array.isArray(m.parts) ? m.parts : []
    const chunks: string[] = []
    for (const p of parts) {
      if (p.type === 'text' && typeof (p as { text?: string }).text === 'string') {
        const t = (p as { text: string }).text.trim()
        if (t) chunks.push(t)
      }
    }
    if (chunks.length > 0) return chunks.join('\n')
  }
  return ''
}

/**
 * Wraps a UIMessageChunk stream so the partial content of a resumed turn is
 * injected back into the new message right away: `reasoning` into the first
 * `reasoning-start` block and `text` into the first `text-start` block. This
 * makes the continuation look seamless instead of dropping the partial output.
 */
function prependContinuationToUIStream(
  stream: ReadableStream<UIMessageChunk>,
  prefix: ContinuationContent
): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader()
  let reasoningEmitted = !prefix.reasoning
  let textEmitted = !prefix.text
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
        const type = (value as { type: string }).type
        if (!reasoningEmitted && type === 'reasoning-start') {
          reasoningEmitted = true
          const id = (value as { id: string }).id
          controller.enqueue({
            type: 'reasoning-delta',
            id,
            delta: prefix.reasoning,
          } as UIMessageChunk)
        }
        if (!textEmitted && type === 'text-start') {
          textEmitted = true
          const id = (value as { id: string }).id
          controller.enqueue({
            type: 'text-delta',
            id,
            delta: prefix.text,
          } as UIMessageChunk)
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      reader.cancel()
    },
  })
}

/**
 * How long a thread stays on the model its fallback chain moved it to. The
 * chosen model failed to answer, so the tool follow-ups of the same turn chain
 * start from the model that did instead of retrying the dead one (each retry
 * costs its own backoff) -- and the user's next message probes it again.
 */
export const PRIMARY_DOWN_MS = 60_000
const primaryDown = new Map<
  string,
  { selection: string; until: number; index: number }
>()
/** Forget every thread's moved-off model. For tests. */
export function resetPrimaryDown(): void {
  primaryDown.clear()
}

type SendOptions = {
  chatId: string
  messages: UIMessage[]
  abortSignal: AbortSignal | undefined
} & {
  trigger: 'submit-message' | 'regenerate-message'
  messageId: string | undefined
} & ChatRequestOptions

/**
 * Cancels a load that was aborted. The engine cannot abort a load in place,
 * so the plugin stops its worker when this model is the only one resident, and
 * otherwise abandons the wait and unloads the model once it is up. When no
 * load was in flight (it finished first), the model is unloaded as before.
 * Best-effort: nothing here may throw into the abort path.
 */
function abandonModelLoad(modelId: string): void {
  const active = useAppState.getState().activeModels
  const keepWorker =
    Array.isArray(active) && active.some((id) => id !== modelId)
  void (async () => {
    try {
      const result = await cancelModelLoad(modelId, keepWorker)
      if (result?.cancelled) return
    } catch {
      // Fall back to a plain unload.
    }
    await unloadLlamaModel(modelId).catch(() => {})
  })()
}

export class CustomChatTransport implements ChatTransport<UIMessage> {
  /** Record memory uses when a reply finishes. Cowork records its own. */
  protected recordsMemoryUsesOnFinish = true
  /**
   * The model Jev routed the message in flight to, instead of the one chosen in
   * the picker. Set before the message is sent and replaced for the next one;
   * the picker itself is never changed.
   */
  protected turnModel?: Pick<
    ReturnType<typeof useModelProvider.getState>,
    'selectedProvider' | 'selectedModel'
  >
  /** The assistant answering the turn in flight, shown on the reply. */
  protected answeringAssistant: { name: string; avatar?: string } | undefined
  /**
   * Record each request as part of a Chat turn (`run.started`/`run.ended`
   * with `source: chat`). Cowork records its own run around every step it
   * sends through this transport, so a second, chat-shaped run for the same
   * requests only duplicated the record -- and ended `error` whenever a step
   * was retried, timed out or superseded while the Cowork run went on to
   * succeed.
   */
  protected recordsChatRun = true
  /** Which MCP server each advertised tool came from, for the context breakdown. */
  protected toolServers = new Map<string, string>()
  /**
   * Whether this transport compacts a conversation at the threshold itself.
   * Cowork compacts in its run loop, where the summary is persisted, and turns
   * this off so a request is never compacted twice.
   */
  protected compactsAtThreshold = true
  private contextEstimate = new ContextEstimate()
  /** A compaction this request made, announced on its reply's metadata. */
  private announcedCompaction: CompactionRecord | null = null
  /**
   * Set for the one resend after the provider refused a request for its
   * length: the request is compacted even though the local estimate said it
   * fitted, and plans against the window the refusal named when it named one.
   */
  private overflowRetry: { learnedWindow: number | null } | null = null
  /** Threads and models already told that auto-compact has no window to use. */
  private unknownWindowNoticed = new Set<string>()

  /** Tell the user, once per chat and model, that auto-compact needs a context size. */
  private noticeUnknownWindow(threadId: string, modelId: string): void {
    const key = `${threadId}|${modelId}`
    if (this.unknownWindowNoticed.has(key)) return
    this.unknownWindowNoticed.add(key)
    toast.warning(i18n.t('common:autoCompactNeedsWindow', { model: modelId }))
  }
  /** The compaction the latest attempt of this request announced. */
  private sentCompaction: CompactionRecord | null = null
  /** HTTP status of the failure `onError` last reported, for the fallback decision. */
  private lastFailureStatus: number | undefined
  /** One a failed attempt made, for the retry's reply to announce. */
  private carriedCompaction: CompactionRecord | null = null
  public model: LanguageModel | null = null
  private routerModel: LanguageModel | null = null
  private routerModelKey = ''
  protected tools: Record<string, Tool> = {}
  // Every tool refreshTools loaded; `tools` may be the lean subset of it a
  // small window is offered (lib/leanTools.ts).
  private loadedTools: Record<string, Tool> | null = null
  /** Saved subagent names the chat's `task` tool offers, for its prompt. */
  protected delegationNames: string[] = []
  private toolsCacheKey: string | null = null
  /** Kept until the set changes again, so the prompt prefix stays stable. */
  private mcpChangeText: string | null = null
  protected mcpStartingText: string | null = null
  // Smart tool routing selects tools from the latest user message, which would
  // change the tool set (and thus the cached prompt prefix) every turn. Freeze
  // the routed set for the thread's lifetime so the prefix stays stable;
  // re-route only when the connected servers or disabled-tool set changes.
  private frozenRoutedTools: MCPTool[] | null = null
  private frozenRoutedSig = ''
  private onTokenUsage?: TokenUsageCallback
  private hasDocuments = false
  private modelSupportsTools = false
  private ragFeatureAvailable = false
  protected systemMessage?: string
  protected serviceHub: ServiceHub | null
  protected threadId?: string
  /**
   * The memories this dispatch is carrying, resolved once per request.
   *
   * Frozen for the invocation on purpose: a retry has to record the selection
   * it actually sent, and re-running retrieval between the send and the record
   * would attribute the wrong memories to it. Cleared and refetched at the top
   * of each `sendMessages`.
   */
  protected memorySelection: ScopedMemoryRetrieved | null = null
  /** Small-context mode is on for the request being built (`lib/smallContext.ts`). */
  protected smallContext = false
  /** Tokens small-context mode saved on the request being built (prompt and tool schemas). */
  protected smallContextSaved: number | (() => number) = 0
  /**
   * The project folder this conversation belongs to, when it has one.
   *
   * Set by Cowork from the folder attached to the run (see
   * `CoworkChatTransport.syncMemoryBinding`). An ordinary chat has no folder;
   * its project, if any, is `janProjectId`.
   */
  protected projectRoot?: string
  /**
   * The Flint sidebar project an ordinary chat belongs to. Read from the thread
   * at send time, so moving the chat or deleting the project changes the next
   * request's scope and never the one already running.
   */
  protected janProjectId?: string
  protected janProjectName?: string
  /**
   * A temporary chat neither reads nor records memory.
   *
   * Carried here rather than inferred from the absence of a thread id: an
   * unsaved chat and a deliberately temporary one are different things, and
   * only the second should be denied its own memory. The temporary chat's own
   * id binds it from construction, so no caller has to remember to.
   */
  protected temporary = false
  /** The binding the last retrieval actually used, for the context panel. */
  private memoryBindingUsed: MemoryBinding | null = null
  /** The request id of the last `sendMessages`, for attribution lookups. */
  private lastRequestId: string | null = null
  private continueFromContent: ContinuationContent | null = null
  /** Latest user message text — used by the MCP orchestrator for tool routing. */
  private lastUserMessage = ''
  /**
   * Monotonic per-request token. The transport instance is reused across
   * regenerate, so a superseded request's terminal onError/onFinish must not
   * clear loading/stream state that the newer request has already set.
   */
  private streamGeneration = 0

  constructor(systemMessage?: string, threadId?: string) {
    this.systemMessage = systemMessage
    this.threadId = threadId
    this.temporary = threadId === TEMPORARY_CHAT_ID
    this.serviceHub = useServiceStore.getState().serviceHub
    // Tools will be loaded when updateRagToolsAvailability is called with model capabilities
  }

  /**
   * The provider and model this transport sends with.
   *
   * The global picker for chat. A subclass bound to a run of its own -- a
   * Cowork session -- answers with the model that run captured, so a model
   * chosen elsewhere mid-run does not change a run already under way
   * (janhq/jan#8905).
   */
  protected getModelSelection(): Pick<
    ReturnType<typeof useModelProvider.getState>,
    'selectedProvider' | 'selectedModel'
  > {
    // A model Jev routed this message to, for this message only.
    if (this.turnModel) return this.turnModel
    // A conversation shown as one of two split panes sends with its own
    // thread's model; the global picker follows whichever pane is active.
    // The model this run was sent with, so a model picked in another chat
    // while a tool loop is under way does not reroute it (janhq/jan#8083).
    if (this.runModel) return this.runModel
    return this.liveModelSelection()
  }

  /** The model chosen for this conversation right now, not the run's. */
  private liveModelSelection(): Pick<
    ReturnType<typeof useModelProvider.getState>,
    'selectedProvider' | 'selectedModel'
  > {
    const scoped = this.modelSelectionResolver?.()
    if (scoped) return scoped
    const { selectedProvider, selectedModel } = useModelProvider.getState()
    return { selectedProvider, selectedModel }
  }

  /**
   * The model a run was sent with. A run is a user message and the tool-loop
   * steps that follow it; each step is its own `sendMessages`, so the model is
   * captured when the user's message goes out and kept while the last message
   * is the assistant's.
   */
  private runModel?: Pick<
    ReturnType<typeof useModelProvider.getState>,
    'selectedProvider' | 'selectedModel'
  >

  /** Capture the run's model at a send, or keep it for a tool-loop step. */
  protected pinRunModel(messages: ReadonlyArray<{ role: string }>): void {
    const last = messages[messages.length - 1]
    if (this.runModel && last && last.role !== 'user') return
    this.runModel = this.liveModelSelection()
  }

  /**
   * The reasoning options this conversation's next request carries in the AI
   * SDK's `providerOptions` (the first-party providers' native thinking and
   * effort settings), read with the conversation's own overrides. Public so a
   * Cowork subagent, which streams on the parent's model, sends the same.
   */
  reasoningProviderOptions(
    threadId: string | undefined = this.threadId
  ): Record<string, JSONObject> | undefined {
    const { selectedProvider, selectedModel } = this.getModelSelection()
    return buildReasoningProviderOptions(
      selectedProvider,
      resolveModel(
        selectedModel,
        withReasoningDefault(
          useModelOverrides.getState().forThread(threadId),
          selectedProvider,
          selectedModel,
          useGeneralSetting.getState().reasoningDefault
        )
      )
    )
  }

  private modelSelectionResolver?: () =>
    | Pick<
        ReturnType<typeof useModelProvider.getState>,
        'selectedProvider' | 'selectedModel'
      >
    | undefined

  /**
   * Answer `getModelSelection` from somewhere other than the global picker, or
   * pass `undefined` to go back to it. Set by a split conversation pane for as
   * long as it shows this transport's thread.
   */
  setModelSelectionResolver(
    resolver?: () =>
      | Pick<
          ReturnType<typeof useModelProvider.getState>,
          'selectedProvider' | 'selectedModel'
        >
      | undefined
  ): void {
    this.modelSelectionResolver = resolver
  }

  setLastUserMessage(message: string): void {
    this.lastUserMessage = message
  }

  /**
   * Bind this transport to a project and say whether the chat is temporary.
   *
   * Both decide which memories apply, so they are set together: a caller that
   * knew one and forgot the other would silently change what is remembered.
   */
  setMemoryBinding(binding: {
    projectRoot?: string
    janProjectId?: string
    janProjectName?: string
    temporary?: boolean
  }): void {
    this.projectRoot = binding.projectRoot
    this.janProjectId = binding.janProjectId
    this.janProjectName = binding.janProjectName
    // Defaulting to "not temporary" would let a caller that forgot the flag
    // read memory into the temporary chat.
    this.temporary = binding.temporary ?? this.threadId === TEMPORARY_CHAT_ID
  }

  /**
   * Re-read the binding from its source just before retrieval.
   *
   * For chat that is the thread: its project can change between requests
   * (moved in the sidebar, project deleted) while this transport lives on in
   * the session store. A thread not in the store keeps the last explicit
   * binding.
   */
  protected syncMemoryBinding(): void {
    if (!this.threadId) return
    const thread = useThreads.getState().threads[this.threadId]
    if (!thread && this.threadId !== TEMPORARY_CHAT_ID) return
    this.setMemoryBinding(chatMemoryBinding(this.threadId, thread))
  }

  /** The binding the next request will use. */
  currentMemoryBinding(): MemoryBinding {
    this.syncMemoryBinding()
    return {
      projectRoot: this.projectRoot,
      janProjectId: this.janProjectId,
      janProjectName: this.janProjectName,
      temporary: this.temporary,
    }
  }

  /** The binding the last request used; `null` before the first request. */
  memoryBindingForLastRequest(): MemoryBinding | null {
    return this.memoryBindingUsed
  }

  /** What the last request from this transport was assembled from. */
  lastAttribution(): RequestAttribution | undefined {
    return this.lastRequestId
      ? requestAttributions.get(this.lastRequestId)
      : undefined
  }

  updateSystemMessage(systemMessage: string | undefined) {
    this.systemMessage = systemMessage
  }

  // Inference params follow the thread's assigned assistant so in-chat agent
  // switches take effect immediately. A thread with no real assistant
  // (model-only / "None") uses no assistant params — matching the switcher.
  // Only off-thread (no threadId / thread not yet in store) do we fall back to
  // the global current assistant.
  private getActiveInferenceParams(): Record<string, unknown> {
    const thread = this.threadId
      ? useThreads.getState().threads[this.threadId]
      : undefined
    if (thread) {
      const threadAssistant = thread.assistants?.[0]
      return threadAssistant && threadAssistant.id !== 'model-only'
        ? (threadAssistant.parameters ?? {})
        : {}
    }
    return useAssistant.getState().currentAssistant?.parameters ?? {}
  }

  setOnTokenUsage(callback: TokenUsageCallback | undefined) {
    this.onTokenUsage = callback
  }

  /**
   * Update RAG tools availability based on thread metadata and model capabilities
   * @param hasDocuments - Whether the thread has documents attached
   * @param modelSupportsTools - Whether the current model supports tool calling
   * @param ragFeatureAvailable - Whether RAG features are available on the platform
   */
  async updateRagToolsAvailability(
    hasDocuments: boolean,
    modelSupportsTools: boolean,
    ragFeatureAvailable: boolean
  ) {
    this.hasDocuments = hasDocuments
    this.modelSupportsTools = modelSupportsTools
    this.ragFeatureAvailable = ragFeatureAvailable

    // Update tools based on current state
    await this.refreshTools()
  }

  /**
   * Refresh tools based on current state
   * Reloads both RAG and MCP tools and merges them
   * Filters out disabled tools based on thread settings
   * @private
   */
  /**
   * llama.cpp slot pin for this surface. Chat reuses one slot per thread so its
   * KV prefix survives across turns; other surfaces override to claim their own
   * and avoid evicting it. See CHAT_SLOT_ID.
   */
  protected slotParams(threadId?: string): Record<string, unknown> {
    return { id_slot: CHAT_SLOT_ID, thread_id: threadId }
  }

  /**
   * The system turn for this surface. Whitespace-only prompts collapse to
   * undefined so we don't send a useless system turn that some chat templates
   * still wrap into special tokens.
   */
  /** Skill text this surface puts in the prompt, counted apart in the breakdown. */
  protected skillTextsInPrompt(): string[] {
    return [skillCatalogBlock(undefined, undefined, this.smallContext)]
  }

  /**
   * Whether chat's own tool gating (specialist tools by conversation, and the
   * small-window low-value tools) applies to this surface. Cowork gates its
   * tools by group and says so; it turns this off.
   */
  protected appliesChatToolGating(): boolean {
    return true
  }

  /**
   * The user turned Chat's shell off (composer options). Chat only: Cowork
   * owns its tool set and keeps its shell. Read per request, so a flip applies
   * to the next send. When true, neither the tool nor its prompt text is sent.
   */
  protected chatShellWithheld(): boolean {
    return this.appliesChatToolGating() && !useChatShell.getState().shellEnabled
  }

  /** Tools this surface holds back from the request, for the context popover. */
  protected heldBackForBreakdown(): { name: string; group: string; schema: unknown }[] {
    return []
  }

  /**
   * Measure what this request carries by kind and hand it to the composer's
   * context circle. Never throws: a figure that cannot be worked out is a
   * missing figure, not a failed message.
   */
  /**
   * What small-context mode saved on this request: the prompt as the full
   * variants would have written it, and the tool schemas it left out. A floor:
   * the memory it capped is not counted.
   */
  private measureSmallContextSaving(
    fullTools: Record<string, unknown> | null,
    keptTools: Record<string, unknown> | null,
    messages: UIMessage[]
  ): number {
    if (!this.smallContext) return 0
    try {
      const small = this.buildSystemPrompt(messages)
      this.smallContext = false
      let full: string | undefined
      try {
        full = this.buildSystemPrompt(messages)
      } finally {
        this.smallContext = true
      }
      const promptSaved =
        estimateTokens(full ?? '') - estimateTokens(small ?? '')
      let toolsSaved = 0
      for (const [name, tool] of Object.entries(fullTools ?? {})) {
        if (keptTools && name in keptTools) continue
        toolsSaved += estimateToolTokens(name, {
          description: (tool as { description?: string }).description,
          inputSchema: (tool as { inputSchema?: unknown }).inputSchema,
        })
      }
      return Math.max(0, promptSaved) + toolsSaved
    } catch {
      return 0
    }
  }

  protected publishContextBreakdown(
    systemPrompt: string | undefined,
    messages: UIMessage[]
  ): void {
    if (!this.threadId) return
    try {
      const memory = this.memorySelection
      const built = buildContextBreakdown({
          systemPrompt,
          skillTexts: this.skillTextsInPrompt(),
          memoryTexts: memory?.block ? [memory.precedence ?? '', memory.block] : [],
          tools: Object.entries(this.tools ?? {}).map(([name, tool]) => ({
            name,
            schema: {
              description: (tool as { description?: string }).description,
              inputSchema: (tool as { inputSchema?: unknown }).inputSchema,
            },
            server: this.toolServers.get(name),
          })),
          held: this.heldBackForBreakdown(),
          messages,
        })
      useContextBreakdown
        .getState()
        .set(
          this.threadId,
          this.smallContext
            ? { ...built, smallContextSaved: this.smallContextSaved }
            : built
        )
    } catch {
      // Not measured this time.
    }
  }

  buildColorOutputInstruction(): string {
    return buildColorOutputInstruction(this.smallContext)
  }

  protected buildSystemPrompt(messages: UIMessage[]): string | undefined {
    const files = this.buildFilesSystemInstruction(messages)
    const web = this.buildWebSearchSystemInstruction()
    const agentTools = this.buildAgentToolsSystemInstruction()
    const shellAvailability = !useAgentToolsConfig.getState().agentToolsEnabled
      ? 'Host and workspace shell tools are off in this chat. If the user asks for one, explain that they can enable Agent Tools in Settings. Do not claim the command ran.'
      : this.tools && 'host_powershell' in this.tools
        ? 'host_powershell is available for an explicit request to run PowerShell on this computer. It asks for approval before execution.'
        : 'host_powershell is not offered in this request. Do not claim the command ran.'
    // Taught only when the tool is really offered, as Cowork does.
    const delegation =
      this.tools && 'task' in this.tools ? subagentGuide(this.delegationNames, { team: false }) : undefined
    // Any tool, MCP included, returns outside content, and an MCP tool can act
    // on the world as readily as the agent tools can.
    const hasTools = Object.keys(this.tools ?? {}).length > 0
    // "None" means none: no assistant text, nothing that needs explaining to
    // the model (no files, web, agent or MCP tools, memory), so what Flint
    // would add -- colour, shell and tool-call notes, the plugin list, the
    // date -- has nothing to attach to. Only the user's own reply-language
    // setting still goes through. `list_plugins` is always offered and is
    // described by its own schema.
    const offeredTools = Object.keys(this.tools ?? {}).filter(
      (name) => name !== 'list_plugins'
    )
    if (
      !this.systemMessage?.trim() &&
      !files &&
      !web &&
      !agentTools &&
      offeredTools.length === 0 &&
      !this.memorySelection?.block &&
      this.mcpPromptNotes().length === 0
    ) {
      return replyLanguageLine() || undefined
    }
    const raw =
      [
        this.systemMessage,
        chatSafetyGuidelines({
          readsExternalContent: Boolean(files || web || agentTools || hasTools),
          // Searching, reading a page, listing plugins or drawing a widget
          // changes nothing: the destructive-action rule (git, pushing,
          // deleting) is only taught when a tool that can act is offered.
          canChangeThings: Boolean(
            agentTools ||
              Object.keys(this.tools ?? {}).some((name) => !READ_ONLY_CHAT_TOOLS.has(name))
          ),
        }),
        files,
        web,
        this.buildColorOutputInstruction(),
        agentTools,
        shellAvailability,
        delegation,
        'Use only structured tool calls supplied by this request. Never print <tool_call> or <function=...> markup as an answer. If no suitable tool is available, say that you cannot run it.',
        // Independent of the agent tools: which plugins are on is Flint's own
        // state, and the answer to "is X enabled?" should never need a shell.
        pluginInventoryLine(),
        ...this.mcpPromptNotes(),
        // The precedence chain (AH-084), stated by the backend so every surface
        // says the same thing, then the remembered facts it ranks. Remembered
        // facts are data the model may use, not instructions it must follow;
        // the block arrives delimited and sealed from the backend. They change
        // with retrieval, so they follow the stable blocks above.
        this.memorySelection?.block ? this.memorySelection.precedence : undefined,
        this.memorySelection?.block ?? undefined,
      ]
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .join('\n\n') || undefined
    const language = replyLanguageLine()
    if (typeof raw !== 'string' || raw.trim().length === 0) return language || undefined
    // Last, so a new day does not invalidate the cached prefix before it.
    return `${raw}\n\n${language ? `${language}\n\n` : ''}${todayLine()}`
  }

  /**
   * Whether an image in a tool result is attached to the request as an image
   * part (or replaced by a note) for every provider, not only a local one. On
   * everywhere: a remote or custom server would otherwise be sent the image as
   * megabytes of base64 text, and never see it.
   */
  protected hoistsToolImages(): boolean {
    return true
  }

  /**
   * Many chat templates (Qwen3.5+) reject a window with no genuine user query
   * and throw a cryptic Jinja error. Fail early with a clear message when
   * deletion/eviction has left no real user turn to respond to.
   */
  protected assertSendable(messages: UIMessage[]): void {
    if (!hasGenuineUserQuery(messages)) {
      throw new Error(
        'This conversation has no user message to respond to. Add a message, or regenerate from a turn that includes your question.'
      )
    }
  }

  /**
   * Resolve what this dispatch may remember.
   *
   * The selection is the backend's: which records apply, how they are ordered,
   * what the budget allows and which conflicts are withheld are all decided in
   * one place that the CLI agent calls in process. This is the desktop reaching
   * the same function over IPC rather than a second implementation of it.
   *
   * A failure leaves the prompt without a memory block rather than failing the
   * turn: not remembering is a degraded answer, and refusing to answer is not.
   */
  protected async refreshMemory(budgetChars?: number): Promise<void> {
    this.memorySelection = null
    this.syncMemoryBinding()
    const binding: MemoryBinding = {
      projectRoot: this.projectRoot,
      janProjectId: this.janProjectId,
      janProjectName: this.janProjectName,
      temporary: this.temporary,
    }
    this.memoryBindingUsed = binding
    let dataFolder: string | null = null
    try {
      // Guarded rather than optional-chained one level: a hub without an app
      // service is a degraded environment, not a reason to fail the turn, and
      // it is what a partially-stubbed host looks like.
      dataFolder = (await getServiceHub().app().getJanDataFolder()) ?? null
    } catch {
      return
    }
    if (!dataFolder) return
    try {
      this.memorySelection = (await memoryRetrieve(
        memoryLocation(dataFolder, binding, this.threadId),
        {
          temporary: binding.temporary,
          instructions: this.memoryInstructions(),
          ...(budgetChars ? { budgetChars } : {}),
        }
      )) as ScopedMemoryRetrieved
    } catch (e) {
      console.warn('[memory] retrieval failed:', errorText(e))
    }
  }

  /**
   * Instruction text above memory for this request (AH-084): a memory that
   * contradicts it is withheld and reported. Chat has none of its own; Cowork
   * supplies its project's JAN.md and approved compatibility files.
   */
  protected memoryInstructions(): MemoryInstruction[] {
    return []
  }

  /** The memories the last dispatch carried, for the snapshot and accounting. */
  memoryUsed(): ScopedMemoryRetrieved | null {
    return this.memorySelection
  }

  async refreshTools(abortSignal?: AbortSignal, useCache = false) {
    return refreshTools(this.toolRefreshHost(), abortSignal, useCache)
  }

  /** The class state tool listing reads and writes; see `chat/transport/toolRefresh.ts`. */
  private toolRefreshHost(): ToolRefreshHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return {
      get serviceHub() { return self.serviceHub },
      get threadId() { return self.threadId },
      get lastUserMessage() { return self.lastUserMessage },
      get hasDocuments() { return self.hasDocuments },
      get ragFeatureAvailable() { return self.ragFeatureAvailable },
      get modelSupportsTools() { return self.modelSupportsTools },
      get model() { return self.model },
      get routerModel() { return self.routerModel },
      set routerModel(v) { self.routerModel = v },
      get routerModelKey() { return self.routerModelKey },
      set routerModelKey(v) { self.routerModelKey = v },
      get tools() { return self.tools },
      set tools(v) { self.tools = v },
      get loadedTools() { return self.loadedTools },
      set loadedTools(v) { self.loadedTools = v },
      get toolsCacheKey() { return self.toolsCacheKey },
      set toolsCacheKey(v) { self.toolsCacheKey = v },
      get toolServers() { return self.toolServers },
      set toolServers(v) { self.toolServers = v },
      get delegationNames() { return self.delegationNames },
      set delegationNames(v) { self.delegationNames = v },
      get frozenRoutedTools() { return self.frozenRoutedTools },
      set frozenRoutedTools(v) { self.frozenRoutedTools = v },
      get frozenRoutedSig() { return self.frozenRoutedSig },
      set frozenRoutedSig(v) { self.frozenRoutedSig = v },
      get mcpStartingText() { return self.mcpStartingText },
      set mcpStartingText(v) { self.mcpStartingText = v },
      get mcpChangeText() { return self.mcpChangeText },
      set mcpChangeText(v) { self.mcpChangeText = v },
      getModelSelection: () => self.getModelSelection(),
      chatShellWithheld: () => self.chatShellWithheld(),
      recordMcpSet: (advertised, listed) => self.recordMcpSet(advertised, listed),
    }
  }

  /**
   * Compare this request's MCP tools with the last request's. A difference
   * becomes a note for the model, a toast for the person when a server
   * appeared, and a refresh of the lists the UI and the call dispatcher read.
   */
  protected recordMcpSet(
    advertised: { name: string; server?: string }[],
    listed?: MCPTool[]
  ): void {
    recordMcpSet(this.toolRefreshHost(), advertised, listed)
  }

  protected mcpPromptNotes(): string[] {
    return [this.mcpChangeText, this.mcpStartingText].filter(
      (s): s is string => typeof s === 'string' && s.length > 0
    )
  }

  /**
   * Get current tools
   */
  getTools(): Record<string, Tool> {
    return this.tools
  }

  /**
   * Set partial assistant content to send as a prefill on the next request,
   * so the model continues generation from where it left off. Accepts a plain
   * text string, or structured content carrying reasoning so a turn stopped
   * mid-thinking resumes inside its reasoning block.
   */
  setContinueFromContent(content: string | ContinuationContent) {
    const normalized: ContinuationContent =
      typeof content === 'string' ? { text: content } : content
    this.continueFromContent =
      normalized.text || normalized.reasoning ? normalized : null
  }

  /**
   * Race model creation (which blocks on llama-server load, up to 600s)
   * against the request's abort signal. `invoke()` has no cancellation of
   * its own, so an abort during "Loading model..." would otherwise be
   * silently ignored until load either finishes or times out. On abort we
   * fire-and-forget an unload of the (possibly still-loading) model so the
   * router doesn't keep spawning/holding a llama-server nobody wants.
   */
  private createModelOrAbort(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown>,
    providerId: string,
    abortSignal: AbortSignal | undefined,
    runId?: string
  ): Promise<LanguageModel> {
    // Which conversation this model's requests belong to, so the transport can
    // record what was sent and the timeline can find that record again. Set on
    // the model instance, which is per conversation -- a shared "current
    // dispatch" would race between two sessions streaming at once. The run is
    // this request, so its snapshot can be attributed to it and not merely to
    // "the thread's latest dispatch".
    const modelPromise = ModelFactory.createModel(
      modelId,
      provider,
      {
        ...parameters,
        ...(this.threadId
          ? {
              [DISPATCH_PARAM_KEY]: {
                session: this.threadId,
                provider: providerId,
                ...(runId ? { run: runId } : {}),
              },
            }
          : {}),
      },
      // Live stream stats belong to this conversation, not to whichever one
      // is current when a chunk arrives.
      this.threadId || undefined
    )
    if (!abortSignal) return modelPromise

    // Target lib is ES2021 here (see tsconfig.app.json), predating
    // Promise.withResolvers (ES2024), so the executor form is required.
    return new Promise<LanguageModel>((resolve, reject) => {
      const onAbort = () => {
        if (providerId === 'llamacpp') {
          // Cancel the load through the plugin directly instead of the
          // extension's `unload()` method: that method first looks up an
          // active *loaded* session and throws if none is found, but a
          // model aborted mid-load is still in the "loading" state (not
          // "loaded") and would never resolve to a session -- silently
          // skipping the unload and leaking the still-loading engine.
          // See https://github.com/janhq/jan/issues/8432.
          abandonModelLoad(modelId)
        }
        const err = new Error('Aborted')
        err.name = 'AbortError'
        reject(err)
      }
      if (abortSignal.aborted) {
        // Nobody else awaits modelPromise on this path; observe it so a later
        // load failure is not an unhandled rejection (#88).
        modelPromise.catch(() => {})
        onAbort()
        return
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      modelPromise
        .then((model) => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(model)
        })
        .catch((error) => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(error)
        })
    })
  }

  /**
   * The tool choice for the next request. A seam: Cowork asks for `none` on
   * the closing turn after its loop guard stops a run.
   */
  protected toolChoiceForStep(): 'auto' | 'none' {
    return 'auto'
  }

  /** Chat's automatic compaction; see `chat/transport/compaction.ts`. */
  private compactAtThreshold(
    threadId: string,
    messages: UIMessage[],
    opts: CompactAtThresholdOptions
  ): Promise<UIMessage[]> {
    return compactAtThreshold(this.compactionHost(), threadId, messages, opts)
  }

  /** Compact, keep the result with the thread, and record it. */
  private runCompaction(
    threadId: string,
    history: UIMessage[],
    opts: RunCompactionOptions
  ) {
    return runCompaction(this.compactionHost(), threadId, history, opts)
  }

  private compactionHost(): CompactionHost {
    return {
      model: () => this.model,
      announce: (record) => {
        this.announcedCompaction = record
      },
    }
  }

  /**
   * Compact this conversation now, whatever its size: the composer's
   * `/compact` and the context-error banner's Compact button. The summary is
   * kept with the thread and used by every later request. Resolves to what
   * was done, or null when there was nothing to fold.
   */
  async compactNow(
    threadId: string,
    messages: UIMessage[],
    signal?: AbortSignal,
    focus?: string
  ): Promise<CompactionRecord | null> {
    const selection = this.getModelSelection()
    const modelId = selection.selectedModel?.id
    if (!modelId) return null
    const params = this.getActiveInferenceParams()
    let policy = DEFAULT_COMPACTION_POLICY
    try {
      policy = await getCompactionPolicy()
    } catch {
      // Defaults: a compaction was asked for either way.
    }
    const { history, stale } = applyChatCompaction(
      messages,
      readChatCompaction(threadId)
    )
    if (stale) writeChatCompaction(threadId, null)
    resetCompactionBreaker(threadId)
    const base = {
      window: usableContextValue(params.max_context_tokens) ?? null,
      summaryMaxTokens: policy.summaryMaxTokens,
      provider: selection.selectedProvider,
      modelId,
      session: threadId,
      reason: 'manual' as const,
      signal,
      focus,
    }
    const keepRecent = policy.keepRecent || DEFAULT_KEEP_RECENT
    let result = await this.runCompaction(threadId, history, {
      ...base,
      keepRecent,
    })
    // A long tool loop is one user turn, which the usual cut keeps whole:
    // fold inside it rather than report that there was nothing to compact.
    if (!result) {
      result = await this.runCompaction(threadId, history, {
        ...base,
        keepRecent: Math.max(2, Math.floor(keepRecent / 2)),
        splitTurn: true,
      })
    }
    return result?.record ?? null
  }

  /**
   * `/btw`: answer one side question from a snapshot of the thread, with no
   * tools and nothing written back. Reads a copy, so it works mid-stream.
   */
  async sideQuestion(
    threadId: string,
    messages: UIMessage[],
    question: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const selection = this.getModelSelection()
    const modelId = selection.selectedModel?.id
    if (!modelId) return null
    let model = this.model
    if (!model) {
      const provider = useModelProvider
        .getState()
        .getProviderByName(selection.selectedProvider)
      if (!provider) return null
      model = await ModelFactory.createModel(modelId, provider, {})
    }
    return askSideQuestion({
      model,
      modelId,
      session: threadId,
      messages,
      question,
      signal,
    })
  }

  /**
   * Sends on the chosen model; if that fails to answer for a reason another
   * model could fix (see `shouldFallback`) before any reply content, the same
   * turn is retried on the next model of the fallback chain.
   */
  async sendMessages(
    options: SendOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.pinRunModel(options.messages)
    // The thread's assistant parameters are read below: a listed summary has
    // none, so load the full assistant first.
    if (this.threadId) await useThreads.getState().ensureThreadHydrated?.(this.threadId)
    // A server that refuses images ("At most 0 image(s) may be provided")
    // although the model can see: learned from the refusal, then the same
    // request goes again without them. Once per newly learned limit.
    const selection = this.getModelSelection()
    const imageKey = imageLimitKey(
      selection.selectedProvider,
      selection.selectedModel?.id ?? ''
    )
    const learnImageLimit = (failure: unknown): boolean => {
      if (options.abortSignal?.aborted) return false
      const limit = parseImageLimit(failure)
      if (limit == null) return false
      const known = imageLimitFor(imageKey)
      if (known != null && known <= limit) return false
      rememberImageLimit(imageKey, limit)
      return true
    }
    let first: ReadableStream<UIMessageChunk>
    try {
      first = await this.sendMessagesCore(options)
    } catch (error) {
      if (!learnImageLimit(error)) throw error
      return this.sendMessagesCore(options)
    }
    return withEarlyRetry(first, learnImageLimit, () =>
      this.sendMessagesCore(options)
    )
  }

  private sendMessagesCore(
    options: SendOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return sendMessagesCore<SendOptions>(
      {
        get compactsAtThreshold() { return self.compactsAtThreshold },
        get overflowRetry() { return self.overflowRetry },
        set overflowRetry(v) { self.overflowRetry = v },
        sendWithFallback: (o) => self.sendWithFallback(o),
        getActiveInferenceParams: () => self.getActiveInferenceParams(),
      },
      options
    )
  }

  private async sendWithFallback(
    options: SendOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    const chain = resolveFallbackChain(
      useGeneralSetting.getState().fallbackModels,
      {
        provider: this.getModelSelection().selectedProvider,
        modelId: this.getModelSelection().selectedModel?.id ?? '',
      },
      useModelProvider.getState().providers
    )
    if (chain.length === 0) return this.sendOnce(options)

    const original = this.turnModel
    let next = 0
    let currentProvider = this.getModelSelection().selectedProvider

    // The chosen model failed on an earlier request of this turn chain and a
    // fallback answered: keep going from that one for a tool follow-up. A new
    // user message, a regenerate, another selected model, or the time running
    // out all forget it, so the chosen model is tried again.
    const threadKey = this.threadId ?? options.chatId
    // The chain is part of the key: reordering or editing it must not leave
    // an index pointing at a different model.
    const selectionKey = `${fallbackRef(
      currentProvider,
      this.getModelSelection().selectedModel?.id ?? ''
    )}>${chain
      .map((c) => fallbackRef(c.selectedProvider, c.selectedModel.id))
      .join('>')}`
    const isFollowUp =
      options.trigger === 'submit-message' &&
      options.messages[options.messages.length - 1]?.role === 'assistant'
    const moved = primaryDown.get(threadKey)
    if (moved) {
      if (
        moved.selection === selectionKey &&
        moved.until > Date.now() &&
        isFollowUp &&
        moved.index >= 1 &&
        moved.index <= chain.length
      ) {
        next = moved.index
        this.turnModel = chain[next - 1]
        currentProvider = chain[next - 1].selectedProvider
      } else {
        primaryDown.delete(threadKey)
      }
    }
    // A compaction the first attempt made is already in the thread's saved
    // state, so a retry finds nothing left to fold and would never announce it.
    this.sentCompaction = null
    this.carriedCompaction = null
    const attempt = async (): Promise<ReadableStream<UIMessageChunk>> => {
      let failure: unknown
      let thrown = false
      this.lastFailureStatus = undefined
      const held: UIMessageChunk[] = []
      let reader: ReadableStreamDefaultReader<UIMessageChunk> | undefined
      try {
        const stream = await this.sendOnce(options)
        reader = stream.getReader()
        // Hold the stream's opening chunks until the first reply content, so a
        // request that fails at once can be retried without the chat showing it.
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          held.push(value)
          if (value.type === 'error') {
            // The chunk carries only the message; `onError` kept the HTTP
            // status of the same failure, which a reply like "The server had
            // an error" does not spell out.
            failure =
              this.lastFailureStatus === undefined
                ? value.errorText
                : Object.assign(new Error(value.errorText), {
                    statusCode: this.lastFailureStatus,
                  })
            break
          }
          if (!/^(start|start-step|message-metadata)$/.test(value.type)) break
        }
      } catch (error) {
        failure = error
        thrown = true
      }
      const target = chain[next]
      if (failure === undefined) {
        // The chosen model answered: it is up. A fallback answered: stay on it
        // for the rest of this turn chain.
        if (next === 0) primaryDown.delete(threadKey)
        else
          primaryDown.set(threadKey, {
            selection: selectionKey,
            until: Date.now() + PRIMARY_DOWN_MS,
            index: next,
          })
      } else if (!target && next > 0) {
        // Every model of the chain failed: start from the chosen one again.
        primaryDown.delete(threadKey)
      }
      if (
        failure === undefined ||
        !target ||
        !shouldFallback(
          failure,
          options.abortSignal?.aborted,
          target.selectedProvider !== currentProvider
        )
      ) {
        if (thrown) throw failure
        // Nothing to retry: hand the stream over exactly as it came, with the
        // chunks held back put in front.
        const source = reader as ReadableStreamDefaultReader<UIMessageChunk>
        return new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const chunk of held) controller.enqueue(chunk)
          },
          async pull(controller) {
            const { done, value } = await source.read()
            if (done) controller.close()
            else controller.enqueue(value)
          },
          cancel: (reason) => source.cancel(reason),
        })
      }
      // The failed attempt's stream is abandoned; stop reading it.
      void reader?.cancel().catch(() => {})
      next++
      this.carriedCompaction = this.sentCompaction ?? this.carriedCompaction
      this.turnModel = target
      currentProvider = target.selectedProvider
      primaryDown.set(threadKey, {
        selection: selectionKey,
        until: Date.now() + PRIMARY_DOWN_MS,
        index: next,
      })
      toast.info(
        i18n.t('common:fallbackSwitched', { model: target.selectedModel.id })
      )
      return attempt()
    }
    try {
      return await attempt()
    } finally {
      // Only this request moved; the next one (a tool follow-up, the next
      // message) starts from the chosen model again. The stream built above
      // reads nothing from here, so it stays on the model that answered it.
      this.turnModel = original
      this.carriedCompaction = null
    }
  }

  /**
   * Everything before the stream exists can throw (model load failure, Stop
   * during load, a missing provider, a hook interrupt, a context that does not
   * fit), and then no stream callback ever runs. Undo what the request set up
   * here so the in-flight flag is not left stale and the run is not recorded
   * as done (report-21 MED-1).
   */
  protected async sendOnce(
    options: SendOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    const held: { generation?: number; run?: string } = {}
    try {
      return await this.sendOnceUnguarded(options, held)
    } catch (error) {
      const threadId = this.threadId ?? options.chatId
      if (
        held.generation === this.streamGeneration &&
        useAppState.getState().currentStreamThreadId === threadId
      ) {
        useAppState.getState().setCurrentStreamThreadId(undefined)
      }
      if (held.run) {
        const aborted =
          options.abortSignal?.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        endChatRun(
          threadId,
          aborted ? 'cancelled' : 'error',
          aborted ? undefined : error instanceof Error ? error.message : String(error),
          held.run
        )
      }
      throw error
    }
  }

  private async sendOnceUnguarded(
    options: SendOptions,
    held: { generation?: number; run?: string }
  ): Promise<ReadableStream<UIMessageChunk>> {
    const threadId = this.threadId ?? options.chatId
    const myGeneration = ++this.streamGeneration
    held.generation = myGeneration
    const requestId = newRequestId()
    useAppState.getState().setCurrentStreamThreadId(threadId)
    // Capture the effective provider name early so the Anthropic serial
    // tool-use repair later uses the same value that was used to create the
    // model, even if the user switches provider mid-request.
    const selection = this.getModelSelection()
    const modelId = selection.selectedModel?.id
    const providerId = selection.selectedProvider
    const effectiveProviderName = providerId
    const provider = useModelProvider.getState().getProviderByName(providerId)
    if (!this.serviceHub || !modelId || !provider) {
      throw new Error('ServiceHub not initialized or model/provider missing.')
    }

    this.lastUserMessage = extractLatestUserText(options.messages)
    // AH-004: the turn, in the session's canonical record. Opened before the
    // request goes out, so a turn cancelled before its first token is in the
    // record rather than missing from it, and continued -- not reopened --
    // when this request is the one carrying tool results back.
    // Only this request's turn may be ended by its callbacks (#137).
    const recordsChatRun = this.recordsChatRun
    const myRun = recordsChatRun
      ? continueOrBeginChatRun(threadId, { model: modelId }).run
      : undefined
    held.run = myRun

    try {
      const updatedProvider = useModelProvider
        .getState()
        .getProviderByName(providerId)

      const inferenceParams = this.getActiveInferenceParams()

      // Resolved for this chat, not the bare global model: everything derived
      // below — the reasoning mode, the sampling defaults, the llama.cpp
      // thinking budget — has to see the chat's own overrides, or a control
      // the composer shows as set would never reach the request.
      const selectedModel = resolveModel(
        selection.selectedModel,
        withReasoningDefault(
          useModelOverrides.getState().forThread(threadId),
          providerId,
          selection.selectedModel,
          useGeneralSetting.getState().reasoningDefault
        )
      )
      const reasoningParams = buildLlamacppReasoningParams(
        effectiveProviderName,
        selectedModel?.settings?.reasoning?.controller_props?.value as
          | 'auto'
          | 'on'
          | 'off'
          | undefined,
        extractModelTemplateKwargs(selectedModel)
      )

      if (providerId === 'llamacpp') {
        try {
          const loaded = await getLoadedModels()
          if (!loaded.includes(modelId)) {
            useAppState.getState().updateLoadingModel(true)
            useAppState.getState().updateThreadLoadingModel(threadId, true)
            useAppState.getState().updateModelLoadProgress(undefined)
            useAppState.getState().updateThreadModelLoadProgress(threadId, undefined)
          }
        } catch {
          // Ignore probe failures; the router will still load on demand
        }
      }

      // Per-model sidebar sampling defaults flow through as request-body
      // overrides (router mode can't bake them into CLI args). Assistant
      // params still win — they're the explicit per-conversation override.
      const modelSamplingDefaults = extractModelSamplingDefaults(selectedModel)
      if (providerId === 'llamacpp') {
        const thinkingBudgetTokens = await resolveThinkingBudgetTokens(
          selectedModel,
          modelId
        )
        if (thinkingBudgetTokens !== undefined) {
          // Reasoning must leave room for the answer inside the output limit.
          const rawMax =
            inferenceParams?.max_output_tokens ??
            inferenceParams?.max_tokens ??
            modelSamplingDefaults.max_tokens
          const maxOut = typeof rawMax === 'number' ? rawMax : Number(rawMax)
          modelSamplingDefaults.thinking_budget_tokens = clampThinkingBudget(
            thinkingBudgetTokens,
            Number.isFinite(maxOut) ? maxOut : undefined
          )
        }
      }

      // Create the model before refreshing tools so the MCP orchestrator can run
      // structured LLM routing when many servers are connected.
      const mergedParams = mergeRequestParams({
        modelSamplingDefaults,
        inferenceParams,
        reasoningParams,
        providerId: effectiveProviderName,
        selectedModel,
        slotParams:
          providerId === 'llamacpp' ? this.slotParams(threadId) : undefined,
      })
      this.model = await this.createModelOrAbort(
        modelId,
        updatedProvider ?? provider,
        mergedParams,
        providerId,
        options.abortSignal,
        requestId
      )
      useAppState.getState().updateLoadingModel(false)
      useAppState.getState().updateThreadLoadingModel(threadId, false)
      useAppState.getState().updateModelLoadProgress(undefined)
      useAppState.getState().updateThreadModelLoadProgress(threadId, undefined)
    } catch (error) {
      const wasLoading = Boolean(useAppState.getState().loadingModels[threadId])
      useAppState.getState().updateLoadingModel(false)
      useAppState.getState().updateThreadLoadingModel(threadId, false)
      useAppState.getState().updateModelLoadProgress(undefined)
      useAppState.getState().updateThreadModelLoadProgress(threadId, undefined)
      if (wasLoading && !(error instanceof Error && error.name === 'AbortError')) {
        useAppState.getState().markThreadModelLoadFailed(threadId, true)
      }
      console.error('Failed to create model:', error)
      // Preserve AbortError identity so callers/UI can tell a user-initiated
      // Stop from an actual model-load failure.
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw engineFailure('model-errors:createModelFailed', error)
    }

    await this.refreshTools(options.abortSignal, true)

    // Split assistant turns that place text after tool calls into separate
    // messages. Required by the Claude API (tool_use / tool_result pairing) and
    // it keeps the prompt prefix byte-identical across turns so llama.cpp reuses
    // the KV cache. See `splitAssistantToolWaves`.
    const messagesToConvert = splitAssistantToolWaves(options.messages)

    const inferenceParams = this.getActiveInferenceParams()

    const selectedModel = this.getModelSelection().selectedModel

    // The user's Claude Code hooks, when they linked them: SessionStart text
    // follows the system prompt, UserPromptSubmit text rides on this message.
    // Only a turn that is answering the user's message asks for the latter.
    const ccContext = await runCcContextHooks({
      sessionId: this.threadId ?? options.chatId,
      projectDir: this.projectRoot,
      prompt: userMessageText(messagesToConvert[messagesToConvert.length - 1]),
    })
    // Stopped while the prompt hooks ran: fail closed rather than answer a
    // prompt no hook has looked at.
    if (ccContext.interrupted) {
      throw new Error(
        'The turn was stopped while its prompt hooks ran, so the prompt was not submitted.'
      )
    }
    const maxOutputTokens: number | undefined = (() => {
      const raw = inferenceParams.max_output_tokens ?? inferenceParams.max_tokens
      if (raw === undefined || raw === null) return undefined
      const n = typeof raw === 'number' ? raw : Number(raw)
      return isNaN(n) ? undefined : n
    })()

    // Zero means "not known", never "a window with no room in it". It reaches
    // `effectiveContextWindow` and then the `> 0` guard below, which is what
    // lets an undiscoverable window still dispatch: Flint's own budgets still
    // apply, but no context limit is enforced against a number nobody has.
    const configuredContextTokens =
      usableContextValue(inferenceParams.max_context_tokens) ?? 0
    let liveContextTokens: number | undefined
    // The engine's real n_ctx bounds the window whether or not Context Shift
    // is on: with fit on and no Max Context Tokens set, it is the only size
    // that is known to fit in memory.
    if (providerId === 'llamacpp') {
      try {
        liveContextTokens = (
          await getLlamacppExtension()?.getModelProps?.(modelId)
        )?.nCtx
      } catch {
        // The router has not loaded the model yet. Preserve the configured limit.
      }
    }
    // A model with no window of its own (a custom OpenAI-compatible one) still
    // has a best available one: what the provider describes, what its model
    // list named, the last one this chat showed, or what the server says now.
    const providerWindow = knownContextWindowDetail(selectedModel, provider)
    // Ollama keeps only its loaded `num_ctx` of a prompt (janhq/jan#9476).
    const ollama = isOllamaProvider(provider)
    let ollamaWindow: number | null = null
    const resolvedWindow = await resolveCompactionWindow({
      known: effectiveContextWindow(
        configuredContextTokens,
        liveContextTokens,
        providerId === 'llamacpp'
      ),
      fetchLoaded: ollama
        ? async () =>
            (ollamaWindow = await fetchOllamaWindow(
              provider?.base_url,
              modelId,
              serverWindowHeaders(provider)
            ))
        : undefined,
      provider: providerWindow.bundled ? null : providerWindow.tokens,
      bundled: providerWindow.bundled ? providerWindow.tokens : null,
      listed: listedWindow(provider?.base_url, modelId),
      remembered: rememberedWindowFor(
        useContextBreakdown.getState(),
        threadId,
        modelId
      ),
      fetchServer: () =>
        fetchServerWindow(
          provider?.base_url,
          modelId,
          serverWindowHeaders(provider)
        ),
    })
    const knownContextTokens = resolvedWindow.tokens
    // The resend after a length refusal plans against what the refusal named
    // when that is smaller, and against an assumed window when nothing is
    // known: a request that was refused has to shrink, not be sent again.
    const retryWindow = this.overflowRetry?.learnedWindow ?? null
    const maxContextTokens = this.overflowRetry
      ? knownContextTokens > 0
        ? retryWindow != null && retryWindow < knownContextTokens
          ? retryWindow
          : knownContextTokens
        : (retryWindow ?? ASSUMED_WINDOW_TOKENS)
      : knownContextTokens
    // AH-076: the shared compaction policy -- the same file the desktop agent
    // loop and the CLI read. A policy file the backend refuses fails the
    // request rather than silently compacting at a default point.
    const compaction =
      maxContextTokens > 0 ? await getCompactionPolicy() : DEFAULT_COMPACTION_POLICY
    // The per-model parameter still opts a model in; the policy opts every
    // surface in or out.
    // The model's Auto Compact parameter, when set, decides; otherwise the
    // shared policy does (`lib/compaction.ts`).
    const autoCompact = resolveAutoCompact(inferenceParams, compaction.auto)
    // Auto-compact has nothing to measure against: say so rather than letting
    // it look like it is working. A refused request still compacts and retries.
    if (autoCompact && resolvedWindow.source === 'none') {
      this.noticeUnknownWindow(threadId, modelId)
    }
    if (
      ollamaWindow != null &&
      shouldNoticeOllamaTruncation(
        `${threadId}|${modelId}`,
        estimateHistoryTokens(messagesToConvert),
        ollamaWindow
      )
    ) {
      toast.warning(
        i18n.t('common:ollamaWindowTruncating', { model: modelId, tokens: ollamaWindow }),
        { duration: 15000 }
      )
    }

    // A small window is not spent on tools a small model rarely needs (the
    // plugin list, image search, widgets), unless the user keeps them on.
    // Before the prompt is built: the prompt only teaches what is offered.
    this.smallContext = smallContextActive(
      useLeanToolsConfig.getState().smallContextMode,
      maxContextTokens
    )
    // Memory is read once the window is known: a small window takes less of it.
    await this.refreshMemory(this.smallContext ? SMALL_CONTEXT_MEMORY_CHARS : undefined)
    const leanWindows = useLeanToolsConfig.getState().leanSmallWindows
    // Specialist host/browser tools wait until the conversation asks for them.
    // Chat only: a surface with its own tool gating (Cowork's groups and
    // `enable_tools`) must not have a second, differently-triggered filter
    // stacked on top of it.
    if (this.appliesChatToolGating()) {
      this.tools = toolsForConversation(
        this.tools,
        messagesToConvert,
        useLeanToolsConfig.getState().leanSpecialist,
        (name) => this.toolServers.has(name)
      )
    }
    // Snapshot after the conversation gating: what small-context mode saves is
    // measured against the set the chat would otherwise send.
    const fullTools =
      this.smallContext && this.appliesChatToolGating()
        ? toolsForWindow(this.tools, maxContextTokens, leanWindows, false)
        : null
    if (this.appliesChatToolGating()) {
      this.tools = toolsForWindow(
        this.tools,
        maxContextTokens,
        leanWindows,
        this.smallContext
      )
    }
    const effectiveSystem = appendSessionContext(
      this.buildSystemPrompt(messagesToConvert),
      ccContext.sessionStart
    )
    // Worked out only when the context popover asks (it rebuilds the prompt).
    const toolsKept = this.tools
    let saved: number | undefined
    this.smallContextSaved = () =>
      (saved ??= this.measureSmallContextSaving(fullTools, toolsKept, messagesToConvert))
    this.publishContextBreakdown(effectiveSystem, messagesToConvert)

    // Room kept for the reply: a local model keeps only its own reply cap (or
    // a small share of the window); a hosted one keeps the policy headroom.
    const localServer = isLocalChatServer(providerId, provider?.base_url)
    const reserveTokens = replyReserve(maxContextTokens, maxOutputTokens, compaction, localServer)
    let effectiveMessages = messagesToConvert
    const estimateKey = `${provider?.base_url ?? providerId}:${modelId}`
    const estimateRatio = this.contextEstimate.ratio(estimateKey)
    const estimatedWindow = Math.floor(maxContextTokens / estimateRatio)
    const toolSchemaTokens =
      Object.keys(this.tools).length > 0 &&
      (selectedModel?.capabilities?.includes('tools') ?? this.modelSupportsTools)
        ? estimateToolSchemaTokens(this.tools)
        : 0
    if (maxContextTokens > 0) {
      const contextConfig: ContextManagerConfig = {
        // History is measured in estimated tokens; the user's cap and reply
        // reserve are real tokens. Convert both using the measured ratio.
        maxContextTokens: estimatedWindow,
        // The reserve is headroom kept free; a model's own output cap, when
        // larger, still wins.
        maxOutputTokens: Math.ceil(reserveTokens / estimateRatio),
        autoCompact: !!autoCompact,
      }

      // Context Shift only shifts llama.cpp's KV cache after generation starts.
      // Keep the submitted chat history under the live router context window first.
      // A vision model is also sent the recent browser screenshots (kept beside
      // the transcript, see lib/toolScreenshots.ts): their cost is reserved here
      // because the pictures are added after the history is fitted.
      const screenshotTokens = (selectedModel?.capabilities?.includes('vision') ?? false)
        ? screenshotsToAttach(messagesToConvert) * SCREENSHOT_TOKEN_ESTIMATE
        : 0
      // Tool definitions are sent on every request, independently of history.
      // Reserving only the system text lets large MCP catalogs bypass the cap.
      const systemPromptTokens =
        (effectiveSystem ? estimateTokens(effectiveSystem) + 4 : 0) +
        (ccContext.promptSubmit.length ? estimateTokens(ccContext.promptSubmit.join('\n')) + 8 : 0) +
        (this.continueFromContent ? estimateTokens(
          (this.continueFromContent.text ?? '') + (this.continueFromContent.reasoning ?? '')
        ) + 4 : 0) +
        toolSchemaTokens +
        screenshotTokens
      this.announcedCompaction = this.carriedCompaction
      if (
        autoCompact &&
        compaction.strategy === 'summarize' &&
        this.compactsAtThreshold
      ) {
        effectiveMessages = await this.compactAtThreshold(
          threadId,
          messagesToConvert,
          {
            window: estimatedWindow,
            trimReserveTokens:
              contextConfig.maxOutputTokens +
              contextSafetyMargin(estimatedWindow),
            threshold: compactThresholdFor(compaction, DEFAULT_COMPACT_THRESHOLD),
            systemPromptTokens,
            keepRecent: compaction.keepRecent || DEFAULT_KEEP_RECENT,
            summaryMaxTokens: compaction.summaryMaxTokens,
            provider: providerId,
            modelId: selectedModel?.id ?? modelId,
            session: options.chatId ?? threadId,
            signal: options.abortSignal,
            force: this.overflowRetry != null,
          }
        )
      }
      // A backstop either way: what still does not fit after compaction (or
      // with compaction off) is trimmed from the oldest end, as before.
      {
        const trimResult = trimMessages(
          effectiveMessages,
          contextConfig,
          systemPromptTokens
        )
        effectiveMessages = trimResult.messages
        if (trimResult.trimmedCount > 0) {
          console.debug(
            `[context-manager] Trimmed ${trimResult.trimmedCount} oldest messages to fit context budget`
          )
          void recordLifecycle(
            { session: options.chatId ?? '', run: '', source: 'chat' },
            {
              id: `context-trim:${Date.now()}`,
              lifecycle: 'compaction',
              phase: 'succeeded',
              summary: `Left out ${trimResult.trimmedCount} oldest messages to fit the context window`,
            }
          )
        }
      }
    }

    // Many chat templates (Qwen3.5+) reject a window with no genuine user query
    // and throw a cryptic Jinja error. Fail early with a clear message when
    // deletion/eviction has left no real user turn to respond to.
    this.assertSendable(effectiveMessages)

    // A compaction summary rides in the first-position system message when
    // the model is known to accept one; otherwise it stays a user message,
    // which every template takes (`lib/compactionSystemRole.ts`).
    let requestSystem = effectiveSystem
    // A raw-completion model just continues the text it is given, so a system
    // prompt would be read as part of that text.
    if (selectedModel?.capabilities?.includes('raw_completion')) {
      requestSystem = undefined
    }
    if (acceptsSystemRole(providerId, selectedModel)) {
      const folded = foldSummaryIntoSystem(requestSystem, effectiveMessages)
      requestSystem = folded.system
      effectiveMessages = folded.messages
    }
    // Old widgets replay as a one-line note; the stored message keeps the code.
    effectiveMessages = truncateStaleWidgetCode(effectiveMessages)
    effectiveMessages = withPromptContext(effectiveMessages, ccContext.promptSubmit)

    // The server may have refused images for this model (a limit of 0): then
    // it is treated as unable to see, and a describer model takes over.
    const imageLimit = imageLimitFor(imageLimitKey(providerId, modelId))
    const modelSupportsVision =
      (selectedModel?.capabilities?.includes('vision') ?? false) &&
      imageLimit !== 0
    // A model that cannot see gets a written description of each image, made by
    // one that can, in the image's place: the images the user attached, and
    // those a tool returned (a screenshot, a file read). Tool images are hoisted
    // as for a model that sees and then described below. With no such model (or
    // the feature off) the images are stripped, as before.
    const describer = modelSupportsVision ? null : currentDescriber()
    const imagesReachModel = modelSupportsVision || describer !== null
    const withInlineAttachments = attachToolScreenshots(
      this.mapUserInlineAttachments(effectiveMessages),
      { supportsVision: imagesReachModel }
    )
    // A local model reads a tool result as text, so an image in one (an MCP
    // screenshot tool) would arrive as its full base64 and flood the context.
    // The image is swapped for a note and, for a model that can see, attached
    // again as an image. Remote providers get the same treatment so a vision
    // model sees the image and any other gets a short note, not base64 text.
    // llama.cpp cannot decode WebP, so a WebP image goes to it as PNG.
    const preparedImages = LOCAL_ENGINE_PROVIDERS.has(providerId ?? '')
      ? await transcodeWebpImages(
          prepareToolResultImagesForModel(withInlineAttachments, {
            supportsVision: imagesReachModel,
          })
        )
      : this.hoistsToolImages() || hasAgentToolImages(withInlineAttachments)
        ? prepareToolResultImagesForModel(withInlineAttachments, {
            supportsVision: imagesReachModel,
          })
        : withInlineAttachments
    const attachmentsReady = describer
      ? await describeImagesInMessages(preparedImages, describer, {
          session: threadId,
          signal: options.abortSignal,
        })
      : preparedImages
    const baseMessages = await convertToModelMessages(
      coalesceMessagesForAlternation(
        resolveOrphanToolCalls(
          this.encodeVideoAttachments(
            this.encodeAudioAttachments(
              limitIfNeeded(
                stripUnsupportedImageParts(attachmentsReady, modelSupportsVision),
                imageLimit
              )
            )
          )
        )
      )
    )

    // If continuing a truncated response, append the partial assistant content as a
    // prefill so the model resumes from where it left off rather than regenerating.
    const continueContent = this.continueFromContent
    this.continueFromContent = null
    const modelMessages = continueContent
      ? [
          ...baseMessages,
          {
            role: 'assistant' as const,
            content: [
              ...(continueContent.reasoning
                ? [
                    {
                      type: 'reasoning' as const,
                      text: continueContent.reasoning,
                    },
                  ]
                : []),
              ...(continueContent.text
                ? [{ type: 'text' as const, text: continueContent.text }]
                : []),
            ],
          },
        ]
      : baseMessages

    const dispatchedEstimate = estimateHistoryTokens(effectiveMessages) +
      (requestSystem ? estimateTokens(requestSystem) + 4 : 0) + toolSchemaTokens +
      (continueContent ? estimateTokens((continueContent.text ?? '') + (continueContent.reasoning ?? '')) : 0)
    // The trimmer preserves a newest message even when that one message is
    // larger than the budget. Refuse that payload instead of silently sending
    // it past the chosen cap. Overflow recovery may compact it once more.
    // A local server is asked once even when the estimate says it is tight:
    // the estimate is a heuristic, and the server's own refusal names the real
    // window, which the overflow recovery then plans against. Only the resend
    // after such a refusal is checked here (with no reserve: a request that
    // fits the window without it is never refused).
    if (!localServer) {
      assertEstimatedContextFits(dispatchedEstimate, estimateRatio, maxContextTokens,
        reserveTokens, this.overflowRetry ? 'the last refusal' : resolvedWindow.source)
    } else if (this.overflowRetry) {
      assertEstimatedContextFits(dispatchedEstimate, estimateRatio, maxContextTokens, 0, 'the last refusal')
    }

    // Include tools only if we have tools loaded AND model supports them
    const hasTools = Object.keys(this.tools).length > 0
    const modelSupportsTools =
      (selectedModel?.capabilities?.includes('tools') ?? this.modelSupportsTools) ||
      threadToolsGranted(this.threadId)
    const shouldEnableTools = hasTools && modelSupportsTools

    // Cloud providers take reasoning via the AI SDK's per-request
    // providerOptions (native thinking config), not the raw body.
    // The chat's own view of the model: global configuration with whatever
    // this chat has overridden layered on top. Resolved here rather than
    // stored, so a setting the chat never touched still follows the global
    // default as that default changes.
    const reasoningProviderOptions = this.reasoningProviderOptions(threadId)

    // The assembled request, by reference: ids and hashes of what went in,
    // never the content. Dispatch events move it to sent / response-started /
    // failed, and it rides on the assistant message's metadata.
    requestAttributions.begin(
      threadId,
      assembleAttribution({
        requestId,
        memory: this.memorySelection,
        binding: this.memoryBindingUsed ?? {
          projectRoot: this.projectRoot,
          janProjectId: this.janProjectId,
          janProjectName: this.janProjectName,
          temporary: this.temporary,
        },
        tools: shouldEnableTools ? Object.keys(this.tools) : [],
        messages: effectiveMessages,
        provider: providerId,
        model: modelId,
      })
    )
    this.lastRequestId = requestId

    let streamStartTime: number | undefined
    // Generation time, for the speed: output only, per step. See createDecodeClock.
    const decodeClock = createDecodeClock()
    // Time spent thinking, stored on the message so "Thought for N s" survives a reload.
    const reasoningClock = createReasoningClock()
    useAppState.getState().updatePromptProgress(undefined)
    useAppState.getState().updateThreadPromptProgress(threadId, undefined)
    useAppState.getState().updateLiveTokenStats(undefined)
    useAppState.getState().updateThreadLiveTokenStats(threadId, undefined)

    // One signal for the request: the user's Stop, or the idle watchdog below
    // ending a stream that went silent, so the server stops working on it too.
    const requestAbort = new AbortController()
    const forwardStop = () => requestAbort.abort(options.abortSignal?.reason)
    if (options.abortSignal?.aborted) forwardStop()
    else options.abortSignal?.addEventListener('abort', forwardStop, { once: true })

    const result = streamText({
      model: this.model,
      messages: modelMessages,
      abortSignal: requestAbort.signal,
      // Hosted providers keep the SDK's two backoff retries for transient
      // 429/5xx; local servers fail at once (see isLocalChatServer).
      maxRetries: isLocalChatServer(providerId, provider.base_url) ? 0 : 2,
      tools: shouldEnableTools ? this.tools : undefined,
      toolChoice: shouldEnableTools ? this.toolChoiceForStep() : undefined,
      system: requestSystem,
      ...(maxOutputTokens !== undefined && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
      ...(() => {
        const providerOptions = mergeProviderOptions(
          reasoningProviderOptions,
          buildVerbosityProviderOptions(providerId, modelId, inferenceParams)
        )
        return providerOptions ? { providerOptions } : {}
      })(),
      experimental_repairToolCall: async ({ toolCall, error }) => {
        // Windows paths (`C:\Users\...`) contain invalid JSON escapes that make
        // the SDK's argument parse fail. Re-escape lone backslashes and retry
        // so the tool receives the intended path instead of looping on failure.
        if (!InvalidToolInputError.isInstance(error)) return null
        const repaired = repairToolArgs(toolCall.input)
        if (!repaired) return null
        return { ...toolCall, input: JSON.stringify(repaired) }
      },
    })

    // The reply this request continues, if it does: its speed block covers
    // every request of the reply, while `usage` stays the last request's.
    const earlierSpeed = earlierTokenSpeed(options.messages)
    // The reply's time is when it began, stamped once on its first part: the
    // chat used to show the time it was rendered, and the thread file the
    // time the last step finished.
    const replyStartedAt = earlierCreatedAt(options.messages) ?? Date.now()
    let tokensPerSecond = 0
    let promptPerSecond = 0
    let draftTokens = 0
    let draftAccepted = 0
    // Per step, with the provider's raw usage: the `finish` part's total has
    // already been summed by the SDK and no longer says whether a cache count
    // was reported or defaulted to zero.
    const usageCollector = createUsageCollector()

    const announced = this.announcedCompaction
    this.announcedCompaction = null
    this.sentCompaction = announced
    const uiStream = result.toUIMessageStream({
      messageMetadata: ({ part }) => {
        // Start the clock at the first sign of output, whatever shape it
        // arrives in.
        //
        // This used to wait for `text-start` or `reasoning-start`. A provider
        // whose stream does not announce those -- an OpenAI-compatible server
        // that goes straight to deltas, for one -- left `streamStartTime`
        // unset, so `durationMs` was 0, so `tokenSpeed` was 0. The indicator
        // then showed the token count and no speed at all, which reads as the
        // speed having disappeared. The token count was right there in the
        // metadata the whole time, which is what made it look like a display
        // bug rather than a measurement one.
        //
        // The starts are still preferred and still checked first, so nothing
        // changes for providers that send them; the deltas are only a floor for
        // providers that do not.
        if (
          !streamStartTime &&
          (part.type === 'text-start' ||
            part.type === 'reasoning-start' ||
            part.type === 'text-delta' ||
            part.type === 'reasoning-delta')
        ) {
          streamStartTime = Date.now()
        }
        if (
          part.type === 'text-delta' ||
          part.type === 'reasoning-delta' ||
          part.type === 'tool-input-delta'
        ) {
          const piece =
            part.type === 'tool-input-delta'
              ? (part as { inputTextDelta?: string }).inputTextDelta
              : (part as { delta?: string }).delta
          decodeClock.tick(piece?.length ?? 0)
        }
        if (part.type === 'finish-step') decodeClock.endStep()
        reasoningClock.observe(part.type)

        usageCollector.observe(part)

        // One invocation per model request, minted when the step starts, so
        // everything the step does -- its tools, its usage, its message -- is
        // recorded against the request that asked for it.
        if (recordsChatRun && part.type === 'start-step') {
          nextChatInvocation(threadId)
        }
        if (recordsChatRun && part.type === 'finish-step') {
          const step = part as { type: 'finish-step'; usage?: LanguageModelUsage }
          const invocation = chatRunOf(threadId)?.invocation ?? ''
          const reported = readTokenUsage(usageCollector.total(step.usage))
          if (reported) {
            recordChatUsage(threadId, invocation, usageEventPayload(reported))
          }
        }

        // The attribution travels with the message from its first part, and
        // again once the provider has answered (the snapshot reference is
        // known by then), so a reply persisted at any point carries it.
        if (part.type === 'start' || part.type === 'start-step') {
          const attribution = attributionMetadata(
            requestAttributions,
            requestId,
            part.type
          )
          // The reply that follows a compaction carries it, so the chat can
          // draw the divider where it happened and show the summary.
          const compacted = part.type === 'start' ? announced : null
          // Who answered, so the reply's header can name the assistant that
          // was in charge of it rather than always saying Flint.
          const answering = part.type === 'start' ? this.answeringAssistant : undefined
          return compacted || answering || part.type === 'start'
            ? {
                ...(attribution ?? {}),
                ...(part.type === 'start' ? { createdAt: replyStartedAt } : {}),
                ...(compacted ? { compaction: compacted } : {}),
                ...(answering
                  ? { assistantName: answering.name, assistantAvatar: answering.avatar }
                  : {}),
              }
            : attribution
        }

        if (part.type === 'finish-step') {
          tokensPerSecond =
            (part.providerMetadata?.providerMetadata
              ?.tokensPerSecond as number) || 0
          promptPerSecond =
            (part.providerMetadata?.providerMetadata
              ?.promptPerSecond as number) || 0
          draftTokens =
            (part.providerMetadata?.providerMetadata
              ?.draftTokens as number) || 0
          draftAccepted =
            (part.providerMetadata?.providerMetadata
              ?.draftAccepted as number) || 0
        }

        // Add usage and token speed to metadata on finish
        if (part.type === 'finish') {
          const finishPart = part as {
            type: 'finish'
            totalUsage: LanguageModelUsage
            finishReason: string
          }
          const usage = usageCollector.total(finishPart.totalUsage)
          this.contextEstimate.observe(estimateKey, dispatchedEstimate, usage.inputTokens)
          const durationMs = streamStartTime ? Date.now() - streamStartTime : 0

          // Only for the speed figure; the stored usage keeps an unreported
          // count unreported rather than zero.
          const outputTokens = usage.outputTokens ?? 0

          // The server's own tokens per second when it sends one (llama.cpp);
          // otherwise the provider's output tokens over the time output was
          // arriving, not over the whole request.
          const generation = generationSpeed({
            serverTokensPerSecond: tokensPerSecond,
            outputTokens: usage.outputTokens,
            ...decodeClock.result(),
          })
          const tokenSpeed = generation?.tokenSpeed ?? 0
          // The Models page charts speed from replies this machine measured.
          if (tokenSpeed > 0 && modelId) {
            recordGeneration({ model: modelId, provider: providerId, tps: tokenSpeed })
          }

          // Counted for the Overview dashboard, on this computer only.
          const pricedModel = useModelProvider
            .getState()
            .getProviderByName(providerId ?? '')
            ?.models.find((m: Model) => m.id === modelId)
          useUsageStats.getState().recordGeneration({
            tokens: outputTokens,
            durationMs: tokenSpeed > 0 ? (outputTokens / tokenSpeed) * 1000 : 0,
            cost: replyCost(
              resolvePricing(
                providerId,
                pricedModel ?? (modelId ? { id: modelId } : undefined)
              ),
              usage.inputTokens,
              outputTokens,
              {
                cachedInputTokens: usage.cachedInputTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
              }
            ),
          })

          // AH-083: where each carried memory was used -- now naming the
          // exact request it went out in, the way Cowork's does, because the
          // transport's snapshot reaches Chat as well (AH-032). Without the
          // snapshot a use could say only "this chat, some turn".
          if (this.recordsMemoryUsesOnFinish && this.memorySelection?.injectedIds.length) {
            const snapshotId = chatSnapshotId(this.threadId)
            void recordMemoryUses({
              sessionId: this.threadId,
              projectRoot: this.projectRoot,
              janProjectId: this.janProjectId,
              memory: {
                injectedIds: this.memorySelection.injectedIds,
                conflictIds: this.memorySelection.conflictIds,
                recall: this.memorySelection.recall ?? [],
              },
              ...(snapshotId
                ? { snapshotId, turnId: `turn-${snapshotId}` }
                : {}),
            })
          }

          // Bind the provider's own count to the dispatch it counted, the
          // way Cowork does. Only with an invocation: an unbound count is
          // what the usage record exists to refuse.
          bindUsageAtFinish({
            registry: requestAttributions,
            requestId,
            session: threadId,
            model: modelId,
            usage: usage
              ? {
                  inputTokens: usage.inputTokens,
                  outputTokens,
                  totalTokens: usage.totalTokens,
                }
              : undefined,
            record: recordPayloadUsage,
          })

          return {
            ...attributionMetadata(requestAttributions, requestId, 'finish'),
            finishReason: finishPart.finishReason,
            streamCutOff: streamCutOff(part),
            usage,
            contextTokens: usageCollector.contextTokens(),
            ...(reasoningClock.totalMs() > 0
              ? { reasoningMs: Math.round(reasoningClock.totalMs()) }
              : {}),
            // Which remembered records this request carried, and which were
            // withheld as conflicting: ids only, never their text.
            ...(this.memorySelection
              ? {
                  memory: {
                    injectedIds: this.memorySelection.injectedIds,
                    conflictIds: this.memorySelection.conflictIds,
                    storageIssues: this.memorySelection.storageIssues ?? [],
                    recallOff: this.memorySelection.recallOff ?? [],
                    recall: (this.memorySelection.recall ?? []).map((r) => ({
                      id: r.id,
                      rank: r.rank,
                      reason: r.reason,
                    })),
                    overridden: this.memorySelection.overridden ?? [],
                    refused: this.memorySelection.refused ?? [],
                  },
                }
              : {}),
            ...(() => {
              if (!recordsChatRun) return {}
              // What the reply was made of: sizes and counts, never the words.
              recordChatMessage(threadId, chatRunOf(threadId)?.invocation ?? '', {
                finishReason: finishPart.finishReason,
                outputTokens,
                durationMs,
              })
              // A reply that asked for tools leaves the turn open: the tools
              // run next, and their results come back in another request.
              markChatAwaitingTools(
                threadId,
                finishPart.finishReason === 'tool-calls',
                myRun
              )
              return {}
            })(),
            tokenSpeed: {
              ...(() => {
                const reply = addToReplySpeed(earlierSpeed, {
                  tokenSpeed,
                  tokenCount: generation?.tokenCount ?? outputTokens,
                  durationMs: generation?.durationMs ?? durationMs,
                })
                return {
                  tokenSpeed: Math.round(reply.tokenSpeed * 100) / 100,
                  tokenCount: reply.tokenCount,
                  durationMs: reply.durationMs,
                }
              })(),
              promptSpeed: promptPerSecond
                ? Math.round(promptPerSecond * 100) / 100
                : undefined,
              ...(generation ? { source: generation.source } : {}),
              ...(draftTokens > 0
                ? { draftTokens, draftAccepted: Math.min(draftAccepted, draftTokens) }
                : {}),
            },
          }
        }

        return undefined
      },
      onError: (error) => {
        requestAttributions.fail(requestId)
        // A superseded request (e.g. after Reload) must not clear loading/stream
        // state the newer request already owns.
        if (this.streamGeneration === myGeneration) {
          useAppState.getState().updatePromptProgress(undefined)
          useAppState.getState().updateLoadingModel(false)
          useAppState.getState().updateThreadPromptProgress(threadId, undefined)
          useAppState.getState().updateThreadLoadingModel(threadId, false)
          useAppState.getState().updateLiveTokenStats(undefined)
          useAppState.getState().updateThreadLiveTokenStats(threadId, undefined)
          if (useAppState.getState().currentStreamThreadId === threadId) {
            useAppState.getState().setCurrentStreamThreadId(undefined)
          }
        }
        const unwrapped = unwrapRetryError(error)
        const failed = unwrapped as { statusCode?: unknown; status?: unknown } | null
        const httpStatus = [failed?.statusCode, failed?.status].find(
          (v): v is number => typeof v === 'number'
        )
        // The error can be reported again, bare, by a stream wrapper; keep the
        // status the first report carried.
        if (httpStatus !== undefined) this.lastFailureStatus = httpStatus
        const rawMessage = unwrapped == null
          ? 'Unknown error'
          : typeof unwrapped === 'string'
            ? unwrapped
            : unwrapped instanceof Error
              ? unwrapped.message
              : JSON.stringify(unwrapped)
        const baseMessage = stripRetryErrorWrapper(rawMessage)
        // Say why the turn failed, not only that it did.
        if (myRun) endChatRun(threadId, 'error', baseMessage, myRun)

        const contextInfo = extractContextInfoFromError(unwrapped)
        if (contextInfo) {
          return `${baseMessage}\n\n(Used ${contextInfo.nPromptTokens.toLocaleString()} of ${contextInfo.nCtx.toLocaleString()} context tokens.)`
        }
        return baseMessage
      },
      onFinish: ({ responseMessage }) => {
        if (!myRun) {
          // Not recording a chat turn: the caller records its own run.
        } else if (options.abortSignal?.aborted)
          endChatRun(threadId, 'cancelled', undefined, myRun)
        // Left open when tools are still to run: the turn ends with the reply
        // that needs none.
        else if (!chatAwaitsTools(threadId, myRun))
          endChatRun(threadId, 'done', undefined, myRun)
        if (this.streamGeneration === myGeneration) {
          useAppState.getState().updatePromptProgress(undefined)
          useAppState.getState().updateLoadingModel(false)
          useAppState.getState().updateThreadPromptProgress(threadId, undefined)
          useAppState.getState().updateThreadLoadingModel(threadId, false)
          useAppState.getState().updateLiveTokenStats(undefined)
          useAppState.getState().updateThreadLiveTokenStats(threadId, undefined)
          if (useAppState.getState().currentStreamThreadId === threadId) {
            useAppState.getState().setCurrentStreamThreadId(undefined)
          }
        }
        if (responseMessage) {
          const metadata = responseMessage.metadata as
            | Record<string, unknown>
            | undefined
          const usage = readTokenUsage(metadata?.usage)
          if (usage) {
            this.onTokenUsage?.(usage, responseMessage.id)
          }
        }
      },
    })

    // When continuing a truncated response, inject the partial content as the
    // very first text-delta so the new message immediately shows it and the
    // user sees a seamless continuation rather than an empty box.
    const continuedStream = continueContent
      ? prependContinuationToUIStream(uiStream, continueContent)
      : uiStream

    // A call to the shell while the composer has it switched off is not in
    // `this.tools`, so the SDK would reject it and end the turn. Hand it to the
    // tool loop instead, which answers it with the "turned off" refusal.
    const finalStream = routeRefusedToolCalls(
      continuedStream,
      (toolName) =>
        toolName === SHELL_TOOL_NAME &&
        !(toolName in (this.tools ?? {})) &&
        this.chatShellWithheld()
    )

    const reasoningGuard = new ReasoningLoopGuard()
    let idle: ReturnType<typeof createIdleWatchdog> | undefined
    const endIdle = () => {
      idle?.stop()
      options.abortSignal?.removeEventListener('abort', forwardStop)
    }
    return finalStream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        start(controller) {
          idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS, () => {
            requestAbort.abort(new Error(streamIdleMessage(STREAM_IDLE_TIMEOUT_MS)))
            controller.error(new Error(streamIdleMessage(STREAM_IDLE_TIMEOUT_MS)))
          })
        },
        transform(chunk, controller) {
          idle?.touch()
          if (chunk.type === 'reasoning-delta' && reasoningGuard.add(chunk.delta)) {
            const loopError = new Error('Reasoning stopped after repeating the same text. Try a different model or a lower thinking budget.')
            endIdle()
            // Stop the request too, as the idle watchdog does: erroring only the
            // downstream stream leaves the model generating the same text on the
            // engine, and the abort is what runs the run cleanup.
            requestAbort.abort(loopError)
            controller.error(loopError)
            return
          }
          if (chunk.type === 'finish' || chunk.type === 'error' || chunk.type === 'abort') endIdle()
          controller.enqueue(chunk)
        },
        flush: endIdle,
        // A consumer that cancels the reader never reaches flush. `cancel` is
        // in the Streams spec but not yet in this TS lib's Transformer type.
        ...({ cancel: endIdle } as object),
      })
    )
  }

  async reconnectToStream(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: {
      chatId: string
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // This function normally handles reconnecting to a stream on the backend, e.g. /api/chat
    // Since this project has no backend, we can't reconnect to a stream, so this is intentionally no-op.
    return null
  }

  encodeAudioAttachments(messages: UIMessage[]): UIMessage[] {
    return encodeAudioAttachments(messages)
  }

  encodeVideoAttachments(messages: UIMessage[]): UIMessage[] {
    return encodeVideoAttachments(messages)
  }

  buildFilesSystemInstruction(messages: UIMessage[]): string {
    return buildFilesSystemInstruction(messages)
  }

  buildWebSearchSystemInstruction(): string {
    return buildWebSearchSystemInstruction({
      threadId: this.threadId,
      tools: this.tools,
      smallContext: this.smallContext,
    })
  }

  buildAgentToolsSystemInstruction(): string {
    return buildAgentToolsSystemInstruction({
      threadId: this.threadId,
      smallContext: this.smallContext,
      shellWithheld: () => this.chatShellWithheld(),
    })
  }

  mapUserInlineAttachments(messages: UIMessage[]): UIMessage[] {
    return mapUserInlineAttachments(messages)
  }
}
