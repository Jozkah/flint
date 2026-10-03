// Pure mappers from the desktop's own records to the phone's wire shapes
// (protocol.ts). Kept apart from `sources.ts`, which reads the stores, so they
// can be tested with plain data.

import type { UIMessage } from 'ai'
import { toolKind } from '@/lib/toolKind'
import { canTemporarilyAllowGit } from '@/hooks/useToolApprovalRequests'
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
  RemoteAttachment,
  RemoteMessage,
  RemoteNote,
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
    const input = clipped(part.input)
    const output = clipped(part.output ?? (part as { errorText?: unknown }).errorText)
    out.push({
      id,
      name,
      kind: toolKind({ name, state: failed ? 'output-error' : part.state, awaitingApproval: isAwaiting }),
      status,
      ...(arg ? { arg } : {}),
      origin: toolOrigin(name),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
    })
  }
  return out
}

/** What a tool step shows of a value when opened. */
export const MAX_TOOL_TEXT = 1500
/** A reply's reasoning, as much as a phone needs to follow it. */
export const MAX_REASONING = 6000

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

function clipped(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 1)
    } catch {
      return undefined
    }
  }
  // Inline media would be megabytes of base64 and nothing a phone can read.
  text = text.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/gi, '[media]')
  return text.trim() ? cut(text, MAX_TOOL_TEXT) : undefined
}

type AnyPart = { type: string; text?: string; mediaType?: string; filename?: string; data?: unknown }

const mediaKind = (mime: string | undefined): RemoteAttachment['kind'] =>
  mime?.startsWith('image/') ? 'image' : mime?.startsWith('audio/') ? 'audio' : mime?.startsWith('video/') ? 'video' : 'file'

const KIND_NAME: Record<RemoteAttachment['kind'], string> = { image: 'Image', audio: 'Audio', video: 'Video', file: 'File' }

/** A settled question as one line: what was asked, and what was answered. */
function askNote(data: unknown): RemoteNote | null {
  const ask = data as {
    state?: string
    request?: { questions?: { id: string; question: string }[] }
    answers?: { id: string; selected?: string[]; custom_input?: string }[]
  }
  if (ask?.state !== 'answered' && ask?.state !== 'cancelled') return null
  const questions = ask.request?.questions ?? []
  if (ask.state === 'cancelled') {
    return { kind: 'answered', text: `Skipped: ${questions.map((q) => q.question).join(' · ')}` }
  }
  const lines = questions.map((q) => {
    const a = ask.answers?.find((x) => x.id === q.id)
    const said = a?.custom_input?.trim() || (a?.selected ?? []).join(', ')
    return `${q.question} ${said || '(no answer)'}`
  })
  return lines.length ? { kind: 'answered', text: lines.join('\n') } : null
}

/**
 * What a stored message holds besides its text and tool calls: the reasoning,
 * the files sent with it (names only), and the lines the desktop draws in the
 * transcript (compacted here, stopped by another session, a question and its
 * answer).
 */
export function messageExtrasOf(message: UIMessage): Pick<RemoteMessage, 'reasoning' | 'attachments' | 'notes'> {
  let reasoning = ''
  const attachments: RemoteAttachment[] = []
  const notes: RemoteNote[] = []
  for (const raw of message.parts ?? []) {
    const part = raw as AnyPart
    if (part.type === 'reasoning' && part.text) reasoning += (reasoning ? '\n\n' : '') + part.text
    else if (part.type === 'file') {
      const kind = mediaKind(part.mediaType)
      attachments.push({ name: part.filename?.trim() || KIND_NAME[kind], kind })
    } else if (part.type === 'data-compaction') {
      const n = (part.data as { summarizedCount?: number } | undefined)?.summarizedCount
      notes.push({ kind: 'compaction', text: n ? `Conversation compacted: ${n} earlier messages summarised` : 'Conversation compacted' })
    } else if (part.type === 'data-session-stop') {
      const d = part.data as { fromName?: string; reason?: string } | undefined
      notes.push({ kind: 'stopped', text: `Stopped by ${d?.fromName || 'another session'}${d?.reason ? `: ${cut(d.reason, 300)}` : ''}` })
    } else if (part.type === 'data-ask') {
      const note = askNote(part.data)
      if (note) notes.push(note)
    }
  }
  const thought = reasoning.trim()
  return {
    ...(thought ? { reasoning: cut(thought, MAX_REASONING) } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(notes.length ? { notes } : {}),
  }
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
    origin?: string
    preview?: string
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
    }).concat(
      // The desktop card's "Allow all temporarily" (#45), offered for routine
      // Git remote operations only.
      canTemporarilyAllowGit(pending.toolName, pending.input, pending.threadIsEphemeral === true)
        ? [{ scope: 'temporary' as const, label: t('permissions:scope.allowGitTemporary'), explanation: t('permissions:scope.allowGitTemporaryExplanation'), broader: true }]
        : []
    ),
    argumentsJson: req.technicalDetails.argumentsJson,
    ...(pending.requestedAt ? { requestedAt: pending.requestedAt } : {}),
    ...(pending.origin ? { origin: pending.origin } : {}),
    ...(pending.preview ? { preview: clipPreview(pending.preview) } : {}),
  }
}

/** A diff longer than this is cut: the phone shows the start and says so. */
export const MAX_PREVIEW = 12_000

function clipPreview(diff: string): string {
  return diff.length > MAX_PREVIEW ? `${diff.slice(0, MAX_PREVIEW)}\n… (cut; see the full change on the computer)` : diff
}
