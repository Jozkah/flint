import { invoke } from '@tauri-apps/api/core'

/** What the gate decided. Mirrors `audit::Outcome` in the agent-tools plugin. */
export type PermissionAuditDecision =
  | 'allow'
  | 'deny'
  | 'prompt'
  | 'granted'
  | 'refused'
  | 'expired'
  | 'revoked'
  | 'stale'
  | 'cancelled'

/** One recorded decision. Mirrors `audit::PermissionRecord`; resource and
 * reason are redacted before they are stored and again when read. */
export type PermissionAuditRecord = {
  v: number
  at: string
  session: string
  run: string
  call: string
  agent: string
  project: string
  tool: string
  capability: string
  kind: string
  resource: string
  decision: PermissionAuditDecision
  reason: string
  rule: string
}

/** The backend clamps to this as well. */
export const PERMISSION_AUDIT_MAX = 200

/**
 * The most recent decisions the built-in tool gate recorded, newest first.
 *
 * Read-only. Only the built-in agent tools write this log today; MCP trust
 * decisions and renderer approvals are not in it.
 *
 * Invoked directly rather than through `@janhq/tauri-plugin-agent-tools-api`
 * so the page does not depend on a rebuilt guest bundle.
 */
export async function permissionAuditRecent(
  dataFolder: string,
  limit = 50
): Promise<PermissionAuditRecord[]> {
  return invoke('plugin:agent-tools|permission_audit_recent', {
    dataFolder,
    limit: Math.max(1, Math.min(PERMISSION_AUDIT_MAX, Math.floor(limit))),
  })
}
