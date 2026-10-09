import type { ThreadMessage } from '@janhq/core'
import { ulid } from 'ulidx'
import { newAssistantThreadContent, newUserThreadContent } from '@/lib/completion'

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

/** The readable text of one message, or '' for kinds Flint does not show. */
function messageText(content: ExportMessage['content']): string {
  if (!content) return ''
  switch (content.content_type) {
    case 'text':
    case 'multimodal_text':
      // Uploaded images are objects in `parts`; only the strings are text.
      return (content.parts ?? [])
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
        .trim()
    case 'code': {
      const code = content.text?.trim()
      if (!code) return ''
      const language =
        content.language && content.language !== 'unknown' ? content.language : ''
      return '```' + language + '\n' + code + '\n```'
    }
    default:
      // Reasoning recaps, browsing and tool output are not part of the chat.
      return ''
  }
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
  // No current_node: follow the newest child down from the root.
  let node = Object.values(mapping).find((n) => !n.parent || !mapping[n.parent])
  while (node?.id && !seen.has(node.id)) {
    seen.add(node.id)
    chain.push(node.id)
    const next: string | undefined = node.children?.[node.children.length - 1]
    node = next ? mapping[next] : undefined
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
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('Not valid JSON')
  }
  if (!Array.isArray(data)) {
    throw new Error('Not a ChatGPT export: expected a list of conversations')
  }
  const out: ImportedConversation[] = []
  for (const raw of data as ExportConversation[]) {
    if (!raw || typeof raw !== 'object' || !raw.mapping) continue
    const messages: ImportedMessage[] = []
    for (const id of mainBranch(raw)) {
      const message = raw.mapping[id]?.message
      const role = message?.author?.role
      if (!message || (role !== 'user' && role !== 'assistant')) continue
      if (message.metadata?.is_visually_hidden_from_conversation) continue
      const text = messageText(message.content)
      if (!text) continue
      messages.push({ role, text, createdAt: asSeconds(message.create_time) })
    }
    if (messages.length === 0) continue
    out.push({
      title: raw.title?.trim() || 'Imported chat',
      createdAt: asSeconds(raw.create_time),
      updatedAt: asSeconds(raw.update_time),
      messages,
    })
  }
  return out
}

type ImportDeps = {
  createThread: (thread: Thread) => Promise<Thread>
  createMessage: (message: ThreadMessage) => Promise<ThreadMessage>
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
      // Message files are ordered by created_at; keep it strictly increasing.
      let last = 0
      for (const message of conversation.messages) {
        const wanted = message.createdAt
          ? Math.round(message.createdAt * 1000)
          : last + 1
        last = Math.max(wanted, last + 1)
        const built =
          message.role === 'user'
            ? newUserThreadContent(id, message.text)
            : newAssistantThreadContent(id, message.text)
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
  }
  return { threads, failed }
}
