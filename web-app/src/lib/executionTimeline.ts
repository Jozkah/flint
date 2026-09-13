/**
 * The desktop execution timeline, built from the session's canonical event
 * log (AH-005) and nothing else. AH-172.
 *
 * One row per tool call or run lifecycle item (folded from its phases, like
 * `activity::items`), and one per request-level event: the provider's usage,
 * what a response was made of, a run starting and ending, an agent
 * dispatched, a background job. Rows are ordered by the sequence number of
 * their first event, which the backend assigns as it writes, so the order is
 * the log's and not any renderer's clock.
 */
import type { EventEnvelope } from '@/lib/eventLog'
import { cacheStatus, readTokenUsage, type TokenUsage } from '@/lib/tokenUsage'

export type TimelineCategory =
  | 'messages'
  | 'reasoning'
  | 'tools'
  | 'edits'
  | 'usage'
  | 'steering'
  | 'approvals'
  | 'background'
  | 'subagents'
  | 'run'

export const TIMELINE_CATEGORIES: TimelineCategory[] = [
  'messages',
  'reasoning',
  'tools',
  'edits',
  'usage',
  'steering',
  'approvals',
  'background',
  'subagents',
  'run',
]

export type TimelineStatus =
  | 'running'
  | 'queued'
  | 'awaiting'
  | 'completed'
  | 'failed'
  | 'refused'
  | 'cancelled'
  | 'interrupted'

export type TimelineChange = {
  path: string
  kind: string
  added?: number
  removed?: number
  diffStored: boolean
  oversized: boolean
}

export type TimelineRow = {
  /** Stable: the call's identity for a folded item, else the event id. */
  id: string
  seq: number
  at: string
  primary: TimelineCategory
  categories: TimelineCategory[]
  title: string
  detail?: string
  status: TimelineStatus
  run?: string
  invocation?: string
  agent?: string
  /** The agent's durable identity (AH-110), when the event carried one. */
  agentId?: string
  call?: string
  tool?: string
  /** Every phase a folded item went through, in order. */
  history: string[]
  input?: string
  output?: string
  outputTruncated?: boolean
  change?: TimelineChange
  elapsedMs?: number
  exitCode?: number
  refusal?: string
  /**
   * What kind of failure this was, in the harness taxonomy (AH-009):
   * `sandbox_denied`, `timeout`, `tool_unavailable`, ... Absent when the row
   * did not fail, and on rows recorded before the taxonomy reached the tool
   * layer -- which read as "a failure", never as a kind nobody decided.
   */
  errorKind?: string
  /**
   * A provider attempt that was given up on, and what was tried next
   * (AH-193). Present only on the row of the request that fell back.
   */
  fallback?: { from: string; to: string; reason?: string; kind?: string }
  usage?: TokenUsage
  /** What a call's command, or a whole run's commands, used (AH-174). */
  resources?: TimelineResources
}

/**
 * CPU and memory attributed to a call or a run (AH-174). `measured` false
 * carries the reason instead of figures: an unmeasured command is never zero.
 */
export type TimelineResources = {
  measured: boolean
  cpuMs?: number
  peakMemoryBytes?: number
  processes?: number
  reason?: string
  /** Run totals only: commands started, and how many were measured. */
  commands?: number
  measuredCommands?: number
}

