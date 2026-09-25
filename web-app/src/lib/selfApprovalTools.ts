/**
 * MCP tools that let the model approve its own commands.
 *
 * Some shell servers (super-shell and the like) publish a tool such as
 * `approve_command` or `whitelist_add`, so a command the server would hold for
 * confirmation can be waved through -- by whoever calls the tool, which is the
 * model. Flint's prompt is the only approval that counts, so such a tool is
 * put to the user on every call: no "allow always", no server trust, no
 * "allow all MCP permissions", no auto-approval answers for it.
 *
 * Detected by name, mirroring `is_self_approval_tool` in the Rust
 * `mcp_trust.rs`; both are tested against `__tests__/selfApprovalCases.json`.
 * A name is not a proof -- a server can call its approval tool anything -- so
 * this catches the tools that say what they do, and every other MCP tool is
 * still asked about as an external tool.
 */

const READ_VERBS = new Set([
  'list',
  'get',
  'show',
  'read',
  'view',
  'check',
  'is',
  'search',
  'find',
  'query',
])
const APPROVING = new Set([
  'approve',
  'approves',
  'approved',
  'approval',
  'autoapprove',
  'whitelist',
  'allowlist',
  'authorize',
  'authorise',
  'permit',
  'grant',
  'confirm',
])
const ALLOWING = new Set(['allow', 'trust', 'unblock'])
const COMMANDISH = new Set([
  'command',
  'commands',
  'cmd',
  'tool',
  'tools',
  'exec',
  'execution',
  'shell',
])

function words(name: string): string[] {
  const base = name.split('__').pop()!.split('.').pop()!
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

export function isSelfApprovalTool(name: string): boolean {
  const w = words(name)
  if (w.length === 0 || READ_VERBS.has(w[0])) return false
  if (w.some((x) => APPROVING.has(x))) return true
  return w.some((x) => ALLOWING.has(x)) && w.some((x) => COMMANDISH.has(x))
}

/** The self-approval tools among a server's tools, for the Settings note. */
export function selfApprovalToolsOf(
  toolNames: readonly string[] | null | undefined
): string[] {
  return (toolNames ?? []).filter(isSelfApprovalTool)
}
