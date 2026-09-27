/**
 * Model Doctor: test whether the selected model can actually use tools,
 * through the same transport a Cowork run uses.
 *
 * "Supports tools" used to be a declared flag -- a GGUF chat template that
 * mentions tools, or a box ticked by hand. A model can carry the flag and
 * still answer a tool schema with prose, emit arguments that are not JSON,
 * or call the tool and then never continue from its result. This probe
 * observes each of those, on demand only ("Test this model"):
 *
 *   1. tool call     -- given one harmless synthetic tool and a request that
 *                       needs it, does the model call it (not answer in prose)?
 *   2. arguments     -- are the arguments valid against the tool's schema?
 *   3. continuation  -- given the tool's result, does the next turn use it
 *                       (quote a one-off code the result carried)?
 *   4. timeout       -- did every step answer within the time limit?
 *
 * The tools are synthetic and never executed: the probe writes their result
 * itself. No project file, real tool, MCP server or sandbox is involved, and
 * nothing is sent but the fixed prompts below.
 *
 * A pass is one observation on one date with one set of settings. It is
 * reported as such -- never as a promise that every task will work -- and a
 * change to any setting that shapes the request (see `modelFingerprint`)
 * invalidates it.
 */
import { generateText, jsonSchema, type LanguageModel, type ModelMessage } from 'ai'

export const PROBE_VERSION = 1
/** Per step; a local model may be loading its weights on the first one. */
export const DEFAULT_STEP_TIMEOUT_MS = 90_000
const MAX_OUTPUT_TOKENS = 512

export type ProbeCheckId = 'tool_call' | 'arguments' | 'continuation' | 'timeout'

export type ProbeCheck = {
  id: ProbeCheckId
  /** null: not reached, because an earlier step failed. */
  ok: boolean | null
  /** What was observed, for the user; never contains a secret. */
  detail: string
}

export type ProbeResult = {
  version: number
  provider: string
  modelId: string
  fingerprint: string
  /** The settings the fingerprint covers, shown so the user can see what was tested. */
  settingsSummary: string
  testedAt: string
  durationMs: number
  outcome: 'passed' | 'failed' | 'cancelled'
  checks: ProbeCheck[]
}

// --- fingerprint -------------------------------------------------------------

const SECRET_KEY = /(key|token|secret|password|auth|credential)/i

function settingValues(settings: ProviderSetting[] | Record<string, ProviderSetting> | undefined) {
  const list = Array.isArray(settings) ? settings : Object.values(settings ?? {})
  const out: Record<string, unknown> = {}
  for (const s of list) {
    if (!s?.key) continue
    // A credential is not part of what shapes the request, and must never be
    // hashed into something stored in plain settings.
    if (SECRET_KEY.test(s.key) || s.controller_props?.type === 'password') continue
    out[s.key] = s.controller_props?.value ?? null
  }
  return out
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** FNV-1a, 2 x 32 bits: stable across runs, cheap, and not reversible to settings. */
function hash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c ^ (a >>> 7), 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** Everything that shapes a tool-calling request, and nothing secret. */
export function fingerprintInput(provider: ProviderObject, model: Model) {
  return {
    probe: PROBE_VERSION,
    provider: provider.provider,
    base_url: provider.base_url ?? null,
    api_type: provider.api_type ?? 'openai',
    provider_settings: settingValues(provider.settings),
    // Names only: header values can be credentials.
    headers: (provider.custom_header ?? []).map((h) => h.header).sort(),
    model: model.id,
    model_settings: settingValues(model.settings),
    template_kwargs: (model.template_kwargs ?? []).map((k) => [k.name, k.default]),
    capabilities: [...(model.capabilities ?? [])].sort(),
  }
}

export function modelFingerprint(provider: ProviderObject, model: Model): string {
  return hash(stable(fingerprintInput(provider, model)))
}

export function settingsSummary(provider: ProviderObject, model: Model): string {
  const input = fingerprintInput(provider, model)
  const parts = [`${input.provider}/${input.model}`]
  if (input.base_url) parts.push(input.base_url)
  const ms = Object.entries(input.model_settings)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
  if (ms.length) parts.push(ms.slice(0, 8).join(', '))
  return parts.join(' · ')
}

// --- probe -------------------------------------------------------------------

export const PROBE_TOOL = 'lookup_fixture'

const PROBE_SYSTEM =
  'You are being tested for tool use. Use the provided tool when the user asks for data only it has. Do not invent tool results.'

const PROBE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    city: { type: 'string', description: 'City name, e.g. "Oslo".' },
    unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
  },
  required: ['city', 'unit'],
  additionalProperties: false,
} as const

