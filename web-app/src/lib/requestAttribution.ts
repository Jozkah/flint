/**
 * What one ordinary chat request was assembled from, and how far it got.
 *
 * Built on the existing snapshot path rather than beside it: the Rust
 * transport already captures a redacted copy of every dispatch into
 * `audit/prompts.jsonl`. This record names that copy (id, hash, invocation)
 * and lists *which* memories, tools and files went into the request -- ids
 * only, never their content, and never a credential -- so the context panel
 * can check each claim against the snapshot instead of repeating what the
 * renderer intended to send.
 *
 * Send states, in order:
 *
 *  - `assembled`         Flint finished building the request (system prompt,
 *                        memory selection, tool list, messages) and handed it
 *                        to the model client. Nothing has been dispatched.
 *  - `sent`              The provider fetch started: the request reached Flint's
 *                        transport, which snapshots it before dialling.
 *  - `response-started`  The provider answered (response head received). The
 *                        snapshot reference arrives with that head, so this is
 *                        also when `snapshotId` becomes known -- or when it
 *                        becomes known that none was captured.
 *  - `failed`            The dispatch was rejected before or during the
 *                        response (network error, provider error, abort).
 *
 * `usageReported` is set when the provider returned token usage at finish and
 * it was handed to `payload_usage_record`, bound to the same invocation.
 *
 * The boundary this record cannot see past: the snapshot is the JSON body as it
 * left Flint. A provider or adapter may still transform it -- a server applying a
 * chat template (llama.cpp renders messages through the model's Jinja
 * template), a proxy adding its own system text, a hosted API truncating
 * context. "Included" in the panel means present in what Flint sent, not a claim
 * about the tokens the model finally saw.
 */
import type { UIMessage } from '@ai-sdk/react'
import { extractFilesFromPrompt } from '@/lib/fileMetadata'
import {
  addDispatchListener,
  type DispatchEvent,
  type PromptSnapshotRef,
} from '@/lib/providerFetch'
import type { MemoryBinding, ScopedMemoryRetrieved } from '@/lib/memoryBinding'

export type SendState = 'assembled' | 'sent' | 'response-started' | 'failed'

/** Whether a snapshot exists for the request, as far as the renderer knows. */
export type SnapshotStatus = 'pending' | 'captured' | 'not-captured'

export type RequestAttribution = {
  v: 1
  /** Dispatch run id sent as `x-jan-run`; unique per `sendMessages`. */
  requestId: string
  snapshotId: string | null
  snapshotHash: string | null
  invocationId: string | null
  snapshotStatus: SnapshotStatus
  /** ISO time the request was assembled. */
  assembledAt: string
  memory: {
    injectedIds: string[]
    injectedHashes: string[]
    conflictIds: string[]
    droppedIds: string[]
    /** Matched this chat's scope; not necessarily chosen. */
    candidateIds: string[]
    /** Backend identity the retrieval used (`jan-project:<id>` or a folder id). */
    projectId: string | null
    /** The project's display name when the request was assembled. */
    projectName: string | null
    disabled: boolean
    temporary: boolean
    /** Retrieval could not run (no data folder, IPC failure). */
    unavailable: boolean
  }
  /** Tool names advertised in the request. Empty when tools were not offered. */
  tools: string[]
  attachments: {
    /** File ids whose content was placed into a message. */
    inline: string[]
    /** File ids the model could reach only through retrieval tools. */
    availableViaSearch: string[]
  }
  provider: string
  model: string
  sendState: SendState
  usageReported: boolean
}

export function newRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** File ids referenced by the messages a request carries. */
export function attachmentIdsOf(messages: UIMessage[]): RequestAttribution['attachments'] {
  const inline = new Set<string>()
  const search = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const part of message.parts ?? []) {
      if (part.type !== 'text') continue
      for (const file of extractFilesFromPrompt(part.text).files) {
        if (!file.id) continue
        if (file.injectionMode === 'embeddings') search.add(file.id)
        else inline.add(file.id)
      }
    }
  }
  return { inline: [...inline], availableViaSearch: [...search] }
}

export function assembleAttribution(input: {
  requestId: string
  memory: ScopedMemoryRetrieved | null
  binding: MemoryBinding
  tools: string[]
  messages: UIMessage[]
  provider: string
  model: string
  now?: Date
}): RequestAttribution {
  const m = input.memory
  return {
    v: 1,
    requestId: input.requestId,
    snapshotId: null,
    snapshotHash: null,
    invocationId: null,
    snapshotStatus: 'pending',
    assembledAt: (input.now ?? new Date()).toISOString(),
    memory: {
      injectedIds: m?.injectedIds ?? [],
      injectedHashes: m?.injectedHashes ?? [],
      conflictIds: m?.conflictIds ?? [],
      droppedIds: m?.droppedIds ?? [],
      candidateIds: m?.candidateIds ?? [],
      projectId: m?.projectId ?? null,
      projectName: input.binding.janProjectName ?? null,
      disabled: m?.disabled === true,
      temporary: input.binding.temporary,
      unavailable: m == null && !input.binding.temporary,
    },
    tools: [...input.tools],
    attachments: attachmentIdsOf(input.messages),
    provider: input.provider,
    model: input.model,
    sendState: 'assembled',
    usageReported: false,
  }
}

type Listener = (record: RequestAttribution) => void

