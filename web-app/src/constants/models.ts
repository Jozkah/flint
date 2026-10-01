/**
 * Model-related constants
 */

export const JAN_CODE_HF_REPO = 'janhq/Jan-Code-4b-Gguf'
export const DEFAULT_MODEL_QUANTIZATIONS = ['iq4_xs', 'q4_k_m']

/**
 * Quantizations to check for SetupScreen quick start
 * Includes Q8 for higher quality on capable systems
 */
export const SETUP_SCREEN_QUANTIZATIONS = ['q4_k_xl']

export const JAN_V2_VL_MODEL_HF_REPO = 'janhq/Jan-v2-VL-high-gguf'
export const JAN_V2_VL_QUANTIZATIONS = ['q4_k_m', 'q4_k_s', 'q4_0', 'q3_k_m']

/**
 * The first model of a provider is the default for a new chat, so it is the
 * balanced one (speed, price and intelligence), then the rest from newest. Each provider's own docs are the source
 * of truth; a provider with a live `/models` endpoint can still refresh the
 * list from the Providers settings.
 */
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6']
const OPENAI_MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5', 'gpt-5-mini']
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash']

/**
 * Provider model capabilities - copied from token.js package
 */
export const providerModels = {
  openai: {
    models: OPENAI_MODELS,
    supportsCompletion: true,
    supportsStreaming: OPENAI_MODELS,
    supportsJSON: OPENAI_MODELS,
    supportsImages: OPENAI_MODELS,
    supportsToolCalls: OPENAI_MODELS,
    supportsN: true,
  },
  ai21: {
    models: ['jamba-instruct'],
    supportsCompletion: true,
    supportsStreaming: ['jamba-instruct'],
    supportsJSON: [],
    supportsImages: [],
    supportsToolCalls: [],
    supportsN: true,
  },
  anthropic: {
    models: ANTHROPIC_MODELS,
    supportsCompletion: true,
    supportsStreaming: ANTHROPIC_MODELS,
    supportsJSON: [],
    supportsImages: ANTHROPIC_MODELS,
    supportsToolCalls: ANTHROPIC_MODELS,
    supportsN: true,
  },
  gemini: {
    models: GEMINI_MODELS,
    supportsCompletion: true,
    supportsStreaming: GEMINI_MODELS,
    supportsJSON: GEMINI_MODELS,
    supportsImages: GEMINI_MODELS,
    supportsToolCalls: GEMINI_MODELS,
    supportsN: true,
  },
  cohere: {
    models: ['command-a-plus-05-2026', 'command-a-03-2025', 'command-a-reasoning-08-2025', 'command-a-vision-07-2025', 'command-r7b-12-2024', 'command-r-08-2024', 'command-r-plus-08-2024'],
    supportsCompletion: true,
    supportsStreaming: ['command-a-plus-05-2026', 'command-a-03-2025', 'command-a-reasoning-08-2025', 'command-a-vision-07-2025', 'command-r7b-12-2024', 'command-r-08-2024', 'command-r-plus-08-2024'],
    supportsJSON: [],
    supportsImages: ['command-a-plus-05-2026', 'command-a-vision-07-2025'],
    supportsToolCalls: ['command-a-plus-05-2026', 'command-a-03-2025', 'command-a-reasoning-08-2025', 'command-r7b-12-2024', 'command-r-08-2024', 'command-r-plus-08-2024'],
    supportsN: true,
  },
  bedrock: {
    models: ['anthropic.claude-fable-5-1', 'anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5', 'anthropic.claude-haiku-4-5', 'cohere.command-r-plus-v1:0', 'cohere.command-r-v1:0', 'meta.llama3-70b-instruct-v1:0', 'meta.llama3-8b-instruct-v1:0', 'mistral.mistral-large-2402-v1:0', 'amazon.titan-text-express-v1'],
    supportsCompletion: true,
    supportsStreaming: ['anthropic.claude-fable-5-1', 'anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5', 'anthropic.claude-haiku-4-5', 'cohere.command-r-plus-v1:0', 'cohere.command-r-v1:0', 'meta.llama3-70b-instruct-v1:0', 'meta.llama3-8b-instruct-v1:0', 'mistral.mistral-large-2402-v1:0', 'amazon.titan-text-express-v1'],
    supportsJSON: [],
    supportsImages: ['anthropic.claude-fable-5-1', 'anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5', 'anthropic.claude-haiku-4-5'],
    supportsToolCalls: ['anthropic.claude-fable-5-1', 'anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5', 'anthropic.claude-haiku-4-5', 'cohere.command-r-plus-v1:0', 'cohere.command-r-v1:0', 'mistral.mistral-large-2402-v1:0'],
    supportsN: true,
  },
  mistral: {
    models: ['mistral-medium-3-5-26-04', 'mistral-small-4-0-26-03', 'mistral-large-3-25-12', 'ministral-3-14b-25-12', 'ministral-3-8b-25-12', 'ministral-3-3b-25-12', 'codestral-2508', 'mistral-medium-latest', 'mistral-small-latest'],
    supportsCompletion: true,
    supportsStreaming: ['mistral-medium-3-5-26-04', 'mistral-small-4-0-26-03', 'mistral-large-3-25-12', 'ministral-3-14b-25-12', 'ministral-3-8b-25-12', 'ministral-3-3b-25-12', 'codestral-2508', 'mistral-medium-latest', 'mistral-small-latest'],
    supportsJSON: ['mistral-medium-3-5-26-04', 'mistral-small-4-0-26-03', 'mistral-large-3-25-12', 'codestral-2508'],
    supportsImages: ['mistral-medium-3-5-26-04', 'mistral-large-3-25-12', 'ministral-3-14b-25-12', 'ministral-3-8b-25-12', 'ministral-3-3b-25-12', 'mistral-medium-latest', 'mistral-small-latest'],
    supportsToolCalls: ['mistral-medium-3-5-26-04', 'mistral-small-4-0-26-03', 'mistral-large-3-25-12', 'ministral-3-14b-25-12', 'ministral-3-8b-25-12', 'ministral-3-3b-25-12', 'codestral-2508', 'mistral-medium-latest', 'mistral-small-latest'],
    supportsN: true,
  },
  groq: {
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'moonshotai/kimi-k2-instruct-0905', 'whisper-large-v3-turbo'],
    supportsCompletion: true,
    supportsStreaming: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'moonshotai/kimi-k2-instruct-0905'],
    supportsJSON: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    supportsImages: ['meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    supportsToolCalls: [],
    supportsN: true,
  },
  xai: {
    models: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-imagine-image'],
    supportsCompletion: true,
    supportsStreaming: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning'],
    supportsJSON: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning'],
    supportsImages: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning'],
    supportsToolCalls: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning'],
    supportsN: true,
  },
  perplexity: {
    models: ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'],
    supportsCompletion: true,
    supportsStreaming: ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'],
    supportsJSON: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    supportsImages: [],
    supportsToolCalls: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    supportsN: true,
  },
  minimax: {
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    supportsCompletion: true,
    supportsStreaming: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    supportsJSON: [],
    supportsImages: [],
    supportsToolCalls: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    supportsN: true,
  },
  openrouter: {
    models: true,
    supportsCompletion: true,
    supportsStreaming: true,
    supportsJSON: true,
    supportsImages: true,
    supportsToolCalls: true,
    supportsN: true,
  },
  nvidia: {
    models: ['deepseek/deepseek-v4.1-flash', 'google/gemma-4-31b-it', 'moonshotai/kimi-k2.5', 'minimaxai/minimax-m2.5', 'z-ai/glm5'],
    supportsCompletion: true,
    supportsStreaming: true,
    supportsJSON: true,
    supportsImages: true,
    supportsToolCalls: true,
    supportsN: true,
  },
  'openai-compatible': {
    models: true,
    supportsCompletion: true,
    supportsStreaming: true,
    supportsJSON: true,
    supportsImages: true,
    supportsToolCalls: true,
    supportsN: true,
  },
} as const