/** The synthetic tools. No `execute`: the probe never runs anything. */
export function probeTools() {
  return {
    [PROBE_TOOL]: {
      description:
        'Look up a fixed test reading for a city. Returns a temperature and a verification code.',
      // No validator: the model's raw arguments are checked below, so an
      // invalid call is observed rather than silently repaired.
      inputSchema: jsonSchema(PROBE_TOOL_SCHEMA as unknown as Parameters<typeof jsonSchema>[0]),
    },
  }
}

/** Arguments valid against `PROBE_TOOL_SCHEMA`, or why not. */
export function validateProbeArgs(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return `arguments are not a JSON object (${JSON.stringify(input)?.slice(0, 120)})`
  }
  const o = input as Record<string, unknown>
  const extra = Object.keys(o).filter((k) => k !== 'city' && k !== 'unit')
  if (typeof o.city !== 'string' || !o.city.trim()) return '"city" is missing or not a string'
  if (o.unit !== 'celsius' && o.unit !== 'fahrenheit') {
    return `"unit" must be "celsius" or "fahrenheit", got ${JSON.stringify(o.unit)}`
  }
  if (extra.length) return `unexpected argument(s): ${extra.join(', ')}`
  return null
}

type Generate = (args: Parameters<typeof generateText>[0]) => Promise<{
  text: string
  finishReason: string
  toolCalls: Array<{
    toolCallId: string
    toolName: string
    input: unknown
    invalid?: boolean
    error?: unknown
  }>
}>

export type ProbeDeps = {
  createModel: () => Promise<LanguageModel>
  generate?: Generate
  now?: () => number
  nonce?: () => string
  stepTimeoutMs?: number
}

class StepTimeout extends Error {}

function stepSignal(outer: AbortSignal | undefined, ms: number) {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort(new StepTimeout(`no answer within ${Math.round(ms / 1000)} s`))
  }, ms)
  const onAbort = () => ctrl.abort(outer?.reason)
  if (outer?.aborted) ctrl.abort(outer.reason)
  else outer?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    },
  }
}

