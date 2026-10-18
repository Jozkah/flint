/**
 * Scoped standing approvals, and approvals answered later.
 *
 * "Always allow" on a file change or a shell command used to mean the whole
 * tool, in every project. The prompt's form now offers something narrower --
 * one folder, or one command prefix -- and the backend saves that as a rule for
 * the project, checks it again against the call it was chosen for, and honors
 * it only for calls inside that scope. Nothing here decides what a rule
 * covers: that is `scoped_rules` in the Rust plugin, and this file only asks it.
 */
import { invoke } from '@/lib/previewInvoke'
import { i18n } from '@/i18n/react-i18next-compat'
import type { ApprovalChoice } from '@/hooks/useToolApprovalRequests'

/** How far an approval reaches, as the backend spells it. */
export type ApprovalScopeWire =
  | { type: 'once' }
  | { type: 'run' }
  | { type: 'folder'; dir: string }
  | { type: 'command_prefix'; prefix: string }

export type ScopedRule = {
  id: string
  project: string
  tool: string
  kind: string
  scope: ApprovalScopeWire
  createdAt: number
}

export type DeferredStatus =
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'expired'
  | 'void'
  | 'consumed'

export type DeferredApproval = {
  id: string
  project: string
  session: string
  tool: string
  kind: string
  summary: string
  argsDigest: string
  status: DeferredStatus
  createdAt: number
  expiresAt: number
  answeredAt: number | null
}

/** Built-in tools whose prompt carries the scope form. */
export const SCOPABLE_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'bash',
])

/** The choice that keeps the old meaning of "always": the whole tool. */
export const EVERYWHERE_CHOICE = 'everywhere'

const asArgs = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}

/** Whether a label is an absolute path rather than a display name. */
export function isAbsolutePath(label: string | undefined): label is string {
  return !!label && (/^[a-zA-Z]:[\\/]/.test(label) || label.startsWith('/'))
}

/** The choices the form offers for this call; none when it cannot be asked. */
export async function approvalScopeOptions(
  root: string,
  tool: string,
  input: unknown
): Promise<ApprovalScopeWire[]> {
  try {
    return await invoke<ApprovalScopeWire[]>('agent_approval_scope_options', {
      root,
      tool,
      args: asArgs(input),
    })
  } catch {
    return []
  }
}

/** The saved rule that answers this call, if one does. Never throws. */
export async function checkScopedRule(
  root: string,
  tool: string,
  input: unknown
): Promise<ScopedRule | null> {
  try {
    return (
      (await invoke<ScopedRule | null>('agent_approval_rule_check', {
        root,
        tool,
        args: asArgs(input),
      })) ?? null
    )
  } catch {
    return null
  }
}

/** Save the scope that was picked as a rule. Rejects when the backend refuses it. */
export function addScopedRule(
  root: string,
  tool: string,
  input: unknown,
  scope: ApprovalScopeWire
): Promise<ScopedRule> {
  return invoke<ScopedRule>('agent_approval_rule_add', {
    root,
    tool,
    args: asArgs(input),
    scope,
  })
}

export function listScopedRules(project?: string): Promise<ScopedRule[]> {
  return invoke<ScopedRule[]>('agent_approval_rules_list', {
    project: project ?? null,
  })
}

export function revokeScopedRule(id: string): Promise<boolean> {
  return invoke<boolean>('agent_approval_rule_revoke', { id })
}

export function listDeferred(
  includeSettled = false,
  project?: string
): Promise<DeferredApproval[]> {
  return invoke<DeferredApproval[]>('agent_deferred_list', {
    project: project ?? null,
    includeSettled,
  })
}

export function answerDeferred(
  id: string,
  allow: boolean
): Promise<DeferredApproval> {
  return invoke<DeferredApproval>('agent_deferred_answer', { id, allow })
}

export function discardDeferred(id: string): Promise<boolean> {
  return invoke<boolean>('agent_deferred_discard', { id })
}

/** Stable id of a standing scope as an option of the form. */
export function choiceIdOf(scope: ApprovalScopeWire): string | null {
  if (scope.type === 'folder') return `folder:${scope.dir}`
  if (scope.type === 'command_prefix') return `prefix:${scope.prefix}`
  return null
}

/** The scope an option id stands for, among those the backend offered. */
export function scopeFromChoiceId(
  id: string | undefined,
  options: readonly ApprovalScopeWire[]
): ApprovalScopeWire | null {
  if (!id) return null
  return options.find((o) => choiceIdOf(o) === id) ?? null
}

/** Weight of a standing scope: the deeper folder, the longer prefix, is narrower. */
function reach(scope: ApprovalScopeWire): number {
  if (scope.type === 'folder') return scope.dir.length
  if (scope.type === 'command_prefix')
    return scope.prefix.split(/\s+/).filter(Boolean).length
  return -1
}

/**
 * The form as a choice for the approval card: each folder or prefix the backend
 * offered, then the old whole-tool meaning last. The narrowest standing scope
 * is selected, so a click on "Always" never widens past what was asked.
 * `undefined` when the backend offered no standing scope: the prompt keeps its
 * old shape.
 */
export function buildScopeChoice(
  options: readonly ApprovalScopeWire[],
  tool: string
): ApprovalChoice | undefined {
  const standing = options.filter((o) => choiceIdOf(o) !== null)
  if (standing.length === 0) return undefined
  const narrowest = standing.reduce((a, b) => (reach(b) > reach(a) ? b : a))
  const t = i18n.t.bind(i18n)
  return {
    question: t('permissions:scopeForm.question'),
    defaultId: choiceIdOf(narrowest)!,
    options: [
      ...standing.map((scope) => ({
        id: choiceIdOf(scope)!,
        label:
          scope.type === 'folder'
            ? t('permissions:scopeForm.folder', { dir: scope.dir })
            : t('permissions:scopeForm.prefix', {
                prefix: scope.type === 'command_prefix' ? scope.prefix : '',
              }),
        description:
          scope.type === 'folder'
            ? t('permissions:scopeForm.folderHint')
            : t('permissions:scopeForm.prefixHint'),
      })),
      {
        id: EVERYWHERE_CHOICE,
        label: t('permissions:scopeForm.everywhere', { tool }),
        description: t('permissions:scopeForm.everywhereHint'),
      },
    ],
  }
}

/** A rule's scope in words, for the settings list. */
export function describeScope(scope: ApprovalScopeWire): {
  key: string
  values: Record<string, string>
} {
  switch (scope.type) {
    case 'folder':
      return { key: 'permissions:rules.folder', values: { dir: scope.dir } }
    case 'command_prefix':
      return {
        key: 'permissions:rules.prefix',
        values: { prefix: scope.prefix },
      }
    case 'run':
      return { key: 'permissions:rules.run', values: {} }
    default:
      return { key: 'permissions:rules.once', values: {} }
  }
}
