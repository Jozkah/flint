/**
 * The JSON body of a provider request: dispatch identity, client-side keys,
 * parameter normalisation, llama.cpp constraints and media sentinels. Pure
 * body transforms, no I/O.
 */
import { hasAudioSentinel, splitAudioSentinels } from '@/lib/audio-sentinel'
import { hasVideoSentinel, splitVideoSentinels } from '@/lib/video-sentinel'
import {
  hasToolImageSentinel,
  splitToolImageSentinels,
} from '@/lib/tool-image-sentinel'
import {
  LLAMACPP_ONLY_PARAM_KEYS,
  paramsSettings,
} from '@/lib/predefinedParams'

/**
 * Keys from inference parameters that are client-side only and must not
 * be forwarded in the HTTP body to remote APIs.
 */
/**
 * Which conversation a model's requests belong to.
 *
 * Carried as a model parameter because the model instance is built per session:
 * a module-level "current dispatch" would race between two sessions streaming
 * at once, and the AI SDK gives no other place to thread it through. Stripped
 * from the request body (it is not a sampling parameter) and sent as headers
 * the provider transport consumes and removes before the request goes out.
 */
export const DISPATCH_PARAM_KEY = '__janDispatch'

export type DispatchIdentity = {
  session: string
  run?: string
  thread?: string
  agent?: string
  provider?: string
}

/** Header names the provider transport reads the identity from. */
export const DISPATCH_HEADERS = {
  session: 'x-jan-session',
  run: 'x-jan-run',
  thread: 'x-jan-thread',
  agent: 'x-jan-agent',
  provider: 'x-jan-provider',
} as const

export const CLIENT_SIDE_PARAM_KEYS: ReadonlySet<string> = new Set([
  'ctx_len',
  'max_context_tokens',
  'auto_compact',
  // Consumed client-side: OpenRouter request shaping and provider options.
  'openrouter_web_search',
  'openrouter_image_output',
  'openrouter_provider',
  'verbosity',
  DISPATCH_PARAM_KEY,
])

/**
 * Reconcile `grammar` / `json_schema` with what llama-server actually accepts.
 * The UI can express every combination the server refuses:
 *
 * - `grammar` is rejected whenever the request carries usable tools, and the
 *   check is `body.contains("grammar")` (server-common.cpp), so an untouched
 *   Grammar row -- default `''` -- 400s a tool-enabled thread on its own.
 * - `json_schema` and `grammar` together are refused outright; the explicit
 *   GBNF wins here, since typing one is the more deliberate act.
 * - a schema must be an *object*. The textarea holds a string, which the
 *   server dumps and re-parses into a JSON string that every consumer skips
 *   over `is_object()`, so the setting silently did nothing.
 *
 * Mutates `body`; llamacpp-only, since the other providers never see these keys.
 */
export function reconcileConstraintParams(body: Record<string, unknown>): void {
  if ('grammar' in body) {
    const grammar = body.grammar
    if (typeof grammar !== 'string' || grammar.trim() === '') {
      delete body.grammar
    }
  }

  if ('json_schema' in body) {
    const raw = body.json_schema
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed === '') {
        delete body.json_schema
      } else {
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch (e) {
          console.warn('Ignoring JSON Schema that is not valid JSON:', e)
          delete body.json_schema
        }
        if ('json_schema' in body) {
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            body.json_schema = parsed
          } else {
            console.warn('Ignoring JSON Schema that is not a JSON object')
            delete body.json_schema
          }
        }
      }
    } else if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      delete body.json_schema
    }
  }

  const tools = body.tools
  const toolsUsable =
    Array.isArray(tools) && tools.length > 0 && body.tool_choice !== 'none'
  if (toolsUsable && 'grammar' in body) {
    console.warn('Ignoring the GBNF grammar: llama.cpp refuses one alongside tools')
    delete body.grammar
  }

  if ('grammar' in body && 'json_schema' in body) {
    console.warn('Ignoring the JSON Schema: a GBNF grammar is set and llama.cpp accepts only one')
    delete body.json_schema
  }
}

