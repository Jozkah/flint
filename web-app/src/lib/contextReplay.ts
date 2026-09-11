/**
 * Replaying a past turn's exact context. AH-079.
 *
 * The backend (`core::agent::replay`) owns the record and hands out the
 * payload: a replay begins by naming a snapshot and the session it belongs
 * to, and gets back the stored request, or a typed refusal when that request
 * is not the whole context (no payload was stored, or fields were redacted).
 * This side sends it, unchanged, to the provider the turn used, reads the
 * reply, and reports how it ended. Tool calls in the reply are recorded by
 * name and never run.
 *
 * The request goes through the ordinary provider transport, which snapshots
 * it like any dispatch. The backend compares that snapshot's hash with the
 * original's, so "the model received the same context again" is checked on
 * the record, not assumed here.
 */
import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { errorText } from '@/lib/errorText'
import {
  REPLAY_AGENT,
  runtimeProviderFetch,
  snapshotOf,
} from '@/lib/providerFetch'
import { providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import { getProviderApiType } from '@/lib/providerCaps'
import { useModelProvider } from '@/hooks/useModelProvider'

export type ReplayErrorKind =
  | 'not-found'
  | 'unavailable'
  | 'redacted'
  | 'not-a-chat'
  | 'provider-gone'
  | 'provider-unsupported'
  | 'model-not-running'
  | 'provider-error'
  | 'stream-cut-off'
  | 'unknown-replay'
  | 'abandoned'
  | 'io'

export type ReplayStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'refused'

export type ReplayState = ReplayStatus | 'interrupted'

export type ReplayError = { kind: ReplayErrorKind; message: string }

export type ReplayRecord = {
  id: string
  session: string
  snapshotId: string
  snapshotHash: string
  provider: string
  model: string
  status: ReplayStatus
  startedAt: string
  endedAt: string | null
  replaySnapshotId: string | null
  matched: boolean | null
  text: string
  truncated: boolean
  finishReason: string | null
  toolCalls: string[]
  usage: unknown
  error: ReplayError | null
}

export type ReplayView = ReplayRecord & { state: ReplayState }

type Settle = {
  status: Exclude<ReplayStatus, 'running'>
  text?: string
  finishReason?: string | null
  toolCalls?: string[]
  usage?: unknown
  replaySnapshotId?: string | null
  errorKind?: ReplayErrorKind
  errorMessage?: string
}

/** A provider as replay needs it. */
type ProviderLike = {
  provider: string
  base_url?: string
  api_key?: string
  api_key_fallbacks?: string[]
  custom_header?: { header: string; value: string }[] | null
  api_type?: 'openai' | 'anthropic'
}

export type ReplayDeps = {
  invoke: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>
  fetch: typeof globalThis.fetch
  provider: (name: string) => ProviderLike | undefined
  /** A running local session for a model, if there is one. */
  localSession: (
    provider: string,
    model: string
  ) => Promise<{ port: number; api_key: string } | null>
}

const defaultDeps = (): ReplayDeps => ({
  invoke: (cmd, args) => invoke(cmd, args),
  fetch: runtimeProviderFetch(),
  provider: (name) =>
    useModelProvider.getState().getProviderByName(name) as
      | ProviderLike
      | undefined,
  localSession: async (provider, model) => {
    if (provider !== 'llamacpp') return null
    const { findSessionByModel } = await import(
      '@janhq/tauri-plugin-llamacpp-api'
    )
    return (await findSessionByModel(model)) ?? null
  },
})

/**
 * Replays this window has started and not yet seen end. One whose record says
 * `running` but which is not here was started by a page that has since been
 * reloaded; nothing is reading its reply any more.
 */
const inFlight = new Map<string, AbortController>()

export const useReplayVersion = create<{ version: number; bump: () => void }>()(
  (set) => ({ version: 0, bump: () => set((s) => ({ version: s.version + 1 })) })
)

export function isReplaying(replayId: string): boolean {
  return inFlight.has(replayId)
}

export function cancelReplay(replayId: string): void {
  inFlight.get(replayId)?.abort()
}

export async function listReplays(
  session: string,
  snapshotId: string,
  deps: Pick<ReplayDeps, 'invoke'> = defaultDeps()
): Promise<ReplayView[]> {
  const found = await deps.invoke<ReplayView[]>('agent_replays_list', {
    session,
    snapshotId,
  })
  const views = Array.isArray(found) ? found : []
  // A replay this window no longer holds is recorded as abandoned, so it does
  // not read as still going.
  const stranded = views.filter(
    (v) => v.state === 'running' && !inFlight.has(v.id)
  )
  if (stranded.length === 0) return views
  for (const v of stranded) {
    await settle(deps, session, v.id, {
      status: 'cancelled',
      errorKind: 'abandoned',
      errorMessage: 'the window that started this replay was reloaded before it ended',
    }).catch(() => {})
  }
  return await deps.invoke<ReplayView[]>('agent_replays_list', {
    session,
    snapshotId,
  })
}

function settle(
  deps: Pick<ReplayDeps, 'invoke'>,
  session: string,
  replayId: string,
  outcome: Settle
): Promise<ReplayRecord> {
  return deps.invoke<ReplayRecord>('agent_replay_settle', {
    session,
    replayId,
    outcome,
  })
}

function failureOf(e: unknown): ReplayError {
  if (e && typeof e === 'object' && 'kind' in e && 'message' in e) {
    const f = e as { kind: ReplayErrorKind; message: unknown }
    return { kind: f.kind, message: String(f.message) }
  }
  return { kind: 'io', message: errorText(e) }
}

type Target = { url: string; headers: Record<string, string> }

/** Where the turn's request went, or why it cannot be sent there again. */
async function targetFor(
  deps: ReplayDeps,
  providerName: string,
  model: string
): Promise<Target | ReplayError> {
  const provider = deps.provider(providerName)
  if (!provider) {
    return {
      kind: 'provider-gone',
      message: `${providerName || 'The provider'} is no longer configured, so there is nowhere to send this context`,
    }
  }
  if (getProviderApiType(provider as never) === 'anthropic') {
    return {
      kind: 'provider-unsupported',
      message: `${providerName} speaks the Anthropic wire format; replay sends OpenAI-compatible chat requests only`,
    }
  }
  if (providerName === 'llamacpp') {
    const session = await deps.localSession(providerName, model).catch(() => null)
    if (!session) {
      return {
        kind: 'model-not-running',
        message: `${model} is not running. Start it, then replay; replay does not load a model`,
      }
    }
    return {
      url: `http://localhost:${session.port}/v1/chat/completions`,
      headers: {
        Authorization: `Bearer ${session.api_key}`,
        Origin: 'tauri://localhost',
      },
    }
  }
  if (providerName === 'mlx') {
    return {
      kind: 'provider-unsupported',
      message: 'Replay does not reach MLX sessions yet',
    }
  }
  const headers: Record<string, string> = {}
  for (const h of provider.custom_header ?? []) headers[h.header] = h.value
  const key = providerRemoteApiKeyChain(provider)[0]
  if (key) headers.Authorization = `Bearer ${key}`
  const base = (provider.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '')
  return { url: `${base}/chat/completions`, headers }
}

type Reading = {
  text: string
  finishReason: string | null
  toolCalls: string[]
  usage: unknown
  complete: boolean
}

/** An OpenAI chat-completions reply, streamed or whole. */
export async function readReply(response: Response): Promise<Reading> {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('event-stream')) {
    const body = (await response.json()) as {
      choices?: {
        message?: { content?: string; tool_calls?: { function?: { name?: string } }[] }
        finish_reason?: string
      }[]
      usage?: unknown
    }
    const choice = body.choices?.[0]
    return {
      text: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      toolCalls: (choice?.message?.tool_calls ?? [])
        .map((c) => c.function?.name ?? '')
        .filter(Boolean),
      usage: body.usage ?? null,
      complete: Boolean(choice?.finish_reason),
    }
  }
  const reading: Reading = {
    text: '',
    finishReason: null,
    toolCalls: [],
    usage: null,
    complete: false,
  }
  const names = new Map<number, string>()
  const reader = response.body?.getReader()
  if (!reader) return reading
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  const take = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      done = true
      return
    }
    let chunk: {
      choices?: {
        delta?: {
          content?: string
          tool_calls?: { index?: number; function?: { name?: string } }[]
        }
        finish_reason?: string | null
      }[]
      usage?: unknown
    }
    try {
      chunk = JSON.parse(data)
    } catch {
      return
    }
    if (chunk.usage) reading.usage = chunk.usage
    for (const choice of chunk.choices ?? []) {
      if (choice.delta?.content) reading.text += choice.delta.content
      for (const call of choice.delta?.tool_calls ?? []) {
        const name = call.function?.name
        if (name) names.set(call.index ?? names.size, name)
      }
      if (choice.finish_reason) reading.finishReason = choice.finish_reason
    }
  }
  for (;;) {
    const { value, done: ended } = await reader.read()
    if (ended) break
    buffer += decoder.decode(value, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      take(buffer.slice(0, at).trim())
      buffer = buffer.slice(at + 1)
    }
  }
  if (buffer.trim()) take(buffer.trim())
  reading.toolCalls = [...names.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
  // Finished means the provider said so: a finish reason, or the stream's own
  // end marker. A connection that simply closed is a cut-off reply.
  reading.complete = reading.finishReason !== null || done
  return reading
}

