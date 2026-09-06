/**
 * Where activity events are made, from facts the run already has (AH-201).
 *
 * The run driver calls these at the two moments a tool call is observable: when
 * it starts, and when it settles. Both produce an event with the *same* id -- the
 * provider's tool-call id, scoped to the session -- so the second is an update on
 * the first rather than a second row. That is what makes a row show a spinner and
 * then its result, in place, instead of the timeline growing twice per call.
 *
 * Nothing here infers. Every field comes from the call that is happening or the
 * result that just arrived:
 *
 * - a path comes from the argument that named it, never from parsing prose;
 * - line counts come from counting the diff the tool produced;
 * - an exit code comes from the marker the shell tool itself printed, because
 *   that is where it exists -- there is no separate exit status on the wire;
 * - a duration comes from the clock, measured between the two calls;
 * - a fact the run did not record is left absent rather than filled in to make a
 *   row look complete.
 *
 * Pure, so every classification below is testable without a running agent. The
 * store writes are the caller's business.
 */

import type { CoworkTurn } from '@/types/coworkSession'
import type {
  ActivityEventKind,
  ActivityEventStatus,
  GitDetail,
  IncomingActivityEvent,
} from './activityEvents'

/** What a recorder needs to know about the run an event belongs to. */
export type ActivityRunContext = {
  sessionId: string
  runId: string
  /** The model driving the run, when known. */
  model?: string
  /** The agent producing the event: the parent run, or a named subagent. */
  agentId?: string
}

/** A tool call as the stream reports it. */
export type ObservedCall = {
  callId: string
  toolName: string
  args: unknown
}

/** A settled tool call: what the tool returned. */
export type ObservedOutcome = {
  output: string
  isError?: boolean
  /** Display-only diff text for `write`/`edit`. */
  diff?: string
}

/**
 * The event id for a tool call.
 *
 * Session-scoped, because a provider's call id is unique within a stream and
 * nothing promises more than that: two sessions can hold the same id, and a
 * timeline keyed on the raw id would merge them.
 */
