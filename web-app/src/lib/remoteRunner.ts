/**
 * Client for the agent runner of a `flint serve --agent-run` server.
 *
 * P0: a capability probe (`agent_server_info`), the list and transcript of the
 * sessions the server holds, and the replay of one session's events with
 * resume. P1 (the second half of this file): create, start, steer, interrupt,
 * approve, answer a question, and the live event stream with resume. Mapping
 * those events into the Cowork stores is `remoteCowork.ts`. Local desktop
 * sessions never touch this module; it is for a page served by the server
 * (`isServerTransport()`).
 */

import { useEffect, useState } from 'react'
import { isServerTransport } from '@/lib/serverTransportFlag'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type RunnerInfo = {
  /** The review plane is on (`--agent-root`). */
  agent: boolean
  /** The server runs sessions: flag on, runner built, sandbox enforced. */
  runsSessions: boolean
  runsChecks: boolean
  /** Sessions that may write get an isolated checkout the server owns (P2). */
  runsWorktrees: boolean
  /** Campaigns can be run by the server itself, with no client attached (P3). */
  runsCampaigns: boolean
  runRequested: boolean
  runnerPlanned: boolean
  sandbox: string
  enforces: boolean
  roots: string[]
  maxSessions: number
  /** Modes `auto` and `bypass` are allowed (`--agent-allow-bypass`). */
  allowBypass: boolean
  /** A client may grant a standing approval (`--agent-allow-always`). */
  allowAlways: boolean
  approvalTimeoutSecs: number
  liveSessions: number
  /** What to do before sessions can run, in words. */
  missing: string[]
  /** Where the server's loop differs from the desktop's. */
  parityGaps: string[]
}

export type RemoteSession = {
  id: string
  title: string
  folder: string | null
  mode: string | null
  model: string | null
  updated: number | null
  status: 'running' | 'idle' | 'awaiting_approval' | 'awaiting_answer'
  campaign: { id: string; title: string } | null
  /** The runner holds it in memory now (P1). */
  live?: boolean
  access?: string
  /** Permission prompts waiting, as the server's `permission_request` events. */
  pendingApprovals?: Array<Record<string, unknown>>
  pendingAsks?: Array<Record<string, unknown>>
  lastSeq?: number
  /** The isolated checkout the session works in, when it has one (P2). */
  worktree?: RemoteWorktreeSummary | null
  worktreeDiscarded?: boolean
}

export type RemoteWorktreeSummary = {
  path: string
  branch: string
  baseBranch: string | null
  baseSha: string
  /** The repository the changes are proposed to; proposals are listed by it. */
  sourceRoot: string
}

export type RemoteTranscript = RemoteSession & {
  turns: Array<{ role: 'user' | 'assistant' | 'tool'; content: string } & Record<string, unknown>>
  messageCount: number
  notMapped: string[]
}

export type ReplayEvent = {
  seq: number
  kind: string
  source?: string
  at?: unknown
  payload?: unknown
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** The probe answer, tolerant of an older server that omits the new fields. */
export function parseRunnerInfo(raw: unknown): RunnerInfo {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const folders = strings(v.roots).length ? strings(v.roots) : strings(v.folders)
  return {
    agent: v.agent === true,
    runsSessions: v.runsSessions === true,
    runsChecks: v.runsChecks === true,
    runsWorktrees: v.runsWorktrees === true,
    runsCampaigns: v.runsCampaigns === true,
    runRequested: v.runRequested === true,
    runnerPlanned: v.runnerPlanned === true,
    sandbox: typeof v.sandbox === 'string' ? v.sandbox : 'unknown',
    enforces: v.enforces === true,
    roots: folders,
    maxSessions: typeof v.maxSessions === 'number' ? v.maxSessions : 0,
    allowBypass: v.allowBypass === true,
    allowAlways: v.allowAlways === true,
    approvalTimeoutSecs: typeof v.approvalTimeoutSecs === 'number' ? v.approvalTimeoutSecs : 0,
    liveSessions: typeof v.liveSessions === 'number' ? v.liveSessions : 0,
    missing: strings(v.missing),
    parityGaps: strings(v.parityGaps),
  }
}

function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init)
}

