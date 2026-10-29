import type { MCPService } from '@/services/mcp/types'

/**
 * The fingerprint to bind a trust or allow-once request to. The backend
 * requires one: `known` (the definition the approval was shown) when there is
 * one, else the server's current fingerprint fetched now. `undefined` when the
 * backend knows no such server, so the caller sends nothing.
 */
export async function fingerprintFor(
  mcp: Pick<MCPService, 'serverFingerprints'>,
  server: string,
  known?: string
): Promise<string | undefined> {
  if (known) return known
  try {
    const fingerprints = await mcp.serverFingerprints()
    return fingerprints[server] || undefined
  } catch {
    return undefined
  }
}
