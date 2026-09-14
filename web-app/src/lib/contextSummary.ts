import type { FileMetadata } from '@/lib/fileMetadata'
import type { Attachment } from '@/types/attachment'
import type { MemoryView } from '@janhq/tauri-plugin-agent-tools-api'
import {
  workspaceProjectIdentity,
  type ScopedMemoryRetrieved,
} from '@/lib/memoryBinding'
import type { RequestAttribution } from '@/lib/requestAttribution'

/**
 * "What JAN is using" for a chat conversation, as data.
 *
 * Every item says how much is actually known about it. The claims are
 * different and are never upgraded without evidence:
 *
 *  - `available`              JAN could use it (an indexed file, an enabled
 *                             tool, a saved memory).
 *  - `retrieved`              A memory whose scope matched this conversation
 *                             for the last request, but that was not chosen
 *                             (it lost to a more specific one, or the budget).
 *  - `selected-last-request`  Chosen for the last request by JAN (a memory the
 *                             backend injected, a tool JAN advertised), and not
 *                             yet verified against the sanitized snapshot.
 *  - `included-last-request`  Verified present in the sanitized snapshot of the
 *                             last request: the memory's id is in its system
 *                             text, the file id is in its payload, the tool
 *                             name is among its declared tools.
 *
 * "Included" is a statement about what JAN sent. A provider or a local engine
 * may still transform the request after that point (a chat template, a proxy),
 * which the panel says in the request section.
 */

export type UsageState =
  /** Verified in the sanitized snapshot of the last request. */
  | 'included-last-request'
  /** Sent as the system prompt with every request in this conversation. */
  | 'included-every-request'
  /** Chosen for the last request; not verified against its snapshot. */
  | 'selected-last-request'
  /** Matched this conversation's scope; not chosen for the last request. */
  | 'retrieved'
  /** Put into the message that attached it; the last request is not verified. */
  | 'attached-to-message'
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
  /** Request lifecycle, for the request section. */
  | 'request-assembled'
  | 'request-sent'
  | 'response-started'
  | 'request-failed'

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
  /** Extra, already human-readable fact (file size, model id, project name). */
  detail?: string
  state: UsageState
  /** i18n key suffix explaining why the state is what it is. */
  reason?: string
  scope?: ContextScope
  action?: ContextAction
}

export interface ContextNotice {
  /** i18n key suffix under `context:notice`. */
  key: string
  /** Interpolation values; a `null` name means "no project". */
  values?: Record<string, string | null>
}

export interface ContextSection {
  id: 'model' | 'instructions' | 'attachments' | 'memory' | 'tools' | 'payload'
  items: ContextItem[]
  /** i18n key suffix for an empty section's explanation. */
  emptyReason?: string
  notices?: ContextNotice[]
  /** The snapshot the "Inspect sanitized request" view should load. */
  snapshotId?: string
}

/**
 * What the sanitized snapshot of the last request lets the panel verify.
 *
 * `loaded` carries only what the checks need: the system text (memory ids),
 * the declared tool names and the serialized payload (file ids). It is derived
 * from the persisted, already-redacted record.
 */
export type SnapshotEvidence =
  | { status: 'none' }
  | { status: 'loading' }
  | {
      status: 'unavailable'
      reason:
        | 'not-captured'
        | 'not-serializable'
        | 'disabled'
        | 'too-large'
        | 'missing'
        | 'error'
    }
  | {
      status: 'loaded'
      systemText: string
      toolNames: string[]
      payloadText: string
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
  /** The last request's memory selection; null when nothing has been sent. */
  memory: ScopedMemoryRetrieved | null
  memoryViews: MemoryView[]
  tools: {
    modelSupportsTools: boolean
    /** `server::tool` keys the app knows about. */
    known: string[]
    disabled: string[]
  }
  /** What the last request was assembled from; null before the first one. */
  attribution?: RequestAttribution | null
  evidence?: SnapshotEvidence
  /** The project this conversation is in now (the next request's scope). */
  currentProject?: { id?: string; name?: string } | null
  /** Name of the project the last request used, when it used one. */
  lastProjectName?: string | null
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

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : ''
      )
      .join('\n')
  }
  return ''
}

/**
 * Turn a persisted snapshot into evidence.
 *
 * Reads both request shapes JAN sends: OpenAI-compatible (`messages[].role ===
 * 'system'`, `tools[].function.name`) and Anthropic (`system`,
 * `tools[].name`).
 */
