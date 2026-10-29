/**
 * Upstream and transport error text for provider requests: cleans stack
 * noise from upstream error bodies and turns raw fetch failures into an
 * actionable message. Pure, no I/O.
 */

/**
 * Strip Jinja-stack-trace noise and other diagnostic prelude from upstream
 * error messages so the UI shows the human-readable cause. Examples:
 *
 *   "\n------------\nWhile executing CallExpression at line 1, column 226 in
 *    source:\n...op.index0 % 2 == 0) %}{{ raise_exception('Conversation roles
 *    must alternate user...\n      ^\nError: Jinja Exception: Conversation
 *    roles must alternate user/assistant/user/assistant/..."
 *
 * becomes:
 *
 *   "Jinja Exception: Conversation roles must alternate user/assistant/..."
 *
 * Pure / no I/O so it can be exercised from tests.
 */
/**
 * Heuristic: does this upstream error look like "this parameter is not
 * accepted"? Catches OpenAI's "Unsupported parameter", Anthropic's mutual
 * exclusion, Mistral/Cohere "unknown/disallowed field" shapes, etc.
 *
 * Used to gate a one-shot retry with all our injected sampling params
 * stripped — cheap recovery without parsing per-provider error grammars.
 */
export function isSamplingParamRejection(message: string): boolean {
  if (typeof message !== 'string') return false
  return (
    /unsupported parameter/i.test(message) ||
    /is not supported with this model/i.test(message) ||
    /cannot both be specified|use only one/i.test(message) ||
    /unknown field/i.test(message) ||
    /property\s+['"`][^'"`]+['"`]\s+is unsupported/i.test(message) ||
    /field\s+['"`][^'"`]+['"`]\s+is not allowed/i.test(message) ||
    /unrecognized arguments?/i.test(message)
  )
}

export function cleanUpstreamErrorMessage(raw: string): string {
  if (typeof raw !== 'string') return raw
  let msg = raw.replace(/\r\n/g, '\n').trim()

  // Prefer the final `Error: <…>` line if present — llama.cpp's Jinja runtime
  // emits "Error: Jinja Exception: <root cause>" after a multi-line trace.
  const errorLineMatch = msg.match(/(?:^|\n)\s*Error:\s*(.+?)(?:\n|$)/)
  if (errorLineMatch && errorLineMatch[1]) {
    return errorLineMatch[1].trim()
  }

  // Otherwise drop a leading `------------` rule and "While executing …"
  // prelude that adds noise without explaining the failure.
  msg = msg.replace(/^-{3,}\s*\n?/, '').trim()
  msg = msg.replace(/^While executing[\s\S]*?\n\s*\^\s*\n?/, '').trim()
  return msg
}

/**
 * Map a transport-level fetch failure (no HTTP response — DNS, connect, TLS,
 * timeout, dropped connection) to an actionable message. the provider transport
 * rethrows reqwest's raw "error sending request for url …" string, which isn't
 * useful to users. Returns null when `err` is not a recognised transport error.
 */
export function describeTransportError(err: unknown): string | null {
  const failure = describeTransportFailure(err)
  return failure ? withTransportDetail(failure.friendly, failure.detail) : null
}

/** The friendly text, then the raw cause on its own line. */
export function withTransportDetail(friendly: string, detail: string): string {
  return detail ? `${friendly}\nDetails: ${detail}` : friendly
}

export function describeTransportFailure(
  err: unknown
): { friendly: string; detail: string } | null {
  const raw = err instanceof Error ? err.message : String(err)
  if (typeof raw !== 'string' || !raw) return null
  const m = raw.toLowerCase()

  const isTransport =
    /error sending request/.test(m) ||
    /error trying to connect/.test(m) ||
    /failed to fetch|networkerror|load failed/.test(m) ||
    /connection (refused|reset|closed|aborted)/.test(m) ||
    /connection error|broken pipe/.test(m) ||
    /dns error|failed to lookup|name resolution/.test(m) ||
    /(operation|request|connection) timed out|timeout/.test(m) ||
    /tls|certificate|ssl|handshake/.test(m) ||
    /unreachable/.test(m)
  if (!isTransport) return null

  // The friendly line says what kind of failure it was; the raw text keeps
  // the actual cause (the OS error, the address tried) for the user and logs.
  const detail = transportErrorDetail(raw)
  const withDetail = (friendly: string) => ({ friendly, detail })

  // Unreachable is checked before DNS: the name resolved, but there is no
  // route to the address (a VPN/Tailscale peer that is offline, a host that
  // is down), which is a different fix from a mistyped hostname.
  if (/unreachable|no route to host/.test(m)) {
    return withDetail(
      "Couldn't reach the provider — the host or network is unreachable. Check that the server is running and that any VPN or Tailscale connection to it is up."
    )
  }
  if (/dns error|failed to lookup|name resolution/.test(m)) {
    return withDetail(
      "Couldn't reach the provider — the address could not be resolved. Check the provider's Base URL and your internet connection."
    )
  }
  if (/timed out|timeout/.test(m)) {
    return withDetail(
      'The provider took too long to respond and the request timed out. It may be overloaded or slow to start — try again.'
    )
  }
  if (/tls|certificate|ssl|handshake/.test(m)) {
    return withDetail(
      "Couldn't establish a secure connection to the provider (TLS/certificate error). Verify the endpoint URL."
    )
  }
  return withDetail(
    "Couldn't reach the provider — the connection failed. Check the provider's Base URL and your internet connection, then try again."
  )
}

/** Longest raw cause kept alongside a friendly transport message. */
const MAX_TRANSPORT_DETAIL = 300

/** The raw transport error, on one line and bounded, for display and logs. */
function transportErrorDetail(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_TRANSPORT_DETAIL
    ? `${oneLine.slice(0, MAX_TRANSPORT_DETAIL)}…`
    : oneLine
}

export function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url ?? ''
}
