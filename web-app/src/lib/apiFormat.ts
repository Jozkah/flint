/**
 * Which OpenAI-style HTTP API a model is talked to over: Chat Completions
 * (`/chat/completions`) or the Responses API (`/responses`).
 *
 * Order of precedence, first hit wins:
 *   1. the user's choice on the model (`Model.apiFormat` = chat | responses)
 *   2. the format a past request proved works (`Model.detectedApiFormat`)
 *   3. a model id that OpenAI serves on the Responses API only
 *   4. the host: genuine OpenAI hosts and Azure v1 speak Responses, anything
 *      else (gateways, Requesty, LiteLLM, groq, ...) speaks Chat Completions
 */

export type ApiFormat = 'chat' | 'responses'
export type ApiFormatSetting = 'auto' | ApiFormat

export type ApiFormatSource = 'override' | 'detected' | 'model' | 'host'

export interface ApiFormatDecision {
  format: ApiFormat
  source: ApiFormatSource
}

export function isApiFormat(value: unknown): value is ApiFormat {
  return value === 'chat' || value === 'responses'
}

/** A blank Base URL and any `*.openai.com` host are the genuine service. */
export function isGenuineOpenAIHost(baseUrl: string | undefined): boolean {
  const raw = baseUrl?.trim()
  if (!raw) return true
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host === 'openai.com' || host.endsWith('.openai.com')
  } catch {
    return false
  }
}

/**
 * Ids OpenAI serves on the Responses API only. Confirmed on OpenAI's model
 * pages: gpt-5-pro, o3-pro, gpt-5-codex and o3-deep-research. The rest follow
 * the same family naming (`-pro` reasoning models, `codex`, `deep-research`,
 * computer-use). A wrong guess costs one request: the fallback switches back.
 * A `vendor/` prefix (gateway-style ids such as `openai/gpt-5-pro`) is ignored.
 */
const RESPONSES_ONLY_ID = [
  /^o\d+(-mini)?-pro\b/,
  /^gpt-5(\.\d+)?(-\w+)*-pro\b/,
  /codex/,
  /deep-research/,
  /^computer-use/,
]

export function isResponsesOnlyModelId(modelId: string): boolean {
  const id = modelId.toLowerCase().split('/').pop() ?? ''
  return RESPONSES_ONLY_ID.some((re) => re.test(id))
}

type ModelLike =
  | { apiFormat?: unknown; detectedApiFormat?: unknown }
  | null
  | undefined

export interface ApiFormatInput {
  /** The provider's Base URL. */
  baseUrl: string | undefined
  modelId: string
  model?: ModelLike
  /** Can the endpoint serve Responses at all? False for legacy Azure. */
  canServeResponses?: boolean
  /** An Azure v1 endpoint: serves Responses like the genuine service. */
  azureV1?: boolean
}

export function resolveApiFormat(input: ApiFormatInput): ApiFormatDecision {
  const { model, modelId, baseUrl } = input
  const canResponses = input.canServeResponses !== false
  const override = model?.apiFormat
  if (isApiFormat(override) && (override === 'chat' || canResponses)) {
    return { format: override, source: 'override' }
  }
  const detected = model?.detectedApiFormat
  if (isApiFormat(detected) && (detected === 'chat' || canResponses)) {
    return { format: detected, source: 'detected' }
  }
  if (!canResponses) return { format: 'chat', source: 'host' }
  if (isResponsesOnlyModelId(modelId)) {
    return { format: 'responses', source: 'model' }
  }
  return {
    format: input.azureV1 || isGenuineOpenAIHost(baseUrl) ? 'responses' : 'chat',
    source: 'host',
  }
}

export function otherFormat(format: ApiFormat): ApiFormat {
  return format === 'chat' ? 'responses' : 'chat'
}

interface ErrorFacts {
  status?: number
  url: string
  text: string
}

function factsOf(error: unknown): ErrorFacts {
  let status: number | undefined
  let url = ''
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (typeof current !== 'object') break
    const e = current as Record<string, unknown>
    if (typeof e.statusCode === 'number') status ??= e.statusCode
    if (typeof e.status === 'number') status ??= e.status
    if (typeof e.url === 'string') url ||= e.url
    if (typeof e.message === 'string') parts.push(e.message)
    if (typeof e.responseBody === 'string') parts.push(e.responseBody)
    current = e.cause ?? (Array.isArray(e.errors) ? e.errors[0] : undefined)
  }
  return { status, url, text: parts.join('\n') }
}

const NEEDS_RESPONSES =
  /(only|not)\s+supported\s+(in|on|with|by)\s+(the\s+)?(v1\/responses|responses)|use\s+(the\s+)?(v1\/responses|responses\s+api)|not\s+a\s+chat\s+model|does\s+not\s+support\s+(the\s+)?chat\s*completions|not\s+supported\s+(in|on)\s+(the\s+)?(v1\/)?chat\/completions|(only|available)\s+(in|on|via)\s+(the\s+)?(v1\/)?responses/i

const RESPONSES_MISSING_TEXT =
  /unknown\s+(endpoint|url|route|path)|no\s+route|cannot\s+(post|get)|method\s+not\s+allowed|not\s+found|invalid\s+url|responses\s+api\s+(is\s+)?(not|un)\s*supported|(not|un)\s*supported.*responses|does\s+not\s+(support|implement).*responses/i

/**
 * The failed request says it was sent to the wrong API, and the other one is
 * worth a try. Only a missing or refused endpoint counts: auth, rate limit and
 * server errors (401/403/429/5xx) never switch formats.
 *
 * - on Chat Completions: a model that only exists on Responses
 * - on Responses: 404/405/501 on `/responses` (or a body naming it), or an
 *   explicit "Responses API not supported"
 */
export function shouldSwitchApiFormat(
  error: unknown,
  current: ApiFormat
): boolean {
  const { status, url, text } = factsOf(error)
  if (current === 'chat') {
    return (status === 400 || status === 404) && NEEDS_RESPONSES.test(text)
  }
  if (status === 404 || status === 405 || status === 501) {
    // "model not found" is about the model, not the endpoint: the other API
    // would say the same.
    if (
      /model[^.\n]*(not\s+found|does\s+not\s+exist)/i.test(text) &&
      !/unknown\s+(endpoint|url|route|path)|no\s+route|cannot\s+(post|get)|method\s+not\s+allowed/i.test(
        text
      )
    ) {
      return false
    }
    return (
      /\/responses\b/i.test(url) ||
      /responses/i.test(text) ||
      RESPONSES_MISSING_TEXT.test(text)
    )
  }
  return status === 400 && /responses\s+api\s+(is\s+)?(not|un)\s*supported/i.test(text)
}