/** Just the dispatch identity of `parameters`, none of its sampling values. */
export function dispatchOnly(
  parameters: Record<string, unknown>
): Record<string, unknown> {
  return DISPATCH_PARAM_KEY in parameters
    ? { [DISPATCH_PARAM_KEY]: parameters[DISPATCH_PARAM_KEY] }
    : {}
}

export function filterParameters(
  parameters: Record<string, unknown>,
  keepLlamacppOnly: boolean
): Record<string, unknown> {
  if (keepLlamacppOnly) return parameters
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parameters)) {
    if (LLAMACPP_ONLY_PARAM_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

/** A seed worth sending: a whole number of zero or more (string or number). */
function isFixedSeed(value: unknown): boolean {
  const n =
    typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : typeof value === 'number'
        ? value
        : NaN
  return Number.isInteger(n) && n >= 0
}

// Params entered via a text input arrive as strings (see InputControl).
// Providers reject a string where a number is required, so coerce back to a
// number when the param's predefined default is numeric.
function coerceNumericParam(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value
  const def = paramsSettings[key]
  if (!def || typeof def.value !== 'number' || value.trim() === '') return value
  const n = Number(value)
  return Number.isNaN(n) ? value : n
}

// Internal param keys that don't match the llama-server wire field name.
const WIRE_KEY_REMAP: Record<string, string> = {
  max_output_tokens: 'max_tokens',
  dynatemp_exp: 'dynatemp_exponent',
}

// Server expects an array of sampler names; the UI stores a comma/
// semicolon-separated string for easy editing.
function coerceSamplers(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const names = value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return names.length > 0 ? names : undefined
}

// The UI stores stop sequences one per line; the wire wants a string array.
function coerceStop(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const items = value.split(/\r?\n/).filter((s) => s.length > 0)
  return items.length > 0 ? items : undefined
}

/**
 * The body sent upstream: our normalised parameters merged over the SDK's
 * body (or the SDK body alone when `includeOurParams` is false), with
 * media sentinels decoded. Mutates `rawBody` when parameters are left out.
 */
export function buildRequestBody(
  rawBody: Record<string, unknown>,
  includeOurParams: boolean,
  parameters: Record<string, unknown>,
  keepLlamacppOnly: boolean
): Record<string, unknown> {
  if (!includeOurParams) {
    decodeAudioSentinelsInBody(rawBody)
    decodeVideoSentinelsInBody(rawBody)
    decodeToolImageSentinelsInBody(rawBody)
    return rawBody
  }
  const normalised: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (CLIENT_SIDE_PARAM_KEYS.has(key)) continue
    if (!keepLlamacppOnly && LLAMACPP_ONLY_PARAM_KEYS.has(key)) continue
    const targetKey = WIRE_KEY_REMAP[key] ?? key
    // -1 (or empty) is "random": leave the field out rather than send a
    // negative seed that strict servers reject.
    if (key === 'seed' && !isFixedSeed(value)) continue
    const coerced =
      key === 'samplers'
        ? coerceSamplers(value)
        : key === 'stop'
          ? coerceStop(value)
          : coerceNumericParam(key, value)
    if (coerced === undefined) continue
    normalised[targetKey] = coerced
  }
  const merged = { ...rawBody, ...normalised }
  // OpenAI-compatible providers require every declared function tool to
  // carry a non-empty string name. Keep malformed discovery data from
  // reaching strict servers (for example: Expected 'function.name' to be a
  // string) even when a caller supplied tools directly in the request body.
  if (Array.isArray(merged.tools)) {
    merged.tools = merged.tools.filter((tool) => {
      const name = (tool as { function?: { name?: unknown } })?.function?.name
      return typeof name === 'string' && name.trim().length > 0
    })
  }
  if (keepLlamacppOnly) {
    // Assert the server default explicitly so a preset/CLI override can't
    // silently disable prompt-prefix KV reuse across turns.
    merged.cache_prompt = true
    reconcileConstraintParams(merged)
  }
  if (keepLlamacppOnly && merged.stream === true) {
    merged.return_progress = true
    // Requests per-chunk timings so the token counter can update live
    // during generation instead of only once the stream finishes.
    merged.timings_per_token = true
  }
  // llama-server convention: max_tokens = -1 means "unlimited". Users who
  // set max_output_tokens = 0 in assistant params mean "no cap", not
  // "produce zero tokens" — coerce here, gated to llamacpp only because
  // OpenAI/Anthropic reject negative values.
  if (merged.max_tokens === 0) {
    if (keepLlamacppOnly) {
      merged.max_tokens = -1
    } else {
      // Every other provider takes a zero literally, and a reply capped at
      // zero tokens is an empty answer, not an unlimited one. A cap nobody
      // meaningfully set is left out of the request entirely, which is what
      // "no cap" means on the wire.
      delete merged.max_tokens
    }
  }
  decodeAudioSentinelsInBody(merged)
  decodeVideoSentinelsInBody(merged)
  decodeToolImageSentinelsInBody(merged)
  return merged
}

/**
 * Drop `reasoning_content` / `reasoning` from assistant turns in the outgoing
 * request body. The Vercel AI SDK's openai-compatible model attaches
 * `reasoning_content` whenever a prior assistant message had a reasoning part
 * (see @ai-sdk/openai-compatible dist/index.js:260). Groq's strict validator
 * rejects this with `property 'reasoning_content' is unsupported`.
 */
export function stripAssistantReasoningInBody(
  body: Record<string, unknown>
): void {
  const messages = body.messages
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as { role?: string; reasoning_content?: unknown; reasoning?: unknown }
    if (m.role !== 'assistant') continue
    if ('reasoning_content' in m) delete m.reasoning_content
    if ('reasoning' in m) delete m.reasoning
  }
}