export function activityEventId(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`
}

const stringArg = (args: unknown, key: string): string | undefined => {
  if (!args || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const numberArg = (args: unknown, key: string): number | undefined => {
  if (!args || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The command a shell call runs, from whichever argument carries it. */
export function commandOfArgs(args: unknown): string | undefined {
  return stringArg(args, 'command')
}

/**
 * The kind of event a tool call produces.
 *
 * `write` is split by what the diff says: a diff with no removed lines against a
 * file that did not exist is a create, and everything else is an edit. The
 * distinction matters to a reader -- "created deploy.env" and "edited
 * deploy.env" are different facts -- and the diff header is where it is stated,
 * so it is read there rather than guessed from the tool name.
 */
export function kindForTool(toolName: string, diff?: string): ActivityEventKind {
  switch (toolName) {
    case 'read':
      return 'file.read'
    case 'write':
      return diff?.startsWith('@@ created file @@') ? 'file.created' : 'file.edited'
    case 'edit':
      return 'file.edited'
    case 'bash':
      return 'command'
    case 'task':
    case 'dispatch_subagent':
      return 'task.started'
    default:
      return 'command'
  }
}

/** Commands whose first word says they verify rather than merely run. */
const VERIFICATION: [RegExp, 'test' | 'build' | 'lint' | 'typecheck'][] = [
  [/\b(vitest|jest|pytest|cargo test|go test|npm test|yarn test|pnpm test)\b/, 'test'],
  [/\b(cargo build|go build|npm run build|yarn build|pnpm build|make\b|msbuild|dotnet build)\b/, 'build'],
  [/\b(eslint|clippy|ruff|golangci-lint|prettier --check)\b/, 'lint'],
  [/\b(tsc|mypy|pyright|dotnet? ?format)\b/, 'typecheck'],
]

/** Which kind of verification a command is, if it is one. */
export function verificationKindOf(
  command: string
): 'test' | 'build' | 'lint' | 'typecheck' | undefined {
  for (const [pattern, kind] of VERIFICATION) {
    if (pattern.test(command)) return kind
  }
  return undefined
}

/**
 * The git operation a command performs, if it is git at all.
 *
 * Read from the subcommand rather than from the whole line, so
 * `git log --grep commit` is a `log`, not a `commit`. `destructive` mirrors what
 * the Rust gate classified (AH-046) -- the timeline says a force push was a force
 * push, which is the row a reader looks for after something goes missing.
 */
export function gitDetailOf(command: string): GitDetail | undefined {
  const tokens = command.trim().split(/\s+/)
  const program = tokens[0]?.split(/[\\/]/).pop()?.replace(/\.exe$/, '')
  if (program !== 'git') return undefined

  let subcommand: string | undefined
  let skipValue = false
  for (const token of tokens.slice(1)) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (token.startsWith('-')) {
      const name = token.replace(/^-+/, '').split('=')[0]
      skipValue = !token.includes('=') && ['C', 'c', 'git-dir', 'work-tree'].includes(name)
      continue
    }
    subcommand = token
    break
  }
  if (!subcommand) return { operation: 'other' }

  const known = [
    'status',
    'commit',
    'branch',
    'checkout',
    'push',
    'pull',
    'merge',
    'stash',
  ] as const
  const operation = (known as readonly string[]).includes(subcommand)
    ? (subcommand as GitDetail['operation'])
    : 'other'
  const destructive =
    /--force\b|--force-with-lease|\s-f\b|--hard\b|--mirror\b|\s-D\b|--prune\b/.test(command) ||
    /\bclean\b.*\s-[a-z]*[fxd]/.test(command)
  return destructive ? { operation, destructive: true } : { operation }
}

/**
 * The exit code a shell tool reported, from the `[exit N]` marker it prints.
 *
 * There is no exit status on the wire: the tool encodes it in its output, so this
 * is where the fact is. Absent when the tool did not print one -- a backgrounded
 * command has not exited yet, and inventing a zero would say it succeeded.
 */
export function exitCodeOf(output: string): number | undefined {
  const match = /\[exit (-?\d+)\]/.exec(output)
  return match ? Number(match[1]) : undefined
}

/** Added and removed line counts from a line-prefixed diff. */
export function diffLineCounts(diff: string | undefined): {
  added?: number
  removed?: number
} {
  if (!diff) return {}
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/** The background job id a shell call was handed, if it backgrounded itself. */
export function jobIdOf(output: string): string | undefined {
  const match = /\[job ([A-Za-z0-9_-]+)\]/.exec(output)
  return match ? match[1] : undefined
}

/** A one-line title for a call, derived from the action and never from prose. */
export function titleForCall(toolName: string, args: unknown): string {
  const path = stringArg(args, 'path') ?? stringArg(args, 'file_path')
  switch (toolName) {
    case 'read':
      return path ? `Read ${path}` : 'Read a file'
    case 'write':
      return path ? `Wrote ${path}` : 'Wrote a file'
    case 'edit':
      return path ? `Edited ${path}` : 'Edited a file'
    case 'bash': {
      const command = commandOfArgs(args)
      if (!command) return 'Ran a command'
      const git = gitDetailOf(command)
      if (git) return `git ${git.operation}`
      const verification = verificationKindOf(command)
      if (verification) {
        const label =
          verification === 'test'
            ? 'tests'
            : verification === 'build'
              ? 'build'
              : verification === 'lint'
                ? 'lint'
                : 'typecheck'
        return `Ran ${label}`
      }
      return `Ran ${command.split('\n')[0]}`
    }
    case 'task':
    case 'dispatch_subagent':
      return `Dispatched ${stringArg(args, 'subagent_name') ?? stringArg(args, 'name') ?? 'a subagent'}`
    case 'grep':
      return `Searched for ${stringArg(args, 'pattern') ?? 'a pattern'}`
    case 'find':
      return `Found files matching ${stringArg(args, 'pattern') ?? 'a pattern'}`
    case 'ls':
      return path ? `Listed ${path}` : 'Listed a directory'
    default:
      return toolName
  }
}

/** The event for a call that has just started, before its result exists. */
export function pendingEventFor(
  run: ActivityRunContext,
  call: ObservedCall,
  at: number
): IncomingActivityEvent {
  const path = stringArg(call.args, 'path') ?? stringArg(call.args, 'file_path')
  const command = commandOfArgs(call.args)
  const base = {
    id: activityEventId(run.sessionId, call.callId),
    at,
    sessionId: run.sessionId,
    runId: run.runId,
    agentId: run.agentId,
    modelId: run.model,
    callId: call.callId,
    status: 'pending' as ActivityEventStatus,
    title: titleForCall(call.toolName, call.args),
  }

  if (call.toolName === 'read') {
    const from = numberArg(call.args, 'offset')
    const limit = numberArg(call.args, 'limit')
    return {
      ...base,
      kind: 'file.read',
      detail: {
        kind: 'read',
        read: {
          path: path ?? '',
          fromLine: from,
          toLine: from !== undefined && limit !== undefined ? from + limit - 1 : undefined,
        },
      },
    }
  }
  if (call.toolName === 'write' || call.toolName === 'edit') {
    return {
      ...base,
      // Which of create/edit it is cannot be known until the diff exists, so it
      // starts as an edit and the settle pass corrects it.
      kind: 'file.edited',
      detail: { kind: 'change', change: { path: path ?? '' } },
    }
  }
  if (command !== undefined) {
    const git = gitDetailOf(command)
    if (git) return { ...base, kind: 'git', detail: { kind: 'git', git } }
    const verification = verificationKindOf(command)
    if (verification) {
      return {
        ...base,
        kind: 'verification',
        detail: { kind: 'verification', verification: { tool: verification, command } },
      }
    }
    return { ...base, kind: 'command', detail: { kind: 'command', command: { command } } }
  }
  return {
    ...base,
    kind: kindForTool(call.toolName),
    detail: { kind: 'none' },
  }
}

/**
 * The event for a call that has settled: the same id, so it updates the pending
 * row in place.
 *
 * `startedAt` is the time the pending row was recorded; a duration is reported
 * only when it is known, because a made-up one would be worse than none.
 */
export function settledEventFor(
  run: ActivityRunContext,
  turn: Pick<CoworkTurn, 'callId' | 'name' | 'args'>,
  outcome: ObservedOutcome,
  at: number,
  startedAt?: number
): IncomingActivityEvent | null {
  const callId = turn.callId
  const toolName = turn.name
  if (!callId || !toolName) return null

  const status: ActivityEventStatus = outcome.isError ? 'error' : 'ok'
  const durationMs = startedAt !== undefined ? Math.max(0, at - startedAt) : undefined
  const base = {
    id: activityEventId(run.sessionId, callId),
    at,
    sessionId: run.sessionId,
    runId: run.runId,
    agentId: run.agentId,
    modelId: run.model,
    callId,
    status,
    title: titleForCall(toolName, turn.args),
  }

  if (toolName === 'read') {
    return {
      ...base,
      kind: 'file.read',
      detail: {
        kind: 'read',
        read: {
          path: stringArg(turn.args, 'path') ?? '',
          lines: outcome.output ? outcome.output.split('\n').length : undefined,
          truncated: /\[truncated\]/i.test(outcome.output),
        },
      },
    }
  }

  if (toolName === 'write' || toolName === 'edit') {
    const { added, removed } = diffLineCounts(outcome.diff)
    return {
      ...base,
      kind: kindForTool(toolName, outcome.diff),
      detail: {
        kind: 'change',
        change: {
          path: stringArg(turn.args, 'path') ?? '',
          diff: outcome.diff,
          added,
          removed,
        },
      },
    }
  }

  const command = commandOfArgs(turn.args)
  if (command !== undefined) {
    const shared = {
      command,
      exitCode: exitCodeOf(outcome.output),
      durationMs,
      stdout: outcome.output,
      jobId: jobIdOf(outcome.output),
      background: Boolean(jobIdOf(outcome.output)),
    }
    const git = gitDetailOf(command)
    if (git) {
      return { ...base, kind: 'git', detail: { kind: 'git', git } }
    }
    const verification = verificationKindOf(command)
    if (verification) {
      return {
        ...base,
        kind: 'verification',
        detail: { kind: 'verification', verification: { ...shared, tool: verification } },
      }
    }
    return { ...base, kind: 'command', detail: { kind: 'command', command: shared } }
  }

  return {
    ...base,
    kind: kindForTool(toolName),
    detail: { kind: 'none' },
  }
}

/** The event for a permission request the run is waiting on. */
export function permissionRequestedEvent(
  run: ActivityRunContext,
  request: { requestId: string; tool: string; promptKind: string; resource?: string },
  at: number
): IncomingActivityEvent {
  return {
    id: `${run.sessionId}:perm:${request.requestId}`,
    at,
    sessionId: run.sessionId,
    runId: run.runId,
    agentId: run.agentId,
    status: 'pending',
    kind: 'permission.requested',
    title: `Permission requested for ${request.tool}`,
    detail: {
      kind: 'permission',
      permission: {
        requestId: request.requestId,
        tool: request.tool,
        promptKind: request.promptKind,
        resource: request.resource,
      },
    },
  }
}

/**
 * The event for the decision that answered a request: the same id, so the row
 * becomes the decision rather than a second row beside the question.
 */
export function permissionDecidedEvent(
  run: ActivityRunContext,
  request: {
    requestId: string
    tool: string
    promptKind: string
    resource?: string
    decision: 'allow_once' | 'allow_always' | 'deny' | 'auto_allowed' | 'expired'
    decidedBy?: 'user' | 'policy' | 'timeout' | 'kill_switch'
    scope?: string
  },
  at: number
): IncomingActivityEvent {
  const denied = request.decision === 'deny' || request.decision === 'expired'
  return {
    id: `${run.sessionId}:perm:${request.requestId}`,
    at,
    sessionId: run.sessionId,
    runId: run.runId,
    agentId: run.agentId,
    status: denied ? 'error' : 'ok',
    kind: 'permission.decided',
    title: `Permission ${denied ? 'denied' : 'granted'} for ${request.tool}`,
    detail: { kind: 'permission', permission: { ...request } },
  }
}

/** The event for a run that has started. */
export function runStartedEvent(
  run: ActivityRunContext,
  title: string,
  at: number
): IncomingActivityEvent {
  return {
    id: `${run.sessionId}:run:${run.runId}:start`,
    at,
    sessionId: run.sessionId,
    runId: run.runId,
    modelId: run.model,
    status: 'pending',
    kind: 'run.started',
    title,
    detail: { kind: 'none' },
  }
}

/** The event for a run that has ended, however it ended. */
export function runFinishedEvent(
  run: ActivityRunContext,
  outcome: { status: ActivityEventStatus; reason?: string },
  at: number
): IncomingActivityEvent {
  return {
    id: `${run.sessionId}:run:${run.runId}:end`,
    at,
    sessionId: run.sessionId,
    runId: run.runId,
    modelId: run.model,
    status: outcome.status,
    kind: outcome.status === 'cancelled' ? 'cancelled' : 'run.finished',
    title:
      outcome.status === 'cancelled'
        ? 'Run cancelled'
        : outcome.status === 'error'
          ? 'Run failed'
          : 'Run finished',
    detail: { kind: 'outcome', outcome: { subject: 'run', reason: outcome.reason } },
  }
}

/** The event for a retry, so a reader sees the attempt and not just the result. */
export function retryEvent(
  run: ActivityRunContext,
  subject: string,
  attempt: { attempt: number; of?: number; reason?: string },
  at: number
): IncomingActivityEvent {
  return {
    id: `${run.sessionId}:retry:${subject}:${attempt.attempt}`,
    at,
    sessionId: run.sessionId,
    runId: run.runId,
    agentId: run.agentId,
    status: 'pending',
    kind: 'retry',
    title: `Retrying ${subject} (attempt ${attempt.attempt}${attempt.of ? ` of ${attempt.of}` : ''})`,
    detail: {
      kind: 'outcome',
      outcome: { subject, attempt: attempt.attempt, of: attempt.of, reason: attempt.reason },
    },
  }
}
