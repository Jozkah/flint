/**
 * Plain-language description of one tool permission request.
 *
 * Pure: it turns what the approval store already knows about a call (tool
 * name, arguments, server) into what a person needs to decide — what is being
 * asked, what it touches, what allowing it means, and which answers are
 * genuinely available. Copy is returned as i18n keys with values so the
 * `permissions` namespace stays the single source of wording.
 *
 * Nothing here invents intent. A reason is shown only when the caller has one
 * (`taskContext`); otherwise the prompt says what the call does, not why.
 */
import { isPlainObject, parseToolInput } from '@/lib/toolInputSummary'
import {
  ALWAYS_ASK_TOOLS,
  STOP_SESSION_TOOL_NAME,
} from '@/lib/sessionMessagingTools'
import {
  GIT_TOOL_NAME,
  gitAlwaysAsks,
  gitCommandLine,
  planGitTool,
  type GitPlan,
} from '@/lib/gitTool'
import { isSelfApprovalTool } from '@/lib/selfApprovalTools'
import { similarToolCall } from '@/lib/similarToolCall'

export type PermissionCategory =
  | 'file-change'
  | 'command'
  | 'network'
  | 'external-tool'
  | 'git'
  | 'read'
  | 'browser'
  | 'other'

/** Answers that grant something. `deny` is always available and not listed. */
export type ApprovalScope = 'allow-once' | 'allow-thread' | 'allow-always'

/** An i18n key plus its interpolation values. */
export type PermissionMessage = {
  key: string
  values?: Record<string, string | number>
}

export type PermissionRequestInput = {
  toolName: string
  input?: unknown
  serverName?: string
  /** Folder or project the call works in, as a path or a display name. */
  workspaceLabel?: string
  /** Why the call is being made, when the caller actually knows. */
  taskContext?: string
  /**
   * The conversation id is reused by the next conversation (a temporary chat),
   * so a "this conversation" grant would silently carry over. Not offered then.
   */
  threadIsEphemeral?: boolean
  /**
   * The caller will ask about this call every time (a push, a destructive
   * command, the auto-approve pause). Recognized actions may still offer a
   * narrow rule, such as clipboard reads or single-process termination.
   */
  alwaysAsk?: boolean
  /**
   * With `alwaysAsk`: the one program a "this conversation" answer may cover
   * (an unsandboxed NUL rerun of `go`, say). Offers that scope, and only it,
   * besides "Allow once"; the caller keeps the grant, never a standing one.
   */
  conversationProgram?: string
}

/** A short fact shown as a chip beside the category. */
export type PermissionBadge = {
  message: PermissionMessage
  tone: 'neutral' | 'warning' | 'danger'
}

export type ScopeExplanation = {
  label: PermissionMessage
  explanation: PermissionMessage
  /** Wider than the request in front of the user; the UI marks it. */
  broader: boolean
}

export type PermissionRequestDescription = {
  category: PermissionCategory
  categoryLabel: PermissionMessage
  action: PermissionMessage
  /** Paths, command, URL or server, sanitized and truncated. */
  resources: string[]
  reason?: string
  /** Chips such as "Reaches GitHub" or "Destructive". */
  badges?: PermissionBadge[]
  /** The stronger warning shown above the answers for a destructive call. */
  warning?: PermissionMessage
  consequences: PermissionMessage[]
  /** Least broad first. */
  scopesOffered: ApprovalScope[]
  scopeExplanations: Partial<Record<ApprovalScope, ScopeExplanation>>
  technicalDetails: {
    toolName: string
    serverName?: string
    /** Pretty JSON of the arguments, with secrets redacted. */
    argumentsJson: string
  }
}

/** Tool names as used by the built-in agent tools, Cowork and the web tools. */
const FILE_CHANGE_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'memory_write',
  'skill_write',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'move_file',
])
const BROWSER_ACTION_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_select',
])
const COMMAND_TOOLS = new Set(['bash', 'shell', 'run_command', 'execute_command'])
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search'])
const READ_TOOLS = new Set([
  'read',
  'ls',
  'find',
  'grep',
  'memory_list',
  'memory_read',
  'skill_list',
  'skill_read',
  'screenshot',
  'read_file',
  'list_directory',
  'search_files',
])
const HELPER_TOOLS = new Set(['task', 'team'])

