/**
 * Why a tool call did not run, in words a person can act on.
 *
 * Tool refusals reach the transcript as plain error text from several places:
 * the chat approval loop, the Cowork dispatcher, the MCP trust gate
 * (`mcp_trust.rs`) and the built-in tool gate (`commands.rs`). This maps the
 * exact wording those produce onto an outcome with a next step. Text that
 * matches nothing returns `null`, so an ordinary tool error is never dressed up
 * as a permission problem.
 */
import type { PermissionMessage } from '@/lib/permissionRequest'

/** What the chat loop records when the user answers "deny". */
export const APPROVAL_DENIED_TEXT = 'Tool execution denied by user'

/** What the chat loop records when the prompt was withdrawn unanswered. */
export const APPROVAL_CANCELLED_TEXT =
  'Tool call cancelled: the conversation stopped before the request was answered'

export type PermissionOutcomeKind =
  | 'denied-by-user'
  | 'cancelled'
  | 'mcp-not-trusted'
  | 'mcp-ticket-rejected'
  | 'policy'
  | 'hidden-state'
  | 'network-off'
  | 'domain-blocked'
  | 'secret-file'
  | 'destructive-git'
  | 'unresolvable-arguments'
  | 'write-outside-workspace'
  | 'approval-unavailable'
  | 'review-mode'
  | 'folder-detached'
  | 'edit-not-confirmed'
  | 'access-unsupported'

export type PermissionOutcome = {
  kind: PermissionOutcomeKind
  message: PermissionMessage
  nextStep?: PermissionMessage
}

type Rule = {
  kind: PermissionOutcomeKind
  pattern: RegExp
  build: (match: RegExpMatchArray) => Omit<PermissionOutcome, 'kind'>
}

const m = (key: string, values?: Record<string, string>): PermissionMessage =>
  values ? { key: `permissions:outcome.${key}`, values } : { key: `permissions:outcome.${key}` }

const RULES: Rule[] = [
  {
    kind: 'cancelled',
    pattern: /conversation stopped before the request was answered/i,
    build: () => ({ message: m('cancelled'), nextStep: m('cancelledNext') }),
  },
  {
    kind: 'denied-by-user',
    // Chat: APPROVAL_DENIED_TEXT. Cowork: coworkDispatch `deniedByUser`.
    pattern: /tool execution denied by user|the user did not allow `/i,
    build: () => ({ message: m('deniedByUser') }),
  },
  {
    kind: 'mcp-not-trusted',
    pattern: /MCP server '([^']+)' is not trusted for this call/,
    build: (x) => ({
      message: m('mcpNotTrusted', { server: x[1] }),
      nextStep: m('mcpNotTrustedNext'),
    }),
  },
  {
    // A ticket from `mcp_allow_once` is single use and lives 300s; either
    // failure produces this refusal, and the text does not say which.
    kind: 'mcp-ticket-rejected',
    pattern: /the authorization for this call to '([^']+)' was not valid/,
    build: (x) => ({
      message: m('mcpTicketRejected', { server: x[1] }),
      nextStep: m('mcpTicketRejectedNext'),
    }),
  },
  {
    kind: 'policy',
    pattern: /tool '[^']*' is denied by policy/,
    build: () => ({ message: m('policy'), nextStep: m('policyNext') }),
  },
  {
    kind: 'hidden-state',
    pattern: /is the agent's own state directory and is hidden/,
    build: () => ({ message: m('hiddenState') }),
  },
  {
    kind: 'network-off',
    pattern: /was refused: this run has no network access/,
    build: () => ({ message: m('networkOff'), nextStep: m('networkOffNext') }),
  },
  {
    kind: 'domain-blocked',
    pattern: /was refused: (\S+) is not a destination this\s+project allows/,
    build: (x) => ({
      message: m('domainBlocked', { host: x[1] }),
      nextStep: m('domainBlockedNext'),
    }),
  },
  {
    kind: 'secret-file',
    pattern: /was refused: (.+?) looks like it holds\s+credentials/,
    build: (x) => ({
      message: m('secretFile', { file: x[1] }),
      nextStep: m('secretFileNext'),
    }),
  },
  {
    kind: 'destructive-git',
    pattern: /destructive git operation\s+\(([^)]+)\)/,
    build: (x) => ({
      message: m('destructiveGit', { op: x[1] }),
      nextStep: m('destructiveGitNext', { op: x[1] }),
    }),
  },
  {
    kind: 'unresolvable-arguments',
    pattern: /could not be resolved to a\s+file, command or destination/,
    build: () => ({ message: m('unresolvable') }),
  },
  {
    kind: 'write-outside-workspace',
    pattern:
      /cannot write outside the agent workspace|tried to write outside the agent workspace/,
    build: () => ({ message: m('writeOutside'), nextStep: m('writeOutsideNext') }),
  },
  {
    kind: 'approval-unavailable',
    pattern: /needs user approval \([^)]*\) and is not available yet/,
    build: () => ({ message: m('approvalUnavailable') }),
  },
  {
    kind: 'review-mode',
    pattern: /tool is disabled in review mode/,
    build: () => ({ message: m('reviewMode'), nextStep: m('reviewModeNext') }),
  },
  {
    kind: 'folder-detached',
    pattern: /The folder this session was working in is no longer attached/,
    build: () => ({
      message: m('folderDetached'),
      nextStep: m('folderDetachedNext'),
    }),
  },
  {
    kind: 'edit-not-confirmed',
    pattern: /editing this folder has not been\s+confirmed for this session/,
    build: () => ({
      message: m('editNotConfirmed'),
      nextStep: m('editNotConfirmedNext'),
    }),
  },
  {
    kind: 'access-unsupported',
    pattern: /the selected access mode is not\s+available in this build/,
    build: () => ({ message: m('accessUnsupported') }),
  },
]

export function classifyPermissionOutcome(
  errorText: string | undefined | null
): PermissionOutcome | null {
  if (!errorText) return null
  for (const rule of RULES) {
    const match = errorText.match(rule.pattern)
    if (match) return { kind: rule.kind, ...rule.build(match) }
  }
  return null
}