export function evidenceFromSnapshot(
  snapshot: { payload?: unknown; unavailable?: string | null } | null | undefined
): SnapshotEvidence {
  if (!snapshot) return { status: 'unavailable', reason: 'missing' }
  if (snapshot.unavailable) {
    const reason = snapshot.unavailable
    return {
      status: 'unavailable',
      reason:
        reason === 'not-serializable' || reason === 'disabled' || reason === 'too-large'
          ? reason
          : 'missing',
    }
  }
  const payload = snapshot.payload
  if (!payload || typeof payload !== 'object') {
    return { status: 'unavailable', reason: 'missing' }
  }
  const body = payload as {
    system?: unknown
    messages?: { role?: string; content?: unknown }[]
    tools?: { name?: unknown; function?: { name?: unknown } }[]
  }
  const systemParts: string[] = []
  if (body.system !== undefined) systemParts.push(textOf(body.system))
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === 'system' || message?.role === 'developer') {
      systemParts.push(textOf(message.content))
    }
  }
  const toolNames = (Array.isArray(body.tools) ? body.tools : [])
    .map((tool) => tool?.function?.name ?? tool?.name)
    .filter((name): name is string => typeof name === 'string')
  return {
    status: 'loaded',
    systemText: systemParts.join('\n'),
    toolNames,
    payloadText: JSON.stringify(payload),
  }
}

const REQUEST_STATE: Record<RequestAttribution['sendState'], UsageState> = {
  assembled: 'request-assembled',
  sent: 'request-sent',
  'response-started': 'response-started',
  failed: 'request-failed',
}