/** A one-line description of a transport error, with no secret in it. */
export function describeProbeError(error: unknown): string {
  const e = error as { message?: string; statusCode?: number; responseBody?: string }
  const status = e?.statusCode ? `HTTP ${e.statusCode}: ` : ''
  const text = (e?.message ?? String(error)).replace(/\s+/g, ' ')
  // Bearer tokens and API-key-shaped strings never reach the report.
  return (status + text)
    .replace(/(bearer\s+)[^\s"']+/gi, '$1<redacted>')
    .replace(/\b(sk|pk|ghp|gho|xox[abp]|AIza)[-_A-Za-z0-9]{12,}/g, '<redacted>')
    .slice(0, 400)
}

/**
 * Run the probe. `identity` is recorded with the result; the result's
 * outcome is `passed` only when every check passed.
 */
export async function runModelProbe(
  identity: { provider: string; modelId: string; fingerprint: string; settingsSummary: string },
  deps: ProbeDeps,
  signal?: AbortSignal
): Promise<ProbeResult> {
  const now = deps.now ?? Date.now
  const generate = (deps.generate ?? (generateText as unknown as Generate)) as Generate
  const stepMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const code = (deps.nonce ?? (() => Math.random().toString(36).slice(2, 10).toUpperCase()))()
  const started = now()
  const checks: Record<ProbeCheckId, ProbeCheck> = {
    tool_call: { id: 'tool_call', ok: null, detail: 'not reached' },
    arguments: { id: 'arguments', ok: null, detail: 'not reached' },
    continuation: { id: 'continuation', ok: null, detail: 'not reached' },
    timeout: { id: 'timeout', ok: null, detail: 'not reached' },
  }
  const finish = (outcome?: ProbeResult['outcome']): ProbeResult => {
    const list = Object.values(checks)
    return {
      version: PROBE_VERSION,
      ...identity,
      testedAt: new Date(now()).toISOString(),
      durationMs: now() - started,
      outcome: outcome ?? (list.every((c) => c.ok === true) ? 'passed' : 'failed'),
      checks: list,
    }
  }

  let model: LanguageModel
  try {
    model = await deps.createModel()
  } catch (e) {
    if (signal?.aborted) return finish('cancelled')
    checks.tool_call = { id: 'tool_call', ok: false, detail: `the model could not be started: ${describeProbeError(e)}` }
    return finish()
  }

  const tools = probeTools()
  const user: ModelMessage = {
    role: 'user',
    content:
      'Use the lookup_fixture tool to get the test reading for Oslo in celsius. Call the tool; do not answer from memory. After you get the result, reply with its verification code.',
  }

  const step = async (messages: ModelMessage[]) => {
    if (signal?.aborted) throw signal.reason ?? new Error('cancelled')
    const s = stepSignal(signal, stepMs)
    const t0 = now()
    try {
      const r = await generate({
        model,
        system: PROBE_SYSTEM,
        messages,
        tools,
        toolChoice: 'auto',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: s.signal,
        maxRetries: 0,
      } as Parameters<typeof generateText>[0])
      return { r, ms: now() - t0 }
    } catch (e) {
      if (s.timedOut()) throw new StepTimeout(`no answer within ${Math.round(stepMs / 1000)} s`)
      throw e
    } finally {
      s.done()
    }
  }

  const slowest: number[] = []
  // 1 + 2: the tool call and its arguments.
  let first
  try {
    first = await step([user])
  } catch (e) {
    if (signal?.aborted) return finish('cancelled')
    if (e instanceof StepTimeout) {
      checks.timeout = { id: 'timeout', ok: false, detail: `first turn: ${e.message}` }
      return finish()
    }
    checks.tool_call = { id: 'tool_call', ok: false, detail: `request failed: ${describeProbeError(e)}` }
    return finish()
  }
  slowest.push(first.ms)
  const call = first.r.toolCalls.find((c) => c.toolName === PROBE_TOOL) ?? first.r.toolCalls[0]
  if (!call) {
    const said = first.r.text.trim().replace(/\s+/g, ' ').slice(0, 160)
    checks.tool_call = {
      id: 'tool_call',
      ok: false,
      detail: `answered without calling the tool (finish reason: ${first.r.finishReason})${said ? `: "${said}"` : ''}`,
    }
    checks.timeout = { id: 'timeout', ok: true, detail: `first turn in ${first.ms} ms` }
    return finish()
  }
  if (call.toolName !== PROBE_TOOL) {
    checks.tool_call = { id: 'tool_call', ok: false, detail: `called an unknown tool "${String(call.toolName).slice(0, 60)}"` }
    return finish()
  }
  checks.tool_call = {
    id: 'tool_call',
    ok: true,
    detail: `called ${PROBE_TOOL}${first.r.toolCalls.length > 1 ? ` (${first.r.toolCalls.length} calls in one turn)` : ''}`,
  }
  const argError = call.invalid
    ? `arguments could not be parsed: ${describeProbeError(call.error)}`
    : validateProbeArgs(call.input)
  checks.arguments = argError
    ? { id: 'arguments', ok: false, detail: argError }
    : { id: 'arguments', ok: true, detail: `valid: ${JSON.stringify(call.input)}` }
  if (argError) {
    checks.timeout = { id: 'timeout', ok: true, detail: `first turn in ${first.ms} ms` }
    return finish()
  }

  // 3: continuation from the tool's result.
  const messages: ModelMessage[] = [
    user,
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: call.toolCallId, toolName: PROBE_TOOL, input: call.input }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: call.toolCallId,
          toolName: PROBE_TOOL,
          output: { type: 'json', value: { city: 'Oslo', temperature: 7, unit: 'celsius', verification_code: code } },
        },
      ],
    },
    // No new user turn: an agent run continues straight from a tool result.
  ]
  let second
  try {
    second = await step(messages)
  } catch (e) {
    if (signal?.aborted) return finish('cancelled')
    if (e instanceof StepTimeout) {
      checks.timeout = { id: 'timeout', ok: false, detail: `continuation turn: ${e.message}` }
      return finish()
    }
    checks.continuation = { id: 'continuation', ok: false, detail: `request failed: ${describeProbeError(e)}` }
    return finish()
  }
  slowest.push(second.ms)
  checks.timeout = {
    id: 'timeout',
    ok: true,
    detail: `slowest turn ${Math.max(...slowest)} ms (limit ${Math.round(stepMs / 1000)} s)`,
  }
  if (second.r.text.toUpperCase().includes(code)) {
    checks.continuation = { id: 'continuation', ok: true, detail: 'used the tool result in the next turn' }
  } else if (second.r.toolCalls.length > 0) {
    checks.continuation = {
      id: 'continuation',
      ok: false,
      detail: 'called the tool again instead of continuing from its result',
    }
  } else {
    const said = second.r.text.trim().replace(/\s+/g, ' ').slice(0, 160)
    checks.continuation = {
      id: 'continuation',
      ok: false,
      detail: said
        ? `did not use the tool result: "${said}"`
        : `returned nothing after the tool result (finish reason: ${second.r.finishReason})`,
    }
  }
  return finish()
}
