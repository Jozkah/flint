import { hasAgentToolImages } from '@/lib/toolOutputImages'
import { pluginInventoryLine, refreshPluginInventory } from '@/lib/pluginInventory'
import { refreshSkillCatalog, skillCatalogBlock } from '@/lib/skillCatalog'
import { buildContextBreakdown } from '@/lib/contextBreakdown'
import { currentDescriber, describeImagesInMessages } from '@/lib/imageDescription'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
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
import {
  convertToModelMessages,
  streamText,
  type ChatRequestOptions,
  type ChatTransport,
  type LanguageModel,
  type UIMessageChunk,
  type Tool,
  type LanguageModelUsage,
  jsonSchema,
  InvalidToolInputError,
} from 'ai'
import { repairToolArgs } from './toolCallRepair'
import { streamCutOff } from './streamFinish'
import { recordMemoryUses } from './memoryUses'
import { getServiceHub, useServiceStore } from '@/hooks/useServiceHub'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { deadTools } from '@/lib/deadTools'
import { DISPATCH_PARAM_KEY, ModelFactory } from './model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import { chatFoldersOf } from '@/lib/chatFolders'
import { useAttachments } from '@/hooks/useAttachments'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import {
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_INPUT_SCHEMA,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_INPUT_SCHEMA,
} from '@/lib/webSearchTool'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { getAgentToolSchemas, sandboxEnforces } from '@/lib/agentTools'
import { SESSION_MESSAGING_TOOLS } from '@/lib/sessionMessagingTools'
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
import { unloadLlamaModel, getLoadedModels } from '@janhq/tauri-plugin-llamacpp-api'
import { engineFailure } from '@/lib/engineError'
import { chatSafetyGuidelines, todayLine } from '@/lib/promptSafety'
import { replyLanguageLine } from '@/lib/replyLanguage'
import { ExtensionManager } from '@/lib/extension'
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
  buildReasoningBodyParams,
} from '@/lib/reasoningProviderOptions'
import { resolveModel } from '@/lib/modelOverrides'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import {
  ExtensionTypeEnum,
  VectorDBExtension,
  type MCPTool,
} from '@janhq/core'
import {
  trimMessages,
  estimateTokens,
  contextSafetyMargin,
  clearStaleToolResults,
  type ContextManagerConfig,
} from './context-manager'
import {
  compactHistory,
  estimateHistoryTokens,
  planCompaction,
  resolveAutoCompact,
  compactionTriggerTokens,
  clipToolResultsToFit,
  isContextLengthError,
  ASSUMED_WINDOW_TOKENS,
  TRIM_HEADROOM_SHARE,
  DEFAULT_KEEP_RECENT,
  type CompactionRecord,
  type CompactResult,
} from '@/lib/compaction'
import { parseServerContextLimit } from '@/lib/contextLimitRecovery'
import { isContextOverflowMessage } from '@/utils/error'
import {
  CompactionLoopError,
  PRECOMPUTE_FRACTION,
  cancelPrecompute,
  isCompactionLooping,
  recordCompaction,
  resetCompactionBreaker,
  startPrecompute,
  takePrecomputedPrefix,
} from '@/lib/compactionGuard'
import {
  acceptsSystemRole,
  foldSummaryIntoSystem,
} from '@/lib/compactionSystemRole'
import { modelSummarizer } from '@/lib/compactionSummarizer'
import {
  applyChatCompaction,
  readChatCompaction,
  stateAfter,
  writeChatCompaction,
} from '@/lib/chatCompaction'
import { recordLifecycle } from '@/lib/toolActivity'
import { getCompactionPolicy, outputHeadroom, DEFAULT_COMPACTION_POLICY } from '@/lib/compactionPolicy'
import { chatAwaitsTools, chatRunOf, chatSnapshotId, continueOrBeginChatRun, endChatRun, markChatAwaitingTools, nextChatInvocation, recordChatMessage, recordChatUsage } from '@/lib/chatRun'
import { usageEventPayload } from '@/lib/executionTimeline'
import { mcpOrchestrator } from '@/lib/mcp-orchestrator'
import { isRouterModelSelectable } from '@/lib/mcp-router-model-filter'
import {
  announceMcpChange,
  diffMcpSnapshots,
  enabledMcpServers,
  getMcpGeneration,
  loadLiveMcpTools,
  mcpChangeNote,
  mcpStartingNote,
  readMcpBaseline,
  snapshotMcpTools,
  syncMcpStore,
  writeMcpBaseline,
} from '@/lib/mcpLiveTools'
import { encodeAudioSentinel, parseAudioDataUrl } from '@/lib/audio-sentinel'
import { prepareToolResultImagesForModel } from '@/lib/toolResultImages'
import { transcodeWebpImages } from '@/lib/imageTranscode'
import { encodeVideoSentinel, parseVideoDataUrl } from '@/lib/video-sentinel'
import { isPredefinedRemoteProvider } from '@/lib/providerCaps'
import { paramsSettings } from '@/lib/predefinedParams'
import { CHAT_SLOT_ID } from '@/constants/models'
import { usableContextValue } from '@/lib/modelCapabilities'
import { recordGeneration } from '@/stores/engine-activity-store'
import { isSelfApprovalTool } from '@/lib/selfApprovalTools'
import {
  createUsageCollector,
  readTokenUsage,
  type TokenUsage,
} from '@/lib/tokenUsage'

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

/**
 * Which shell to reach for, in order. Third-party shell MCPs (super-shell and
 * the like) have their own whitelists and program/args shapes, and a model
 * offered them beside bash and git kept picking them and failing.
 */
export const SHELL_ROUTING_GUIDANCE = [
  'Choosing a shell: use the git tool for every git and gh command, the',
  'built-in bash tool for all other commands, and an MCP shell or terminal',
  'tool only when the user names it or asks for it.',
].join(' ')

const SCHEMA_PRIMITIVE_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'array',
  'object',
])

const SCHEMA_NODE_MAP_KEYS = new Set(['properties', 'patternProperties', 'definitions', '$defs'])
const SCHEMA_NODE_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])

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
] as const

