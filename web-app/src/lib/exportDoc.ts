/**
 * Build an `ExportDoc` from what the app holds: a chat thread's stored
 * messages, a Cowork session's transcript, or one message as the chat renders
 * it. Pure; `now` is passed in so the result is deterministic.
 */
import type { UIMessage } from 'ai'
import type { ThreadMessage } from '@janhq/core'
import {
  activePathOf,
  allBranchPaths,
  getSiblings,
  hasBranching,
  pickActiveChild,
} from '@/lib/message-branching'
import { extractFilesFromPrompt } from '@/lib/fileMetadata'
import type { CoworkTurn } from '@/types/coworkSession'
import type { ExportDoc, ExportMessage, ExportTool } from '@/lib/exportMarkdown'

const UNTITLED = 'New conversation'

const titleOf = (title: string | undefined) => title?.trim() || UNTITLED

/** The stored thread, kept to the fields an export needs. */
export type ExportThread = {
  id: string
  title?: string
  model?: { id?: string } | null
  metadata?: Record<string, unknown> | null
}

export type ThreadDocOptions = {
  /** Nest the other versions of each edited or regenerated message. */
  allVersions?: boolean
}

const isTurn = (m: ThreadMessage) => m.role === 'user' || m.role === 'assistant'

/** A version and what followed it on its own active line. */
function lineFrom(all: ThreadMessage[], start: ThreadMessage): ThreadMessage[] {
  const line: ThreadMessage[] = []
  const seen = new Set<string>()
  for (let n: ThreadMessage | undefined = start; n && !seen.has(n.id); ) {
    seen.add(n.id)
    line.push(n)
    n = pickActiveChild(all, n)
  }
  return line
}

/**
 * A chat thread. By default the branch on screen: the stored list also holds
 * every edited and regenerated version, and exporting them all in a row would
 * read as a conversation that never happened. `allVersions` keeps the shown
 * branch and nests the other versions under the message they replace. System
 * and tool rows are dropped.
 */
export function docFromThread(
  thread: ExportThread,
  messages: readonly ThreadMessage[],
  now: Date,
  options: ThreadDocOptions = {}
): ExportDoc {
  const all = [...messages]
  const branched = hasBranching(all)
  const path = activePathOf(all, thread.metadata)
  const out: ExportMessage[] = []
  for (const m of path) {
    if (!isTurn(m)) continue
    const entry = fromStored(m)
    if (options.allVersions && branched) {
      const others = getSiblings(all, m)
        .filter((x) => x.id !== m.id)
        .map((v) => lineFrom(all, v).filter(isTurn).map(fromStored))
        .filter((alt) => alt.length > 0)
      if (others.length) entry.alternatives = others
    }
    out.push(entry)
  }
  let branch: ExportDoc['branch']
  if (branched && !options.allVersions) {
    const paths = allBranchPaths(all)
    const leaf = path[path.length - 1]?.id
    const at = paths.findIndex((p) => p[p.length - 1]?.id === leaf)
    if (paths.length > 1 && at >= 0) branch = { index: at + 1, count: paths.length }
  }
  return {
    title: titleOf(thread.title),
    scope: branch ? 'branch' : 'thread',
    exportedAt: now.toISOString(),
    model: thread.model?.id,
    messages: out,
    ...(branch ? { branch } : {}),
  }
}

function fromStored(m: ThreadMessage): ExportMessage {
  const texts: string[] = []
  const reasoning: string[] = []
  const tools: ExportTool[] = []
  let images = 0
  for (const part of m.content ?? []) {
    switch (part.type) {
      case 'text':
        if (part.text?.value) texts.push(part.text.value)
        break
      case 'reasoning':
        if (part.text?.value) reasoning.push(part.text.value)
        break
      case 'image_url':
        images += 1
        break
      case 'tool_call':
        tools.push({
          name: part.tool_name ?? 'tool',
          input: part.input,
          output: part.output,
        })
        break
      default:
        break
    }
  }
  const joined = texts.join('\n\n')
  const { files, cleanPrompt } =
    m.role === 'user'
      ? extractFilesFromPrompt(joined)
      : { files: [], cleanPrompt: joined }
  return {
    role: m.role as ExportMessage['role'],
    text: cleanPrompt,
    reasoning: reasoning.join('\n\n') || undefined,
    files: files.length ? files.map((f) => f.name) : undefined,
    images: images || undefined,
    tools: tools.length ? tools : undefined,
    at: m.created_at ? toMillis(m.created_at) : undefined,
  }
}