export function resourcesOf(v: unknown): TimelineResources | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  if (typeof r.commands === 'number') {
    const measured = n(r.measuredCommands) ?? 0
    return {
      measured: measured > 0,
      cpuMs: measured > 0 ? n(r.cpuMs) : undefined,
      peakMemoryBytes: measured > 0 ? n(r.peakMemoryBytes) : undefined,
      processes: measured > 0 ? n(r.processes) : undefined,
      reason: typeof r.unmeasuredReason === 'string' ? r.unmeasuredReason : undefined,
      commands: r.commands as number,
      measuredCommands: measured,
    }
  }
  if (typeof r.measured !== 'boolean') return undefined
  return {
    measured: r.measured,
    cpuMs: n(r.cpuMs),
    peakMemoryBytes: n(r.peakMemoryBytes),
    processes: n(r.processes),
    reason: typeof r.reason === 'string' ? r.reason : undefined,
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** What a tool or lifecycle phase means for the row. */
export function statusOfPhase(phase: string): TimelineStatus {
  switch (phase) {
    case 'succeeded':
      return 'completed'
    case 'failed':
    case 'timed-out':
      return 'failed'
    case 'refused':
      return 'refused'
    case 'cancelled':
      return 'cancelled'
    // A call a dead run left behind: the application exited under it.
    case 'stale':
      return 'interrupted'
    case 'queued':
      return 'queued'
    case 'awaiting-permission':
      return 'awaiting'
    default:
      return 'running'
  }
}

export const isTerminal = (status: TimelineStatus): boolean =>
  status !== 'running' && status !== 'queued' && status !== 'awaiting'

const WRITES = new Set(['write', 'edit'])

function categoriesOfItem(row: TimelineRow, lifecycle: string, jobId?: string): TimelineCategory[] {
  const out = new Set<TimelineCategory>()
  if (lifecycle) {
    if (lifecycle === 'steering') out.add('steering')
    else if (lifecycle === 'subagent') out.add('subagents')
    else if (lifecycle === 'background-job') out.add('background')
    else if (lifecycle === 'approval') out.add('approvals')
    else out.add('run')
  } else {
    out.add('tools')
    // An edit is a call that changed, or set out to change, a file; a write
    // the harness refused never got that far and is a refusal, not an edit.
    if (row.change || (row.tool && WRITES.has(row.tool) && row.status !== 'refused')) {
      out.add('edits')
    }
    if (row.tool === 'task' || row.tool === 'team') out.add('subagents')
    if (jobId) out.add('background')
  }
  if (row.history.includes('awaiting-permission')) out.add('approvals')
  return [...out]
}

function titleOfItem(tool: string, lifecycle: string, summary?: string): string {
  if (lifecycle === 'steering') return 'Steering'
  if (lifecycle === 'compaction') return 'Context compaction'
  if (lifecycle === 'subagent') return 'Subagent'
  if (lifecycle === 'background-job') return 'Background job'
  if (lifecycle) return lifecycle
  return summary ? `${tool}: ${summary}` : tool
}

function changeOf(v: unknown): TimelineChange | undefined {
  if (!v || typeof v !== 'object') return undefined
  const c = v as Record<string, unknown>
  const path = str(c.path)
  if (!path) return undefined
  return {
    path,
    kind: str(c.kind) ?? 'edited',
    added: num(c.added),
    removed: num(c.removed),
    diffStored: c.diffStored === true,
    oversized: c.oversized === true,
  }
}

/** Fold a session's envelopes into rows. Envelopes of other sessions are dropped. */
export function buildTimeline(envelopes: EventEnvelope[], session: string): TimelineRow[] {
  const rows = new Map<string, TimelineRow>()
  // The same rows keyed without the invocation, so an event that carries none
  // still folds into the call it belongs to instead of opening a second row.
  const looseRows = new Map<string, TimelineRow>()
  const lifecycleOf = new Map<string, { lifecycle: string; jobId?: string }>()
  const sorted = envelopes
    .filter((e) => e.session === session)
    .slice()
    .sort((a, b) => a.seq - b.seq)

  for (const e of sorted) {
    const p = e.payload ?? {}
    const isTool = e.kind.startsWith('tool.')
    const isLifecycle = e.kind.startsWith('lifecycle.')
    if (isTool || isLifecycle) {
      const call = str(p.call) ?? e.id
      const phase = str(p.phase) ?? e.kind.slice(e.kind.indexOf('.') + 1)
      // The invocation is part of the key (AH-004): a provider that numbers
      // its tool calls per request reuses `call_1`, and two requests' calls
      // are two rows, not one row that changes its mind.
      const invocation = str(e.invocation) ?? str(p.invocation) ?? ''
      const base = `item:${call}:${str(p.agent) ?? ''}:${e.run}`
      const key = `${base}:${invocation}`
      const lifecycle = isLifecycle ? (str(p.lifecycle) ?? 'lifecycle') : ''
      let row = rows.get(key)
      if (!row) {
        // An event that lost its invocation still belongs to the call it
        // names, and a call first seen without one keeps its row when the
        // invocation arrives. A *different* invocation is a different call.
        const loose = looseRows.get(base)
        if (loose && (!invocation || !loose.invocation)) {
          row = loose
          if (invocation) row.invocation = invocation
          rows.set(key, row)
        }
      }
      if (!row) {
        row = {
          id: key,
          seq: e.seq,
          at: e.at,
          primary: 'tools',
          categories: [],
          title: titleOfItem(str(p.tool) ?? '', lifecycle, str(p.summary)),
          status: statusOfPhase(phase),
          run: str(e.run),
          invocation: str(e.invocation) ?? str(p.invocation),
          agent: str(p.agent),
          agentId: str(p.agent_id),
          call,
          tool: str(p.tool),
          history: [],
        }
        rows.set(key, row)
      }
      looseRows.set(base, row)
      row.history.push(phase)
      row.status = statusOfPhase(phase)
      row.invocation ??= str(e.invocation) ?? str(p.invocation)
      row.detail = str(p.detail) ?? row.detail
      if (!lifecycle && str(p.summary)) row.title = titleOfItem(row.tool ?? '', '', str(p.summary))
      else if (lifecycle && str(p.summary)) row.detail = str(p.summary)
      row.input = str(p.input) ?? row.input
      if (str(p.output) !== undefined) {
        row.output = str(p.output)
        row.outputTruncated = p.output_truncated === true
      }
      row.change = changeOf(p.change) ?? row.change
      row.elapsedMs = num(p.elapsed_ms) ?? num(p.elapsedMs) ?? row.elapsedMs
      row.exitCode = num(p.exit_code) ?? num(p.exitCode) ?? row.exitCode
      row.resources = resourcesOf(p.resources) ?? row.resources
      row.refusal = str(p.refusal) ?? row.refusal
      // AH-009: the record says what kind of failure it was; the row shows
      // that rather than making a reader infer it from the words.
      row.errorKind = str(p.error_kind) ?? str(p.errorKind) ?? row.errorKind
      const jobId = str(p.job_id) ?? lifecycleOf.get(key)?.jobId
      lifecycleOf.set(key, { lifecycle, jobId })
      continue
    }
    const base = {
      id: e.id,
      seq: e.seq,
      at: e.at,
      run: str(e.run),
      invocation: str(e.invocation),
      history: [],
    }
    switch (e.kind) {
      case 'usage.reported': {
        const usage = readTokenUsage({
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          totalTokens: p.totalTokens,
          cachedInputTokens: p.cachedTokens,
          cacheWriteTokens: p.cacheWriteTokens,
          cacheSource: p.cacheSource,
          requests: p.requests ?? 1,
          cacheReportedRequests: p.cacheReportedRequests,
          cacheHitRequests: p.cacheHitRequests,
        })
        rows.set(e.id, {
          ...base,
          primary: 'usage',
          categories: ['usage'],
          title: 'Token usage',
          status: 'completed',
          usage,
        })
        break
      }
      case 'message.completed': {
        const phase = str(p.phase)
        if (phase === 'fell-back') {
          // AH-193: the provider that did not answer and the one tried next.
          // Its own row, because it is something that happened rather than a
          // property of the reply that eventually arrived.
          rows.set(e.id, {
            ...base,
            primary: 'run',
            categories: ['run'],
            title: 'Provider fell back',
            detail: `${str(p.from) ?? 'the model'} did not answer; trying ${str(p.to) ?? 'the next provider'}`,
            status: 'failed',
            errorKind: str(p.failureKind),
            fallback: {
              from: str(p.from) ?? '',
              to: str(p.to) ?? '',
              reason: str(p.reason),
              kind: str(p.failureKind),
            },
          })
          break
        }
        if (phase === 'failed') {
          // A request that never produced a reply: what kind of failure it
          // was is the useful part, and the record now says.
          const failure = p.error as Record<string, unknown> | undefined
          rows.set(e.id, {
            ...base,
            primary: 'run',
            categories: ['run'],
            title: 'Request failed',
            detail: str(p.detail),
            status: 'failed',
            errorKind:
              typeof failure?.kind === 'string' ? (failure.kind as string) : undefined,
          })
          break
        }
        const text = num(p.textChars) ?? 0
        const reasoning = num(p.reasoningChars) ?? 0
        const calls = num(p.toolCalls) ?? 0
        const parts = [`${text} characters`]
        if (reasoning > 0) parts.push(`${reasoning} characters of reasoning`)
        if (calls > 0) parts.push(`${calls} tool ${calls === 1 ? 'call' : 'calls'}`)
        rows.set(e.id, {
          ...base,
          primary: 'messages',
          categories: reasoning > 0 ? ['messages', 'reasoning'] : ['messages'],
          title: 'Response',
          detail: parts.join(' · '),
          status: 'completed',
        })
        break
      }
      case 'run.started':
        rows.set(e.id, {
          ...base,
          primary: 'run',
          categories: ['run', 'messages'],
          title: 'Run started',
          detail: str(p.model),
          status: 'completed',
        })
        break
      case 'run.ended': {
        const by = str(p.stoppedBy) ?? 'unknown'
        rows.set(e.id, {
          ...base,
          primary: 'run',
          categories: ['run'],
          title: 'Run ended',
          detail: by === 'done' || by === 'unknown' ? undefined : by,
          resources: resourcesOf(p.resources),
          status:
            by === 'aborted' ? 'cancelled' : by === 'error' ? 'failed' : 'completed',
        })
        break
      }
      case 'agent.dispatched':
      case 'agent.ended':
        rows.set(e.id, {
          ...base,
          primary: 'subagents',
          categories: ['subagents'],
          title: e.kind === 'agent.dispatched' ? `Dispatched ${str(p.agent) ?? 'an agent'}` : 'Agent ended',
          agent: str(p.agent),
          status: 'completed',
        })
        break
      case 'job.started':
      case 'job.ended':
        rows.set(e.id, {
          ...base,
          primary: 'background',
          categories: ['background'],
          title: e.kind === 'job.started' ? 'Background job started' : 'Background job ended',
          status:
            e.kind === 'job.started'
              ? 'completed'
              : str(p.status) === 'failed'
                ? 'failed'
                : 'completed',
        })
        break
      default:
        // A kind this build does not know: kept and shown, never guessed at.
        rows.set(e.id, {
          ...base,
          primary: 'run',
          categories: ['run'],
          title: e.kind,
          status: 'completed',
        })
    }
  }

  // One row per call, even when it is reachable under both its loose and its
  // invocation-qualified key.
  const out = [...new Set(rows.values())]
  for (const row of out) {
    if (row.history.length > 0) {
      const meta = lifecycleOf.get(row.id)
      row.categories = categoriesOfItem(row, meta?.lifecycle ?? '', meta?.jobId)
      row.primary = row.categories[0]
    }
  }
  return out.sort((a, b) => a.seq - b.seq)
}

/**
 * A request's usage as a `usage.reported` payload: provider counts only, with
 * token-named keys so a metadata-only export keeps them and never mistakes
 * them for a tool's `input`/`output`. A count the provider did not report is
 * left out, never written as 0.
 */
export function usageEventPayload(usage: TokenUsage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedInputTokens,
    uncachedTokens: usage.uncachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheStatus: cacheStatus(usage),
    cacheSource: usage.cacheSource,
    requests: usage.requests,
    cacheReportedRequests: usage.cacheReportedRequests,
    cacheHitRequests: usage.cacheHitRequests,
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

/** Rows in any of the enabled categories. */
export function filterTimeline(
  rows: TimelineRow[],
  enabled: ReadonlySet<TimelineCategory>
): TimelineRow[] {
  return rows.filter((r) => r.categories.some((c) => enabled.has(c)))
}

/** How many rows each category holds, for the filter chips. */
export function countByCategory(rows: TimelineRow[]): Record<TimelineCategory, number> {
  const out = Object.fromEntries(TIMELINE_CATEGORIES.map((c) => [c, 0])) as Record<
    TimelineCategory,
    number
  >
  for (const r of rows) for (const c of r.categories) out[c] += 1
  return out
}
