/**
 * Client for the agent runner of a `flint serve --agent-run` server.
 *
 * Phase P0 is read-only: a capability probe (`agent_server_info`), the list and
 * transcript of the sessions the server holds, and the replay of one session's
 * events with resume. Starting a turn is phase P1 and is not here. Local
 * desktop sessions never touch this module; it is for a page served by the
 * server (`isServerTransport()`).
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
  runRequested: boolean
  runnerPlanned: boolean
  sandbox: string
  enforces: boolean
  roots: string[]
  maxSessions: number
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
  status: 'running' | 'idle'
  campaign: { id: string; title: string } | null
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
    runRequested: v.runRequested === true,
    runnerPlanned: v.runnerPlanned === true,
    sandbox: typeof v.sandbox === 'string' ? v.sandbox : 'unknown',
    enforces: v.enforces === true,
    roots: folders,
    maxSessions: typeof v.maxSessions === 'number' ? v.maxSessions : 0,
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
