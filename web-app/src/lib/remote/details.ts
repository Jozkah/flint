// Pure mappers from the desktop's own records to the phone's wire shapes
// (protocol.ts). Kept apart from `sources.ts`, which reads the stores, so they
// can be tested with plain data.

import type { UIMessage } from 'ai'
import { toolKind } from '@/lib/toolKind'
import { mainArgOf, toolCallFailed } from '@/lib/activityDetail'
import {
  describePermissionRequest,
  requestSubject,
  type ApprovalScope,
  type PermissionMessage,
} from '@/lib/permissionRequest'
import type { Room } from '@/lib/rooms/types'
import type { TodoList } from '@/types/coworkSession'
import { roomStatus } from './handlers'
import type {
  CoworkDetail,
  CoworkTodo,
  RemoteApproval,
  RemoteToolStep,
  RoomDetail,
} from './protocol'

type ToolLikePart = {
  type: string
  toolName?: string
  toolCallId?: string
  state?: string
  input?: unknown
  output?: unknown
}

const WEB_TOOL = /^web_|^fetch$|browser/

/** Where a Cowork tool came from, as the desktop's timeline row labels it. */
export function toolOrigin(name: string): string {
  if (WEB_TOOL.test(name)) return 'Web'
  const mcp = name.match(/^(?:mcp__)?([A-Za-z0-9-]+)(?:__|\.)[A-Za-z0-9_-]+$/)
  if (mcp) return `MCP · ${mcp[1]}`
  return 'Workspace'
}

/** The tool calls in one UI message, in order. */
export function toolStepsOf(
  message: UIMessage,
  awaiting: ReadonlySet<string> = new Set()
): RemoteToolStep[] {
  const out: RemoteToolStep[] = []
  for (const raw of message.parts ?? []) {
    const part = raw as ToolLikePart
    const isTool = part.type === 'dynamic-tool' || part.type.startsWith('tool-')
    if (!isTool) continue
    const name = part.type === 'dynamic-tool' ? (part.toolName ?? 'tool') : part.type.slice('tool-'.length)
    const id = part.toolCallId ?? `${message.id}:${out.length}`
    const isAwaiting = awaiting.has(id)
    const failed =
      part.state === 'output-error' ||
      part.state === 'output-denied' ||
      (part.state === 'output-available' && toolCallFailed(part.state, part.output))
    const status: RemoteToolStep['status'] = isAwaiting
      ? 'awaiting'
      : failed
        ? 'failed'
        : part.state === 'output-available'
          ? 'done'
          : 'running'
    const arg = mainArgOf(part.input)
    out.push({
      id,
      name,
      kind: toolKind({ name, state: failed ? 'output-error' : part.state, awaitingApproval: isAwaiting }),
      status,
      ...(arg ? { arg } : {}),
      origin: toolOrigin(name),
    })
  }
  return out
}

export function todosOf(list: TodoList | undefined): CoworkTodo[] {
  if (!list) return []
  return list.phases.flatMap((phase) => phase.tasks.map((task) => ({
    text: task.content,
    status: task.status === 'completed' || task.status === 'in_progress' ? task.status : 'pending',
  })))
}

export function coworkDetailOf(session: {
  id: string
  title: string
  folder: string | null
  mode?: 'review' | 'ask' | 'auto'
  planMode?: boolean
  access?: 'review-only' | 'managed-worktree' | 'edit-folder'
  model?: { provider: string; id: string }
  todos?: TodoList
  lastUsage?: { prompt_tokens?: number; completion_tokens?: number }
}): CoworkDetail {
  const group = session.folder?.split(/[\\/]/).filter(Boolean).pop()
  return {
    id: session.id,
    title: session.title,
    status: 'idle',
    folder: session.folder,
    ...(group ? { group } : {}),
    mode: session.mode ?? (session.planMode ? 'review' : 'auto'),
    access: session.access ?? 'review-only',
    model: session.model ? { id: session.model.id, provider: session.model.provider } : null,
    todos: todosOf(session.todos),
    usage: session.lastUsage
      ? { inputTokens: session.lastUsage.prompt_tokens ?? 0, outputTokens: session.lastUsage.completion_tokens ?? 0 }
      : null,
  }
}

export function roomDetailOf(room: Room): RoomDetail {
  return {
    id: room.id,
    title: room.title,
    objective: room.objective,
    status: roomStatus(room.status),
    roomStatus: room.status,
    mode: room.mode,
    participants: room.participants
      .filter((p) => !p.removed)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        model: p.model.id,
        provider: p.model.provider,
        toolAccess: p.toolAccess,
        ...(p.reasoning ? { reasoning: p.reasoning } : {}),
      })),
    moderator: {
      enabled: room.moderator.enabled,
      name: room.moderator.name,
      model: room.moderator.model?.id ?? null,
      ...(room.moderator.model?.provider ? { provider: room.moderator.model.provider } : {}),
    },
    nextSpeakerId: room.nextSpeakerId,
    round: room.round,
    folder: room.folder ?? null,
    limits: {
      maxRounds: room.limits.maxRounds,
      maxTurns: room.limits.maxTurns,
      maxTotalTokens: room.limits.maxTotalTokens,
      maxOutputTokensPerTurn: room.limits.maxOutputTokensPerTurn,
      maxCostUsd: room.limits.maxCostUsd,
      maxDurationMs: room.limits.maxDurationMs,
    },
    usage: {
      turns: room.usage.turns,
      rounds: room.usage.rounds,
      tokens: room.usage.inputTokens + room.usage.outputTokens,
      costUsd: room.usage.costUsd,
      activeMs: room.usage.activeMs,
    },
  }
}

type Translate = (key: string, values?: Record<string, unknown>) => string

const SCOPE_WIRE: Record<ApprovalScope, RemoteApproval['scopes'][number]['scope']> = {
  'allow-once': 'once',
  'allow-thread': 'thread',
  'allow-always': 'always',
}

/** A pending prompt in the words of the desktop's approval card. */
export function approvalOf(
  pending: {
    requestId: string
    threadId: string
    toolName: string
    serverName?: string
    input?: unknown
    workspaceLabel?: string
    taskContext?: string
    threadIsEphemeral?: boolean
    alwaysAsk?: boolean
    conversationProgram?: string
    requestedAt?: number
  },
  t: Translate
): RemoteApproval {
  const req = describePermissionRequest(pending)
  const say = (m: PermissionMessage) => t(m.key, m.values)
  const subject = requestSubject(pending.input, req.resources)
  return {
    requestId: pending.requestId,
    threadId: pending.threadId,
    toolName: pending.toolName,
    ...(pending.serverName ? { serverName: pending.serverName } : {}),
    title: say(req.action),
    ...(subject ? { subject } : {}),
    ...(req.reason ? { why: req.reason } : {}),
    consequences: req.consequences.map(say),
    scopes: req.scopesOffered.flatMap((scope) => {
      const e = req.scopeExplanations[scope]
      return e ? [{ scope: SCOPE_WIRE[scope], label: say(e.label), explanation: say(e.explanation), broader: e.broader }] : []
    }),
    argumentsJson: req.technicalDetails.argumentsJson,
    ...(pending.requestedAt ? { requestedAt: pending.requestedAt } : {}),
  }
}
