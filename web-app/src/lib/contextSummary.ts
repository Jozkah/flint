import type { FileMetadata } from '@/lib/fileMetadata'
import type { Attachment } from '@/types/attachment'
import type {
  MemoryRetrieved,
  MemoryView,
} from '@janhq/tauri-plugin-agent-tools-api'

/**
 * "What JAN is using" for a chat conversation, as data.
 *
 * Every item says how much is actually known about it, because the three are
 * different claims and the chat path records different amounts of each:
 *
 *  - `available`     JAN could use it (an indexed file, an enabled tool);
 *  - `selected`      it was chosen for a request (a memory retrieved for the
 *                    last request, a file attached to a message);
 *  - `included`      it was put into a request (inline file content, the
 *                    assistant instructions, the injected memory block).
 *
 * Chat does not record a per-request payload snapshot (Cowork does), so this
 * never claims more than those sources show, and says when something is not
 * recorded at all.
 */

export type UsageState =
  /** Content placed into the request that attached it. */
  | 'included-with-message'
  /** Sent as the system prompt with every request in this conversation. */
  | 'included-every-request'
  /** Put into the last request sent from this window. */
  | 'included-last-request'
  /** Attached, waiting for the next message. */
  | 'pending-next-message'
  /** Indexed; the model reads parts of it only if it searches. */
  | 'available-on-search'
  /** Offered to the model, which decides whether to use it. */
  | 'available'
  /** Configured but not offered, with a reason. */
  | 'not-offered'
  /** Not observable for this conversation. */
  | 'not-recorded'

export type ContextScope = 'conversation' | 'project' | 'across-chats' | 'app'

export type ContextAction =
  | 'remove-pending-attachment'
  | 'open-memory-settings'
  | 'open-tool-settings'
  | 'open-assistant-settings'
  | 'open-provider-settings'

export interface ContextItem {
  key: string
  label: string
  /** True when `label` is an i18n key suffix rather than user data. */
  labelIsKey?: boolean
  /** Extra, already human-readable fact (file size, model id, tool count). */
  detail?: string
  state: UsageState
  /** i18n key suffix explaining why the state is what it is. */
  reason?: string
  scope?: ContextScope
  action?: ContextAction
}

export interface ContextSection {
  id: 'model' | 'instructions' | 'attachments' | 'memory' | 'tools' | 'payload'
  items: ContextItem[]
  /** i18n key suffix for an empty section's explanation. */
  emptyReason?: string
}

export interface ChatContextInput {
  model: {
    id?: string
    provider?: string
    location: 'local' | 'remote' | 'checking' | 'unknown'
  }
  assistant?: { name?: string; hasInstructions: boolean }
  sentFiles: FileMetadata[]
  pendingFiles: Attachment[]
  /** Files indexed for this conversation; null when they could not be listed. */
  indexedFiles: { id: string; name?: string; chunk_count?: number }[] | null
  temporary: boolean
  /** From the transport; null when nothing has been sent from this window. */
  memory: MemoryRetrieved | null
  memoryViews: MemoryView[]
  tools: {
    modelSupportsTools: boolean
    /** `server::tool` keys the app knows about. */
    known: string[]
    disabled: string[]
  }
}

const SCOPE_BY_MEMORY: Record<MemoryView['scope'], ContextScope> = {
  chat: 'conversation',
  project: 'project',
  user: 'across-chats',
}

