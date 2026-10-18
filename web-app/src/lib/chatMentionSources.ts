/**
 * Where mentionable conversations come from (docs/CHAT_MENTIONS.md): chat
 * threads, Cowork sessions and discussion rooms, all read from the app's own
 * local stores. Nothing here touches the network.
 *
 * The `*Snapshot` builders are pure so they can be tested; `listConversations`
 * and `loadSnapshot` are the thin readers over the stores.
 */
import type { ThreadMessage } from '@janhq/core'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useMessages } from '@/hooks/useMessages'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import { useRoomsStore } from '@/lib/rooms/store'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import { messagesFromJournal } from '@/lib/rooms/recovery'
import type { Room, RoomJournalRecord } from '@/lib/rooms/types'
import { activePathOf } from '@/lib/message-branching'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useChatMentionConfig } from '@/hooks/useChatMentionConfig'
import type { ChatReadContext } from '@/lib/chatReadTool'
import {
  MENTION_BLOCK_MARK,
  grantedIdsIn,
  splitMentionBlocks,
  type ConversationEntry,
  type ConversationMessage,
  type ConversationSnapshot,
} from '@/lib/chatMentions'

// ── Pure builders ────────────────────────────────────────────────────────────

/**
 * A user turn as the person wrote it: the mention blocks, the attached-file
 * list and the inlined file contents the composer appended are not part of it.
 * A mention found in a mentioned conversation therefore never reaches the
 * model as a live reference.
 */
export function cleanTurnText(text: string): string {
  let out = text
  let seen = ''
  if (out.includes(MENTION_BLOCK_MARK)) {
    const { clean, mentions } = splitMentionBlocks(out)
    out = clean
    seen = mentions
      .map((m) => `\n[mentioned the ${m.kind} "${m.titleAtSend}"]`)
      .join('')
  }
  const files = out.indexOf('[ATTACHED_FILES]')
  if (files !== -1) out = out.slice(0, files)
  const refs = out.indexOf('\n\n---\nReferenced file contents:')
  if (refs !== -1) out = out.slice(0, refs)
  return (out.trim() + seen).trim()
}

const textOfThreadMessage = (m: ThreadMessage): string =>
  (m.content ?? [])
    // Only spoken text: reasoning and tool parts also carry a text value.
    .filter((c) => c?.type === 'text')
    .map((c) => c?.text?.value ?? '')
    .join('')
    .trim()

export function threadSnapshot(
  thread: { id: string; title: string; metadata?: Record<string, unknown> },
  messages: ThreadMessage[]
): ConversationSnapshot {
  const path = activePathOf(messages, thread.metadata)
  const out: ConversationMessage[] = []
  for (const m of path) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', text: '' })
      continue
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const raw = textOfThreadMessage(m)
    const text = m.role === 'user' ? cleanTurnText(raw) : raw
    const hasImage = (m.content ?? []).some((c) => c.type !== 'text')
    if (!text && !hasImage) continue
    out.push({
      role: m.role,
      text: text || '[attachment]',
    })
  }
  return {
    kind: 'chat',
    id: thread.id,
    title: thread.title,
    project: (thread.metadata as { project?: { name?: string } } | undefined)
      ?.project?.name,
    messages: out,
  }
}

export function sessionSnapshot(session: CoworkSession): ConversationSnapshot {
  const out: ConversationMessage[] = []
  for (const turn of session.turns ?? []) {
    if (turn.role === 'tool') {
      out.push({ role: 'tool', text: '' })
    } else if (turn.role === 'user' || turn.role === 'assistant') {
      const text =
        turn.role === 'user' ? cleanTurnText(turn.content) : turn.content.trim()
      if (text) out.push({ role: turn.role, text })
    }
  }
  return {
    kind: 'session',
    id: session.id,
    title: session.title,
    project: folderName(session.folder),
    messages: out,
  }
}

const SPOKEN = new Set(['speech', 'user', 'synthesis', 'final-position'])

