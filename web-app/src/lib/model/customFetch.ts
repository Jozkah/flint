/**
 * The fetch wrapper every provider model uses: builds the request body,
 * tags the dispatch identity, tracks reachability and cleans or retries
 * upstream errors.
 */
import {
  originOf,
  useProviderReachability,
} from '@/hooks/useProviderReachability'
import {
  filterDefaultSseEvents,
  sanitizeOpenAiToolCallSseEvents,
} from '@/lib/sseEventTypeFilter'
import {
  cleanUpstreamErrorMessage,
  describeTransportFailure,
  isSamplingParamRejection,
  requestUrlOf,
  withTransportDetail,
} from './transportErrors'
import {
  buildRequestBody,
  DISPATCH_HEADERS,
  DISPATCH_PARAM_KEY,
  type DispatchIdentity,
} from './requestBody'

/**
 * Create a custom fetch function that injects additional parameters into the
 * request body, normalising key names for OpenAI-compatible APIs:
 * - `max_output_tokens` is remapped to `max_tokens`
 * - client-side-only keys (e.g. `ctx_len`) are stripped
 *
 * Also rewrites OpenAI-shape error bodies on non-OK responses so the inner
 * `error.message` is cleaned of stack-trace noise before the AI SDK surfaces
 * it to the UI.
 */
export function createCustomFetch(
  baseFetch: typeof globalThis.fetch,
  parameters: Record<string, unknown>,
  keepLlamacppOnly = false,
  onLlamacppServerError?: () => void,
  filterNamedSseEvents = false
): typeof globalThis.fetch {
  const dispatch = parameters[DISPATCH_PARAM_KEY] as DispatchIdentity | undefined

  const prepareResponse = (res: Response): Response => {
    // OpenAI-compatible servers may interleave custom named SSE events (e.g.
    // tool-progress) with chat.completion.chunk data; the AI SDK validates
    // every data line against the chunk schema, so strip non-default events.
    // Opt-in only: Anthropic and the OpenAI Responses API use named SSE
    // events as their protocol, so filtering there blanks the whole stream.
    const contentType = res.headers.get('content-type') || ''
    if (
      filterNamedSseEvents &&
      res.body &&
      contentType.includes('text/event-stream')
    ) {
      return new Response(
        sanitizeOpenAiToolCallSseEvents(filterDefaultSseEvents(res.body)),
        {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        }
      )
    }
    return res
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (dispatch?.session) {
      // The transport records what it is about to send; without knowing whose
      // conversation this is, the record could not be found again.
      const headers = new Headers(init?.headers ?? {})
      headers.set(DISPATCH_HEADERS.session, dispatch.session)
      if (dispatch.run) headers.set(DISPATCH_HEADERS.run, dispatch.run)
      if (dispatch.thread) headers.set(DISPATCH_HEADERS.thread, dispatch.thread)
      if (dispatch.agent) headers.set(DISPATCH_HEADERS.agent, dispatch.agent)
      if (dispatch.provider)
        headers.set(DISPATCH_HEADERS.provider, dispatch.provider)
      init = { ...init, headers }
    }
    let rawBody: Record<string, unknown> | null = null
    if (init?.method === 'POST' || !init?.method) {
      try {
        rawBody = init?.body ? JSON.parse(init.body as string) : {}
      } catch (e) {
        throw new Error(
          `Failed to parse request body as JSON: ${e instanceof Error ? e.message : String(e)}`
        )
      }
      init = { ...init, body: JSON.stringify(buildRequestBody(rawBody!, true, parameters, keepLlamacppOnly)) }
    }

    const origin = originOf(requestUrlOf(input))
    let res: Response
    try {
      res = await baseFetch(input, init)
    } catch (err) {
      const failure = describeTransportFailure(err)
      if (!failure) throw err
      // The URL belongs with the summary; the raw cause stays on its own line.
      const friendly = withTransportDetail(
        `${failure.friendly} (${requestUrlOf(input)})`,
        failure.detail
      )
      // A real request just failed at the transport layer. That, and only
      // that, is what marks a provider offline — nothing probes for it.
      if (origin) {
        useProviderReachability
          .getState()
          .markUnreachable(origin, friendly)
      }
      throw new Error(friendly)
    }
    // Answered at all: whatever was wrong with the endpoint is over. A 4xx is
    // still an answer, so it clears the offline mark too.
    if (origin) useProviderReachability.getState().markReachable(origin)
    if (res.ok) return prepareResponse(res)

    const isLlamacpp500 = keepLlamacppOnly && res.status === 500

    let parsed: { error?: { message?: unknown; [k: string]: unknown } } | null =
      null
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('json')) {
      try {
        parsed = JSON.parse(await res.clone().text())
      } catch {
        parsed = null
      }
    }

    const innerMessage =
      typeof parsed?.error?.message === 'string'
        ? (parsed.error.message as string)
        : null

    if (isLlamacpp500 && !innerMessage) {
      // 500 with no JSON body = router couldn't reach the child (crash). Recover.
      onLlamacppServerError?.()
      const synthMessage =
        'The model crashed and is being reloaded. Please retry.'
      const nextBody = JSON.stringify({
        error: {
          message: synthMessage,
          code: 500,
          type: 'llamacpp_server_error',
        },
      })
      return new Response(nextBody, {
        status: res.status,
        statusText: res.statusText,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (!innerMessage) return res

    // Sampling-rejection auto-retry: when the upstream complains about an
    // injected parameter (top_k on OpenAI, temp+top_p on Anthropic, etc.),
    // retry once with all our injected params stripped, surface a toast so
    // the user knows their popover knob was ignored this turn, and return
    // the bare-body response. Only attempts when we have a captured body
    // and the request looked like a chat completion / messages POST.
    if (
      rawBody &&
      res.status >= 400 &&
      res.status < 500 &&
      isSamplingParamRejection(innerMessage) &&
      Object.keys(parameters).length > 0
    ) {
      const bareInit = {
        ...init,
        body: JSON.stringify(buildRequestBody(rawBody, false, parameters, keepLlamacppOnly)),
      }
      const retry = await baseFetch(input, bareInit)
      if (retry.ok) {
        notifySamplingStripped(innerMessage)
        return prepareResponse(retry)
      }
      // Retry also failed — fall through to surface the cleaned original error.
    }

    const cleaned = cleanUpstreamErrorMessage(innerMessage)
    if (cleaned === innerMessage) return res
    const nextBody = JSON.stringify({
      ...parsed,
      error: { ...parsed!.error, message: cleaned },
    })
    return new Response(nextBody, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}

let lastSamplingNoticeAt = 0
function notifySamplingStripped(reason: string): void {
  const now = Date.now()
  if (now - lastSamplingNoticeAt < 3000) return
  lastSamplingNoticeAt = now
  void import('sonner')
    .then(({ toast }) => {
      toast.warning('Sampling parameters dropped', {
        description: `${cleanUpstreamErrorMessage(reason)} — request retried without your sampling overrides. Adjust in the Sampling popover.`,
      })
    })
    .catch(() => {
      console.warn('[sampling-retry]', reason)
    })
}