function formatSize(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function summarizeChatContext(input: ChatContextInput): ContextSection[] {
  const sections: ContextSection[] = []

  // ---- Model and where it runs ---------------------------------------------
  sections.push({
    id: 'model',
    items: input.model.id
      ? [
          {
            key: 'model',
            label: input.model.id,
            detail: input.model.provider,
            state: 'included-every-request',
            reason: `location.${input.model.location}`,
            scope: 'conversation',
            action: 'open-provider-settings',
          },
        ]
      : [],
    emptyReason: 'noModel',
  })

  // ---- Instructions ----------------------------------------------------------
  sections.push({
    id: 'instructions',
    items: input.assistant?.hasInstructions
      ? [
          {
            key: 'assistant',
            label: input.assistant.name ?? 'Assistant',
            state: 'included-every-request',
            reason: 'assistantInstructions',
            scope: 'conversation',
            action: 'open-assistant-settings',
          },
        ]
      : [],
    // Chat has no project-instruction files; Cowork reads JAN.md/CLAUDE.md.
    emptyReason: 'noInstructions',
  })

  // ---- Attachments -----------------------------------------------------------
  const attachments: ContextItem[] = []
  for (const file of input.pendingFiles) {
    attachments.push({
      key: `pending:${file.id ?? file.name}`,
      label: file.name,
      detail: formatSize(file.size),
      state: 'pending-next-message',
      reason:
        file.injectionMode === 'embeddings' || file.parseMode === 'embeddings'
          ? 'pendingEmbeddings'
          : 'pendingInline',
      scope: 'conversation',
      action: 'remove-pending-attachment',
    })
  }
  const seen = new Set<string>()
  for (const file of input.sentFiles) {
    if (seen.has(file.id)) continue
    seen.add(file.id)
    attachments.push({
      key: `sent:${file.id}`,
      label: file.name,
      detail: formatSize(file.size),
      state:
        file.injectionMode === 'embeddings'
          ? 'available-on-search'
          : 'included-with-message',
      reason:
        file.injectionMode === 'embeddings' ? 'retrievalNotRecorded' : 'inlineSent',
      scope: 'conversation',
    })
  }
  for (const file of input.indexedFiles ?? []) {
    if (seen.has(file.id)) continue
    seen.add(file.id)
    attachments.push({
      key: `indexed:${file.id}`,
      label: file.name ?? file.id,
      state: 'available-on-search',
      reason: 'retrievalNotRecorded',
      scope: 'conversation',
    })
  }
  sections.push({
    id: 'attachments',
    items: attachments,
    emptyReason: input.indexedFiles === null ? 'indexUnavailable' : 'noAttachments',
  })

  // ---- Memory ----------------------------------------------------------------
  const memoryItems: ContextItem[] = []
  if (input.temporary) {
    memoryItems.push({
      key: 'memory:temporary',
      label: 'temporary',
        labelIsKey: true,
      state: 'not-offered',
      reason: 'temporaryChat',
      action: 'open-memory-settings',
    })
  } else if (!input.memory) {
    memoryItems.push({
      key: 'memory:unknown',
      label: 'notSentYet',
        labelIsKey: true,
      state: 'not-recorded',
      reason: 'memoryNotSentYet',
      action: 'open-memory-settings',
    })
  } else {
    const byId = new Map(input.memoryViews.map((v) => [v.id, v]))
    for (const id of input.memory.injectedIds) {
      const view = byId.get(id)
      memoryItems.push({
        key: `memory:${id}`,
        label: view?.preview ?? id,
        state: 'included-last-request',
        reason: view ? 'memoryInjected' : 'memoryDetailsUnavailable',
        scope: view ? SCOPE_BY_MEMORY[view.scope] : undefined,
        action: 'open-memory-settings',
      })
    }
    if (input.memory.conflictIds.length > 0) {
      memoryItems.push({
        key: 'memory:conflicts',
        label: 'conflicts',
        labelIsKey: true,
        detail: String(input.memory.conflictIds.length),
        state: 'not-offered',
        reason: 'memoryConflicts',
        action: 'open-memory-settings',
      })
    }
    if (input.memory.droppedIds.length > 0) {
      memoryItems.push({
        key: 'memory:dropped',
        label: 'dropped',
        labelIsKey: true,
        detail: String(input.memory.droppedIds.length),
        state: 'not-offered',
        reason: 'memoryDropped',
        action: 'open-memory-settings',
      })
    }
  }
  sections.push({ id: 'memory', items: memoryItems, emptyReason: 'noMemory' })

  // ---- Tools -----------------------------------------------------------------
  const disabled = new Set(input.tools.disabled)
  const enabled = input.tools.known.filter((k) => !disabled.has(k))
  const toolItems: ContextItem[] = []
  if (!input.tools.modelSupportsTools) {
    if (input.tools.known.length > 0) {
      toolItems.push({
        key: 'tools:unsupported',
        label: 'tools',
        labelIsKey: true,
        detail: String(input.tools.known.length),
        state: 'not-offered',
        reason: 'modelWithoutTools',
        scope: 'app',
        action: 'open-tool-settings',
      })
    }
  } else {
    for (const key of enabled) {
      const [server, tool] = key.includes('::') ? key.split('::') : ['', key]
      toolItems.push({
        key: `tool:${key}`,
        label: tool,
        detail: server || undefined,
        state: 'available',
        reason: server ? 'toolFromServer' : 'toolBuiltIn',
        scope: 'app',
        action: 'open-tool-settings',
      })
    }
    if (disabled.size > 0) {
      toolItems.push({
        key: 'tools:disabled',
        label: 'disabled',
        labelIsKey: true,
        detail: String(disabled.size),
        state: 'not-offered',
        reason: 'toolsTurnedOff',
        scope: 'app',
        action: 'open-tool-settings',
      })
    }
  }
  sections.push({ id: 'tools', items: toolItems, emptyReason: 'noTools' })

  // ---- Exact payload -----------------------------------------------------------
  sections.push({
    id: 'payload',
    items: [
      {
        key: 'payload',
        label: 'payload',
        labelIsKey: true,
        state: 'not-recorded',
        reason: 'chatPayloadNotRecorded',
      },
    ],
  })

  return sections
}