async function rpc<T>(command: string, args: unknown, fetchImpl: FetchLike): Promise<T> {
  const response = await fetchImpl(`/api/v1/rpc/${encodeURIComponent(command)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  })
  if (!response.ok) throw new Error((await response.text()) || `${command} failed (${response.status})`)
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function probeRunner(fetchImpl: FetchLike = defaultFetch()): Promise<RunnerInfo> {
  return parseRunnerInfo(await rpc('agent_server_info', {}, fetchImpl))
}

export async function listRemoteSessions(
  fetchImpl: FetchLike = defaultFetch()
): Promise<RemoteSession[]> {
  const out = await rpc<{ sessions?: RemoteSession[] }>('agent_run_list', {}, fetchImpl)
  return Array.isArray(out?.sessions) ? out.sessions : []
}

export function getRemoteSession(
  id: string,
  fetchImpl: FetchLike = defaultFetch()
): Promise<RemoteTranscript> {
  return rpc<RemoteTranscript>('agent_run_get', { id }, fetchImpl)
}

export type ParsedSse = {
  events: ReplayEvent[]
  /** Set by the server's closing `end` event. */
  end: { last: number; more: boolean } | null
}

/** Pure reader for the server's finite event-stream body. */
export function parseSse(body: string): ParsedSse {
  const events: ReplayEvent[] = []
  let end: ParsedSse['end'] = null
  for (const block of body.split(/\r?\n\r?\n/)) {
    let name = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':') || !line) continue
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (!data.length) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n'))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    if (name === 'end') {
      end = { last: Number(record.last) || 0, more: record.more === true }
    } else if (typeof record.seq === 'number') {
      events.push(record as unknown as ReplayEvent)
    }
  }
  return { events, end }
}

/**
 * Every event of a session after `after`, following the server's pages until it
 * says none remain. Pass the last seq you hold to resume.
 */
export async function replaySession(
  id: string,
  options: { after?: number; fetchImpl?: FetchLike; maxPages?: number } = {}
): Promise<{ events: ReplayEvent[]; last: number }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch()
  let after = options.after ?? 0
  const events: ReplayEvent[] = []
  for (let page = 0; page < (options.maxPages ?? 50); page++) {
    const response = await fetchImpl(
      `/api/v1/agent/sessions/${encodeURIComponent(id)}/events?after=${after}`,
      { credentials: 'same-origin', headers: { Accept: 'text/event-stream' } }
    )
    if (!response.ok) throw new Error((await response.text()) || `replay failed (${response.status})`)
    const parsed = parseSse(await response.text())
    events.push(...parsed.events)
    const last = parsed.end?.last ?? after
    if (!parsed.end?.more || last <= after) return { events, last }
    after = last
  }
  return { events, last: after }
}

export type RemoteRunnerState =
  | { state: 'local' }
  | { state: 'checking' }
  | { state: 'unreachable'; detail: string }
  | { state: 'ready'; info: RunnerInfo }

/** The probe for the page's server, or `local` off a server page. */
export function useRemoteRunner(): RemoteRunnerState {
  const server = isServerTransport()
  const [state, setState] = useState<RemoteRunnerState>(
    server ? { state: 'checking' } : { state: 'local' }
  )
  useEffect(() => {
    if (!server) return
    let live = true
    probeRunner()
      .then((info) => live && setState({ state: 'ready', info }))
      .catch(
        (e) =>
          live &&
          setState({ state: 'unreachable', detail: e instanceof Error ? e.message : String(e) })
      )
    return () => {
      live = false
    }
  }, [server])
  return state
}

/** The one-line banner text, English, from a probe. */
export function runnerBanner(info: RunnerInfo): { ok: boolean; text: string } {
  if (info.runsSessions) return { ok: true, text: 'This server can run agents: connected.' }
  if (!info.agent) {
    return {
      ok: false,
      text: 'This server does not run agents. Start `flint serve --agent-run --agent-root <folder>`.',
    }
  }
  const why = info.missing.length ? ` Missing: ${info.missing.join('; ')}.` : ''
  return { ok: false, text: `This server does not run agents yet.${why}` }
}

// ---------------------------------------------------------------------------
// P1: run a session on the server
// ---------------------------------------------------------------------------

export type RunAccess = 'read' | 'ask' | 'auto' | 'bypass'

export type CreatedRun = {
  id: string
  folder: string
  model: string
  access: string
  mode?: string
  status: string
  lastSeq: number
  worktree?: Record<string, unknown> | null
}

export function createRun(
  input: {
    folder: string
    access?: RunAccess
    mode?: string
    model?: string
    title?: string
    /** Omitted: isolated when the session may write and the folder is a git repository. */
    worktree?: boolean
    /** A branch to start the isolated checkout from. */
    base?: string
  },
  fetchImpl: FetchLike = defaultFetch()
): Promise<CreatedRun> {
  return rpc<CreatedRun>('agent_run_create', input, fetchImpl)
}

/** A message is text, or the content parts the stdio protocol takes. */
export type RunInput = string | Array<Record<string, unknown>>

/** `after` is the seq to subscribe past to see this turn from its first event. */
export function startRun(
  id: string,
  input: RunInput,
  fetchImpl: FetchLike = defaultFetch()
): Promise<{ turnId: string; after: number }> {
  return rpc('agent_run_start', { id, input }, fetchImpl)
}

export function steerRun(id: string, text: string, fetchImpl: FetchLike = defaultFetch()) {
  return rpc<Record<string, never>>('agent_run_steer', { id, text }, fetchImpl)
}

export function interruptRun(id: string, fetchImpl: FetchLike = defaultFetch()) {
  return rpc<Record<string, never>>('agent_run_interrupt', { id }, fetchImpl)
}

export type ApprovalAnswer = 'allow_once' | 'allow_always' | 'deny'

export function approveRun(
  id: string,
  requestId: string,
  decision: ApprovalAnswer,
  fetchImpl: FetchLike = defaultFetch()
) {
  return rpc<Record<string, never>>('agent_run_approve', { id, requestId, decision }, fetchImpl)
}

export type AskResult = { id: string; selected: string[]; custom_input?: string }

export function answerRunAsk(
  id: string,
  requestId: string,
  results: AskResult[],
  fetchImpl: FetchLike = defaultFetch()
) {
  return rpc<Record<string, never>>('agent_run_answer_ask', { id, requestId, results }, fetchImpl)
}

export function deleteRun(id: string, fetchImpl: FetchLike = defaultFetch()) {
  return rpc<{ deleted: boolean }>('agent_run_delete', { id }, fetchImpl)
}

export function setRunModel(id: string, model: string, fetchImpl: FetchLike = defaultFetch()) {
  return rpc<{ model: string }>('agent_run_set_model', { id, model }, fetchImpl)
}

export function setRunAccess(id: string, access: RunAccess, fetchImpl: FetchLike = defaultFetch()) {
  return rpc<{ access: string }>('agent_run_set_mode', { id, access }, fetchImpl)
}

// ---------------------------------------------------------------------------
// P2: a session's worktree. Every command names the session, never a path.
// ---------------------------------------------------------------------------

export type WorktreeStateWord =
  | 'ready'
  | 'missing'
  | 'corrupt'
  | 'branch-moved'
  | 'identity-changed'

export type RemoteWorktreeState = {
  state: WorktreeStateWord
  worktree: {
    path: string
    branch: string
    baseBranch: string | null
    baseSha: string
    sourceRoot: string
  }
  project: string
}

export type MergeOutcome = {
  merged: boolean
  fastForward: boolean
  alreadyMerged: boolean
  target: string
  newTip: string | null
  conflicts: string[]
  committedPending: boolean
}

export function worktreeState(id: string, fetchImpl: FetchLike = defaultFetch()) {
  return rpc<RemoteWorktreeState>('agent_worktree_state', { id }, fetchImpl)
}

/** Files the worktree holds that are not committed. */
export async function worktreePending(
  id: string,
  fetchImpl: FetchLike = defaultFetch()
): Promise<string[]> {
  const out = await rpc<{ files?: string[] }>('agent_worktree_pending', { id }, fetchImpl)
  return strings(out?.files)
}

/** Commits on the session's branch its base branch does not have. */
export async function worktreeUnmerged(
  id: string,
  fetchImpl: FetchLike = defaultFetch()
): Promise<string[]> {
  const out = await rpc<{ commits?: string[] }>('agent_worktree_unmerged', { id }, fetchImpl)
  return strings(out?.commits)
}

export function commitWorktree(
  id: string,
  message?: string,
  fetchImpl: FetchLike = defaultFetch()
) {
  return rpc<{ committed: boolean }>('agent_worktree_commit_pending', { id, message }, fetchImpl)
}

/** Merge into the base branch (or `target`). Uncommitted work refuses unless `commitMessage` is given. */
export function mergeWorktree(
  id: string,
  options: { target?: string; commitMessage?: string } = {},
  fetchImpl: FetchLike = defaultFetch()
) {
  return rpc<MergeOutcome>('agent_worktree_merge', { id, ...options }, fetchImpl)
}

/** Remove the checkout and its branch. Refuses unmerged or uncommitted work unless `force`. */
export function discardWorktree(
  id: string,
  force = false,
  fetchImpl: FetchLike = defaultFetch()
) {
  return rpc<{ discarded: boolean }>('agent_worktree_discard', { id, force }, fetchImpl)
}

export function renameWorktree(id: string, title: string, fetchImpl: FetchLike = defaultFetch()) {
  return rpc<{ worktree: RemoteWorktreeState['worktree'] }>(
    'agent_worktree_rename',
    { id, title },
    fetchImpl
  )
}

/** Flint's worktrees of the repository at `project` (a folder inside a root). */
export async function listWorktrees(
  project: string,
  fetchImpl: FetchLike = defaultFetch()
): Promise<Array<Record<string, unknown>>> {
  const out = await rpc<{ worktrees?: Array<Record<string, unknown>> }>(
    'agent_worktree_list',
    { project },
    fetchImpl
  )
  return Array.isArray(out?.worktrees) ? out.worktrees : []
}

export type ServerFolder = { name: string; path: string; git: boolean }

/** The folders under `path` the server allows, or its roots when omitted. */
export function listServerFolders(
  path?: string,
  fetchImpl: FetchLike = defaultFetch()
): Promise<{ path: string | null; parent: string | null; entries: ServerFolder[] }> {
  return rpc('agent_server_folders', path ? { path } : {}, fetchImpl)
}

/** One server-sent record: its `event:` name, its `id:` and its data text. */
export type SseRecord = { event: string; id: string | null; data: string }

/**
 * Incremental reader for an event stream: feed it text as it arrives, take the
 * complete records. A record split across two chunks is held until its blank
 * line; comments (heartbeats) produce nothing.
 */
export class SseDecoder {
  private buffer = ''

  feed(chunk: string): SseRecord[] {
    this.buffer += chunk
    const out: SseRecord[] = []
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (!match) break
      const block = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      let event = 'message'
      let id: string | null = null
      const data: string[] = []
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('id:')) id = line.slice(3).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) out.push({ event, id, data: data.join('\n') })
    }
    return out
  }
}

export type LiveEnvelope = {
  seq: number
  source: 'live' | 'log' | 'transcript'
  kind: string
  at?: unknown
  payload?: Record<string, unknown> & { type?: string }
}

export type SubscribeOptions = {
  /** Resume point: only events after this seq are delivered. */
  after?: number
  /** Called with each chunk's worth of events, in order. */
  onEvents: (events: LiveEnvelope[]) => void
  /** The ring no longer holds what was missed: refetch the transcript. */
  onGap?: (info: { from: number; after: number }) => void
  /** The cursor was from an earlier life of the session: events restart. */
  onReset?: () => void
  /** A connection attempt failed or ended; the stream will retry. */
  onReconnect?: (attempt: number) => void
  signal?: AbortSignal
  fetchImpl?: FetchLike
  /** Milliseconds of silence (heartbeats come every 15s) before reconnecting. */
  silenceMs?: number
  /** Backoff between reconnects, in order; the last repeats. */
  backoffMs?: number[]
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })

/** A refusal that retrying cannot change. */
class Fatal extends Error {}

/**
 * Follow a live session's events until `signal` aborts, resuming from the last
 * seq seen on every reconnect. A dropped connection, a silent one and a server
 * restart are all just a reconnect; a session the server no longer holds ends
 * the stream with a rejection.
 */
export async function subscribeRun(id: string, options: SubscribeOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? defaultFetch()
  const silenceMs = options.silenceMs ?? 45_000
  const backoff = options.backoffMs ?? [500, 1000, 2000, 5000]
  const signal = options.signal
  let last = options.after ?? 0
  let attempt = 0
  while (!signal?.aborted) {
    const controller = new AbortController()
    const stop = () => controller.abort()
    signal?.addEventListener('abort', stop, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), silenceMs)
    }
    try {
      arm()
      const response = await fetchImpl(
        `/api/v1/agent/sessions/${encodeURIComponent(id)}/events?after=${last}`,
        {
          credentials: 'same-origin',
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(last) },
          signal: controller.signal,
        }
      )
      if (!response.ok) {
        const text = await response.text()
        if ([401, 403, 404].includes(response.status)) {
          throw new Fatal(text || `events failed (${response.status})`)
        }
        throw new Error(text || `events failed (${response.status})`)
      }
      if (!response.body) throw new Fatal('this browser cannot stream events')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const sse = new SseDecoder()
      attempt = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        const batch: LiveEnvelope[] = []
        for (const record of sse.feed(decoder.decode(value, { stream: true }))) {
          let data: unknown
          try {
            data = JSON.parse(record.data)
          } catch {
            continue
          }
          if (record.event === 'gap') {
            const g = data as { from?: number; after?: number }
            options.onGap?.({ from: Number(g.from) || 0, after: Number(g.after) || 0 })
          } else if (record.event === 'reset') {
            last = 0
            options.onReset?.()
          } else if (record.event === 'end') {
            if (batch.length) options.onEvents(batch)
            return
          } else if (record.event === 'message') {
            const env = data as LiveEnvelope
            if (typeof env.seq === 'number' && env.seq > last) {
              last = env.seq
              batch.push(env)
            }
          }
        }
        if (batch.length) options.onEvents(batch)
      }
    } catch (e) {
      if (signal?.aborted) return
      if (e instanceof Fatal) throw e
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
    }
    if (signal?.aborted) return
    attempt += 1
    options.onReconnect?.(attempt)
    await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)], signal)
  }
}
