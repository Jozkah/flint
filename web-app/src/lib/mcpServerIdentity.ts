import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * The security fingerprint of one MCP server as the backend computes it.
 *
 * The renderer never fingerprints a server definition itself: the backend's
 * `mcp_identity` is the single definition the trust gate enforces, and a second
 * implementation here could disagree with it about whether a server changed.
 *
 * Resolves `undefined` when the server is not configured or the backend is
 * unavailable. Callers treat that as "identity unknown", which matches no
 * approval.
 */
export async function resolveServerFingerprint(
  serverName: string
): Promise<string | undefined> {
  try {
    const fingerprints = await getServiceHub().mcp().serverFingerprints()
    const fingerprint = fingerprints?.[serverName]
    return typeof fingerprint === 'string' && fingerprint ? fingerprint : undefined
  } catch {
    return undefined
  }
}

/** Every configured server's fingerprint, or an empty map when unavailable. */
export async function resolveServerFingerprints(): Promise<
  Record<string, string>
> {
  try {
    return (await getServiceHub().mcp().serverFingerprints()) ?? {}
  } catch {
    return {}
  }
}