export type ReplayOutcome =
  | { ok: true; record: ReplayRecord }
  | { ok: false; error: ReplayError; record?: ReplayRecord }

/**
 * Replay one snapshot. Resolves when the replay has ended and its ending is
 * recorded; `cancelReplay` stops it part-way.
 */
export async function startReplay(
  session: string,
  snapshotId: string,
  deps: ReplayDeps = defaultDeps()
): Promise<ReplayOutcome> {
  let start: { record: ReplayRecord; payload: unknown }
  try {
    start = await deps.invoke('agent_replay_begin', { session, snapshotId })
  } catch (e) {
    useReplayVersion.getState().bump()
    return { ok: false, error: failureOf(e) }
  }
  const { record, payload } = start
  const controller = new AbortController()
  inFlight.set(record.id, controller)
  useReplayVersion.getState().bump()

  const finish = async (outcome: Settle): Promise<ReplayOutcome> => {
    try {
      const settled = await settle(deps, session, record.id, outcome)
      return outcome.status === 'completed'
        ? { ok: true, record: settled }
        : {
            ok: false,
            record: settled,
            error: settled.error ?? {
              kind: outcome.errorKind ?? 'io',
              message: outcome.errorMessage ?? '',
            },
          }
    } catch (e) {
      return { ok: false, error: failureOf(e) }
    } finally {
      inFlight.delete(record.id)
      useReplayVersion.getState().bump()
    }
  }

  const target = await targetFor(deps, record.provider, record.model)
  if ('kind' in target) {
    return finish({
      status: 'refused',
      errorKind: target.kind,
      errorMessage: target.message,
    })
  }

  let response: Response
  try {
    response = await deps.fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...target.headers,
        'x-jan-session': session,
        'x-jan-run': `replay:${record.id}`,
        'x-jan-agent': REPLAY_AGENT,
        'x-jan-provider': record.provider,
      },
      // Exactly what was stored. Nothing is added, dropped or reordered.
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (e) {
    return finish(
      controller.signal.aborted
        ? { status: 'cancelled', errorKind: 'abandoned', errorMessage: 'stopped before the provider answered' }
        : { status: 'failed', errorKind: 'provider-error', errorMessage: errorText(e) }
    )
  }
  const replaySnapshotId = snapshotOf(response)?.id ?? null

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return finish({
      status: 'failed',
      replaySnapshotId,
      errorKind: 'provider-error',
      errorMessage: `HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
    })
  }

  try {
    const reply = await readReply(response)
    if (controller.signal.aborted) {
      return finish({
        status: 'cancelled',
        text: reply.text,
        replaySnapshotId,
        errorKind: 'abandoned',
        errorMessage: 'stopped part-way through the reply',
      })
    }
    return finish({
      status: reply.complete ? 'completed' : 'failed',
      text: reply.text,
      finishReason: reply.finishReason,
      toolCalls: reply.toolCalls,
      usage: reply.usage,
      replaySnapshotId,
      ...(reply.complete
        ? {}
        : {
            errorKind: 'stream-cut-off' as const,
            errorMessage: 'the reply stopped before the provider said it was finished',
          }),
    })
  } catch (e) {
    return finish(
      controller.signal.aborted
        ? {
            status: 'cancelled',
            replaySnapshotId,
            errorKind: 'abandoned',
            errorMessage: 'stopped part-way through the reply',
          }
        : {
            status: 'failed',
            replaySnapshotId,
            errorKind: 'provider-error',
            errorMessage: errorText(e),
          }
    )
  }
}
