/**
 * The numbers shown for a subagent: tokens, tool calls, model turns, elapsed.
 *
 * Computed in one place so the row, the detail header and the workflow totals
 * cannot disagree about the same child. Pure: nothing here reads a store or a
 * clock (callers pass `now`).
 *
 * Token counts are the provider's own when it reported them. A child that ran
 * but reported nothing (some local servers send no usage) gets an estimate from
 * the text it produced, marked `approximate` so the UI never presents a guess
 * as a measurement.
 */
import type { CoworkTurn, Usage } from '@/types/coworkSession'
import type { ActivityTask } from '@/lib/coworkActivity'

/** Rough characters per token, used only when no usage was reported. */
const CHARS_PER_TOKEN = 4

export type ToolCallCounts = {
  total: number
  /** Calls still waiting or running. */
  active: number
  succeeded: number
  failed: number
  /** Count per tool name, in first-seen order. */
  byTool: Record<string, number>
  /** How many of each tool's calls failed, for tools with at least one. */
  failedByTool: Record<string, number>
  /** How many of each tool's calls are still running or waiting. */
  activeByTool: Record<string, number>
}

export type SubagentStats = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** The token numbers are an estimate, not what the provider reported. */
  approximate: boolean
  tools: ToolCallCounts
  /** Model turns: assistant messages the child produced. */
  turns: number
  elapsedMs: number
}

const FAILED = new Set(['failed', 'refused', 'timed-out', 'stale', 'cancelled'])
const ACTIVE = new Set(['requested', 'awaiting-permission', 'running'])

/** How one tool turn ended: its `toolState`, else the older two-value form. */
function toolOutcome(turn: CoworkTurn): 'active' | 'failed' | 'succeeded' {
  if (turn.toolState) {
    if (ACTIVE.has(turn.toolState)) return 'active'
    return FAILED.has(turn.toolState) ? 'failed' : 'succeeded'
  }
  if (turn.isError) return 'failed'
  return turn.status === 'running' ? 'active' : 'succeeded'
}

/** Count a transcript's tool calls by tool and by how they ended. */
export function tallyToolCalls(
  turns: readonly CoworkTurn[] | undefined
): ToolCallCounts {
  const out: ToolCallCounts = {
    total: 0,
    active: 0,
    succeeded: 0,
    failed: 0,
    byTool: {},
    failedByTool: {},
    activeByTool: {},
  }
  for (const turn of turns ?? []) {
    if (turn.role !== 'tool') continue
    out.total += 1
    const outcome = toolOutcome(turn)
    out[outcome] += 1
    const name = turn.name || 'tool'
    out.byTool[name] = (out.byTool[name] ?? 0) + 1
    if (outcome === 'failed') out.failedByTool[name] = (out.failedByTool[name] ?? 0) + 1
    if (outcome === 'active') out.activeByTool[name] = (out.activeByTool[name] ?? 0) + 1
  }
  return out
}

/** Elapsed wall-clock time: to `endedAt` once finished, else to `now`. */
export function elapsedMs(
  task: Pick<ActivityTask, 'startedAt' | 'endedAt' | 'status'>,
  now: number
): number {
  if (task.status === 'queued') return 0
  const end = task.endedAt ?? now
  return Math.max(0, end - task.startedAt)
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Tokens in/out from a usage record, or `null` when it carries none. */
function reported(usage: Usage | undefined) {
  if (!usage) return null
  const input = usage.prompt_tokens ?? 0
  const output = usage.completion_tokens ?? 0
  const total = usage.total_tokens ?? input + output
  return total > 0 ? { input, output, total } : null
}

export function subagentStats(
  task: Pick<
    ActivityTask,
    'startedAt' | 'endedAt' | 'status' | 'usage' | 'transcript' | 'output'
  >,
  now: number
): SubagentStats {
  const turns = task.transcript ?? []
  const tools = tallyToolCalls(turns)
  const modelTurns = turns.filter((t) => t.role === 'assistant').length
  const real = reported(task.usage)
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let approximate = false
  if (real) {
    inputTokens = real.input
    outputTokens = real.output
    totalTokens = real.total
  } else if (turns.length > 0 || task.output) {
    // Nothing reported: what the child wrote is output, what came back from its
    // tools is what it read.
    outputTokens = estimateTokens(
      turns
        .filter((t) => t.role === 'assistant')
        .map((t) => t.content)
        .join('') + (task.output ?? '')
    )
    inputTokens = estimateTokens(
      turns
        .filter((t) => t.role === 'tool')
        .map((t) => t.result ?? '')
        .join('')
    )
    totalTokens = inputTokens + outputTokens
    approximate = totalTokens > 0
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    approximate,
    tools,
    turns: modelTurns,
    elapsedMs: elapsedMs(task, now),
  }
}

/** What a background row says it is doing right now. */
export type StatusLine =
  | 'queued'
  | 'thinking'
  | 'command'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'web'
  | 'tool'
  | 'finished'
  | 'failed'
  | 'cancelled'

const TOOL_LINE: Record<string, StatusLine> = {
  bash: 'command',
  read: 'reading',
  ls: 'reading',
  grep: 'searching',
  find: 'searching',
  write: 'editing',
  edit: 'editing',
  web_search: 'web',
  web_fetch: 'web',
}

/**
 * The one-line state of a task: what its latest unfinished tool call is doing,
 * else that it is thinking, else how it ended. Derived from the record, so a
 * row never says "running a command" for work that has stopped.
 */
export function statusLine(
  task: Pick<ActivityTask, 'status' | 'transcript' | 'kind'>
): StatusLine {
  switch (task.status) {
    case 'queued':
      return 'queued'
    case 'done':
      return 'finished'
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'interrupted':
      return 'cancelled'
  }
  if (task.kind === 'shell') return 'command'
  const turns = task.transcript ?? []
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    if (turn.role !== 'tool') {
      if (turn.role === 'assistant') break
      continue
    }
    if (toolOutcome(turn) === 'active') {
      return TOOL_LINE[turn.name ?? ''] ?? 'tool'
    }
    break
  }
  return 'thinking'
}

/** Totals over a group of children (a team, or a workflow's agents). */
export function aggregateStats(stats: readonly SubagentStats[]): SubagentStats {
  const byTool: Record<string, number> = {}
  const failedByTool: Record<string, number> = {}
  const activeByTool: Record<string, number> = {}
  const tools: ToolCallCounts = {
    total: 0,
    active: 0,
    succeeded: 0,
    failed: 0,
    byTool,
    failedByTool,
    activeByTool,
  }
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let turns = 0
  let approximate = false
  // Children run side by side, so the group's wall-clock is the longest one,
  // not the sum.
  let longest = 0
  for (const s of stats) {
    inputTokens += s.inputTokens
    outputTokens += s.outputTokens
    totalTokens += s.totalTokens
    turns += s.turns
    approximate ||= s.approximate
    longest = Math.max(longest, s.elapsedMs)
    tools.total += s.tools.total
    tools.active += s.tools.active
    tools.succeeded += s.tools.succeeded
    tools.failed += s.tools.failed
    for (const [name, n] of Object.entries(s.tools.byTool)) {
      byTool[name] = (byTool[name] ?? 0) + n
    }
    for (const [name, n] of Object.entries(s.tools.failedByTool)) {
      failedByTool[name] = (failedByTool[name] ?? 0) + n
    }
    for (const [name, n] of Object.entries(s.tools.activeByTool)) {
      activeByTool[name] = (activeByTool[name] ?? 0) + n
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    approximate,
    tools,
    turns,
    elapsedMs: longest,
  }
}