/** Keys whose upstream handler throws on a negative value. */
const NON_NEGATIVE_SAMPLING_KEYS = new Set<string>([
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

export function effectiveContextWindow(
  configuredContextTokens: number,
  liveContextTokens: number | undefined,
  contextShiftEnabled: boolean
): number {
  return contextShiftEnabled &&
    typeof liveContextTokens === 'number' &&
    liveContextTokens > 0
    ? liveContextTokens
    : configuredContextTokens
}


/**
 * Coerce a schema-node slot into a valid sub-schema. Some tool generators
 * emit shorthand like `{ "properties": { "foo": "string" } }` instead of
 * `{ "properties": { "foo": { "type": "string" } } }`. llama.cpp's
 * json-schema-to-grammar rejects the former with
 * `Unrecognized schema: "string"`. We expand the shorthand here so the
 * grammar generator sees a well-formed schema.
 */
function coerceSchemaNode(value: unknown): unknown {
  if (typeof value === 'string' && SCHEMA_PRIMITIVE_TYPES.has(value)) {
    return normalizeToolInputSchemaValue({ type: value })
  }
  return normalizeToolInputSchemaValue(value)
}

function normalizeToolInputSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeToolInputSchemaValue)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, childValue]) => {
      // Schema-node containers: their direct children are sub-schemas, so a
      // bare-string primitive type name should expand to `{ type: <name> }`.
      if (
        SCHEMA_NODE_MAP_KEYS.has(key) &&
        childValue &&
        typeof childValue === 'object' &&
        !Array.isArray(childValue)
      ) {
        return [
          key,
          Object.fromEntries(
            Object.entries(childValue as Record<string, unknown>).map(
              ([propKey, propVal]) => [propKey, coerceSchemaNode(propVal)]
            )
          ),
        ]
      }
      if (SCHEMA_NODE_LIST_KEYS.has(key) && Array.isArray(childValue)) {
        return [key, childValue.map(coerceSchemaNode)]
      }
      if (key === 'items') {
        if (Array.isArray(childValue)) return [key, childValue.map(coerceSchemaNode)]
        return [key, coerceSchemaNode(childValue)]
      }
      return [key, normalizeToolInputSchemaValue(childValue)]
    })
  )

  const hasDescription = Object.prototype.hasOwnProperty.call(normalized, 'description')
  const hasType = Object.prototype.hasOwnProperty.call(normalized, 'type')
  const hasNestedSchemaKeywords =
    Object.prototype.hasOwnProperty.call(normalized, 'properties') ||
    Object.prototype.hasOwnProperty.call(normalized, 'items') ||
    Object.prototype.hasOwnProperty.call(normalized, 'anyOf') ||
    Object.prototype.hasOwnProperty.call(normalized, 'oneOf') ||
    Object.prototype.hasOwnProperty.call(normalized, 'allOf') ||
    Object.prototype.hasOwnProperty.call(normalized, '$ref')

  if (normalized.type === 'object' && !Object.prototype.hasOwnProperty.call(normalized, 'properties')) {
    normalized.properties = {}
  }

  if (hasDescription && !hasType && !hasNestedSchemaKeywords) {
    normalized.type = 'string'
  }

  // llama.cpp's json-schema-to-grammar emits PCRE `\d` for these formats,
  // which GBNF rejects; the failed grammar silently disables tool-call JSON.
  if (
    typeof normalized.format === 'string' &&
    LLAMACPP_BROKEN_STRING_FORMATS.has(normalized.format as string)
  ) {
    delete normalized.format
  }

  // `pattern` is the same PCRE-to-GBNF trap as `format`: any pattern that
  // uses `\d`, `\w`, or `\s` (extremely common in date/time/uuid regexes)
  // fails GBNF compilation. The model still has `type` and `description`.
  if (
    typeof normalized.pattern === 'string' &&
    PCRE_SHORTHAND.test(normalized.pattern as string)
  ) {
    delete normalized.pattern
  }

  return normalized
}

const LLAMACPP_BROKEN_STRING_FORMATS = new Set(['date', 'time', 'date-time'])
const PCRE_SHORTHAND = /\\[dDwWsS]/

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
 * Merge `b`'s parts onto `a`'s parts. When adjacent text parts meet at the
 * boundary, they're concatenated with a blank-line separator so the merged
 * message reads as one continuous turn rather than two.
 */
function mergeMessageParts(
  a: UIMessage['parts'],
  b: UIMessage['parts']
): UIMessage['parts'] {
  const aParts = Array.isArray(a) ? [...a] : []
  const bParts = Array.isArray(b) ? b : []
  for (const part of bParts) {
    const last = aParts[aParts.length - 1]
    if (
      last &&
      (last as { type?: string }).type === 'text' &&
      (part as { type?: string }).type === 'text' &&
      typeof (last as { text?: string }).text === 'string' &&
      typeof (part as { text?: string }).text === 'string'
    ) {
      aParts[aParts.length - 1] = {
        ...(last as object),
        text: `${(last as { text: string }).text}\n\n${(part as { text: string }).text}`,
      } as (typeof aParts)[number]
    } else {
      aParts.push(part)
    }
  }
  return aParts as UIMessage['parts']
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
 * 2. Merging any remaining adjacent user messages by concatenating their
 *    text parts and appending their non-text parts. This preserves all of
 *    the user's content — nothing is silently dropped.
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
    })
    if (!touched) return message
    return { ...message, parts: nextParts } as UIMessage
  })
}

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
      out[out.length - 1] = {
        ...prev,
        parts: mergeMessageParts(prev.parts, cur.parts),
      }
    } else {
      out.push(cur)
    }
  }
  return out
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

type ToolInputSchema = Record<string, unknown>

// Keep this behavior aligned with `normalize_openai_tool_parameters_schema` in Rust.
export function normalizeToolInputSchema(
  schema: ToolInputSchema
): ToolInputSchema {
  return normalizeToolInputSchemaValue(schema) as ToolInputSchema
}