export function summarizeChatContext(input: ChatContextInput): ContextSection[] {
  const sections: ContextSection[] = []
  const evidence = input.evidence ?? { status: 'none' }
  const verified = evidence.status === 'loaded' ? evidence : null
  const attribution = input.attribution ?? null

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
    // Chat has no project-instruction files; Cowork reads FLINT.md/CLAUDE.md.
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
    const embedded = file.injectionMode === 'embeddings'
    const inLastRequest = verified ? verified.payloadText.includes(file.id) : false
    attachments.push({
      key: `sent:${file.id}`,
      label: file.name,
      detail: formatSize(file.size),
      state: embedded
        ? 'available-on-search'
        : inLastRequest
          ? 'included-last-request'
          : 'attached-to-message',
      reason: embedded
        ? 'retrievalNotRecorded'
        : inLastRequest
          ? 'inlineVerified'
          : 'inlineSent',
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
  const memoryNotices: ContextNotice[] = []
  const memory = input.memory
  if (input.temporary) {
    memoryItems.push({
      key: 'memory:temporary',
      label: 'temporary',
      labelIsKey: true,
      state: 'not-offered',
      reason: 'temporaryChat',
      action: 'open-memory-settings',
    })
  } else if (!memory) {
    memoryItems.push({
      key: 'memory:unknown',
      label: attribution ? 'memoryUnavailable' : 'notSentYet',
      labelIsKey: true,
      state: 'not-recorded',
      reason: attribution ? 'memoryUnavailable' : 'memoryNotSentYet',
      action: 'open-memory-settings',
    })
  } else if (memory.disabled) {
    memoryItems.push({
      key: 'memory:disabled',
      label: 'memoryDisabled',
      labelIsKey: true,
      state: 'not-offered',
      reason: 'memoryDisabled',
      action: 'open-memory-settings',
    })
  } else {
    const byId = new Map(input.memoryViews.map((v) => [v.id, v]))
    const describe = (id: string) => {
      const view = byId.get(id)
      const scope = view ? SCOPE_BY_MEMORY[view.scope] : undefined
      return {
        label: view?.preview ?? id,
        scope,
        // A project memory names its project, so "this project" is never
        // ambiguous after the conversation moves.
        detail: scope === 'project' ? (input.lastProjectName ?? undefined) : undefined,
      }
    }
    const injected = new Set(memory.injectedIds)
    for (const id of memory.injectedIds) {
      const present = verified ? verified.systemText.includes(`[${id}]`) : false
      memoryItems.push({
        key: `memory:${id}`,
        ...describe(id),
        state: present ? 'included-last-request' : 'selected-last-request',
        reason: present
          ? 'memoryIncludedVerified'
          : verified
            ? 'memoryNotInSnapshot'
            : 'memorySelectedUnverified',
        action: 'open-memory-settings',
      })
    }
    const withheld = new Set([...memory.conflictIds, ...memory.droppedIds])
    for (const id of memory.candidateIds ?? []) {
      if (injected.has(id) || withheld.has(id)) continue
      memoryItems.push({
        key: `memory:${id}`,
        ...describe(id),
        state: 'retrieved',
        reason: 'memoryRetrievedNotChosen',
        action: 'open-memory-settings',
      })
    }
    if (memory.conflictIds.length > 0) {
      memoryItems.push({
        key: 'memory:conflicts',
        label: 'conflicts',
        labelIsKey: true,
        detail: String(memory.conflictIds.length),
        state: 'not-offered',
        reason: 'memoryConflicts',
        action: 'open-memory-settings',
      })
    }
    if (memory.droppedIds.length > 0) {
      memoryItems.push({
        key: 'memory:dropped',
        label: 'dropped',
        labelIsKey: true,
        detail: String(memory.droppedIds.length),
        state: 'not-offered',
        reason: 'memoryDropped',
        action: 'open-memory-settings',
      })
    }
  }
  // The conversation moved (or its project was deleted) after the last
  // request: say which project that request used and what the next one will.
  if (!input.temporary && memory && memory.projectId !== undefined && input.currentProject !== undefined) {
    const nextIdentity = workspaceProjectIdentity({
      janProjectId: input.currentProject?.id,
    })
    if ((memory.projectId ?? null) !== nextIdentity) {
      memoryNotices.push({
        key: 'projectChanged',
        values: {
          previous: memory.projectId ? (input.lastProjectName ?? null) : null,
          current: nextIdentity ? (input.currentProject?.name ?? null) : null,
        },
      })
    }
  }
  sections.push({
    id: 'memory',
    items: memoryItems,
    emptyReason: 'noMemory',
    ...(memoryNotices.length ? { notices: memoryNotices } : {}),
  })

  // ---- Tools -----------------------------------------------------------------
  const disabled = new Set(input.tools.disabled)
  const enabled = input.tools.known.filter((k) => !disabled.has(k))
  const advertised = new Set(attribution?.tools ?? [])
  const toolItems: ContextItem[] = []
  const toolState = (name: string): Pick<ContextItem, 'state' | 'reason'> | null => {
    if (verified) {
      return verified.toolNames.includes(name)
        ? { state: 'included-last-request', reason: 'toolInRequest' }
        : attribution
          ? { state: 'available', reason: 'toolNotInLastRequest' }
          : null
    }
    return advertised.has(name)
      ? { state: 'selected-last-request', reason: 'toolAdvertisedUnverified' }
      : null
  }
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
    const listed = new Set<string>()
    for (const key of enabled) {
      const [server, tool] = key.includes('::') ? key.split('::') : ['', key]
      listed.add(tool)
      toolItems.push({
        key: `tool:${key}`,
        label: tool,
        detail: server || undefined,
        state: 'available',
        reason: server ? 'toolFromServer' : 'toolBuiltIn',
        ...(toolState(tool) ?? {}),
        scope: 'app',
        action: 'open-tool-settings',
      })
    }
    // Built-in tools (agent tools, web search, retrieval) are not in the
    // connection list but can be in the request.
    const requestNames = verified ? verified.toolNames : [...advertised]
    for (const name of requestNames) {
      if (listed.has(name)) continue
      listed.add(name)
      toolItems.push({
        key: `tool:builtin:${name}`,
        label: name,
        state: 'available',
        reason: 'toolBuiltIn',
        ...(toolState(name) ?? {}),
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

  // ---- The request itself ------------------------------------------------------
  const payloadItems: ContextItem[] = []
  const payloadNotices: ContextNotice[] = []
  if (!attribution) {
    payloadItems.push({
      key: 'payload',
      label: 'payload',
      labelIsKey: true,
      state: 'not-recorded',
      reason: 'noRequestYet',
    })
  } else {
    let reason: string
    if (evidence.status === 'loaded') reason = 'snapshotVerified'
    else if (evidence.status === 'unavailable') reason = `snapshotUnavailable.${evidence.reason}`
    else if (attribution.snapshotStatus === 'not-captured') reason = 'snapshotUnavailable.not-captured'
    else if (attribution.sendState === 'failed') reason = 'requestFailed'
    else if (attribution.snapshotStatus === 'captured') reason = 'snapshotRecorded'
    else reason = 'snapshotPending'
    payloadItems.push({
      key: 'payload:request',
      label: 'lastRequest',
      labelIsKey: true,
      detail: [attribution.provider, attribution.model].filter(Boolean).join(' · ') || undefined,
      state: REQUEST_STATE[attribution.sendState],
      reason,
    })
    if (attribution.usageReported) {
      payloadItems.push({
        key: 'payload:usage',
        label: 'usage',
        labelIsKey: true,
        state: 'response-started',
        reason: 'usageRecorded',
      })
    }
    payloadNotices.push({ key: 'adapterBoundary' })
  }
  sections.push({
    id: 'payload',
    items: payloadItems,
    ...(payloadNotices.length ? { notices: payloadNotices } : {}),
    ...(attribution?.snapshotId ? { snapshotId: attribution.snapshotId } : {}),
  })

  return sections
}
