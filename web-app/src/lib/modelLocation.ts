import { endpointScope } from '@/lib/endpointDiagnostics'
import type { EndpointDiagnostics } from '@/lib/providerFetch'

/**
 * Where a model's inference actually runs.
 *
 * The old rule was "does this provider ship an inference engine", which is a
 * question about how the provider was installed, not about where the work
 * happens. A workstation on the LAN, a home server, or a machine on the
 * tailnet reached at `http://llm-host:8080/v1` was therefore filed under REMOTE --
 * next to the hosted APIs -- which is exactly backwards for the property
 * anybody is grouping by: whether the prompt leaves the network.
 *
 * So this classifies the endpoint, not the installation. It never rewrites the
 * endpoint, and it never guesses: a single-label hostname is `checking` until
 * the resolver has actually answered for it, because that name can legitimately
 * be either.
 */
export type ModelLocation = 'local' | 'remote' | 'checking' | 'unknown'

export type LocationInput = {
  /** The endpoint as the user configured it. Never modified. */
  baseUrl?: string | null
  /** True for Jan's own bundled inference engine. */
  builtInEngine?: boolean
  /**
   * What the canonical resolver decided for this endpoint, when it has run.
   *
   * This is what settles a single-label name: `llm-host` is local exactly when the
   * address actually selected for it is a local one.
   */
  diagnostics?: EndpointDiagnostics | null
}

/** Address classes the transport reports for something that is not on the internet. */
const LOCAL_CLASSES = new Set([
  'loopback',
  'tailscale',
  'private-lan',
  'local-ipv6',
])

export function classifyModelLocation(input: LocationInput): ModelLocation {
  // Jan's own runtime: inference is this process, whatever the URL looks like.
  if (input.builtInEngine) return 'local'

  const url = input.baseUrl?.trim()
  if (!url) return 'unknown'

  const scope = endpointScope(url)
  if (scope === 'loopback' || scope === 'private') return 'local'
  if (scope === 'public') return 'remote'

  // `unknown` is the resolver-dependent case -- a single-label name like
  // `llm-host`. The resolver's own answer decides it.
  const diagnostics = input.diagnostics
  if (!diagnostics) return 'checking'
  // Mixed public and private answers are not ambiguous: the transport picks
  // the private one and refuses to dial the public one, so the model is local.
  if (diagnostics.selected) {
    const chosen = diagnostics.candidates.find(
      (c) => c.address === diagnostics.selected
    )
    if (chosen) return LOCAL_CLASSES.has(chosen.class) ? 'local' : 'remote'
  }
  if (diagnostics.candidates.some((c) => c.eligible && LOCAL_CLASSES.has(c.class))) {
    return 'local'
  }
  if (diagnostics.candidates.length > 0) return 'remote'
  return 'checking'
}

/**
 * The group a model belongs in.
 *
 * Anything not yet settled stays out of REMOTE: filing an unresolved local
 * machine under "remote" is the mistake this exists to stop, and it is worse
 * than saying so.
 */
export function isLocalModel(input: LocationInput): boolean {
  return classifyModelLocation(input) === 'local'
}

export function isRemoteModel(input: LocationInput): boolean {
  return classifyModelLocation(input) === 'remote'
}
