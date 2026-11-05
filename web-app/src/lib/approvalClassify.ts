// Pure classification helpers for tool approval requests, split out of
// hooks/useToolApprovalRequests.ts.

import { destructiveCommandReason } from '@/lib/destructiveCommand'
import { GIT_TOOL_NAME, planGitTool } from '@/lib/gitTool'

export function bashDestructiveReason(
  toolName: string,
  input: unknown,
  context: { workspaceLabel?: string; workspaceRoots?: readonly string[] } | undefined
): string | null {
  if (toolName !== 'bash') return null
  const command = (input as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string') return null
  const label = context?.workspaceLabel
  const roots =
    context?.workspaceRoots ??
    (label && (/^[a-zA-Z]:[\\/]/.test(label) || label.startsWith('/'))
      ? [label]
      : [])
  return destructiveCommandReason(command, roots)
}

/** Calls that cannot safely be inferred from a generic tool approval. */
export function sensitiveCall(
  toolName: string,
  serverName: string | undefined,
  input: unknown
): boolean {
  if (/^(?:bash|browser_(?:click|type|press|select))$/.test(toolName))
    return true
  if (
    /(?:^|_)(?:approve|grant|permission|create|update|modify|delete|remove|kill|stop|uninstall|shutdown|reboot|format|drop|merge|send|transfer|purchase|payment|publish|deploy|push|execute|exec|run|shell|terminal|upload|move|rename|replace|install)(?:_|$)/i.test(
      toolName
    )
  )
    return true
  const action =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).action
      : undefined
  if (
    typeof action === 'string' &&
    /^(?:create|update|modify|delete|remove|kill|stop|uninstall|shutdown|reboot|format|drop|merge|send|transfer|purchase|payment|publish|deploy|push|execute|exec|run|upload|move|rename|replace|install)$/i.test(
      action
    )
  )
    return true
  return (
    !!serverName &&
    !/^(?:list|get|read|search|find|fetch|query|inspect|describe|status|view|preview)(?:_|$)/i.test(
      toolName
    )
  )
}

/** A configured remote's name, not a URL or a path (`.`, `..`, `a/b`, `host:x`). */
const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const PUSH_TARGET_OPTIONS = ['--repo', '--receive-pack', '--exec']

/**
 * Whether "Allow all temporarily" may cover this call. It is for routine
 * publishing to a remote the repository already has: a push to a configured
 * remote NAME (never a URL or path, which could send the work anywhere), or a
 * `gh` call that acts on an existing repository. Anything that creates,
 * reconfigures, or merges on GitHub (`gh repo *`, `gh pr merge`, `gh release
 * *`) keeps prompting, and so does everything destructive.
 */
export function canTemporarilyAllowGit(
  toolName: string,
  input: unknown,
  threadIsEphemeral = false
): boolean {
  if (threadIsEphemeral || toolName !== GIT_TOOL_NAME) return false
  const planned = planGitTool(input)
  if (!planned.ok) return false
  const { plan } = planned
  if (plan.class !== 'remote' || plan.destructive !== undefined) return false
  if (plan.program === 'gh') {
    const [group, action] = plan.args
    if (group === 'repo' || group === 'release') return false
    if (group === 'pr' && action === 'merge') return false
    return true
  }
  const retargeted = plan.args.some((a) =>
    PUSH_TARGET_OPTIONS.some((o) => a === o || a.startsWith(`${o}=`))
  )
  if (retargeted) return false
  return plan.remote === undefined || REMOTE_NAME.test(plan.remote)
}

/** Longest reason handed to the model; the Rust side caps the same way. */
export const REFUSAL_REASON_MAX_CHARS = 500

/** A typed reason as it is stored: control characters to spaces, trimmed, capped. */
export function cleanRefusalReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  // eslint-disable-next-line no-control-regex
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return cleaned ? Array.from(cleaned).slice(0, REFUSAL_REASON_MAX_CHARS).join('') : undefined
}