/**
 * The live records, keyed by request id.
 *
 * One registry for every chat session: dispatch events carry the run id, so a
 * request in one thread is never updated by another thread's traffic. Bounded,
 * because only the last few requests are ever inspected live; what matters
 * after that is what was persisted on the message.
 */
export class AttributionRegistry {
  private records = new Map<string, RequestAttribution>()
  private latestBySession = new Map<string, string>()
  private listeners = new Set<Listener>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly limit = 50) {}

  /** Start following dispatch events. Idempotent. */
  listen(): void {
    if (this.unsubscribe) return
    this.unsubscribe = addDispatchListener((event) => this.onDispatch(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  begin(session: string, record: RequestAttribution): RequestAttribution {
    this.listen()
    this.records.set(record.requestId, record)
    this.latestBySession.set(session, record.requestId)
    while (this.records.size > this.limit) {
      const oldest = this.records.keys().next().value as string
      this.records.delete(oldest)
    }
    this.emit(record)
    return record
  }

  get(requestId: string): RequestAttribution | undefined {
    return this.records.get(requestId)
  }

  latest(session: string): RequestAttribution | undefined {
    const id = this.latestBySession.get(session)
    return id ? this.records.get(id) : undefined
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  fail(requestId: string): void {
    this.update(requestId, (r) =>
      r.sendState === 'failed' ? r : { ...r, sendState: 'failed' }
    )
  }

  markUsageReported(requestId: string): void {
    this.update(requestId, (r) => ({ ...r, usageReported: true }))
  }

  /** Forget a session's records, e.g. when its thread is deleted. */
  forgetSession(session: string): void {
    const id = this.latestBySession.get(session)
    if (id) this.records.delete(id)
    this.latestBySession.delete(session)
  }

  private onDispatch(event: DispatchEvent): void {
    if (!event.run) return
    switch (event.phase) {
      case 'sent':
        this.update(event.run, (r) => ({
          ...r,
          // A retry is a new fetch; the newest invocation is the one whose
          // snapshot will come back.
          invocationId: event.invocation ?? r.invocationId,
          sendState: r.sendState === 'assembled' ? 'sent' : r.sendState,
        }))
        return
      case 'response-started':
        this.update(event.run, (r) => withSnapshot(r, event.snapshot))
        return
      case 'failed':
        this.fail(event.run)
    }
  }

  private update(
    requestId: string,
    change: (r: RequestAttribution) => RequestAttribution
  ): void {
    const current = this.records.get(requestId)
    if (!current) return
    const next = change(current)
    if (next === current) return
    this.records.set(requestId, next)
    this.emit(next)
  }

  private emit(record: RequestAttribution): void {
    for (const listener of this.listeners) listener(record)
  }
}

function withSnapshot(
  record: RequestAttribution,
  snapshot: PromptSnapshotRef | null
): RequestAttribution {
  return {
    ...record,
    sendState: 'response-started',
    snapshotId: snapshot?.id ?? null,
    snapshotHash: snapshot?.hash ?? null,
    invocationId: snapshot?.invocation || record.invocationId,
    snapshotStatus: snapshot ? 'captured' : 'not-captured',
  }
}

/** The app's registry. */
export const requestAttributions = new AttributionRegistry()

/**
 * The message metadata to emit for one stream part of a request.
 *
 * The first part and each step start carry the record as it stands; by a
 * step's start the provider has answered, so the snapshot reference is on it.
 * Other parts carry nothing, which leaves the metadata the SDK merged so far.
 */
export function attributionMetadata(
  registry: AttributionRegistry,
  requestId: string,
  partType: string
): { attribution: RequestAttribution } | undefined {
  if (partType !== 'start' && partType !== 'start-step' && partType !== 'finish') {
    return undefined
  }
  const attribution = registry.get(requestId)
  return attribution ? { attribution } : undefined
}

/**
 * Bind the provider's reported usage to the dispatch it counted.
 *
 * Only when the request has an invocation: the usage log refuses an unbound
 * count, and a count filed against "the thread's last request" is the
 * attribution error it exists to prevent. Returns whether it was submitted.
 */
export function bindUsageAtFinish(input: {
  registry: AttributionRegistry
  requestId: string
  session: string
  model: string
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
  record: (args: {
    session: string
    run: string
    snapshot: PromptSnapshotRef
    model?: string
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }) => Promise<unknown>
}): boolean {
  const attribution = input.registry.get(input.requestId)
  if (!input.usage || !attribution?.invocationId) return false
  void input.record({
    session: input.session,
    run: input.requestId,
    snapshot: {
      id: attribution.snapshotId ?? '',
      hash: attribution.snapshotHash ?? '',
      redactions: 0,
      invocation: attribution.invocationId,
    },
    model: input.model,
    usage: {
      prompt_tokens: input.usage.inputTokens,
      completion_tokens: input.usage.outputTokens,
      total_tokens: input.usage.totalTokens,
    },
  })
  input.registry.markUsageReported(input.requestId)
  return true
}

/** Read a persisted attribution back off a message, if it carries one. */
export function attributionOf(message: { metadata?: unknown } | undefined): RequestAttribution | null {
  const value = (message?.metadata as { attribution?: unknown } | undefined)?.attribution
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<RequestAttribution>
  return record.v === 1 && typeof record.requestId === 'string'
    ? (record as RequestAttribution)
    : null
}