/** Stored timestamps are seconds in some paths and milliseconds in others. */
function toMillis(value: number): number {
  return value < 1e11 ? value * 1000 : value
}

/** A Cowork transcript: tool rows fold into the assistant reply they belong to. */
export function docFromCowork(
  session: { id: string; title?: string; turns: readonly CoworkTurn[] },
  now: Date,
  model?: string
): ExportDoc {
  const out: ExportMessage[] = []
  for (const turn of session.turns) {
    if (turn.hidden) continue
    if (turn.role === 'tool') {
      let last = out[out.length - 1]
      if (!last || last.role !== 'assistant') {
        last = { role: 'assistant', text: '', tools: [] }
        out.push(last)
      }
      last.tools = [
        ...(last.tools ?? []),
        {
          name: turn.name ?? 'tool',
          input: turn.args,
          output: turn.result,
          isError: turn.isError || turn.toolState === 'failed',
        },
      ]
      continue
    }
    out.push({
      role: turn.role,
      text: turn.content ?? '',
      images: turn.images?.length || undefined,
    })
  }
  return {
    title: titleOf(session.title),
    scope: 'session',
    exportedAt: now.toISOString(),
    model,
    messages: out,
  }
}

type LoosePart = {
  type: string
  text?: string
  filename?: string
  toolName?: string
  input?: unknown
  output?: unknown
  errorText?: string
  state?: string
}

function oneLineSnippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat
}

/** One message as the chat renders it (a `UIMessage`). */
export function docFromUIMessage(
  message: UIMessage,
  title: string | undefined,
  now: Date
): ExportDoc {
  const texts: string[] = []
  const reasoning: string[] = []
  const tools: ExportTool[] = []
  const files: string[] = []
  let images = 0
  for (const raw of message.parts ?? []) {
    const part = raw as LoosePart
    if (part.type === 'text') {
      if (part.text) texts.push(part.text)
    } else if (part.type === 'reasoning') {
      if (part.text) reasoning.push(part.text)
    } else if (part.type === 'file') {
      if (part.filename) files.push(part.filename)
      else images += 1
    } else if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      tools.push({
        name: part.toolName ?? part.type.replace(/^tool-/, ''),
        input: part.input,
        output: part.output ?? part.errorText,
        isError: part.state === 'output-error',
      })
    }
  }
  const joined = texts.join('\n')
  const meta = message.metadata as { createdAt?: Date | string | number } | undefined
  const created = meta?.createdAt ? new Date(meta.createdAt).getTime() : NaN
  const extracted =
    message.role === 'user'
      ? extractFilesFromPrompt(joined)
      : { files: [], cleanPrompt: joined }
  files.push(...extracted.files.map((f) => f.name))
  const role: ExportMessage['role'] =
    message.role === 'system' ? 'system' : message.role
  const snippet = oneLineSnippet(extracted.cleanPrompt)
  return {
    title: title?.trim() || snippet || 'Message',
    scope: 'message',
    exportedAt: now.toISOString(),
    messages: [
      {
        role,
        text: extracted.cleanPrompt,
        reasoning: reasoning.join('\n\n') || undefined,
        files: files.length ? files : undefined,
        images: images || undefined,
        tools: tools.length ? tools : undefined,
        at: Number.isFinite(created) ? created : undefined,
      },
    ],
  }
}