/**
 * llama.cpp slot pins. Flint sends every chat turn to slot 0 so a thread reuses
 * its cached KV prefix across turns, every background task (title generation,
 * subagents) to slot 1 so it can never overwrite that cache, and every Cowork
 * turn to slot 2.
 *
 * Cowork needs its own slot because one agent turn re-prefills a growing prompt
 * dozens of times; sharing slot 0 would evict the viewed thread's prefix on
 * every step, and vice versa. Subagents deliberately reuse the background slot
 * rather than taking a fourth: their prefixes are worth nothing to preserve
 * (each has a different system prompt, so concurrent subagents evict each other
 * regardless), and all that matters is that a dispatch cannot evict the
 * *parent's* prefix on slot 2. Reserving one slot instead of two keeps the KV
 * cache split three ways rather than four.
 *
 * Both are fixed indices rather than values derived from the "Parallel
 * Sequences" setting, because upstream *wraps* an out-of-range `id_slot`
 * instead of rejecting it (`get_slot_by_id`: `id_slot = id_slot % slots.size()`)
 * -- so a pin computed from a stale or differently-resolved slot count silently
 * lands back on slot 0. The extension's RESERVED_BACKGROUND_SLOTS keeps the
 * emitted `parallel` at 2 or more unconditionally, which is what guarantees
 * slot 1 exists; nothing else pins to it, so it is free even when the user
 * raised the sequence count.
 */
export const CHAT_SLOT_ID = 0
export const BACKGROUND_SLOT_ID = 1
export const COWORK_SLOT_ID = 2
