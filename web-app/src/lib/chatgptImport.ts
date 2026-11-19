import type { ThreadMessage } from '@janhq/core'
import { ulid } from 'ulidx'
import { newAssistantThreadContent, newUserThreadContent } from '@/lib/completion'
import { i18n } from '@/i18n/react-i18next-compat'

/** One visible turn of a ChatGPT conversation, oldest first. */
export type ImportedMessage = {
  role: 'user' | 'assistant'
  text: string
  /** Unix seconds, when the export carries one. */
  createdAt?: number
}

export type ImportedConversation = {
  title: string
  createdAt?: number
  updatedAt?: number
  messages: ImportedMessage[]
}

type ExportMessage = {
  author?: { role?: string }
  create_time?: number | null
  content?: {
    content_type?: string
    parts?: unknown[]
    text?: string
    language?: string
  }
  metadata?: { is_visually_hidden_from_conversation?: boolean }
}

type ExportNode = {
  id?: string
  parent?: string | null
  children?: string[]
  message?: ExportMessage | null
}

type ExportConversation = {
  title?: string | null
  create_time?: number | null
  update_time?: number | null
  current_node?: string | null
  mapping?: Record<string, ExportNode>
}

const asSeconds = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Kinds that are never part of the visible chat. */
const SKIPPED_CONTENT = /^(thoughts|reasoning_recap|tether_|system_error|execution_output|user_editable_context|model_editable_context|computer_output|sonic_webpage)/

/** The text in one `parts` entry: a string, or an object carrying `text`. */
function partText(part: unknown): string {
  if (typeof part === 'string') return part
  if (part && typeof part === 'object') {
    const text = (part as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return ''
}

/** The readable text of one message, or '' for kinds Flint does not show. */
function messageText(content: ExportMessage['content']): string {
  if (!content) return ''
  const type = content.content_type ?? ''
  if (SKIPPED_CONTENT.test(type)) return ''
  if (type === 'code') {
    const code = content.text?.trim()
    if (!code) return ''
    const language =
      content.language && content.language !== 'unknown' ? content.language : ''
    return '```' + language + '\n' + code + '\n```'
  }
  // text, multimodal_text, and kinds added since: uploaded images are objects
  // without `text`, so only real text survives.
  const fromParts = (content.parts ?? [])
    .map(partText)
    .filter((t) => t.trim())
    .join('\n')
    .trim()
  if (fromParts) return fromParts
  return typeof content.text === 'string' ? content.text.trim() : ''
}

/** Node ids from the root to the conversation's last visible message. */
function mainBranch(conversation: ExportConversation): string[] {
  const mapping = conversation.mapping ?? {}
  const chain: string[] = []
  const seen = new Set<string>()
  let id = conversation.current_node ?? undefined
  if (id && mapping[id]) {
    // Walk up from the node ChatGPT was showing last.
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id)
      chain.push(id)
      id = mapping[id].parent ?? undefined
    }
    return chain.reverse()
  }
  return newestPath(conversation)
}

/** From the root, follow the newest child down to a leaf. */
function newestPath(conversation: ExportConversation): string[] {
  const mapping = conversation.mapping ?? {}
  const chain: string[] = []
  const seen = new Set<string>()
  let node = Object.entries(mapping)
    .map(([key, n]) => ({ ...n, id: n.id ?? key }))
    .find((n) => !n.parent || !mapping[n.parent])
  while (node?.id && !seen.has(node.id)) {
    seen.add(node.id)
    chain.push(node.id)
    const next: string | undefined = node.children?.[node.children.length - 1]
    node = next && mapping[next] ? { ...mapping[next], id: mapping[next].id ?? next } : undefined
  }
  return chain
}

/**
 * Parse the text of a ChatGPT data export's `conversations.json`. Each
 * conversation keeps its main branch (edited or regenerated alternatives are
 * dropped); system, tool and hidden messages are skipped, and a conversation
 * with no visible turns is left out. Throws when the text is not an export.
 */
export function parseChatGptExport(json: string): ImportedConversation[] {
  return parseChatGptExportCounted(json).conversations
}

/** Like {@link parseChatGptExport}, also saying how many conversations the file held. */
export function parseChatGptExportCounted(json: string): {
  conversations: ImportedConversation[]
  total: number
} {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('Not valid JSON')
  }
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    Array.isArray((data as { conversations?: unknown }).conversations)
  ) {
    data = (data as { conversations: unknown[] }).conversations
  }
  if (!Array.isArray(data)) {
    throw new Error('Not a ChatGPT export: expected a list of conversations')
  }
  const out: ImportedConversation[] = []
  let total = 0
  for (const raw of data as ExportConversation[]) {
    if (!raw || typeof raw !== 'object' || !raw.mapping) continue
    total++
    const mapping = raw.mapping
    const visible = (ids: string[]): ImportedMessage[] => {
      const found: ImportedMessage[] = []
      for (const id of ids) {
        const message = mapping[id]?.message
        const role = message?.author?.role
        if (!message || (role !== 'user' && role !== 'assistant')) continue
        if (message.metadata?.is_visually_hidden_from_conversation) continue
        const text = messageText(message.content)
        if (!text) continue
        found.push({ role, text, createdAt: asSeconds(message.create_time) })
      }
      return found
    }
    let messages = visible(mainBranch(raw))
    // current_node can point at a branch with nothing to show; try the path
    // down the newest children from the root before giving up.
    if (messages.length === 0) messages = visible(newestPath(raw))
    if (messages.length === 0) continue
    out.push({
      title: raw.title?.trim() || i18n.t('chat:importedChatTitle'),
      createdAt: asSeconds(raw.create_time),
      updatedAt: asSeconds(raw.update_time),
      messages,
    })
  }
  return { conversations: out, total }
}

type ImportDeps = {
  createThread: (thread: Thread) => Promise<Thread>
  createMessage: (message: ThreadMessage) => Promise<ThreadMessage>
  /** Called after each conversation, imported or not. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Create a Flint thread and its messages for each conversation. A failure in
 * one conversation is counted and skipped so the rest still arrive.
 */
export async function importConversations(
  conversations: ImportedConversation[],
  deps: ImportDeps
): Promise<{ threads: Thread[]; failed: number }> {
  const threads: Thread[] = []
  let failed = 0
  for (const conversation of conversations) {
    try {
      const id = ulid()
      const created = await deps.createThread({
        id,
        title: conversation.title,
        updated:
          conversation.updatedAt ?? conversation.createdAt ?? Date.now() / 1000,
        assistants: [],
        metadata: { importedFrom: 'chatgpt' },
      } as Thread)
      // The backend may assign its own thread id; messages must use that one
      // or they land under a thread that does not exist and the chat is empty.
      const threadId = created?.id ?? id
      // Message files are ordered by created_at; keep it strictly increasing.
      let last = 0
      for (const message of conversation.messages) {
        const wanted = message.createdAt
          ? Math.round(message.createdAt * 1000)
          : last + 1
        last = Math.max(wanted, last + 1)
        const built =
          message.role === 'user'
            ? newUserThreadContent(threadId, message.text)
            : newAssistantThreadContent(threadId, message.text)
        await deps.createMessage({
          ...built,
          created_at: last,
          completed_at: last,
        })
      }
      threads.push(created)
    } catch (error) {
      console.error('Failed to import conversation:', error)
      failed++
    }
    deps.onProgress?.(threads.length + failed, conversations.length)
  }
  return { threads, failed }
}