export function roomSnapshot(
  room: Room,
  journal: RoomJournalRecord[]
): ConversationSnapshot {
  const out: ConversationMessage[] = []
  if (room.objective.trim())
    out.push({ role: 'system', speaker: 'Objective', text: room.objective })
  for (const m of messagesFromJournal(room.id, journal)) {
    if (!SPOKEN.has(m.kind)) continue
    const author = m.author as { kind: string; name?: string }
    out.push({
      role: author.kind === 'user' ? 'user' : 'assistant',
      speaker: author.kind === 'user' ? 'user' : (author.name ?? 'moderator'),
      text: m.text,
    })
  }
  return { kind: 'room', id: room.id, title: room.title, messages: out }
}

const folderName = (folder: string | null | undefined): string | undefined =>
  folder ? folder.split(/[\\/]+/).filter(Boolean).pop() : undefined

/** Thread times are in seconds, the others in milliseconds; read both as milliseconds. */
const toMs = (t: number): number => (t < 1e12 ? t * 1000 : t)

const oneLine = (text: string, max = 110) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// ── Stores ───────────────────────────────────────────────────────────────────

type ThreadStats = { count: number; preview: string }
const threadStats = new Map<string, ThreadStats>()

function statsFromMessages(messages: ThreadMessage[]): ThreadStats {
  const spoken = messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && textOfThreadMessage(m)
  )
  const last = spoken[spoken.length - 1]
  return {
    count: spoken.length,
    preview: last ? oneLine(cleanTurnText(textOfThreadMessage(last))) : '',
  }
}

/** Counts and previews for the chats that matter now; bounded, best effort. */
export async function warmThreadStats(limit = 30): Promise<void> {
  const threads = Object.values(useThreads.getState().threads)
    .filter((t) => t.id !== TEMPORARY_CHAT_ID)
    .sort((a, b) => toMs(b.updated) - toMs(a.updated))
    .slice(0, limit)
  const todo = threads.filter((t) => !threadStats.has(t.id))
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(
      todo.slice(i, i + 5).map(async (t) => {
        try {
          const loaded = useMessages.getState().messages[t.id]
          const all =
            loaded ?? (await getServiceHub().messages().fetchMessages(t.id))
          threadStats.set(t.id, statsFromMessages(all))
        } catch {
          // The count stays unknown; the row simply shows less.
        }
      })
    )
  }
}

export function listConversations(): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (const t of Object.values(useThreads.getState().threads)) {
    if (t.id === TEMPORARY_CHAT_ID) continue
    const loaded = useMessages.getState().messages[t.id]
    const stats = loaded?.length ? statsFromMessages(loaded) : threadStats.get(t.id)
    entries.push({
      kind: 'chat',
      id: t.id,
      title: t.title,
      project: t.metadata?.project?.name,
      updated: toMs(t.updated),
      messageCount: stats?.count,
      preview: stats?.preview,
    })
  }
  for (const s of useCoworkSessions.getState().sessions) {
    const spoken = (s.turns ?? []).filter(
      (turn) => turn.role === 'user' || turn.role === 'assistant'
    )
    const last = spoken[spoken.length - 1]
    entries.push({
      kind: 'session',
      id: s.id,
      title: s.title,
      project: folderName(s.folder),
      updated: toMs(s.updated),
      messageCount: spoken.length,
      preview: last ? oneLine(cleanTurnText(last.content)) : '',
    })
  }
  for (const r of useRoomsStore.getState().summaries) {
    entries.push({
      kind: 'room',
      id: r.id,
      title: r.title,
      updated: toMs(r.updatedAt),
      messageCount: r.turns,
      preview: oneLine(r.objective),
      live: r.status === 'running',
    })
  }
  return entries
}

/** The same, with rooms and thread counts loaded first. */
export async function listConversationsAsync(): Promise<ConversationEntry[]> {
  try {
    if (useRoomsStore.getState().summaries.length === 0) {
      const rooms = await getRoomPersistence().listRooms()
      if (rooms.length) useRoomsStore.setState({ summaries: rooms })
    }
  } catch {
    // Rooms are optional: the rest still list.
  }
  await warmThreadStats()
  return listConversations()
}