// Rewrites any sentinel-bearing text content (planted by
// CustomChatTransport.encodeAudioAttachments) back into OpenAI `input_audio`
// content parts. Mutates `body.messages` in place.
export function decodeAudioSentinelsInBody(body: Record<string, unknown>): void {
  const messages = body.messages
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as { role?: string; content?: unknown }
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      if (!hasAudioSentinel(m.content)) continue
      const split = splitAudioSentinels(m.content)
      if (split) m.content = split
      continue
    }
    if (!Array.isArray(m.content)) continue
    const next: unknown[] = []
    let touched = false
    for (const part of m.content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: string }).type === 'text' &&
        typeof (part as { text?: string }).text === 'string' &&
        hasAudioSentinel((part as { text: string }).text)
      ) {
        const split = splitAudioSentinels((part as { text: string }).text)
        if (split) {
          next.push(...split)
          touched = true
          continue
        }
      }
      next.push(part)
    }
    if (touched) m.content = next
  }
}

// Rewrites any sentinel-bearing text content (planted by
// CustomChatTransport.encodeVideoAttachments) back into llama-server
// `input_video` content parts. Mutates `body.messages` in place. Runs after
// decodeAudioSentinelsInBody, so it also handles content already promoted to
// an array by the audio pass; the two sentinel markers are disjoint.
export function decodeVideoSentinelsInBody(body: Record<string, unknown>): void {
  const messages = body.messages
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as { role?: string; content?: unknown }
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      if (!hasVideoSentinel(m.content)) continue
      const split = splitVideoSentinels(m.content)
      if (split) m.content = split
      continue
    }
    if (!Array.isArray(m.content)) continue
    const next: unknown[] = []
    let touched = false
    for (const part of m.content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: string }).type === 'text' &&
        typeof (part as { text?: string }).text === 'string' &&
        hasVideoSentinel((part as { text: string }).text)
      ) {
        const split = splitVideoSentinels((part as { text: string }).text)
        if (split) {
          next.push(...split)
          touched = true
          continue
        }
      }
      next.push(part)
    }
    if (touched) m.content = next
  }
}

// Rewrites a sentinel-bearing `role: tool` message (a tool that returned an
// image) into a text part plus OpenAI `image_url` parts. Mutates
// `body.messages` in place.
export function decodeToolImageSentinelsInBody(
  body: Record<string, unknown>
): void {
  const messages = body.messages
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as { role?: string; content?: unknown }
    if (m.role !== 'tool' || typeof m.content !== 'string') continue
    if (!hasToolImageSentinel(m.content)) continue
    const split = splitToolImageSentinels(m.content)
    if (split) m.content = split
  }
}