/** Provider tool names must be non-empty strings; reject malformed discovery data. */
export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0
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
  /** A compaction this request made, announced on its reply's metadata. */
  private announcedCompaction: CompactionRecord | null = null
  /**
   * Set for the one resend after the provider refused a request for its
   * length: the request is compacted even though the local estimate said it
   * fitted, and plans against the window the refusal named when it named one.
   */
  private overflowRetry: { learnedWindow: number | null } | null = null
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
    const scoped = this.modelSelectionResolver?.()
    if (scoped) return scoped
    const { selectedProvider, selectedModel } = useModelProvider.getState()
    return { selectedProvider, selectedModel }
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
        useModelOverrides.getState().forThread(threadId)
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
    return [skillCatalogBlock()]
  }

  /**
   * Measure what this request carries by kind and hand it to the composer's
   * context circle. Never throws: a figure that cannot be worked out is a
   * missing figure, not a failed message.
   */
  protected publishContextBreakdown(
    systemPrompt: string | undefined,
    messages: UIMessage[]
  ): void {
    if (!this.threadId) return
    try {
      const memory = this.memorySelection
      useContextBreakdown.getState().set(
        this.threadId,
        buildContextBreakdown({
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
          messages,
        })
      )
    } catch {
      // Not measured this time.
    }
  }

  protected buildSystemPrompt(messages: UIMessage[]): string | undefined {
    const files = this.buildFilesSystemInstruction(messages)
    const web = this.buildWebSearchSystemInstruction()
    const agentTools = this.buildAgentToolsSystemInstruction()
    // Any tool, MCP included, returns outside content, and an MCP tool can act
    // on the world as readily as the agent tools can.
    const hasTools = Object.keys(this.tools ?? {}).length > 0
    const raw =
      [
        this.systemMessage,
        chatSafetyGuidelines({
          readsExternalContent: Boolean(files || web || agentTools || hasTools),
          canChangeThings: Boolean(agentTools || hasTools),
        }),
        files,
        web,
        agentTools,
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
   * part (or replaced by a note) for every provider, not only a local one. Off
   * for chat, where remote providers are left alone; Cowork turns it on for
   * the images its `read` tool returns.
   */
  protected hoistsToolImages(): boolean {
    return false
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
  protected async refreshMemory(): Promise<void> {
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
    if (!this.serviceHub) {
      this.tools = {}
      this.toolsCacheKey = null
      return
    }

    const toolsRecord: Record<string, Tool> = {}
    const toolServers = new Map<string, string>()

    // Tool availability is global (shared across all chats).
    const disabledToolKeys = useToolAvailable.getState().getDisabledTools()
    const isToolDisabled = (serverName: string, toolName: string): boolean => {
      const toolKey = `${serverName}::${toolName}`
      return disabledToolKeys.includes(toolKey)
    }

    const selectedModel = this.getModelSelection().selectedModel
    const modelSupportsTools = selectedModel?.capabilities?.includes('tools') ?? this.modelSupportsTools
    // Whether there are documents is read live, before the cache check: a
    // file attached to the thread's project mid-thread changes nothing else
    // in the key, and `this.hasDocuments` is only refreshed by the thread
    // view, so a key built from it kept the RAG tools away (#128).
    let hasDocuments = this.hasDocuments
    let ragFeatureAvailable = this.ragFeatureAvailable
    if (modelSupportsTools) {
      if (!hasDocuments && this.threadId) {
        const thread = useThreads.getState().threads[this.threadId]
        const hasThreadDocuments = Boolean(thread?.metadata?.hasDocuments)

        const projectId = thread?.metadata?.project?.id
        if (projectId) {
          try {
            const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
              ExtensionTypeEnum.VectorDB
            )
            if (ext?.listAttachmentsForProject) {
              const projectFiles = await ext.listAttachmentsForProject(projectId)
              hasDocuments = hasThreadDocuments || projectFiles.length > 0
            }
          } catch (error) {
            console.warn('Failed to check project files:', error)
            hasDocuments = hasThreadDocuments
          }
        } else {
          hasDocuments = hasThreadDocuments
        }
      }

      if (!ragFeatureAvailable) {
        ragFeatureAvailable = Boolean(useAttachments.getState().enabled)
      }
    }
    // The MCP tools that exist right now. Without it a server installed or
    // activated after the chat opened never reached the chat: every send
    // found the old key and kept the old tool list, so it took a new chat.
    const mcpNames: unknown = useAppState.getState?.()?.mcpToolNames
    const mcpFingerprint =
      mcpNames instanceof Set || Array.isArray(mcpNames)
        ? [...(mcpNames as Iterable<string>)].sort()
        : []
    const cacheKey = JSON.stringify({
      mcpFingerprint,
      // A server switched on after the chat began has no tools until it is
      // started, so the fingerprint alone cannot see it.
      mcpGeneration: getMcpGeneration(),
      mcpEnabled: enabledMcpServers(),
      model: selectedModel?.id ?? '',
      modelSupportsTools,
      hasDocuments,
      ragFeatureAvailable,
      disabledToolKeys,
      deadTools: deadTools(this.threadId),
      webSearchEnabled: useWebSearchConfig.getState().webSearchEnabled,
      agentToolsEnabled: useAgentToolsConfig.getState().agentToolsEnabled,
    })
    if (useCache && this.toolsCacheKey === cacheKey) return

    // Only load tools if model supports them
    if (modelSupportsTools) {
      // Load RAG tools if documents are available
      if (hasDocuments && ragFeatureAvailable) {
        try {
          const ragTools = await this.serviceHub.rag().getTools()
          if (Array.isArray(ragTools) && ragTools.length > 0) {
            // Convert RAG tools to AI SDK format, filtering out disabled tools
            ragTools.forEach((tool) => {
              if (!isValidToolName(tool.name)) return
              // RAG tools use MCPTool interface with server field
              const serverName =
                (tool as { server?: string }).server || 'unknown'
              if (!isToolDisabled(serverName, tool.name)) {
                toolsRecord[tool.name] = {
                  description: tool.description,
                  inputSchema: jsonSchema(
                    normalizeToolInputSchema(tool.inputSchema as Record<string, unknown>)
                  ),
                } as Tool
              }
            })
          }
        } catch (error) {
          console.warn('Failed to load RAG tools:', error)
        }
      }

      // Load MCP tools — route through the orchestrator when available so only
      // relevant servers are queried instead of all of them.
      try {
        const mcpService = this.serviceHub.mcp()
        let mcpTools: MCPTool[]
        let mcpStarting: string[] = []
        // Smart routing lists a subset; only a full listing may refresh the
        // store the tool picker and the call dispatcher read.
        let fullListing = false
        const mcpSettings = useMCPServers.getState().settings
        const routingEnabled = mcpSettings.enableSmartToolRouting

        if (
          routingEnabled &&
          mcpService.getToolsForServers &&
          mcpService.getServerSummaries
        ) {
          const summaries = await mcpService.getServerSummaries!()
          const routedSig = JSON.stringify({
            // Tool identities, not only server names: a server that gains
            // tools must re-route rather than keep the frozen subset.
            tools: mcpFingerprint,
            servers: summaries.map((s) => s.name).sort(),
            disabled: [...disabledToolKeys].sort(),
          })
          if (this.frozenRoutedTools && this.frozenRoutedSig === routedSig) {
            mcpTools = this.frozenRoutedTools
          } else {
            const routerModel =
              mcpSettings.useLightweightRouterModel &&
              mcpSettings.routerModelProvider.trim() &&
              mcpSettings.routerModelId.trim()
                ? (await this.resolveRouterModel(mcpSettings)) ?? this.model
                : this.model
            mcpTools = await mcpOrchestrator.getRelevantTools(
              this.lastUserMessage,
              {
                // The router decides from server summaries, then only the
                // servers it selects are started (on demand).
                getTools: () => mcpService.getTools({ start: true }),
                getToolsForServers: (names) =>
                  mcpService.getToolsForServers!(names, { start: true }),
                getServerSummaries: () => Promise.resolve(summaries),
              },
              disabledToolKeys,
              {
                routerModel,
                abortSignal,
              }
            )
            this.frozenRoutedTools = mcpTools
            this.frozenRoutedSig = routedSig
          }
        } else {
          // A send that uses tools starts enabled servers on demand, waiting
          // a bounded time for ones still starting.
          const live = await loadLiveMcpTools(mcpService)
          mcpTools = live.tools
          mcpStarting = live.starting
          fullListing = true
        }
        this.mcpStartingText = mcpStartingNote(mcpStarting)

        if (Array.isArray(mcpTools) && mcpTools.length > 0) {
          const seenBy = new Map<string, string>()
          mcpTools.forEach((tool) => {
            if (!isValidToolName(tool.name)) return
            const serverName = tool.server || 'unknown'
            if (isToolDisabled(serverName, tool.name)) return
            // A tool that approves the server's own held commands is never
            // offered: Flint's prompt is the only approval, and the model
            // looped on approve/execute pairs when it had one.
            if (isSelfApprovalTool(tool.name)) return
            const prevServer = seenBy.get(tool.name)
            if (prevServer && prevServer !== serverName) {
              console.warn(
                `[tools] MCP tool name collision: "${tool.name}" exposed by both "${prevServer}" and "${serverName}". Using "${serverName}".`
              )
            }
            seenBy.set(tool.name, serverName)
            toolServers.set(tool.name, serverName)
            toolsRecord[tool.name] = {
              description: tool.description,
              inputSchema: jsonSchema(
                normalizeToolInputSchema(tool.inputSchema as Record<string, unknown>)
              ),
            } as Tool
          })
        }
        this.recordMcpSet(
          [...toolServers].map(([name, server]) => ({ name, server })),
          fullListing ? mcpTools : undefined
        )
      } catch (error) {
        console.warn('Failed to load MCP tools:', error)
      }

      // Native web tools, provided by the websearch plugin (not an MCP server).
      // Advertised whenever the user has web search enabled.
      if (useWebSearchConfig.getState().webSearchEnabled) {
        toolsRecord['web_search'] = {
          description: WEB_SEARCH_DESCRIPTION,
          inputSchema: jsonSchema(WEB_SEARCH_INPUT_SCHEMA as Record<string, unknown>),
        } as Tool
        toolsRecord['web_fetch'] = {
          description: WEB_FETCH_DESCRIPTION,
          inputSchema: jsonSchema(WEB_FETCH_INPUT_SCHEMA as Record<string, unknown>),
        } as Tool
      }

      // Built-in agent tools (filesystem reads plus skills/memory), provided by
      // the agent-tools plugin. Schemas come from Rust so they are never
      // re-typed here.
      // Plugin state is Flint's own, not a workspace tool, so it is read and
      // `list_plugins` offered whether or not the agent tools are on: without
      // it a model asked "is <plugin> enabled?" goes digging through shells.
      // Read before the system prompt is assembled, which names the enabled
      // plugins from this cache.
      await refreshPluginInventory()
      await refreshSkillCatalog()
      if (!useAgentToolsConfig.getState().agentToolsEnabled) {
        try {
          const listPlugins = (await getAgentToolSchemas()).find(
            (s) => s.function?.name === 'list_plugins'
          )
          if (listPlugins) {
            toolsRecord.list_plugins = {
              description: listPlugins.function.description,
              inputSchema: jsonSchema(listPlugins.function.parameters),
            } as Tool
          }
        } catch (error) {
          console.warn('Failed to load list_plugins:', error)
        }
      }
      if (useAgentToolsConfig.getState().agentToolsEnabled) {
        try {
          for (const schema of await getAgentToolSchemas()) {
            if (!isValidToolName(schema.function?.name)) continue
            // Session-scope tools: a chat thread has no mailbox identity.
            if (SESSION_MESSAGING_TOOLS.has(schema.function.name)) continue
            toolsRecord[schema.function.name] = {
              description: schema.function.description,
              inputSchema: jsonSchema(schema.function.parameters),
            } as Tool
          }
        } catch (error) {
          console.warn('Failed to load agent tools:', error)
        }
      }
    }

    // A tool its server does not implement is no longer offered in this
    // conversation (transcript audit #11).
    for (const name of deadTools(this.threadId)) delete toolsRecord[name]
    // Sorted by name: the tool list is part of the prompt, and a server that
    // reconnects in a different order would otherwise change the prefix and
    // throw away the model's prompt cache.
    this.tools = Object.fromEntries(
      Object.entries(toolsRecord).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    )
    this.toolServers = toolServers
    this.toolsCacheKey = cacheKey
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
    const next = snapshotMcpTools(advertised)
    const key = this.threadId ?? ''
    const before = readMcpBaseline(key)
    let note = before?.note ?? null
    if (listed) syncMcpStore(listed)
    if (before) {
      const change = diffMcpSnapshots(before.snapshot, next)
      const changed = mcpChangeNote(change)
      if (changed) {
        note = changed
        announceMcpChange(change)
      }
    }
    writeMcpBaseline(key, next, note)
    this.mcpChangeText = note
  }

  protected mcpPromptNotes(): string[] {
    return [this.mcpChangeText, this.mcpStartingText].filter(
      (s): s is string => typeof s === 'string' && s.length > 0
    )
  }

  private async resolveRouterModel(settings: {
    useLightweightRouterModel: boolean
    routerModelProvider: string
    routerModelId: string
  }): Promise<LanguageModel | null> {
    if (!settings.useLightweightRouterModel) return null
    const providerName = settings.routerModelProvider.trim()
    const modelId = settings.routerModelId.trim()
    if (!providerName || !modelId) return null

    const key = `${providerName}::${modelId}`
    if (this.routerModel && this.routerModelKey === key) {
      return this.routerModel
    }

    const provider = useModelProvider.getState().getProviderByName(providerName)
    if (!provider) {
      console.warn(
        `[MCP] Router model provider '${providerName}' not found; using chat model for routing.`
      )
      return null
    }

    const catalogModel = provider.models.find((m) => m.id === modelId)
    if (!catalogModel || !isRouterModelSelectable(provider, catalogModel)) {
      console.warn(
        `[MCP] Router model '${key}' is not allowed for routing (use a lightweight model with API access); using chat model for routing.`
      )
      return null
    }

    try {
      const model = await ModelFactory.createModel(modelId, provider, {})
      this.routerModel = model
      this.routerModelKey = key
      return model
    } catch (error) {
      console.warn(
        `[MCP] Failed to create router model '${key}'; using chat model for routing.`,
        error
      )
      this.routerModel = null
      this.routerModelKey = ''
      return null
    }
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
    const modelPromise = ModelFactory.createModel(modelId, provider, {
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
    })
    if (!abortSignal) return modelPromise

    // Target lib is ES2021 here (see tsconfig.app.json), predating
    // Promise.withResolvers (ES2024), so the executor form is required.
    return new Promise<LanguageModel>((resolve, reject) => {
      const onAbort = () => {
        if (providerId === 'llamacpp') {
          // Call the plugin's unload command directly instead of through the
          // extension's `unload()` method: that method first looks up an
          // active *loaded* session and throws if none is found, but a
          // model aborted mid-load is still in the "loading" state (not
          // "loaded") and would never resolve to a session -- silently
          // skipping the unload and leaking the still-loading llama-server.
          // See https://github.com/janhq/jan/issues/8432.
          unloadLlamaModel(modelId).catch(() => {
            // Best-effort: model may not have started loading yet, or may
            // already have finished/failed on its own.
          })
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

  /**
   * Chat's automatic compaction (`lib/compaction.ts`).
   *
   * The summary in force is applied first: everything before its boundary is
   * replaced by it. When the request is still past the threshold of the
   * window, the older part is summarized again (the earlier summary folded
   * in) and the new boundary remembered, so the next request reuses it.
   */
  private async compactAtThreshold(
    threadId: string,
    messages: UIMessage[],
    opts: {
      window: number
      /** What the trimmer keeps free of the window; compaction starts before it acts. */
      trimReserveTokens?: number
      systemPromptTokens: number
      keepRecent: number
      summaryMaxTokens: number
      provider: string
      modelId: string
      session: string
      signal?: AbortSignal
      /** The provider refused the request for its length: compact regardless. */
      force?: boolean
    }
  ): Promise<UIMessage[]> {
    const inForce = readChatCompaction(threadId)
    const applied = applyChatCompaction(messages, inForce)
    const stale = applied.stale
    let history = applied.history
    // The boundary message was edited or deleted: the summary no longer
    // describes what precedes it.
    if (stale) {
      writeChatCompaction(threadId, null)
      cancelPrecompute(threadId)
    }

    const fullTrigger = compactionTriggerTokens(
      opts.window,
      opts.trimReserveTokens
    )
    // The next request grows by about what the last assistant turns did (tool
    // output rides in them), so compact before that growth crosses the window
    // rather than after. At most a tenth of the window, so a compaction that
    // keeps a large recent turn cannot leave the request still over the trigger.
    const recentAssistant = history
      .filter((m) => m.role === 'assistant')
      .slice(-4)
      .map((m) => estimateHistoryTokens([m]))
    const headroom = Math.min(
      Math.floor(opts.window * 0.1),
      Math.ceil(Math.max(0, ...recentAssistant) * 1.25)
    )
    let trigger = Math.max(
      Math.floor(opts.window * 0.1),
      fullTrigger - headroom
    )
    let projected = opts.systemPromptTokens + estimateHistoryTokens(history)
    // The provider just refused this request: whatever the estimate says, it
    // did not fit, so aim well under what it measured.
    const forced = opts.force === true
    if (forced) trigger = Math.min(trigger, Math.floor(projected * 0.6))
    if (!forced && projected < trigger) {
      if (projected >= trigger * PRECOMPUTE_FRACTION) {
        // When clearing old tool output alone will keep the request well under
        // the trigger, the summary would never be used: don't write it.
        const afterClearing =
          opts.systemPromptTokens +
          estimateHistoryTokens(clearStaleToolResults(history).messages)
        if (afterClearing >= trigger * PRECOMPUTE_FRACTION) {
          this.precomputeSummary(threadId, history, opts)
        }
      }
      return history
    }

    // Old tool output is the cheapest thing to give up: clear it first and
    // summarize only if the request is still over.
    const cleared = clearStaleToolResults(history)
    if (cleared.clearedCount > 0) {
      history = cleared.messages
      projected = opts.systemPromptTokens + estimateHistoryTokens(history)
      if (projected < trigger) return history
    }

    // A conversation that refills right after a compaction is not helped by
    // the same compaction again, so it starts at a harder cut instead of
    // stopping: more of the recent turns, then the middle of the current one,
    // are folded.
    const looping = !forced && isCompactionLooping(threadId, history.length)
    const result = await this.compactToFit(threadId, history, {
      ...opts,
      trigger,
      reason: forced ? 'context-error' : 'threshold',
      startLevel: looping ? 1 : 0,
    })
    let out = result?.messages ?? history
    // What no summary can shrink is the newest thing in the conversation: a
    // single tool result that alone fills the window. It keeps its head and
    // tail and loses the middle, rather than the request being refused.
    const ceiling = Math.floor(
      (opts.window - (opts.trimReserveTokens ?? 0)) * TRIM_HEADROOM_SHARE
    )
    const room = Math.max(
      1000,
      (forced ? Math.min(ceiling, trigger) : ceiling) - opts.systemPromptTokens
    )
    let clippedCount = 0
    if (estimateHistoryTokens(out) > room) {
      const clipped = clipToolResultsToFit(out, room)
      out = clipped.messages
      clippedCount = clipped.clippedCount
    }
    if (!result && clippedCount === 0) {
      // Nothing could be folded or shrunk and the breaker had already seen
      // this loop: say so rather than send a request that will be refused.
      if (looping) throw new CompactionLoopError()
      return history
    }
    // Still over the window itself after every cut: the refill loop is real.
    if (
      looping &&
      opts.systemPromptTokens + estimateHistoryTokens(out) >= opts.window
    ) {
      throw new CompactionLoopError()
    }
    if (result) {
      recordCompaction(threadId, history.length, result.messages.length)
      this.announcedCompaction = result.record
    }
    return out
  }

  /**
   * Compact until the request is under `trigger`, cutting harder each time it
   * is not: the configured share of recent turns, then half of it with the cut
   * allowed inside the current user turn (a long tool loop is one turn), then
   * only the newest message. A cut whose kept part alone is over is skipped
   * without a model call. Null when nothing could be folded.
   */
  private async compactToFit(
    threadId: string,
    history: UIMessage[],
    opts: {
      window: number
      systemPromptTokens: number
      keepRecent: number
      summaryMaxTokens: number
      provider: string
      modelId: string
      session: string
      signal?: AbortSignal
      trigger: number
      reason: CompactionRecord['reason']
      startLevel: number
    }
  ): Promise<CompactResult | null> {
    const levels = [
      { keepRecent: opts.keepRecent, splitTurn: false },
      {
        keepRecent: Math.max(2, Math.floor(opts.keepRecent / 2)),
        splitTurn: true,
      },
      { keepRecent: 1, splitTurn: true },
    ]
    // What the summary itself will add to the request.
    const summaryAllowance = opts.summaryMaxTokens + 200
    let current = history
    let last: CompactResult | null = null
    for (
      let i = Math.min(opts.startLevel, levels.length - 1);
      i < levels.length;
      i++
    ) {
      const level = levels[i]
      const isLast = i === levels.length - 1
      const plan = planCompaction(current, level)
      if (!plan) continue
      // Summarizing everything older cannot make this cut fit when what it
      // keeps is already over: cut deeper instead of paying for a summary
      // that would not help. The deepest cut always runs; what it keeps is
      // then shrunk by the caller.
      const kept =
        opts.systemPromptTokens +
        estimateHistoryTokens([...plan.pinned, ...plan.keep]) +
        summaryAllowance
      if (kept >= opts.trigger && !isLast) continue
      const result = await this.runCompaction(threadId, current, {
        window: opts.window,
        keepRecent: level.keepRecent,
        splitTurn: level.splitTurn,
        summaryMaxTokens: opts.summaryMaxTokens,
        provider: opts.provider,
        modelId: opts.modelId,
        session: opts.session,
        reason: opts.reason,
        signal: opts.signal,
      })
      if (!result) continue
      last = result
      current = result.messages
      if (
        opts.systemPromptTokens + estimateHistoryTokens(current) <
        opts.trigger
      ) {
        break
      }
    }
    return last
  }

  /** Start the summary a coming compaction will need, without waiting for it. */
  private precomputeSummary(
    threadId: string,
    history: UIMessage[],
    opts: {
      window: number
      keepRecent: number
      summaryMaxTokens: number
      provider: string
      modelId: string
      session: string
    }
  ): void {
    const plan = planCompaction(history, { keepRecent: opts.keepRecent })
    if (!plan) return
    startPrecompute(
      threadId,
      plan.summarize,
      modelSummarizer({
        provider: opts.provider,
        modelId: opts.modelId,
        session: opts.session,
        maxOutputTokens: opts.summaryMaxTokens,
        window: opts.window,
        model: () => this.model,
      })
    )
  }

  /** Compact, keep the result with the thread, and record it. */
  private async runCompaction(
    threadId: string,
    history: UIMessage[],
    opts: {
      window: number | null
      keepRecent: number
      splitTurn?: boolean
      summaryMaxTokens: number
      provider: string
      modelId: string
      session: string
      reason: CompactionRecord['reason']
      signal?: AbortSignal
    }
  ) {
    const result = await compactHistory(history, {
      summarize: modelSummarizer({
        provider: opts.provider,
        modelId: opts.modelId,
        session: opts.session,
        maxOutputTokens: opts.summaryMaxTokens,
        window: opts.window,
        model: () => this.model,
      }),
      keepRecent: opts.keepRecent,
      splitTurn: opts.splitTurn,
      reason: opts.reason,
      signal: opts.signal,
      reusePrefix: (covered) => takePrecomputedPrefix(threadId, covered),
    })
    cancelPrecompute(threadId)
    if (!result) return null
    // Kept with the thread, so a restart reuses it rather than summarizing
    // the same messages again.
    const state = stateAfter(result.messages, result.record, result.latestRequest)
    if (state) writeChatCompaction(threadId, state)
    // A compaction changes what the model sees from here on, so it is part of
    // what the conversation did and goes in its record.
    void recordLifecycle(
      { session: opts.session, run: '', source: 'chat' },
      {
        id: `compaction:${result.record.at}`,
        lifecycle: 'compaction',
        phase: 'succeeded',
        summary: `Compacted ${result.record.summarizedCount} messages into a summary`,
      }
    )
    return result
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
    signal?: AbortSignal
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
   * Sends on the chosen model; if that fails to answer for a reason another
   * model could fix (see `shouldFallback`) before any reply content, the same
   * turn is retried on the next model of the fallback chain.
   */
  async sendMessages(
    options: SendOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    // Cowork compacts and retries in its own run loop.
    if (!this.compactsAtThreshold) return this.sendWithFallback(options)

    // The provider refusing a request for its length is not the end of a run
    // the window could still hold: compact, harder than the estimate asked
    // for, and send it once more. Only before any reply content, so nothing
    // the chat already showed is taken back.
    const refusedForLength = async (failure: unknown): Promise<boolean> => {
      const message =
        failure instanceof Error ? failure.message : String(failure ?? '')
      return (
        !options.abortSignal?.aborted &&
        (isContextLengthError(failure) || isContextOverflowMessage(message)) &&
        (await this.canRecoverFromOverflow())
      )
    }
    const resend = async (
      failure: unknown
    ): Promise<ReadableStream<UIMessageChunk>> => {
      const message =
        failure instanceof Error ? failure.message : String(failure ?? '')
      const learned = parseServerContextLimit(
        (failure as { data?: unknown } | null)?.data ?? null,
        message
      )
      this.overflowRetry = { learnedWindow: learned?.contextTokens ?? null }
      try {
        return await this.sendWithFallback(options)
      } finally {
        this.overflowRetry = null
      }
    }

    let first: ReadableStream<UIMessageChunk>
    try {
      first = await this.sendWithFallback(options)
    } catch (error) {
      if (!(await refusedForLength(error))) throw error
      first = await resend(error)
      return first
    }

    let source = first.getReader()
    let retried = false
    // Chunks pass straight through. An error before any reply content that is
    // a length refusal is swallowed instead, and the resent request's stream
    // continues in its place (its opening chunks were already delivered).
    let sawContent = false
    let sentStart = false
    let sentStep = false
    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        for (;;) {
          const { done, value } = await source.read()
          if (done) {
            controller.close()
            return
          }
          if (
            !sawContent &&
            !retried &&
            value.type === 'error' &&
            (await refusedForLength(value.errorText))
          ) {
            retried = true
            void source.cancel().catch(() => {})
            try {
              source = (await resend(value.errorText)).getReader()
            } catch (error) {
              controller.error(error)
              return
            }
            continue
          }
          if (retried && value.type === 'start' && sentStart) {
            // Already delivered; its metadata (a compaction the resend made)
            // still has to reach the message.
            const metadata = (value as { messageMetadata?: unknown })
              .messageMetadata
            if (metadata === undefined) continue
            controller.enqueue({
              type: 'message-metadata',
              messageMetadata: metadata,
            } as UIMessageChunk)
            return
          }
          if (retried && value.type === 'start-step' && sentStep) continue
          if (value.type === 'start') sentStart = true
          if (value.type === 'start-step') sentStep = true
          if (!/^(start|start-step|message-metadata)$/.test(value.type)) {
            sawContent = true
          }
          controller.enqueue(value)
          return
        }
      },
      cancel: (reason) => source.cancel(reason),
    })
  }

  /**
   * Whether a request the provider refused for its length can be compacted
   * and sent again: automatic compaction is on, by summary, and the model does
   * not shift its own context.
   */
  private async canRecoverFromOverflow(): Promise<boolean> {
    try {
      const params = this.getActiveInferenceParams()
      const policy = await getCompactionPolicy()
      return (
        resolveAutoCompact(params, policy.auto) && policy.strategy === 'summarize'
      )
    } catch {
      return false
    }
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

  protected async sendOnce(
    options: SendOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    const threadId = this.threadId ?? options.chatId
    const myGeneration = ++this.streamGeneration
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
        useModelOverrides.getState().forThread(threadId)
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
      const mergedParams: Record<string, unknown> = {
        ...modelSamplingDefaults,
        ...(inferenceParams ?? {}),
        ...reasoningParams,
      }
      if (isPredefinedRemoteProvider(effectiveProviderName)) {
        for (const key of Object.keys(paramsSettings)) delete mergedParams[key]
      }
      // A remote OpenAI-compatible reasoning model takes its effort as a
      // `reasoning_effort` body field. Unlike the first-party providers (which
      // go through the AI SDK's native providerOptions below), this reaches the
      // server through the request body, so it is merged in here — after the
      // sampling-param strip above, since it is not one of those params.
      // `selectedModel` is already resolved with this chat's overrides (above),
      // so a per-chat effort applies. See `buildReasoningBodyParams`.
      const reasoningBodyParams = buildReasoningBodyParams(
        providerId,
        selectedModel
      )
      if (reasoningBodyParams) Object.assign(mergedParams, reasoningBodyParams)
      // Pin chat to the chat slot so llama-server reuses this thread's cached
      // KV prefix across turns; background tasks use BACKGROUND_SLOT_ID and
      // can't evict it.
      //
      // thread_id names whose cache that is, which is what lets the engine
      // park it when another thread takes the slot and pick it back up later,
      // including in a later session. It is stripped before the request
      // reaches llama.cpp.
      if (providerId === 'llamacpp') {
        Object.assign(mergedParams, this.slotParams(threadId))
      }
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
      useAppState.getState().updateLoadingModel(false)
      useAppState.getState().updateThreadLoadingModel(threadId, false)
      useAppState.getState().updateModelLoadProgress(undefined)
      useAppState.getState().updateThreadModelLoadProgress(threadId, undefined)
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

    await this.refreshMemory()
    const effectiveSystem = this.buildSystemPrompt(messagesToConvert)
    this.publishContextBreakdown(effectiveSystem, messagesToConvert)

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
    const contextShiftEnabled =
      providerId === 'llamacpp' &&
      provider.settings?.some(
        (setting) =>
          setting.key === 'ctx_shift' &&
          setting.controller_props?.value === true
      ) === true
    let liveContextTokens: number | undefined
    if (contextShiftEnabled) {
      try {
        liveContextTokens = (
          await getLlamacppExtension()?.getModelProps?.(modelId)
        )?.nCtx
      } catch {
        // The router has not loaded the model yet. Preserve the configured limit.
      }
    }
    const knownContextTokens = effectiveContextWindow(
      configuredContextTokens,
      liveContextTokens,
      contextShiftEnabled
    )
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

    let effectiveMessages = messagesToConvert
    if (maxContextTokens > 0) {
      const contextConfig: ContextManagerConfig = {
        maxContextTokens,
        // The reserve is headroom kept free; a model's own output cap, when
        // larger, still wins.
        maxOutputTokens: outputHeadroom(maxContextTokens, maxOutputTokens ?? 2048, compaction),
        autoCompact: !!autoCompact,
      }

      // Context Shift only shifts llama.cpp's KV cache after generation starts.
      // Keep the submitted chat history under the live router context window first.
      const systemPromptTokens = effectiveSystem
        ? estimateTokens(effectiveSystem) + 4
        : 0
      this.announcedCompaction = this.carriedCompaction
      if (
        autoCompact &&
        compaction.strategy === 'summarize' &&
        !contextShiftEnabled &&
        this.compactsAtThreshold
      ) {
        effectiveMessages = await this.compactAtThreshold(
          threadId,
          messagesToConvert,
          {
            window: maxContextTokens,
            trimReserveTokens:
              contextConfig.maxOutputTokens +
              contextSafetyMargin(maxContextTokens),
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
    if (acceptsSystemRole(providerId, selectedModel)) {
      const folded = foldSummaryIntoSystem(requestSystem, effectiveMessages)
      requestSystem = folded.system
      effectiveMessages = folded.messages
    }

    const modelSupportsVision =
      selectedModel?.capabilities?.includes('vision') ?? false
    let withInlineAttachments = this.mapUserInlineAttachments(effectiveMessages)
    // A model that cannot see gets a written description of each image, made by
    // one that can, in the image's place. With no such model (or the feature
    // off) the images are stripped below, as before.
    if (!modelSupportsVision) {
      const describer = currentDescriber()
      if (describer) {
        withInlineAttachments = await describeImagesInMessages(
          withInlineAttachments,
          describer,
          { session: threadId, signal: options.abortSignal }
        )
      }
    }
    // A local model reads a tool result as text, so an image in one (an MCP
    // screenshot tool) would arrive as its full base64 and flood the context.
    // The image is swapped for a note and, for a model that can see, attached
    // again as an image. Remote providers have the room and are left alone.
    // llama.cpp cannot decode WebP, so a WebP image goes to it as PNG.
    const attachmentsReady = LOCAL_ENGINE_PROVIDERS.has(providerId ?? '')
      ? await transcodeWebpImages(
          prepareToolResultImagesForModel(withInlineAttachments, {
            supportsVision: modelSupportsVision,
          })
        )
      : this.hoistsToolImages() || hasAgentToolImages(withInlineAttachments)
        ? prepareToolResultImagesForModel(withInlineAttachments, {
            supportsVision: modelSupportsVision,
          })
        : withInlineAttachments
    const baseMessages = await convertToModelMessages(
      coalesceMessagesForAlternation(
        resolveOrphanToolCalls(
          this.encodeVideoAttachments(
            this.encodeAudioAttachments(
              stripUnsupportedImageParts(attachmentsReady, modelSupportsVision)
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

    // Include tools only if we have tools loaded AND model supports them
    const hasTools = Object.keys(this.tools).length > 0
    const modelSupportsTools = selectedModel?.capabilities?.includes('tools') ?? this.modelSupportsTools
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
    useAppState.getState().updatePromptProgress(undefined)
    useAppState.getState().updateThreadPromptProgress(threadId, undefined)
    useAppState.getState().updateLiveTokenStats(undefined)
    useAppState.getState().updateThreadLiveTokenStats(threadId, undefined)

    const result = streamText({
      model: this.model,
      messages: modelMessages,
      abortSignal: options.abortSignal,
      tools: shouldEnableTools ? this.tools : undefined,
      toolChoice: shouldEnableTools ? this.toolChoiceForStep() : undefined,
      system: requestSystem,
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
      ...(reasoningProviderOptions
        ? { providerOptions: reasoningProviderOptions }
        : {}),
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
          return compacted || answering
            ? {
                ...(attribution ?? {}),
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
          const durationMs = streamStartTime ? Date.now() - streamStartTime : 0
          const durationSec = durationMs / 1000

          // Only for the speed figure; the stored usage keeps an unreported
          // count unreported rather than zero.
          const outputTokens = usage.outputTokens ?? 0

          // Use llama.cpp's tokens per second if available, otherwise calculate from duration
          let tokenSpeed: number
          if (durationSec > 0 && outputTokens > 0) {
            tokenSpeed =
              tokensPerSecond > 0 ? tokensPerSecond : outputTokens / durationSec
          } else {
            tokenSpeed = 0
          }
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
              outputTokens
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
              tokenSpeed: Math.round(tokenSpeed * 100) / 100,
              promptSpeed: promptPerSecond
                ? Math.round(promptPerSecond * 100) / 100
                : undefined,
              tokenCount: outputTokens,
              durationMs,
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
    const finalStream = continueContent
      ? prependContinuationToUIStream(uiStream, continueContent)
      : uiStream

    return finalStream
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

  // Replace audio `file` parts on user messages with sentinel-bearing `text`
  // parts. The `@ai-sdk/openai-compatible` provider rejects non-image file
  // parts in its converter; the matching fetch wrapper in model-factory.ts
  // decodes these sentinels back into OpenAI `input_audio` content parts on
  // the outgoing wire, which llama-server's chat-completions endpoint accepts.
  encodeAudioAttachments(messages: UIMessage[]): UIMessage[] {
    return messages.map((message) => {
      if (message.role !== 'user' || !Array.isArray(message.parts)) return message
      let touched = false
      const nextParts = message.parts.map((part) => {
        if (
          part?.type === 'file' &&
          typeof (part as { mediaType?: string }).mediaType === 'string' &&
          (part as { mediaType: string }).mediaType.startsWith('audio/') &&
          typeof (part as { url?: string }).url === 'string'
        ) {
          const parsed = parseAudioDataUrl((part as { url: string }).url)
          if (!parsed) return part
          touched = true
          return { type: 'text' as const, text: encodeAudioSentinel(parsed.format, parsed.data) }
        }
        return part
      })
      if (!touched) return message
      return { ...message, parts: nextParts } as UIMessage
    })
  }

  // Replace video `file` parts on user messages with sentinel-bearing `text`
  // parts, same mechanism as encodeAudioAttachments. The fetch wrapper in
  // model-factory.ts decodes these into llama-server `input_video` content
  // parts (frames decoded via the vision encoder + ffmpeg on the server).
  encodeVideoAttachments(messages: UIMessage[]): UIMessage[] {
    return messages.map((message) => {
      if (message.role !== 'user' || !Array.isArray(message.parts)) return message
      let touched = false
      const nextParts = message.parts.map((part) => {
        if (
          part?.type === 'file' &&
          typeof (part as { mediaType?: string }).mediaType === 'string' &&
          (part as { mediaType: string }).mediaType.startsWith('video/') &&
          typeof (part as { url?: string }).url === 'string'
        ) {
          const parsed = parseVideoDataUrl((part as { url: string }).url)
          if (!parsed) return part
          touched = true
          return { type: 'text' as const, text: encodeVideoSentinel(parsed.data) }
        }
        return part
      })
      if (!touched) return message
      return { ...message, parts: nextParts } as UIMessage
    })
  }

  /**
   * [ATTACHED_FILES] blocks stay on the user message that carries them (see
   * fileMetadata.ts injectFilesIntoPrompt) so the model reads file_ids in the
   * turn they belong to. Only a static, file-independent instruction is added
   * to the system prompt - it never varies per attachment, so it doesn't
   * defeat prompt caching.
   */
  buildFilesSystemInstruction(messages: UIMessage[]): string {
    const hasAttachedFiles = messages.some(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.parts) &&
        message.parts.some(
          (part) =>
            part?.type === 'text' &&
            typeof (part as { text?: string }).text === 'string' &&
            (part as { text: string }).text.includes('[ATTACHED_FILES]')
        )
    )
    if (!hasAttachedFiles) return ''
    return [
      'Some user messages contain an [ATTACHED_FILES] block listing files',
      'attached to that turn (file_id, name, type, size, chunk count, mode).',
      'Use the available retrieval tools with those file_ids when their',
      'contents are relevant to the request.',
    ].join(' ')
  }

  /**
   * Static instruction teaching the model to use the native web tools and cite
   * sources inline with [[cite:URL]] markers (rendered as favicon chips). Only
   * added when web search is enabled so it doesn't affect prompt caching for
   * users who keep it off.
   */
  buildWebSearchSystemInstruction(): string {
    if (!useWebSearchConfig.getState().webSearchEnabled) return ''
    return [
      '# Web Access',
      'You can search the web with web_search and read pages with web_fetch.',
      'Use them whenever the request needs current, external, or verifiable',
      'information, then base your answer on what you find. When a statement',
      'relies on a web source, cite it inline immediately after that statement',
      'using the exact marker [[cite:URL]], where URL is the full source URL',
      'from a web_search result (for example: [[cite:https://example.com/page]]).',
      'Cite each distinct source you rely on; do not add a separate references',
      'or sources section.',
    ].join(' ')
  }

  /**
   * Static instruction describing the isolated agent workspace the built-in
   * tools operate in. Only added when the toolset is enabled so it doesn't
   * affect prompt caching for users who keep it off.
   */
  buildAgentToolsSystemInstruction(): string {
    if (!useAgentToolsConfig.getState().agentToolsEnabled) return ''
    const parts = [
      '# Workspace',
      'read, ls, find, grep, write and edit operate on an isolated agent',
      "workspace, not the user's whole filesystem. Paths are relative to that",
      'workspace root and cannot escape it. The workspace is scratch space for',
      'this conversation only and is deleted with it, so do not keep anything',
      'there that should last. Use memory_write to persist facts worth remembering',
      'across conversations, and memory_list/memory_read to recall them. Skills',
      'are reusable instructions: list and read them before a task they cover,',
      'and record a repeatable procedure with skill_write.',
    ]
    // Folders the user attached to this chat (directly or from its group):
    // passed to the tools read-only, as Cowork passes its extra folders.
    const folders = this.threadId
      ? chatFoldersOf(useThreads.getState().threads[this.threadId])
      : []
    if (folders.length > 0) {
      parts.push(
        'The user attached these folders to this chat:',
        ...folders.map((folder) => `- \`${folder}\``),
        'They are READ-ONLY: read, search and list inside them, but writes there will',
        'be refused. Use absolute paths for them.'
      )
    }
    const skills = skillCatalogBlock()
    if (skills) parts.push('', skills, '')
    // Stating the limits up front is cheaper than letting the model discover
    // them by having a command refused. Only when bash is actually offered.
    parts.push(SHELL_ROUTING_GUIDANCE)
    if (sandboxEnforces()) {
      parts.push(
        'bash runs commands in that workspace under an OS sandbox: it starts',
        'there, can only write there, and cannot read files in the',
        "user's home directory."
      )
      parts.push(
        'This limit applies only to these built-in tools. For a location outside',
        'the workspace, use a configured filesystem MCP tool when its allowed',
        'directories include that location. Tool approval approves a call; it',
        'does not expand a tool\'s filesystem roots. Do not report an MCP path',
        'as denied until that MCP tool returns its own error.'
      )
      parts.push(
        'When a file or folder outside the workspace is needed and a tool was',
        'refused for it, call request_access with the narrowest absolute path and',
        'a one-sentence reason (access_mode "write" when you must create or change',
        'files there, e.g. after a write or "Access is denied" failure); the user',
        'decides. Ask instead of reporting the folder as read-only. If it is granted, retry the',
        'refused call. If it is denied, do not ask again for that path: offer',
        'another way (the user pastes or attaches it, or another source).'
      )
      parts.push(
        useAgentToolsConfig.getState().bashNetworkEnabled
          ? 'It has network access.'
          : 'It has no network access, so commands that download or upload will fail.'
      )
      parts.push(
        'git and Git Bash cannot run inside the bash sandbox. For all Git and',
        'GitHub work (status, commit, branch, push, pull requests, clone) call the',
        'git tool, which runs the real git and gh outside the sandbox and asks the',
        'user before anything changes or reaches a remote. Never use an MCP shell',
        'or terminal tool for git: it bypasses that approval. If a GitHub URL names',
        'only a user or organization and no repository, ask the user which',
        'repository to clone before cloning.'
      )
    }
    return parts.join(' ')
  }

  mapUserInlineAttachments(messages: UIMessage[]): UIMessage[] {
    return messages.map((message) => {
      if (message.role === 'user') {
        const metadata = message.metadata as
          | {
              inline_file_contents?: Array<{ name?: string; content?: string }>
            }
          | undefined
        const inlineFileContents = Array.isArray(metadata?.inline_file_contents)
          ? metadata.inline_file_contents.filter((f) => f?.content)
          : []
        // Tool messages have content as array of ToolResultPart
        if (inlineFileContents.length > 0) {
          const buildInlineText = (base: string) => {
            if (!inlineFileContents.length) return base
            const formatted = inlineFileContents
              .map((f) => `File: ${f.name || 'attachment'}\n${f.content ?? ''}`)
              .join('\n\n')
            return base ? `${base}\n\n${formatted}` : formatted
          }

          if (message.parts.length > 0) {
            // Return a fresh message with fresh text parts rather than
            // overwriting `message.parts` in place. Mutating the input would
            // both leak into the persisted transcript and, on a second mapping
            // of the same array, append the inline content a second time
            // (jan#9022). Non-text parts and metadata are carried over by
            // reference without being touched.
            const parts = message.parts.map((part) => {
              if (part.type === 'text') {
                return {
                  type: 'text' as const,
                  text: buildInlineText(part.text ?? ''),
                }
              }
              return part
            })
            return { ...message, parts }
          }
        }
      }

      return message
    })
  }
}