export async function loadSnapshot(
  entry: Pick<ConversationEntry, 'kind' | 'id'>
): Promise<ConversationSnapshot | null> {
  if (entry.kind === 'chat') {
    const thread = useThreads.getState().threads[entry.id]
    if (!thread) return null
    const loaded = useMessages.getState().messages[entry.id]
    const all =
      loaded?.length
        ? loaded
        : await getServiceHub().messages().fetchMessages(entry.id)
    return threadSnapshot(thread, all)
  }
  if (entry.kind === 'session') {
    const session = useCoworkSessions
      .getState()
      .sessions.find((s) => s.id === entry.id)
    return session ? sessionSnapshot(session) : null
  }
  try {
    const { room, journal } = await getRoomPersistence().getRoom(entry.id)
    return roomSnapshot(room, journal)
  } catch {
    return null
  }
}

/** A session that takes messages from other sessions (the default). */
export const sessionAcceptsMessages = (id: string): boolean =>
  useSessionMessaging.getState().optOut[id] !== true

/**
 * What the model is told about messaging a mentioned session, in agent mode.
 * It is information only: `send_message` keeps its own rules, limits and
 * approvals, and mentioning a session grants nothing.
 */
export function messagingHintFor(
  entry: ConversationEntry,
  tool = 'send_message'
): string | undefined {
  if (entry.kind !== 'session') return undefined
  if (!sessionAcceptsMessages(entry.id))
    return `This session does not accept messages from other sessions.`
  return (
    `Session "${entry.title.replace(/["\r\n]+/g, ' ')}" (id ${entry.id}) can be messaged with ` +
    `${tool}({to: "${entry.id}", message}). The usual limits and approvals for ${tool} still apply; ` +
    `mentioning a session does not grant anything.`
  )
}

/**
 * The conversations the user mentioned in a Cowork session: the blocks in
 * their own turns. Mail from another session and rows Flint wrote are not the
 * user's, so a block inside them grants nothing.
 */
export function grantedForSession(session: CoworkSession): Set<string> {
  return grantedIdsIn(
    (session.turns ?? [])
      .filter((t) => t.role === 'user' && !t.from && !t.hidden)
      .map((t) => t.content)
  )
}

/** The same for a chat thread, from its stored user messages. */
export function grantedForThread(messages: ThreadMessage[]): Set<string> {
  // The message a continued chat opens with is a model-written summary under
  // the user role; a block in it is not something the user mentioned.
  return grantedIdsIn(
    messages
      .filter(
        (m) =>
          m.role === 'user' &&
          !m.metadata?.continuedFrom &&
          !m.metadata?.hidden
      )
      .map(textOfThreadMessage)
  )
}

/** Whether a chat should be offered `chat_read`: it has a mention, or reading is open. */
export function chatReadWanted(threadId: string): boolean {
  return (
    useChatMentionConfig.getState().readAnyConversation ||
    grantedForThread(useMessages.getState().getMessages(threadId)).size > 0
  )
}

/** What `chat_read` needs to run for a Cowork session. */
export function chatReadContextForSession(sessionId: string): ChatReadContext {
  const session = useCoworkSessions
    .getState()
    .sessions.find((s) => s.id === sessionId)
  return {
    granted: session ? grantedForSession(session) : new Set<string>(),
    allowAny: useChatMentionConfig.getState().readAnyConversation,
    currentId: sessionId,
    entries: listConversations,
    load: loadSnapshot,
  }
}

/** What `chat_read` needs to run for a chat thread. */
export function chatReadContextForThread(threadId: string): ChatReadContext {
  return {
    granted: grantedForThread(useMessages.getState().getMessages(threadId)),
    allowAny: useChatMentionConfig.getState().readAnyConversation,
    currentId: threadId,
    entries: listConversations,
    load: loadSnapshot,
  }
}