export const MAX_RESOURCE_LENGTH = 160
const MAX_ARG_STRING_LENGTH = 500
const MAX_ARGUMENTS_JSON_LENGTH = 4000
const MAX_RESOURCES = 20
export const REDACTED = '[redacted]'

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

/** Key names that mark a value as a credential. Mirrors `audit.rs`. */
const SECRET_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'authorization',
  'auth',
  'credential',
  'private_key',
  'access_key',
  'session_key',
  'cookie',
]

export function namesASecret(key: string): boolean {
  const k = key.replace(/^-+/, '').toLowerCase()
  return SECRET_KEY_PARTS.some((part) => k.includes(part))
}

const TOKEN_PREFIXES = ['sk-', 'sk_live_', 'pk_live_', 'ghp_', 'gho_', 'github_pat_', 'xoxb-', 'xoxp-', 'AKIA']

function looksLikeToken(word: string): boolean {
  if (TOKEN_PREFIXES.some((p) => word.startsWith(p)) && word.length >= 8) {
    return true
  }
  if (word.length < 32) return false
  if (/[/\\\s]/.test(word)) return false
  return /[A-Z]/.test(word) && /[a-z]/.test(word) && /\d/.test(word)
}

/** Redact credential-shaped text: `KEY=value`, bearer tokens, URL secrets. */
export function redactSecrets(text: string): string {
  let out = text
    // user:password@ in a URL
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`)
    // secret-named query parameters
    .replace(
      /([?&][^=&\s#]*(?:token|key|secret|password|auth|sig|signature)[^=&\s#]*=)[^&\s#]+/gi,
      `$1${REDACTED}`
    )
    // Authorization: Bearer xyz / Basic xyz
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${REDACTED}`)
  out = out
    .split(/(\s+)/)
    .map((word) => {
      if (/^\s+$/.test(word) || word === '') return word
      const eq = word.indexOf('=')
      // A URL was handled above, parameter by parameter; treating the whole of
      // it as one KEY=value would swallow everything after the first secret.
      if (eq > 0 && !word.includes('://')) {
        const key = word.slice(0, eq)
        const value = word.slice(eq + 1)
        if (
          value &&
          !value.startsWith(REDACTED) &&
          namesASecret(key.replace(/^["']/, ''))
        ) {
          return `${key}=${REDACTED}`
        }
      }
      const bare = word.replace(/^["'(]+|["'),;]+$/g, '')
      if (bare && bare !== REDACTED && looksLikeToken(bare)) {
        return word.replace(bare, REDACTED)
      }
      return word
    })
    .join('')
  return out
}

export function truncate(text: string, max = MAX_RESOURCE_LENGTH): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** One line, secrets redacted, bounded. */
export function sanitizeResource(text: string, max = MAX_RESOURCE_LENGTH): string {
  return truncate(redactSecrets(text.replace(/\s+/g, ' ').trim()), max)
}

/** Deep copy with secret-named keys and credential-shaped strings redacted. */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '…'
  if (typeof value === 'string') {
    const redacted = redactSecrets(value)
    return redacted.length > MAX_ARG_STRING_LENGTH
      ? `${redacted.slice(0, MAX_ARG_STRING_LENGTH)}… (${redacted.length - MAX_ARG_STRING_LENGTH} more characters)`
      : redacted
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      out[key] =
        namesASecret(key) && v !== null && v !== undefined && v !== ''
          ? REDACTED
          : sanitizeValue(v, depth + 1)
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function categorizeTool(
  toolName: string,
  serverName?: string
): PermissionCategory {
  // A server's tool name is chosen by the server, so it says nothing reliable
  // about what the call does; where it goes is the fact that matters.
  if (serverName) return 'external-tool'
  if (toolName === GIT_TOOL_NAME) return 'git'
  // The assistant acting on a web page in the browser pane (click, type, ...).
  if (BROWSER_ACTION_TOOLS.has(toolName) || toolName === 'browser') return 'browser'
  if (FILE_CHANGE_TOOLS.has(toolName)) return 'file-change'
  if (COMMAND_TOOLS.has(toolName)) return 'command'
  if (NETWORK_TOOLS.has(toolName)) return 'network'
  if (READ_TOOLS.has(toolName)) return 'read'
  return 'other'
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => Boolean(s)) : []

/** Files named inside a patch body (`*** Update File:` or `+++ b/`). */
function pathsInPatch(patch: string): string[] {
  const found: string[] = []
  for (const line of patch.split(/\r?\n/)) {
    const apply = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    const diff = line.match(/^\+\+\+ (?:b\/)?(.+)$/)
    const name = apply?.[1] ?? (diff && diff[1] !== '/dev/null' ? diff[1] : undefined)
    if (name) found.push(name.trim())
  }
  return found
}

function changedPaths(args: Record<string, unknown>): string[] {
  const paths = [
    str(args.path),
    str(args.file_path),
    str(args.filePath),
    ...strings(args.paths),
  ].filter((p): p is string => Boolean(p))
  if (typeof args.patch === 'string') paths.push(...pathsInPatch(args.patch))
  if (typeof args.input === 'string') paths.push(...pathsInPatch(args.input))
  return paths
}

function unique(values: string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) === i)
}

function resourcesFor(
  category: PermissionCategory,
  toolName: string,
  args: Record<string, unknown>,
  serverName?: string
): string[] {
  const generic = [
    str(args.path),
    str(args.file_path),
    str(args.filePath),
    str(args.url),
    str(args.command),
    str(args.pattern),
  ].filter((p): p is string => Boolean(p))

  let raw: string[]
  switch (category) {
    case 'file-change':
      raw = changedPaths(args)
      if (toolName === 'memory_write' || toolName === 'skill_write') {
        const name = str(args.name) ?? str(args.title)
        if (raw.length === 0 && name) raw = [name]
      }
      break
    case 'command':
      raw = [str(args.command) ?? str(args.cmd)].filter(Boolean) as string[]
      break
    case 'network':
      raw = [str(args.url) ?? str(args.query)].filter(Boolean) as string[]
      break
    case 'read':
      raw = generic
      break
    case 'browser':
      // The page in full (its query string is what a prompt must not hide),
      // then the control, as the page's own snapshot labels it.
      raw = [str(args.url), str(args.page), str(args.control) ? `"${str(args.control)}"` : undefined].filter(
        (v): v is string => Boolean(v)
      )
      break
    case 'external-tool':
      raw = [...(serverName ? [serverName] : []), ...generic]
      break
    default:
      if (toolName === STOP_SESSION_TOOL_NAME) {
        raw = [str(args.session) ?? str(args.session_id)].filter(Boolean) as string[]
      } else if (toolName === 'team' && Array.isArray(args.tasks)) {
        raw = args.tasks.flatMap((task) =>
          isPlainObject(task) ? strings(task.writes) : []
        )
      } else {
        raw = [str(args.subagent_name)].filter(Boolean) as string[]
      }
  }
  return unique(raw.map((r) => sanitizeResource(r))).slice(0, MAX_RESOURCES)
}

/** Last path segment of a folder, for "in Forma" rather than a full path. */
export function workspaceName(label?: string): string | undefined {
  const trimmed = label?.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return undefined
  const parts = trimmed.split(/[\\/]/)
  return sanitizeResource(parts[parts.length - 1] || trimmed, 60)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function actionFor(
  category: PermissionCategory,
  toolName: string,
  args: Record<string, unknown>,
  resources: string[],
  serverName: string | undefined,
  workspace: string | undefined
): PermissionMessage {
  const within = (key: string, values: Record<string, string | number> = {}) =>
    workspace
      ? { key: `permissions:action.${key}In`, values: { ...values, workspace } }
      : { key: `permissions:action.${key}`, values }

  switch (category) {
    case 'git': {
      const plan = gitPlanOf(args)
      const command = resources[0] ?? toolName
      if (!plan) return { key: 'permissions:action.gitLocal', values: { command } }
      if (plan.destructive) {
        return { key: 'permissions:action.gitDestructive', values: { command } }
      }
      return plan.class === 'remote'
        ? {
            key: 'permissions:action.gitRemote',
            values: { command, target: plan.program === 'gh' ? 'GitHub' : (plan.remote ?? 'the remote') },
          }
        : within('gitLocal', { command })
    }
    case 'file-change':
      if (toolName === 'memory_write') return { key: 'permissions:action.saveMemory' }
      if (toolName === 'skill_write') return { key: 'permissions:action.saveSkill' }
      if (resources.length === 0) return within('changeFiles')
      if (resources.length === 1)
        return within('changeFile', { target: resources[0] })
      return within('changeManyFiles', { count: resources.length })
    case 'command':
      return within('runCommand')
    case 'network': {
      const url = str(args.url)
      if (url) {
        return {
          key: 'permissions:action.reachSite',
          values: { target: sanitizeResource(hostOf(url), 80) },
        }
      }
      return { key: 'permissions:action.searchWeb' }
    }
    case 'browser': {
      const control = str(args.control)
      const values = {
        control: control ? `"${sanitizeResource(control, 60)}"` : 'the control',
        page: sanitizeResource(str(args.page) ?? 'the open page', 200),
      }
      switch (toolName) {
        case 'browser': {
          const what = [str(args.action), str(args.url) ?? str(args.ref)]
            .filter(Boolean)
            .join(' ')
          return {
            key: 'permissions:action.browserAgent',
            values: { what: sanitizeResource(what || 'an action', 200) },
          }
        }
        case 'browser_click':
          return { key: 'permissions:action.browserClick', values }
        case 'browser_type':
          return {
            key: 'permissions:action.browserType',
            values: { ...values, text: sanitizeResource(str(args.text) ?? '', 60) },
          }
        case 'browser_press':
          return {
            key: 'permissions:action.browserPress',
            values: { ...values, keyName: sanitizeResource(str(args.key) ?? '', 20) },
          }
        default:
          return {
            key: 'permissions:action.browserSelect',
            values: { ...values, value: sanitizeResource(str(args.value) ?? '', 60) },
          }
      }
    }
    case 'external-tool':
      return {
        key: 'permissions:action.useExternalTool',
        values: { tool: toolName, server: serverName ?? '' },
      }
    case 'read':
      return resources[0]
        ? { key: 'permissions:action.readTarget', values: { target: resources[0] } }
        : { key: 'permissions:action.readFiles' }
    default:
      if (toolName === 'clipboard') {
        if (args.action === 'read') return { key: 'permissions:action.readClipboard' }
        if (args.action === 'write') return { key: 'permissions:action.writeClipboard' }
      }
      if (toolName === STOP_SESSION_TOOL_NAME) {
        return {
          key: 'permissions:action.stopSession',
          values: {
            session: sanitizeResource(
              str(args.session) ?? str(args.session_id) ?? '',
              80
            ),
          },
        }
      }
      if (HELPER_TOOLS.has(toolName)) return { key: 'permissions:action.startHelper' }
      return { key: 'permissions:action.useTool', values: { tool: toolName } }
  }
}

function consequencesFor(
  category: PermissionCategory,
  toolName: string,
  args: Record<string, unknown> = {}
): PermissionMessage[] {
  switch (category) {
    case 'git': {
      const plan = gitPlanOf(args)
      const out: PermissionMessage[] = [
        plan?.class === 'remote'
          ? { key: 'permissions:consequence.gitRemote' }
          : { key: 'permissions:consequence.gitLocal' },
      ]
      if (plan?.destructive) out.push({ key: 'permissions:consequence.gitDestructive' })
      return out
    }
    case 'file-change':
      return toolName === 'memory_write' || toolName === 'skill_write'
        ? [
            { key: 'permissions:consequence.fileChange' },
            { key: 'permissions:consequence.memory' },
          ]
        : [{ key: 'permissions:consequence.fileChange' }]
    case 'command':
      return [{ key: 'permissions:consequence.command' }]
    case 'network':
      return [{ key: 'permissions:consequence.network' }]
    case 'external-tool':
      return [{ key: 'permissions:consequence.externalTool' }]
    case 'read':
      return [{ key: 'permissions:consequence.read' }]
    case 'browser':
      return [{ key: 'permissions:consequence.browser' }]
    default:
      if (toolName === 'clipboard') {
        if (args.action === 'read') return [{ key: 'permissions:consequence.readClipboard' }]
        if (args.action === 'write') return [{ key: 'permissions:consequence.writeClipboard' }]
      }
      if (toolName === STOP_SESSION_TOOL_NAME) {
        return [{ key: 'permissions:consequence.stopSession' }]
      }
      return HELPER_TOOLS.has(toolName)
        ? [{ key: 'permissions:consequence.helper' }]
        : [{ key: 'permissions:consequence.unknown' }]
  }
}

/**
 * Which grants the approval store can really keep for this request.
 *
 * - `allow-once`: always.
 * - `allow-thread`: `useToolApproval.approvedTools[threadId]`, persisted. Not
 *   offered when the conversation id is reused (temporary chat).
 * - `allow-always`: for a recognized action, only that action;
 *   for a server tool, the server's trust, recorded with the
 *   backend gate (`mcp_trust_server`); for a tool with no server, the tool name
 *   in `approvedToolsGlobal`, persisted by the renderer store.
 */
export function scopesFor(req: PermissionRequestInput): ApprovalScope[] {
  const scopes: ApprovalScope[] = ['allow-once']
  if (
    !req.serverName &&
    !ALWAYS_ASK_TOOLS.has(req.toolName) &&
    similarToolCall(req.toolName, req.input)
  ) return req.threadIsEphemeral
    ? [...scopes, 'allow-always']
    : [...scopes, 'allow-thread', 'allow-always']
  // Decided call by call: nothing broader can be recorded for these.
  if (
    req.alwaysAsk &&
    req.conversationProgram &&
    !req.threadIsEphemeral &&
    !ALWAYS_ASK_TOOLS.has(req.toolName)
  ) {
    return [...scopes, 'allow-thread']
  }
  if (ALWAYS_ASK_TOOLS.has(req.toolName) || req.alwaysAsk) return scopes
  // A tool that approves commands on its own server: only this prompt may.
  if (req.serverName && isSelfApprovalTool(req.toolName)) return scopes
  // A push, a pull request, a destructive git command: asked every time.
  if (!req.serverName && req.toolName === GIT_TOOL_NAME) {
    const plan = gitPlanOf(
      (() => {
        const parsed = parseToolInput(req.input)
        return isPlainObject(parsed) ? parsed : {}
      })()
    )
    if (plan && gitAlwaysAsks(plan)) return scopes
  }
  if (!req.threadIsEphemeral) scopes.push('allow-thread')
  scopes.push('allow-always')
  return scopes
}

function explain(
  scope: ApprovalScope,
  toolName: string,
  serverName?: string
): ScopeExplanation {
  switch (scope) {
    case 'allow-once':
      return {
        label: { key: 'permissions:scope.allowOnce' },
        explanation: { key: 'permissions:scope.onceExplanation' },
        broader: false,
      }
    case 'allow-thread':
      return {
        label: { key: 'permissions:scope.allowThread' },
        explanation: { key: 'permissions:scope.threadExplanation' },
        broader: false,
      }
    case 'allow-always':
      return serverName
        ? {
            label: {
              key: 'permissions:scope.allowAlwaysServer',
              values: { server: serverName },
            },
            explanation: {
              key: 'permissions:scope.alwaysServerExplanation',
              values: { server: serverName },
            },
            broader: true,
          }
        : {
            label: {
              key: 'permissions:scope.allowAlwaysTool',
              values: { tool: toolName },
            },
            explanation: {
              key: 'permissions:scope.alwaysToolExplanation',
              values: { tool: toolName },
            },
            broader: true,
          }
  }
}

function gitPlanOf(args: Record<string, unknown>): GitPlan | undefined {
  const result = planGitTool(args)
  return result.ok ? result.plan : undefined
}

/** Command, remote, branch and folder of a `git` call, for "Affects". */
function gitResources(args: Record<string, unknown>): string[] {
  const plan = gitPlanOf(args)
  if (!plan) {
    const argv = Array.isArray(args.args) ? args.args.filter((a) => typeof a === 'string') : []
    return [sanitizeResource(gitCommandLine({ program: 'git', args: argv as string[] }))]
  }
  const out = [sanitizeResource(gitCommandLine(plan))]
  if (plan.remote) out.push(sanitizeResource(`${plan.program === 'gh' ? 'repo' : 'remote'} ${plan.remote}`))
  if (plan.branch) out.push(sanitizeResource(`branch ${plan.branch}`))
  if (plan.cwd) out.push(sanitizeResource(`in ${plan.cwd}`))
  return out
}

function gitBadges(args: Record<string, unknown>): PermissionBadge[] {
  const plan = gitPlanOf(args)
  if (!plan) return []
  const badges: PermissionBadge[] = []
  if (plan.reachesRemote && plan.class !== 'read') {
    badges.push({
      message: {
        key: 'permissions:badge.reachesRemote',
        values: { target: plan.program === 'gh' ? 'GitHub' : 'remote' },
      },
      tone: plan.class === 'remote' ? 'warning' : 'neutral',
    })
  }
  if (plan.destructive) {
    badges.push({ message: { key: 'permissions:badge.destructive' }, tone: 'danger' })
  }
  return badges
}

function gitExtras(
  args: Record<string, unknown>
): Pick<PermissionRequestDescription, 'badges' | 'warning'> {
  const plan = gitPlanOf(args)
  const badges = gitBadges(args)
  return {
    ...(badges.length ? { badges } : {}),
    ...(plan?.destructive
      ? { warning: { key: 'permissions:warning.gitDestructive', values: { why: plan.destructive } } }
      : {}),
  }
}

function argumentsJson(input: unknown): string {
  if (input === undefined) return ''
  const parsed = parseToolInput(input)
  let json: string
  try {
    json =
      typeof parsed === 'string'
        ? redactSecrets(parsed)
        : (JSON.stringify(sanitizeValue(parsed), null, 2) ?? '')
  } catch {
    json = ''
  }
  return truncate(json, MAX_ARGUMENTS_JSON_LENGTH)
}

export function describePermissionRequest(
  req: PermissionRequestInput
): PermissionRequestDescription {
  const { toolName, serverName } = req
  const parsed = parseToolInput(req.input)
  const args = isPlainObject(parsed) ? parsed : {}
  const category = categorizeTool(toolName, serverName)
  const resources =
    category === 'git'
      ? gitResources(args)
      : resourcesFor(category, toolName, args, serverName)
  const workspace = workspaceName(req.workspaceLabel)
  const scopesOffered = scopesFor(req)
  const scopeExplanations: Partial<Record<ApprovalScope, ScopeExplanation>> = {}
  for (const scope of scopesOffered) {
    scopeExplanations[scope] = explain(scope, toolName, serverName)
  }
  const similar = !serverName ? similarToolCall(toolName, req.input) : null
  if (similar && scopeExplanations['allow-always']) {
    scopeExplanations['allow-always'] = {
      label: { key: 'permissions:scope.allowSimilar', values: { action: similar.label } },
      explanation: {
        key: similar.key === 'clipboard:read'
          ? 'permissions:scope.allowClipboardReadExplanation'
          : 'permissions:scope.allowSimilarExplanation',
        values: { action: similar.label },
      },
      broader: true,
    }
  }
  if (similar && scopeExplanations['allow-thread']) {
    scopeExplanations['allow-thread'] = {
      label: { key: 'permissions:scope.allowSimilarThread', values: { action: similar.label } },
      explanation: { key: 'permissions:scope.allowSimilarThreadExplanation', values: { action: similar.label } },
      broader: false,
    }
  }
  if (req.alwaysAsk && req.conversationProgram && scopeExplanations['allow-thread']) {
    scopeExplanations['allow-thread'] = {
      label: { key: 'permissions:scope.allowThread' },
      explanation: {
        key: 'permissions:scope.threadProgramExplanation',
        values: { program: req.conversationProgram },
      },
      broader: false,
    }
  }
  // A stop request carries its own reason, written by the agent asking. Shown
  // as the "why" so the user decides with it in front of them.
  const stated =
    toolName === STOP_SESSION_TOOL_NAME ? str(args.reason) : req.taskContext
  const reason = stated?.trim() ? sanitizeResource(stated, 300) : undefined

  return {
    category,
    categoryLabel: { key: `permissions:category.${category}` },
    action: actionFor(category, toolName, args, resources, serverName, workspace),
    resources,
    ...(reason ? { reason } : {}),
    ...(category === 'git' ? gitExtras(args) : {}),
    ...(serverName && isSelfApprovalTool(toolName)
      ? {
          badges: [
            {
              message: { key: 'permissions:badge.selfApproval' },
              tone: 'danger' as const,
            },
          ],
          warning: {
            key: 'permissions:warning.selfApproval',
            values: { tool: toolName, server: serverName },
          },
        }
      : {}),
    consequences: consequencesFor(category, toolName, args),
    scopesOffered,
    scopeExplanations,
    technicalDetails: {
      toolName,
      ...(serverName ? { serverName } : {}),
      argumentsJson: argumentsJson(req.input),
    },
  }
}

/** The full text a request acts on: a command in full, else what it touches. */
export const requestSubject = (
  input: unknown,
  resources: string[]
): string | undefined => {
  const parsed = parseToolInput(input)
  if (isPlainObject(parsed)) {
    for (const key of ['command', 'cmd', 'url', 'query']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return resources.length > 0 ? resources.join('\n') : undefined
}
